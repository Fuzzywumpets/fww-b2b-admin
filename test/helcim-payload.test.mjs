import assert from 'node:assert/strict';
import {
  buildHelcimInvoicePayload,
  HelcimInvoiceValidationError,
  sanitizeHelcimText,
} from '../lib/helcim-invoice-payload.mjs';

const money = (amount, currencyCode = 'USD') => ({ presentmentMoney: { amount: String(amount), currencyCode } });
const line = ({ title = 'Collar', quantity = 1, currentQuantity, price = '10.00', sku = 'COL-1', variantTitle = 'Default Title' } = {}) => ({
  title,
  quantity,
  ...(currentQuantity === undefined ? {} : { currentQuantity }),
  variant: { sku, title: variantTitle, selectedOptions: [] },
  discountedUnitPriceSet: money(price),
  originalUnitPriceSet: money(price),
});
const order = ({
  lines = [line()], subtotal = '10.00', shipping = '0.00', tax = '0.00', total = '10.00',
  currency = 'USD', taxExempt = false, taxesIncluded = false,
} = {}) => ({
  id: 'gid://shopify/Order/1001', name: '#1001',
  customer: { email: 'buyer@example.com' }, taxExempt, taxesIncluded,
  lineItems: { edges: lines.map(node => ({ node })) },
  currentSubtotalPriceSet: money(subtotal, currency),
  currentShippingPriceSet: money(shipping, currency),
  currentTotalTaxSet: money(tax, currency),
  currentTotalPriceSet: money(total, currency),
  currentTaxLines: tax === '0.00' ? [] : [{ title: 'IL Sales Tax' }],
  billingAddress: { firstName: 'Ana', lastName: 'Buyer', address1: '1 Main St', city: 'Chicago', province: 'IL', zip: '60601', country: 'US' },
  shippingAddress: { firstName: 'Ana', lastName: 'Buyer', address1: '2 Ship St', city: 'Chicago', province: 'IL', zip: '60602', country: 'US' },
});

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('itemizes current quantities with discrete shipping, tax, addresses, and reconciliation ID', () => {
  const result = buildHelcimInvoicePayload({
    order: order({
      lines: [line({ title: 'Collar — R&D', quantity: 2, price: '10.00', sku: 'COL-1' })],
      subtotal: '20.00', shipping: '5.00', tax: '1.65', total: '26.65',
    }),
    expectedAmount: '26.65',
  });
  assert.equal(result.amountCents, 2665);
  assert.equal(result.invoiceNumber, 'FWW-1001');
  assert.equal(result.taxStatus, 'taxable');
  assert.deepEqual(result.payload.lineItems, [{ description: 'Collar - R and D', quantity: 2, price: 10, sku: 'COL-1' }]);
  assert.deepEqual(result.payload.tax, { amount: 1.65, details: 'IL Sales Tax' });
  assert.equal(result.payload.shipping.amount, 5);
  assert.equal(result.payload.shipping.address.postalCode, '60602');
  assert.equal(result.payload.billingAddress.postalCode, '60601');
  assert.equal(result.payload.invoiceNumber, 'FWW-1001');
});

test('omits removed lines and represents order discounts once at invoice level', () => {
  const result = buildHelcimInvoicePayload({
    order: order({
      lines: [
        line({ title: 'Edited', quantity: 2, currentQuantity: 1, price: '10.00' }),
        line({ title: 'Removed', quantity: 1, currentQuantity: 0, price: '50.00' }),
      ],
      subtotal: '9.00', total: '9.00',
    }),
    expectedAmount: '9.00',
  });
  assert.equal(result.payload.lineItems.length, 1);
  assert.equal(result.payload.lineItems[0].quantity, 1);
  assert.deepEqual(result.payload.discount, { amount: 1, details: 'Shopify order discounts' });
});

test('preserves a fully comped line as a zero-price item without resurrecting list price', () => {
  const result = buildHelcimInvoicePayload({
    order: order({
      lines: [line({ title: 'Paid', price: '25.00' }), line({ title: 'Comped', quantity: 2, price: '0.00' })],
      subtotal: '25.00', total: '25.00',
    }),
    expectedAmount: '25.00',
  });
  assert.equal(result.payload.lineItems[1].price, 0);
  assert.equal(result.payload.discount, undefined);
});

test('marks explicit tax-exempt orders and refuses contradictory non-zero tax', () => {
  const exempt = buildHelcimInvoicePayload({ order: order({ taxExempt: true }), expectedAmount: '10.00' });
  assert.equal(exempt.taxStatus, 'exempt');
  assert.deepEqual(exempt.payload.tax, { amount: 0, details: 'Tax exempt' });
  assert.throws(
    () => buildHelcimInvoicePayload({ order: order({ taxExempt: true, tax: '1.00', total: '11.00' }), expectedAmount: '11.00' }),
    /Tax-exempt Shopify order has a non-zero tax amount/,
  );
});

test('uses exact decimal parsing at cent boundaries', () => {
  const result = buildHelcimInvoicePayload({
    order: order({ lines: [line({ quantity: 3, price: '0.10' })], subtotal: '0.30', total: '0.30' }),
    expectedAmount: '0.30',
  });
  assert.equal(result.amountCents, 30);
  assert.equal(result.payload.lineItems[0].price, 0.1);
  assert.throws(
    () => buildHelcimInvoicePayload({ order: order(), expectedAmount: '10.001' }),
    /at most two decimal places/,
  );
});

test('refuses partial, unreconciled, unsupported-currency, and tax-inclusive invoices', () => {
  assert.throws(
    () => buildHelcimInvoicePayload({ order: order(), expectedAmount: '9.00' }),
    /Refusing unreconciled Helcim invoice/,
  );
  assert.throws(
    () => buildHelcimInvoicePayload({ order: order({ currency: 'EUR' }), expectedAmount: '10.00' }),
    /currency must be USD or CAD/,
  );
  assert.throws(
    () => buildHelcimInvoicePayload({ order: order({ taxesIncluded: true }), expectedAmount: '10.00' }),
    /Tax-inclusive Shopify orders/,
  );
});

test('sanitizes descriptions and safely omits unverified SKUs', () => {
  assert.equal(sanitizeHelcimText('Crème & “Stars” — 1½'), 'Creme and Stars - 1.5');
  const result = buildHelcimInvoicePayload({
    order: order({ lines: [line({ sku: 'unsafe sku/1' })] }), expectedAmount: '10.00',
  });
  assert.equal('sku' in result.payload.lineItems[0], false);
  assert.deepEqual(result.omittedSkuLines, [1]);
});

test('refuses empty active orders and the documented 100-line API ceiling', () => {
  assert.throws(
    () => buildHelcimInvoicePayload({ order: order({ lines: [line({ currentQuantity: 0 })], subtotal: '0.00', total: '0.00' }), expectedAmount: '0.00' }),
    /at least one active line item/,
  );
  assert.throws(
    () => buildHelcimInvoicePayload({ order: order({ lines: Array.from({ length: 101 }, () => line()), subtotal: '1010.00', total: '1010.00' }), expectedAmount: '1010.00' }),
    /100-line limit/,
  );
});

let failed = 0;
for (const { name, fn } of tests) {
  try { await fn(); console.log(`✓ ${name}`); }
  catch (error) { failed++; console.error(`✗ ${name}`); console.error(error); }
}
if (failed) process.exitCode = 1;
else console.log(`\n${tests.length} Helcim payload tests passed`);
