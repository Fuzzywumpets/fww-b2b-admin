// Standalone DB-level suite for the backorders table (no server).
//
// Why standalone: the migration runs when db.mjs is IMPORTED and only matters against a file that already
// holds the OLD schema + rows — the mock HTTP server uses a fresh in-memory DB, so it can never prove that an
// existing live database survives. Same reasoning for the SQL state machine (claim / finalize / abandon /
// begin / revert / restore): it is plain SQL the HTTP suite only reaches indirectly.
//
// SAFETY: db.mjs is pointed at a throwaway directory through B2B_ADMIN_DATA_DIR BEFORE it is imported, and
// B2B_ADMIN_MOCK is cleared so it opens that FILE (which is what a migration test needs). The test refuses to
// run if the handle did not land inside the temp dir — it can never touch the real data/admin.db.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const here = path.dirname(fileURLToPath(import.meta.url));
const DB_MODULE = path.join(here, '..', 'db.mjs');
const DB_URL = pathToFileURL(DB_MODULE).href;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b2badmin-backorder-mig-'));

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${err.message}`); failed++; }
}

// ── Build a database exactly as the PREVIOUS release left it ─────────────────────────────────────
const OLD_DDL = `
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
  );`;
// Verbatim from the previous db.mjs upsertBackorder — what a rolled-back release will run.
const OLD_UPSERT = `
    INSERT INTO backorders (order_id, line_item_id, line_item_title, quantity, eta_date, status, created_at, created_by, notified)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 0)
    ON CONFLICT(order_id, line_item_id) DO UPDATE SET
      eta_date = excluded.eta_date, quantity = excluded.quantity, status = 'pending',
      created_at = excluded.created_at, created_by = excluded.created_by
  `;
const seed = new Database(path.join(tmp, 'admin.db'));
seed.exec(OLD_DDL);
seed.prepare(OLD_UPSERT).run('gid://shopify/Order/9001', 'li-old', 'Legacy Collar', 3, '2026-07-01', 1700000000000, 'old@fww');
seed.close();

process.env.B2B_ADMIN_DATA_DIR = tmp;
delete process.env.B2B_ADMIN_MOCK;
const dbm = await import(DB_URL);
const db = dbm.default;
if (!path.resolve(db.name).startsWith(path.resolve(tmp))) {
  console.error(`REFUSING to run: db opened ${db.name}, not the scratch dir ${tmp}`);
  process.exit(2);
}

const NEW_COLS = ['variant_id', 'sku', 'variant_title', 'unit_price', 'currency', 'shopify_removed_qty', 'restored_at', 'claim_prior_qty'];
const cols = () => db.prepare('PRAGMA table_info(backorders)').all();
const OLD = 'gid://shopify/Order/9001';

console.log('\n  backorders migration (old-schema database)');

await test('importing db.mjs adds every new column to an old-schema table', () => {
  const names = cols().map(c => c.name);
  for (const c of NEW_COLS) assert.ok(names.includes(c), `missing column ${c}`);
});

await test('shopify_removed_qty is NOT NULL DEFAULT 0 and every other new column is nullable', () => {
  const by = Object.fromEntries(cols().map(c => [c.name, c]));
  assert.equal(by.shopify_removed_qty.notnull, 1);
  assert.equal(String(by.shopify_removed_qty.dflt_value), '0');
  for (const c of NEW_COLS.filter(n => n !== 'shopify_removed_qty')) assert.equal(by[c].notnull, 0, `${c} must be nullable`);
});

await test('the pre-existing old-style row survives untouched and reads as a legacy flag-only row', () => {
  const r = dbm.getBackorderRow(OLD, 'li-old');
  assert.equal(r.line_item_title, 'Legacy Collar');
  assert.equal(r.quantity, 3);
  assert.equal(r.eta_date, '2026-07-01');
  assert.equal(r.status, 'pending');
  assert.equal(r.created_by, 'old@fww');
  assert.equal(r.shopify_removed_qty, 0);
  for (const c of ['variant_id', 'sku', 'variant_title', 'unit_price', 'currency', 'restored_at', 'claim_prior_qty']) assert.equal(r[c], null, c);
});

await test('legacy flag-only rows keep working in the queue readers', () => {
  assert.ok(dbm.getOpenBackorders().some(r => r.line_item_id === 'li-old'), '/backorders queue still lists it');
  assert.ok(dbm.getBackordersForOrder(OLD).some(r => r.line_item_id === 'li-old'), 'order page badge still sees it');
});

await test('legacy flag-only rows are NOT returned by getBackorderedLinesForOrder (never struck through)', () => {
  assert.deepEqual(dbm.getBackorderedLinesForOrder(OLD), []);
});

await test('ROLLBACK SAFETY: the previous release\'s INSERT and ON CONFLICT UPDATE still run on the migrated table', () => {
  db.prepare(OLD_UPSERT).run('gid://shopify/Order/9002', 'li-rb', 'Rollback Leash', 2, null, 1700000001000, 'rb@fww');
  db.prepare(OLD_UPSERT).run('gid://shopify/Order/9002', 'li-rb', 'Rollback Leash', 5, '2026-08-01', 1700000002000, 'rb2@fww');
  const r = dbm.getBackorderRow('gid://shopify/Order/9002', 'li-rb');
  assert.equal(r.quantity, 5);
  assert.equal(r.status, 'pending');
  assert.equal(r.shopify_removed_qty, 0);
});

await test('running the migration again is a no-op (same columns, no error)', () => {
  const before = JSON.stringify(cols());
  dbm.migrateBackordersSchema(db);
  dbm.migrateBackordersSchema(db);
  assert.equal(JSON.stringify(cols()), before);
  assert.ok(dbm.getBackorderRow(OLD, 'li-old'), 'row still there');
});

await test('a second process start (restart) over the already-migrated file is clean and keeps the data', () => {
  const script = `
    const m = await import(${JSON.stringify(DB_URL)});
    const cols = m.default.prepare('PRAGMA table_info(backorders)').all().map(c => c.name);
    const row = m.getBackorderRow('gid://shopify/Order/9001', 'li-old');
    console.log(JSON.stringify({ n: cols.length, qty: row.quantity, removed: row.shopify_removed_qty }));
  `;
  const env = { ...process.env, B2B_ADMIN_DATA_DIR: tmp }; delete env.B2B_ADMIN_MOCK;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const j = JSON.parse(out.stdout.trim().split('\n').pop());
  assert.equal(j.n, cols().length);
  assert.equal(j.qty, 3);
  assert.equal(j.removed, 0);
});

await test('a brand-new database (no prior table) ends up with the identical column set', () => {
  const script = `
    const m = await import(${JSON.stringify(DB_URL)});
    console.log(JSON.stringify(m.default.prepare('PRAGMA table_info(backorders)').all().map(c => c.name)));
  `;
  const env = { ...process.env, B2B_ADMIN_MOCK: '1' };
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const fresh = JSON.parse(out.stdout.trim().split('\n').pop()).sort();
  assert.deepEqual(fresh, cols().map(c => c.name).sort());
});

// ── The state machine ────────────────────────────────────────────────────────────────────────────
console.log('\n  backorders lifecycle (claim → finalize → undo)');
const snap = (o = {}) => ({
  orderId: 'gid://shopify/Order/9100', lineItemId: 'gid://shopify/LineItem/1', title: 'Elite Collar', variantId: 'gid://shopify/ProductVariant/55',
  sku: 'EC-1', variantTitle: 'Small / Navy', unitPrice: '18.00', currency: 'USD', quantity: 4, priorQty: 10,
  createdBy: 'a@fww', now: 1700000100000, ...o,
});

await test('claim → the row is invisible to every reader until Shopify confirms (finalize)', () => {
  const c = dbm.claimBackorderRemoval(snap());
  assert.deepEqual([c.ok, c.prev], [true, null]);
  const r = dbm.getBackorderRow('gid://shopify/Order/9100', 'gid://shopify/LineItem/1');
  assert.equal(r.status, 'applying');
  assert.equal(r.shopify_removed_qty, 0, 'not counted as removed yet');
  assert.deepEqual(dbm.getBackorderedLinesForOrder('gid://shopify/Order/9100'), []);
  assert.ok(!dbm.getOpenBackorders().some(x => x.order_id === 'gid://shopify/Order/9100'));
  assert.ok(!dbm.getBackordersForOrder('gid://shopify/Order/9100').length);
  assert.ok(dbm.getTransientBackorders().some(x => x.order_id === 'gid://shopify/Order/9100'), 'listed for reconcile');
});

await test('finalize → getBackorderedLinesForOrder returns the exact documented shape', () => {
  assert.equal(dbm.finalizeBackorderRemoval('gid://shopify/Order/9100', 'gid://shopify/LineItem/1'), true);
  const [l, ...rest] = dbm.getBackorderedLinesForOrder('gid://shopify/Order/9100');
  assert.equal(rest.length, 0);
  assert.deepEqual(l, {
    lineItemId: 'gid://shopify/LineItem/1', variantId: 'gid://shopify/ProductVariant/55', sku: 'EC-1', title: 'Elite Collar',
    variantTitle: 'Small / Navy', quantity: 4, unitPrice: 18, currency: 'USD', lineTotal: 72,
    createdAt: 1700000100000, createdBy: 'a@fww',
  });
  assert.ok(!('etaDate' in l), 'the expected ship date was removed from the contract');
  assert.equal(dbm.getBackorderRow('gid://shopify/Order/9100', 'gid://shopify/LineItem/1').eta_date, null, 'and is never written');
  assert.equal(typeof l.unitPrice, 'number');
  assert.ok(dbm.getOpenBackorders().some(x => x.order_id === 'gid://shopify/Order/9100'), 'the queue lists it');
});

await test('lineTotal is rounded to 2dp and lines come back oldest first', () => {
  const o = 'gid://shopify/Order/9101';
  dbm.claimBackorderRemoval(snap({ orderId: o, lineItemId: 'b', unitPrice: '3.33', quantity: 3, now: 2000 }));
  dbm.finalizeBackorderRemoval(o, 'b');
  dbm.claimBackorderRemoval(snap({ orderId: o, lineItemId: 'a', unitPrice: '1.10', quantity: 1, now: 1000 }));
  dbm.finalizeBackorderRemoval(o, 'a');
  const lines = dbm.getBackorderedLinesForOrder(o);
  assert.deepEqual(lines.map(l => l.lineItemId), ['a', 'b']);
  assert.equal(lines[1].lineTotal, 9.99);
  assert.ok(lines.every(l => !('etaDate' in l)));
});

await test('a claim over a LEGACY row that carried an ETA clears it; abandoning hands the legacy row back verbatim', () => {
  const o = 'gid://shopify/Order/9150';
  dbm.upsertBackorder(o, 'legacy-eta', 'Legacy Collar', 2, '2026-07-01', 'old@fww');
  const c = dbm.claimBackorderRemoval(snap({ orderId: o, lineItemId: 'legacy-eta', quantity: 2 }));
  assert.equal(c.ok, true);
  assert.equal(dbm.getBackorderRow(o, 'legacy-eta').eta_date, null, 'the new claim carries no ETA');
  dbm.abandonBackorderClaim(o, 'legacy-eta', c.prev);
  const back = dbm.getBackorderRow(o, 'legacy-eta');
  assert.deepEqual([back.status, back.eta_date, back.shopify_removed_qty], ['pending', '2026-07-01', 0], 'old data is restored exactly');
});

await test('a live removed row refuses a second claim (no accumulation)', () => {
  const c = dbm.claimBackorderRemoval(snap());
  assert.equal(c.ok, false);
  assert.equal(c.reason, 'already_backordered');
  assert.equal(dbm.getBackorderRow('gid://shopify/Order/9100', 'gid://shopify/LineItem/1').status, 'pending');
});

await test('abandon removes a claim that created the row, and restores the legacy row it overwrote verbatim', () => {
  const o = 'gid://shopify/Order/9102';
  const c1 = dbm.claimBackorderRemoval(snap({ orderId: o, lineItemId: 'x' }));
  assert.equal(dbm.abandonBackorderClaim(o, 'x', c1.prev), true);
  assert.equal(dbm.getBackorderRow(o, 'x'), null, 'no record claims the line is backordered');
  // legacy flag-only row, then a claim over it, then the claim is abandoned
  dbm.upsertBackorder(o, 'y', 'Legacy', 2, '2026-01-01', 'old@fww');
  const before = dbm.getBackorderRow(o, 'y');
  const c2 = dbm.claimBackorderRemoval(snap({ orderId: o, lineItemId: 'y' }));
  assert.equal(c2.ok, true);
  assert.equal(c2.prev.status, 'pending');
  dbm.abandonBackorderClaim(o, 'y', c2.prev);
  assert.deepEqual(dbm.getBackorderRow(o, 'y'), before);
});

await test('abandon only ever touches a row still in applying', () => {
  const o = 'gid://shopify/Order/9100', l = 'gid://shopify/LineItem/1';
  assert.equal(dbm.abandonBackorderClaim(o, l, null), false, 'a finalized row must not be deleted');
  assert.equal(dbm.getBackorderRow(o, l).status, 'pending');
});

await test('fulfillBackorder clears a LEGACY row but never a row whose units were removed from Shopify', () => {
  const o = 'gid://shopify/Order/9100', l = 'gid://shopify/LineItem/1';
  dbm.fulfillBackorder(o, l);
  assert.equal(dbm.getBackorderRow(o, l).status, 'pending', 'shipping the remainder must not drop removed units');
  assert.equal(dbm.getBackorderedLinesForOrder(o).length, 1);
  dbm.fulfillBackorder(OLD, 'li-old');
  assert.equal(dbm.getBackorderRow(OLD, 'li-old').status, 'fulfilled', 'legacy behaviour unchanged');
});

await test('fulfillBackorder leaves an in-flight claim alone', () => {
  const o = 'gid://shopify/Order/9103';
  dbm.claimBackorderRemoval(snap({ orderId: o, lineItemId: 'z' }));
  dbm.fulfillBackorder(o, 'z');
  assert.equal(dbm.getBackorderRow(o, 'z').status, 'applying');
});

await test('legacy upsertBackorder cannot clobber a removed row or an in-flight claim', () => {
  const o = 'gid://shopify/Order/9100', l = 'gid://shopify/LineItem/1';
  dbm.upsertBackorder(o, l, 'Hijack', 99, '2030-01-01', 'evil@fww');
  const r = dbm.getBackorderRow(o, l);
  assert.equal(r.quantity, 4);
  assert.equal(r.shopify_removed_qty, 4);
  assert.equal(r.line_item_title, 'Elite Collar');
  dbm.upsertBackorder('gid://shopify/Order/9103', 'z', 'Hijack', 99, null, 'evil@fww');
  assert.equal(dbm.getBackorderRow('gid://shopify/Order/9103', 'z').quantity, 4);
});

await test('undo: begin → restoring (hidden), revert → pending again, restore → restored', () => {
  const o = 'gid://shopify/Order/9100', l = 'gid://shopify/LineItem/1';
  assert.equal(dbm.beginBackorderRestore(o, l, 10), true);
  const r = dbm.getBackorderRow(o, l);
  assert.equal(r.status, 'restoring');
  assert.equal(r.claim_prior_qty, 10);
  assert.deepEqual(dbm.getBackorderedLinesForOrder(o), []);
  assert.equal(dbm.beginBackorderRestore(o, l, 10), false, 'cannot begin twice');
  assert.equal(dbm.revertBackorderRestore(o, l), true);
  assert.equal(dbm.getBackorderedLinesForOrder(o).length, 1);
  dbm.beginBackorderRestore(o, l, 10);
  assert.equal(dbm.restoreBackorder(o, l, 1700000200000), true);
  const done = dbm.getBackorderRow(o, l);
  assert.equal(done.status, 'restored');
  assert.equal(done.restored_at, 1700000200000);
  assert.equal(done.shopify_removed_qty, 4, 'kept as history');
  assert.deepEqual(dbm.getBackorderedLinesForOrder(o), []);
  assert.ok(!dbm.getOpenBackorders().some(x => x.order_id === o));
  assert.equal(dbm.restoreBackorder(o, l), false, 'a restored row is not restored twice');
});

await test('restoreBackorder clears a legacy flag-only row without needing Shopify', () => {
  dbm.upsertBackorder('gid://shopify/Order/9104', 'q', 'Legacy', 1, null, 'old@fww');
  assert.equal(dbm.restoreBackorder('gid://shopify/Order/9104', 'q'), true);
  assert.equal(dbm.getBackorderRow('gid://shopify/Order/9104', 'q').status, 'restored');
});

await test('a restored line can be flagged again (fresh snapshot replaces the old one)', () => {
  const o = 'gid://shopify/Order/9100', l = 'gid://shopify/LineItem/1';
  const c = dbm.claimBackorderRemoval(snap({ quantity: 2, unitPrice: '17.50', now: 1700000300000 }));
  assert.equal(c.ok, true);
  assert.equal(c.prev.status, 'restored');
  dbm.finalizeBackorderRemoval(o, l);
  const [line] = dbm.getBackorderedLinesForOrder(o);
  assert.equal(line.quantity, 2);
  assert.equal(line.unitPrice, 17.5);
  assert.equal(dbm.getBackorderRow(o, l).restored_at, null);
});

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
