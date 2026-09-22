import assert from 'node:assert/strict';
import { addLineDiscountsConcurrent } from '../lib/order-money.mjs';

const lines = Array.from({ length: 286 }, (_, i) => ({ id: `gid://shopify/CalculatedLineItem/${i + 1}`, title: `Line ${i + 1}` }));
const calls = [];
let inFlight = 0;
let maxInFlight = 0;
const okFetch = async (query, variables, options) => {
  calls.push({ query, variables, options });
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  await new Promise(resolve => setImmediate(resolve));
  inFlight--;
  return { data: { orderEditAddLineItemDiscount: { userErrors: [] } } };
};

const result = await addLineDiscountsConcurrent({
  shopifyFetch: okFetch,
  calcId: 'gid://shopify/CalculatedOrder/1',
  lines,
  discount: { percentValue: 5, description: 'Order discount: Prepay' },
});
assert.equal(result.applied, 286);
assert.equal(calls.length, 286, 'each line gets an independently timeout-bounded request');
assert.equal(maxInFlight, 24, 'production default should keep at most 24 Shopify writes in flight');
assert.ok(calls.every(c => Object.hasOwn(c.variables, 'li')));
assert.ok(calls.every(c => c.variables.d.percentValue === 5));
assert.ok(calls.every(c => c.options.timeoutMs === 60000));

const tunedCalls = [];
await addLineDiscountsConcurrent({
  shopifyFetch: async (query, variables, options) => {
    tunedCalls.push({ query, variables, options });
    return { data: { orderEditAddLineItemDiscount: { userErrors: [] } } };
  },
  calcId: 'gid://shopify/CalculatedOrder/large',
  lines,
  discount: { percentValue: 5, description: 'Order discount: Prepay' },
  concurrency: 7,
  fetchTimeoutMs: 45000,
});
assert.equal(tunedCalls.length, 286);
assert.ok(tunedCalls.every(c => c.options.timeoutMs === 45000));

let completed = 0;
await assert.rejects(
  addLineDiscountsConcurrent({
    shopifyFetch: async (_query, variables) => {
      await new Promise(resolve => setImmediate(resolve));
      completed++;
      const userErrors = variables.li.endsWith('/24')
        ? [{ field: ['discount'], message: 'Shopify refused this line' }]
        : [];
      return { data: { orderEditAddLineItemDiscount: { userErrors } } };
    },
    calcId: 'gid://shopify/CalculatedOrder/2',
    lines: lines.slice(0, 45), concurrency: 8,
    discount: { percentValue: 5, description: 'Order discount: Prepay' },
  }),
  /"Line 24": Shopify refused this line/
);
assert.equal(completed, 45, 'must settle every in-flight mutation before rejecting the edit');

await assert.rejects(
  addLineDiscountsConcurrent({ shopifyFetch: okFetch, calcId: 'x', lines: [], discount: {}, concurrency: 33 }),
  /concurrency must be an integer from 1 to 32/
);

for (const response of [{}, { data: { orderEditAddLineItemDiscount: null } }]) {
  await assert.rejects(addLineDiscountsConcurrent({ shopifyFetch: async () => response,
    calcId: 'x', lines: lines.slice(0, 1), discount: {} }), /no discount mutation result/);
}
let settled = 0;
await assert.rejects(addLineDiscountsConcurrent({
  shopifyFetch: async (_query, variables) => {
    await new Promise(resolve => setImmediate(resolve));
    settled++;
    if (variables.li === lines[0].id) throw new Error('transport timeout');
    return { data: { orderEditAddLineItemDiscount: { userErrors: [] } } };
  }, calcId: 'x', lines: lines.slice(0, 30), discount: {},
}), /Line 1.*transport timeout/);
assert.equal(settled, 30, 'transport failure must also drain all workers before rejecting');
console.log('order-discount concurrency tests passed');
