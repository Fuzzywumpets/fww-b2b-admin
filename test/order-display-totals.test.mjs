// Standalone unit test: an EDITED order must be shown and summed at its CURRENT total, never the
// frozen original.
//
// THE BUG (2026-08-28). Shopify freezes total_price/subtotal_price the moment an order is edited;
// current_total/current_subtotal carry the truth. On 2026-06-29 the cache writers and the row
// hydrator were taught that, and a migration added the current_* columns — whose own comment says
// "the LIST must show current_total". The readers were never changed. Two months later order #38953
// was edited from $4,771.82 down to $4,469.82 and the Dashboard, the Accounting page, the customer
// sales-range widget and the customer outstanding-balance widget all still reported $4,771.82: a
// $302 overstatement on that order and on every other edited order, with the correct figure sitting
// unread in the very next column.
//
// Standalone because both halves are unreachable from the HTTP suites: the cache paths are gated on
// `if (!MOCK)` so the mock server never reads orders_cache, and the render sites are template
// strings. The SQL gets a real DB; the render sites get source guards.

process.env.B2B_ADMIN_MOCK = '1';

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cacheRowTotal, cacheRowSubtotal, listRowTotalAmount } from '../lib/order-display-totals.mjs';

const {
  upsertOrderCache,
  upsertCustomerCache,
  getOutstandingBalanceForCustomer,
  getOrderSpendFromCache,
  listOrdersFromCache,
} = await import('../db.mjs');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}

console.log('\n── Unit: edited orders show their CURRENT total ──\n');

// ── the accessors ────────────────────────────────────────────────────────────

await test('an edited row reports the CURRENT total, not the frozen one', () => {
  // #38953 to the cent: ordered $4,771.82, edited down to $4,469.82.
  const row = { total_price: 4771.82, current_total: 4469.82, subtotal_price: 4771.82, current_subtotal: 4469.82 };
  assert.equal(cacheRowTotal(row), 4469.82);
  assert.equal(cacheRowSubtotal(row), 4469.82);
});

await test('an un-resynced row (current_total NULL) falls back to the frozen total', () => {
  assert.equal(cacheRowTotal({ total_price: 250, current_total: null }), 250);
  assert.equal(cacheRowTotal({ total_price: 250 }), 250);
  assert.equal(cacheRowSubtotal({ subtotal_price: 200, current_subtotal: null }), 200);
});

// The `||` trap: an order whose every line was removed is legitimately worth 0. Falling back there
// would report money on an order that has none — the same lie, pointing the other way.
await test('a current total of ZERO is honoured, not treated as missing', () => {
  assert.equal(cacheRowTotal({ total_price: 900, current_total: 0 }), 0,
    'an order edited down to nothing must report 0, not its original $900');
  assert.equal(cacheRowSubtotal({ subtotal_price: 900, current_subtotal: 0 }), 0);
});

await test('missing rows and empty shapes degrade to 0 rather than throwing', () => {
  assert.equal(cacheRowTotal(null), 0);
  assert.equal(cacheRowTotal({}), 0);
  assert.equal(cacheRowSubtotal(undefined), 0);
});

await test('the GraphQL-shaped accessor prefers currentTotalPriceSet', () => {
  const edited = {
    totalPriceSet: { presentmentMoney: { amount: '4771.82' } },
    currentTotalPriceSet: { presentmentMoney: { amount: '4469.82' } },
  };
  assert.equal(listRowTotalAmount(edited), '4469.82');
  assert.equal(listRowTotalAmount({ totalPriceSet: { presentmentMoney: { amount: '250.00' } } }), '250.00',
    'no current* (unedited or un-resynced) → frozen total');
  assert.equal(listRowTotalAmount({
    totalPriceSet: { presentmentMoney: { amount: '900.00' } },
    currentTotalPriceSet: { presentmentMoney: { amount: '0.00' } },
  }), '0.00', 'a zeroed order must not fall back to its original');
  assert.equal(listRowTotalAmount(null), undefined);
});

// ── the SQL sums, against a real database ────────────────────────────────────

await test('the customer outstanding balance sums CURRENT totals', () => {
  upsertCustomerCache({ shopify_id: '9310', gid: 'gid://shopify/Customer/9310', email: 'edited@example.com', display_name: 'Edited Co', tags: ['b2b'] });
  // Edited down, still unpaid — the #38953 shape.
  upsertOrderCache({
    shopify_id: '7401', gid: 'gid://shopify/Order/7401', name: '#7401',
    customer_shopify_id: '9310', created_at: Date.now(),
    total_price: 4771.82, current_total: 4469.82, financial_status: 'PENDING',
  });
  // Never edited, and never resynced since the migration: current_total is NULL.
  upsertOrderCache({
    shopify_id: '7402', gid: 'gid://shopify/Order/7402', name: '#7402',
    customer_shopify_id: '9310', created_at: Date.now(),
    total_price: 100, current_total: null, financial_status: 'PENDING',
  });
  const bal = getOutstandingBalanceForCustomer('9310');
  assert.equal(bal.count, 2);
  assert.equal(bal.total, 4569.82,
    `expected 4469.82 + 100; got ${bal.total} — 4871.82 means it is still summing the frozen total_price`);
});

await test('an order edited down to nothing contributes 0 to the balance', () => {
  upsertCustomerCache({ shopify_id: '9320', gid: 'gid://shopify/Customer/9320', email: 'zeroed@example.com', display_name: 'Zeroed Co', tags: ['b2b'] });
  upsertOrderCache({
    shopify_id: '7403', gid: 'gid://shopify/Order/7403', name: '#7403',
    customer_shopify_id: '9320', created_at: Date.now(),
    total_price: 900, current_total: 0, financial_status: 'PENDING',
  });
  assert.equal(getOutstandingBalanceForCustomer('9320').total, 0,
    'COALESCE must not treat 0 as missing — the customer owes nothing on a fully-removed order');
});

await test('the customer spend range sums CURRENT totals', () => {
  const spend = getOrderSpendFromCache('9310', null, null);
  assert.equal(spend.count, 2);
  assert.equal(spend.total, 4569.82, `got ${spend.total} — the frozen total would give 4871.82`);
});

await test('a cancelled order is still excluded (guard against a rewritten WHERE)', () => {
  upsertOrderCache({
    shopify_id: '7404', gid: 'gid://shopify/Order/7404', name: '#7404',
    customer_shopify_id: '9320', created_at: Date.now(), cancelled_at: Date.now(),
    total_price: 500, current_total: 500, financial_status: 'PENDING',
  });
  assert.equal(getOutstandingBalanceForCustomer('9320').total, 0, 'cancelled orders must not be billed');
});

await test('the hydrated list row carries BOTH price sets so readers can choose', () => {
  const rows = listOrdersFromCache({});
  const edited = rows.find(r => r.name === '#7401');
  assert.ok(edited, 'the seeded order should be listed');
  assert.equal(edited.totalPriceSet.presentmentMoney.amount, '4771.82', 'frozen original stays available');
  assert.equal(edited.currentTotalPriceSet.presentmentMoney.amount, '4469.82', 'current total must be exposed');
  assert.equal(listRowTotalAmount(edited), '4469.82', 'and the shared accessor must pick it');
});

// ── source guards: every money-rendering site must use the accessor ──────────

const serverSrc = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
const dbSrc     = await readFile(new URL('../db.mjs', import.meta.url), 'utf8');

await test('no rendered money reads the raw frozen total_price', () => {
  const offenders = serverSrc.split('\n')
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(({ l }) => /fmtMoney\([^)]*\.total_price|total:\s*String\(o\.total_price/.test(l) && !/^\s*(\/\/|\*)/.test(l));
  assert.equal(offenders.length, 0,
    `frozen total rendered at line(s) ${offenders.map(o => o.n).join(', ')} — use cacheRowTotal(row)`);
});

await test('no total is summed off the raw frozen column', () => {
  const offenders = serverSrc.split('\n')
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(({ l }) => /reduce\([^)]*o\.total_price/.test(l));
  assert.equal(offenders.length, 0, `frozen total summed at line(s) ${offenders.map(o => o.n).join(', ')}`);
});

await test('both cache SUM queries COALESCE to the current total', () => {
  const sums = dbSrc.match(/SUM\((?:ROUND\()?[^)]*\)/g) || [];
  const bare = (dbSrc.match(/SUM\(total_price\)/g) || []).length;
  assert.equal(bare, 0, 'a SUM(total_price) with no COALESCE(current_total, …) is back');
  assert.ok(/SUM\(COALESCE\(current_total, total_price\)\)/.test(dbSrc), 'the balance/spend sums must COALESCE');
  assert.ok(sums.length >= 1);
});

await test('the dashboard cache fallback exposes currentTotalPriceSet', () => {
  assert.match(serverSrc, /currentTotalPriceSet: o\.current_total != null/,
    'without it listRowTotalAmount has nothing to prefer and silently shows the frozen total');
});

await test('listRowTotalAmount is defined exactly once, in the shared module', () => {
  assert.equal((serverSrc.match(/function listRowTotalAmount/g) || []).length, 0,
    'a second local copy is how the reader and the writer drifted apart in the first place');
  assert.match(serverSrc, /from '\.\/lib\/order-display-totals\.mjs'/);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
