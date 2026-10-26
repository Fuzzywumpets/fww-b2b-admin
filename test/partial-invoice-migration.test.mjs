// Standalone DB-level suite for partial_invoices.backordered_json (no server).
//
// Why standalone: the column is added when db.mjs is IMPORTED and only matters against a file that already holds
// the OLD schema + issued invoices — the mock HTTP server uses a fresh in-memory DB, so it can never prove that
// the live database (with invoices already issued, e.g. #39875-A and -B) survives, or that a rollback is safe.
// Same pattern as test/backorder-migration.test.mjs.
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
// Verbatim from the previous db.mjs createPartialInvoice — what a rolled-back release will run.
const OLD_INSERT = `
    INSERT INTO partial_invoices (order_id, invoice_letter, invoice_type, total, shipping, tax, line_items_json, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
const ORDER = 'gid://shopify/Order/18948052451563';
const LINES_A = JSON.stringify([{ id: 'gid://shopify/LineItem/1', title: 'Collar', quantity: 118, unitPrice: 37.97 }]);
const seed = new Database(path.join(tmp, 'admin.db'));
seed.exec(OLD_DDL);
seed.prepare(OLD_INSERT).run(ORDER, 'A', 'full', 4481.67, 0, 0, LINES_A, Date.parse('2026-10-26T20:46:58.685Z'), 'staff@fww');
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

console.log('\n  partial_invoices.backordered_json migration (old-schema database)');

await test('importing db.mjs adds backordered_json to the old-schema table, as a NULLABLE TEXT column with no default', () => {
  const c = cols().find(x => x.name === 'backordered_json');
  assert.ok(c, 'column missing');
  assert.equal(c.type, 'TEXT');
  assert.equal(c.notnull, 0);
  assert.equal(c.dflt_value, null);
});

await test('the already-issued invoice survives untouched and reads as LEGACY (NULL, not "[]")', () => {
  const [a] = dbm.getPartialInvoices(ORDER);
  assert.equal(a.invoice_letter, 'A');
  assert.equal(a.total, 4481.67);
  assert.equal(a.line_items_json, LINES_A);
  assert.equal(a.created_at, Date.parse('2026-10-26T20:46:58.685Z'));
  assert.equal(a.backordered_json, null, 'NULL is what marks a snapshot as legacy');
});

await test('ROLLBACK SAFETY: the previous release\'s INSERT (explicit columns, no backordered_json) still runs on the migrated table', () => {
  db.prepare(OLD_INSERT).run(ORDER, 'B', 'full', 4331.67, 0, 0, '[]', Date.parse('2026-10-26T21:47:21.315Z'), 'rb@fww');
  const b = dbm.getPartialInvoices(ORDER).find(r => r.invoice_letter === 'B');
  assert.equal(b.total, 4331.67);
  assert.equal(b.backordered_json, null, 'a row written by the old release is legacy-shaped');
  assert.equal(dbm.getNextInvoiceLetter(ORDER), 'C');
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

await test('running the migration again is a no-op (same columns, no error, data kept)', () => {
  const before = JSON.stringify(cols());
  dbm.migratePartialInvoicesSchema(db);
  dbm.migratePartialInvoicesSchema(db);
  assert.equal(JSON.stringify(cols()), before);
  assert.equal(dbm.getPartialInvoices(ORDER)[0].total, 4481.67);
});

await test('a second process start (restart) over the already-migrated file is clean and keeps the data', () => {
  const script = `
    const m = await import(${JSON.stringify(DB_URL)});
    const cols = m.default.prepare('PRAGMA table_info(partial_invoices)').all().map(c => c.name);
    console.log(JSON.stringify({ n: cols.length, has: cols.includes('backordered_json'), letters: m.getPartialInvoices(${JSON.stringify(ORDER)}).map(r => r.invoice_letter) }));
  `;
  const env = { ...process.env, B2B_ADMIN_DATA_DIR: tmp }; delete env.B2B_ADMIN_MOCK;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const j = JSON.parse(out.stdout.trim().split('\n').pop());
  assert.equal(j.n, cols().length);
  assert.equal(j.has, true);
  assert.deepEqual(j.letters, ['A', 'B']);
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

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
