// Standalone unit test (no server): the /orders and /customers lists must not lie about how much
// they are showing.
//
// Why this can't be an HTTP test: in prod both lists take the CACHE path in getOrdersData /
// getCustomersData, which is gated on `if (!MOCK)`. The mock server therefore never exercises the
// capped query at all, and an API-level assertion would report a false green over the exact code
// that truncates. So we drive db.mjs directly against the in-memory MOCK database, plus the pure
// copy helpers that server.mjs renders.
//
// The bug this guards: the cache query had a hardcoded LIMIT (200 orders / 100 customers) with no
// offset or cursor, and the page footer printed `rows.length` as the total with no pager. Past the
// cap the page read "200 orders" as though that were every matching order.

process.env.B2B_ADMIN_MOCK = '1';

const {
  upsertCustomerCache, upsertOrderCache,
  listCustomersFromCache, listOrdersFromCache,
} = await import('../db.mjs');
const {
  ORDERS_LIST_LIMIT, CUSTOMERS_LIST_LIMIT, listCountLabel, truncationNoticeHtml,
} = await import('../lib/list-truncation.mjs');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

function seedCustomer(i) {
  upsertCustomerCache({
    shopify_id: String(9000 + i),
    gid: `gid://shopify/Customer/${9000 + i}`,
    email: `buyer${i}@example.com`,
    display_name: `Buyer ${i}`,
    company: `Company ${i}`,
    tags: ['b2b'],
    amount_spent_total: 100000 - i, // descending spend keeps ordering deterministic
    orders_count: 1,
    created_at: Date.now(),
  });
}

function seedOrder(i, customerShopifyId) {
  upsertOrderCache({
    shopify_id: String(70000 + i),
    gid: `gid://shopify/Order/${70000 + i}`,
    name: `#${70000 + i}`,
    customer_shopify_id: customerShopifyId,
    created_at: Date.now() - i * 1000,
    processed_at: Date.now() - i * 1000,
    financial_status: 'PAID',
    fulfillment_status: 'FULFILLED',
    total_price: 250,
    currency: 'USD',
  });
}

console.log('\nList truncation (ui-truthfulness)');

// ── customers ────────────────────────────────────────────────────────────────
await test('customers: under the cap reports truncated=false', async () => {
  for (let i = 0; i < 5; i++) seedCustomer(i);
  const rows = listCustomersFromCache({ segment: 'b2b' });
  assertEqual(rows.length, 5);
  assertEqual(rows.truncated, false, 'a short list must not claim truncation');
});

await test(`customers: exactly ${CUSTOMERS_LIST_LIMIT} rows is NOT truncated (no off-by-one)`, async () => {
  for (let i = 5; i < CUSTOMERS_LIST_LIMIT; i++) seedCustomer(i);
  const rows = listCustomersFromCache({ segment: 'b2b' });
  assertEqual(rows.length, CUSTOMERS_LIST_LIMIT);
  assertEqual(rows.truncated, false, 'a full page that happens to be the whole result set is not truncated');
});

await test(`customers: past ${CUSTOMERS_LIST_LIMIT} rows returns the cap AND flags truncated`, async () => {
  for (let i = CUSTOMERS_LIST_LIMIT; i < CUSTOMERS_LIST_LIMIT + 25; i++) seedCustomer(i);
  const rows = listCustomersFromCache({ segment: 'b2b' });
  assertEqual(rows.length, CUSTOMERS_LIST_LIMIT, 'page size must stay capped');
  assertEqual(rows.truncated, true, 'SILENT TRUNCATION: >cap customers matched but the list reports a complete set');
});

await test('customers: filters.limit is honored (it used to be accepted and ignored)', async () => {
  // getCustomersPendingXeroReview passes {segment:'b2b', limit:999} and was silently getting 100.
  const rows = listCustomersFromCache({ segment: 'b2b', limit: 999 });
  assertEqual(rows.length, CUSTOMERS_LIST_LIMIT + 25, 'limit:999 must return every matching row');
  assertEqual(rows.truncated, false);
});

await test('customers: a nonsense limit falls back to the default rather than truncating everything', async () => {
  for (const bad of [0, -5, NaN, 'abc', null]) {
    const rows = listCustomersFromCache({ segment: 'b2b', limit: bad });
    assertEqual(rows.length, CUSTOMERS_LIST_LIMIT, `limit=${String(bad)} must fall back to the default page size`);
  }
});

await test('customers: truncated flag does not leak into the row shape', async () => {
  const rows = listCustomersFromCache({ segment: 'b2b' });
  assert(Array.isArray(rows), 'return value must still be a plain array');
  assert(!Object.keys(rows).includes('truncated'), 'truncated must be non-enumerable');
  assert(!JSON.stringify(rows).includes('truncated'), 'truncated must not serialize into API payloads');
});

// ── orders ───────────────────────────────────────────────────────────────────
await test('orders: under the cap reports truncated=false', async () => {
  for (let i = 0; i < 10; i++) seedOrder(i, '9000');
  const rows = listOrdersFromCache({});
  assertEqual(rows.length, 10);
  assertEqual(rows.truncated, false);
});

await test(`orders: past ${ORDERS_LIST_LIMIT} rows returns the cap AND flags truncated`, async () => {
  for (let i = 10; i < ORDERS_LIST_LIMIT + 20; i++) seedOrder(i, '9000');
  const rows = listOrdersFromCache({});
  assertEqual(rows.length, ORDERS_LIST_LIMIT, 'page size must stay capped');
  assertEqual(rows.truncated, true, 'SILENT TRUNCATION: >cap orders matched but the list reports a complete set');
});

await test('orders: a FILTERED view is flagged too — a narrowed search can still drop matches', async () => {
  const rows = listOrdersFromCache({ status: 'paid' });
  assertEqual(rows.length, ORDERS_LIST_LIMIT);
  assertEqual(rows.truncated, true, 'filtered lists are capped by the same LIMIT and must say so');
});

await test('orders: filters.limit is honored', async () => {
  const rows = listOrdersFromCache({ limit: 5 });
  assertEqual(rows.length, 5);
  assertEqual(rows.truncated, true);
  const all = listOrdersFromCache({ limit: 1000 });
  assertEqual(all.length, ORDERS_LIST_LIMIT + 20);
  assertEqual(all.truncated, false);
});

await test('orders: row shape unchanged (mapped Shopify-ish fields still present)', async () => {
  const [row] = listOrdersFromCache({ limit: 1 });
  assert(row.id.startsWith('gid://shopify/Order/'), 'gid mapping intact');
  assert(row.totalPriceSet?.presentmentMoney?.amount, 'money shape intact');
  assertEqual(row.customer.email, 'buyer0@example.com', 'customer join intact');
});

// ── the copy the user actually reads ─────────────────────────────────────────
await test('footer: an untruncated list still reads as a plain count', async () => {
  assertEqual(listCountLabel({ count: 3, noun: 'order', truncated: false }), '3 orders');
  assertEqual(listCountLabel({ count: 1, noun: 'order', truncated: false }), '1 order');
  assertEqual(listCountLabel({ count: 0, noun: 'customer', truncated: false }), '0 customers');
});

await test('footer: a truncated list never presents the cap as a total', async () => {
  const label = listCountLabel({ count: ORDERS_LIST_LIMIT, noun: 'order', truncated: true });
  assert(label.includes('first'), `footer must say it is showing only the first N — got "${label}"`);
  assert(/refine/i.test(label), 'footer must tell the user what to do about it');
  assert(label !== `${ORDERS_LIST_LIMIT} orders`, 'footer must not read as a complete total');
});

// B2B-16 regression. /leads can supply a true total (countLeads), so listCountLabel grew an optional
// `total`. The bug this guards: renderLeadsList originally appended " of 342 matching" AFTER the
// label, but the truncated branch already returns a COMPLETE sentence, producing
// "showing the first 100 leads — more match, refine the filters of 342 matching".
// Qodo caught it; the HTTP assertion did not, because it only substring-matched "showing the first".
await test('footer: with a true total, the truncated label is ONE well-formed sentence', async () => {
  const label = listCountLabel({ count: 100, noun: 'lead', truncated: true, total: 342 });
  assertEqual(label, 'showing the first 100 of 342 leads — refine the filters');
  assert(!/filters .*of \d+ matching/.test(label), 'label must not be two sentences glued together');
  assert(label.includes('342'), 'the whole point of passing total is to name the real number');
});

await test('footer: omitting total preserves the exact wording /orders and /customers ship', async () => {
  // These two read from a cache path with no true total. PR #13's copy must not change under them.
  assertEqual(listCountLabel({ count: 200, noun: 'order', truncated: true }),
    'showing the first 200 orders — more match, refine the filters');
  // A nonsense/unusable total must fall back rather than render "of NaN" or "of 5" under a 100-row page.
  assertEqual(listCountLabel({ count: 100, noun: 'lead', truncated: true, total: NaN }),
    'showing the first 100 leads — more match, refine the filters');
  assertEqual(listCountLabel({ count: 100, noun: 'lead', truncated: true, total: 100 }),
    'showing the first 100 leads — more match, refine the filters');
});

await test('banner: only renders when something was actually cut off', async () => {
  assertEqual(truncationNoticeHtml({ truncated: false, limit: 200, noun: 'order' }), '');
  const html = truncationNoticeHtml({ truncated: true, limit: 200, noun: 'order' });
  assert(html.includes('data-truncation-notice'), 'banner needs its test hook');
  assert(html.includes('200'), 'banner must name the cap');
  assert(html.includes('alert-warning'), 'banner must be styled as a warning');
});

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
