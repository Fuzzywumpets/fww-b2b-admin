// Standalone unit test (no server): lib/order-money.mjs — the money-correctness helpers.
//
// These run WITHOUT the mock HTTP server on purpose. The branches under test are Shopify
// *userError* branches, which MOCK mode can never reach (mock never calls shopifyFetch), so an
// API-suite-only green would be a false green over exactly the paths where the wrong-money bugs
// lived. Here shopifyFetch is injected as a fake that can return userErrors on demand.
//
// The rule that matters most is the FIRST group: a per-line price change is remove-then-add inside
// ONE uncommitted edit session. If the add fails after the remove succeeded and we do not throw,
// the caller commits the removal alone and the line silently reverts from wholesale to full retail.

import assert from 'node:assert/strict';
import { parseLinePrices, applyLinePriceChanges, bulkMarkOrdersPaid } from '../lib/order-money.mjs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}

const LI = 'gid://shopify/LineItem/555';
const CALC_LI = 'gid://shopify/CalculatedLineItem/555';
const CALC_ID = 'gid://shopify/CalculatedOrder/9';

// Retail $24.99, currently wholesale $12.50 — the exact shape from the finding.
function fixtures() {
  return {
    calcId: CALC_ID,
    idMap: { [LI]: CALC_LI },
    discountIdMap: { [LI]: { discountAppId: 'gid://shopify/DiscountApplication/1', retailPrice: 24.99, wholesalePrice: 12.50 } },
  };
}

// Fake shopifyFetch: records calls, returns userErrors per mutation kind on demand.
function fakeShopify({ removeErrors = [], addErrors = [] } = {}) {
  const calls = [];
  const fn = async (query, variables) => {
    if (/orderEditRemoveDiscount/.test(query)) {
      calls.push({ op: 'remove', variables });
      return { data: { orderEditRemoveDiscount: { calculatedOrder: { id: CALC_ID }, userErrors: removeErrors } } };
    }
    if (/orderEditAddLineItemDiscount/.test(query)) {
      calls.push({ op: 'add', variables });
      return { data: { orderEditAddLineItemDiscount: { calculatedOrder: { id: CALC_ID }, userErrors: addErrors } } };
    }
    throw new Error('unexpected mutation: ' + query.slice(0, 60));
  };
  fn.calls = calls;
  return fn;
}

console.log('\nUnit tests — lib/order-money.mjs:');

console.log('\n  applyLinePriceChanges — remove-then-add atomicity:');

await test('REGRESSION: add-discount userErrors after a successful remove THROW (never fall through to commit)', async () => {
  const shopifyFetch = fakeShopify({ addErrors: [{ field: null, message: 'Discount cannot be applied to this line item.' }] });
  await assert.rejects(
    () => applyLinePriceChanges({ shopifyFetch, ...fixtures(), pricesMap: { [LI]: 10.00 } }),
    (err) => {
      // The throw is what abandons the uncommitted calculatedOrder. Without it the caller commits
      // the removal alone and the line jumps $12.50 -> $24.99 behind "success=order_edited".
      assert.match(err.message, /Discount cannot be applied/);
      assert.match(err.message, /555/);
      return true;
    });
  // Both steps must have been attempted — the remove is what makes the failure dangerous.
  assert.deepEqual(shopifyFetch.calls.map(c => c.op), ['remove', 'add']);
});

await test('a failed REMOVE skips the line without throwing (nothing was un-discounted, so nothing is at risk)', async () => {
  const shopifyFetch = fakeShopify({ removeErrors: [{ field: null, message: 'Discount not found.' }] });
  const out = await applyLinePriceChanges({ shopifyFetch, ...fixtures(), pricesMap: { [LI]: 10.00 } });
  assert.equal(out.applied.length, 0);
  assert.equal(out.skipped.length, 1);
  assert.match(out.skipped[0].reason, /remove failed/);
  assert.deepEqual(shopifyFetch.calls.map(c => c.op), ['remove']);  // add never attempted
});

await test('happy path re-discounts at the right percentage and reports the change', async () => {
  const shopifyFetch = fakeShopify();
  const out = await applyLinePriceChanges({ shopifyFetch, ...fixtures(), pricesMap: { [LI]: 10.00 } });
  assert.deepEqual(shopifyFetch.calls.map(c => c.op), ['remove', 'add']);
  const pct = shopifyFetch.calls[1].variables.d.percentValue;
  // (24.99 - 10.00) / 24.99 * 100
  assert.ok(Math.abs(pct - 59.9840) < 0.001, `expected ~59.984%, got ${pct}`);
  assert.equal(shopifyFetch.calls[1].variables.d.description, 'B2B price adj');
  assert.equal(out.applied.length, 1);
  assert.equal(out.applied[0].to, 10.00);
});

await test('an unchanged price fires no mutation at all', async () => {
  const shopifyFetch = fakeShopify();
  const out = await applyLinePriceChanges({ shopifyFetch, ...fixtures(), pricesMap: { [LI]: 12.50 } });
  assert.equal(shopifyFetch.calls.length, 0);
  assert.equal(out.skipped[0].reason, 'unchanged');
});

await test('a price above retail is skipped (no money moves) and reported, not silently dropped', async () => {
  const shopifyFetch = fakeShopify();
  const out = await applyLinePriceChanges({ shopifyFetch, ...fixtures(), pricesMap: { [LI]: 99.00 } });
  assert.equal(shopifyFetch.calls.length, 0);
  assert.equal(out.applied.length, 0);
  assert.match(out.skipped[0].reason, /out of range/);
});

console.log('\n  parseLinePrices — a blank field is not a comp:');

await test('REGRESSION: a cleared price input is reported invalid, NOT coerced to $0.00', async () => {
  const { prices, invalid } = parseLinePrices({ [LI]: '' });
  // parseFloat('') || 0 === 0 => newPct 100 => the line would commit at $0.00 with a success banner.
  assert.deepEqual(prices, {});
  assert.deepEqual(invalid, [LI]);
});

await test('REGRESSION: non-numeric text is reported invalid, NOT coerced to $0.00', async () => {
  const { prices, invalid } = parseLinePrices({ [LI]: 'twelve fifty' });
  assert.deepEqual(prices, {});
  assert.deepEqual(invalid, [LI]);
});

await test('a negative price is reported invalid', async () => {
  const { invalid } = parseLinePrices({ [LI]: '-5' });
  assert.deepEqual(invalid, [LI]);
});

await test('a DELIBERATE comp — an explicitly typed 0 — still parses as a valid $0.00', async () => {
  const { prices, invalid } = parseLinePrices({ [LI]: '0' });
  assert.deepEqual(prices, { [LI]: 0 });
  assert.deepEqual(invalid, []);
});

await test('ordinary prices parse, and one bad line does not swallow the good ones', async () => {
  const { prices, invalid } = parseLinePrices({ a: '12.50', b: '', c: '7' });
  assert.deepEqual(prices, { a: 12.5, c: 7 });
  assert.deepEqual(invalid, ['b']);
});

console.log('\n  bulkMarkOrdersPaid — userErrors are results, not noise:');

const toGid = (n) => `gid://shopify/Order/${n}`;

await test('REGRESSION: a per-order userError lands in `failed` and never in `paid`', async () => {
  const shopifyFetch = async (_q, vars) => {
    const bad = vars.input.id.endsWith('/1003');
    return { data: { orderMarkAsPaid: {
      order: bad ? null : { id: vars.input.id, displayFinancialStatus: 'PAID' },
      userErrors: bad ? [{ field: null, message: 'Order cannot be marked as paid.' }] : [],
    } } };
  };
  const { paid, failed } = await bulkMarkOrdersPaid({ shopifyFetch, ids: ['1001', '1003', '1005'], toGid });
  // The caller audit-logs ONLY `paid` — logging 1003 would assert payment for an unpaid order, and
  // this bulk path skips Xero, so no second system would ever catch it.
  assert.deepEqual(paid, ['1001', '1005']);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].id, '1003');
  assert.match(failed[0].message, /cannot be marked as paid/);
});

await test('a transport throw is also a failure, not a silent success', async () => {
  const shopifyFetch = async (_q, vars) => {
    if (vars.input.id.endsWith('/1002')) throw new Error('shopify-bridge 502');
    return { data: { orderMarkAsPaid: { order: { id: vars.input.id }, userErrors: [] } } };
  };
  const { paid, failed } = await bulkMarkOrdersPaid({ shopifyFetch, ids: ['1002', '1004'], toGid });
  assert.deepEqual(paid, ['1004']);
  assert.equal(failed[0].id, '1002');
  assert.match(failed[0].message, /502/);
});

await test('all-clean batch reports every id paid and no failures', async () => {
  const shopifyFetch = async (_q, vars) => ({ data: { orderMarkAsPaid: { order: { id: vars.input.id }, userErrors: [] } } });
  const { paid, failed } = await bulkMarkOrdersPaid({ shopifyFetch, ids: ['1001', '1002'], toGid });
  assert.deepEqual(paid, ['1001', '1002']);
  assert.deepEqual(failed, []);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
