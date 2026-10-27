// Standalone DB-level suite for the Helcim paid-sync columns + ledger functions (no server).
//
// Why standalone: the migration runs when db.mjs is IMPORTED and only matters against a file that already holds the OLD
// helcim_invoice_map (live admin.db has rows from real sends) — the mock HTTP server uses a fresh in-memory DB, so it can never
// prove that an existing database survives. The claim / state / poll-list SQL is also only reachable here without a server.
//
// SAFETY: db.mjs is pointed at a throwaway directory through B2B_ADMIN_DATA_DIR BEFORE it is imported, and B2B_ADMIN_MOCK is cleared
// so it opens that FILE. The test refuses to run if the handle did not land inside the temp dir — it can never touch data/admin.db.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const here = path.dirname(fileURLToPath(import.meta.url));
const DB_URL = pathToFileURL(path.join(here, '..', 'db.mjs')).href;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b2badmin-helcim-paid-mig-'));

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${err.message}`); failed++; }
}

// ── A database exactly as the PREVIOUS release left it (helcim_invoice_map without any paid_* column) ──────────
const OLD_DDL = `
  CREATE TABLE helcim_invoice_map (
    order_id TEXT PRIMARY KEY,
    invoice_id TEXT NOT NULL,
    invoice_number TEXT,
    token TEXT NOT NULL,
    url TEXT NOT NULL,
    amount REAL NOT NULL,
    currency TEXT NOT NULL,
    delivery_status TEXT NOT NULL DEFAULT 'created',
    delivery_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`;
// Verbatim from the previous db.mjs upsertHelcimInvoiceMap / setHelcimInvoiceDelivery — what a rolled-back release will run.
const OLD_UPSERT = `
    INSERT INTO helcim_invoice_map
      (order_id, invoice_id, invoice_number, token, url, amount, currency, delivery_status, delivery_error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'created', NULL, ?, ?)
    ON CONFLICT(order_id) DO UPDATE SET
      invoice_id=excluded.invoice_id, invoice_number=excluded.invoice_number, token=excluded.token,
      url=excluded.url, amount=excluded.amount, currency=excluded.currency,
      delivery_status='created', delivery_error=NULL, updated_at=excluded.updated_at
  `;
const OLD_DELIVERY = 'UPDATE helcim_invoice_map SET delivery_status = ?, delivery_error = ?, updated_at = ? WHERE order_id = ?';
const NEW_COLS = ['paid_state', 'paid_amount', 'helcim_status', 'paid_checked_at', 'paid_synced_at', 'paid_note'];

const O1 = 'gid://shopify/Order/40089';
const NOW = 1_800_000_000_000;
const STALE = 10 * 60 * 1000;
const seed = new Database(path.join(tmp, 'admin.db'));
seed.exec(OLD_DDL);
seed.prepare(OLD_UPSERT).run(O1, '73759349', 'INV001002', 'tok-secret', 'https://fuzzywumpets.myhelcim.com/order/?token=tok-secret', 1, 'USD', NOW - 1000, NOW - 1000);
seed.close();

process.env.B2B_ADMIN_DATA_DIR = tmp;
delete process.env.B2B_ADMIN_MOCK;
const dbm = await import(DB_URL);
const db = dbm.default;
if (!path.resolve(db.name).startsWith(path.resolve(tmp))) {
  console.error(`REFUSING to run: db opened ${db.name}, not the scratch dir ${tmp}`);
  process.exit(2);
}
const cols = () => db.prepare('PRAGMA table_info(helcim_invoice_map)').all();
const add = (orderId, { createdAt = NOW - 1000, invoiceId = String(Math.floor(Math.random() * 1e6)) } = {}) => {
  db.prepare(OLD_UPSERT).run(orderId, invoiceId, 'INV-X', 'tok', 'https://fuzzywumpets.myhelcim.com/order/?token=tok', 25, 'USD', createdAt, createdAt);
  return orderId;
};
const state = (orderId) => dbm.getHelcimInvoiceMap(orderId);

console.log('\n  helcim_invoice_map paid-sync migration (old-schema database)');

await test('importing db.mjs adds every paid_* column to an old-schema table', () => {
  const names = cols().map(c => c.name);
  for (const c of NEW_COLS) assert.ok(names.includes(c), `missing column ${c}`);
});

await test('every new column is nullable with no default (so an old INSERT/UPDATE still works)', () => {
  const by = Object.fromEntries(cols().map(c => [c.name, c]));
  for (const c of NEW_COLS) { assert.equal(by[c].notnull, 0, `${c} must be nullable`); assert.equal(by[c].dflt_value, null, `${c} must have no default`); }
});

await test('the pre-existing row survives untouched with a null sync state', () => {
  const r = dbm.getHelcimInvoiceMap(O1);
  assert.equal(r.invoice_id, '73759349');
  assert.equal(r.invoice_number, 'INV001002');
  assert.equal(r.amount, 1);
  assert.equal(r.currency, 'USD');
  assert.equal(r.delivery_status, 'created');
  for (const c of NEW_COLS) assert.equal(r[c], null, c);
});

await test('ROLLBACK SAFETY: the previous release\'s INSERT, ON CONFLICT UPDATE and delivery UPDATE still run on the migrated table', () => {
  const o = 'gid://shopify/Order/40090';
  db.prepare(OLD_UPSERT).run(o, '111', 'INV-A', 't1', 'https://fuzzywumpets.myhelcim.com/order/?token=t1', 10, 'USD', NOW, NOW);
  db.prepare(OLD_UPSERT).run(o, '222', 'INV-B', 't2', 'https://fuzzywumpets.myhelcim.com/order/?token=t2', 12, 'USD', NOW + 1, NOW + 1);
  db.prepare(OLD_DELIVERY).run('sent', null, NOW + 2, o);
  const r = dbm.getHelcimInvoiceMap(o);
  assert.equal(r.invoice_id, '222');
  assert.equal(r.delivery_status, 'sent');
  assert.equal(r.paid_state, null);
});

await test('running the migration again is a no-op (same columns, no error)', () => {
  const before = JSON.stringify(cols());
  dbm.migrateHelcimInvoiceMapSchema(db);
  dbm.migrateHelcimInvoiceMapSchema(db);
  assert.equal(JSON.stringify(cols()), before);
  assert.ok(dbm.getHelcimInvoiceMap(O1), 'row still there');
});

await test('a second process start over the already-migrated file is clean and keeps the data', () => {
  const script = `
    const m = await import(${JSON.stringify(DB_URL)});
    const cols = m.default.prepare('PRAGMA table_info(helcim_invoice_map)').all().map(c => c.name);
    const row = m.getHelcimInvoiceMap('gid://shopify/Order/40089');
    console.log(JSON.stringify({ n: cols.length, invoice: row.invoice_id }));
  `;
  const env = { ...process.env, B2B_ADMIN_DATA_DIR: tmp }; delete env.B2B_ADMIN_MOCK;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const j = JSON.parse(out.stdout.trim().split('\n').pop());
  assert.equal(j.n, cols().length);
  assert.equal(j.invoice, '73759349');
});

await test('a brand-new database (no prior table) ends up with the identical column set', () => {
  const script = `
    const m = await import(${JSON.stringify(DB_URL)});
    console.log(JSON.stringify(m.default.prepare('PRAGMA table_info(helcim_invoice_map)').all().map(c => c.name)));
  `;
  const env = { ...process.env, B2B_ADMIN_MOCK: '1' };
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const fresh = JSON.parse(out.stdout.trim().split('\n').pop()).sort();
  assert.deepEqual(fresh, cols().map(c => c.name).sort());
});

console.log('\n  claimHelcimPaymentSync');

await test('a NULL-state row is claimed once; a second claim loses', () => {
  const o = add('gid://shopify/Order/50001');
  assert.equal(dbm.claimHelcimPaymentSync(o, NOW, STALE), true);
  assert.equal(state(o).paid_state, 'syncing');
  assert.equal(state(o).paid_checked_at, NOW);
  assert.equal(dbm.claimHelcimPaymentSync(o, NOW + 1000, STALE), false, 'a fresh claim must not be stolen');
});

await test('an expired claim (interrupted sync) can be taken over; a claim exactly at the boundary cannot', () => {
  const o = add('gid://shopify/Order/50002');
  assert.equal(dbm.claimHelcimPaymentSync(o, NOW, STALE), true);
  assert.equal(dbm.claimHelcimPaymentSync(o, NOW + STALE, STALE), false, 'age == staleMs is still held');
  assert.equal(dbm.claimHelcimPaymentSync(o, NOW + STALE + 1, STALE), true, 'older than staleMs is taken over');
  assert.equal(state(o).paid_checked_at, NOW + STALE + 1);
});

await test('needs_review and error rows are claimable again (staff re-check / retry)', () => {
  for (const s of ['needs_review', 'error']) {
    const o = add(`gid://shopify/Order/5001-${s}`);
    dbm.setHelcimPaymentState(o, { paid_state: s, paid_checked_at: NOW });
    assert.equal(dbm.claimHelcimPaymentSync(o, NOW + 5, STALE), true, s);
  }
});

await test('paid_synced and already_paid rows are FINISHED: never claimable', () => {
  for (const s of ['paid_synced', 'already_paid']) {
    const o = add(`gid://shopify/Order/5002-${s}`);
    dbm.setHelcimPaymentState(o, { paid_state: s, paid_checked_at: NOW });
    assert.equal(dbm.claimHelcimPaymentSync(o, NOW + STALE * 10, STALE), false, s);
    assert.equal(state(o).paid_state, s, 'state unchanged by the failed claim');
  }
});

await test('claiming an order with no ledger row is false, not an error', () => {
  assert.equal(dbm.claimHelcimPaymentSync('gid://shopify/Order/404', NOW, STALE), false);
});

console.log('\n  setHelcimPaymentState');

await test('writes only the paid_* columns and returns the updated row', () => {
  const o = add('gid://shopify/Order/50100');
  const before = state(o);
  const after = dbm.setHelcimPaymentState(o, { paid_state: 'paid_synced', paid_amount: 25, helcim_status: 'PAID', paid_checked_at: NOW, paid_synced_at: NOW, paid_note: null });
  assert.equal(after.paid_state, 'paid_synced');
  assert.equal(after.paid_amount, 25);
  assert.equal(after.helcim_status, 'PAID');
  assert.equal(after.paid_synced_at, NOW);
  for (const c of ['invoice_id', 'invoice_number', 'token', 'url', 'amount', 'currency', 'delivery_status', 'created_at', 'updated_at']) {
    assert.equal(after[c], before[c], `${c} must not change`);
  }
});

await test('rejects unknown columns (a typo must not silently skip a write) and can never reach invoice identity', () => {
  const o = add('gid://shopify/Order/50101');
  for (const bad of [{ invoice_id: '1' }, { token: 'x' }, { url: 'x' }, { amount: 1 }, { delivery_status: 'sent' }, { 'paid_state = NULL, token': 'x' }, { paid_stat: 'error' }]) {
    assert.throws(() => dbm.setHelcimPaymentState(o, bad), TypeError, JSON.stringify(bad));
  }
  assert.throws(() => dbm.setHelcimPaymentState(o, {}), TypeError);
  assert.equal(state(o).token, 'tok');
});

await test('paid_state must be null or a known state', () => {
  const o = add('gid://shopify/Order/50102');
  assert.throws(() => dbm.setHelcimPaymentState(o, { paid_state: 'paid' }), TypeError);
  assert.throws(() => dbm.setHelcimPaymentState(o, { paid_state: '' }), TypeError);
  dbm.setHelcimPaymentState(o, { paid_state: 'needs_review' });
  assert.equal(dbm.setHelcimPaymentState(o, { paid_state: null }).paid_state, null, 'null resets (unpaid)');
});

await test('paid_note is capped at 500 characters', () => {
  const o = add('gid://shopify/Order/50103');
  assert.equal(dbm.setHelcimPaymentState(o, { paid_note: 'x'.repeat(900) }).paid_note.length, 500);
});

await test('SQL in a value is data, not code', () => {
  const o = add('gid://shopify/Order/50104');
  dbm.setHelcimPaymentState(o, { paid_note: "x'; DROP TABLE helcim_invoice_map; --" });
  assert.equal(state(o).paid_note, "x'; DROP TABLE helcim_invoice_map; --");
  assert.ok(state(O1), 'table and other rows intact');
});

await test('re-sending a DIFFERENT invoice for an order clears its paid verdict (it belongs to one invoice)', () => {
  const o = add('gid://shopify/Order/50105', { invoiceId: '900' });
  dbm.setHelcimPaymentState(o, { paid_state: 'paid_synced', paid_amount: 25, helcim_status: 'PAID', paid_checked_at: NOW, paid_synced_at: NOW, paid_note: 'n' });
  dbm.upsertHelcimInvoiceMap(o, { invoiceId: '901', invoiceNumber: 'INV-901', token: 't9', url: 'https://fuzzywumpets.myhelcim.com/order/?token=t9', amount: 30, currency: 'USD' });
  const r = state(o);
  assert.equal(r.invoice_id, '901');
  for (const c of NEW_COLS) assert.equal(r[c], null, c);
});

console.log('\n  listHelcimInvoicesForPaymentSync');

// A clean ledger so the assertions below see only their own rows.
db.exec('DELETE FROM helcim_invoice_map');
const DAY = 24 * 60 * 60 * 1000;
const ids = (rows) => rows.map(r => r.order_id);
const list = (opts = {}) => dbm.listHelcimInvoicesForPaymentSync({ limit: 50, nowMs: NOW, staleMs: STALE, ...opts });

await test('a never-checked fresh invoice is due; one checked a minute ago is not; one checked 5 minutes ago is', () => {
  const never = add('gid://shopify/Order/60001', { createdAt: NOW - 2 * 60 * 1000 });
  const recent = add('gid://shopify/Order/60002', { createdAt: NOW - 20 * 60 * 1000 });
  const older = add('gid://shopify/Order/60003', { createdAt: NOW - 20 * 60 * 1000 });
  dbm.setHelcimPaymentState(recent, { paid_checked_at: NOW - 60 * 1000 });
  dbm.setHelcimPaymentState(older, { paid_checked_at: NOW - 5 * 60 * 1000 });
  const due = ids(list());
  assert.ok(due.includes(never));
  assert.ok(!due.includes(recent), 'checked 1 min ago: too soon');
  assert.ok(due.includes(older), 'checked 5 min ago: due');
});

await test('an invoice older than 3 days is polled hourly, not every 4 minutes', () => {
  const aged = add('gid://shopify/Order/60004', { createdAt: NOW - 4 * DAY });
  dbm.setHelcimPaymentState(aged, { paid_checked_at: NOW - 30 * 60 * 1000 });
  assert.ok(!ids(list()).includes(aged), 'checked 30 min ago, aged: not yet');
  dbm.setHelcimPaymentState(aged, { paid_checked_at: NOW - 61 * 60 * 1000 });
  assert.ok(ids(list()).includes(aged), 'checked 61 min ago, aged: due');
});

await test('an invoice older than the 90-day horizon is left to staff (manual check only)', () => {
  const ancient = add('gid://shopify/Order/60005', { createdAt: NOW - 91 * DAY });
  assert.ok(!ids(list()).includes(ancient));
});

await test('finished and human-owned rows are never polled: paid_synced, already_paid, needs_review', () => {
  for (const s of ['paid_synced', 'already_paid', 'needs_review']) {
    const o = add(`gid://shopify/Order/6001-${s}`, { createdAt: NOW - 20 * 60 * 1000 });
    dbm.setHelcimPaymentState(o, { paid_state: s, paid_checked_at: NOW - 3 * 60 * 60 * 1000 });
    assert.ok(!ids(list()).includes(o), s);
  }
});

await test('error rows are retried (after the gap) and a live syncing claim is skipped but an expired one is picked up', () => {
  const err = add('gid://shopify/Order/60021', { createdAt: NOW - 20 * 60 * 1000 });
  dbm.setHelcimPaymentState(err, { paid_state: 'error', paid_checked_at: NOW - 5 * 60 * 1000 });
  const live = add('gid://shopify/Order/60022', { createdAt: NOW - 20 * 60 * 1000 });
  dbm.setHelcimPaymentState(live, { paid_state: 'syncing', paid_checked_at: NOW - 5 * 60 * 1000 });
  const dead = add('gid://shopify/Order/60023', { createdAt: NOW - 20 * 60 * 1000 });
  dbm.setHelcimPaymentState(dead, { paid_state: 'syncing', paid_checked_at: NOW - STALE - 1000 });
  const due = ids(list());
  assert.ok(due.includes(err), 'error retried');
  assert.ok(!due.includes(live), 'a running sync is left alone');
  assert.ok(due.includes(dead), 'an interrupted sync is retried');
});

await test('delivery_failed invoices are still polled (the customer may have got the link anyway)', () => {
  const o = add('gid://shopify/Order/60031', { createdAt: NOW - 20 * 60 * 1000 });
  dbm.setHelcimInvoiceDelivery(o, 'delivery_failed', 'Portal did not confirm');
  assert.ok(ids(list()).includes(o));
});

await test('ordering is least-recently-checked first (never-checked leading) and the limit is honoured', () => {
  db.exec('DELETE FROM helcim_invoice_map');
  const a = add('gid://shopify/Order/60041', { createdAt: NOW - 60 * 60 * 1000 });
  const b = add('gid://shopify/Order/60042', { createdAt: NOW - 60 * 60 * 1000 });
  const c = add('gid://shopify/Order/60043', { createdAt: NOW - 60 * 60 * 1000 });
  dbm.setHelcimPaymentState(a, { paid_checked_at: NOW - 30 * 60 * 1000 });
  dbm.setHelcimPaymentState(b, { paid_checked_at: NOW - 10 * 60 * 1000 });
  assert.deepEqual(ids(list()), [c, a, b]);
  assert.deepEqual(ids(list({ limit: 2 })), [c, a]);
});

await test('the limit is clamped to 1..100 so a bad caller cannot burst the Helcim API', () => {
  for (let i = 0; i < 105; i++) add(`gid://shopify/Order/7${String(i).padStart(4, '0')}`, { createdAt: NOW - 60 * 60 * 1000 });
  assert.equal(list({ limit: -5 }).length, 1);
  assert.equal(list({ limit: 1_000_000 }).length, 100);
  assert.equal(list({ limit: 'abc' }).length, 20, 'a non-number falls back to the default 20');
});

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n  HELCIM-PAID-MIGRATION: ${passed} passed, ${failed} failed${failed === 0 ? ' ✓' : ''}`);
process.exit(failed === 0 ? 0 : 1);
