// Pagination-completeness regression for the order-detail path (2026-09-23 audit, P0 #39355 class).
//
// getOrderDetail used lineItems(first:250) with NO pageInfo and NO cursor, so any order with >250
// lines silently dropped the overflow from renderOrderDetail, createXeroInvoice, and the ship/fulfill/
// cancel flows — the exact defect class that printed 250 of 286 items on B2B order #39355.
//
// This is a source-level guard, matching the repo's established pattern (order-edit-nav-deadlock) —
// the missing CALL SITE is the defect, and a unit test of an extracted helper cannot see it.
// It asserts:
//   * the order-detail query asks for pageInfo on lineItems so the connection can be walked;
//   * getOrderDetail actually drains remaining pages via drainLineItems and rebuilds edges,
//     never leaving lineItems as a bare first:250 prefix.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  \u2713 ${name}`); passed++; }
  catch (e) { console.log(`  \u2717 ${name}\n      ${e.message}`); failed++; }
}

console.log('\n\u2500\u2500 Unit: order-detail line-item pagination completeness (#39355 class) \u2500\u2500\n');

const src = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');

// The initial projection in getOrderDetail must carry pageInfo so the walker can advance.
await test('getOrderDetail lineItems(first:250) requests pageInfo { hasNextPage endCursor }', () => {
  const m = src.match(/getOrderDetail[\s\S]*?lineItems\(first:250\)\{pageInfo\{hasNextPage endCursor\}/);
  assert.ok(m, 'the order-detail query must request pageInfo on the lineItems connection');
});

// getOrderDetail must actually drain remaining pages and rebuild the edges (not leave a prefix).
await test('getOrderDetail drains line items via drainLineItems and rebuilds edges', () => {
  assert.notEqual(src.indexOf("const nodes = await drainLineItems(result.data.order.lineItems"), -1,
    'getOrderDetail must call drainLineItems on the order lineItems connection');
  assert.match(src, /result\.data\.order\.lineItems = \{ edges: nodes\.map\(node => \(\{ node \}\)\) \};/,
    'getOrderDetail must reassign lineItems.edges to the FULL drained set');
});

// A partial page must never be returned as success: a paging failure is surfaced (throwOnError)
// rather than silently returning a prefix.
await test('getOrderDetail fails closed when line-item paging errors and throwOnError is set', () => {
  const region = src.slice(src.indexOf('Pagination-completeness'), src.indexOf('return result.data?.order || null;'));
  assert.match(region, /if \(throwOnError\) throw err;/, 'a paging failure must propagate when throwOnError is set');
  assert.match(region, /return null;/, 'a paging failure must not silently render a truncated order');
});

await test('fulfill and dashboard live paths no longer use silent first-page prefixes', () => {
  assert.match(src, /loadOpenFulfillmentLineMap\(/);
  assert.match(src, /drainDashboardOrders\(/);
  assert.match(src, /drainLowStockItems\(/);
  assert.match(src, /drainCustomerSpendOrders\(/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
