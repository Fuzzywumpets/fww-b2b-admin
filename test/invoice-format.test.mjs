import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateInvoicePdf, invoiceItemTitle } from '../pdf.mjs';

assert.equal(invoiceItemTitle({ title: 'Collar — SM / 1"', variant: { title: 'SM / 1"' } }), 'Collar');
assert.equal(invoiceItemTitle({ title: 'Walking Lead - Booth — 12"', variant: { title: '12"' } }), 'Walking Lead - Booth');
assert.equal(invoiceItemTitle({ title: 'Ordinary — Product', variant: { title: 'Blue' } }), 'Ordinary — Product');

const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
assert.match(source, /variantTitle:\s*i\.variant\?\.title/,
  'new partial-invoice snapshots retain the variant title');
assert.match(source, /sku:\s*i\.variant\?\.sku/,
  'new partial-invoice snapshots retain the SKU');
assert.match(source, /currentLines\.get\(li\.id\)/,
  'historical snapshots recover display metadata by immutable line-item id');

const money = amount => ({ presentmentMoney: { amount: String(amount), currencyCode: 'USD' } });
const lineItems = Array.from({ length: 30 }, (_, i) => ({
  id: `gid://shopify/LineItem/${i + 1}`,
  title: `Long descriptive wholesale product ${i + 1} — MED / 1.5"`,
  quantity: 1,
  currentQuantity: 1,
  discountedUnitPriceSet: money(12.34),
  discountedTotalSet: money(12.34),
  originalUnitPriceSet: money(12.34),
  discountAllocations: [],
  variant: { title: 'MED / 1.5"', sku: `SKU-LONG-${String(i + 1).padStart(3, '0')}` },
}));
const pdf = await generateInvoicePdf({
  name: '#TEST', processedAt: '2026-09-23T12:00:00Z', displayFinancialStatus: 'PENDING',
  customer: { company: 'Test Company', displayName: 'Test Company', email: 'test@example.com' },
  shippingAddress: { company: 'Test Company', address1: '1 Main St', city: 'Chicago', province: 'Illinois', zip: '60601', country: 'United States' },
}, { lineItems, invoiceSuffix: 'A', subtotal: 370.20, shipping: 0, total: 370.20 });
assert.ok(Buffer.isBuffer(pdf) && pdf.length > 1000);
assert.ok((pdf.toString('binary').match(/\/Type\s*\/Page[^s]/g) || []).length >= 2,
  'dense invoice paginates instead of clipping rows');

console.log('invoice format tests passed');
