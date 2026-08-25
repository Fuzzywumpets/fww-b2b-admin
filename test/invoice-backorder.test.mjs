// Back-ordered lines on the wholesale invoice.
//
// Requirement (Alex, 2026-08-25): when only some items ship, the invoice shows the
// held lines "struck-thru to indicate backordered, and amounts set to $0.00 along
// with a summary of back-ordered items at the bottom".
//
// The PURE split is tested here. The drawing itself is verified by generating a
// real PDF and looking at it — a test asserting pdfkit drawing calls would only
// restate the implementation, and pdfkit compresses its text streams so the
// output is not greppable either.
//
// Run: node --test test/invoice-backorder.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitBackordered, generateInvoicePdf } from '../pdf.mjs';

const money = (a) => ({ presentmentMoney: { amount: String(a), currencyCode: 'USD' } });
const line = (id, title, qty, unit) => ({
  id, title, quantity: qty, currentQuantity: qty,
  discountedUnitPriceSet: money(unit), originalUnitPriceSet: money(unit),
  variant: { title: 'Medium / Lime', sku: 'SKU-' + id },
});

const SHIPPED = [line('1', 'Collar', 6, '18.50'), line('2', 'Leash', 4, '16.00')];
const HELD = [line('3', 'Limited-Slip Collar', 12, '19.75')];
const ALL = [...SHIPPED, ...HELD];

test('splitBackordered separates held lines from shipped ones', () => {
  const { shipped, backordered } = splitBackordered(ALL, ['3']);
  assert.deepEqual(shipped.map((l) => l.id), ['1', '2']);
  assert.deepEqual(backordered.map((l) => l.id), ['3']);
});

test('ids are compared as STRINGS so a numeric id still matches', () => {
  // A caller holding numeric ids would otherwise match nothing and silently
  // invoice the customer for goods that never shipped.
  assert.equal(splitBackordered([{ id: 7 }], ['7']).backordered.length, 1);
  assert.equal(splitBackordered([{ id: '7' }], [7]).backordered.length, 1);
});

test('no backordered ids means every line ships (the ordinary invoice)', () => {
  const { shipped, backordered } = splitBackordered(ALL, []);
  assert.equal(shipped.length, 3);
  assert.equal(backordered.length, 0);
  assert.deepEqual(splitBackordered(ALL, undefined).backordered, []);
  assert.deepEqual(splitBackordered(ALL, null).backordered, []);
});

test('junk input degrades instead of throwing', () => {
  assert.deepEqual(splitBackordered(null, ['1']).shipped, []);
  assert.deepEqual(splitBackordered(ALL, [null, undefined]).backordered, []);
});

// ── The money guard ───────────────────────────────────────────────────────────
// The computed-totals branch reads Shopify's authoritative aggregates, which
// cover the WHOLE order. Printing those next to struck-through $0.00 rows would
// bill the customer for goods that did not ship, and it would look entirely
// plausible. Refuse rather than guess.
test('backordered lines REQUIRE caller-reconciled totals', async () => {
  const order = { name: '#1', lineItems: { edges: ALL.map((n) => ({ node: n })) } };
  await assert.rejects(
    () => generateInvoicePdf(order, { lineItems: ALL, backorderedIds: ['3'] }),
    /requires caller-reconciled/,
    'must not fall back to full-order totals on a partial shipment',
  );
});

test('with reconciled totals it renders a PDF', async () => {
  const order = {
    name: '#1', processedAt: '2026-08-25T15:00:00Z',
    customer: { email: 'b@example.com' },
    lineItems: { edges: ALL.map((n) => ({ node: n })) },
  };
  const pdf = await generateInvoicePdf(order, {
    lineItems: ALL, backorderedIds: ['3'],
    subtotal: 175, shipping: 12.4, total: 187.4,
  });
  assert.ok(Buffer.isBuffer(pdf) && pdf.length > 1000, 'a real PDF came back');
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-', 'and it is actually a PDF');
});
