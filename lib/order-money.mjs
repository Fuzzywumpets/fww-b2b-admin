/**
 * Money-correctness helpers extracted from server.mjs so they can be unit-tested without a live
 * Shopify bridge. Every function here is pure or takes `shopifyFetch` by injection (same pattern as
 * lib/xero-customer-sync.mjs), so a fake can drive the userError branches that MOCK mode can never
 * reach — those branches are exactly where the wrong-money bugs lived.
 *
 * Rules that are LAW in this codebase and are encoded here:
 *   - a line's committed unit price is ALREADY wholesale; never re-discount it implicitly
 *   - a price that cannot be parsed is NOT $0.00 — $0.00 is a 100%-off comp and must be typed
 */

/**
 * Parse the batch order-edit `prices` form map into numbers.
 *
 * DEPENDS: POST /orders/:id/edit in server.mjs rejects the whole batch when `invalid` is non-empty.
 * The edit-mode UI submits a price input for EVERY line, so a field the operator cleared arrives as
 * "" — `parseFloat("") || 0` used to coerce that to 0, which downstream reads as a legitimate
 * 100%-off ("B2B price adj") and comps the line with a success banner. Non-finite and negative
 * inputs are therefore reported, never coerced. A deliberate comp is still expressible by typing an
 * explicit "0", which parses to a finite 0 and passes.
 *
 * @param {Record<string,unknown>} prices raw req.body.prices
 * @returns {{ prices: Record<string, number>, invalid: string[] }}
 */
export function parseLinePrices(prices) {
  const out = {};
  const invalid = [];
  for (const [liId, raw] of Object.entries(prices || {})) {
    const n = parseFloat(raw);
    if (!Number.isFinite(n) || n < 0) { invalid.push(liId); continue; }
    out[liId] = n;
  }
  return { prices: out, invalid };
}

/**
 * Apply per-line unit-price changes inside an OPEN (uncommitted) calculatedOrder edit session, by
 * removing the line's existing explicit discount and adding a replacement at the new percentage.
 *
 * DEPENDS: callers must run this BEFORE orderEditCommit and must let the throw propagate past the
 * commit. An abandoned calculatedOrder persists nothing, so throwing is the safe outcome; swallowing
 * the add failure commits the REMOVE alone and reverts the line from wholesale to full retail
 * (e.g. $12.50 -> $24.99) behind a success banner. This mirrors POST /orders/:id/line/price, which
 * throws on the same userErrors.
 *
 * orderEditUpdateDiscount is deliberately NOT used: discounts stack on commit.
 *
 * @returns {Promise<{ applied: Array<{liId:string,from:number,to:number,pct:number}>, skipped: Array<{liId:string,reason:string}> }>}
 */
export async function applyLinePriceChanges({ shopifyFetch, calcId, pricesMap, discountIdMap, idMap, log = () => {} }) {
  const applied = [];
  const skipped = [];
  for (const [origLiId, newPrice] of Object.entries(pricesMap || {})) {
    const info = discountIdMap[origLiId];
    if (!info) { skipped.push({ liId: origLiId, reason: 'no explicit discount on line' }); continue; }
    const calcLiId = idMap[origLiId];
    if (!calcLiId) { skipped.push({ liId: origLiId, reason: 'no calc mapping' }); continue; }
    const currentPrice = info.wholesalePrice;
    if (Math.abs(newPrice - currentPrice) < 0.005) { skipped.push({ liId: origLiId, reason: 'unchanged' }); continue; }
    const newPct = ((info.retailPrice - newPrice) / info.retailPrice) * 100;
    if (!Number.isFinite(newPct) || newPct < 0 || newPct > 100) {
      // Unchanged pre-existing behaviour: no money moves, the line keeps its wholesale price. The
      // caller surfaces this to staff so the skip is not silent.
      log('[order-edit] price out of range — skipping', origLiId);
      skipped.push({ liId: origLiId, reason: `price $${Number(newPrice).toFixed(2)} is out of range for retail $${Number(info.retailPrice).toFixed(2)}` });
      continue;
    }
    // Step 1: remove existing per-line B2B discount.
    const remRes = await shopifyFetch(
      `mutation rem($id:ID!,$did:ID!){
        orderEditRemoveDiscount(id:$id,discountApplicationId:$did){
          calculatedOrder{id} userErrors{field message}
        }
      }`,
      { id: calcId, did: info.discountAppId }
    );
    const remErrs = remRes?.data?.orderEditRemoveDiscount?.userErrors || [];
    if (remErrs.length) {
      // Nothing was removed, so the line still carries its wholesale discount — safe to skip.
      log('[order-edit] remove discount failed — line left unchanged:', origLiId, JSON.stringify(remErrs));
      skipped.push({ liId: origLiId, reason: 'remove failed: ' + remErrs.map(e => e.message).join('; ') });
      continue;
    }
    // Step 2: add the replacement discount at the adjusted percentage. From here the session is
    // un-discounted for this line — an add failure MUST abort the batch, never fall through to commit.
    const addRes = await shopifyFetch(
      `mutation add($id:ID!,$li:ID!,$d:OrderEditAppliedDiscountInput!){
        orderEditAddLineItemDiscount(id:$id,lineItemId:$li,discount:$d){
          addedDiscountStagedChange{id} calculatedOrder{id} userErrors{field message}
        }
      }`,
      { id: calcId, li: calcLiId, d: { percentValue: parseFloat(newPct.toFixed(4)), description: 'B2B price adj' } }
    );
    const addErrs = addRes?.data?.orderEditAddLineItemDiscount?.userErrors || [];
    if (addErrs.length) {
      throw new Error(`price update "${origLiId}": ${addErrs.map(e => e.message).join('; ')}`);
    }
    applied.push({ liId: origLiId, from: currentPrice, to: newPrice, pct: newPct });
    log('[order-edit] price updated:', origLiId, currentPrice, '->', newPrice, `(${newPct.toFixed(2)}%)`);
  }
  return { applied, skipped };
}

/**
 * Mark a batch of orders paid, reading orderMarkAsPaid userErrors per order.
 *
 * DEPENDS: POST /orders/bulk in server.mjs audit-logs 'mark_paid' ONLY for ids in `paid` and
 * redirects with ?error=mark_paid_partial when `failed` is non-empty. Previously the response was
 * discarded, so an order Shopify refused (already captured, wrong gateway state, not pending) was
 * still audit-logged as paid and reported as success. This bulk path also skips Xero payment
 * recording (documented asymmetry with POST /orders/:id/mark-paid), so there is no second system
 * that would catch the discrepancy.
 *
 * @returns {Promise<{ paid: string[], failed: Array<{ id: string, message: string }> }>}
 */
export async function bulkMarkOrdersPaid({ shopifyFetch, ids, toGid, log = () => {} }) {
  const paid = [];
  const failed = [];
  for (const numId of ids || []) {
    try {
      const r = await shopifyFetch(`mutation orderMarkAsPaid($input:OrderMarkAsPaidInput!){
        orderMarkAsPaid(input:$input){ order{id displayFinancialStatus} userErrors{field message} }
      }`, { input: { id: toGid(numId) } });
      const ue = r?.data?.orderMarkAsPaid?.userErrors || [];
      if (ue.length) {
        const message = ue.map(e => e.message).join('; ');
        log('bulk mark-paid userError:', numId, message);
        failed.push({ id: String(numId), message });
        continue;
      }
      paid.push(String(numId));
    } catch (err) {
      log('bulk mark-paid error:', numId, err.message);
      failed.push({ id: String(numId), message: err.message });
    }
  }
  return { paid, failed };
}
