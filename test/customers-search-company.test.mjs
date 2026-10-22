// Standalone unit test (no server): /customers search on the CACHE path must match the company name.
//
// Why standalone: the cache path in getCustomersData is gated on `if (!MOCK)`, so the mock HTTP server
// never runs listCustomersFromCache. We drive db.mjs directly against the in-memory MOCK database.
//
// The bug this guards: the cache list renders `company` as the customer's name ("Champ Dog"), but the
// search only matched display_name and email, so typing the name shown on screen found nothing.

process.env.B2B_ADMIN_MOCK = '1';

const { upsertCustomerCache, listCustomersFromCache } = await import('../db.mjs');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }

console.log('\n── Unit: customers cache search matches company ──\n');

upsertCustomerCache({
  shopify_id: '7700001', gid: 'gid://shopify/Customer/7700001',
  email: 'owner@example.com', display_name: 'James Owner', company: 'Champ Dog',
  tags: ['b2b'], amount_spent_total: 500, orders_count: 3,
});
upsertCustomerCache({
  shopify_id: '7700002', gid: 'gid://shopify/Customer/7700002',
  email: 'nocompany@example.com', display_name: 'No Company Person', company: null,
  tags: ['b2b'], amount_spent_total: 10, orders_count: 1,
});

await test('a partial, case-insensitive company match finds the customer', () => {
  const rows = listCustomersFromCache({ q: 'champ' });
  assert(rows.some(r => r.id === 'gid://shopify/Customer/7700001'), 'Champ Dog not found by "champ"');
});
await test('the matched row displays the company name', () => {
  const row = listCustomersFromCache({ q: 'CHAMP DOG' }).find(r => r.id === 'gid://shopify/Customer/7700001');
  assert(row && row.displayName === 'Champ Dog', `got ${row && row.displayName}`);
});
await test('personal name and email still match; a NULL company does not break the query', () => {
  assert(listCustomersFromCache({ q: 'james owner' }).length >= 1, 'name match lost');
  assert(listCustomersFromCache({ q: 'nocompany@' }).length === 1, 'email match lost / NULL company broke it');
});
await test('a non-matching query still returns nothing', () => {
  assert(listCustomersFromCache({ q: 'zzz-no-such-customer' }).length === 0);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
