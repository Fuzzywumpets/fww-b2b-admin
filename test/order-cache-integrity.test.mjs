// Standalone unit test (no server): order/line-item cache integrity.
//
// Runs against the in-memory MOCK database, because both behaviours under test are DB-layer writes
// that the mock HTTP server never exercises — getOrdersData() short-circuits to the MOCK fixture
// array before it ever reads orders_cache, so an API-level assertion would be a false green.
//
// Covers two money-affecting regressions:
//   H14 — upsertOrderLineItemsCache used to be a bare INSERT OR REPLACE with no unique key it could
//         ever match, so every re-sync of an order APPENDED a second full copy of its lines and the
//         reports page multiplied product revenue by the number of syncs.
//   H15 — the REST orders/* webhook writes lowercase financial_status ('paid') while every cache
//         query compares uppercase ('PAID'), so a webhook-updated order silently dropped out of
//         every status-filtered view and out of the customer unpaid-balance total.

process.env.B2B_ADMIN_MOCK = '1';

const {
  upsertOrderLineItemsCache,
  upsertOrderCache,
  upsertCustomerCache,
  listOrdersFromCache,
  getOutstandingBalanceForCustomer,
  getOrderFromCache,
  getReportsDataFromCache,
  default: db,
} = await import('../db.mjs');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

function countLines(orderId) {
  return db.prepare('SELECT COUNT(*) AS n FROM order_line_items_cache WHERE order_shopify_id = ?').get(orderId).n;
}

// Two lines, as the orders/* webhook hands them over.
function lines() {
  return [
    { line_id: '1', sku: 'COLLAR-1', title: 'Elite Collar', quantity: 2, price: 25, total_discount: 0, vendor: 'Fuzzywumpets' },
    { line_id: '2', sku: 'LEAD-1',   title: 'Elite Lead',   quantity: 1, price: 40, total_discount: 0, vendor: 'Fuzzywumpets' },
  ];
}

console.log('\n── Unit: order + line-item cache integrity (standalone, no server) ──');

// ── H14: line-item duplication ───────────────────────────────────────────────

await test('H14: re-syncing the same order does not duplicate its line items', async () => {
  upsertOrderLineItemsCache('7001', lines());
  assertEqual(countLines('7001'), 2, 'first sync writes exactly the supplied lines');
  upsertOrderLineItemsCache('7001', lines());
  upsertOrderLineItemsCache('7001', lines());
  assertEqual(countLines('7001'), 2, 'a webhook redelivery must REPLACE the line set, not append a second copy');
});

await test('H14: an order edited down to fewer lines leaves no orphan rows', async () => {
  upsertOrderLineItemsCache('7002', lines());
  assertEqual(countLines('7002'), 2);
  upsertOrderLineItemsCache('7002', [lines()[0]]);
  assertEqual(countLines('7002'), 1, 'the removed line must be deleted, not left behind inflating reports');
  const remaining = db.prepare('SELECT sku FROM order_line_items_cache WHERE order_shopify_id = ?').all('7002');
  assertEqual(remaining[0].sku, 'COLLAR-1');
});

await test('H14: re-syncing one order does not touch another order\'s lines', async () => {
  upsertOrderLineItemsCache('7003', lines());
  upsertOrderLineItemsCache('7004', lines());
  upsertOrderLineItemsCache('7003', lines());
  assertEqual(countLines('7004'), 2, 'the DELETE must be scoped to order_shopify_id');
});

await test('H14: an order re-synced twice does not double its product revenue in reports', async () => {
  upsertCustomerCache({ shopify_id: '9100', gid: 'gid://shopify/Customer/9100', email: 'b2b@example.com', display_name: 'Dedupe Co', tags: ['b2b'] });
  upsertOrderCache({
    shopify_id: '7100', gid: 'gid://shopify/Order/7100', name: '#7100',
    customer_shopify_id: '9100', created_at: Date.now(), total_price: 90,
    financial_status: 'PAID',
  });
  upsertOrderLineItemsCache('7100', lines());
  const once = getReportsDataFromCache();
  const collarOnce = once.products.find(p => p.sku === 'COLLAR-1');
  assertEqual(collarOnce.revenue, 50, '2 x $25 = $50');
  assertEqual(collarOnce.units, 2);

  // Exactly what a Shopify webhook redelivery does.
  upsertOrderLineItemsCache('7100', lines());
  const twice = getReportsDataFromCache();
  const collarTwice = twice.products.find(p => p.sku === 'COLLAR-1');
  assertEqual(collarTwice.revenue, 50, 're-sync must NOT double product revenue');
  assertEqual(collarTwice.units, 2, 're-sync must NOT double units sold');
});

// ── H15: financial-status casing ─────────────────────────────────────────────

await test('H15: a lowercase webhook financial_status is stored uppercase', async () => {
  upsertOrderCache({
    shopify_id: '7200', gid: 'gid://shopify/Order/7200', name: '#7200',
    customer_shopify_id: '9100', created_at: Date.now(), total_price: 100,
    // REST webhook payloads are lowercase.
    financial_status: 'paid', fulfillment_status: 'fulfilled',
  });
  const row = getOrderFromCache('7200');
  assertEqual(row.financial_status, 'PAID', 'readers compare uppercase; storing raw lowercase hides the order');
  assertEqual(row.fulfillment_status, 'FULFILLED');
});

await test('H15: a webhook-updated order still matches the paid status filter', async () => {
  const found = listOrdersFromCache({ status: 'paid' }).some(o => o.name === '#7200');
  assert(found, 'order written by a webhook must not vanish from /orders?status=paid');
});

await test('H15: a webhook-updated unpaid order still counts in the customer balance', async () => {
  upsertCustomerCache({ shopify_id: '9200', gid: 'gid://shopify/Customer/9200', email: 'owed@example.com', display_name: 'Owing Co', tags: ['b2b'] });
  upsertOrderCache({
    shopify_id: '7300', gid: 'gid://shopify/Order/7300', name: '#7300',
    customer_shopify_id: '9200', created_at: Date.now(), total_price: 250,
    financial_status: 'pending',
  });
  const bal = getOutstandingBalanceForCustomer('9200');
  assertEqual(bal.count, 1, 'a lowercase-status order must not be dropped from the unpaid sum');
  assertEqual(bal.total, 250);
});

await test('H15: uppercase statuses from the GraphQL sync are unchanged', async () => {
  upsertOrderCache({
    shopify_id: '7400', gid: 'gid://shopify/Order/7400', name: '#7400',
    customer_shopify_id: '9100', created_at: Date.now(), total_price: 10,
    financial_status: 'PARTIALLY_REFUNDED',
  });
  assertEqual(getOrderFromCache('7400').financial_status, 'PARTIALLY_REFUNDED');
});

await test('H15: a null fulfillment_status stays null (unfulfilled orders)', async () => {
  upsertOrderCache({
    shopify_id: '7500', gid: 'gid://shopify/Order/7500', name: '#7500',
    customer_shopify_id: '9100', created_at: Date.now(), total_price: 10,
    financial_status: 'paid', fulfillment_status: null,
  });
  assertEqual(getOrderFromCache('7500').fulfillment_status, null);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
