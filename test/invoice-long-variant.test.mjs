// DeepReview 0.4.1 of #73, finding 2: an ACTIVE invoice line's variant title is drawn with lineBreak:false and no clip, so a long
// title is not clipped: it wraps into many lines that run down through the rows below (and a single-line run would cross the
// SKU / qty / price columns, since pdfkit does not clip text to its width).
// Run: node test/invoice-long-variant.test.mjs
import assert from 'node:assert/strict';
import { generateInvoicePdf } from '../pdf.mjs';
import { extractPdfText } from './pdf-inspect.mjs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; } catch (e) { console.log(`  ✗ ${name}\n      ${e.stack?.split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const money = a => ({ presentmentMoney: { amount: String(a), currencyCode: 'USD' } });
const ADDR = { address1: '123 Main St', city: 'Chicago', province: 'IL', zip: '60601', country: 'United States' };
const order = (variantTitle) => ({
  name: '#1001', processedAt: '2026-09-23T12:00:00Z', displayFinancialStatus: 'PENDING',
  customer: { displayName: 'Acme Pet Supply', email: 'buyer@acme.com' }, shippingAddress: ADDR, billingAddress: ADDR,
  note: '', tags: [], transactions: [], fulfillments: [],
  lineItems: { edges: [{ node: {
    id: 'gid://shopify/LineItem/1', title: 'Collar', quantity: 2, currentQuantity: 2,
    variant: { id: 'gid://shopify/ProductVariant/1', sku: 'CRSWLK0533258XS8', title: variantTitle },
    discountedUnitPriceSet: money('12.50'), originalUnitPriceSet: money('12.50'), discountedTotalSet: money('25.00'), discountAllocations: [],
  } }] },
  subtotalPriceSet: money('25.00'), totalShippingPriceSet: money('0.00'), totalTaxSet: money('0.00'), totalPriceSet: money('25.00'),
});

console.log('\nInvoice: long variant titles stay in their column');
await test('a very long ACTIVE variant title is clipped with an ellipsis, not drawn in full across the SKU / price columns', async () => {
  const long = 'Wide variant '.repeat(20).trim();
  const runs = extractPdfText(Buffer.from(await generateInvoicePdf(order(long))));
  const drawn = runs.filter(r => r.text.startsWith('Wide variant'));
  assert.equal(drawn.length, 1, `the variant must be ONE clipped line, not ${drawn.length} wrapped lines running down through the rows below`);
  assert.ok(drawn[0].text.endsWith('…'), `clipped text must end with an ellipsis, got "${drawn[0].text.slice(-12)}"`);
  assert.ok(drawn[0].text.length < 80, `a 210pt column at 8pt holds well under 80 characters, drew ${drawn[0].text.length}`);
});
await test('a SHORT variant title is drawn unchanged', async () => {
  const runs = extractPdfText(Buffer.from(await generateInvoicePdf(order('Small / Navy'))));
  assert.ok(runs.some(r => r.text === 'Small / Navy'));
});
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
