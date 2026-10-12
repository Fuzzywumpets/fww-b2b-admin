// Standalone unit test (no server): lib/order-company.mjs — wholesale company on invoices + orders.
//
// Standalone because the paths under test sit behind `if (MOCK)` short-circuits: getOrderDetail
// returns the MOCK_ORDERS fixture without ever resolving a company, and submitNewOrder returns
// before orderCreate is built. Here the real resolver/builder run against Shopify-shaped fixtures,
// and the invoice PDF is rendered from a live-shaped order to read BILL TO back out of it.
//
// Regression: invoice #39848-A (2026-10-12) billed "Lorraine Rainwater" instead of
// "Mountain Valley Country Store".

import assert from 'node:assert/strict';
import fs from 'node:fs';
import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import { pickOrderCompany, resolveOrderCompany, buildOrderAddresses, sameStreetAddress } from '../lib/order-company.mjs';
import { generateInvoicePdf } from '../pdf.mjs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}

const CO = 'Mountain Valley Country Store';
const DEFAULT_ADDR = {
  id: 'gid://shopify/MailingAddress/6823808532673?model_name=CustomerAddress',
  company: CO, firstName: 'Lorraine', lastName: 'Rainwater', address1: '670 Highway 69', address2: '',
  city: 'Haysville', province: 'North Carolina', provinceCode: 'NC', zip: '28904',
  country: 'United States', countryCodeV2: 'US', phone: '+18285078913',
};
// The #39848 shape as originally created: no company anywhere on the order, no billing address.
function order39848({ defaultAddress = DEFAULT_ADDR } = {}) {
  return {
    id: 'gid://shopify/Order/18941984342251', name: '#39848',
    customer: { id: 'gid://shopify/Customer/5662285201601', displayName: 'Lorraine Rainwater', email: 'l@example.com', defaultAddress },
    shippingAddress: { company: null, firstName: 'Lorraine', lastName: 'Rainwater', address1: '670 Highway 69', city: 'Haysville', province: 'NC', zip: '28904', country: 'United States' },
    billingAddress: null,
  };
}

console.log('\n── Unit: order company resolution + order-create addresses (lib/order-company.mjs) ──');

await test('precedence: billing > shipping > default > prior order > cache', () => {
  const o = order39848();
  o.billingAddress = { company: 'Bill Co' }; o.shippingAddress.company = 'Ship Co';
  assert.deepEqual(pickOrderCompany(o, { priorCompanies: ['Prior Co'], cacheCompany: 'Cache Co' }), { company: 'Bill Co', source: 'billingAddress' });
  o.billingAddress = { company: '  ' };
  assert.equal(pickOrderCompany(o).company, 'Ship Co');
  o.shippingAddress.company = null;
  assert.deepEqual(pickOrderCompany(o), { company: CO, source: 'defaultAddress' });
  o.customer.defaultAddress = { company: null };
  assert.deepEqual(pickOrderCompany(o, { priorCompanies: ['', 'Prior Co'], cacheCompany: 'Cache Co' }), { company: 'Prior Co', source: 'priorOrder' });
  assert.deepEqual(pickOrderCompany(o, { cacheCompany: 'Cache Co' }), { company: 'Cache Co', source: 'customersCache' });
  assert.deepEqual(pickOrderCompany(o), { company: null, source: null });
});

await test('never reads an arbitrary address-book company (Touchstone drift trap)', () => {
  const o = order39848({ defaultAddress: { company: null } });
  o.customer.addresses = [{ company: 'Touchstone Crystal' }];
  assert.equal(pickOrderCompany(o).company, null);
});

await test('resolveOrderCompany: no Shopify round-trip when (a)-(c) answer', async () => {
  let calls = 0;
  const r = await resolveOrderCompany(order39848(), { shopifyFetch: async () => { calls++; return {}; } });
  assert.equal(r.company, CO); assert.equal(calls, 0);
});

await test('resolveOrderCompany: falls back to most recent PRIOR order, skipping this one', async () => {
  const o = order39848({ defaultAddress: { company: null } });
  const fake = async () => ({ data: {
    customer: { orders: { nodes: [
      { id: o.id, billingAddress: { company: 'SELF — must be skipped' }, shippingAddress: null },
      { id: 'gid://shopify/Order/2', billingAddress: null, shippingAddress: { company: null } },
      { id: 'gid://shopify/Order/3', billingAddress: { company: CO }, shippingAddress: { company: CO } },
    ] } },
    draftOrders: { nodes: [{ billingAddress: { company: 'Draft Co' }, shippingAddress: null }] },
  } });
  const r = await resolveOrderCompany(o, { shopifyFetch: fake, getCacheCompany: () => 'Cache Co' });
  assert.deepEqual(r, { company: CO, source: 'priorOrder' });
});

await test('resolveOrderCompany: Shopify failure degrades to customers_cache, never throws', async () => {
  const o = order39848({ defaultAddress: null });
  const r = await resolveOrderCompany(o, { shopifyFetch: async () => { throw new Error('bridge 502'); }, getCacheCompany: (id) => (id === '5662285201601' ? CO : null) });
  assert.deepEqual(r, { company: CO, source: 'customersCache' });
});

// Record every string pdf.mjs draws (embedded fonts encode glyph ids, so the bytes are unreadable).
const drawn = [];
const origText = PDFDocument.prototype.text;
PDFDocument.prototype.text = function (str, ...rest) { drawn.push(String(str)); return origText.call(this, str, ...rest); };

await test('invoice BILL TO prints the company and "c/o person" when only defaultAddress has it (#39848-A)', async () => {
  const o = order39848();
  Object.assign(o, {
    processedAt: '2026-10-12T15:30:28Z', displayFinancialStatus: 'PENDING', tags: ['b2b-portal'],
    lineItems: { edges: [{ node: { id: 'gid://shopify/LineItem/1', title: 'Collar', quantity: 1, currentQuantity: 1,
      variant: { sku: 'C-1' }, discountedUnitPriceSet: { presentmentMoney: { amount: '10.00', currencyCode: 'USD' } },
      originalUnitPriceSet: { presentmentMoney: { amount: '10.00', currencyCode: 'USD' } },
      discountedTotalSet: { presentmentMoney: { amount: '10.00', currencyCode: 'USD' } }, discountAllocations: [] } }] },
    currentSubtotalPriceSet: { presentmentMoney: { amount: '10.00', currencyCode: 'USD' } },
    currentTotalPriceSet: { presentmentMoney: { amount: '10.00', currencyCode: 'USD' } },
    transactions: [], fulfillments: [],
  });
  // Exactly what getOrderDetail does before handing the order to the PDF.
  o.customer.company = (await resolveOrderCompany(o)).company;
  drawn.length = 0;
  await generateInvoicePdf(o);
  const billIdx = drawn.indexOf('BILL TO');
  assert.ok(billIdx >= 0, 'BILL TO header not drawn');
  assert.equal(drawn[billIdx + 1], CO, `BILL TO name should be "${CO}", got "${drawn[billIdx + 1]}"`);
  const norm = drawn.join('|').replace(/\s+/g, '');
  assert.ok(norm.includes('c/oLorraineRainwater'), 'BILL TO missing "c/o Lorraine Rainwater"');
});

await test('order-create payload: default address sent verbatim WITH company + phone, billing set', () => {
  const submitted = { firstName: 'Lorraine', lastName: 'Rainwater', address1: '670 Highway 69', address2: '', city: 'Haysville', province: 'NC', zip: '28904', country: 'United States' };
  assert.ok(sameStreetAddress(submitted, DEFAULT_ADDR));
  const { shippingAddress, billingAddress } = buildOrderAddresses({ submitted, submittedCompany: CO, defaultAddress: DEFAULT_ADDR, company: CO });
  assert.equal(shippingAddress.company, CO);
  assert.equal(shippingAddress.phone, '+18285078913', 'phone must match the saved address or Shopify saves a duplicate');
  assert.equal(shippingAddress.provinceCode, 'NC'); assert.equal(shippingAddress.countryCode, 'US');
  assert.ok(billingAddress, 'billingAddress must be set');
  assert.equal(billingAddress.company, CO);
  assert.equal(billingAddress.address1, '670 Highway 69');
});

await test('order-create payload: an edited province/country is NOT replaced by the saved address (DeepReview #1)', () => {
  const base = { firstName: 'Lorraine', lastName: 'Rainwater', address1: '670 Highway 69', city: 'Haysville', zip: '28904' };
  assert.ok(sameStreetAddress({ ...base, province: 'NC', country: 'US' }, DEFAULT_ADDR));
  assert.ok(sameStreetAddress({ ...base, province: 'north carolina', country: 'United States' }, DEFAULT_ADDR));
  assert.ok(!sameStreetAddress({ ...base, province: 'TX', country: 'US' }, DEFAULT_ADDR));
  assert.ok(!sameStreetAddress({ ...base, province: 'NC', country: 'CA' }, DEFAULT_ADDR));
  const { shippingAddress } = buildOrderAddresses({ submitted: { ...base, province: 'TX', country: 'US' }, submittedCompany: CO, defaultAddress: DEFAULT_ADDR, company: CO });
  assert.equal(shippingAddress.province, 'TX'); assert.equal(shippingAddress.provinceCode, undefined);
  assert.equal(shippingAddress.company, CO);
});

await test('order-create payload: legacy form (no ship_company field) still carries the company', () => {
  const submitted = { firstName: 'Lorraine', lastName: 'Rainwater', address1: '670 Highway 69', city: 'Haysville', zip: '28904' };
  const { shippingAddress, billingAddress } = buildOrderAddresses({ submitted, submittedCompany: undefined, defaultAddress: DEFAULT_ADDR, company: CO });
  assert.equal(shippingAddress.company, CO); assert.equal(billingAddress.company, CO);
});

await test('order-create payload: dropship (cleared company, other address) ships without company, bills the business', () => {
  const submitted = { firstName: 'Pat', lastName: 'Consumer', address1: '1 Elm', city: 'Austin', province: 'TX', zip: '78701', country: 'US' };
  const { shippingAddress, billingAddress } = buildOrderAddresses({ submitted, submittedCompany: '', defaultAddress: DEFAULT_ADDR, company: CO });
  assert.equal(shippingAddress.company, undefined);
  assert.equal(shippingAddress.address1, '1 Elm');
  assert.equal(billingAddress.company, CO); assert.equal(billingAddress.address1, '670 Highway 69');
});

await test('order-create payload: no default address → billing mirrors shipping with resolved company', () => {
  const submitted = { firstName: 'A', lastName: 'B', address1: '9 Oak', city: 'X', zip: '1', country: 'US' };
  const { shippingAddress, billingAddress } = buildOrderAddresses({ submitted, defaultAddress: null, company: 'Prior Co' });
  assert.equal(shippingAddress.company, 'Prior Co');
  assert.equal(billingAddress.company, 'Prior Co'); assert.equal(billingAddress.address1, '9 Oak');
});

await test('submitNewOrder sends billingAddress + restores the prior default address (source guard)', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../server.mjs', import.meta.url)), 'utf8');
  const start = src.indexOf('async function submitNewOrder(');
  assert.ok(start > 0, 'submitNewOrder not found');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.ok(/buildOrderAddresses\(/.test(body), 'submitNewOrder must build addresses via buildOrderAddresses');
  assert.ok(/^\s+billingAddress,\s*$/m.test(body), 'orderInput must include billingAddress');
  assert.ok(/customerUpdateDefaultAddress/.test(body), 'default-address guard missing');
  assert.ok(/req\.body\.ship_company/.test(body), 'ship_company form field not read');
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
