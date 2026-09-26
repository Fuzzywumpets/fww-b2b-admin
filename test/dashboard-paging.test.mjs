import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  drainDashboardOrders,
  drainLowStockItems,
  drainCustomerSpendOrders,
} from '../lib/dashboard-paging.mjs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  \u2713 ${name}`); passed++; }
  catch (e) { console.log(`  \u2717 ${name}\n      ${e.message}`); failed++; }
}

function ordersPage(nodes, next = null) {
  return { data: { orders: { pageInfo: { hasNextPage: !!next, endCursor: next }, edges: nodes.map((node) => ({ node })) } } };
}

console.log('\n\u2500\u2500 Unit: dashboard / spend pagination completeness \u2500\u2500\n');

await test('dashboard orders walk 0/1/50/51 and fail closed on a missing cursor', async () => {
  assert.deepEqual(await drainDashboardOrders(async () => ordersPage([]), 'q'), []);
  assert.equal((await drainDashboardOrders(async () => ordersPage([{ id: '1' }]), 'q')).length, 1);

  let afters = [];
  const fiftyOne = async (_q, vars) => {
    afters.push(vars.after);
    if (!vars.after) return ordersPage(Array.from({ length: 50 }, (_, i) => ({ id: String(i) })), 'n1');
    return ordersPage([{ id: '50' }]);
  };
  assert.equal((await drainDashboardOrders(fiftyOne, 'q')).length, 51);
  assert.deepEqual(afters, [null, 'n1']);

  await assert.rejects(
    () => drainDashboardOrders(async () => ({ data: { orders: { pageInfo: { hasNextPage: true, endCursor: null }, edges: [] } } }), 'q'),
    /without cursor/,
  );
});

await test('low-stock drains a variant on the second page and ignores unpublished products', async () => {
  const shopifyFetch = async (query, vars) => {
    if (query.includes('products(first:')) {
      return { data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [
        { node: { id: 'p-hide', title: 'Hidden', publishedOnPublication: false, variants: { pageInfo: { hasNextPage: false }, edges: [{ node: { sku: 'H', title: 'H', inventoryQuantity: 1 } }] } } },
        { node: { id: 'p1', title: 'Shown', publishedOnPublication: true, variants: { pageInfo: { hasNextPage: true, endCursor: 'v2' }, edges: [{ node: { sku: 'A', title: 'A', inventoryQuantity: 2 } }] } } },
      ] } } };
    }
    assert.equal(vars.after, 'v2');
    return { data: { product: { variants: { pageInfo: { hasNextPage: false }, edges: [{ node: { sku: 'B', title: 'B', inventoryQuantity: 9 } }] } } } };
  };
  const items = await drainLowStockItems(shopifyFetch, 'gid://shopify/Publication/1');
  assert.deepEqual(items.map((i) => i.sku), ['A', 'B']);
});

await test('customer spend keeps lifetime fields from page 1 and all range orders', async () => {
  const shopifyFetch = async (_q, vars) => {
    if (!vars.after) {
      return { data: { customer: {
        amountSpent: { amount: '99.00', currencyCode: 'USD' },
        numberOfOrders: 251,
        orders: { pageInfo: { hasNextPage: true, endCursor: 'c2' }, edges: [{ node: { id: 'o1', name: '#1', processedAt: '2026-01-01' } }] },
      } } };
    }
    return { data: { customer: {
      amountSpent: { amount: '99.00', currencyCode: 'USD' },
      numberOfOrders: 251,
      orders: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [{ node: { id: 'o251', name: '#251', processedAt: '2026-02-01' } }] },
    } } };
  };
  const out = await drainCustomerSpendOrders(shopifyFetch, 'gid://shopify/Customer/1', 'q');
  assert.equal(out.customer.numberOfOrders, 251);
  assert.equal(out.orders.length, 2);
  assert.equal(out.orders[1].id, 'o251');
});

const src = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
await test('dashboard and spend live paths call the drain helpers', () => {
  assert.match(src, /drainDashboardOrders\(/);
  assert.match(src, /drainLowStockItems\(/);
  assert.match(src, /drainCustomerSpendOrders\(/);
  assert.doesNotMatch(src, /orders\(first:50,query:\$q,sortKey:PROCESSED_AT,reverse:true\)\{\s*edges\{node\{id name processedAt customer/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
