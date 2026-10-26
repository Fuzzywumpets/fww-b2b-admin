// WHAT: the "Mark backordered" / "Undo" core. A backorder now REMOVES the backordered units from the
//   Shopify order (so the customer is invoiced only for what ships) while keeping a snapshot in the local
//   `backorders` table so the removed units can still be shown on the invoice and later put back at the
//   SAME price. This module is the orchestration + the Shopify staging; server.mjs supplies the transport
//   (real order-edit session vs the MOCK order model) through the `deps` object, so the identical logic is
//   exercised by the mock HTTP suite and by test/backorder-edit.test.mjs.
//
// WHY two-phase (claim → Shopify → finalize): a write that touches two systems must never lose the record
//   of the one that already moved. Order of effects:
//     1. claimBackorderRemoval  — row 'applying' WITH the full invoice snapshot, before Shopify is touched.
//     2. Shopify edit           — remove N units (restock:true, notifyCustomer:false — see the report).
//     3. read Shopify back      — never trust "no exception" alone; classify applied / not applied / unknown.
//     4. applied      → finalizeBackorderRemoval ('pending', units counted)
//        not applied  → abandonBackorderClaim    (NO record claims the line is backordered)
//        unknown      → row stays 'applying' and the failure is logged LOUDLY; the next flag/undo on that
//                       line reconciles it against Shopify using the quantity recorded at claim time.
//   Undo mirrors it: 'pending' → 'restoring' → Shopify → 'restored' (or back to 'pending').
//
// CHANGE-GUARD:
//   * The Shopify quantity READ-BACK is what decides the outcome after an error. Do not "simplify" it to
//     `catch → abandon`: a timeout on orderEditCommit can leave the edit APPLIED, and abandoning then
//     would erase the only record of units that are no longer on the order.
//   * A reported success whose read-back shows NO change is treated as not applied (fail closed) — an
//     invoice must never be told units are backordered when the order still bills them.
//   * Shopify cannot un-remove a line (quantity 0 is terminal), so Undo of a fully removed line adds the
//     variant back as a NEW line at the STORED price. It raises the old line's quantity only when that line
//     still exists AND still carries the stored price; otherwise it adds a separate line so the stored price
//     is honoured exactly.
//   * SPEED (2026-10-26): the read-back may be satisfied by the lines the orderEditCommit mutation itself
//     returned (deps.removeUnits / restoreUnits -> { lines }), saving one 118-line order read per click. That
//     is allowed ONLY as a POSITIVE confirmation: the committed quantity must equal exactly the expected
//     value (flag: prior - N; undo: before + N). Anything else - no lines, a stale or partial answer, an
//     error from the edit - falls back to the independent readLines() below, unchanged. The commit response
//     can therefore never turn a failure into a success; it can only skip a read that would have agreed.
//   * NO SILENT ABANDON AFTER A REPORTED SUCCESS (2026-10-26 follow-up): when the edit finished WITHOUT error but its
//     commit answer did not confirm, the units may well be gone while a lagging read still shows the old quantity.
//     That path therefore behaves as it did before the speed change - one settling whole-order read after the commit
//     (deps.settleAfterCommit, what runOrderEdit's readCommittedLineState used to be), then the read-back - and a
//     read-back that STILL shows no change is retried (READBACK_RETRY_DELAYS_MS) instead of being believed. If it
//     never changes, the claim is NOT abandoned: the row stays 'applying'/'restoring' (loud log, "check the order"
//     message) and the next flag/undo on that line, or the boot log, reconciles it from claim_prior_qty. Abandoning
//     there would erase the only record of units that are no longer on the order. After an edit ERROR the read-back is
//     still a single immediate read, unchanged (a rejection that changed nothing must still release the claim).
//
// INVARIANT(S): shopify_removed_qty > 0 only after Shopify confirmed (finalize). Every unit-moving Shopify
//   call goes through server.mjs runOrderEdit (begin/commit, per-order lock, idempotency ledger) — there is
//   no parallel Shopify edit path here. Staging functions never commit.
//
// DEPENDS: db.mjs backorder functions (claim/finalize/abandon/begin/revert/restore), BACKORDER_STATUS
//   below mirrors their status strings. server.mjs POST /orders/:id/backorder[/undo] wires `deps`
//   (backorderDeps there supplies the optional settleAfterCommit; `sleep` is optional and only tests replace it).
// SYNC: the Shopify mutations here deliberately match the ones in server.mjs POST /orders/:id/line/qty,
//   /line/remove and /line/add (same arguments, same WHOLESALE_DISCOUNT_TITLE discount description) — change them together.

import { WHOLESALE_DISCOUNT_TITLE } from './wholesale-discount.mjs';

export const BACKORDER_STATUS = Object.freeze({
  APPLYING: 'applying', PENDING: 'pending', RESTORING: 'restoring', RESTORED: 'restored', FULFILLED: 'fulfilled',
});
// Flash codes the order page reads from ?success= / ?error= (the page renders them; this module never does).
export const BACKORDER_FLASH = Object.freeze({
  FLAGGED: 'backorder_flagged', RESTORED: 'backorder_restored', FAILED: 'backorder_shopify_failed',
});
// A second identical flag on the same line inside this window is a double-submit, not a new request.
export const DUPLICATE_WINDOW_MS = 60_000;
// Pauses between the read-backs of an edit that reported success but whose commit answer did not confirm it (see the
// NO SILENT ABANDON bullet above): up to 1 + this many reads, ~2 s in all, paid only on that rare path.
// DEPENDS: test/backorder-roundtrips.test.mjs sizes its fake-bridge `readLag` from this length.
export const READBACK_RETRY_DELAYS_MS = Object.freeze([500, 1500]);
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Money comparison slack: Shopify rounds a percent discount to the cent per line.
export const PRICE_TOLERANCE = 0.015;

// What the core needs to know about each order line. Read PAGED by server.mjs (fetchAllOrderLineItems) so a
// flag on line 101+ of a 131-line order works like any other. Lives here (not in server.mjs) so
// test/backorder-edit.test.mjs can validate it against the Admin schema snapshot — the schema scan in
// test/shopify-schema.test.mjs cannot see a selection that arrives through an interpolation.
// SYNC: server.mjs normalizeBackorderLine reads exactly these fields.
export const BACKORDER_LINE_FIELDS = `
  id title variantTitle sku quantity currentQuantity
  variant{id title sku}
  originalUnitPriceSet{presentmentMoney{amount currencyCode}}
  discountedUnitPriceSet{presentmentMoney{amount currencyCode}}
  discountedTotalSet{presentmentMoney{amount currencyCode}}
  discountAllocations{ allocatedAmountSet{presentmentMoney{amount currencyCode}} discountApplication{ targetSelection } }
`;

// WHAT: server.mjs runOrderEdit's commit mutation, extended to hand back the order's lines in the SAME
//   response (so the read-back after a backorder edit needs no extra round trip). `first` is sized by the
//   caller to the session's line count (+ headroom), NOT the 250 page ceiling, to keep the request cost down.
// CHANGE-GUARD: the selection is BACKORDER_LINE_FIELDS on purpose - the exact fields the pre-read uses and
//   normalizeBackorderLine consumes - so a commit-sourced line and a read-sourced line are indistinguishable
//   downstream. pageInfo is selected so the caller can refuse an incomplete answer.
// DEPENDS: server.mjs runOrderEdit (opts.commitLines) calls this; the variables ($id,$notify,$note) must match
//   its plain commit mutation. test/backorder-edit.test.mjs validates this document against the schema snapshot.
export function backorderCommitMutation(first) {
  if (!Number.isInteger(first) || first < 1 || first > 250) throw new Error(`backorderCommitMutation: bad page size ${first}`);
  return `mutation commit($id:ID!,$notify:Boolean!,$note:String){
    orderEditCommit(id:$id,notifyCustomer:$notify,staffNote:$note){
      order{ id lineItems(first:${first}){ pageInfo{hasNextPage endCursor} edges{node{ ${BACKORDER_LINE_FIELDS} }}}}
      userErrors{field message}}}`;
}

// WHAT: the nodes of that mutation's `order.lineItems` answer - or null unless the page is provably COMPLETE.
// INVARIANT(S): complete = a connection with an edges array AND pageInfo.hasNextPage === false. A missing
//   connection, a missing pageInfo, hasNextPage true (or anything else) all give null, so the caller falls back
//   to the full paged read (fetchAllOrderLineItems) instead of treating a prefix of the order as the order.
//   This is the overflow check for the single-page selection above (the pagination guard looks for it here).
export function completeCommitNodes(conn) {
  if (!conn || !Array.isArray(conn.edges) || !conn.pageInfo || conn.pageInfo.hasNextPage !== false) return null;
  return conn.edges.map(e => e.node);
}

const isTransient = (s) => s === BACKORDER_STATUS.APPLYING || s === BACKORDER_STATUS.RESTORING;
const idTail = (gid) => String(gid ?? '').split('/').pop();
const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
export function errMsg(e) {
  if (!e) return 'unknown error';
  if (Array.isArray(e.userMessages) && e.userMessages.length) return e.userMessages.join('; ');
  return String(e.message || e);
}
export const money2 = (n) => (Math.round(Number(n) * 100) / 100).toFixed(2);
export const pricesMatch = (a, b, tol = PRICE_TOLERANCE) => Math.abs(Number(a) - Number(b)) <= tol;

// WHAT: validates the modal's fields. Quantity must be a plain whole number >= 1 (the upper bound — the
//   line's CURRENT Shopify quantity — is checked against live data in flagBackorder).
// CHANGE-GUARD: there is deliberately NO expected-ship-date field any more (owner decision). A stale client
//   that still posts `eta` has it ignored here — it is not validated, not returned, not stored.
export function parseBackorderRequest({ lineItemId, quantity } = {}) {
  const id = String(lineItemId ?? '').trim();
  if (!id) return { ok: false, message: 'No line item was selected.' };
  const raw = String(quantity ?? '').trim();
  if (!/^\d{1,9}$/.test(raw) || Number(raw) < 1) {
    return { ok: false, message: 'Quantity must be a whole number of 1 or more.' };
  }
  return { ok: true, lineItemId: id, quantity: Number(raw) };
}

// Does a live order line represent the same product as a backorder row? Variant id when the row has one,
// otherwise (custom line) the title with no variant.
export function lineMatchesRow(line, row) {
  if (row.variant_id) return line.variantId === row.variant_id;
  return !line.variantId && line.title === row.line_item_title;
}
export const sumMatching = (lines, row) =>
  lines.filter(l => lineMatchesRow(l, row)).reduce((s, l) => s + (Number(l.currentQuantity) || 0), 0);
const qtyOfLine = (lines, liId) => Number(lines.find(l => l.liId === liId)?.currentQuantity) || 0;

// WHAT: how to turn a variant's CURRENT list price into the stored B2B price on an added line.
//   Shopify ignores a manual unit price when a variantId is given, so the stored price is reached with a
//   percentage line discount (the house mechanism — see POST /orders/:id/line/add).
// Returns { kind:'none' } | { kind:'discount', pct } | { kind:'above' } (stored price exceeds list: a
//   discount cannot raise a price, so the caller must refuse rather than silently bill list).
export function priceAdjustment(listPrice, targetPrice) {
  const list = Number(listPrice), target = Number(targetPrice);
  if (Math.abs(list - target) <= 0.004) return { kind: 'none' };
  if (target > list) return { kind: 'above' };
  return { kind: 'discount', pct: parseFloat((((list - target) / list) * 100).toFixed(4)) };
}

// ── Shopify staging (inside the caller's open order-edit session; never commits) ──────────────────
function checkedPayload(res, field) {
  const p = res?.data?.[field];
  if (res?.errors?.length || !p || !Array.isArray(p.userErrors)) {
    throw new Error(`Shopify did not confirm ${field}. Reload the order before retrying.`);
  }
  if (p.userErrors.length) throw new Error(p.userErrors.map(e => e?.message || JSON.stringify(e)).join('; '));
  return p;
}
const SET_QTY = `mutation setQty($id:ID!,$li:ID!,$qty:Int!,$r:Boolean!){
  orderEditSetQuantity(id:$id,lineItemId:$li,quantity:$qty,restock:$r){ calculatedOrder{id} userErrors{field message}}}`;

// WHAT: takes `quantity` units off a line. Lowering to 0 removes the line. restock:true in BOTH cases —
//   the identical flag the ✕ remove route (POST /orders/:id/line/remove) sends — so the inventory the
//   order was holding for these units is released. calcQty is the line's quantity INSIDE this session.
export async function stageRemoveUnits({ shopifyFetch, calcId, calcLiId, calcQty, quantity }) {
  if (!Number.isInteger(calcQty)) throw new Error('Shopify did not report this line\'s quantity.');
  if (!(quantity >= 1) || quantity > calcQty) {
    throw new Error(`Only ${calcQty} unit(s) of this line are on the order — cannot remove ${quantity}.`);
  }
  checkedPayload(await shopifyFetch(SET_QTY, { id: calcId, li: calcLiId, qty: calcQty - quantity, r: true }), 'orderEditSetQuantity');
}

// WHAT: puts `quantity` units back onto a line that still exists (Undo, "raise" mode). restock:false —
//   nothing is being restocked when quantity goes UP.
export async function stageRaiseUnits({ shopifyFetch, calcId, calcLiId, calcQty, quantity }) {
  if (!Number.isInteger(calcQty)) throw new Error('Shopify did not report this line\'s quantity.');
  checkedPayload(await shopifyFetch(SET_QTY, { id: calcId, li: calcLiId, qty: calcQty + quantity, r: false }), 'orderEditSetQuantity');
}

// WHAT: re-adds a catalog variant as a NEW line at the stored B2B unit price (Undo, "add" mode).
// CHANGE-GUARD: fails closed. If the stored price cannot be reached (above current list, or the order
//   carries an order-level discount Shopify will not stack a line discount on) it THROWS so the session is
//   abandoned and nothing is added — adding at list price instead would silently overbill the customer.
export async function stageAddVariantAtPrice({ shopifyFetch, calcId, variantGid, quantity, unitPrice }) {
  const added = checkedPayload(await shopifyFetch(`mutation addVar($id:ID!,$v:ID!,$q:Int!){
    orderEditAddVariant(id:$id,variantId:$v,quantity:$q,allowDuplicates:true){
      calculatedLineItem{id originalUnitPriceSet{presentmentMoney{amount}} calculatedDiscountAllocations{discountApplication{targetSelection}}}
      calculatedOrder{id} userErrors{field message}}}`, { id: calcId, v: variantGid, q: quantity }), 'orderEditAddVariant');
  const li = added.calculatedLineItem;
  const list = Number(li?.originalUnitPriceSet?.presentmentMoney?.amount);
  if (!li?.id || !Number.isFinite(list)) throw new Error('Shopify did not return the re-added line or its price.');
  const plan = priceAdjustment(list, unitPrice);
  if (plan.kind === 'above') {
    throw new Error(`The stored price $${money2(unitPrice)} is above the variant's current price $${money2(list)}, so it cannot be applied to a re-added line. Add the line manually in Shopify.`);
  }
  if (plan.kind === 'discount') {
    const stacked = (li.calculatedDiscountAllocations || []).some(a => a?.discountApplication?.targetSelection === 'ALL');
    if (stacked) {
      throw new Error('This order carries an order-level discount, so Shopify will not let a line discount be added to restore the stored price. Add the line manually in Shopify.');
    }
    checkedPayload(await shopifyFetch(`mutation addDisc($id:ID!,$li:ID!,$d:OrderEditAppliedDiscountInput!){
      orderEditAddLineItemDiscount(id:$id,lineItemId:$li,discount:$d){ calculatedOrder{id} userErrors{field message}}}`,
      // SYNC: WHOLESALE_DISCOUNT_TITLE — pdf.mjs matches this description, so an Undo-restored line prints at its net price like any other wholesale line.
      { id: calcId, li: li.id, d: { percentValue: plan.pct, description: WHOLESALE_DISCOUNT_TITLE } }), 'orderEditAddLineItemDiscount');
  }
  return { listPrice: list, discountPct: plan.kind === 'discount' ? plan.pct : 0 };
}

// WHAT: re-adds a NON-catalog (custom) line. A custom item takes an exact unit price, so no discount.
export async function stageAddCustomAtPrice({ shopifyFetch, calcId, title, quantity, unitPrice, currency }) {
  checkedPayload(await shopifyFetch(`mutation addItem($id:ID!,$title:String!,$price:MoneyInput!,$qty:Int!){
    orderEditAddCustomItem(id:$id,title:$title,price:$price,quantity:$qty,taxable:false,requiresShipping:true){
      calculatedOrder{id} userErrors{field message}}}`,
    { id: calcId, title: String(title || 'Backordered item').slice(0, 200), price: { amount: money2(unitPrice), currencyCode: currency || 'USD' }, qty: quantity }),
    'orderEditAddCustomItem');
}

// ── Reconciling an interrupted write ────────────────────────────────────────────────────────────────
// WHAT: decides what really happened to a row left 'applying'/'restoring' (process died mid-write, or an
//   earlier request could not confirm) by comparing Shopify NOW with the quantity recorded at claim time.
//   Returns { ok:true } after bringing the row to a terminal state, or { ok:false, message } when Shopify
//   shows a quantity that matches neither outcome (someone edited the line meanwhile) — never guesses.
function reconcileTransient(deps, row, lines) {
  const { db, log } = deps;
  const n = row.quantity;
  const P = row.claim_prior_qty;
  const key = `${row.order_id} ${row.line_item_id}`;
  if (!Number.isInteger(P)) {
    log.error(`[backorder] STUCK ${row.status} row without claim_prior_qty (${key}) — cannot reconcile automatically`);
    return { ok: false, message: 'An earlier backorder action on this line did not finish and cannot be checked automatically. Check the order in Shopify.' };
  }
  if (row.status === BACKORDER_STATUS.APPLYING) {
    const x = qtyOfLine(lines, row.line_item_id);
    if (x === P - n) {
      db.finalizeBackorderRemoval(row.order_id, row.line_item_id);
      log.error(`[backorder] RECOVERED interrupted flag ${key}: Shopify shows ${x} (was ${P}, removed ${n}) — row finalized as pending`);
      return { ok: true };
    }
    if (x === P) {
      db.abandonBackorderClaim(row.order_id, row.line_item_id, null);
      log.error(`[backorder] RECOVERED interrupted flag ${key}: Shopify still shows ${x} — claim discarded`);
      return { ok: true };
    }
    log.error(`[backorder] STUCK applying row ${key}: Shopify shows ${x}, expected ${P - n} (applied) or ${P} (not applied)`);
    return { ok: false, message: `An earlier backorder on this line did not finish and Shopify now shows ${x} unit(s) (expected ${P - n} or ${P}). Check the order in Shopify before retrying.` };
  }
  const s = sumMatching(lines, row);
  if (s === P + n) {
    db.restoreBackorder(row.order_id, row.line_item_id, deps.now());
    log.error(`[backorder] RECOVERED interrupted undo ${key}: Shopify shows ${s} (was ${P}, restored ${n}) — row marked restored`);
    return { ok: true };
  }
  if (s === P) {
    db.revertBackorderRestore(row.order_id, row.line_item_id);
    log.error(`[backorder] RECOVERED interrupted undo ${key}: Shopify still shows ${s} — row returned to pending`);
    return { ok: true };
  }
  log.error(`[backorder] STUCK restoring row ${key}: Shopify shows ${s}, expected ${P + n} (applied) or ${P} (not applied)`);
  return { ok: false, message: `An earlier undo on this line did not finish and Shopify now shows ${s} unit(s) (expected ${P} or ${P + n}). Check the order in Shopify before retrying.` };
}

const ok = (extra = {}) => ({ ok: true, warnings: [], ...extra });
const fail = (message, state = 'rejected') => ({ ok: false, message, state });

// WHAT: the lines the commit mutation itself returned, but ONLY if the edit finished without error AND they
//   positively confirm the expected outcome (`confirms(lines)` true). Otherwise null, and the caller reads
//   Shopify back independently exactly as it always did.
// INVARIANT(S): never returns lines after an edit error (the outcome is then genuinely unknown and only an
//   independent read may decide it), never an empty/absent list, never lines that do not match the expected
//   quantity - so a stale, truncated or odd answer degrades to the old behaviour instead of deciding anything.
function confirmedByCommit(edited, editError, confirms) {
  if (editError) return null;
  const lines = edited?.lines;
  if (!Array.isArray(lines) || lines.length === 0) return null;
  return confirms(lines) ? lines : null;
}

// WHAT: the read-back for an edit that finished WITHOUT error but whose commit answer did not positively confirm it -
//   the pre-speed-change behaviour, plus a retry. First the settling read the commit used to be followed by
//   (deps.settleAfterCommit, optional; a failure of it is logged and ignored - it only buys time), then
//   readLines(); while the order STILL looks unchanged (`unchanged(lines)`) it waits READBACK_RETRY_DELAYS_MS[i] and reads
//   again. Returns the last lines read, or null when no read ever succeeded.
// INVARIANT(S): only ever called after a clean (error-free) edit; it never decides anything itself - the caller reads
//   the returned lines. If a later read FAILS after an earlier one showed "unchanged", the earlier lines are returned
//   (still "unchanged"), never null - null means "no evidence either way" and the caller trusts a clean success on
//   it, which must not happen once a read has actually contradicted that success.
async function readBackAfterUnconfirmedCommit(deps, label, unchanged) {
  const { log } = deps;
  const sleep = deps.sleep || defaultSleep;
  if (typeof deps.settleAfterCommit === 'function') {
    try { await deps.settleAfterCommit(); }
    catch (e) { log.warn?.(`[backorder] settling read after ${label} failed (continuing): ${errMsg(e)}`); }
  }
  let last = null;
  for (let attempt = 0; ; attempt++) {
    try { last = await deps.readLines(); }
    catch (e) {
      log.error(`[backorder] read-back after ${label} failed: ${errMsg(e)}`);
      return last;
    }
    if (!unchanged(last) || attempt >= READBACK_RETRY_DELAYS_MS.length) return last;
    await sleep(READBACK_RETRY_DELAYS_MS[attempt]);
  }
}

// WHAT: flag `quantity` units of a line as backordered and remove them from the Shopify order.
// deps: { db, getEditAction(key), readLines(), removeUnits({line, quantity, idemKey, payload}), now(), log }
//   readLines() -> [{ liId, title, variantTitle, sku, variantId, currentQuantity, unitPrice, currency }]
//   removeUnits() must run ONE atomic Shopify edit (throw on any rejection) and may not touch our DB. It MAY
//   return { lines } - the COMPLETE order lines the commit itself answered with (same shape as readLines()) -
//   which stands in for the read-back only if it positively confirms (see confirmedByCommit).
// input: { orderId (gid), lineItemId, quantity (int), email, idemKey|null }
// Returns { ok:true, duplicate?:true } | { ok:false, message, state:'rejected'|'not_applied'|'unconfirmed' }.
// INVARIANT(S): the caller must serialise calls per order (server.mjs withOrderLock) — this function
//   assumes no other flag/undo for the same order interleaves with it.
export async function flagBackorder(deps, input) {
  const { db, log } = deps;
  const { orderId, lineItemId, quantity, email, idemKey } = input;

  // 1. Client double-submit token (hidden form field, when the page sends one): a committed ledger entry
  //    for the same token means this exact submission already ran — report success, change nothing.
  const tokenKey = idemKey ? `bo-flag-tok-${idTail(orderId)}-${idemKey}` : null;
  if (tokenKey) {
    const led = deps.getEditAction(tokenKey);
    if (led && led.status === 'committed') {
      const p = safeParse(led.payload_json);
      const same = led.action === 'backorder/flag' && p && p.liId === lineItemId && p.qty === quantity;
      return same ? ok({ duplicate: true }) : fail('This form was already used for a different backorder. Reload the order and try again.');
    }
  }

  // 2. Live Shopify state — the only authority on what is on the order right now.
  let lines;
  try { lines = await deps.readLines(); }
  catch (e) { return fail(`Could not read the order from Shopify (${errMsg(e)}). Nothing was changed.`); }

  // 3. An existing row for this line: settle an interrupted one, then detect a double-submit.
  let prevRow = db.getBackorderRow(orderId, lineItemId);
  if (prevRow && isTransient(prevRow.status)) {
    const rec = reconcileTransient(deps, prevRow, lines);
    if (!rec.ok) return fail(rec.message, 'unconfirmed');
    prevRow = db.getBackorderRow(orderId, lineItemId);
  }
  if (prevRow && prevRow.status === BACKORDER_STATUS.PENDING && prevRow.shopify_removed_qty > 0) {
    const recentSame = prevRow.shopify_removed_qty === quantity
      && prevRow.created_by === email && deps.now() - prevRow.created_at <= DUPLICATE_WINDOW_MS;
    if (recentSame) return ok({ duplicate: true });
    return fail(`This line already has ${prevRow.shopify_removed_qty} unit(s) backordered and removed from the order. Undo that first if it needs to change.`);
  }

  // 4. Validate against the line's CURRENT Shopify quantity.
  const line = lines.find(l => l.liId === lineItemId);
  if (!line || !(line.currentQuantity > 0)) return fail('That line is no longer on the order. Reload the page and try again.');
  if (quantity > line.currentQuantity) {
    return fail(`Quantity must be between 1 and ${line.currentQuantity} (the units currently on this line). You entered ${quantity}.`);
  }
  if (!Number.isFinite(line.unitPrice) || line.unitPrice < 0) return fail('Could not determine this line\'s price, so nothing was changed.');

  // 5. Phase 1 — claim, with the complete invoice snapshot.
  const now = deps.now();
  const claim = db.claimBackorderRemoval({
    orderId, lineItemId, title: line.title, variantId: line.variantId, sku: line.sku, variantTitle: line.variantTitle,
    unitPrice: money2(line.unitPrice), currency: line.currency, quantity, priorQty: line.currentQuantity,
    createdBy: email, now,
  });
  if (!claim.ok) {
    return fail(claim.reason === 'already_backordered'
      ? 'This line is already backordered. Undo that first if it needs to change.'
      : 'Another backorder action on this line is still being confirmed. Reload the order in a moment.', 'rejected');
  }

  // 6. Phase 2 — the Shopify edit.
  const attemptKey = tokenKey || `bo-flag-${idTail(orderId)}-${idTail(lineItemId)}-${now}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = {
    liId: lineItemId, qty: quantity,
    staffNote: `Backordered ${quantity} x ${line.title}: removed from this order until stock arrives.`,
  };
  let editError = null, edited = null;
  try { edited = await deps.removeUnits({ line, quantity, idemKey: attemptKey, payload }); }
  catch (e) { editError = e; }

  // 7. Read Shopify back and decide. Never trust "no exception" or "exception" alone.
  //    The commit's own answer stands in for the read ONLY when it positively shows the expected quantity.
  const expected = line.currentQuantity - quantity;
  //    The line must be PRESENT in that answer: Shopify keeps a removed line at currentQuantity 0, so an answer that
  //    merely omits it proves nothing (the independent read below treats absent as 0; this shortcut will not).
  let fresh = confirmedByCommit(edited, editError, (ls) => ls.some(l => l.liId === lineItemId) && qtyOfLine(ls, lineItemId) === expected);
  if (!fresh) {
    if (editError) {
      // After an error the outcome is unknown and ONE independent read decides, as it always has.
      try { fresh = await deps.readLines(); }
      catch (e) { log.error(`[backorder] read-back after flag failed (${orderId} ${lineItemId}): ${errMsg(e)}`); }
    } else {
      // The edit reported success but its answer did not confirm it: settle, read, and do not believe an unchanged
      // quantity until it has survived the retries (a lagging read must not erase the record of removed units).
      fresh = await readBackAfterUnconfirmedCommit(deps, `flag (${orderId} ${lineItemId})`, (ls) => qtyOfLine(ls, lineItemId) === line.currentQuantity);
    }
  }
  let applied;
  if (fresh) {
    const after = qtyOfLine(fresh, lineItemId);
    if (after === expected) applied = true;
    // Unchanged after an ERROR is a definite "not applied". Unchanged after a reported SUCCESS that survived the
    // settling read and every retry is NOT definitive (stale read vs genuine no-op): never abandon on it.
    else if (after === line.currentQuantity) applied = editError ? false : null;
    else applied = editError ? null : true;                           // concurrent edit moved it; trust a success
    if (applied === true && after !== expected) log.warn(`[backorder] flag ${orderId} ${lineItemId}: Shopify shows ${after}, expected ${expected} — trusting the confirmed edit`);
  } else {
    applied = editError ? null : true;
  }

  if (applied === true) {
    if (!db.finalizeBackorderRemoval(orderId, lineItemId)) {
      log.error(`[backorder] flag ${orderId} ${lineItemId}: units ARE removed on Shopify but finalize found no 'applying' row — check the backorders table`);
    }
    if (editError) log.error(`[backorder] flag ${orderId} ${lineItemId}: Shopify reported "${errMsg(editError)}" but the removal IS in effect — finalized as pending`);
    return ok();
  }
  if (applied === false) {
    db.abandonBackorderClaim(orderId, lineItemId, claim.prev);
    return fail(errMsg(editError), 'not_applied');
  }
  if (!editError) {
    // Reported success + a read-back that never showed the change = unverifiable, NOT "nothing happened". The claim is
    // kept ('applying', claim_prior_qty recorded) so the next flag/undo on this line or the boot log reconciles it.
    log.error(`[backorder] UNCONFIRMED flag ${orderId} ${lineItemId} qty=${quantity} prior=${line.currentQuantity}: orderEditCommit reported success but the order still reads ${line.currentQuantity} after ${READBACK_RETRY_DELAYS_MS.length + 1} reads over ~${READBACK_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)}ms - claim NOT abandoned (the units may already be gone), row left 'applying' for reconcile; verify the order in Shopify`);
    return fail(`Shopify said the edit went through but this line still shows ${line.currentQuantity} unit(s) after re-checking, so the removal is unconfirmed. Refresh the order and check it in Shopify before retrying.`, 'unconfirmed');
  }
  log.error(`[backorder] UNCONFIRMED flag ${orderId} ${lineItemId} qty=${quantity} prior=${line.currentQuantity}: ${errMsg(editError)} — row left 'applying' for reconcile; verify the order in Shopify`);
  return fail(`Shopify did not confirm whether the units were removed (${errMsg(editError)}). Check the order in Shopify; do not repeat this until you have.`, 'unconfirmed');
}

// WHAT: put a backorder's removed units back on the Shopify order at the STORED unit price and mark the row
//   'restored'.
// deps: as flagBackorder plus restoreUnits({ mode:'raise'|'add', row, live, quantity, unitPrice, idemKey, payload })
//   -> { warnings?, lines? } (throws on rejection; `lines` as for flagBackorder's removeUnits).
// input: { orderId (gid), lineItemId (the id the line had when flagged), email }
// INVARIANT(S): idempotent — undoing an already-restored row is a success that changes nothing; the Shopify
//   idempotency key is derived from the row (not the request), so a retry after a crash between the Shopify
//   commit and our status flip replays the ledger instead of adding the units twice.
export async function undoBackorder(deps, input) {
  const { db, log } = deps;
  const { orderId, lineItemId } = input;

  let row = db.getBackorderRow(orderId, lineItemId);
  if (!row) return fail('There is no backorder recorded for that line.');
  if (row.status === BACKORDER_STATUS.RESTORED) return ok({ duplicate: true });
  if (row.status === BACKORDER_STATUS.FULFILLED) return fail('That backorder is already marked fulfilled, so there is nothing to put back.');
  // LEGACY flag-only row (nothing was ever removed from Shopify): clearing the flag is all "undo" can mean.
  if (row.status === BACKORDER_STATUS.PENDING && row.shopify_removed_qty === 0) {
    db.restoreBackorder(orderId, lineItemId, deps.now());
    return ok({ legacy: true });
  }

  let lines;
  try { lines = await deps.readLines(); }
  catch (e) { return fail(`Could not read the order from Shopify (${errMsg(e)}). Nothing was changed.`); }

  if (isTransient(row.status)) {
    const rec = reconcileTransient(deps, row, lines);
    if (!rec.ok) return fail(rec.message, 'unconfirmed');
    row = db.getBackorderRow(orderId, lineItemId);
    if (!row) return fail('That backorder was not applied, so there is nothing to put back.');
    if (row.status === BACKORDER_STATUS.RESTORED) return ok({ duplicate: true });
  }
  if (!(row.status === BACKORDER_STATUS.PENDING && row.shopify_removed_qty > 0)) {
    return fail('That backorder is not in a state that can be restored. Reload the order.');
  }

  const n = row.shopify_removed_qty;
  const price = row.unit_price == null ? NaN : Number(row.unit_price);
  if (!Number.isFinite(price) || price < 0) {
    return fail('The price saved with this backorder is missing, so it cannot be put back at the right price. Add the line manually in Shopify.');
  }

  const live = lines.find(l => l.liId === row.line_item_id);
  const mode = live && live.currentQuantity > 0 && pricesMatch(live.unitPrice, price) ? 'raise' : 'add';
  const before = sumMatching(lines, row);
  const beforeIds = new Set(lines.map(l => l.liId));
  if (!db.beginBackorderRestore(orderId, row.line_item_id, before)) {
    return fail('This backorder changed while it was being restored. Reload the order and try again.');
  }

  const attemptKey = `bo-restore-${idTail(orderId)}-${idTail(row.line_item_id)}-${row.created_at}`;
  const payload = {
    liId: row.line_item_id, qty: n, price: row.unit_price,
    staffNote: `Restored ${n} x ${row.line_item_title} to this order from backorder at ${money2(price)} each.`,
  };
  let editError = null, staged = null;
  try { staged = await deps.restoreUnits({ mode, row, live, quantity: n, unitPrice: price, idemKey: attemptKey, payload }); }
  catch (e) { editError = e; }

  // Same rule as flagBackorder: the commit's own answer replaces the read only as a POSITIVE confirmation.
  let fresh = confirmedByCommit(staged, editError, (ls) => sumMatching(ls, row) === before + n);
  if (!fresh) {
    if (editError) {
      try { fresh = await deps.readLines(); }
      catch (e) { log.error(`[backorder] read-back after undo failed (${orderId} ${lineItemId}): ${errMsg(e)}`); }
    } else {
      // Same rule as flagBackorder: a reported success whose answer did not confirm is settled, re-read and retried
      // before an unchanged quantity is believed.
      fresh = await readBackAfterUnconfirmedCommit(deps, `undo (${orderId} ${lineItemId})`, (ls) => sumMatching(ls, row) === before);
    }
  }
  let applied;
  if (fresh) {
    const after = sumMatching(fresh, row);
    if (after === before + n) applied = true;
    else if (after === before) applied = editError ? false : null;   // reported success + never changed: not definitive, never revert on it
    else applied = editError ? null : true;
    if (applied === true && after !== before + n) log.warn(`[backorder] undo ${orderId} ${lineItemId}: Shopify shows ${after}, expected ${before + n} — trusting the confirmed edit`);
  } else {
    applied = editError ? null : true;
  }

  if (applied === true) {
    if (!db.restoreBackorder(orderId, row.line_item_id, deps.now())) {
      log.error(`[backorder] undo ${orderId} ${lineItemId}: units ARE back on Shopify but no 'restoring' row could be marked restored — check the backorders table`);
    }
    if (editError) log.error(`[backorder] undo ${orderId} ${lineItemId}: Shopify reported "${errMsg(editError)}" but the restore IS in effect — marked restored`);
    const warnings = [...(staged?.warnings || [])];
    if (fresh) {
      const touched = fresh.filter(l => lineMatchesRow(l, row) && l.currentQuantity > 0 && (l.liId === live?.liId || !beforeIds.has(l.liId)));
      for (const l of touched) {
        if (!pricesMatch(l.unitPrice, price)) warnings.push(`Restored line is priced $${money2(l.unitPrice)} instead of the stored $${money2(price)}. Check the line price.`);
      }
    }
    return ok({ warnings });
  }
  if (applied === false) {
    db.revertBackorderRestore(orderId, row.line_item_id);
    return fail(errMsg(editError), 'not_applied');
  }
  if (!editError) {
    // Mirror of the flag case: the row stays 'restoring' (claim_prior_qty = `before`), so a retry reconciles instead of adding twice.
    log.error(`[backorder] UNCONFIRMED undo ${orderId} ${lineItemId} qty=${n} prior=${before}: orderEditCommit reported success but the order still reads ${before} after ${READBACK_RETRY_DELAYS_MS.length + 1} reads over ~${READBACK_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)}ms - NOT reverting (the units may already be back), row left 'restoring' for reconcile; verify the order in Shopify`);
    return fail('Shopify said the edit went through but the order does not yet show the restored unit(s) after re-checking, so the restore is unconfirmed. Refresh the order and check it in Shopify before retrying.', 'unconfirmed');
  }
  log.error(`[backorder] UNCONFIRMED undo ${orderId} ${lineItemId} qty=${n} prior=${before}: ${errMsg(editError)} — row left 'restoring' for reconcile; verify the order in Shopify`);
  return fail(`Shopify did not confirm whether the units were put back (${errMsg(editError)}). Check the order in Shopify before trying again.`, 'unconfirmed');
}
