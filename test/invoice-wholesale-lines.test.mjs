// Wholesale-priced added lines on invoices (lib/wholesale-discount.mjs + pdf.mjs + the partial-invoice routes).
//
// THE REPORT (partial invoice #39875-A): every line showed its net wholesale price except SKU 04622, which staff
// added with "add product". Shopify ignores a manual price on a catalog variant, so the app adds it at LIST
// price ($17.99) and applies a per-line "B2B wholesale" discount (~50%, netting $8.99). The invoice printed
// that line at $17.99 plus a "Discount -$9.00" row (Subtotal $4,490.67, Discount -$9.00, Total $4,481.67).
// The arithmetic was right; the presentation was not. This suite pins the fix.
//
// Run: node test/invoice-wholesale-lines.test.mjs
//   Sections 1-3 are pure (pdf.mjs / source). Section 4 boots ITS OWN mock server on a free port with
//   B2B_ADMIN_MOCK=1 (in-memory SQLite, no Shopify/Doppler env) and seeds two LEGACY snapshots through
//   test/invoice-wholesale-seed.mjs; it never touches data/admin.db or any live service.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  generateInvoicePdf, lineItemInvoiceDiscount, lineItemWholesaleDiscount, lineItemTrueTotal,
  lineItemInvoiceGrossTotal, lineItemInvoiceGrossUnit, snapshotLineInvoiceDiscount,
} from '../pdf.mjs';
import {
  WHOLESALE_DISCOUNT_TITLE, isWholesaleDiscountDescription, isWholesaleDiscountAllocation,
} from '../lib/wholesale-discount.mjs';
import { extractPdfText } from './pdf-inspect.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.stack?.split('\n').slice(0, 5).join('\n      ') || e.message}`); failed++; }
}

const m = a => ({ presentmentMoney: { amount: String(a), currencyCode: 'USD' } });
const alloc = (amount, description, targetSelection = 'EXPLICIT') =>
  ({ allocatedAmountSet: m(amount), discountApplication: { targetSelection, ...(description ? { description } : {}) } });
function netLine(id, title, sku, qty, unit) {
  return { id: `gid://shopify/LineItem/${id}`, title, quantity: qty, currentQuantity: qty, variant: { title: 'Default Title', sku },
    discountedUnitPriceSet: m(unit), originalUnitPriceSet: m(unit), discountedTotalSet: m((qty * unit).toFixed(2)), discountAllocations: [] };
}
// SKU 04622 exactly as Shopify returns it after the app's add: LIST price + a per-line wholesale discount.
const wholesaleLine = (over = {}) => ({
  id: 'gid://shopify/LineItem/5', title: 'Pinpoint Leash', quantity: 1, currentQuantity: 1, variant: { title: 'Default Title', sku: '04622' },
  discountedUnitPriceSet: m('8.99'), originalUnitPriceSet: m('17.99'), discountedTotalSet: m('8.99'),
  discountAllocations: [alloc('9.00', WHOLESALE_DISCOUNT_TITLE)], ...over,
});
const baseOrder = (lines, sub, over = {}) => ({
  name: '#39875', processedAt: '2026-10-20T12:00:00Z', displayFinancialStatus: 'PENDING',
  customer: { company: 'Mountain Valley Country Store', displayName: 'Lorraine Rainwater', email: 'orders@example.com' },
  shippingAddress: { address1: '12 Mill Rd', city: 'Asheville', province: 'NC', zip: '28801', country: 'United States' },
  currentSubtotalPriceSet: m(sub), currentTotalPriceSet: m(sub), totalShippingPriceSet: m('0.00'),
  lineItems: { edges: lines.map(node => ({ node })) }, ...over,
});

// What the invoice actually DREW. extractPdfText gives one run per drawn string with its baseline y.
function readInvoice(pdf) {
  const runs = extractPdfText(pdf);
  const sameRow = (anchor) => runs.filter(r => r.page === anchor.page && Math.abs(r.y - anchor.y) <= 2);
  const row = (sku) => {
    const a = runs.find(r => r.text === sku);
    if (!a) return null;
    const cells = sameRow(a).filter(r => r.x >= a.x).sort((p, q) => p.x - q.x).map(r => r.text);
    return { qty: cells[1], unit: cells[2], total: cells[3] };
  };
  const summary = (label) => {
    // LAST match: the table header also draws "TOTAL" (x 500, y 292); the totals block sits below it.
    const a = runs.findLast(r => r.text === label && r.x > 300 && r.x < 470);
    if (!a) return null;
    return sameRow(a).filter(r => r.x > a.x).sort((p, q) => p.x - q.x)[0]?.text ?? null;
  };
  return { runs, row, summary, has: (t) => runs.some(r => r.text === t), texts: runs.map(r => r.text) };
}
const cents = s => Math.round(parseFloat(String(s).replace(/[$,]/g, '')) * 100);

// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 1. One constant, matched in one place ──');

await test('the title is "B2B wholesale" and the matcher is exact (not a substring, not a price adjustment, not an order discount)', () => {
  assert.equal(WHOLESALE_DISCOUNT_TITLE, 'B2B wholesale');
  assert.equal(isWholesaleDiscountDescription('B2B wholesale'), true);
  assert.equal(isWholesaleDiscountDescription('  B2B wholesale '), true);
  for (const d of ['B2B price adj', 'Order discount: B2B wholesale', 'b2b wholesale', 'B2B wholesale 2', '', null, undefined, 42]) {
    assert.equal(isWholesaleDiscountDescription(d), false, String(d));
  }
  assert.equal(isWholesaleDiscountAllocation(alloc('1', WHOLESALE_DISCOUNT_TITLE)), true);
  assert.equal(isWholesaleDiscountAllocation(alloc('1')), false, 'no description (code / automatic discount) is never ours');
  assert.equal(isWholesaleDiscountAllocation(null), false);
});

await test('no code writes the literal title: every mutation site imports the shared constant (comments may mention it)', () => {
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  for (const f of ['server.mjs', 'lib/backorder-edit.mjs', 'pdf.mjs']) {
    const code = stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    assert.ok(!/['"`]B2B wholesale['"`]/.test(code), `${f} still hard-codes the "B2B wholesale" literal`);
  }
  const server = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  assert.equal((server.match(/percentValue: parseFloat\(pct\.toFixed\(4\)\), description: WHOLESALE_DISCOUNT_TITLE/g) || []).length, 2,
    'server.mjs has exactly two wholesale mutation sites (POST /orders/:id/edit catalog lines, POST /orders/:id/line/add)');
  assert.match(server, /import \{ WHOLESALE_DISCOUNT_TITLE \} from '\.\/lib\/wholesale-discount\.mjs'/);
  const bo = fs.readFileSync(path.join(ROOT, 'lib/backorder-edit.mjs'), 'utf8');
  assert.match(bo, /description: WHOLESALE_DISCOUNT_TITLE/, 'Undo-restored backorder lines stamp the same constant');
  assert.match(bo, /import \{ WHOLESALE_DISCOUNT_TITLE \} from '\.\/wholesale-discount\.mjs'/);
  // …and the discount pdf.mjs excludes is selected by getOrderDetail (description lives on ManualDiscountApplication).
  assert.ok((server.match(/discountApplication\{targetSelection \.\.\. on ManualDiscountApplication\{description\}\}/g) || []).length >= 2,
    'getOrderDetail (both its pages) must select discountApplication.description or nothing can be recognised');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 2. Line math ──');

await test('a wholesale-only line has NO invoice discount: gross == net (8.99 / 8.99) and the TOTAL math is untouched', () => {
  const l = wholesaleLine();
  assert.equal(lineItemInvoiceDiscount(l), 0);
  assert.equal(lineItemWholesaleDiscount(l), 9);
  assert.equal(lineItemTrueTotal(l), 8.99);
  assert.equal(lineItemInvoiceGrossTotal(l), 8.99);
  assert.equal(lineItemInvoiceGrossUnit(l), 8.99);
});

await test('genuine discounts still count: order-level code (ALL), an "Order discount: …", a "B2B price adj", and a code with no description', () => {
  const lines = [
    wholesaleLine({ discountAllocations: [alloc('4.00', 'Order discount: Trade show')], discountedUnitPriceSet: m('13.99'), discountedTotalSet: m('13.99') }),
    wholesaleLine({ discountAllocations: [alloc('4.00', 'B2B price adj')], discountedUnitPriceSet: m('13.99'), discountedTotalSet: m('13.99') }),
    wholesaleLine({ discountAllocations: [alloc('4.00', undefined, 'ALL')], discountedUnitPriceSet: m('17.99'), discountedTotalSet: m('17.99') }),
    wholesaleLine({ discountAllocations: [alloc('4.00')], discountedUnitPriceSet: m('13.99'), discountedTotalSet: m('13.99') }),
  ];
  for (const l of lines) { assert.equal(lineItemInvoiceDiscount(l), 4); assert.equal(lineItemWholesaleDiscount(l), 0); }
});

await test('mixed allocations on one line: only the wholesale part is removed; the two parts add back to every allocation', () => {
  const l = wholesaleLine({ discountAllocations: [alloc('9.00', WHOLESALE_DISCOUNT_TITLE), alloc('2.50', undefined, 'ALL')] });
  assert.equal(lineItemInvoiceDiscount(l), 2.5);
  assert.equal(lineItemWholesaleDiscount(l), 9);
  assert.equal(lineItemInvoiceDiscount(l) + lineItemWholesaleDiscount(l), 11.5);
});

await test('quantity scaling is unchanged: a line edited from 4 to 2 prorates the wholesale part exactly like any other discount', () => {
  const l = wholesaleLine({ quantity: 4, currentQuantity: 2, discountedTotalSet: m('35.96'), discountAllocations: [alloc('36.00', WHOLESALE_DISCOUNT_TITLE), alloc('8.00', 'Order discount: x')] });
  assert.equal(lineItemWholesaleDiscount(l), 18);
  assert.equal(lineItemInvoiceDiscount(l), 4);
  const removed = wholesaleLine({ currentQuantity: 0 });
  assert.equal(lineItemInvoiceDiscount(removed), 0);
  assert.equal(lineItemWholesaleDiscount(removed), 0);
});

await test('snapshotLineInvoiceDiscount: new snapshots untouched; legacy ones lose only the wholesale share; never negative, never invented', () => {
  const liveWholesale = { discountAllocations: [alloc('9.00', WHOLESALE_DISCOUNT_TITLE)] };
  // new format (wholesaleDiscountAmount present, even 0): discountAmount is already exclusive — leave it alone.
  assert.equal(snapshotLineInvoiceDiscount({ discountAmount: 0, wholesaleDiscountAmount: 9 }, liveWholesale), 0);
  assert.equal(snapshotLineInvoiceDiscount({ discountAmount: 4, wholesaleDiscountAmount: 0 }, liveWholesale), 4, 'a present key is trusted even if the live line looks wholesale');
  // legacy: inclusive 9.00, live line is wholesale-discounted -> the whole 9.00 was the wholesale price.
  assert.equal(snapshotLineInvoiceDiscount({ discountAmount: 9 }, liveWholesale), 0);
  // legacy + genuine only on the live line -> unchanged.
  assert.equal(snapshotLineInvoiceDiscount({ discountAmount: 4 }, { discountAllocations: [alloc('4.00', 'Order discount: x')] }), 4);
  // legacy mixed (6 of 10 is wholesale) -> proportional.
  assert.equal(snapshotLineInvoiceDiscount({ discountAmount: 10 }, { discountAllocations: [alloc('6', WHOLESALE_DISCOUNT_TITLE), alloc('4', undefined, 'ALL')] }), 4);
  // legacy, live line gone / replaced / no allocations -> nothing identifies the wholesale part, the saved figure stands.
  for (const live of [undefined, null, {}, { discountAllocations: [] }]) assert.equal(snapshotLineInvoiceDiscount({ discountAmount: 9 }, live), 9);
  assert.equal(snapshotLineInvoiceDiscount({ discountAmount: 0 }, liveWholesale), 0);
  assert.equal(snapshotLineInvoiceDiscount({ discountAmount: -3 }, liveWholesale), 0);
  assert.equal(snapshotLineInvoiceDiscount({}, liveWholesale), 0);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 3. What the PDF draws (generateInvoicePdf) ──');

const FOUR_NET = [
  netLine(1, 'Everyday Walking Lead', '03110', 120, 24.99), netLine(2, 'Luxe Limited Slip Collar', '03587', 48, 18.5),
  netLine(3, 'Pinpoint Harness', '03942', 14, 29.99), netLine(4, 'Reflective Bandana', '04120', 6, 27.67),
];

await test('REPORT #39875-A: the 04622 line prints at $8.99 / $8.99 with NO Discount row; Subtotal == TOTAL == $4,481.67', async () => {
  const pdf = readInvoice(await generateInvoicePdf(baseOrder([...FOUR_NET, wholesaleLine()], '4481.67'), {}));
  assert.deepEqual(pdf.row('04622'), { qty: '1', unit: '$8.99', total: '$8.99' });
  assert.deepEqual(pdf.row('03110'), { qty: '120', unit: '$24.99', total: '$2,998.80' }, 'net-priced lines are unchanged');
  assert.equal(pdf.has('Discount'), false, 'no Discount row for the app\'s own wholesale price');
  assert.ok(!pdf.texts.some(t => /17\.99|9\.00/.test(t)), 'neither the list price nor the 9.00 discount appears anywhere');
  assert.equal(pdf.summary('Subtotal'), '$4,481.67');
  assert.equal(pdf.summary('TOTAL'), '$4,481.67');
});

await test('CONTROL: the same line WITHOUT the wholesale title is a genuine discount and still prints list price + Discount -$9.00', async () => {
  for (const description of ['B2B price adj', 'Order discount: Trade show', undefined]) {
    const line = wholesaleLine({ discountAllocations: [alloc('9.00', description)] });
    const pdf = readInvoice(await generateInvoicePdf(baseOrder([...FOUR_NET, line], '4481.67'), {}));
    assert.deepEqual(pdf.row('04622'), { qty: '1', unit: '$17.99', total: '$17.99' }, String(description));
    assert.equal(pdf.summary('Discount'), '-$9.00', String(description));
    assert.equal(pdf.summary('Subtotal'), '$4,490.67', String(description));
    assert.equal(pdf.summary('TOTAL'), '$4,481.67', String(description));
  }
});

await test('wholesale + genuine on one invoice: only the genuine discount is itemised, and Subtotal - Discount == the Shopify subtotal', async () => {
  const genuine = netLine(6, 'Trade Show Lead', 'TSL-003', 2, 18);
  genuine.originalUnitPriceSet = m('20.00'); genuine.discountAllocations = [alloc('4.00', 'Order discount: Trade show')];
  const order = baseOrder([netLine(1, 'Wholesale Collar', 'WC-001', 3, 12), wholesaleLine(), genuine], '80.99');
  const pdf = readInvoice(await generateInvoicePdf(order, {}));
  assert.deepEqual(pdf.row('04622'), { qty: '1', unit: '$8.99', total: '$8.99' });
  assert.deepEqual(pdf.row('TSL-003'), { qty: '2', unit: '$20.00', total: '$40.00' });
  assert.equal(pdf.summary('Discount'), '-$4.00');
  assert.equal(pdf.summary('Subtotal'), '$84.99');
  assert.equal(pdf.summary('TOTAL'), '$80.99');
  assert.equal(cents(pdf.summary('Subtotal')) + cents(pdf.summary('Discount')), cents(pdf.summary('TOTAL')));
});

await test('partial-invoice opts (the POST route\'s numbers): no Discount row, rows net, total unchanged', async () => {
  const lines = [...FOUR_NET, wholesaleLine()];
  const subtotal = lines.reduce((s, i) => s + lineItemTrueTotal(i), 0);
  const discount = lines.reduce((s, i) => s + lineItemInvoiceDiscount(i), 0);
  assert.equal(discount, 0);
  const pdf = readInvoice(await generateInvoicePdf(baseOrder(lines, '4481.67'),
    { lineItems: lines, invoiceSuffix: 'A', subtotal, grossSubtotal: subtotal + discount, discount, shipping: 0, total: subtotal }));
  assert.deepEqual(pdf.row('04622'), { qty: '1', unit: '$8.99', total: '$8.99' });
  assert.equal(pdf.has('Discount'), false);
  assert.equal(pdf.summary('Subtotal'), '$4,481.67');
  assert.equal(pdf.summary('TOTAL'), '$4,481.67');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 4. The real routes (own mock server, fixture #1011, seeded legacy snapshots) ──');

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
// Only what the mock needs — no Shopify / Doppler / Xero / Google / Helcim variable is passed through, and
// B2B_ADMIN_MOCK=1 keeps SQLite in memory (never data/admin.db). The seed module refuses to run otherwise.
async function startMockServer() {
  const port = await freePort();
  const env = {};
  for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (process.env[k] != null) env[k] = process.env[k];
  Object.assign(env, { PORT: String(port), B2B_ADMIN_MOCK: '1',
    B2B_IMPERSONATION_SECRET: 'test-impersonation-secret-mock', SHOPIFY_WEBHOOK_SECRET: 'test-shopify-webhook-secret' });
  const child = spawn(process.execPath, ['--import', './test/invoice-wholesale-seed.mjs', 'server.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode != null) break;
    try { if ((await fetch(`${base}/healthz`)).ok) return { base, child, stop: () => child.kill() }; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  child.kill();
  throw new Error(`mock server did not start on ${port}:\n${log.slice(-800)}`);
}

const server = await startMockServer();
try {
  const sid = (await (await fetch(`${server.base}/__test__/session?email=alex@fuzzywumpets.com`)).json()).sid;
  const cookie = `b2b_admin_sid=${sid}`;
  const get = (p) => fetch(server.base + p, { headers: { Cookie: cookie } });
  const pdfOf = async (p) => { const r = await get(p); assert.equal(r.status, 200, p); return readInvoice(Buffer.from(await r.arrayBuffer())); };

  const expectWithGenuine = (pdf, label) => {
    assert.deepEqual(pdf.row('WC-001'), { qty: '3', unit: '$12.00', total: '$36.00' }, label);
    assert.deepEqual(pdf.row('04622'), { qty: '1', unit: '$8.99', total: '$8.99' }, `${label}: wholesale line at net`);
    assert.deepEqual(pdf.row('TSL-003'), { qty: '2', unit: '$20.00', total: '$40.00' }, `${label}: genuine discount still reconstructed`);
    assert.equal(pdf.summary('Discount'), '-$4.00', `${label}: only the genuine discount`);
    assert.equal(pdf.summary('Subtotal'), '$84.99', label);
    assert.equal(pdf.summary('TOTAL'), '$80.99', `${label}: TOTAL is the Shopify order total`);
    assert.equal(cents(pdf.summary('Subtotal')) + cents(pdf.summary('Discount')), cents(pdf.summary('TOTAL')), `${label}: Subtotal - Discount == TOTAL`);
  };

  await test('FULL order invoice (GET /orders/1011/invoice.pdf)', async () => {
    expectWithGenuine(await pdfOf('/orders/1011/invoice.pdf'), 'full invoice');
  });

  await test('invoice.csv and the order page are unchanged: net unit price and line total (no list price, no wholesale Discount row)', async () => {
    const csv = await (await get('/orders/1011/invoice.csv')).text();
    assert.match(csv, /"Added Pinpoint Leash".*"04622","8\.99","1","8\.99"/);
    const page = await (await get('/orders/1011')).text();
    assert.ok(page.includes('$8.99') && !page.includes('$17.99'), 'order page shows the net wholesale unit price');
    assert.match(page, /Discount — Trade show<\/span><span>-\$4\.00/, 'order page itemises only the genuine "Order discount"');
    assert.ok(!/Discount[^<]*<\/span><span>-\$13\.00/.test(page));
  });

  await test('NEW partial invoice (POST /orders/1011/partial-invoice) renders the same, and snapshots the split', async () => {
    const r = await fetch(`${server.base}/orders/1011/partial-invoice`, { method: 'POST', redirect: 'manual',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'type=full&shipping_handling=first' });
    assert.equal(r.status, 302);
    assert.match(r.headers.get('location'), /letter=A$/);
    expectWithGenuine(await pdfOf('/orders/1011/partial-invoice/A.pdf'), 'new snapshot re-download');
    const rows = (await (await get('/api/admin/orders/1011/partial-invoices')).json()).invoices;
    const a = JSON.parse(rows.find(x => x.invoice_letter === 'A').line_items_json);
    const leash = a.find(l => l.sku === '04622'), lead = a.find(l => l.sku === 'TSL-003');
    assert.equal(leash.unitPrice, 8.99);
    assert.equal(leash.discountAmount, 0, 'genuine discount only');
    assert.equal(leash.wholesaleDiscountAmount, 9, 'the wholesale price is recorded apart (and marks the snapshot as exclusive)');
    assert.equal(lead.discountAmount, 4);
    assert.equal(lead.wholesaleDiscountAmount, 0);
    assert.equal(cents(rows.find(x => x.invoice_letter === 'A').total), 8099, 'the stored invoice total is the Shopify total, unchanged');
  });

  await test('LEGACY snapshot Y (saved before the fix: inclusive 9.00 + genuine 4.00) re-downloads corrected', async () => {
    expectWithGenuine(await pdfOf('/orders/1011/partial-invoice/Y.pdf'), 'legacy snapshot');
  });

  await test('LEGACY snapshot Z (wholesale-priced lines only — the #39875-A shape) re-downloads with NO Discount row', async () => {
    const pdf = await pdfOf('/orders/1011/partial-invoice/Z.pdf');
    assert.deepEqual(pdf.row('04622'), { qty: '1', unit: '$8.99', total: '$8.99' });
    assert.equal(pdf.has('Discount'), false);
    assert.equal(pdf.summary('Subtotal'), '$44.99');
    assert.equal(pdf.summary('TOTAL'), '$44.99');
    assert.ok(!pdf.texts.some(t => /17\.99|9\.00/.test(t)));
  });

  await test('a wholesale-only ORDER (the genuine line removed through the edit form) has no Discount row and Subtotal == TOTAL', async () => {
    const r = await fetch(`${server.base}/orders/1011/edit`, { method: 'POST', redirect: 'manual',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'removes=li1011c' });
    assert.equal(r.status, 302);
    const pdf = await pdfOf('/orders/1011/invoice.pdf');
    assert.equal(pdf.row('TSL-003'), null, 'the removed line is gone');
    assert.deepEqual(pdf.row('04622'), { qty: '1', unit: '$8.99', total: '$8.99' });
    assert.equal(pdf.has('Discount'), false);
    assert.equal(pdf.summary('Subtotal'), '$44.99');
    assert.equal(pdf.summary('TOTAL'), '$44.99');
  });
} finally {
  server.stop();
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
