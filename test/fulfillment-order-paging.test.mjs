import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadOpenFulfillmentLineMap } from '../lib/fulfillment-order-paging.mjs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  \u2713 ${name}`); passed++; }
  catch (e) { console.log(`  \u2717 ${name}\n      ${e.message}`); failed++; }
}

function conn(nodes, { next = null } = {}) {
  return {
    pageInfo: { hasNextPage: !!next, endCursor: next },
    edges: nodes.map((node) => ({ node })),
  };
}

console.log('\n\u2500\u2500 Unit: fulfillment-order pagination completeness \u2500\u2500\n');

await test('maps remaining lines across two fulfillment-order pages', async () => {
  const calls = [];
  const shopifyFetch = async (query, vars) => {
    calls.push({ query, vars });
    if (query.includes('fulfillmentOrders')) {
      if (!vars.after) {
        return { data: { order: { fulfillmentOrders: conn(
          [{ id: 'fo1', status: 'OPEN', lineItems: conn([{ id: 'fol1', remainingQuantity: 1, lineItem: { id: 'li1', title: 'A' } }]) }],
          { next: 'fo-next' },
        ) } } };
      }
      return { data: { order: { fulfillmentOrders: conn(
        [{ id: 'fo2', status: 'OPEN', lineItems: conn([{ id: 'fol2', remainingQuantity: 2, lineItem: { id: 'li2', title: 'B' } }]) }],
      ) } } };
    }
    throw new Error(`unexpected query: ${query}`);
  };
  const map = await loadOpenFulfillmentLineMap('gid://shopify/Order/1', shopifyFetch);
  assert.deepEqual(map.li1, { foId: 'fo1', foLiId: 'fol1', remaining: 1 });
  assert.deepEqual(map.li2, { foId: 'fo2', foLiId: 'fol2', remaining: 2 });
  assert.equal(calls.filter((c) => c.query.includes('fulfillmentOrders')).length, 2);
});

await test('drains nested fulfillment-order line items past first:50', async () => {
  const shopifyFetch = async (query, vars) => {
    if (query.includes('fulfillmentOrders')) {
      return { data: { order: { fulfillmentOrders: conn([{
        id: 'fo1', status: 'OPEN',
        lineItems: conn([{ id: 'fol1', remainingQuantity: 1, lineItem: { id: 'li1', title: 'A' } }], { next: 'li-next' }),
      }]) } } };
    }
    if (query.includes('fulfillmentOrder(id:$id)')) {
      assert.equal(vars.after, 'li-next');
      return { data: { fulfillmentOrder: { lineItems: conn([{ id: 'fol51', remainingQuantity: 1, lineItem: { id: 'li51', title: 'Z' } }]) } } };
    }
    throw new Error(`unexpected query: ${query}`);
  };
  const map = await loadOpenFulfillmentLineMap('gid://shopify/Order/1', shopifyFetch);
  assert.ok(map.li1);
  assert.ok(map.li51);
});

await test('fails closed when fulfillmentOrders hasNextPage without a cursor', async () => {
  const shopifyFetch = async () => ({
    data: { order: { fulfillmentOrders: { pageInfo: { hasNextPage: true, endCursor: null }, edges: [] } } },
  });
  await assert.rejects(() => loadOpenFulfillmentLineMap('gid://shopify/Order/1', shopifyFetch), /without cursor/);
});

await test('skips closed fulfillment orders', async () => {
  const shopifyFetch = async () => ({
    data: { order: { fulfillmentOrders: conn([
      { id: 'fo-closed', status: 'CLOSED', lineItems: conn([{ id: 'folx', remainingQuantity: 1, lineItem: { id: 'lix', title: 'X' } }]) },
      { id: 'fo-open', status: 'IN_PROGRESS', lineItems: conn([{ id: 'foly', remainingQuantity: 3, lineItem: { id: 'liy', title: 'Y' } }]) },
    ]) } },
  });
  const map = await loadOpenFulfillmentLineMap('gid://shopify/Order/1', shopifyFetch);
  assert.equal(map.lix, undefined);
  assert.deepEqual(map.liy, { foId: 'fo-open', foLiId: 'foly', remaining: 3 });
});

const src = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
await test('ship/label and fulfill call loadOpenFulfillmentLineMap', () => {
  assert.match(src, /loadOpenFulfillmentLineMap/);
  assert.equal((src.match(/loadOpenFulfillmentLineMap\(/g) || []).length >= 2, true, 'both fulfill call sites must drain');
  assert.doesNotMatch(src, /fulfillmentOrders\(first:10\)\{edges\{node\{/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
