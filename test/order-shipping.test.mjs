import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentShippingAmount, parseShippingAmount, stageShippingReplacement } from '../lib/order-shipping.mjs';

const money = amount => ({ presentmentMoney: { amount: String(amount), currencyCode: 'USD' }, shopMoney: { amount: String(amount), currencyCode: 'USD' } });
const line = (id, amount, stagedStatus = 'NONE') => ({ id, title: 'UPS', stagedStatus, price: money(amount) });
function fixture(lines, fail) {
  const calls = [];
  return { calls, shopifyFetch: async (query, vars) => {
    if (query.startsWith('query')) return { data: { node: { shippingLines: lines } } };
    calls.push(vars);
    const key = query.includes('orderEditRemoveShippingLine') ? 'orderEditRemoveShippingLine' : 'orderEditAddShippingLine';
    if (fail === 'missing') return {};
    return { data: { [key]: { calculatedOrder: { id: 'calc' }, userErrors: fail === key ? [{ message: 'Rejected by Shopify' }] : [] } } };
  } };
}
const stage = f => stageShippingReplacement({ ...f, calcId: 'calc', amount: 45, title: 'UPS', expectedAmount: 125 });

test('removed $80 is excluded from current shipping, including zero', () => {
  assert.equal(currentShippingAmount({ currentShippingPriceSet: money(45), totalShippingPriceSet: money(125) }), 45);
  assert.equal(currentShippingAmount({ currentShippingPriceSet: money(0), totalShippingPriceSet: money(125) }), 0);
  assert.equal(currentShippingAmount({ totalShippingPriceSet: money(30) }), 30);
});
test('amounts reject blank, negative, trailing junk, infinity and fractional cents', () => {
  for (const raw of ['', null, '-1', '45oops', 'Infinity', '0.001', '1e2']) assert.throws(() => parseShippingAmount(raw));
  assert.equal(parseShippingAmount('45.00'), 45);
  assert.equal(parseShippingAmount('0'), 0);
});
test('replacement removes BOTH active shipping lines before adding exactly $45', async () => {
  const f = fixture([line('old', 80), line('new', 45), line('removed', 99, 'REMOVED')]);
  await stage(f);
  assert.deepEqual(f.calls, [{ id: 'calc', line: 'old' }, { id: 'calc', line: 'new' }, { id: 'calc', shipping: { title: 'UPS', price: { amount: '45.00', currencyCode: 'USD' } } }]);
});
test('failed removal aborts before addition; failed addition throws before caller commit', async () => {
  const f = fixture([line('old', 80), line('new', 45)], 'orderEditRemoveShippingLine');
  await assert.rejects(stage(f), /Rejected/);
  assert.equal(f.calls.length, 1);
  const addFail = fixture([line('old', 125)], 'orderEditAddShippingLine');
  await assert.rejects(stage(addFail), /Rejected/);
  assert.equal(addFail.calls.length, 2);
});
test('missing mutation payload fails closed', async () => {
  const f = fixture([line('old', 125)], 'missing');
  await assert.rejects(stage(f), /did not confirm/);
  assert.equal(f.calls.length, 1);
});
test('stale page and currency mismatch make no changes', async () => {
  const stale = fixture([line('old', 90)]);
  await assert.rejects(stage(stale), /changed/);
  assert.equal(stale.calls.length, 0);
  const foreign = line('old', 125);
  foreign.price.shopMoney.currencyCode = 'CAD';
  const f = fixture([foreign]);
  await assert.rejects(stage(f), /currency/);
  assert.equal(f.calls.length, 0);
});
test('resaving the same charge is a no-op, free shipping is an explicit zero line', async () => {
  const f = fixture([line('current', 45)]);
  await stageShippingReplacement({ ...f, calcId: 'calc', amount: 45, expectedAmount: 45, title: 'UPS' });
  assert.equal(f.calls.length, 0);
  await stageShippingReplacement({ ...f, calcId: 'calc', amount: 0, expectedAmount: 45, title: 'UPS' });
  assert.equal(f.calls[1].shipping.price.amount, '0.00');
});
