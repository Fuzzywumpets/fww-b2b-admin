// Customers sortKey regression (2026-10-12). Shopify rejects `sortKey:AMOUNT_SPENT` on customers() —
// it is not a CustomerSortKeys value — and the whole query fails, which surfaced as the
// "Shopify unavailable" banner on /customers search and an empty /customers/export.csv.
//
// Source-level guard (same pattern as pagination-completeness): the live paths sit behind `if (!MOCK)`
// so the HTTP suite never sends these queries. Asserts every customers() call uses a valid sort key,
// and that spend ordering is done in-process via sortCustomers.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  \u2713 ${name}`); passed++; }
  catch (e) { console.log(`  \u2717 ${name}\n      ${e.message}`); failed++; }
}

console.log('\n\u2500\u2500 Unit: customers() sortKey validity \u2500\u2500\n');

const src = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
// Verified via Admin API introspection of CustomerSortKeys.
const VALID = new Set(['CREATED_AT', 'ID', 'LOCATION', 'NAME', 'RELEVANCE', 'UPDATED_AT']);

await test('no customers() query uses sortKey AMOUNT_SPENT', () => {
  assert.doesNotMatch(src, /sortKey\s*:\s*AMOUNT_SPENT/);
});

await test('every literal customers(...) sortKey is a valid CustomerSortKeys value', () => {
  const calls = [...src.matchAll(/customers\(first:[^)]*\)/g)].map(m => m[0]);
  assert.ok(calls.length >= 2, `expected >=2 customers() queries, found ${calls.length}`);
  for (const c of calls) {
    const k = c.match(/sortKey\s*:\s*([A-Z_]+)/);
    if (k) assert.ok(VALID.has(k[1]), `invalid sortKey ${k[1]} in ${c}`);
  }
});

await test('getCustomersData picks RELEVANCE when searching, else ID, and sorts the page in-process', () => {
  assert.match(src, /const sortKey = filters\.q \? 'RELEVANCE' : 'ID';/);
  assert.match(src, /customers: sortCustomers\(edges\.map\(e => e\.node\), filters\.sort\)/);
});

await test('/customers/export.csv sorts collected rows by lifetime spend', () => {
  assert.match(src, /return sortCustomers\(all, 'lifetime_spend_desc'\);/);
});

await test('sortCustomers orders by spend desc / name asc / orders desc', async () => {
  const m = src.match(/function sortCustomers\(customers, sort\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'sortCustomers definition not found');
  const sortCustomers = new Function(`${m[0]}; return sortCustomers;`)();
  const rows = () => [
    { displayName: 'Bea', amountSpent: { amount: '10.5' }, numberOfOrders: 9 },
    { displayName: 'Al',  amountSpent: { amount: '200' },  numberOfOrders: 1 },
    { displayName: 'Cy',  amountSpent: null,               numberOfOrders: 3 },
  ];
  assert.deepEqual(sortCustomers(rows()).map(c => c.displayName), ['Al', 'Bea', 'Cy']);
  assert.deepEqual(sortCustomers(rows(), 'name_asc').map(c => c.displayName), ['Al', 'Bea', 'Cy']);
  assert.deepEqual(sortCustomers(rows(), 'orders_desc').map(c => c.displayName), ['Bea', 'Cy', 'Al']);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
