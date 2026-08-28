// Standalone unit test (no server): lib/order-sync-paging.mjs + the poller wiring in server.mjs.
//
// WHY STANDALONE: syncRecentFromShopify short-circuits in MOCK and calls the real shopifyFetch
// otherwise, so neither HTTP suite can ever reach the pagination loop — a green there says nothing
// about this path (the same false-green shape order-money.test.mjs guards against). The drain and
// cursor rules are pure lib logic tested directly; the server side is pinned with source guards on
// the call sites, because the 8/25 lesson is that a stranded module passes its own unit tests
// forever while protecting nothing.
//
// THE BUG THIS PINS (2026-08-28): the backstop poller was orders(first:50, sortKey:UPDATED_AT,
// reverse:true) with NO pagination loop — it selected pageInfo{hasNextPage}, never read it, then
// advanced its cursor to now(), permanently dropping every update past 50 in a busy window. On
// ERROR it advanced the cursor anyway, permanently dropping the whole window of a failed poll.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ORDER_SYNC_PAGE_SIZE, ORDER_SYNC_PAGE_LIMIT,
  drainRecentOrders, maxUpdatedAtMs, nextSyncCursorMs,
} from '../lib/order-sync-paging.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}

const BASE = Date.parse('2026-08-28T10:00:00Z');
const node = (i) => ({ id: `gid://shopify/Order/${i}`, updatedAt: new Date(BASE + i * 60000).toISOString() });
const page = (nodes, hasNextPage, endCursor = null) =>
  ({ edges: nodes.map(n => ({ node: n })), pageInfo: { hasNextPage, endCursor } });

console.log('\norder-sync-paging: drainRecentOrders');

await test('single short page: everything collected, drained=true, no error', async () => {
  const r = await drainRecentOrders(async () => page([node(1), node(2)], false));
  assert.equal(r.drained, true);
  assert.equal(r.error, null);
  assert.equal(r.pagesFetched, 1);
  assert.deepEqual(r.nodes.map(n => n.id), ['gid://shopify/Order/1', 'gid://shopify/Order/2']);
});

await test('multi-page walk passes each endCursor as the next after and concatenates in order', async () => {
  const seen = [];
  const pages = [
    page([node(1), node(2)], true, 'c1'),
    page([node(3)], true, 'c2'),
    page([node(4)], false),
  ];
  const r = await drainRecentOrders(async (after) => { seen.push(after); return pages[seen.length - 1]; });
  assert.deepEqual(seen, [null, 'c1', 'c2']);
  assert.equal(r.drained, true);
  assert.equal(r.pagesFetched, 3);
  assert.deepEqual(r.nodes.map(n => n.id), [1, 2, 3, 4].map(i => `gid://shopify/Order/${i}`));
});

await test(`stops at ORDER_SYNC_PAGE_LIMIT (${ORDER_SYNC_PAGE_LIMIT}) pages with hasNextPage still true: drained=false, error=null, fetched nodes kept`, async () => {
  let calls = 0;
  const r = await drainRecentOrders(async () => { calls++; return page([node(calls)], true, `c${calls}`); });
  assert.equal(calls, ORDER_SYNC_PAGE_LIMIT);
  assert.equal(r.drained, false);
  assert.equal(r.error, null);
  assert.equal(r.nodes.length, ORDER_SYNC_PAGE_LIMIT);
});

await test('mid-drain fetch error keeps the pages that already landed and reports the error', async () => {
  let calls = 0;
  const r = await drainRecentOrders(async () => {
    calls++;
    if (calls === 2) throw new Error('shopify 502');
    return page([node(calls)], true, `c${calls}`);
  });
  assert.equal(r.drained, false);
  assert.equal(r.pagesFetched, 1);
  assert.equal(r.nodes.length, 1);
  assert.match(r.error.message, /502/);
});

await test('hasNextPage with a missing endCursor aborts with an error instead of refetching page 1 forever', async () => {
  let calls = 0;
  const r = await drainRecentOrders(async () => { calls++; return page([node(calls)], true, null); });
  assert.equal(calls, 1);
  assert.equal(r.drained, false);
  assert.match(r.error.message, /endCursor/);
});

console.log('\norder-sync-paging: maxUpdatedAtMs');

await test('returns the newest updatedAt in ms regardless of order', () => {
  assert.equal(maxUpdatedAtMs([node(3), node(7), node(5)]), BASE + 7 * 60000);
});

await test('empty / missing input returns null', () => {
  assert.equal(maxUpdatedAtMs([]), null);
  assert.equal(maxUpdatedAtMs(null), null);
});

await test('junk updatedAt is skipped, not allowed to poison the max with NaN', () => {
  assert.equal(maxUpdatedAtMs([{ updatedAt: 'not-a-date' }, node(2), { updatedAt: null }]), BASE + 2 * 60000);
});

console.log('\norder-sync-paging: nextSyncCursorMs — the loss-prevention rules');

await test('full drain advances to sync start (updates landing during the drain are covered by the 60s overlap)', () => {
  const start = BASE + 999 * 60000;
  assert.equal(nextSyncCursorMs({ drained: true, nodes: [node(1)], syncStartMs: start, prevCursorMs: BASE }), start);
  assert.equal(nextSyncCursorMs({ drained: true, nodes: [], syncStartMs: start, prevCursorMs: BASE }), start);
});

await test('partial run advances only to the newest INGESTED update, never past it', () => {
  const cursor = nextSyncCursorMs({ drained: false, nodes: [node(1), node(4)], syncStartMs: BASE + 999 * 60000, prevCursorMs: BASE });
  assert.equal(cursor, BASE + 4 * 60000);
});

await test('nothing ingested keeps the previous cursor — a failed poll must not eat its window', () => {
  assert.equal(nextSyncCursorMs({ drained: false, nodes: [], syncStartMs: BASE + 999 * 60000, prevCursorMs: BASE }), BASE);
});

await test('nothing ingested on cold start returns null so the caller re-arms the same lookback', () => {
  assert.equal(nextSyncCursorMs({ drained: false, nodes: [], syncStartMs: BASE, prevCursorMs: null }), null);
});

await test('a burst bigger than one run: cursor lands ON the newest ingested update, strictly before every un-ingested one', async () => {
  // More pages available than the cap allows — the exact shape that used to lose data permanently.
  const all = Array.from({ length: ORDER_SYNC_PAGE_LIMIT * 2 + 3 }, (_, i) => node(i + 1));
  const r = await drainRecentOrders(async (after) => {
    const at = after ? Number(after) : 0;
    return page(all.slice(at, at + 2), at + 2 < all.length, String(at + 2));
  });
  assert.equal(r.drained, false);
  const cursor = nextSyncCursorMs({ drained: false, nodes: r.nodes, syncStartMs: Date.now(), prevCursorMs: BASE - 1 });
  const firstMissed = all[r.nodes.length];
  assert.equal(cursor, Date.parse(r.nodes[r.nodes.length - 1].updatedAt));
  assert.ok(cursor < Date.parse(firstMissed.updatedAt), 'cursor must sit strictly before the first order NOT ingested');
});

console.log('\nsource guards: syncRecentFromShopify wiring in server.mjs');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.mjs'), 'utf8');
const flat = serverSrc.replace(/\s+/g, '');

await test('poller query is paginated: first:${ORDER_SYNC_PAGE_SIZE}, after:$after, sortKey:UPDATED_AT ASCENDING', () => {
  assert.ok(
    flat.includes('orders(first:${ORDER_SYNC_PAGE_SIZE},query:$q,sortKey:UPDATED_AT,reverse:false,after:$after){'),
    'the paginated ascending orders query is missing from server.mjs'
  );
});

await test('the old unpaginated shape is gone: no orders(first:50, sortKey:UPDATED_AT) query remains', () => {
  assert.ok(!flat.includes('orders(first:50,query:$q,sortKey:UPDATED_AT'), 'the pre-fix single-shot poller query is back');
});

await test('the poller page selects pageInfo{hasNextPage endCursor} (and actually can continue the walk)', () => {
  const at = flat.indexOf('orders(first:${ORDER_SYNC_PAGE_SIZE}');
  assert.ok(at >= 0, 'poller query not found');
  assert.ok(flat.slice(at, at + 900).includes('pageInfo{hasNextPageendCursor}'), 'poller page does not select hasNextPage + endCursor');
});

await test('drainRecentOrders and nextSyncCursorMs are CALLED by server.mjs — not a stranded module', () => {
  assert.ok(serverSrc.includes('await drainRecentOrders(fetchPage)'), 'drainRecentOrders has no call site');
  assert.ok(serverSrc.includes('nextSyncCursorMs({'), 'nextSyncCursorMs has no call site');
});

await test('cursor honesty: no setSyncState with lastSyncedAt: Date.now() remains anywhere in server.mjs', () => {
  assert.ok(!serverSrc.includes('lastSyncedAt: Date.now()'), 'a blind cursor advance to now() is back — that is the data-loss bug');
});

console.log(`\norder-sync-paging: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
