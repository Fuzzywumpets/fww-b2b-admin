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
//
// INVARIANT(S): shopify_removed_qty > 0 only after Shopify confirmed (finalize). Every unit-moving Shopify
//   call goes through server.mjs runOrderEdit (begin/commit, per-order lock, idempotency ledger) — there is
//   no parallel Shopify edit path here. Staging functions never commit.
//
// DEPENDS: db.mjs backorder functions (claim/finalize/abandon/begin/revert/restore), BACKORDER_STATUS
//   below mirrors their status strings. server.mjs POST /orders/:id/backorder[/undo] wires `deps`.
// SYNC: the Shopify mutations here deliberately match the ones in server.mjs POST /orders/:id/line/qty,
//   /line/remove and /line/add (same arguments, same 'B2B wholesale' discount description) — change them together.

export const BACKORDER_STATUS = Object.freeze({
  APPLYING: 'applying', PENDING: 'pending', RESTORING: 'restoring', RESTORED: 'restored', FULFILLED: 'fulfilled',
});
// Flash codes the order page reads from ?success= / ?error= (the page renders them; this module never does).
export const BACKORDER_FLASH = Object.freeze({
  FLAGGED: 'backorder_flagged', RESTORED: 'backorder_restored', FAILED: 'backorder_shopify_failed',
});
// A second identical flag on the same line inside this window is a double-submit, not a new request.
export const DUPLICATE_WINDOW_MS = 60_000;
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
//   line's CURRENT Shopify quantity — is checked against live data in flagBackorder). ETA is optional but,
//   when present, must be a real calendar date.
export function parseBackorderRequest({ lineItemId, quantity, eta } = {}) {
  const id = String(lineItemId ?? '').trim();
  if (!id) return { ok: false, message: 'No line item was selected.' };
  const raw = String(quantity ?? '').trim();
  if (!/^\d{1,9}$/.test(raw) || Number(raw) < 1) {
    return { ok: false, message: 'Quantity must be a whole number of 1 or more.' };
  }
  const etaRaw = String(eta ?? '').trim();
  let etaDate = null;
  if (etaRaw) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(etaRaw);
    const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
    if (!d || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
      return { ok: false, message: 'Expected ship date must be a valid date (YYYY-MM-DD).' };
    }
    etaDate = etaRaw;
  }
  return { ok: true, lineItemId: id, quantity: Number(raw), etaDate };
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
      { id: calcId, li: li.id, d: { percentValue: plan.pct, description: 'B2B wholesale' } }), 'orderEditAddLineItemDiscount');
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

// WHAT: flag `quantity` units of a line as backordered and remove them from the Shopify order.
// deps: { db, getEditAction(key), readLines(), removeUnits({line, quantity, idemKey, payload}), now(), log }
//   readLines() -> [{ liId, title, variantTitle, sku, variantId, currentQuantity, unitPrice, currency }]
//   removeUnits() must run ONE atomic Shopify edit (throw on any rejection) and may not touch our DB.
// input: { orderId (gid), lineItemId, quantity (int), etaDate|null, email, idemKey|null }
// Returns { ok:true, duplicate?:true } | { ok:false, message, state:'rejected'|'not_applied'|'unconfirmed' }.
// INVARIANT(S): the caller must serialise calls per order (server.mjs withOrderLock) — this function
//   assumes no other flag/undo for the same order interleaves with it.
export async function flagBackorder(deps, input) {
  const { db, log } = deps;
  const { orderId, lineItemId, quantity, etaDate, email, idemKey } = input;
  const eta = etaDate || null;

  // 1. Client double-submit token (hidden form field, when the page sends one): a committed ledger entry
  //    for the same token means this exact submission already ran — report success, change nothing.
  const tokenKey = idemKey ? `bo-flag-tok-${idTail(orderId)}-${idemKey}` : null;
  if (tokenKey) {
    const led = deps.getEditAction(tokenKey);
    if (led && led.status === 'committed') {
      const p = safeParse(led.payload_json);
      const same = led.action === 'backorder/flag' && p && p.liId === lineItemId && p.qty === quantity && (p.eta || null) === eta;
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
    const recentSame = prevRow.shopify_removed_qty === quantity && (prevRow.eta_date || null) === eta
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
    etaDate: eta, createdBy: email, now,
  });
  if (!claim.ok) {
    return fail(claim.reason === 'already_backordered'
      ? 'This line is already backordered. Undo that first if it needs to change.'
      : 'Another backorder action on this line is still being confirmed. Reload the order in a moment.', 'rejected');
  }

  // 6. Phase 2 — the Shopify edit.
  const attemptKey = tokenKey || `bo-flag-${idTail(orderId)}-${idTail(lineItemId)}-${now}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = {
    liId: lineItemId, qty: quantity, eta,
    staffNote: `Backordered ${quantity} x ${line.title}${eta ? ` (ETA ${eta})` : ''}: removed from this order until stock arrives.`,
  };
  let editError = null;
  try { await deps.removeUnits({ line, quantity, idemKey: attemptKey, payload }); }
  catch (e) { editError = e; }

  // 7. Read Shopify back and decide. Never trust "no exception" or "exception" alone.
  let fresh = null;
  try { fresh = await deps.readLines(); }
  catch (e) { log.error(`[backorder] read-back after flag failed (${orderId} ${lineItemId}): ${errMsg(e)}`); }
  const expected = line.currentQuantity - quantity;
  let applied;
  if (fresh) {
    const after = qtyOfLine(fresh, lineItemId);
    if (after === expected) applied = true;
    else if (after === line.currentQuantity) applied = false;          // even if the call "succeeded"
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
    return fail(editError ? errMsg(editError) : 'Shopify accepted the edit but the line quantity did not change, so nothing was backordered.', 'not_applied');
  }
  log.error(`[backorder] UNCONFIRMED flag ${orderId} ${lineItemId} qty=${quantity} prior=${line.currentQuantity}: ${errMsg(editError)} — row left 'applying' for reconcile; verify the order in Shopify`);
  return fail(`Shopify did not confirm whether the units were removed (${errMsg(editError)}). Check the order in Shopify; do not repeat this until you have.`, 'unconfirmed');
}

// WHAT: put a backorder's removed units back on the Shopify order at the STORED unit price and mark the row
//   'restored'.
// deps: as flagBackorder plus restoreUnits({ mode:'raise'|'add', row, live, quantity, unitPrice, idemKey, payload })
//   -> { warnings? } (throws on rejection).
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

  let fresh = null;
  try { fresh = await deps.readLines(); }
  catch (e) { log.error(`[backorder] read-back after undo failed (${orderId} ${lineItemId}): ${errMsg(e)}`); }
  let applied;
  if (fresh) {
    const after = sumMatching(fresh, row);
    if (after === before + n) applied = true;
    else if (after === before) applied = false;
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
    return fail(editError ? errMsg(editError) : 'Shopify accepted the edit but the order did not change, so nothing was restored.', 'not_applied');
  }
  log.error(`[backorder] UNCONFIRMED undo ${orderId} ${lineItemId} qty=${n} prior=${before}: ${errMsg(editError)} — row left 'restoring' for reconcile; verify the order in Shopify`);
  return fail(`Shopify did not confirm whether the units were put back (${errMsg(editError)}). Check the order in Shopify before trying again.`, 'unconfirmed');
}
