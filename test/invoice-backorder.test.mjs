// Backordered lines on the ORDER invoice (lib/invoice-backorder.mjs + pdf.mjs + GET /orders/:id/invoice[.pdf]).
//
// Run: node test/invoice-backorder.test.mjs
//   Self-contained: section 5-6 boot THEIR OWN mock server (B2B_ADMIN_MOCK=1, in-memory SQLite, a free port
//   chosen at run time, no Shopify/Doppler env passed in) so the state is pristine and nothing is shared with
//   the other suites' server. Playwright (section 6) is already a devDependency (test/ui.test.mjs).
//
// Re-pinning the "no backorders => unchanged" goldens — ONLY when the invoice layout is changed on purpose:
//   WRITE_INVOICE_GOLDEN=1 [INVOICE_GOLDEN_HTTP_BASE=http://127.0.0.1:<port of a PRISTINE mock server>] \
//     node test/invoice-backorder.test.mjs
//   and review the diff of test/fixtures/invoice-no-backorder.golden.json. The committed file was generated
//   by the pre-feature code (commit 89a9d55: pdf.mjs for `unit`, a mock server started from that commit for
//   `http`), so passing proves the feature leaves backorder-free invoices exactly as they were.
//
// Set INVOICE_SHOT_DIR=<dir> to also save the section-6 screenshots (390 / 768 / 1280 px) and the section-5 PDF.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import * as fontkit from 'fontkit';
import { fileURLToPath } from 'node:url';
import { generateInvoicePdf, buildOrderInvoiceBackorderModel } from '../pdf.mjs';
import {
  BACKORDER_MARK, BACKORDER_TAG, BACKORDER_HEADING, BACKORDER_HEADING_CONTINUED, BACKORDER_INTRO,
  INVOICE_BACKORDER_CSS,
  buildInvoiceBackorderModel, formatBackorderMoney, renderInvoiceBackorderHtml,
} from '../lib/invoice-backorder.mjs';
import { pageContentHashes, extractPdfText } from './pdf-inspect.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GOLDEN_PATH = fileURLToPath(new URL('./fixtures/invoice-no-backorder.golden.json', import.meta.url));

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.stack?.split('\n').slice(0, 5).join('\n      ') || e.message}`); failed++; }
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────
const money = (a) => ({ presentmentMoney: { amount: String(a), currencyCode: 'USD' } });
function line(i, over = {}) {
  const unit = over.unit ?? 12.5;
  const qty = over.qty ?? 2;
  return { node: {
    id: `gid://shopify/LineItem/${i}`, title: over.title || `Collar ${i}`, quantity: qty,
    currentQuantity: over.currentQuantity ?? qty,
    variant: over.noVariant ? null : { id: `gid://shopify/ProductVariant/${i}`, sku: over.sku || `SKU-${i}`, title: over.variantTitle || 'Small / Navy' },
    discountedUnitPriceSet: money(unit), originalUnitPriceSet: money(over.list ?? unit),
    discountedTotalSet: money((unit * qty).toFixed(2)),
    discountAllocations: over.allocations || [],
  } };
}
const ADDR = { address1: '123 Main St', address2: '', city: 'Chicago', province: 'IL', zip: '60601', country: 'United States' };
function baseOrder(over = {}) {
  return {
    name: '#1001', processedAt: '2026-09-23T12:00:00Z', displayFinancialStatus: 'PENDING',
    customer: { displayName: 'Acme Pet Supply', email: 'buyer@acme.com' },
    shippingAddress: { ...ADDR }, billingAddress: { ...ADDR },
    note: '', tags: [], transactions: [], fulfillments: [],
    lineItems: { edges: [line(1, { qty: 5, unit: 18 }), line(2, { qty: 2, unit: 37.5, noVariant: true, title: 'Luxe Leash', sku: 'LL-005' })] },
    subtotalPriceSet: money('165.00'), totalShippingPriceSet: money('30.00'), totalTaxSet: money('0.00'), totalPriceSet: money('195.00'),
    ...over,
  };
}
// A db.mjs getBackorderedLinesForOrder() row.
function boRow(over = {}) {
  return {
    lineItemId: 'gid://shopify/LineItem/900', variantId: 'gid://shopify/ProductVariant/900', sku: 'EC-001-S-NV',
    title: 'Elite Collar', variantTitle: 'Small / Navy', quantity: 3, unitPrice: 18, currency: 'USD', lineTotal: 54,
    etaDate: '2026-12-01', createdAt: 1_700_000_000_000, createdBy: 'alex@fuzzywumpets.com', ...over,
  };
}

// The scenarios the "no backorders => unchanged" goldens cover: every layout branch the feature sits next to
// (single page, notes + terms, cart/line discounts, multi-page, partial-invoice opts, removed-only, company).
function scenarios() {
  const dense = Array.from({ length: 38 }, (_, i) => line(i + 1, {
    title: `Long descriptive wholesale product ${i + 1} — MED / 1.5" with a very long marketing description that wraps`,
    variantTitle: 'MED / 1.5"', sku: `SKU-LONG-${String(i + 1).padStart(3, '0')}`, unit: 12.34, qty: 1 + (i % 3),
  }));
  dense[5].node.currentQuantity = 0; // removed in an edit → skipped
  const discounted = [
    line(1, { qty: 4, unit: 22.5, list: 25, allocations: [{ allocatedAmountSet: money('10.00'), discountApplication: { targetSelection: 'EXPLICIT' } }] }),
    line(2, { qty: 3, unit: 40, allocations: [{ allocatedAmountSet: money('15.00'), discountApplication: { targetSelection: 'ALL' } }] }),
  ];
  const partialLines = dense.slice(0, 30).map(e => e.node);
  return [
    { name: 'single-page-unpaid', order: baseOrder(), opts: {} },
    { name: 'paid-note-terms-discounts', order: baseOrder({
        displayFinancialStatus: 'PAID', note: 'Ship by Friday.\nPlease call the dock before delivery.',
        lineItems: { edges: discounted },
        currentSubtotalPriceSet: money('195.00'), currentTotalPriceSet: money('215.00'), totalShippingPriceSet: money('20.00'),
      }), opts: { paymentTerms: 'Net 30' } },
    { name: 'dense-multipage-with-note', order: baseOrder({
        lineItems: { edges: dense }, note: 'Backordered items ship when available — thanks for your patience.',
        currentSubtotalPriceSet: money('1000.00'), currentTotalPriceSet: money('1035.00'), totalShippingPriceSet: money('35.00'),
      }), opts: {} },
    { name: 'partial-invoice-opts', order: baseOrder({ name: '#2002' }),
      opts: { lineItems: partialLines, invoiceSuffix: 'B', subtotal: 370.2, grossSubtotal: 400, discount: 29.8, shipping: 15, total: 385.2 } },
    { name: 'all-lines-removed', order: baseOrder({
        lineItems: { edges: [line(1, { qty: 3, currentQuantity: 0 }), line(2, { qty: 1, currentQuantity: 0 })] },
        currentSubtotalPriceSet: money('0.00'), currentTotalPriceSet: money('0.00'), totalShippingPriceSet: money('0.00'),
      }), opts: {} },
    { name: 'company-and-canada', order: baseOrder({
        customer: { company: 'Happy Paws Boutique LLC', displayName: 'Jane Smith', email: 'orders@happypaws.com' },
        shippingAddress: { company: 'Happy Paws Warehouse', address1: '456 Park Ave', address2: 'Dock 4', city: 'Toronto', province: 'ON', zip: 'M5V 2T6', country: 'Canada' },
      }), opts: {} },
  ];
}

// ── own mock server ─────────────────────────────────────────────────────────────────────────────
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
// Only what the mock server needs — no Shopify / Doppler / Xero / Google / Helcim variable is passed through,
// so this can never reach a live service, and B2B_ADMIN_MOCK=1 keeps SQLite in memory (never data/admin.db).
async function startMockServer() {
  const port = await freePort();
  const env = {};
  for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'NODE_OPTIONS']) if (process.env[k] != null) env[k] = process.env[k];
  Object.assign(env, { PORT: String(port), B2B_ADMIN_MOCK: '1',
    B2B_IMPERSONATION_SECRET: 'test-impersonation-secret-mock', SHOPIFY_WEBHOOK_SECRET: 'test-shopify-webhook-secret' });
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
async function sessionCookie(base) {
  const j = await (await fetch(`${base}/__test__/session?email=alex@fuzzywumpets.com`)).json();
  return `b2b_admin_sid=${j.sid}`;
}
const getText = async (base, cookie, p) => { const r = await fetch(base + p, { headers: { Cookie: cookie } }); return { status: r.status, text: await r.text() }; };
const getPdf = async (base, cookie, p) => {
  const r = await fetch(base + p, { headers: { Cookie: cookie } });
  return { status: r.status, type: r.headers.get('content-type'), buf: Buffer.from(await r.arrayBuffer()) };
};
const postForm = (base, cookie, p, fields) => fetch(base + p, {
  method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(), redirect: 'manual',
});
const postJson = async (base, cookie, p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual' });
  let json = null; try { json = await r.json(); } catch { /* not json */ }
  return { status: r.status, json };
};

// ── golden (re)generation ──────────────────────────────────────────────────────────────────────
if (process.env.WRITE_INVOICE_GOLDEN === '1') {
  const out = fs.existsSync(GOLDEN_PATH) ? JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) : {};
  const httpBase = process.env.INVOICE_GOLDEN_HTTP_BASE;
  if (httpBase) {            // `http` goldens: a PRISTINE mock server started from the pre-feature commit
    const cookie = await sessionCookie(httpBase);
    out.http = {};
    for (const n of ['1001', '1002']) {
      out.http[`viewer-html-${n}`] = sha((await getText(httpBase, cookie, `/orders/${n}/invoice`)).text);
      out.http[`pdf-${n}`] = pageContentHashes((await getPdf(httpBase, cookie, `/orders/${n}/invoice.pdf`)).buf);
    }
  } else {                   // `unit` goldens: this checkout's pdf.mjs — run it ONLY on the pre-feature commit
    out.unit = {};
    for (const sc of scenarios()) out.unit[sc.name] = pageContentHashes(await generateInvoicePdf(sc.order, sc.opts));
  }
  fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
  fs.writeFileSync(GOLDEN_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote ${GOLDEN_PATH} (${httpBase ? 'http' : 'unit'} part)`);
  process.exit(0);
}
const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));

// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 1. Model + wording (lib/invoice-backorder.mjs) ──');

await test('no rows (null / undefined / [] / not an array / zero or junk quantity) => null model, nothing rendered', () => {
  for (const rows of [null, undefined, [], 'x', {}, [null], [boRow({ quantity: 0 })], [boRow({ quantity: -2 })], [boRow({ quantity: 'abc' })]]) {
    assert.equal(buildInvoiceBackorderModel(rows), null, JSON.stringify(rows));
  }
  assert.equal(renderInvoiceBackorderHtml(null), '');
});

await test('the footnote wording, verbatim (customer-facing — change it on purpose, not by accident)', () => {
  const m = buildInvoiceBackorderModel([
    boRow(),
    boRow({ title: 'Luxe Leash', variantTitle: '', sku: 'LL-005', quantity: 1, unitPrice: 37.5, lineTotal: 37.5, etaDate: null }),
  ]);
  assert.equal(m.footnote.heading, '* Backordered items');
  assert.equal(m.footnote.headingContinued, '* Backordered items (continued)');
  assert.equal(m.footnote.intro, "These items are currently backordered and are not included in this invoice's total.");
  assert.equal(m.tag, 'Backordered *');
  assert.deepEqual(m.footnote.items, [
    { primary: 'Elite Collar — Small / Navy', detail: 'SKU EC-001-S-NV · Qty 3' },
    { primary: 'Luxe Leash', detail: 'SKU LL-005 · Qty 1' },
  ]);
});

await test('the wording constants are exactly what the model carries (one source of truth)', () => {
  const m = buildInvoiceBackorderModel([boRow()]);
  assert.equal(m.tag, BACKORDER_TAG);
  assert.equal(m.mark, BACKORDER_MARK);
  assert.equal(m.footnote.heading, BACKORDER_HEADING);
  assert.equal(m.footnote.headingContinued, BACKORDER_HEADING_CONTINUED);
  assert.equal(m.footnote.intro, BACKORDER_INTRO);
});

await test('wording lives ONLY in lib/invoice-backorder.mjs — pdf.mjs and server.mjs hold no copy of it', () => {
  const owners = ['pdf.mjs', 'server.mjs'].map(f => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]);
  for (const phrase of ['currently backordered', 'not included in this invoice', 'Backordered *', '* Backordered items', '(continued)']) {
    for (const [f, src] of owners) {
      // server.mjs/pdf.mjs may MENTION a phrase in a comment; they must not build a string literal out of it.
      const literal = new RegExp(`['"\`][^'"\`\\n]*${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^'"\`\\n]*['"\`]`);
      const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
      assert.ok(!literal.test(code), `${f} must not carry its own copy of: ${phrase}`);
    }
  }
});

await test('customer wording is factual: no promise of billing, shipping dates or follow-up', () => {
  const m = buildInvoiceBackorderModel([boRow(), boRow({ etaDate: null })]);
  const all = [m.tag, m.footnote.heading, m.footnote.headingContinued, m.footnote.intro, ...m.footnote.items.flatMap(i => [i.primary, i.detail])].join(' | ');
  assert.match(all, /currently backordered/);
  assert.match(all, /not included in this invoice's total/);
  assert.doesNotMatch(all, /\b(will|shall|going to|guarantee|promise|soon|separately|later|follow[- ]?up|invoiced|billed|charged)\b/i, all);
  assert.doesNotMatch(all, /\b(hotfix|snapshot|removed|shopify|pending|status|internal)\b/i, 'no internal jargon');
});

// Owner decision: the expected ship date is NOT printed on the invoice. The data still carries it
// (backorders.eta_date, shown on the internal /backorders queue); the invoice model must ignore it entirely.
// SYNC: ETA_WORDING is the phrase list every "no ETA anywhere" assertion in this file reuses (model, HTML, PDF,
// viewer, browser). It is phrases only: a whole PDF legitimately contains other dates (invoice date), so the
// date-shaped check (noEtaDate) is applied only where the exact ETA values used by a test are known.
const ETA_WORDING = /expected\s+ship|ship\s+date|\beta\b|not yet available/i;
const noEta = (s, where) => assert.doesNotMatch(String(s), ETA_WORDING, `${where}: expected-ship-date wording leaked onto the invoice`);
const noEtaDate = (s, where, dates) => {
  for (const d of dates) assert.ok(!String(s).includes(d), `${where}: ETA value ${JSON.stringify(d)} leaked onto the invoice`);
};

await test('no ship date on the invoice: rows may carry an etaDate (valid, null or junk) and the model ignores it', () => {
  const rows = [boRow({ etaDate: '2026-12-01' }), boRow({ etaDate: null }), boRow({ etaDate: 'nonsense' }), boRow({ etaDate: undefined }), boRow({ etaDate: '2027-01-15' })];
  const m = buildInvoiceBackorderModel(rows);
  assert.equal(m.lines.length, 5);
  for (const l of m.lines) {
    assert.ok(!('etaDate' in l) && !('etaLabel' in l), `line leaks an eta field: ${Object.keys(l)}`);
  }
  // Same row with / without an ETA => identical model (nothing about the ETA reaches the display).
  assert.deepEqual(buildInvoiceBackorderModel([boRow({ etaDate: '2026-12-01' })]), buildInvoiceBackorderModel([boRow({ etaDate: null })]));
  // The footnote detail is just SKU and quantity.
  assert.deepEqual(m.footnote.items.map(i => i.detail), Array(5).fill('SKU EC-001-S-NV · Qty 3'));
  const ETA_VALUES = ['2026-12-01', 'Dec 1, 2026', '2027-01-15', 'Jan 15, 2027', 'nonsense'];
  noEta(JSON.stringify(m), 'model');
  noEtaDate(JSON.stringify(m), 'model', ETA_VALUES);
  const html = renderInvoiceBackorderHtml(m);
  noEta(html, 'html');
  noEtaDate(html, 'html', ETA_VALUES);
});

await test('every character of the customer wording exists in the embedded invoice fonts (no "NO GLYPH" boxes)', () => {
  const m = buildInvoiceBackorderModel([boRow(), boRow({ etaDate: null })]);
  const text = [m.tag, m.footnote.heading, m.footnote.headingContinued, m.footnote.intro, '•', ...m.footnote.items.flatMap(i => [i.primary, i.detail])].join('');
  for (const f of ['Inter-Regular', 'Inter-SemiBold', 'Inter-Bold']) {
    const font = fontkit.openSync(path.join(ROOT, 'assets/fonts', `${f}.ttf`));
    for (const ch of new Set(text)) assert.ok(font.hasGlyphForCodePoint(ch.codePointAt(0)), `${f} has no glyph for ${JSON.stringify(ch)} (U+${ch.codePointAt(0).toString(16)})`);
  }
  // The dagger the owner asked for is NOT in Inter (it printed as a "NO GLYPH" box) — hence '*'. If a font
  // upgrade ever adds it, switching BACKORDER_MARK back is a one-line change in lib/invoice-backorder.mjs.
  const inter = fontkit.openSync(path.join(ROOT, 'assets/fonts/Inter-Regular.ttf'));
  assert.equal(inter.hasGlyphForCodePoint(0x2020), false, 'Inter now has U+2020 — the dagger could be used again');
  assert.equal(BACKORDER_MARK, '*');
});

await test('rows are normalised: Default Title dropped, whitespace collapsed, variant baked into the title stripped, order kept', () => {
  const m = buildOrderInvoiceBackorderModel([
    boRow({ title: 'Luxe Limited Slip Collar - Booth — XXS / 1/2"', variantTitle: 'XXS / 1/2"', sku: ' LL-1 ' }),
    boRow({ title: '  Plain\n  Leash  ', variantTitle: 'Default Title', sku: '' }),
  ]);
  assert.equal(m.lines[0].title, 'Luxe Limited Slip Collar - Booth');
  assert.equal(m.lines[0].variantTitle, 'XXS / 1/2"');
  assert.equal(m.lines[0].sku, 'LL-1');
  assert.equal(m.lines[1].title, 'Plain Leash');
  assert.equal(m.lines[1].variantTitle, '');
  assert.deepEqual(m.footnote.items.map(i => i.primary), ['Luxe Limited Slip Collar - Booth — XXS / 1/2"', 'Plain Leash']);
  assert.equal(m.footnote.items[1].detail, 'Qty 3', 'no SKU => no "SKU" fragment');
});

await test('amounts are formatted per currency and fall back safely', () => {
  assert.equal(formatBackorderMoney(1234.5), '$1,234.50');
  assert.equal(formatBackorderMoney('x'), '$0.00');
  assert.equal(formatBackorderMoney(5, 'not-a-currency'), '$5.00');
  assert.match(formatBackorderMoney(5, 'EUR'), /€/);
  const m = buildInvoiceBackorderModel([boRow({ unitPrice: 11, lineTotal: undefined, quantity: 10 })]);
  assert.equal(m.lines[0].lineTotal, 110);
  assert.equal(m.lines[0].lineTotalLabel, '$110.00');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 2. On-screen block (renderInvoiceBackorderHtml) ──');

await test('HTML: struck description / qty / unit price / line total, tag, footnote, itemised entries', () => {
  const m = buildInvoiceBackorderModel([boRow(), boRow({ title: 'Luxe Leash', variantTitle: '', sku: 'LL-005', quantity: 1, unitPrice: 37.5, lineTotal: 37.5, etaDate: null })]);
  const html = renderInvoiceBackorderHtml(m);
  assert.equal((html.match(/<s class="inv-bo-title">/g) || []).length, 2, 'two struck titles');
  assert.equal((html.match(/<s class="inv-bo-var">/g) || []).length, 1, 'variant only when present');
  for (const v of ['<s>3</s>', '<s>$18.00</s>', '<s>$54.00</s>', '<s>1</s>', '<s>$37.50</s>']) assert.ok(html.includes(v), v);
  assert.equal((html.match(new RegExp(BACKORDER_TAG.replace('*', '\\*'), 'g')) || []).length, 2, 'tag on each line');
  assert.ok(html.includes('>* Backordered items<'));
  assert.ok(html.includes(BACKORDER_INTRO.replace("'", '&#x27;')), 'intro sentence (apostrophe escaped in markup)');
  assert.ok(html.includes('Elite Collar — Small / Navy') && html.includes('SKU EC-001-S-NV · Qty 3<'), 'detail is SKU + Qty and nothing after it');
  assert.ok(html.includes('SKU LL-005 · Qty 1<'));
  assert.ok(!html.includes('·&nbsp;') && !html.includes('Qty 3 ·') && !html.includes('Qty 1 ·'), 'no dangling separator after Qty');
  noEta(html, 'html');
});

await test('HTML: every dynamic value is escaped', () => {
  const m = buildInvoiceBackorderModel([boRow({ title: '<script>alert(1)</script>', variantTitle: '"><img src=x onerror=1>', sku: "'; DROP--" })]);
  const html = renderInvoiceBackorderHtml(m);
  assert.ok(!html.includes('<script>') && !html.includes('<img'), html);
  assert.ok(html.includes('&lt;script&gt;'));
});

await test('HTML css keeps the legibility guards (wrap, no sideways growth, AA grey, visible strike)', () => {
  for (const token of ['flex-wrap:wrap', 'overflow-wrap:anywhere', 'min-width:0', 'text-decoration:line-through', '#757575']) {
    assert.ok(INVOICE_BACKORDER_CSS.includes(token), token);
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 3. No backordered lines => the invoice is unchanged (goldens generated at commit 89a9d55) ──');

for (const sc of scenarios()) {
  await test(`PDF page content identical to the pre-feature output: ${sc.name}`, async () => {
    const expected = golden.unit[sc.name];
    assert.ok(Array.isArray(expected) && expected.length, `no golden for ${sc.name}`);
    for (const [label, extra] of [['option absent', {}], ['[]', { backorderedLines: [] }], ['null', { backorderedLines: null }],
      ['undefined', { backorderedLines: undefined }], ['rows with no quantity', { backorderedLines: [boRow({ quantity: 0 })] }]]) {
      const got = pageContentHashes(await generateInvoicePdf(sc.order, { ...sc.opts, ...extra }));
      assert.deepEqual(got, expected, `${sc.name}: drifted when backorderedLines is ${label}`);
    }
  });
}

await test('the same rows DO change the order invoice (the goldens are not vacuous)', async () => {
  const sc = scenarios()[0];
  const got = pageContentHashes(await generateInvoicePdf(sc.order, { ...sc.opts, backorderedLines: [boRow()] }));
  assert.notDeepEqual(got, golden.unit[sc.name]);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 4. PDF layout: struck rows, totals, footnote, pagination ──');

// Renders with a spy on pdfkit's text()/addPage() so each draw call's options (strike!, width, align) and page
// are visible, and ALSO reads the finished PDF back (extractPdfText) so geometry is judged on the real artifact.
async function render(order, opts) {
  const calls = []; let page = 0;
  const { addPage, text } = PDFDocument.prototype;
  PDFDocument.prototype.addPage = function (...a) { page++; return addPage.apply(this, a); };
  PDFDocument.prototype.text = function (str, x, y, o) {
    const s = String(str);
    const opt = (o && typeof o === 'object') ? o : {};
    if (typeof x === 'number' && typeof y === 'number') {
      calls.push({ page, text: s, x, y, w: opt.width ?? null, strike: !!opt.strike, align: opt.align || null,
        textWidth: this.widthOfString(s), size: this._fontSize, oneLine: opt.lineBreak === false });
    }
    return text.apply(this, arguments);
  };
  let pdf;
  try { pdf = await generateInvoicePdf(order, opts); }
  finally { PDFDocument.prototype.addPage = addPage; PDFDocument.prototype.text = text; }
  return { pdf, calls, runs: extractPdfText(pdf) };
}
const AMOUNT_RUNS = (runs) => runs.filter(r => r.size >= 10 && /^-?\$/.test(r.text)).map(r => `${r.page}:${r.text}`);

// Geometry/invariants for a render that HAS a footnote. Returns the footnote runs for further checks.
function assertFootnoteLayout({ runs }, model) {
  const totalIdx = runs.findLastIndex(r => r.text === 'TOTAL' && r.size === 13);
  const footerIdx = runs.findIndex(r => r.text.startsWith('Thank you for your business'));
  const headIdx = runs.findIndex(r => r.text === BACKORDER_HEADING);
  assert.ok(totalIdx >= 0 && footerIdx > totalIdx, 'TOTAL row and page footer present');
  assert.ok(headIdx > totalIdx && headIdx < footerIdx, 'footnote heading is drawn after the totals and before the footer');
  const total = runs[totalIdx], footer = runs[footerIdx], head = runs[headIdx];
  assert.ok(head.page > total.page || head.y > total.y + 8, `footnote (y=${head.y}) overlaps the totals block (y=${total.y})`);
  // (continuation pages also carry the "INVOICE #… - CONTINUED" page header — chrome, not footnote)
  const foot = runs.slice(headIdx, footerIdx).filter(r => !(r.text.startsWith('INVOICE #') && r.y < 40));
  for (const r of foot) {
    assert.ok(r.y + r.size * 0.25 <= 702, `footnote run "${r.text.slice(0, 30)}" reaches y=${r.y} (limit 702)`);
    assert.ok(r.y >= 60, `footnote run "${r.text.slice(0, 30)}" sits in the page header zone (y=${r.y})`);
    if (r.page === footer.page) assert.ok(r.y + 6 < footer.y - 8, `footnote overlaps the page footer on page ${r.page}`);
  }
  // runs in the same column never collide vertically
  const byCol = new Map();
  for (const r of foot) { const k = `${r.page}:${r.x}`; byCol.set(k, [...(byCol.get(k) || []), r.y]); }
  for (const [k, ys] of byCol) for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= 8, `column ${k}: lines ${ys[i - 1]} and ${ys[i]} collide`);
  // every itemised entry made it onto the page, once, in order
  const bullets = foot.filter(r => r.text === '•');
  assert.equal(bullets.length, model.lines.length, 'one bullet per backordered variant');
  const joined = foot.map(r => r.text).join(' ');
  let from = 0;
  for (const it of model.footnote.items) {
    const at = joined.indexOf(it.detail.slice(0, 24), from);
    assert.ok(at >= 0, `footnote entry missing/out of order: ${it.primary}`);
    from = at;
  }
  return foot;
}

await test('struck rows: grey + line-through on description / qty / unit price / line total; tag is not struck', async () => {
  const rows = [boRow(), boRow({ title: 'Simplicity Collar', variantTitle: 'Medium / Red', sku: 'SC-002-M-RD', quantity: 10, unitPrice: 11, lineTotal: 110, etaDate: null })];
  const { calls } = await render(baseOrder(), { backorderedLines: rows });
  const struck = calls.filter(c => c.strike).map(c => c.text);
  assert.deepEqual(struck, ['Elite Collar', 'Small / Navy', '3', '$18.00', '$54.00', 'Simplicity Collar', 'Medium / Red', '10', '$11.00', '$110.00']);
  const tags = calls.filter(c => c.text === BACKORDER_TAG);
  assert.equal(tags.length, 2); assert.ok(tags.every(t => !t.strike), 'the tag stays un-struck and legible');
  assert.ok(!calls.some(c => c.strike && c.text === 'EC-001-S-NV'), 'SKU is muted, not struck (owner spec lists description/qty/unit/total)');
  // active rows are never struck
  assert.ok(!calls.some(c => c.strike && /^(Collar 1|Luxe Leash|SKU-1|LL-005)$/.test(c.text)));
});

await test('struck rows come AFTER every active row and BEFORE the totals', async () => {
  const { runs } = await render(baseOrder(), { backorderedLines: [boRow(), boRow({ title: 'Z' })] });
  const idx = (t) => runs.findIndex(r => r.text === t);
  const luxe = idx('Luxe Leash'), tagFirst = idx(BACKORDER_TAG), sub = idx('Subtotal');
  assert.ok(luxe >= 0 && tagFirst > luxe && sub > tagFirst, JSON.stringify({ luxe, tagFirst, sub }));
  const y = (t) => runs[idx(t)].y;
  assert.ok(y(BACKORDER_TAG) > y('Luxe Leash') && y('Subtotal') > y(BACKORDER_TAG));
});

await test('TOTALS ARE UNTOUCHED: subtotal / shipping / total print identically with and without backordered rows', async () => {
  for (const sc of scenarios().filter(s => s.name !== 'partial-invoice-opts')) {
    const without = await render(sc.order, sc.opts);
    const withRows = await render(sc.order, { ...sc.opts, backorderedLines: [boRow({ unitPrice: 999.99, lineTotal: 2999.97, quantity: 3 }), boRow({ title: 'Other', unitPrice: 1, lineTotal: 1, quantity: 1 })] });
    const a = AMOUNT_RUNS(without.runs).map(s => s.split(':')[1]);
    const b = AMOUNT_RUNS(withRows.runs).map(s => s.split(':')[1]);
    assert.deepEqual(b, a, `${sc.name}: totals changed when backordered rows were added`);
    assert.ok(!b.includes('$2,999.97') && !b.includes('$999.99'), 'a struck amount leaked into the totals area');
  }
});

await test('totals come from the Shopify order, not recomputed from lines: a deliberately inconsistent order prints ITS aggregates', async () => {
  const order = baseOrder({ currentSubtotalPriceSet: money('123.45'), currentTotalPriceSet: money('150.00'), totalShippingPriceSet: money('26.55') });
  const { runs } = await render(order, { backorderedLines: [boRow()] });
  const amounts = AMOUNT_RUNS(runs).map(s => s.split(':')[1]);
  assert.deepEqual(amounts, ['$123.45', '$26.55', '$150.00']);
});

await test('footnote: one sentence + one entry per backordered variant, below the totals, clear of the footer', async () => {
  const rows = [boRow(), boRow({ title: 'Luxe Leash', variantTitle: '', sku: 'LL-005', quantity: 1, unitPrice: 37.5, lineTotal: 37.5, etaDate: null })];
  const model = buildOrderInvoiceBackorderModel(rows);
  const r = await render(baseOrder(), { backorderedLines: rows });
  const foot = assertFootnoteLayout(r, model);
  assert.deepEqual(foot.slice(0, 2).map(x => x.text), [BACKORDER_HEADING, BACKORDER_INTRO]);
  const text = foot.map(x => x.text).join('\n');
  assert.ok(text.includes('SKU EC-001-S-NV · Qty 3'));
  assert.ok(text.includes('SKU LL-005 · Qty 1'));
  // The row carries etaDate '2026-12-01' — it must not be drawn anywhere on the page.
  assert.deepEqual(foot.filter(x => /^(SKU|Qty)/.test(x.text)).map(x => x.text), ['SKU EC-001-S-NV · Qty 3', 'SKU LL-005 · Qty 1']);
  noEta(r.runs.map(x => x.text).join('\n'), 'pdf');
  noEtaDate(r.runs.map(x => x.text).join('\n'), 'pdf', ['2026-12-01', 'Dec 1, 2026']);
});

await test('footnote starts below notes / payment terms, never on top of them', async () => {
  const rows = [boRow()];
  const order = baseOrder({ note: 'Ship by Friday.\nCall the dock first.\nGate code 4821.' });
  const r = await render(order, { paymentTerms: 'Net 30', backorderedLines: rows });
  assertFootnoteLayout(r, buildOrderInvoiceBackorderModel(rows));
  const lastNote = r.runs.findLast(x => x.text === 'Gate code 4821.');
  const head = r.runs.find(x => x.text === BACKORDER_HEADING);
  assert.ok(lastNote && head && (head.page > lastNote.page || head.y > lastNote.y + 10), `footnote y=${head.y} vs last note line y=${lastNote?.y}`);
});

await test('long titles / variants / SKUs / amounts wrap or clip INSIDE their columns (struck rows)', async () => {
  const rows = [
    boRow({
      title: 'Luxe Limited Slip Collar - Booth with an extremely long descriptive wholesale product title that keeps going and going well past four lines of text in the narrow item column of the invoice table',
      variantTitle: 'XXS / 1/2" with an equally long variant description that wraps over multiple lines in the column and then some more words here to clip',
      sku: 'CRSWLK0533258XS8-EXTRA-LONG-SKU-VALUE-0001', quantity: 1234, unitPrice: 1234.5, lineTotal: 1523373,
    }),
    boRow({ title: 'SUPERCALIFRAGILISTICEXPIALIDOCIOUS_WHOLESALE_COLLAR_ASSORTMENT_PACK_OF_TWELVE_UNITS_EXTRA', variantTitle: '', sku: '', quantity: 2, unitPrice: 5, lineTotal: 10 }),
  ];
  const r = await render(baseOrder(), { backorderedLines: rows });
  const struckCalls = r.calls.filter(c => c.strike || c.text === BACKORDER_TAG || /^CRSWLK/.test(c.text) || /…$/.test(c.text));
  for (const c of r.calls.filter(c => c.oneLine && c.w && (c.strike || /^CRSWLK/.test(c.text)))) {
    assert.ok(c.textWidth <= c.w + 0.5, `"${c.text}" is ${c.textWidth.toFixed(1)}pt in a ${c.w}pt column`);
  }
  assert.ok(struckCalls.length > 0);
  // the title is clipped to 4 lines, the variant to 3: count the rendered lines of the FIRST struck row
  // (everything drawn in the item column between the last active row and its own tag)
  const lux = r.runs.findIndex(x => x.text === 'Luxe Leash');
  const tag1 = r.runs.findIndex(x => x.text === BACKORDER_TAG);
  const rowRuns = r.runs.slice(lux + 1, tag1).filter(x => x.x === 56);
  const titleLines = rowRuns.filter(x => x.size === 9.5).length, variantLines = rowRuns.filter(x => x.size === 8).length;
  assert.ok(titleLines >= 2 && titleLines <= 4, `title lines ${titleLines} (wrap, clip at 4)`);
  assert.ok(variantLines >= 2 && variantLines <= 3, `variant lines ${variantLines} (wrap, clip at 3)`);
  assert.ok(r.runs.some(x => /…$/.test(x.text)), 'an over-long block is ellipsised, not silently dropped');
  assert.ok(r.runs.every(x => x.x >= 49 && x.x <= 562), 'nothing starts outside the page margins');
  // no two consecutive struck rows overlap: a row's tag sits above the next row's first line
  const tags = r.runs.filter(x => x.text === BACKORDER_TAG);
  const nextTitleY = r.runs.find(x => x.text.startsWith('SUPERCALIFRAGILISTIC'))?.y;
  assert.ok(tags.length === 2 && nextTitleY > tags[0].y, 'second row starts below the first row tag');
  assertFootnoteLayout(r, buildOrderInvoiceBackorderModel(rows));
});

await test('multi-page order: struck rows and footnote paginate with the table, footnote never on the page footer', async () => {
  const sc = scenarios().find(s => s.name === 'dense-multipage-with-note');
  const rows = [boRow(), boRow({ title: 'Everyday Collar', variantTitle: 'Large / Black', sku: 'EC-003-L-BK', quantity: 5, unitPrice: 30, lineTotal: 150, etaDate: '2026-11-20' }), boRow({ title: 'Leash Set', variantTitle: '', sku: 'LS-007', quantity: 1, unitPrice: 45, lineTotal: 45, etaDate: null })];
  const r = await render(sc.order, { ...sc.opts, backorderedLines: rows });
  assertFootnoteLayout(r, buildOrderInvoiceBackorderModel(rows));
  assert.ok(Math.max(...r.runs.map(x => x.page)) >= 3, 'the order spans pages');
  // struck rows keep the table header on every continuation page they land on
  const tagPages = [...new Set(r.runs.filter(x => x.text === BACKORDER_TAG).map(x => x.page))];
  for (const pg of tagPages) assert.ok(pg === 1 || r.runs.some(x => x.page === pg && x.text === 'UNIT PRICE'), `page ${pg} lost the table header`);
  for (const x of r.runs.filter(x => x.text === BACKORDER_TAG)) assert.ok(x.y + 3 <= 700, `tag at y=${x.y}`);
});

await test('MANY backordered lines: rows and footnote spill across pages, each entry exactly once, "(continued)" heading used', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => boRow({
    title: `Backordered wholesale item number ${i + 1}`, variantTitle: `Size ${i % 5} / Color ${i % 3}`, sku: `BO-SKU-${i + 1}`,
    quantity: i + 1, unitPrice: 9.99, lineTotal: Math.round((i + 1) * 999) / 100, etaDate: i % 2 ? `2026-12-${String(1 + (i % 28)).padStart(2, '0')}` : null,
  }));
  const model = buildOrderInvoiceBackorderModel(rows);
  const r = await render(baseOrder({ displayFinancialStatus: 'PAID' }), { paymentTerms: 'Net 30', backorderedLines: rows });
  const foot = assertFootnoteLayout(r, model);
  assert.equal(r.runs.filter(x => x.text === BACKORDER_TAG).length, 30, 'a struck row per unit of backordered line');
  assert.ok(foot.some(x => x.text === BACKORDER_HEADING_CONTINUED), 'footnote continues onto a further page under a (continued) heading');
  assert.ok(new Set(foot.map(x => x.page)).size >= 2, 'footnote spans pages');
  for (let i = 1; i <= 30; i++) {
    assert.equal(foot.filter(x => x.text === `Backordered wholesale item number ${i} — Size ${(i - 1) % 5} / Color ${(i - 1) % 3}`).length, 1, `entry ${i} appears exactly once`);
  }
  const pages = Math.max(...r.runs.map(x => x.page));
  assert.ok(r.runs.filter(x => x.text.startsWith('Thank you for your business')).every(x => x.page === pages), 'footer only on the last page (as before)');
});

await test('SWEEP: footnote never overlaps totals / notes / footer wherever the page break falls (1..20 active lines)', async () => {
  const rows = [boRow(), boRow({ title: 'Everyday Collar', variantTitle: 'Large / Black', sku: 'EC-003-L-BK', quantity: 5, unitPrice: 30, lineTotal: 150 }), boRow({ title: 'Leash Set', variantTitle: '', sku: 'LS-007', quantity: 1, unitPrice: 45, lineTotal: 45, etaDate: null })];
  const model = buildOrderInvoiceBackorderModel(rows);
  for (let n = 1; n <= 20; n++) {
    for (const [terms, note] of [[true, 'Net 30 account.\nPlease call before delivery.'], [false, '']]) {
      if (!terms && n % 3 !== 1) continue;
      const lines = Array.from({ length: n }, (_, i) => line(i + 1, { title: `Wholesale product ${i + 1} with a moderately long marketing description`, unit: 10 + i, qty: 1 + (i % 4) }));
      const order = baseOrder({ lineItems: { edges: lines }, note });
      const opts = terms ? { paymentTerms: 'Net 30' } : {};
      const r = await render(order, { ...opts, backorderedLines: rows });
      try { assertFootnoteLayout(r, model); }
      catch (e) { e.message = `[${n} active lines, terms=${terms}] ${e.message}`; throw e; }
      const without = await render(order, opts);
      assert.deepEqual(AMOUNT_RUNS(r.runs).map(s => s.split(':')[1]), AMOUNT_RUNS(without.runs).map(s => s.split(':')[1]), `[${n}] totals drifted`);
    }
  }
});

await test('partial-invoice PDFs (opts.lineItems) are out of scope: only the order-invoice routes pass backorderedLines', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  const calls = [...src.matchAll(/generateInvoicePdf\(order(?:,\s*\{([\s\S]*?)\})?\)/g)];
  const withBackorder = calls.filter(c => /backorderedLines/.test(c[1] || ''));
  assert.equal(withBackorder.length, 1, 'exactly one generateInvoicePdf call passes backorderedLines (GET /orders/:id/invoice.pdf)');
  assert.ok(calls.length >= 3, 'the partial-invoice call sites exist');
  assert.ok(!/getInvoiceBackorderedRows|orderInvoiceBackorderedLines/.test(src.slice(src.indexOf("app.post('/orders/:id/partial-invoice'"), src.indexOf("app.get('/api/admin/orders/:id/partial-invoices'"))),
    'partial-invoice POST/GET handlers must not read backordered rows');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 5. Real flow over HTTP (own mock server): POST /orders/1001/backorder → invoice.pdf / invoice ──');

const server = await startMockServer();
process.on('exit', () => { try { server.child.kill(); } catch { /* already gone */ } });   // never leave it running if the suite dies
console.log(`  (mock server ${server.base})`);
const cookie = await sessionCookie(server.base);

await test('BEFORE any backorder: viewer HTML and invoice.pdf of #1001 / #1002 equal the pre-feature goldens', async () => {
  for (const n of ['1001', '1002']) {
    const html = await getText(server.base, cookie, `/orders/${n}/invoice`);
    assert.equal(html.status, 200);
    assert.equal(sha(html.text), golden.http[`viewer-html-${n}`], `#${n} viewer HTML drifted from the pre-feature page`);
    assert.ok(!html.text.includes('inv-bo'), 'no backordered block / css without backordered lines');
    const pdf = await getPdf(server.base, cookie, `/orders/${n}/invoice.pdf`);
    assert.equal(pdf.status, 200); assert.equal(pdf.type, 'application/pdf');
    assert.deepEqual(pageContentHashes(pdf.buf), golden.http[`pdf-${n}`], `#${n} invoice.pdf drifted from the pre-feature PDF`);
  }
});

const boFlag = (fields) => postForm(server.base, cookie, '/orders/1001/backorder', fields);
const boUndo = (liId) => postForm(server.base, cookie, '/orders/1001/backorder/undo', { lineItemId: liId });
const loc = (res) => res.headers.get('location') || '';

await test('flag 2 of 5 Elite Collars (through the real flow): invoice.pdf keeps them struck + footnote, totals stay the order\'s', async () => {
  const res = await boFlag({ lineItemId: 'li1', quantity: '2', eta: '2026-12-01' });
  assert.equal(res.status, 302); assert.ok(loc(res).includes('success=backorder_flagged'), loc(res));
  const pdf = await getPdf(server.base, cookie, '/orders/1001/invoice.pdf');
  assert.equal(pdf.status, 200); assert.equal(pdf.buf.subarray(0, 5).toString(), '%PDF-');
  if (process.env.INVOICE_SHOT_DIR) { fs.mkdirSync(process.env.INVOICE_SHOT_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.INVOICE_SHOT_DIR, 'invoice-1001-http-backordered.pdf'), pdf.buf); }
  const runs = extractPdfText(pdf.buf);
  const texts = runs.map(r => r.text);
  // active line is now 3 units; the 2 removed units appear struck below it
  const rowOf = (t, from = 0) => runs.findIndex((r, i) => i >= from && r.text === t);
  const elite = rowOf('Elite Collar'), eliteStruck = rowOf('Elite Collar', elite + 1);
  assert.ok(elite >= 0 && eliteStruck > elite, 'the active row and the struck row are both on the invoice');
  assert.deepEqual(runs.slice(elite, elite + 6).filter(r => r.size === 9.5).map(r => r.text), ['Elite Collar', '3', '$18.00', '$54.00']);
  assert.deepEqual(runs.slice(eliteStruck, eliteStruck + 7).filter(r => r.size === 9.5).map(r => r.text), ['Elite Collar', '2', '$18.00', '$36.00']);
  assert.equal(texts.filter(t => t === BACKORDER_TAG).length, 1);
  // totals = the order's current aggregates (3x18 + 2x37.50 = 129 + 30 shipping), NOT plus the struck 36.00
  assert.deepEqual(AMOUNT_RUNS(runs).map(s => s.split(':')[1]), ['$129.00', '$30.00', '$159.00']);
  assert.ok(texts.includes(BACKORDER_HEADING) && texts.includes(BACKORDER_INTRO));
  assert.ok(texts.includes('SKU EC-001-S-NV · Qty 2'), texts.filter(t => /^SKU/.test(t)).join(' / '));
  // The flow stored eta=2026-12-01 (the internal /backorders queue still shows it); the invoice must not.
  noEta(texts.join('\n'), 'invoice.pdf');
  noEtaDate(texts.join('\n'), 'invoice.pdf', ['2026-12-01', 'Dec 1, 2026']);
  assertFootnoteLayout({ runs }, buildOrderInvoiceBackorderModel([boRow({ quantity: 2, unitPrice: 18, lineTotal: 36 })]));
});

await test('the invoice viewer page carries the same block as real HTML text (not for ?letter= partial views)', async () => {
  const page = await getText(server.base, cookie, '/orders/1001/invoice');
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('id="invoice-backorders"'));
  assert.ok(page.text.includes('<s class="inv-bo-title">Elite Collar</s>'));
  assert.ok(page.text.includes('<s>$36.00</s>') && page.text.includes('<s>2</s>'));
  assert.ok(page.text.includes('SKU EC-001-S-NV · Qty 2<'), 'detail is SKU + Qty and nothing after it');
  noEta(page.text, 'invoice viewer');
  noEtaDate(page.text, 'invoice viewer', ['2026-12-01', 'Dec 1, 2026']);
  assert.ok(page.text.includes(BACKORDER_INTRO.replace("'", '&#x27;')));
  assert.ok(page.text.includes('<style>') && page.text.includes('.inv-bo'));
  const partial = await getText(server.base, cookie, '/orders/1001/invoice?letter=A');
  assert.ok(!partial.text.includes('inv-bo'), 'partial-invoice viewer is untouched');
  assert.ok(page.text.includes('/orders/1001/invoice.pdf?download=1'), 'download link still points at the attachment route');
});

await test('both invoice routes still require auth', async () => {
  for (const p of ['/orders/1001/invoice', '/orders/1001/invoice.pdf']) {
    const r = await fetch(server.base + p, { redirect: 'manual' });
    assert.equal(r.status, 302, p); assert.ok((r.headers.get('location') || '').includes('/login'), p);
  }
});

await test('OUT OF SCOPE stays as it was: invoice.csv and a partial-invoice snapshot do not list backordered lines', async () => {
  const csv = await getText(server.base, cookie, '/orders/1001/invoice.csv');
  assert.equal(csv.status, 200);
  assert.equal(csv.text.trim().split(/\r?\n/).length, 3, 'CSV: header + the 2 active lines only');
  assert.ok(!/backorder/i.test(csv.text));
  const made = await postForm(server.base, cookie, '/orders/1001/partial-invoice', { type: 'full' });
  assert.equal(made.status, 302);
  const letter = /letter=([A-Z])/.exec(loc(made))?.[1];
  assert.ok(letter, loc(made));
  const snap = await getPdf(server.base, cookie, `/orders/1001/partial-invoice/${letter}.pdf`);
  assert.equal(snap.status, 200);
  const texts = extractPdfText(snap.buf).map(r => r.text);
  assert.ok(!texts.includes(BACKORDER_TAG) && !texts.includes(BACKORDER_HEADING), 'partial-invoice PDF is unchanged (no backordered section)');
});

await test('UNDO: the struck rows and footnote disappear and the line is back to 5 units', async () => {
  const res = await boUndo('li1');
  assert.ok(loc(res).includes('success=backorder_restored'), loc(res));
  const runs = extractPdfText((await getPdf(server.base, cookie, '/orders/1001/invoice.pdf')).buf);
  assert.ok(!runs.some(r => r.text === BACKORDER_TAG || r.text === BACKORDER_HEADING));
  const elite = runs.findIndex(r => r.text === 'Elite Collar');
  assert.deepEqual(runs.slice(elite, elite + 6).filter(r => r.size === 9.5).map(r => r.text), ['Elite Collar', '5', '$18.00', '$90.00']);
  const page = await getText(server.base, cookie, '/orders/1001/invoice');
  assert.ok(!page.text.includes('inv-bo'));
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 6. On screen (Playwright, 390 / 768 / 1280): the invoice viewer with long backordered lines ──');

await test('no horizontal overflow, long text wraps, strike-through visible, footnote readable at 390 / 768 / 1280', async () => {
  const LONG = 'Luxe Limited Slip Collar - Booth with an extremely long descriptive wholesale product title that keeps going and going';
  const LONG_VAR = 'XXS / 1/2" with an equally long variant description that wraps over multiple lines';
  const LONG_SKU = 'CRSWLK0533258XS8-EXTRA-LONG-SKU-VALUE-0001-WITH-NO-BREAKS-ANYWHERE';
  // Real flow: add a probe line (like test/api.test.mjs boProbe), then backorder it fully / partly.
  const add = (title, qty, variantId, sku) => postJson(server.base, cookie, '/orders/1001/line/add',
    { idemKey: crypto.randomUUID(), variantId, title, sku, qty, listPrice: 28, price: 14 });
  const a = await add(LONG, 4, '350', LONG_SKU); assert.equal(a.status, 200, JSON.stringify(a.json));
  const b = await add('Second probe item', 6, '351', 'BO-PROBE-2'); assert.equal(b.status, 200);
  assert.ok(loc(await boFlag({ lineItemId: a.json.line.liId, quantity: '4', eta: '2027-01-15' })).includes('success=backorder_flagged'));
  assert.ok(loc(await boFlag({ lineItemId: b.json.line.liId, quantity: '2' })).includes('success=backorder_flagged'));
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [390, 768, 1280]) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 } });
      await ctx.addCookies([{ name: 'b2b_admin_sid', value: cookie.split('=')[1], domain: '127.0.0.1', path: '/' }]);
      const pg = await ctx.newPage();
      await pg.goto(`${server.base}/orders/1001/invoice`, { waitUntil: 'domcontentloaded' });
      await pg.locator('#invoice-backorders').scrollIntoViewIfNeeded();
      const m = await pg.evaluate(() => {
        const sec = document.querySelector('#invoice-backorders');
        const r = sec.getBoundingClientRect();
        const struck = [...sec.querySelectorAll('s')].map(e => getComputedStyle(e).textDecorationLine);
        const title = sec.querySelector('.inv-bo-title');
        const tr = title.getBoundingClientRect();
        const note = sec.querySelector('.inv-bo-note p');
        const nums = [...sec.querySelectorAll('.inv-bo-nums')].map(e => e.getBoundingClientRect().right);
        const overflowers = [...sec.querySelectorAll('*')].filter(e => e.getBoundingClientRect().right > window.innerWidth + 0.5).map(e => e.className || e.tagName);
        return {
          docW: document.documentElement.scrollWidth, winW: window.innerWidth, secLeft: r.left, secRight: r.right,
          struck, titleH: tr.height, titleLine: parseFloat(getComputedStyle(title).lineHeight) || 14 * 1.5, titleRight: tr.right,
          noteFont: parseFloat(getComputedStyle(note).fontSize), noteVisible: note.getBoundingClientRect().height > 0,
          numsRight: Math.max(...nums), overflowers, text: sec.innerText,
        };
      });
      const tag = `@${width}px`;
      assert.ok(m.docW <= m.winW, `${tag}: page scrolls sideways (${m.docW} > ${m.winW})`);
      assert.ok(m.secLeft >= 0 && m.secRight <= m.winW + 0.5, `${tag}: block leaves the viewport (${m.secLeft}..${m.secRight})`);
      assert.deepEqual(m.overflowers, [], `${tag}: elements wider than the viewport`);
      assert.ok(m.numsRight <= m.winW + 0.5, `${tag}: numbers column overflows`);
      assert.ok(m.struck.length >= 8 && m.struck.every(s => s.includes('line-through')), `${tag}: strike-through missing (${m.struck})`);
      if (width <= 768) assert.ok(m.titleH > m.titleLine * 1.5, `${tag}: long title did not wrap (${m.titleH}px)`);   // at 1280 it fits on one line
      assert.ok(m.titleRight <= m.winW + 0.5, `${tag}: long title runs past the viewport`);
      assert.ok(m.noteFont >= 12 && m.noteVisible, `${tag}: footnote not readable (${m.noteFont}px)`);
      assert.ok(m.text.includes(LONG) && m.text.includes(LONG_SKU), `${tag}: long text was cut off, not wrapped`);
      assert.ok(m.text.includes(BACKORDER_INTRO), tag);
      // eta=2027-01-15 was stored by the flow for the first probe and none for the second: neither may show.
      noEta(m.text, `${tag} rendered text`);
      noEtaDate(m.text, `${tag} rendered text`, ['2027-01-15', 'Jan 15, 2027']);
      assert.ok(m.text.split('\n').some(l => l.trim() === `SKU ${LONG_SKU} · Qty 4`), `${tag}: footnote detail line is "SKU · Qty" and nothing else`);
      if (process.env.INVOICE_SHOT_DIR) {
        fs.mkdirSync(process.env.INVOICE_SHOT_DIR, { recursive: true });
        await pg.screenshot({ path: path.join(process.env.INVOICE_SHOT_DIR, `invoice-viewer-${width}.png`), fullPage: true });
        await pg.locator('#invoice-backorders').screenshot({ path: path.join(process.env.INVOICE_SHOT_DIR, `invoice-viewer-block-${width}.png`) });
      }
      await ctx.close();
    }
  } finally { await browser.close(); }
});

server.stop();

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
