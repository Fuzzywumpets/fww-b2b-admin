// Standalone unit test (no server): incremental orders poller + REST status normalizer.
// The poller lives behind `if (!MOCK)` in server.mjs, so the HTTP suite can never reach it.
import { syncRecentOrders, normalizeRestFulfillmentStatus, SYNC_OVERLAP_MS } from '../lib/orders-recent-sync.mjs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; } catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(m || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// Fake Shopify: `orders` sorted ascending by updatedAt, served in pages honouring `updated_at:>` and `after`.
function fakeShopify(orders) {
  const calls = [];
  const fn = async (_q, { q, first, after }) => {
    calls.push({ q, first, after });
    const since = Date.parse(q.replace('updated_at:>', ''));
    const rows = orders.filter(o => Date.parse(o.updatedAt) > since).sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    const start = after ? Number(after) : 0;
    const slice = rows.slice(start, start + first);
    const end = start + slice.length;
    return { data: { orders: { edges: slice.map(node => ({ node })), pageInfo: { hasNextPage: end < rows.length, endCursor: String(end) } } } };
  };
  fn.calls = calls;
  return fn;
}
const mk = (n, iso) => ({ id: `gid://shopify/Order/${n}`, name: `#${n}`, updatedAt: iso, displayFulfillmentStatus: 'FULFILLED' });
function harness(state) {
  const h = { state, stored: [], writes: [] };
  h.getState = () => h.state;
  h.setState = (st) => { h.writes.push(st); if (st.lastSyncedAt != null) h.state = { last_synced_at: st.lastSyncedAt }; };
  h.upsertNode = (n) => h.stored.push(n.name);
  return h;
}

console.log('\norders-recent-sync');

await test('pages past 50 — none of a 120-order burst is dropped (the original bug)', async () => {
  const base = Date.parse('2026-10-02T10:00:00Z');
  const orders = Array.from({ length: 120 }, (_, i) => mk(i, new Date(base + i * 1000).toISOString()));
  const h = harness({ last_synced_at: base - 3600_000 });
  const r = await syncRecentOrders({ shopifyFetch: fakeShopify(orders), ...h, getState: h.getState, setState: h.setState, upsertNode: h.upsertNode, now: () => base + 999_000 });
  eq(h.stored.length, 120); eq(r.truncated, false);
  eq(h.writes.at(-1).lastSyncedAt, base + 999_000, 'complete run advances to start time');
});

await test('page cap hit — cursor resumes from newest stored row, NOT now, and next run finishes the rest', async () => {
  const base = Date.parse('2026-10-02T10:00:00Z');
  const orders = Array.from({ length: 120 }, (_, i) => mk(i, new Date(base + i * 60_000).toISOString()));
  const h = harness({ last_synced_at: base - 3600_000 });
  const f = fakeShopify(orders);
  const run = (now) => syncRecentOrders({ shopifyFetch: f, getState: h.getState, setState: h.setState, upsertNode: h.upsertNode, now: () => now, pageLimit: 1, pageSize: 50 });
  const r1 = await run(base + 10 * 3600_000);
  eq(r1.truncated, true); eq(h.stored.length, 50);
  eq(h.state.last_synced_at, Date.parse(orders[49].updatedAt), 'cursor = newest stored updatedAt');
  await run(base + 10 * 3600_000); await run(base + 10 * 3600_000);
  eq(new Set(h.stored).size, 120, 'every order eventually stored');
});

await test('error mid-run — cursor does not advance, error is rethrown, lastError recorded', async () => {
  const base = Date.parse('2026-10-02T10:00:00Z');
  const h = harness({ last_synced_at: base - 5000 });
  let n = 0;
  const f = async () => { if (n++) throw new Error('bridge 502'); return { data: { orders: { edges: [{ node: mk(1, new Date(base).toISOString()) }], pageInfo: { hasNextPage: true, endCursor: 'x' } } } }; };
  let threw = null;
  try { await syncRecentOrders({ shopifyFetch: f, getState: h.getState, setState: h.setState, upsertNode: h.upsertNode, now: () => base + 99_000 }); } catch (e) { threw = e; }
  eq(threw?.message, 'bridge 502');
  eq(h.state.last_synced_at, base - 5000, 'cursor unchanged');
  eq(h.writes.at(-1).lastError, 'bridge 502');
});

await test('overlap — window starts SYNC_OVERLAP_MS before the stored cursor', async () => {
  const h = harness({ last_synced_at: Date.parse('2026-10-02T10:00:00Z') });
  const f = fakeShopify([]);
  await syncRecentOrders({ shopifyFetch: f, ...h, getState: h.getState, setState: h.setState, upsertNode: h.upsertNode, now: () => Date.parse('2026-10-02T10:05:00Z') });
  eq(f.calls[0].q, `updated_at:>${new Date(Date.parse('2026-10-02T10:00:00Z') - SYNC_OVERLAP_MS).toISOString()}`);
});

await test('malformed response (no orders) throws instead of silently advancing', async () => {
  const h = harness({ last_synced_at: 1000 });
  let threw = false;
  try { await syncRecentOrders({ shopifyFetch: async () => ({ data: {} }), getState: h.getState, setState: h.setState, upsertNode: h.upsertNode, now: () => 9e12 }); } catch { threw = true; }
  eq(threw, true); eq(h.state.last_synced_at, 1000);
});

await test('REST fulfillment status maps onto the GraphQL enum', () => {
  eq(normalizeRestFulfillmentStatus(null), 'UNFULFILLED');
  eq(normalizeRestFulfillmentStatus(undefined), 'UNFULFILLED');
  eq(normalizeRestFulfillmentStatus('fulfilled'), 'FULFILLED');
  eq(normalizeRestFulfillmentStatus('partial'), 'PARTIALLY_FULFILLED');
  eq(normalizeRestFulfillmentStatus('restocked'), 'RESTOCKED');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
