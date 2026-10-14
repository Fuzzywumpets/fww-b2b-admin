// Pagination sweep 2026-10-14: fail-closed connection walker + the server wiring that uses it.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { paginateConnection, drainRemaining } from '../lib/paginate-connection.mjs';
import { drainLineItems } from '../lib/line-item-paging.mjs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
const page = (nodes, next) => ({ edges: nodes.map(node => ({ node })), pageInfo: { hasNextPage: !!next, endCursor: next } });
const pages = (...ps) => async (after) => ps[after ? Number(after.slice(1)) : 0];

await test('walks 3 pages and returns every node in order', async () => {
  const all = await paginateConnection(pages(page([1, 2], 'c1'), page([3, 4], 'c2'), page([5], null)), 't');
  assert.deepEqual(all, [1, 2, 3, 4, 5]);
});
await test('single page passes through', async () => {
  assert.deepEqual(await paginateConnection(pages(page([1], null)), 't'), [1]);
});
await test('nodes-shaped connections are supported', async () => {
  const f = async (after) => after ? { nodes: [3], pageInfo: { hasNextPage: false } } : { nodes: [1, 2], pageInfo: { hasNextPage: true, endCursor: 'c1' } };
  assert.deepEqual(await paginateConnection(f, 't'), [1, 2, 3]);
});
await test('repeated cursor throws instead of looping or returning a prefix', async () => {
  const f = async () => page([1], 'same');
  await assert.rejects(() => paginateConnection(f, 't'), /cursor repeated/);
});
await test('hasNextPage without endCursor throws', async () => {
  await assert.rejects(() => paginateConnection(async () => ({ edges: [], pageInfo: { hasNextPage: true } }), 't'), /without endCursor/);
});
await test('missing pageInfo throws', async () => {
  await assert.rejects(() => paginateConnection(async () => ({ edges: [] }), 't'), /pageInfo missing/);
});
await test('null page (provider error) throws', async () => {
  await assert.rejects(() => paginateConnection(async () => null, 't'), /unavailable/);
  await assert.rejects(() => drainRemaining(page([1], 'c1'), 't', async () => null), /unavailable/);
});
await test('safety ceiling throws, never returns a partial set', async () => {
  let n = 0;
  const f = async () => page([n], `c${++n}`);
  await assert.rejects(() => paginateConnection(f, 't', { maxPages: 5 }), /did not paginate to completion/);
});
await test('drainRemaining finishes an inline first page', async () => {
  const first = page([1, 2], 'c1');
  const rest = await drainRemaining(first, 't', async (a) => { assert.equal(a, 'c1'); return page([3], null); });
  assert.deepEqual(rest, [1, 2, 3]);
});
await test('drainLineItems (order lines) now fails closed on repeated / missing cursor', async () => {
  await assert.rejects(() => drainLineItems(page([1], 'x'), 't', async () => page([2], 'x')), /cursor repeated/);
  await assert.rejects(() => drainLineItems({ edges: [], pageInfo: { hasNextPage: true } }, 't', async () => null), /without endCursor/);
  const ok = await drainLineItems(page([1], 'a'), 't', async () => page([2], null));
  assert.deepEqual(ok, [1, 2]);
});

const src = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
await test('catalog list walks every page (no single page-1 fetch)', () => {
  assert.match(src, /paginateConnection\(async \(after\) =>[\s\S]{0,400}products\(first:50,query:\$q,after:\$after/);
  assert.doesNotMatch(src, /\{ q: qParts\.join\(' '\), after: null \}/);
});
await test('catalog, product detail, labels and export complete overflowing variants', () => {
  for (const label of ["'catalog'", "'product detail'", "'labels'", "'export'"]) {
    assert.ok(src.includes(`, ${label})`) || src.includes(`${label});`), `completeProductVariants for ${label}`);
  }
  assert.ok((src.match(/variants\(first:\d+\)\{pageInfo\{hasNextPage endCursor\}/g) || []).length >= 4);
});
await test('labels-from-order and analytics complete overflowing line items', () => {
  assert.match(src, /completeOrderLineItems\(\[o\],/);
  assert.match(src, /completeOrderLineItems\(edges\.map\(e => e\.node\),/);
});
await test('analytics order loop throws at its ceiling instead of silently stopping', () => {
  assert.match(src, /analytics orders did not paginate to completion/);
  assert.doesNotMatch(src, /while \(pageCount < 10\)/);
});
await test('order fulfillments drain fulfillmentLineItems overflow', () => {
  assert.match(src, /fulfillmentLineItems\(first:250\)\{pageInfo\{hasNextPage endCursor\}/);
  assert.match(src, /\.\.\. on Fulfillment\{fulfillmentLineItems\(first:250,after:\$after\)/);
});
await test('plain-list fields (transactions, customer addresses) no longer carry a first: cap', () => {
  assert.doesNotMatch(src, /transactions\(first:10\)/);
  assert.doesNotMatch(src, /addresses\(first:5\)/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

await test('drainLineItems fails closed on a first page without pageInfo (DeepReview 2026-10-14)', async () => {
  await assert.rejects(() => drainLineItems({ edges: [{ node: 1 }] }, 't', async () => null), /without pageInfo/);
});
