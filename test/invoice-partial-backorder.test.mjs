// Backordered lines on LETTERED partial invoices (lib/partial-invoice-backorder.mjs + partial_invoices.backordered_json
// + POST/GET /orders/:id/partial-invoice* + the GET /orders/:id/invoice?letter= viewer).
//
// THE REPORT (order #39875, 2026-10-26): "Mark backordered" removes units from the Shopify order and the full-order
// invoice shows them struck through with a footnote — but staff issue LETTERED invoices (Generate PDF), which did not.
//   letter A  issued 20:46:58 UTC, BEFORE the 3 backorders  -> a frozen record that bills the 3 units; must stay as is
//   letter B  issued 21:47:21 UTC, AFTER them               -> 115 lines / $4,331.67 with NO struck rows and NO footnote (the bug)
// test/fixtures/invoice-39875-facts.mjs holds those facts; sections 3-4 replay them through the real routes.
//
// Run: node test/invoice-partial-backorder.test.mjs
//   Sections 1-2 are pure. Sections 3-4 boot ITS OWN mock server on a free port with B2B_ADMIN_MOCK=1 (in-memory
//   SQLite, no Shopify/Doppler env) and seed the incident through test/invoice-partial-backorder-seed.mjs; it never
//   touches data/admin.db or any live service.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildOrderInvoiceBackorderModel } from '../pdf.mjs';
import { BACKORDER_TAG, BACKORDER_HEADING, BACKORDER_INTRO } from '../lib/invoice-backorder.mjs';
import {
  serializeBackorderedLines, parseStoredBackorderedLines, backorderedLinesForPartialInvoice,
} from '../lib/partial-invoice-backorder.mjs';
import { pageContentHashes, extractPdfText } from './pdf-inspect.mjs';
import * as F from './fixtures/invoice-39875-facts.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.stack?.split('\n').slice(0, 5).join('\n      ') || e.message}`); failed++; }
}

// A db.mjs getBackorderedLinesForOrder() row for one of the incident's three units.
const liveRow = (b, over = {}) => ({
  lineItemId: b.lineItemId, variantId: b.variantId, sku: b.sku, title: b.title, variantTitle: b.variantTitle, quantity: 1,
  unitPrice: Number(b.unitPrice), currency: 'USD', lineTotal: Number(b.unitPrice), createdAt: b.createdAt, createdBy: 'alex@fuzzywumpets.com', ...over,
});
const LIVE = F.BACKORDERED.map(b => liveRow(b));   // what the live table returns today: all three, oldest first
const spyRows = (rows) => { const s = { calls: 0, get: () => { s.calls++; return rows; } }; return s; };

// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 1. The fixtures ARE the incident ──');

await test('A bills 118 lines / 178 units / $4,481.67; B 115 lines / 175 units / $4,331.67; the difference is exactly the 3 backordered units', () => {
  const a = F.snapshotLinesA(), b = F.snapshotLinesB();
  assert.equal(a.length, 118); assert.equal(b.length, 115);
  assert.equal(a.reduce((s, l) => s + l.quantity, 0), 178); assert.equal(b.reduce((s, l) => s + l.quantity, 0), 175);
  assert.equal(F.sum(a), 4481.67); assert.equal(F.sum(b), 4331.67);
  assert.equal(F.sum(a) - F.sum(b), 150);
  assert.deepEqual(F.BACKORDERED.map(x => Number(x.unitPrice)), [55, 45, 50]);
  assert.deepEqual(a.slice(115).map(l => l.sku), F.BACKORDERED.map(x => x.sku), 'A carries the 3 units as ordinary rows');
  assert.ok(!b.some(l => F.BACKORDERED.some(x => x.sku === l.sku)), 'B does not');
  assert.ok(F.T.A < F.T.BO1 && F.T.BO1 < F.T.BO2 && F.T.BO2 < F.T.BO3 && F.T.BO3 < F.T.B, 'A < the three backorders < B');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 2. Which rows a snapshot shows (lib/partial-invoice-backorder.mjs) ──');

await test('serializeBackorderedLines: a JSON array string; "[]" (never null) when nothing; only the fields the invoice needs', () => {
  for (const none of [[], null, undefined, [null], 'x', {}]) assert.equal(serializeBackorderedLines(none), '[]', JSON.stringify(none));
  const out = JSON.parse(serializeBackorderedLines(LIVE));
  assert.equal(out.length, 3);
  assert.deepEqual(Object.keys(out[0]).sort(), ['createdAt', 'currency', 'lineItemId', 'lineTotal', 'quantity', 'sku', 'title', 'unitPrice', 'variantTitle']);
  assert.ok(out.every(r => !('createdBy' in r) && !('variantId' in r)), 'no staff email, no variant id in the snapshot');
  assert.deepEqual(out.map(r => r.sku), ['LSC04946LG', 'LSC04946SM', 'LSC04857MED']);
});

await test('stored copy round-trips into the SAME model the live rows give (same wording, same footnote — nothing forked)', () => {
  const live = buildOrderInvoiceBackorderModel(LIVE);
  const stored = buildOrderInvoiceBackorderModel(parseStoredBackorderedLines(serializeBackorderedLines(LIVE)));
  assert.deepEqual(stored, live);
  assert.equal(live.lines.length, 3);
  assert.deepEqual(live.footnote.items.map(i => i.detail), ['SKU LSC04946LG · Qty 1', 'SKU LSC04946SM · Qty 1', 'SKU LSC04857MED · Qty 1']);
});

await test('parseStoredBackorderedLines: only a JSON array counts; NULL / empty / junk / non-array => null (= legacy)', () => {
  for (const bad of [null, undefined, '', '   ', 'not json', '{"a":1}', '"x"', '42', 'null', 7, {}]) assert.equal(parseStoredBackorderedLines(bad), null, String(bad));
  assert.deepEqual(parseStoredBackorderedLines('[]'), []);
  assert.deepEqual(parseStoredBackorderedLines('[{"sku":"S"},null,3,[1],"x"]'), [{ sku: 'S' }], 'non-object entries are dropped');
});

await test('NEW snapshot (stored copy): rendered from the stored rows ONLY — the live table is never read, so a later restore/backorder cannot change it', () => {
  const stored = serializeBackorderedLines(LIVE);
  const spy = spyRows([]);                                   // live table now EMPTY (everything was restored)
  const rows = backorderedLinesForPartialInvoice({ backordered_json: stored, created_at: F.T.B }, spy.get);
  assert.equal(rows.length, 3); assert.equal(spy.calls, 0, 'live rows were consulted');
  const spy2 = spyRows(LIVE);                                // and a snapshot frozen with "none" ignores units backordered later
  assert.deepEqual(backorderedLinesForPartialInvoice({ backordered_json: '[]', created_at: F.T.B }, spy2.get), []);
  assert.equal(spy2.calls, 0, '"[]" froze "none": it is not the same as NULL');
});

await test('LEGACY snapshot (NULL): live pending rows created at/before the snapshot — #39875: A gets NONE, B gets all THREE', () => {
  const a = backorderedLinesForPartialInvoice({ backordered_json: null, created_at: F.T.A }, () => LIVE);
  const b = backorderedLinesForPartialInvoice({ backordered_json: null, created_at: F.T.B }, () => LIVE);
  assert.deepEqual(a, [], 'A was issued before any of the three backorders and billed those units: nothing is struck');
  assert.deepEqual(b.map(r => r.sku), ['LSC04946LG', 'LSC04946SM', 'LSC04857MED']);
  assert.deepEqual(b.map(r => r.unitPrice), [55, 45, 50]);
});

await test('LEGACY boundary: created_at <= snapshot (inclusive); a snapshot issued mid-way gets only the units already backordered', () => {
  const at = (ms) => backorderedLinesForPartialInvoice({ backordered_json: undefined, created_at: ms }, () => LIVE).map(r => r.sku);
  assert.deepEqual(at(F.T.BO1 - 1), []);
  assert.deepEqual(at(F.T.BO1), ['LSC04946LG'], 'same millisecond counts as already backordered');
  assert.deepEqual(at(F.T.BO2), ['LSC04946LG', 'LSC04946SM']);
  assert.deepEqual(at(F.T.BO3 - 1), ['LSC04946LG', 'LSC04946SM']);
  assert.deepEqual(at(F.T.BO3), ['LSC04946LG', 'LSC04946SM', 'LSC04857MED']);
});

await test('LEGACY, impossible to place in time => OMITTED, never guessed (row without a usable createdAt; invoice without a usable created_at)', () => {
  const rows = [liveRow(F.BACKORDERED[0]), liveRow(F.BACKORDERED[1], { createdAt: null }), liveRow(F.BACKORDERED[2], { createdAt: 'abc' }),
    liveRow(F.BACKORDERED[2], { createdAt: undefined }), liveRow(F.BACKORDERED[2], { createdAt: '' })];
  assert.deepEqual(backorderedLinesForPartialInvoice({ backordered_json: null, created_at: F.T.B }, () => rows).map(r => r.sku), ['LSC04946LG']);
  for (const created_at of [null, undefined, 'x', NaN]) assert.deepEqual(backorderedLinesForPartialInvoice({ backordered_json: null, created_at }, () => LIVE), [], String(created_at));
  assert.deepEqual(backorderedLinesForPartialInvoice(null, () => LIVE), []);
  assert.deepEqual(backorderedLinesForPartialInvoice({ backordered_json: null, created_at: F.T.B }, () => null), []);
  assert.deepEqual(backorderedLinesForPartialInvoice({ backordered_json: null, created_at: F.T.B }), [], 'no live source => nothing');
});

await test('LEGACY: a unit restored since (no longer a pending row) is simply not there; a corrupt stored value is treated as legacy', () => {
  const afterUndo = [LIVE[0], LIVE[2]];
  assert.deepEqual(backorderedLinesForPartialInvoice({ backordered_json: null, created_at: F.T.B }, () => afterUndo).map(r => r.sku), ['LSC04946LG', 'LSC04857MED']);
  assert.deepEqual(backorderedLinesForPartialInvoice({ backordered_json: '{oops', created_at: F.T.A }, () => LIVE), []);
  assert.equal(backorderedLinesForPartialInvoice({ backordered_json: '{oops', created_at: F.T.B }, () => LIVE).length, 3);
});

await test('the module holds no customer wording (that lives only in lib/invoice-backorder.mjs) and does no I/O', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/partial-invoice-backorder.mjs'), 'utf8');
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  for (const phrase of ['currently backordered', 'not included', 'Backordered', 'backordered items']) {
    assert.ok(!new RegExp(`['"\`][^'"\`\\n]*${phrase}[^'"\`\\n]*['"\`]`, 'i').test(code), `forked wording: ${phrase}`);
  }
  assert.ok(!/\bimport\b|Date\.now|process\.env|readFileSync|better-sqlite3/.test(code), 'pure: no imports, clock, env, fs or db');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 3. #39875 through the real routes (own mock server, seeded: legacy A + B, three pending backorders) ──');

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
  const child = spawn(process.execPath, ['--import', './test/invoice-partial-backorder-seed.mjs', 'server.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
process.on('exit', () => { try { server.child.kill(); } catch { /* already gone */ } });   // never leave it running if the suite dies
try {
  const sid = (await (await fetch(`${server.base}/__test__/session?email=alex@fuzzywumpets.com`)).json()).sid;
  const cookie = `b2b_admin_sid=${sid}`;
  const get = (p) => fetch(server.base + p, { headers: { Cookie: cookie } });
  const text = async (p) => { const r = await get(p); assert.equal(r.status, 200, p); return r.text(); };
  const pdf = async (p) => { const r = await get(p); assert.equal(r.status, 200, p); return Buffer.from(await r.arrayBuffer()); };
  const post = (p, fields) => fetch(server.base + p, { method: 'POST', redirect: 'manual',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
  const apiRows = async (n) => (await (await get(`/api/admin/orders/${n}/partial-invoices`)).json()).invoices;

  // What the invoice drew, from the finished PDF.
  const readPdf = (buf) => {
    const runs = extractPdfText(buf);
    const idx = (t, from = 0) => runs.findIndex((r, i) => i >= from && r.text === t);
    const skuRuns = runs.filter(r => r.x === 276 && r.size === 8.5);                // the SKU cell of every row, struck or not
    const filler = skuRuns.filter(r => /^FILL-/.test(r.text));
    const incident = F.BACKORDERED.map(b => ({ sku: b.sku, at: skuRuns.filter(r => r.text === b.sku) }));
    return {
      runs, texts: runs.map(r => r.text), skuRuns, filler, incident,
      tags: runs.filter(r => r.text === BACKORDER_TAG),
      amounts: runs.filter(r => r.size >= 10 && /^-?\$/.test(r.text)).map(r => r.text),   // Subtotal / Discount / Shipping / TOTAL
      lastFillerIdx: runs.findLastIndex(r => r.x === 276 && r.size === 8.5 && /^FILL-/.test(r.text)),
      idx,
      footnote: () => {                                                                   // everything from the heading to the page footer
        const h = idx(BACKORDER_HEADING), f = runs.findIndex(r => r.text.startsWith('Thank you for your business'));
        return h < 0 ? [] : runs.slice(h, f).filter(r => !(r.text.startsWith('INVOICE #') && r.y < 40)).map(r => r.text);
      },
    };
  };
  const O = `/orders/${F.ORDER_NUM}`;

  await test('LETTER A (legacy, issued before the backorders): untouched — 118 ordinary rows incl. the 3 units, NO struck rows, NO footnote, $4,481.67', async () => {
    const a = readPdf(await pdf(`${O}/partial-invoice/A.pdf`));
    assert.equal(a.filler.length, 115);
    for (const i of a.incident) assert.equal(i.at.length, 1, `${i.sku} is billed as one ordinary row`);
    assert.equal(a.skuRuns.length, 118);
    assert.equal(a.tags.length, 0, 'no "Backordered *" tag');
    assert.ok(!a.texts.includes(BACKORDER_HEADING) && !a.texts.includes(BACKORDER_INTRO), 'no footnote');
    assert.deepEqual(a.amounts, ['$4,481.67', '$4,481.67'], 'Subtotal == TOTAL == the snapshot total');
    assert.ok(a.texts.includes('$55.00') && a.texts.includes('$45.00') && a.texts.includes('$50.00'), 'the 3 units print at their price as billed rows');
  });

  await test('LETTER B (legacy, issued after): 115 billed rows, the 3 units struck below them with the tag + footnote, total still $4,331.67', async () => {
    const b = readPdf(await pdf(`${O}/partial-invoice/B.pdf`));
    assert.equal(b.filler.length, 115);
    assert.equal(b.skuRuns.length, 118, '115 billed rows + 3 struck rows');
    for (const i of b.incident) {
      assert.equal(i.at.length, 1, `${i.sku} appears once`);
      assert.ok(b.runs.indexOf(i.at[0]) > b.lastFillerIdx, `${i.sku} is drawn AFTER every billed row`);
      const tag = b.tags.find(t => t.page === i.at[0].page && t.y > i.at[0].y && t.y - i.at[0].y < 40);
      assert.ok(tag, `${i.sku}: its row carries the "${BACKORDER_TAG}" tag`);
    }
    assert.equal(b.tags.length, 3);
    assert.ok(b.texts.includes(BACKORDER_HEADING) && b.texts.includes(BACKORDER_INTRO));
    assert.deepEqual(b.footnote().filter(t => /^SKU /.test(t)), ['SKU LSC04946LG · Qty 1', 'SKU LSC04946SM · Qty 1', 'SKU LSC04857MED · Qty 1']);
    // Struck rows never enter the totals: the amounts block is exactly the snapshot's.
    assert.deepEqual(b.amounts, ['$4,331.67', '$4,331.67']);
    const totalAt = b.runs.findLastIndex(r => r.text === 'TOTAL' && r.size === 13);
    assert.ok(b.idx(BACKORDER_HEADING) > totalAt, 'footnote sits below the totals');
    assert.ok(b.runs.findIndex(r => r.text === '$55.00') < totalAt, 'the struck $55.00 is a row, above the totals');
  });

  await test('the viewer page repeats the block as real HTML for B (3 struck lines + footnote), and shows nothing for A', async () => {
    const pb = await text(`${O}/invoice?letter=B`);
    assert.ok(pb.includes('id="invoice-backorders"'));
    assert.equal((pb.match(/class="inv-bo-line"/g) || []).length, 3);
    for (const v of ['<s>$55.00</s>', '<s>$45.00</s>', '<s>$50.00</s>', 'SKU LSC04946LG · Qty 1<', 'SKU LSC04857MED · Qty 1<']) assert.ok(pb.includes(v), v);
    assert.ok(pb.includes(BACKORDER_INTRO.replace("'", '&#x27;')));
    assert.ok(pb.includes('/orders/' + F.ORDER_NUM + '/partial-invoice/B.pdf?download=1'), 'download link still the attachment route');
    const pa = await text(`${O}/invoice?letter=A`);
    assert.ok(!pa.includes('inv-bo'), 'A: no block, no css');
    assert.ok(!(await text(`${O}/invoice?letter=Q`)).includes('inv-bo'), 'unknown letter: nothing');
  });

  await test('download (?download=1 — "Invoices issued" and the /invoices links) renders the same pages as the inline view', async () => {
    for (const l of ['A', 'B']) {
      const inline = await get(`${O}/partial-invoice/${l}.pdf`), dl = await get(`${O}/partial-invoice/${l}.pdf?download=1`);
      assert.ok((dl.headers.get('content-disposition') || '').startsWith('attachment'), l);
      assert.deepEqual(pageContentHashes(Buffer.from(await dl.arrayBuffer())), pageContentHashes(Buffer.from(await inline.arrayBuffer())), l);
    }
  });

  await test('reading never rewrites a legacy snapshot: A and B still hold NULL (no backfill by a GET)', async () => {
    const rows = await apiRows(F.ORDER_NUM);
    const by = Object.fromEntries(rows.map(r => [r.invoice_letter, r]));
    assert.equal(by.A.backordered_json, null); assert.equal(by.B.backordered_json, null);
    assert.equal(by.A.total, 4481.67); assert.equal(by.B.total, 4331.67);
    assert.equal(by.A.created_at, F.T.A); assert.equal(by.B.created_at, F.T.B);
  });

  let letterC;
  await test('NEW snapshot (POST Generate PDF): freezes the 3 live rows at creation; every rendering then uses the stored copy', async () => {
    const made = await post(`${O}/partial-invoice`, { type: 'full' });
    assert.equal(made.status, 302);
    letterC = /letter=([A-Z])/.exec(made.headers.get('location') || '')?.[1];
    assert.equal(letterC, 'C', 'A and B exist, so the next letter is C');
    const c = (await apiRows(F.ORDER_NUM)).find(r => r.invoice_letter === 'C');
    const stored = JSON.parse(c.backordered_json);
    assert.deepEqual(stored.map(r => r.sku), ['LSC04946LG', 'LSC04946SM', 'LSC04857MED']);
    assert.deepEqual(stored.map(r => r.unitPrice), [55, 45, 50]);
    assert.ok(stored.every(r => !('createdBy' in r)));
    const pc = readPdf(await pdf(`${O}/partial-invoice/C.pdf`));
    assert.equal(pc.tags.length, 3);
    assert.deepEqual(pc.amounts, ['$1,200.00', '$1,200.00'], 'mock #1003 total; the struck rows are not in it');
    // Same rendering and wording as the full-order invoice (which reads the live rows): the footnote is identical.
    const full = readPdf(await pdf(`${O}/invoice.pdf`));
    assert.equal(full.tags.length, 3);
    assert.deepEqual(pc.footnote(), full.footnote(), 'lettered footnote == full-invoice footnote, word for word');
    assert.ok(pc.footnote().includes(BACKORDER_HEADING));
  });

  await test('the viewer for the NEW letter shows the stored block too', async () => {
    const page = await text(`${O}/invoice?letter=${letterC}`);
    assert.equal((page.match(/class="inv-bo-line"/g) || []).length, 3);
  });

  await test('an order with NO backorders: the new letter stores "[]" and renders no struck rows (unchanged layout)', async () => {
    const made = await post('/orders/1004/partial-invoice', { type: 'full' });
    assert.equal(made.status, 302);
    const row = (await apiRows('1004'))[0];
    assert.equal(row.backordered_json, '[]', 'frozen "none" — distinct from NULL (legacy)');
    const p = readPdf(await pdf(`/orders/1004/partial-invoice/${row.invoice_letter}.pdf`));
    assert.equal(p.tags.length, 0);
    assert.ok(!p.texts.includes(BACKORDER_HEADING));
    assert.ok(!(await text(`/orders/1004/invoice?letter=${row.invoice_letter}`)).includes('inv-bo'));
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n── 4. An issued invoice never changes (real Mark-backordered flow on mock #1002) ──');

  await test('letter issued BEFORE a unit is backordered stays free of it; a letter issued AFTER shows it; the full invoice shows it live', async () => {
    const before = await post('/orders/1002/partial-invoice', { type: 'full' });
    assert.equal(before.status, 302);
    const rows0 = await apiRows('1002');
    assert.equal(rows0[0].backordered_json, '[]');
    const l1 = rows0[0].invoice_letter;
    const hashes0 = pageContentHashes(await pdf(`/orders/1002/partial-invoice/${l1}.pdf`));

    const flag = await post('/orders/1002/backorder', { lineItemId: 'li3', quantity: '2' });
    assert.equal(flag.status, 302);
    assert.ok((flag.headers.get('location') || '').includes('success=backorder_flagged'), flag.headers.get('location'));

    const live = readPdf(await pdf('/orders/1002/invoice.pdf'));
    assert.equal(live.tags.length, 1, 'the full invoice shows the newly backordered unit');
    assert.deepEqual(pageContentHashes(await pdf(`/orders/1002/partial-invoice/${l1}.pdf`)), hashes0, `letter ${l1} issued before the backorder is byte-identical in content`);
    assert.ok(!(await text(`/orders/1002/invoice?letter=${l1}`)).includes('inv-bo'));

    const after = await post('/orders/1002/partial-invoice', { type: 'full' });
    assert.equal(after.status, 302);
    const l2 = (await apiRows('1002')).find(r => r.invoice_letter !== l1).invoice_letter;
    const p2 = readPdf(await pdf(`/orders/1002/partial-invoice/${l2}.pdf`));
    assert.equal(p2.tags.length, 1, `letter ${l2} issued after shows it`);
    assert.ok(p2.footnote().includes('SKU SC-002-M-RD · Qty 2'), p2.footnote().join(' | '));
  });
} finally {
  server.stop();
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
