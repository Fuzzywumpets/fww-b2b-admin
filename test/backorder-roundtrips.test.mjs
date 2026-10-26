// Standalone suite: how many sequential Shopify round trips an edit costs, and that the shortcuts taken to
// cut them did not loosen anything. 2026-10-26 hot-fix ("Mark backordered ... seems slow": three real clicks
// on order #39875 took 7.5-8.3 s each, about 2 s of it four redundant 118-line order reads).
//
// WHY standalone: B2B_ADMIN_MOCK=1 never calls Shopify, so the mock HTTP suites cannot see a single
// round trip. This boots the REAL (non-MOCK) server, in a throwaway data dir, with test/fixtures/
// fake-shopify-bridge.mjs preloaded: a stateful fake of the bridge worker that logs, orders and schema-validates
// every GraphQL document the server sends. Nothing here can reach live Shopify or the real admin.db.
//
// Set ROUNDTRIPS_REPORT=1 to print each scenario's call sequence and skip the exact-sequence assertions
// (used to take the "before" numbers from an older checkout; every behavioural assertion still runs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FAKE = pathToFileURL(path.join(ROOT, 'test', 'fixtures', 'fake-shopify-bridge.mjs')).href;
const REPORT = process.env.ROUNDTRIPS_REPORT === '1';
const EMAIL = 'tester@example.com';
const ORDER = '39875';
const li = (n) => `gid://shopify/LineItem/${n}`;

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${err.stack?.split('\n').slice(0, 4).join('\n      ') || err.message}`); failed++; }
}
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const tmpDirs = [], children = [];
async function startServer(extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2b-roundtrips-'));
  tmpDirs.push(dataDir);
  const logFile = path.join(dataDir, 'bridge-calls.jsonl');
  const controlFile = path.join(dataDir, 'bridge-control.json');
  fs.writeFileSync(controlFile, '{}');
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', FAKE, 'server.mjs'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port), B2B_ADMIN_MOCK: '', B2B_ADMIN_DATA_DIR: dataDir,       // real code path, throwaway sqlite
      B2B_ADMIN_ALLOW_TEST_SESSION: '1', B2B_ADMIN_ALLOWED_EMAILS: EMAIL,
      SHOPIFY_BRIDGE_BEARER: '',                                                  // pollers stay off; the fake never forwards anything
      FAKE_BRIDGE_LOG: logFile, FAKE_BRIDGE_CONTROL: controlFile, FAKE_BRIDGE_ORDER: ORDER, FAKE_BRIDGE_LINES: '118',
      ...extraEnv,
    },
  });
  let out = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
    if (i === 79) throw new Error(`server did not start:\n${out}`);
  }
  const res = await fetch(`${base}/__test__/session?email=${encodeURIComponent(EMAIL)}`);
  const cookie = (res.headers.get('set-cookie') || '').match(/b2b_admin_sid=[^;]+/)?.[0];
  assert.ok(cookie, 'no session cookie');
  const srv = {
    base, dataDir, logFile, controlFile, cookie, getOut: () => out, mark: 0,
    control: (c) => fs.writeFileSync(controlFile, JSON.stringify(c)),
    entries: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []),
    state: () => JSON.parse(fs.readFileSync(`${logFile}.state.json`, 'utf8')),
    // Calls made since the previous call() ended - the unit every assertion below counts.
    async call(fn) {
      const startAt = srv.entries().length;
      const result = await fn();
      const calls = srv.entries().slice(startAt);
      return { result, calls, ops: calls.map(c => c.op) };
    },
    post: (route, body, { json = false } = {}) => fetch(`${base}${route}`, {
      method: 'POST', redirect: 'manual',
      headers: { Cookie: cookie, 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' },
      body: json ? JSON.stringify(body) : new URLSearchParams(body).toString(),
    }),
    ledger: (key) => {
      const db = new Database(path.join(dataDir, 'admin.db'), { readonly: true });
      try { return db.prepare('SELECT action, status, result_json FROM order_edit_action WHERE idem_key = ?').get(key) || null; }
      finally { db.close(); }
    },
    row: (lineNum) => {
      const db = new Database(path.join(dataDir, 'admin.db'), { readonly: true });
      try { return db.prepare('SELECT status, quantity, shopify_removed_qty FROM backorders WHERE order_id = ? AND line_item_id = ?').get(`gid://shopify/Order/${ORDER}`, li(lineNum)) || null; }
      finally { db.close(); }
    },
  };
  return srv;
}
function stop() {
  for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* windows file lock */ } }
}
process.on('exit', stop);

const flash = (res) => decodeURIComponent(res.headers.get('location') || '');
const flag = (srv, num, qty, token) => srv.post(`/orders/${ORDER}/backorder`, { lineItemId: li(num), quantity: String(qty), idemKey: token });
const undo = (srv, num) => srv.post(`/orders/${ORDER}/backorder/undo`, { lineItemId: li(num) });
function sequence(name, got, expected) {
  if (REPORT) { console.log(`      ROUNDTRIPS ${name}: ${got.length} calls  ${got.join(' > ')}`); return; }
  assert.deepEqual(got, expected, `${name}: round trips`);
}

// The sequences the order-edit path is allowed to make. The commit mutation itself carries the order's lines,
// so a confirmed commit needs no separate read-back; an unconfirmed one falls back to exactly one.
const FLAG = ['orderLines', 'begin', 'setQty', 'commit'];
const FLAG_FALLBACK = [...FLAG, 'orderLines'];
const UNDO_RAISE = ['orderLines', 'begin', 'setQty', 'commit'];
const UNDO_ADD = ['orderLines', 'begin', 'addVariant', 'addDiscount', 'commit'];
const AUTOSAVE = ['begin', 'setQty', 'commit', 'lineState'];

console.log('\n  backorder / edit round trips (real server, fake Shopify bridge)');
const srv = await startServer();

await test('FLAG (partial): one pre-read, begin, set quantity, commit - no second read of the order', async () => {
  const { result, ops } = await srv.call(() => flag(srv, 5000, 4, 'tok-flag-5000'));
  assert.equal(result.status, 302);
  assert.match(flash(result), /success=backorder_flagged/);
  assert.equal(srv.state()[5000].cq, 6, 'Shopify now shows 6 of 10');
  assert.deepEqual(srv.row(5000), { status: 'pending', quantity: 4, shopify_removed_qty: 4 });
  sequence('flag', ops, FLAG);
});

await test('the idempotency ledger records the commit WITHOUT the 118-line payload (nothing heavy is persisted or replayed)', () => {
  const led = srv.ledger('bo-flag-tok-39875-tok-flag-5000');
  assert.equal(led.status, 'committed');
  assert.equal(led.action, 'backorder/flag');
  const stored = JSON.parse(led.result_json);
  assert.equal(stored.ok, true);
  assert.equal(stored.lineState, undefined);
  assert.equal(stored.committedNodes, undefined);
  assert.ok(led.result_json.length < 500, `ledger row is ${led.result_json.length} bytes`);
});

await test('FLAG double submit (same hidden token) answers success with ZERO Shopify calls', async () => {
  const { result, ops } = await srv.call(() => flag(srv, 5000, 4, 'tok-flag-5000'));
  assert.match(flash(result), /success=backorder_flagged/);
  assert.deepEqual(ops, []);
  assert.equal(srv.state()[5000].cq, 6, 'not removed twice');
});

await test('UNDO (raise): the removed units come back on the existing line, same short path', async () => {
  const { result, ops } = await srv.call(() => undo(srv, 5000));
  assert.match(flash(result), /success=backorder_restored/);
  assert.equal(srv.state()[5000].cq, 10);
  assert.equal(srv.row(5000).status, 'restored');
  sequence('undo-raise', ops, UNDO_RAISE);
});

await test('UNDO (add): a fully removed line comes back as a NEW line at the stored price', async () => {
  const f = await srv.call(() => flag(srv, 5001, 10, 'tok-flag-5001'));
  assert.match(flash(f.result), /success=backorder_flagged/);
  assert.equal(srv.state()[5001].cq, 0);
  sequence('flag (full line)', f.ops, FLAG);
  const u = await srv.call(() => undo(srv, 5001));
  assert.match(flash(u.result), /success=backorder_restored/);
  const added = Object.values(srv.state()).filter(l => l.cq === 10 && l.unit === 18 && /^Re-added/.test(l.title));
  assert.equal(added.length, 1, 'exactly one re-added line, at the stored 18.00');
  assert.equal(srv.row(5001).status, 'restored');
  sequence('undo-add', u.ops, UNDO_ADD);
});

await test('FAIL CLOSED: commit response that does not confirm (stale) -> ONE independent read decides; applied edit still finalizes', async () => {
  srv.control({ commitStale: true });
  const { result, ops } = await srv.call(() => flag(srv, 5002, 3, 'tok-flag-5002'));
  srv.control({});
  assert.match(flash(result), /success=backorder_flagged/);
  assert.equal(srv.state()[5002].cq, 7);
  assert.equal(srv.row(5002).status, 'pending');
  sequence('flag, stale commit response', ops, FLAG_FALLBACK);
});

await test('FAIL CLOSED: commit response without lineItems, or with a next page, is never trusted as complete', async () => {
  srv.control({ commitNoLines: true });
  const a = await srv.call(() => flag(srv, 5003, 3, 'tok-flag-5003'));
  srv.control({ commitHasNextPage: true });
  const b = await srv.call(() => flag(srv, 5004, 3, 'tok-flag-5004'));
  srv.control({});
  for (const r of [a, b]) assert.match(flash(r.result), /success=backorder_flagged/);
  assert.equal(srv.row(5003).status, 'pending');
  assert.equal(srv.row(5004).status, 'pending');
  sequence('flag, commit response without lines', a.ops, FLAG_FALLBACK);
  sequence('flag, commit response with a next page', b.ops, FLAG_FALLBACK);
});

await test('FAIL CLOSED: a "successful" commit that changed nothing is NOT a backorder - claim abandoned, error shown, no row', async () => {
  srv.control({ commitDrops: true });
  const { result, ops } = await srv.call(() => flag(srv, 5005, 3, 'tok-flag-5005'));
  srv.control({});
  assert.match(flash(result), /error=backorder_shopify_failed/);
  assert.equal(srv.state()[5005].cq, 10, 'order untouched');
  assert.equal(srv.row(5005), null, 'no row claims the line is backordered');
  sequence('flag, commit changed nothing', ops, FLAG_FALLBACK);
});

await test('FAIL CLOSED: commit applied but the answer was a gateway timeout -> the read-back decides (still finalizes, still counted)', async () => {
  srv.control({ commitThrows: true });
  const { result, ops } = await srv.call(() => flag(srv, 5006, 3, 'tok-flag-5006'));
  srv.control({});
  assert.match(flash(result), /success=backorder_flagged/);
  assert.equal(srv.state()[5006].cq, 7);
  assert.equal(srv.row(5006).status, 'pending');
  sequence('flag, commit timed out after applying', ops, FLAG_FALLBACK);
});

await test('FAIL CLOSED: Shopify rejects the staged quantity -> nothing committed, error shown, no row, session abandoned', async () => {
  srv.control({ failSetQty: 'Line item has been fulfilled' });
  const { result, ops } = await srv.call(() => flag(srv, 5007, 3, 'tok-flag-5007'));
  srv.control({});
  assert.match(flash(result), /error=backorder_shopify_failed/);
  assert.match(flash(result), /fulfilled/);
  assert.equal(srv.state()[5007].cq, 10);
  assert.equal(srv.row(5007), null);
  assert.ok(!ops.includes('commit'), 'a failed stage must never reach orderEditCommit');
  sequence('flag, set quantity rejected', ops, ['orderLines', 'begin', 'setQty', 'orderLines']);
});

await test('FAIL CLOSED: a commit userError is surfaced and nothing is recorded as backordered', async () => {
  srv.control({ commitUserError: 'Order is locked by another edit' });
  const { result } = await srv.call(() => flag(srv, 5008, 3, 'tok-flag-5008'));
  srv.control({});
  assert.match(flash(result), /error=backorder_shopify_failed/);
  assert.equal(srv.row(5008), null);
  assert.equal(srv.state()[5008].cq, 10);
});

await test('two flags on the SAME order never interleave (per-order lock intact): begin..commit of one, then the other', async () => {
  const { result, ops } = await srv.call(async () => {
    const [a, b] = await Promise.all([flag(srv, 5010, 2, 'tok-flag-5010'), flag(srv, 5011, 2, 'tok-flag-5011')]);
    return [a, b];
  });
  for (const r of result) assert.match(flash(r), /success=backorder_flagged/);
  assert.equal(srv.state()[5010].cq, 8);
  assert.equal(srv.state()[5011].cq, 8);
  // Whichever flag won the lock, its whole begin..commit comes out before the other's begin.
  let open = false;
  for (const o of ops) {
    if (o === 'begin') { assert.equal(open, false, `a second order-edit session began before the first committed: ${ops.join(' > ')}`); open = true; }
    if (o === 'commit') { assert.equal(open, true); open = false; }
  }
  assert.equal(ops.filter(o => o === 'commit').length, 2);
  sequence('two concurrent flags', ops, [...FLAG, ...FLAG]);
});

await test('AUTOSAVE qty: still verified by the line-state read (the oracle is NOT skipped), one fewer order read', async () => {
  const { result, ops } = await srv.call(() => srv.post(`/orders/${ORDER}/line/qty`, { idemKey: 'tok-qty-5020', liId: li(5020), qty: 7 }, { json: true }));
  const body = await result.json();
  assert.equal(body.ok, true);
  assert.equal(body.line.currentQuantity, 7);
  assert.equal(srv.state()[5020].cq, 7);
  sequence('autosave qty', ops, AUTOSAVE);
});

await test('AUTOSAVE qty: a line that does not exist still answers "line not found" (fast path never invents a mapping)', async () => {
  const { result } = await srv.call(() => srv.post(`/orders/${ORDER}/line/qty`, { idemKey: 'tok-qty-nope1', liId: li(1234567), qty: 3 }, { json: true }));
  assert.equal(result.status, 422);
  assert.match(JSON.stringify(await result.json()), /line not found on order/);
  const bad = await srv.call(() => srv.post(`/orders/${ORDER}/line/qty`, { idemKey: 'tok-qty-nope2', liId: 'gid://shopify/Product/5021', qty: 3 }, { json: true }));
  assert.equal(bad.result.status, 422, 'a non-LineItem gid must not be mapped by its numeric suffix');
  assert.equal(srv.state()[5021].cq, 10);
});

await test('AUTOSAVE remove: verified by the line-state read, one fewer order read', async () => {
  const { result, ops } = await srv.call(() => srv.post(`/orders/${ORDER}/line/remove`, { idemKey: 'tok-rm-5022', liId: li(5022) }, { json: true }));
  assert.equal((await result.json()).ok, true);
  assert.equal(srv.state()[5022].cq, 0);
  sequence('autosave remove', ops, AUTOSAVE);
});

await test('every document the server sent is valid against the Admin schema snapshot (incl. the commit that carries the lines)', () => {
  const bad = srv.entries().filter(e => e.schemaErrors?.length);
  assert.deepEqual(bad.map(e => [e.op, e.schemaErrors]), []);
});

await test('the server reached for nothing but the bridge, and no call fell outside the known order-edit set', () => {
  const stray = srv.entries().filter(e => e.op === 'blocked' || e.op === 'other');
  assert.deepEqual(stray, []);
});

await test('the OK log line carries per-phase timings so the live gain can be read off journalctl', () => {
  const lines = srv.getOut().split('\n').filter(l => /\[order-edit\] OK action=backorder\/flag/.test(l));
  assert.ok(lines.length >= 1, 'no [order-edit] OK line for a backorder flag');
  assert.match(lines[0], /ms\[begin=\d+ stage=\d+ commit=\d+ verify=\d+ total=\d+\]/);
});

console.log('\n  kill switch');
const srv2 = await startServer({ B2B_BACKORDER_COMMIT_READBACK: '0' });
await test('B2B_BACKORDER_COMMIT_READBACK=0 restores the independent read-back (everything else stays lean)', async () => {
  const { result, ops } = await srv2.call(() => flag(srv2, 5000, 4, 'tok-flag-ks-1'));
  assert.match(flash(result), /success=backorder_flagged/);
  assert.equal(srv2.state()[5000].cq, 6);
  sequence('flag, read-back switched off', ops, FLAG_FALLBACK);
  assert.deepEqual(srv2.entries().filter(e => e.schemaErrors?.length), []);
});

stop();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
