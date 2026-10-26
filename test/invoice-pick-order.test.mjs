// Invoice line ORDER = warehouse PICK LIST order (pdf.mjs invoiceSortKey / sortInvoiceLines, SYNC: pick-sort-key).
//
// THE PICK LIST is fww-shipping-bridge/worker.js pickAggregate: lines grouped by PATTERN (title minus its leading width and
// the product-type words), patterns sorted with localeCompare, then each pattern's variants sorted by the label
// `width · size · typeCode` with localeCompare. The invoice now prints its lines in that order so the person packing the box
// can tick the invoice off against the shelf. Display only: totals never depend on row order.
//
// Run: node test/invoice-pick-order.test.mjs
//   Sections 1-3 are pure (pdf.mjs + fixtures built from the REAL lines of order #39875). Section 4 boots ITS OWN mock server
//   on a free port with B2B_ADMIN_MOCK=1 (in-memory SQLite, no Shopify/Doppler env), seeding one legacy lettered invoice
//   through test/invoice-pick-order-seed.mjs; it never touches data/admin.db or any live service.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateInvoicePdf, invoiceSortKey, sortInvoiceLines, buildOrderInvoiceBackorderModel } from '../pdf.mjs';
import { BACKORDER_TAG, BACKORDER_HEADING } from '../lib/invoice-backorder.mjs';
import { extractPdfText } from './pdf-inspect.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.stack?.split('\n').slice(0, 5).join('\n      ') || e.message}`); failed++; }
}

// A getOrderDetail-shaped line node. variant is null for a custom line (no variant at all).
const money = (a) => ({ presentmentMoney: { amount: String(a), currencyCode: 'USD' } });
const node = (title, variantTitle, sku, over = {}) => ({
  id: over.id || `gid://shopify/LineItem/${Math.random().toString(36).slice(2)}`, title, quantity: over.qty ?? 1, currentQuantity: over.qty ?? 1,
  variant: (variantTitle != null || sku) ? { id: 'v', title: variantTitle, sku: sku ?? null } : null,
  discountedUnitPriceSet: money(over.unit ?? 10), originalUnitPriceSet: money(over.unit ?? 10), discountedTotalSet: money(((over.unit ?? 10) * (over.qty ?? 1)).toFixed(2)),
  discountAllocations: [],
});
const ADDR = { address1: '1 Main St', city: 'Asheville', province: 'NC', zip: '28801', country: 'United States' };
const orderOf = (nodes, total) => ({
  name: '#39875', processedAt: '2026-10-20T12:00:00Z', displayFinancialStatus: 'PENDING',
  customer: { company: 'Mountain Valley Country Store', displayName: 'Test Buyer', email: 'orders@example.com' },
  shippingAddress: { ...ADDR }, billingAddress: { ...ADDR },
  currentSubtotalPriceSet: money(total), currentTotalPriceSet: money(total), totalShippingPriceSet: money('0.00'),
  lineItems: { edges: nodes.map(n => ({ node: n })) },
});
// What the SKU column of each ROW drew, in draw order (struck rows included — they are drawn at the same x/size).
const skuColumn = (pdf) => extractPdfText(pdf).filter(r => r.x === 276 && r.size === 8.5).map(r => r.text);

// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 1. The key, pinned on real titles (pattern = title minus width and type words; label = width · size · type) ──');

// [Shopify line title, variant title, sku] -> expected key. Titles/variants/SKUs are real lines of order #39875.
const PINS = [
  // The product title carries no width; the variant is "<width> / <size>" (the "Everyday" lines).
  [['A Leg to Stand On Everyday Limited Slip Collar', '5/8" / XS', 'CRSLSC0531858XS'], { pattern: 'A Leg to Stand On', label: '5/8" / XS · LSC' }],
  [['Upland Bird Everyday Limited Slip Collar', '1" / LG', 'FWLSC-UBXX-1-LG'], { pattern: 'Upland Bird', label: '1" / LG · LSC' }],
  [['Honey Bees Everyday Limited Slip Collar', 'XS / 5/8"', 'CRSLSC05106XS58'], { pattern: 'Honey Bees', label: 'XS / 5/8" · LSC' }],
  // The width leads the title; the variant is just the size.
  [['5/8" Anastasia Luxe Limited Slip Collar', 'MED', 'LSC04595MED'], { pattern: 'Anastasia', label: '5/8" · MED · LSC' }],
  [['1.5" Apple Nouvelle Luxe Limited Slip Collar', 'MED', 'LSC04984MED'], { pattern: 'Apple Nouvelle', label: '1.5" · MED · LSC' }],
  [['1.5" Art Deco Dreams Everyday Limited Slip Collar', 'LG', 'LSC04718LG'], { pattern: 'Art Deco Dreams', label: '1.5" · LG · LSC' }],
  [['1" Gold & Orange Honoré Luxe Limited Slip Collar', 'XS', 'LSC04593XS'], { pattern: 'Gold & Orange Honoré', label: '1" · XS · LSC' }],
  [['5/8" Enchanted Forest  Limited Slip Collar', 'XS', 'LSC04739XS'], { pattern: 'Enchanted Forest', label: '5/8" · XS · LSC' }],
  // Other product types: the type code comes from the title; "Other" adds nothing to the label.
  [['Smooth Operator Snap Leash', '6ft / Purple', '046326FTPUR'], { pattern: 'Smooth Operator Snap', label: '6ft / Purple · Leash' }],
  [['5/8" Smooth Operator Limited Slip Collar', 'Blue / LG (16"-20")', 'LSC04633BLULG'], { pattern: 'Smooth Operator', label: '5/8" · Blue / LG (16"-20") · LSC' }],
  [['Smooth Operator Adjustable Slip Lead (6 ft)', 'Purple', '04625'], { pattern: 'Smooth Operator Adjustable Slip Lead (6 ft)', label: 'Purple' }],
  // No variant: a "Default Title" variant counts as none (Shopify leaves it out of the line name).
  [['Smooth Operator Adjustable Slip Lead (6 ft)', 'Default Title', '04625'], { pattern: 'Smooth Operator Adjustable Slip Lead (6 ft)', label: '—' }],
  // Width forms the pick list understands: mixed number, unicode fraction, "in"/"inch".
  [['1 1/4" Foo Luxe Collar', 'SM', 'X-1'], { pattern: 'Foo', label: '1 1/4" · SM' }],
  [['⅝" Foo Luxe Collar', 'SM', 'X-2'], { pattern: 'Foo', label: '⅝" · SM' }],
  [['1.5 inch Foo Harness', 'SM', 'X-3'], { pattern: 'Foo', label: '1.5" · SM · Harness' }],
];

for (const [[title, variant, sku], want] of PINS) {
  await test(`key: ${title} / ${variant}`, () => {
    const k = invoiceSortKey(node(title, variant, sku));
    assert.deepEqual({ pattern: k.pattern, label: k.label, hasSku: k.hasSku }, { ...want, hasSku: true });
  });
}

await test('the same key from a stored-snapshot line ({ variantTitle, sku } flat) and a backorders row — one function for all three shapes', () => {
  const live = invoiceSortKey(node('5/8" Anastasia Luxe Limited Slip Collar', 'MED', 'LSC04595MED'));
  assert.deepEqual(invoiceSortKey({ title: '5/8" Anastasia Luxe Limited Slip Collar', variantTitle: 'MED', sku: 'LSC04595MED' }), live);
  assert.deepEqual(invoiceSortKey({ title: '5/8" Anastasia Luxe Limited Slip Collar', variant: { title: 'MED', sku: 'LSC04595MED' } }), live);
});

await test('SKU presence: a SKU on the line OR on its variant counts; blank / missing / custom line (no variant) does not', () => {
  assert.equal(invoiceSortKey({ title: 'X', sku: 'S1' }).hasSku, true);
  assert.equal(invoiceSortKey({ title: 'X', variant: { sku: 'S1' } }).hasSku, true);
  for (const bad of [{ title: 'X' }, { title: 'X', sku: '' }, { title: 'X', sku: '  ' }, { title: 'X', variant: null }, { title: 'X', variant: { sku: null } }, null, undefined]) {
    assert.equal(invoiceSortKey(bad).hasSku, false, JSON.stringify(bad));
  }
  assert.equal(invoiceSortKey(null).pattern, 'Item', 'never throws on junk');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 2. Sorting semantics ──');

const L = (title, variant, sku = 'S') => node(title, variant, sku);
const titles = (items) => items.map(i => `${i.title}|${i.variant?.title ?? ''}`);

await test('patterns sort alphabetically, then variants by label — sizes ALPHABETICALLY (LG, MED, SM, XLG, XS), not by physical size', () => {
  const input = [L('1.5" Luna Everyday Limited Slip Collar', 'XS'), L('1.5" Luna Everyday Limited Slip Collar', 'SM'), L('1.5" Luna Everyday Limited Slip Collar', 'XLG'),
    L('1.5" Luna Everyday Limited Slip Collar', 'MED'), L('1.5" Luna Everyday Limited Slip Collar', 'LG'), L('1.5" Anastasia Luxe Limited Slip Collar', 'XS')];
  assert.deepEqual(sortInvoiceLines(input).map(i => i.variant.title), ['XS', 'LG', 'MED', 'SM', 'XLG', 'XS']);
  assert.deepEqual(sortInvoiceLines(input).map(i => invoiceSortKey(i).pattern), ['Anastasia', 'Luna', 'Luna', 'Luna', 'Luna', 'Luna']);
});

await test('the product TYPE is not a sort level of its own: "Everyday" and "Luxe" of one pattern interleave by variant label alone', () => {
  const input = [L('1.5" Foo Luxe Limited Slip Collar', 'SM'), L('1.5" Foo Everyday Limited Slip Collar', 'LG'), L('1.5" Foo Luxe Limited Slip Collar', 'LG')];
  assert.deepEqual(sortInvoiceLines(input).map(i => i.variant.title), ['LG', 'LG', 'SM']);
});

await test('ties keep their ORIGINAL order (stable; no tie-breaker beyond the index) and the input array is not mutated', () => {
  const a = L('Dup Everyday Limited Slip Collar', 'MED', 'S-1'), b = L('Dup Everyday Limited Slip Collar', 'MED', 'S-2'), c = L('Dup Everyday Limited Slip Collar', 'MED', 'S-3');
  const input = [c, a, b];
  const out = sortInvoiceLines(input);
  assert.deepEqual(out.map(i => i.variant.sku), ['S-3', 'S-1', 'S-2']);
  assert.deepEqual(input.map(i => i.variant.sku), ['S-3', 'S-1', 'S-2']);
  assert.notEqual(out, input);
});

await test('lines with NO SKU print last, in their original order, however they would otherwise sort', () => {
  const input = [node('Alteration', null, null), L('Zebra Collar', 'MED'), node('Aaa Repair', null, ''), L('Aardvark Collar', 'LG'), { title: 'Custom', variant: null }];
  assert.deepEqual(sortInvoiceLines(input).map(i => i.title), ['Aardvark Collar', 'Zebra Collar', 'Alteration', 'Aaa Repair', 'Custom']);
});

await test('comparison is locale-aware (a < B), not code-unit order — the same as the pick list\'s localeCompare', () => {
  const out = sortInvoiceLines([L('banana Collar', 'M'), L('Apple Collar', 'M'), L('Cherry Collar', 'M'), L('apricot Collar', 'M')]);
  assert.deepEqual(out.map(i => i.title), ['Apple Collar', 'apricot Collar', 'banana Collar', 'Cherry Collar']);
});

await test('junk in, no crash: non-array / null entries / missing titles', () => {
  assert.deepEqual(sortInvoiceLines(null), []);
  assert.deepEqual(sortInvoiceLines([]), []);
  assert.equal(sortInvoiceLines([null, undefined, {}, { title: 'A Collar', sku: 'S' }]).length, 4);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 3. A real-shaped order (the 118 lines of order #39875), and the PDF ──');

const REAL = readJson('test/fixtures/order-39875-lines.json');
const realNodes = () => REAL.map(([title, variant, sku], i) => node(title, variant, sku, { id: `gid://shopify/LineItem/real${i}` }));

await test('the first lines come out as the pick list reads: A Leg to Stand On, Anastasia, Apple Nouvelle, Art Deco Dreams LG then MED, Athena, Autumn Paisley, Bats Ahoy LG then MED, Camo', () => {
  const sorted = sortInvoiceLines(realNodes());
  const head = sorted.slice(0, 10);
  assert.deepEqual(head.map(n => invoiceSortKey(n).pattern),
    ['A Leg to Stand On', 'Anastasia', 'Apple Nouvelle', 'Art Deco Dreams', 'Art Deco Dreams', 'Athena', 'Autumn Paisley', 'Bats Ahoy', 'Bats Ahoy', 'Camo']);
  assert.deepEqual(head.map(n => n.variant.title), ['5/8" / XS', 'MED', 'MED', 'LG', 'MED', 'MED', 'MED', '1" / LG', '1" / MED', 'XS'], 'LG before MED within a pattern');
  assert.deepEqual(head.slice(0, 3).map(n => n.variant.sku), ['CRSLSC0531858XS', 'LSC04595MED', 'LSC04984MED']);
  // For contrast: Shopify's own order starts with Upland Bird, Hot to Trot, Hot to Trot.
  assert.deepEqual(realNodes().slice(0, 3).map(n => invoiceSortKey(n).pattern), ['Upland Bird', 'Hot to Trot', 'Hot to Trot']);
});

await test('the whole order follows the REAL pick list: same (pattern, variant label) sequence as fww-shipping-bridge pickAggregate produced for these lines', () => {
  const golden = readJson('test/fixtures/order-39875-pick-list.json').sequence;     // generated by running the bridge's own code
  const seq = [];
  for (const n of sortInvoiceLines(realNodes())) {
    const k = invoiceSortKey(n);
    if (!k.hasSku) continue;
    const s = `${k.pattern}\t${k.label}`;
    if (seq[seq.length - 1] !== s) seq.push(s);        // the pick list merges equal rows; the invoice keeps them adjacent
  }
  assert.deepEqual(seq, golden);
  assert.equal(golden.length, 117);
});

await test('nothing is lost or invented: the sorted order is a permutation of the input, the SKU-less custom line is last', () => {
  const input = realNodes(), sorted = sortInvoiceLines(input);
  assert.equal(sorted.length, 118);
  assert.deepEqual([...sorted].sort((a, b) => a.id.localeCompare(b.id)), [...input].sort((a, b) => a.id.localeCompare(b.id)));
  assert.equal(sorted.at(-1).title, "Smooth Operator Custom 4' Slip Lead");
  assert.equal(invoiceSortKey(sorted.at(-1)).hasSku, false);
});

await test('PDF: the SKU column draws in pick order, quantities/prices stay on their own rows, totals are the order\'s and do not move', async () => {
  const nodes = REAL.map(([title, variant, sku], i) => node(title, variant, sku, { id: `gid://shopify/LineItem/real${i}`, qty: 1 + (i % 3) }));
  const order = orderOf(nodes, '4481.67');
  const pdf = await generateInvoicePdf(order, {});
  const drawn = skuColumn(pdf).filter(s => s !== '—');
  assert.deepEqual(drawn, sortInvoiceLines(nodes).filter(n => invoiceSortKey(n).hasSku).map(n => n.variant.sku));
  const runs = extractPdfText(pdf);
  // Each row's qty and total sit on the same baseline as its SKU: find the Anastasia row and read across.
  const sku = runs.find(r => r.text === 'LSC04595MED');
  const cells = runs.filter(r => r.page === sku.page && Math.abs(r.y - sku.y) <= 2 && r.x >= sku.x).sort((p, q) => p.x - q.x).map(r => r.text);
  const idx = nodes.findIndex(n => n.variant.sku === 'LSC04595MED');
  assert.deepEqual(cells, ['LSC04595MED', String(1 + (idx % 3)), '$10.00', `$${(10 * (1 + (idx % 3))).toFixed(2)}`]);
  const amounts = runs.filter(r => r.size >= 10 && /^-?\$/.test(r.text)).map(r => r.text);
  assert.deepEqual(amounts, ['$4,481.67', '$4,481.67'], 'Subtotal == TOTAL == the order\'s figure, whatever the row order');
});

await test('struck BACKORDERED rows stay a trailing block (after every active row) and follow the same pick order — rows AND footnote', async () => {
  const nodes = [node('Zebra Everyday Limited Slip Collar', 'MED', 'Z-1'), node('Mango Everyday Limited Slip Collar', 'MED', 'M-1'), node('Apple Everyday Limited Slip Collar', 'MED', 'A-1')];
  // Flagged order (oldest first): Zebra, Apple, Mango, and one SKU-less item. Pick order: Apple, Mango, Zebra, then the SKU-less one.
  const row = (title, sku) => ({ lineItemId: `li-${title}`, sku, title, variantTitle: 'MED', quantity: 1, unitPrice: 5, currency: 'USD', lineTotal: 5, createdAt: 1 });
  const rows = [row('Zebra Everyday Limited Slip Collar', 'BZ-1'), row('Custom Charm', ''), row('Apple Everyday Limited Slip Collar', 'BA-1'), row('Mango Everyday Limited Slip Collar', 'BM-1')];
  const pdf = await generateInvoicePdf(orderOf(nodes, '30.00'), { backorderedLines: rows });
  assert.deepEqual(skuColumn(pdf), ['A-1', 'M-1', 'Z-1', 'BA-1', 'BM-1', 'BZ-1', '—'], 'active rows first (pick order), then the struck block (pick order, SKU-less last)');
  const model = buildOrderInvoiceBackorderModel(rows);
  assert.deepEqual(model.lines.map(l => l.sku), ['BA-1', 'BM-1', 'BZ-1', ''], 'the model (hence the HTML block) is in the same order');
  assert.deepEqual(model.footnote.items.map(i => i.detail), ['SKU BA-1 · Qty 1', 'SKU BM-1 · Qty 1', 'SKU BZ-1 · Qty 1', 'Qty 1'], 'footnote maps 1:1 onto the rows');
  const texts = extractPdfText(pdf).map(r => r.text);
  const foot = texts.slice(texts.indexOf(BACKORDER_HEADING));
  assert.ok(foot.indexOf('SKU BA-1 · Qty 1') < foot.indexOf('SKU BM-1 · Qty 1') && foot.indexOf('SKU BM-1 · Qty 1') < foot.indexOf('SKU BZ-1 · Qty 1'));
  assert.equal(texts.filter(t => t === BACKORDER_TAG).length, 4);
});

await test('buildOrderInvoiceBackorderModel: null stays null; junk rows are dropped as before; input rows are not mutated', () => {
  assert.equal(buildOrderInvoiceBackorderModel(null), null);
  assert.equal(buildOrderInvoiceBackorderModel([]), null);
  assert.equal(buildOrderInvoiceBackorderModel([null, { title: 'x', quantity: 0 }]), null);
  const rows = [{ title: 'Z Collar', sku: 'Z', quantity: 1, unitPrice: 1 }, { title: 'A Collar', sku: 'A', quantity: 1, unitPrice: 1 }];
  buildOrderInvoiceBackorderModel(rows);
  assert.deepEqual(rows.map(r => r.sku), ['Z', 'A']);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 4. All three invoice surfaces, through the real routes (own mock server on #1001) ──');

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
async function startMockServer() {
  const port = await freePort();
  const env = {};
  for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (process.env[k] != null) env[k] = process.env[k];
  Object.assign(env, { PORT: String(port), B2B_ADMIN_MOCK: '1',
    B2B_IMPERSONATION_SECRET: 'test-impersonation-secret-mock', SHOPIFY_WEBHOOK_SECRET: 'test-shopify-webhook-secret' });
  const child = spawn(process.execPath, ['--import', './test/invoice-pick-order-seed.mjs', 'server.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
process.on('exit', () => { try { server.child.kill(); } catch { /* already gone */ } });
try {
  const sid = (await (await fetch(`${server.base}/__test__/session?email=alex@fuzzywumpets.com`)).json()).sid;
  const cookie = `b2b_admin_sid=${sid}`;
  const get = (p) => fetch(server.base + p, { headers: { Cookie: cookie } });
  const text = async (p) => { const r = await get(p); assert.equal(r.status, 200, p); return r.text(); };
  const pdf = async (p) => { const r = await get(p); assert.equal(r.status, 200, p); return Buffer.from(await r.arrayBuffer()); };
  const postForm = (p, fields) => fetch(server.base + p, { method: 'POST', redirect: 'manual',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
  const postJson = async (p, body) => {
    const r = await fetch(server.base + p, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual' });
    let json = null; try { json = await r.json(); } catch { /* not json */ }
    return { status: r.status, json };
  };
  const addLine = (title, sku, qty) => postJson('/orders/1001/line/add', { idemKey: crypto.randomUUID(), variantId: sku || 'v-nosku', title, sku, qty, listPrice: 28, price: 14 });

  // Mock #1001 holds Elite Collar (EC-001-S-NV) then Luxe Leash (LL-005) — already in pick order. Add an A-line and a
  // SKU-less line AFTER them, so Shopify's order and the pick order disagree.
  const aard = await addLine('Aardvark Collar', 'AA-001', 2); assert.equal(aard.status, 200, JSON.stringify(aard.json));
  const svc = await addLine('Zeta Alteration', '', 1); assert.equal(svc.status, 200, JSON.stringify(svc.json));
  const PICK = ['AA-001', 'EC-001-S-NV', 'LL-005', '—'];

  await test('FULL order invoice (GET /orders/1001/invoice.pdf): Shopify order Elite, Luxe, Aardvark, Zeta -> printed Aardvark, Elite, Luxe, then the SKU-less line', async () => {
    assert.deepEqual(skuColumn(await pdf('/orders/1001/invoice.pdf')), PICK);
  });

  await test('NEW lettered invoice (POST Generate PDF, then the re-download the viewer/Download use): same pick order', async () => {
    const made = await postForm('/orders/1001/partial-invoice', { type: 'full' });
    assert.equal(made.status, 302);
    assert.match(made.headers.get('location'), /letter=A$/);
    assert.deepEqual(skuColumn(await pdf('/orders/1001/partial-invoice/A.pdf')), PICK);
    assert.deepEqual(skuColumn(await pdf('/orders/1001/partial-invoice/A.pdf?download=1')), PICK);
  });

  await test('OLD lettered invoice (legacy snapshot Y saved as Luxe, Elite, Zebra, Aardvark, alteration): re-download prints it in pick order — prices and total untouched', async () => {
    const buf = await pdf('/orders/1001/partial-invoice/Y.pdf');
    assert.deepEqual(skuColumn(buf), ['AA-1-LG', 'EC-001-S-NV', 'LL-005', 'ZB-1-MED', '—']);
    const runs = extractPdfText(buf);
    assert.deepEqual(runs.filter(r => r.size >= 10 && /^-?\$/.test(r.text)).map(r => r.text), ['$225.00', '$225.00']);
    const alt = runs.find(r => r.text === 'Alteration');
    const row = runs.filter(r => r.page === alt.page && Math.abs(r.y - alt.y) <= 2 && r.x > 380).sort((p, q) => p.x - q.x).map(r => r.text);
    assert.deepEqual(row, ['1', '$10.00', '$10.00'], 'the SKU-less alteration kept its own qty / price / total');
    const saved = (await (await get('/api/admin/orders/1001/partial-invoices')).json()).invoices.find(r => r.invoice_letter === 'Y');
    assert.deepEqual(JSON.parse(saved.line_items_json).map(l => l.id), ['li2', 'li1', 'legacy-z', 'legacy-a', 'legacy-svc'], 'the SAVED snapshot is not reordered — display only');
  });

  await test('BACKORDERED rows flagged Elite-then-Aardvark print Aardvark-then-Elite below the active rows on all three surfaces (PDF rows, footnote, viewer HTML)', async () => {
    const f1 = await postForm('/orders/1001/backorder', { lineItemId: 'li1', quantity: '1' });
    assert.ok((f1.headers.get('location') || '').includes('success=backorder_flagged'), f1.headers.get('location'));
    const f2 = await postForm('/orders/1001/backorder', { lineItemId: aard.json.line.liId, quantity: '1' });
    assert.ok((f2.headers.get('location') || '').includes('success=backorder_flagged'), f2.headers.get('location'));
    const EXPECT = [...PICK, 'AA-001', 'EC-001-S-NV'];                 // active block, then the struck block
    const full = await pdf('/orders/1001/invoice.pdf');
    assert.deepEqual(skuColumn(full), EXPECT);
    const footnote = (buf) => extractPdfText(buf).map(r => r.text).filter(t => /^SKU /.test(t));
    assert.deepEqual(footnote(full), ['SKU AA-001 · Qty 1', 'SKU EC-001-S-NV · Qty 1']);

    const made = await postForm('/orders/1001/partial-invoice', { type: 'full' });   // a NEW letter freezes both rows
    const letter = /letter=([A-Z])$/.exec(made.headers.get('location'))?.[1];
    assert.equal(letter, 'B');
    const lettered = await pdf(`/orders/1001/partial-invoice/${letter}.pdf`);
    assert.deepEqual(skuColumn(lettered), EXPECT);
    assert.deepEqual(footnote(lettered), ['SKU AA-001 · Qty 1', 'SKU EC-001-S-NV · Qty 1']);

    for (const p of ['/orders/1001/invoice', `/orders/1001/invoice?letter=${letter}`]) {
      const html = await text(p);
      const a = html.indexOf('<s class="inv-bo-title">Aardvark Collar</s>'), e = html.indexOf('<s class="inv-bo-title">Elite Collar</s>');
      assert.ok(a > 0 && e > a, `${p}: viewer block lists Aardvark before Elite`);
    }
  });
} finally {
  server.stop();
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
