// Standalone unit test (no server): customers_cache refresh from the customers/* webhook and the
// incremental customer sync behind "Sync now".
//
// Why standalone: the webhook refresh and the poller are skipped under MOCK (no Shopify), so the HTTP
// suite can never reach them. This drives lib/customer-cache-sync.mjs with a fake shopifyFetch and
// the REAL db.mjs upsertCustomerCache/getCustomerFromCache against the in-memory MOCK database.
//
// The bug this guards (2026-10-12): the webhook upserted from the REST payload, which for this app's
// API version carries no tags/total_spent/orders_count — so every CUSTOMERS_UPDATE wrote tags='',
// is_b2b=0, spend 0, orders 0 and dropped a B2B customer (5662285201601) out of every B2B view.

process.env.B2B_ADMIN_MOCK = '1';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { upsertCustomerCache, getCustomerFromCache } = await import('../db.mjs');
const {
  refreshCustomerFromShopify, syncRecentCustomers, customerNodeToCacheRow, customerGid,
  CUSTOMER_SYNC_OVERLAP_MS,
} = await import('../lib/customer-cache-sync.mjs');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(m || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
async function rejects(p, m) { try { await p; } catch { return; } throw new Error(m || 'expected rejection'); }

const deps = (shopifyFetch) => ({ shopifyFetch, upsert: upsertCustomerCache, isCached: (id) => !!getCustomerFromCache(id) });
const node = (n, over = {}) => ({
  id: `gid://shopify/Customer/${n}`, email: `c${n}@example.com`, firstName: 'Lorraine', lastName: 'Rainwater',
  displayName: 'Lorraine Rainwater', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2026-10-12T15:00:00Z',
  numberOfOrders: '5', amountSpent: { amount: '1828.24', currencyCode: 'USD' }, tags: ['b2b', 'wholesale'],
  defaultAddress: { company: 'Mountain Valley Country Store', city: 'X', province: 'Y', country: 'US' },
  ...over,
});
const oneFetch = (n) => { const f = async (_q, v) => { f.calls.push(v); return { data: { customer: n } }; }; f.calls = []; return f; };

console.log('\ncustomer-cache-sync');

await test('webhook refresh writes tags/is_b2b/spend/orders from GraphQL, not the payload', async () => {
  const f = oneFetch(node(7001));
  eq(await refreshCustomerFromShopify(7001, deps(f)), 'upserted');
  eq(f.calls[0].id, 'gid://shopify/Customer/7001');
  const r = getCustomerFromCache('7001');
  eq([r.tags, r.is_b2b, r.amount_spent_total, r.orders_count, r.company], ['b2b,wholesale', 1, 1828.24, 5, 'Mountain Valley Country Store']);
});

await test('a GraphQL node missing tags/spend/orders is never written as empty/zero (the original bug)', async () => {
  for (const bad of [{ tags: undefined }, { amountSpent: null }, { numberOfOrders: null }]) {
    eq(await refreshCustomerFromShopify(7001, deps(oneFetch(node(7001, bad)))), 'skipped-incomplete');
  }
  const r = getCustomerFromCache('7001');
  eq([r.is_b2b, r.amount_spent_total, r.orders_count], [1, 1828.24, 5]);
});

await test('a failed Shopify read writes nothing and rethrows', async () => {
  await rejects(refreshCustomerFromShopify(7001, deps(async () => { throw new Error('bridge 502'); })));
  eq(getCustomerFromCache('7001').is_b2b, 1);
});

await test('removing the b2b tag demotes an already-cached customer', async () => {
  eq(await refreshCustomerFromShopify(7001, deps(oneFetch(node(7001, { tags: ['wholesale'] })))), 'upserted');
  eq(getCustomerFromCache('7001').is_b2b, 0);
  eq(await refreshCustomerFromShopify(7001, deps(oneFetch(node(7001)))), 'upserted');
  eq(getCustomerFromCache('7001').is_b2b, 1);
});

await test('a non-B2B customer that is not cached is not added (cache stays B2B-scoped)', async () => {
  eq(await refreshCustomerFromShopify(7002, deps(oneFetch(node(7002, { tags: ['vip'] })))), 'skipped-non-b2b');
  eq(getCustomerFromCache('7002'), null);
});

await test('a new customer tagged b2b is inserted', async () => {
  eq(await refreshCustomerFromShopify('gid://shopify/Customer/7003', deps(oneFetch(node(7003, { numberOfOrders: '0', amountSpent: { amount: '0.0' } })))), 'upserted');
  eq(getCustomerFromCache('7003').is_b2b, 1);
});

await test('a customer Shopify no longer has leaves the cached row alone', async () => {
  eq(await refreshCustomerFromShopify(7001, deps(oneFetch(null))), 'missing');
  eq(getCustomerFromCache('7001').is_b2b, 1);
});

await test('customerGid / row mapping edge cases', async () => {
  eq(customerGid('123'), 'gid://shopify/Customer/123');
  eq(customerGid('gid://shopify/Customer/9'), 'gid://shopify/Customer/9');
  eq(customerGid('abc'), null);
  eq(customerNodeToCacheRow(node(1, { amountSpent: { amount: 'NaN' } })), null);
  eq(customerNodeToCacheRow(node(1)).orders_count, 5);
  await rejects(refreshCustomerFromShopify('', deps(oneFetch(node(1)))));
});

// ── incremental sync ──────────────────────────────────────────────────────────
function fakeList(nodes) {
  const calls = [];
  const fn = async (_q, { q, first, after }) => {
    calls.push({ q, first, after });
    const since = Date.parse(q.replace('updated_at:>', ''));
    const rows = nodes.filter(n => Date.parse(n.updatedAt) > since).sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    const start = after ? Number(after) : 0;
    const slice = rows.slice(start, start + first);
    const end = start + slice.length;
    return { data: { customers: { edges: slice.map(node => ({ node })), pageInfo: { hasNextPage: end < rows.length, endCursor: String(end) } } } };
  };
  fn.calls = calls;
  return fn;
}
function stateHarness(last) {
  const h = { state: last ? { last_synced_at: last } : null, writes: [] };
  h.getState = () => h.state;
  h.setState = (st) => { h.writes.push(st); h.state = { last_synced_at: st.lastSyncedAt }; };
  return h;
}

await test('sync picks up a b2b tag added, a tag removed, and ignores unrelated customers', async () => {
  const base = Date.parse('2026-10-12T16:00:00Z');
  const t = (i) => new Date(base + i * 1000).toISOString();
  const nodes = [
    node(7101, { updatedAt: t(1) }),                         // newly b2b
    node(7003, { updatedAt: t(2), tags: ['retail'] }),        // cached, tag removed
    node(7102, { updatedAt: t(3), tags: [] }),                // DTC customer, never cached
  ];
  const h = stateHarness(base - 3600_000);
  const res = await syncRecentCustomers({ ...deps(fakeList(nodes)), getState: h.getState, setState: h.setState, now: () => base + 10_000 });
  eq([res.scanned, res.upserted, res.truncated], [3, 2, false]);
  eq(getCustomerFromCache('7101').is_b2b, 1);
  eq(getCustomerFromCache('7003').is_b2b, 0);
  eq(getCustomerFromCache('7102'), null);
  eq(h.state.last_synced_at, base + 10_000);
});

await test('sync pages past one page and resumes from the newest stored row when capped', async () => {
  const base = Date.parse('2026-10-12T17:00:00Z');
  const nodes = Array.from({ length: 7 }, (_, i) => node(7200 + i, { updatedAt: new Date(base + i * 1000).toISOString() }));
  const h = stateHarness(base - 60_000);
  const f = fakeList(nodes);
  const res = await syncRecentCustomers({ ...deps(f), getState: h.getState, setState: h.setState, now: () => base + 60_000, pageSize: 2, pageLimit: 2 });
  eq([res.upserted, res.truncated], [4, true]);
  eq(h.state.last_synced_at, base + 3000);   // newest of the 4 stored, not "now"
  const res2 = await syncRecentCustomers({ ...deps(f), getState: h.getState, setState: h.setState, now: () => base + 60_000, pageSize: 2, pageLimit: 10 });
  eq(res2.truncated, false);
  for (let i = 0; i < 7; i++) eq(getCustomerFromCache(String(7200 + i)).is_b2b, 1);
});

await test('a capped run whose rows carry no parseable updatedAt does not jump the cursor to now', async () => {
  const last = Date.parse('2026-10-12T17:30:00Z');
  const h = stateHarness(last);
  const f = async () => ({ data: { customers: { edges: [{ node: node(7300, { updatedAt: null }) }], pageInfo: { hasNextPage: true, endCursor: '1' } } } });
  const res = await syncRecentCustomers({ ...deps(f), getState: h.getState, setState: h.setState, now: () => last + 3600_000, pageLimit: 1 });
  eq(res.truncated, true);
  eq(h.state.last_synced_at, last);
});

await test('sync error leaves the cursor in place and rethrows', async () => {
  const last = Date.parse('2026-10-12T18:00:00Z');
  const h = stateHarness(last);
  await rejects(syncRecentCustomers({ ...deps(async () => { throw new Error('bridge 500'); }), getState: h.getState, setState: h.setState }));
  eq(h.state.last_synced_at, last);
  eq(h.writes[0].lastError, 'bridge 500');
  await rejects(syncRecentCustomers({ ...deps(async () => ({ data: {} })), getState: h.getState, setState: h.setState }));
  eq(h.state.last_synced_at, last);
});

await test('sync query uses the overlap window', async () => {
  const last = Date.parse('2026-10-12T19:00:00Z');
  const h = stateHarness(last);
  const f = fakeList([]);
  await syncRecentCustomers({ ...deps(f), getState: h.getState, setState: h.setState });
  eq(f.calls[0].q, `updated_at:>${new Date(last - CUSTOMER_SYNC_OVERLAP_MS).toISOString()}`);
});

// Source guard: the customers/* webhook branch must not build a cache row from the payload again.
await test('server.mjs customers/* webhook branch is trigger-only', async () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs'), 'utf8');
  const start = src.indexOf("if (topic.startsWith('customers/')) {");
  const end = src.indexOf("} else if (topic.startsWith('orders/')) {", start);
  if (start < 0 || end < 0) throw new Error('could not find the customers/ webhook branch');
  const branch = src.slice(start, end);
  if (/upsertCustomerCache\s*\(/.test(branch)) throw new Error('webhook branch upserts directly from the payload');
  if (!/refreshCustomerFromShopify\(/.test(branch)) throw new Error('webhook branch does not re-read the customer');
  if (!/syncRecentCustomersFromShopify\(\)/.test(src.slice(src.indexOf("app.post('/api/admin/sync-now'")))) throw new Error('sync-now does not refresh customers');
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
