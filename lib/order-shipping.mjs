// WHAT: current shipping for order pages, invoices and edit reconciliation.
// DEPENDS: server.mjs getOrderDetail/readCommittedLineState select currentShippingPriceSet;
// pdf.mjs and invoice creation use this helper so removed charges never reappear.
export function currentShippingAmount(order) {
  return Number(order.currentShippingPriceSet?.presentmentMoney?.amount
    ?? order.totalShippingPriceSet?.presentmentMoney?.amount ?? 0);
}

// WHAT: find the saved invoice that actually includes shipping; zero-shipping PDFs do not count.
// DEPENDS: server.mjs uses this in both the invoice dialog and POST billing guard so the
// offered choice matches what is saved. Existing invoice snapshots are never rewritten.
export function findShippingInvoice(invoices) {
  return invoices.find(invoice => Number(invoice.shipping) > 0);
}

export function parseShippingAmount(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw) || !Number.isSafeInteger(Math.round(Number(raw) * 100))) {
    throw new Error('Enter a shipping amount of 0 or more, with at most two decimal places.');
  }
  return Number(raw);
}

function checkedPayload(response, field) {
  const payload = response?.data?.[field];
  if (response?.errors?.length || !payload || !Array.isArray(payload.userErrors)) {
    throw new Error('Shopify did not confirm the shipping change. Reload the order before retrying.');
  }
  if (payload.userErrors.length) throw new Error(payload.userErrors.map(e => e.message).join('; '));
  if (!payload.calculatedOrder?.id) throw new Error('Shopify returned no calculated order.');
  return payload;
}

// WHAT: replace existing shipping inside the caller's uncommitted order edit.
// CHANGE-GUARD: committed shipping cannot be updated in place; remove ALL active lines,
// then add exactly one replacement. Any failed removal/addition must abort before commit.
// DEPENDS: server.mjs runs this under runOrderEdit's per-order lock and verifies committed
// currentShippingPriceSet before reporting success. This function never commits or emails.
export async function stageShippingReplacement({ shopifyFetch, calcId, amount, title, expectedAmount }) {
  const r = await shopifyFetch(`query($id:ID!){node(id:$id){... on CalculatedOrder{
    shippingLines{id title stagedStatus price{shopMoney{amount currencyCode} presentmentMoney{amount currencyCode}}}
  }}}`, { id: calcId });
  const lines = r?.data?.node?.shippingLines;
  if (!Array.isArray(lines)) throw new Error('Unable to read existing shipping charges.');
  const active = lines.filter(l => l.stagedStatus !== 'REMOVED');
  if (active.some(l => !l.id || !['NONE', 'ADDED'].includes(l.stagedStatus))) {
    throw new Error('Shipping has unrecognized staged changes. Reload the order.');
  }
  if (active.some(l => l.price?.presentmentMoney?.amount == null || !Number.isFinite(Number(l.price.presentmentMoney.amount)))) {
    throw new Error('Unable to read existing shipping amounts.');
  }
  const current = active.reduce((sum, l) => sum + Number(l.price.presentmentMoney.amount), 0);
  if (Math.abs(current - expectedAmount) > 0.005) {
    throw new Error('Shipping changed since this page was loaded, or carries a shipping discount. Reload the order; use Shopify for discounted shipping.');
  }
  // The staff UI uses USD; refusing other currencies avoids applying presentment dollars
  // as shop currency. Existing multi-currency orders remain readable.
  if (active.some(l => l.price.shopMoney.currencyCode !== 'USD' || l.price.presentmentMoney.currencyCode !== 'USD')) {
    throw new Error('Edit shipping for this currency in Shopify.');
  }
  if (active.length === 1 && Math.abs(current - amount) < 0.005 && active[0].title === title) return;
  for (const line of active) {
    const removed = await shopifyFetch(`mutation($id:ID!,$line:ID!){
      orderEditRemoveShippingLine(id:$id,shippingLineId:$line){calculatedOrder{id} userErrors{field message}}
    }`, { id: calcId, line: line.id });
    checkedPayload(removed, 'orderEditRemoveShippingLine');
  }
  const added = await shopifyFetch(`mutation($id:ID!,$shipping:OrderEditAddShippingLineInput!){
    orderEditAddShippingLine(id:$id,shippingLine:$shipping){calculatedOrder{id} userErrors{field message}}
  }`, { id: calcId, shipping: { title, price: { amount: amount.toFixed(2), currencyCode: 'USD' } } });
  checkedPayload(added, 'orderEditAddShippingLine');
}
