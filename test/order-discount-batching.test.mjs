import assert from 'node:assert/strict';
import { addLineDiscountsBatched } from '../lib/order-money.mjs';

const lines = Array.from({ length: 286 }, (_, i) => ({ id: `gid://shopify/CalculatedLineItem/${i + 1}`, title: `Line ${i + 1}` }));
const calls = [];
const okFetch = async (query, variables, options) => {
  calls.push({ query, variables, options });
  const data = {};
  for (const match of query.matchAll(/(d\d+):orderEditAddLineItemDiscount/g)) data[match[1]] = { userErrors: [] };
  return { data };
};

const result = await addLineDiscountsBatched({
  shopifyFetch: okFetch,
  calcId: 'gid://shopify/CalculatedOrder/1',
  lines,
  discount: { percentValue: 5, description: 'Order discount: Prepay' },
});
assert.equal(result.applied, 286);
assert.equal(calls.length, 15, '286 lines should use 15 requests at the default batch size of 20');
assert.equal(Object.keys(calls[0].variables).filter(k => k.startsWith('li')).length, 20);
assert.equal(Object.keys(calls.at(-1).variables).filter(k => k.startsWith('li')).length, 6);
assert.ok(calls.every(c => c.variables.d.percentValue === 5));
assert.ok(calls.every(c => c.options.timeoutMs === 15000));

const tunedCalls = [];
await addLineDiscountsBatched({
  shopifyFetch: async (query, variables, options) => {
    tunedCalls.push({ query, variables, options });
    const data = {};
    for (const match of query.matchAll(/(d\d+):orderEditAddLineItemDiscount/g)) data[match[1]] = { userErrors: [] };
    return { data };
  },
  calcId: 'gid://shopify/CalculatedOrder/large',
  lines,
  discount: { percentValue: 5, description: 'Order discount: Prepay' },
  batchSize: 10,
  fetchTimeoutMs: 60000,
});
assert.equal(tunedCalls.length, 29, '286 production lines should use 29 smaller batches');
assert.ok(tunedCalls.every(c => c.options.timeoutMs === 60000));

let attempts = 0;
await assert.rejects(
  addLineDiscountsBatched({
    shopifyFetch: async (query) => {
      attempts++;
      const data = {};
      for (const match of query.matchAll(/(d\d+):orderEditAddLineItemDiscount/g)) data[match[1]] = { userErrors: [] };
      if (attempts === 2) data.d3.userErrors.push({ field: ['discount'], message: 'Shopify refused this line' });
      return { data };
    },
    calcId: 'gid://shopify/CalculatedOrder/2',
    lines: lines.slice(0, 45),
    discount: { percentValue: 5, description: 'Order discount: Prepay' },
  }),
  /"Line 24": Shopify refused this line/
);
assert.equal(attempts, 2, 'must stop immediately after a failed batch');

console.log('order-discount batching tests passed');
