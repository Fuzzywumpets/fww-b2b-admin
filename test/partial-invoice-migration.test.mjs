// Standalone DB-level suite for partial_invoices.backordered_json (no server).
//
// Why standalone: the column is added when db.mjs is IMPORTED and only matters against a file that already holds
// the OLD schema + issued invoices — the mock HTTP server uses a fresh in-memory DB, so it can never prove that
// the live database (with invoices already issued, e.g. #39875-A and -B) survives, or that a rollback is safe.
// Same pattern as test/backorder-migration.test.mjs.
//
// What it pins (two layers):
//   1. SCHEMA: the additive column, rollback safety (the previous release's INSERT still runs), idempotent re-run.
//   2. BACKFILL (2026-10-26 follow-up): every letter issued BEFORE the column existed (backordered_json NULL) is
//      frozen at boot with exactly what the legacy fallback rendered, so a later Undo / fulfil / re-flag can no longer
//      change an issued invoice. The headline case is the real order #39875 shape: letter A issued BEFORE the three
//      backorders, letter B issued AFTER them (test/fixtures/invoice-39875-facts.mjs holds the prod timestamps).
//
// SAFETY: db.mjs is pointed at a throwaway directory through B2B_ADMIN_DATA_DIR BEFORE it is imported, and
// B2B_ADMIN_MOCK is cleared so it opens that FILE. The test refuses to run if the handle did not land inside the
// temp dir — it can never touch the real data/admin.db.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { T, BACKORDERED } from './fixtures/invoice-39875-facts.mjs';
import { backorderedLinesForPartialInvoice, serializeBackorderedLines } from '../lib/partial-invoice-backorder.mjs';
import { buildInvoiceBackorderModel, renderInvoiceBackorderHtml } from '../lib/invoice-backorder.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DB_URL = pathToFileURL(path.join(here, '..', 'db.mjs')).href;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b2badmin-partial-mig-'));

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${err.message}`); failed++; }
}

// ── A database exactly as the PREVIOUS release left it ───────────────────────────────────────────
// Verbatim from the previous db.mjs CREATE TABLE (no backordered_json).
const OLD_DDL = `
  CREATE TABLE partial_invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    invoice_letter TEXT NOT NULL,
    invoice_type TEXT NOT NULL DEFAULT 'fulfilled_only',
    total REAL NOT NULL DEFAULT 0,
    shipping REAL NOT NULL DEFAULT 0,
    tax REAL NOT NULL DEFAULT 0,
    line_items_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    sent_at INTEGER
  );`;
// The backorders table as production has it at the previous release (6d967a0): the original CREATE TABLE plus the
// eight columns the backorder hot-fix migration added (db.mjs BACKORDER_ADDED_COLUMNS). Seeded complete on purpose,
// so the reading side of the backfill is exercised against the real prod shape.
const OLD_BACKORDERS_DDL = `
  CREATE TABLE backorders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    line_item_id TEXT NOT NULL,
    line_item_title TEXT,
    quantity INTEGER NOT NULL DEFAULT 0,
    eta_date TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    created_by TEXT,
    notified INTEGER NOT NULL DEFAULT 0,
    UNIQUE(order_id, line_item_id)
  );
  ALTER TABLE backorders ADD COLUMN variant_id TEXT;
  ALTER TABLE backorders ADD COLUMN sku TEXT;
  ALTER TABLE backorders ADD COLUMN variant_title TEXT;
  ALTER TABLE backorders ADD COLUMN unit_price TEXT;
  ALTER TABLE backorders ADD COLUMN currency TEXT;
  ALTER TABLE backorders ADD COLUMN shopify_removed_qty INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE backorders ADD COLUMN restored_at INTEGER;
  ALTER TABLE backorders ADD COLUMN claim_prior_qty INTEGER;`;
// Verbatim from the previous db.mjs createPartialInvoice — what a rolled-back release will run.
const OLD_INSERT = `
    INSERT INTO partial_invoices (order_id, invoice_letter, invoice_type, total, shipping, tax, line_items_json, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
const insertBackorder = (d, o) => d.prepare(`
  INSERT INTO backorders (order_id, line_item_id, line_item_title, quantity, status, created_at, created_by, variant_id, sku,
                          variant_title, unit_price, currency, shopify_removed_qty, restored_at, claim_prior_qty)
  VALUES (@order_id, @line_item_id, @title, @quantity, @status, @created_at, @by, @variant_id, @sku, @variant_title, @unit_price, 'USD', @removed, @restored_at, @prior)
`).run({ status: 'pending', by: 'staff@fww', variant_id: null, sku: null, variant_title: null, unit_price: '10.00', restored_at: null, prior: null, removed: 1, title: 'Item', ...o, quantity: o.quantity ?? o.removed ?? 1 });

const ORDER = 'gid://shopify/Order/18948052451563';        // order #39875
const LINES_A = JSON.stringify([{ id: 'gid://shopify/LineItem/1', title: 'Collar', quantity: 118, unitPrice: 37.97 }]);
const T_C = Date.parse('2026-10-26T22:30:00.000Z');         // a letter the PREVIOUS release writes after a rollback
const T_NEW_BO = Date.parse('2026-10-26T22:10:00.000Z');    // a unit backordered AFTER letter B was issued

const seed = new Database(path.join(tmp, 'admin.db'));
seed.exec(OLD_DDL);
seed.exec(OLD_BACKORDERS_DDL);
// THE #39875 SHAPE (prod facts, UTC): letter A at 20:46:58.685, three units backordered one at a time at
// 21:45:44 / 21:46:04 / 21:46:29, letter B at 21:47:21.315. Both letters were written by the previous release: NULL.
seed.prepare(OLD_INSERT).run(ORDER, 'A', 'full', 4481.67, 0, 0, LINES_A, T.A, 'staff@fww');
for (const b of BACKORDERED) {
  insertBackorder(seed, { order_id: ORDER, line_item_id: b.lineItemId, title: b.title, variant_id: b.variantId, sku: b.sku,
    variant_title: b.variantTitle, unit_price: b.unitPrice, created_at: b.createdAt });
}
seed.prepare(OLD_INSERT).run(ORDER, 'B', 'full', 4331.67, 0, 0, '[]', T.B, 'rb@fww');

// THE EDGE RULES of the legacy fallback, on a second order: a letter issued at ms 1000 exactly. Only the pending rows
// that REMOVED units (shopify_removed_qty > 0) and were created at/before it count - restored, fulfilled, in-flight,
// legacy flag-only, later and other-order rows do not.
const MIX = 'gid://shopify/Order/9400', OTHER = 'gid://shopify/Order/9401';
insertBackorder(seed, { order_id: MIX, line_item_id: 'li-equal', title: 'Equal', sku: 'EQ', created_at: 1000 });                         // == issuedAt: IN
insertBackorder(seed, { order_id: MIX, line_item_id: 'li-before', title: 'Before', sku: 'BE', created_at: 999, removed: 2 });            // before: IN
insertBackorder(seed, { order_id: MIX, line_item_id: 'li-after', title: 'After', sku: 'AF', created_at: 1001 });                        // after: out
insertBackorder(seed, { order_id: MIX, line_item_id: 'li-restored', title: 'Restored', sku: 'RS', created_at: 500, status: 'restored', restored_at: 900 });
insertBackorder(seed, { order_id: MIX, line_item_id: 'li-flagonly', title: 'Flag only', sku: 'FO', created_at: 500, removed: 0, quantity: 3 }); // legacy flag-only: removed nothing
insertBackorder(seed, { order_id: MIX, line_item_id: 'li-applying', title: 'Applying', sku: 'AP', created_at: 500, status: 'applying', removed: 0 });
insertBackorder(seed, { order_id: MIX, line_item_id: 'li-fulfilled', title: 'Fulfilled', sku: 'FU', created_at: 500, status: 'fulfilled' });
insertBackorder(seed, { order_id: OTHER, line_item_id: 'li-other', title: 'Other order', sku: 'OT', created_at: 500 });
seed.prepare(OLD_INSERT).run(MIX, 'A', 'full', 10, 0, 0, '[]', 1000, 'staff@fww');
seed.prepare(OLD_INSERT).run(MIX, 'B', 'full', 10, 0, 0, '[]', 998, 'staff@fww');             // before 'li-before'(999) and 'li-equal': nothing yet
seed.prepare(OLD_INSERT).run(OTHER, 'A', 'full', 10, 0, 0, '[]', 2000, 'staff@fww');
seed.prepare(OLD_INSERT).run('gid://shopify/Order/9402', 'A', 'full', 10, 0, 0, '[]', 'not-a-time', 'staff@fww'); // unplaceable in time: omitted, never guessed
seed.close();

process.env.B2B_ADMIN_DATA_DIR = tmp;
delete process.env.B2B_ADMIN_MOCK;
const dbm = await import(DB_URL);
const db = dbm.default;
if (!path.resolve(db.name).startsWith(path.resolve(tmp))) {
  console.error(`REFUSING to run: db opened ${db.name}, not the scratch dir ${tmp}`);
  process.exit(2);
}
const cols = () => db.prepare('PRAGMA table_info(partial_invoices)').all();
const letter = (order, l) => dbm.getPartialInvoices(order).find(r => r.invoice_letter === l);
const dump = () => JSON.stringify(db.prepare('SELECT * FROM partial_invoices ORDER BY id').all());
const stored = (order, l) => JSON.parse(letter(order, l).backordered_json);
const skus = (rows) => rows.map(r => r.sku);
// What the on-screen/PDF renderers do with a lettered invoice (server.mjs partialInvoiceBackorderedLines), minus the PDF.
const NEVER_LIVE = () => { throw new Error('a frozen invoice must not read the live backorders table'); };
const renderRows = (inv, live = NEVER_LIVE) => backorderedLinesForPartialInvoice(inv, live);
const renderHtml = (inv, live = NEVER_LIVE) => renderInvoiceBackorderHtml(buildInvoiceBackorderModel(renderRows(inv, live)));

console.log('\n  partial_invoices.backordered_json migration (old-schema database)');

await test('importing db.mjs adds backordered_json to the old-schema table, as a NULLABLE TEXT column with no default', () => {
  const c = cols().find(x => x.name === 'backordered_json');
  assert.ok(c, 'column missing');
  assert.equal(c.type, 'TEXT');
  assert.equal(c.notnull, 0);
  assert.equal(c.dflt_value, null);
});

await test('the already-issued invoices survive the migration untouched (totals, lines, issue time, author)', () => {
  const [a, b] = dbm.getPartialInvoices(ORDER);
  assert.deepEqual([a.invoice_letter, b.invoice_letter], ['A', 'B']);
  assert.equal(a.total, 4481.67);
  assert.equal(a.line_items_json, LINES_A);
  assert.equal(a.created_at, T.A);
  assert.equal(a.created_by, 'staff@fww');
  assert.equal(b.total, 4331.67);
  assert.equal(b.line_items_json, '[]');
  assert.equal(b.created_at, T.B);
  assert.equal(b.created_by, 'rb@fww');
  assert.equal(a.sent_at, null);
});

console.log('\n  backfill: real order #39875 (A before the three backorders, B after them)');

await test('letter A (issued BEFORE the three backorders) is frozen as "[]", never left NULL', () => {
  assert.equal(letter(ORDER, 'A').backordered_json, '[]');
});

await test('letter B (issued AFTER them) is frozen with exactly the 3 removed units, in the stored shape', () => {
  const expected = BACKORDERED.map(b => ({
    lineItemId: b.lineItemId, sku: b.sku, title: b.title, variantTitle: b.variantTitle, quantity: 1,
    unitPrice: Number(b.unitPrice), currency: 'USD', lineTotal: Number(b.unitPrice), createdAt: b.createdAt,
  }));
  assert.deepEqual(stored(ORDER, 'B'), expected);
  assert.equal(letter(ORDER, 'B').backordered_json, serializeBackorderedLines(expected), 'byte-identical to what the create route would store');
  assert.deepEqual(skus(stored(ORDER, 'B')), ['LSC04946LG', 'LSC04946SM', 'LSC04857MED']);
});

await test('the renderers now take both letters from the stored copy and never touch the live table', () => {
  assert.deepEqual(renderRows(letter(ORDER, 'A')), []);
  assert.equal(buildInvoiceBackorderModel(renderRows(letter(ORDER, 'A'))), null, 'A has no struck rows and no footnote');
  const model = buildInvoiceBackorderModel(renderRows(letter(ORDER, 'B')));
  assert.equal(model.lines.length, 3);
  assert.equal(model.footnote.items.length, 3);
});

await test('UNDO one unit, then flag a NEW one and fulfil another: the live table changes, letters A and B render IDENTICALLY', () => {
  const beforeA = { rows: renderRows(letter(ORDER, 'A')), html: renderHtml(letter(ORDER, 'A')) };
  const beforeB = { rows: renderRows(letter(ORDER, 'B')), html: renderHtml(letter(ORDER, 'B')) };
  assert.ok(dbm.restoreBackorder(ORDER, BACKORDERED[1].lineItemId, Date.parse('2026-10-27T01:00:00.000Z')), 'undo (restore) of the middle unit');
  const claim = dbm.claimBackorderRemoval({ orderId: ORDER, lineItemId: 'gid://shopify/LineItem/777', title: 'Later unit', variantId: null,
    sku: 'LATER', variantTitle: null, unitPrice: '12.00', currency: 'USD', quantity: 1, priorQty: 2, createdBy: 'staff@fww', now: T_NEW_BO });
  assert.ok(claim.ok);
  assert.ok(dbm.finalizeBackorderRemoval(ORDER, 'gid://shopify/LineItem/777'));
  dbm.fulfillBackorder(ORDER, BACKORDERED[0].lineItemId);          // must NOT clear a removed-units row (own CHANGE-GUARD) - still, no effect on a frozen copy
  const live = dbm.getBackorderedLinesForOrder(ORDER);
  assert.deepEqual(skus(live), ['LSC04946LG', 'LSC04857MED', 'LATER'], 'the live table really did change');
  // What the OLD live-row fallback would render for B now: 2 of its 3 rows plus none of the new one (created later) - i.e. DIFFERENT.
  const legacyNow = backorderedLinesForPartialInvoice({ backordered_json: null, created_at: T.B }, () => live);
  assert.deepEqual(skus(legacyNow), ['LSC04946LG', 'LSC04857MED'], 'the legacy fallback would have dropped the undone unit from B');
  // The frozen render does not move.
  assert.deepEqual(renderRows(letter(ORDER, 'A')), beforeA.rows);
  assert.equal(renderHtml(letter(ORDER, 'A')), beforeA.html);
  assert.deepEqual(renderRows(letter(ORDER, 'B')), beforeB.rows);
  assert.equal(renderHtml(letter(ORDER, 'B')), beforeB.html);
  assert.equal(beforeB.rows.length, 3);
});

console.log('\n  backfill: the exact rules of the legacy fallback');

await test('a letter issued at ms 1000: pending removed rows created at/before it (equal counts), oldest first - and nothing else', () => {
  assert.deepEqual(skus(stored(MIX, 'A')), ['BE', 'EQ'], 'restored / fulfilled / applying / legacy flag-only / later rows are not frozen in');
  assert.equal(JSON.parse(letter(MIX, 'A').backordered_json)[0].quantity, 2, 'quantity is the REMOVED quantity');
});

await test('a letter issued before every row is frozen as "[]"; rows of ANOTHER order never leak in', () => {
  assert.equal(letter(MIX, 'B').backordered_json, '[]');
  assert.deepEqual(skus(stored(OTHER, 'A')), ['OT']);
});

await test('a letter whose issue time cannot be placed is frozen as "[]" (omitted, never guessed)', () => {
  assert.equal(letter('gid://shopify/Order/9402', 'A').backordered_json, '[]');
});

await test('NO letter is left NULL after the migration', () => {
  assert.deepEqual(db.prepare('SELECT order_id, invoice_letter FROM partial_invoices WHERE backordered_json IS NULL').all(), []);
});

console.log('\n  rollback safety and new letters');

await test('ROLLBACK SAFETY: the previous release\'s INSERT (explicit columns, no backordered_json) still runs on the migrated table', () => {
  db.prepare(OLD_INSERT).run(ORDER, 'C', 'full', 4000, 0, 0, '[]', T_C, 'rb@fww');
  const c = letter(ORDER, 'C');
  assert.equal(c.total, 4000);
  assert.equal(c.backordered_json, null, 'a row written by the old release is legacy-shaped until the next boot freezes it');
  assert.equal(dbm.getNextInvoiceLetter(ORDER), 'D');
});

await test('createPartialInvoice stores the frozen copy; "[]" is kept as "[]" (frozen "none"), omitted stays NULL', () => {
  const o = 'gid://shopify/Order/9301';
  dbm.createPartialInvoice({ orderId: o, invoiceLetter: 'A', invoiceType: 'full', total: 1, lineItemsJson: '[]', backorderedJson: '[{"sku":"S","quantity":1}]', createdBy: 'a@fww' });
  dbm.createPartialInvoice({ orderId: o, invoiceLetter: 'B', invoiceType: 'full', total: 1, lineItemsJson: '[]', backorderedJson: '[]', createdBy: 'a@fww' });
  dbm.createPartialInvoice({ orderId: o, invoiceLetter: 'C', invoiceType: 'full', total: 1, lineItemsJson: '[]', createdBy: 'a@fww' });
  const by = Object.fromEntries(dbm.getPartialInvoices(o).map(r => [r.invoice_letter, r.backordered_json]));
  assert.deepEqual(by, { A: '[{"sku":"S","quantity":1}]', B: '[]', C: null });
});

await test('every reader that selects * still sees the old columns unchanged (list API row shape + the /invoices join)', () => {
  const row = dbm.getPartialInvoices(ORDER)[0];
  for (const k of ['id', 'order_id', 'invoice_letter', 'invoice_type', 'total', 'shipping', 'tax', 'line_items_json', 'created_at', 'created_by', 'sent_at']) {
    assert.ok(k in row, `row lost ${k}`);
  }
  assert.ok(dbm.getPartialInvoicesAll().some(r => r.order_id === ORDER && r.invoice_letter === 'A'));
});

console.log('\n  idempotent, one-time');

const afterImport = {};
await test('running the migration (twice) changes NOTHING already frozen - A and B keep their rows although a unit was undone - and freezes only the NULL rows', () => {
  const a0 = letter(ORDER, 'A').backordered_json, b0 = letter(ORDER, 'B').backordered_json;
  const mixA0 = letter(MIX, 'A').backordered_json;
  const colsBefore = JSON.stringify(cols());
  dbm.migratePartialInvoicesSchema(db);
  const afterFirst = dump();
  dbm.migratePartialInvoicesSchema(db);
  const afterSecond = dump();
  assert.equal(afterSecond, afterFirst, 'the second run changed nothing');
  assert.equal(JSON.stringify(cols()), colsBefore, 'no schema change');
  assert.equal(letter(ORDER, 'A').backordered_json, a0);
  assert.equal(letter(ORDER, 'B').backordered_json, b0, 'B was NOT recomputed from the live table (3 rows, though only 2 are pending now)');
  assert.equal(letter(MIX, 'A').backordered_json, mixA0);
  assert.equal(dbm.getPartialInvoices(ORDER)[0].total, 4481.67);
  // The only rows that were NULL (written after the first boot) are now frozen: C from the live rows at its issue time,
  // and the omitted-on-purpose letter 'C' of order 9301.
  assert.deepEqual(skus(stored(ORDER, 'C')), ['LSC04946LG', 'LSC04857MED', 'LATER'], 'C: what was pending when it was issued (the undone unit is not)');
  assert.equal(letter('gid://shopify/Order/9301', 'C').backordered_json, '[]');
  assert.deepEqual(db.prepare('SELECT 1 FROM partial_invoices WHERE backordered_json IS NULL').all(), []);
  afterImport.dump = afterSecond;
});

await test('the backfill reports what it wrote: 0 when there is nothing left to freeze', () => {
  assert.equal(dbm.backfillPartialInvoiceBackordered(db), 0);
  assert.equal(dump(), afterImport.dump);
});

await test('a second process start (restart) over the already-migrated file is clean, keeps the data and rewrites nothing', () => {
  const script = `
    const m = await import(${JSON.stringify(DB_URL)});
    const cols = m.default.prepare('PRAGMA table_info(partial_invoices)').all().map(c => c.name);
    const rows = m.default.prepare('SELECT * FROM partial_invoices ORDER BY id').all();
    console.log(JSON.stringify({ n: cols.length, has: cols.includes('backordered_json'), letters: m.getPartialInvoices(${JSON.stringify(ORDER)}).map(r => r.invoice_letter), dump: JSON.stringify(rows) }));
  `;
  const env = { ...process.env, B2B_ADMIN_DATA_DIR: tmp }; delete env.B2B_ADMIN_MOCK;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const j = JSON.parse(out.stdout.trim().split('\n').pop());
  assert.equal(j.n, cols().length);
  assert.equal(j.has, true);
  assert.deepEqual(j.letters, ['A', 'B', 'C']);
  assert.equal(j.dump, afterImport.dump, 'a restart changed no row');
  assert.ok(!/froze the backordered lines/.test(out.stdout), 'and logged no backfill (nothing to do)');
});

await test('a brand-new database (no prior table) ends up with the identical column set', () => {
  const script = `
    const m = await import(${JSON.stringify(DB_URL)});
    console.log(JSON.stringify(m.default.prepare('PRAGMA table_info(partial_invoices)').all().map(c => c.name)));
  `;
  const env = { ...process.env, B2B_ADMIN_MOCK: '1' }; delete env.B2B_ADMIN_DATA_DIR;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const fresh = JSON.parse(out.stdout.trim().split('\n').pop()).sort();
  assert.deepEqual(fresh, cols().map(c => c.name).sort());
});

console.log('\n  backfill failure handling (scratch in-memory databases)');

const memDb = ({ backorders = true } = {}) => {
  const d = new Database(':memory:');
  d.exec(OLD_DDL);
  if (backorders) d.exec(OLD_BACKORDERS_DDL);
  return d;
};

await test('a database with no backorders table at all (schema older than the backorder hot-fix) is frozen as "[]" without error', () => {
  const d = memDb({ backorders: false });
  d.prepare(OLD_INSERT).run('gid://shopify/Order/1', 'A', 'full', 1, 0, 0, '[]', 5, 'x');
  dbm.migratePartialInvoicesSchema(d);
  assert.equal(d.prepare('SELECT backordered_json FROM partial_invoices').get().backordered_json, '[]');
  d.close();
});

await test('the backfill is ONE transaction and a failure never takes the app down: all rows roll back, are retried next start, and the error is loud', () => {
  const d = memDb();
  const O = 'gid://shopify/Order/2';
  insertBackorder(d, { order_id: O, line_item_id: 'li-1', title: 'One', sku: 'ONE', created_at: 10 });
  d.prepare(OLD_INSERT).run(O, 'A', 'full', 1, 0, 0, '[]', 20, 'x');
  d.prepare(OLD_INSERT).run(O, 'B', 'full', 1, 0, 0, '[]', 30, 'x');
  // Letter B's UPDATE fails AFTER letter A's succeeded inside the same transaction.
  d.exec(`CREATE TRIGGER boom BEFORE UPDATE ON partial_invoices WHEN NEW.invoice_letter = 'B' BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;`);
  const errs = [];
  const realErr = console.error; console.error = (...a) => { errs.push(a.join(' ')); };
  try { dbm.migratePartialInvoicesSchema(d); } finally { console.error = realErr; }
  const nulls = d.prepare('SELECT invoice_letter FROM partial_invoices WHERE backordered_json IS NULL ORDER BY id').all().map(r => r.invoice_letter);
  assert.deepEqual(nulls, ['A', 'B'], 'letter A\'s write rolled back with B\'s failure');
  assert.ok(errs.some(e => /BACKFILL FAILED/.test(e) && /simulated disk failure/.test(e)), `no loud error: ${errs.join(' | ')}`);
  // Next start, once the cause is gone: both are frozen.
  d.exec('DROP TRIGGER boom');
  dbm.migratePartialInvoicesSchema(d);
  const by = Object.fromEntries(d.prepare('SELECT invoice_letter, backordered_json FROM partial_invoices').all().map(r => [r.invoice_letter, JSON.parse(r.backordered_json).map(x => x.sku)]));
  assert.deepEqual(by, { A: ['ONE'], B: ['ONE'] });
  d.close();
});

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
