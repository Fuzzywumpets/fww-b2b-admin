// Standalone suite: the "payment received" email to the owner, driven through the REAL Admin routes.
//
// Boots the REAL (non-MOCK) server on a free port in a throwaway data dir with test/fixtures/fake-shopify-markpaid.mjs
// preloaded (fake Shopify; no network, never the live admin.db) and an in-process FAKE PORTAL on 127.0.0.1 standing in for
// POST /__internal__/payment-notice (the Portal owns Gmail; its own tests cover the mail). What this pins is the Admin side:
//   * a staff Mark Paid (Orders list bulk, order page) and a Record payment each ask the Portal for ONE notice, with the
//     order name / current total from Shopify, the staff member as actor, the internal bearer, and NO recipient / link / token;
//   * it is sent only for orders Shopify really marked paid, and only AFTER their audit rows exist;
//   * a double submit sends once; a refused or empty action sends nothing;
//   * FAIL-OPEN: a Portal that 502s, 404s, or never answers cannot fail or delay the payment, and the failure is audited
//     as payment_notice_failed; a Portal "skipped" (staff member is the recipient) is not a failure.
// MOCK cannot do this (it never calls Shopify or the Portal), hence the real server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FAKE = pathToFileURL(path.join(ROOT, 'test', 'fixtures', 'fake-shopify-markpaid.mjs')).href;
const EMAIL = 'tester@example.com';
const PORTAL_TOKEN = 'test-portal-token';

const SHOPIFY = {
  51001: 'PENDING', 51002: 'PENDING', 51003: 'PAID', 51004: 'PENDING', 51005: 'PENDING_STICKY', 51006: 'PENDING',
  51007: 'PENDING', 51008: 'PENDING', 51009: 'PENDING', 51010: 'PENDING', 51012: 'PENDING', 51013: 'PENDING', 51014: 'PENDING',
};
const TOTALS = {
  51001: { name: '#51001', amount: '123.40' }, 51002: { name: '#51002', amount: '50.00' }, 51004: { name: '#51004', amount: '77.77' },
  51006: { name: '#51006', amount: '250.00' }, 51012: { name: '#51012', amount: '5.50' }, 51013: { name: '#51013', amount: '6.60' },
};

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${err.stack?.split('\n').slice(0, 4).join('\n      ') || err.message}`); failed++; }
}
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 5000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(50); } return !!fn(); }

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2b-paynotice-'));
const logFile = path.join(dataDir, 'bridge-calls.jsonl');
let child = null, portal = null, serverOut = '';
const heldSockets = new Set();
function stop() {
  try { child?.kill(); } catch { /* already gone */ }
  try { for (const s of heldSockets) s.destroy(); portal?.close(); } catch { /* ignore */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows file lock */ }
}
process.on('exit', stop);

// ── seed (real db.mjs, throwaway dir) BEFORE the server boots ───────────────────────────────────────────────
process.env.B2B_ADMIN_DATA_DIR = dataDir;
delete process.env.B2B_ADMIN_MOCK;
assert.ok(path.resolve(process.env.B2B_ADMIN_DATA_DIR).startsWith(path.resolve(os.tmpdir())), 'refusing to seed outside the temp dir');
const db = await import('../db.mjs');
// 51001 has a Helcim invoice on file: its token / pay URL must NEVER reach the notice request.
db.upsertHelcimInvoiceMap('gid://shopify/Order/51001', { invoiceId: '55', invoiceNumber: 'INV001003', token: 'SECRET-TOKEN-xyz', url: 'https://secure.example.test/pay/SECRET', amount: 123.4, currency: 'USD' });

const readDb = (fn) => { const d = new Database(path.join(dataDir, 'admin.db'), { readonly: true }); try { return fn(d); } finally { d.close(); } };
const auditIds = (action) => readDb(d => d.prepare('SELECT target FROM admin_audit_log WHERE action = ? ORDER BY id').all(action).map(r => r.target.split('/').pop()));
const auditRows = (action) => readDb(d => d.prepare('SELECT email, target, after_val FROM admin_audit_log WHERE action = ? ORDER BY id').all(action));

// ── the fake Portal ─────────────────────────────────────────────────────────────────────────────────────────
// mode: ok | skipped | 502 | 404 | hang | no-email. Each recorded request also snapshots which orders already had a
// `mark_paid` / `record_manual_payment` audit row AT ARRIVAL, which proves the notice goes out only after the audit write.
let mode = 'ok';
const requests = [];
portal = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    let body = null; try { body = JSON.parse(raw); } catch { /* keep null */ }
    requests.push({
      method: req.method, url: req.url, auth: req.headers.authorization, raw, body,
      auditedAtArrival: { mark_paid: auditIds('mark_paid'), record_manual_payment: auditIds('record_manual_payment') },
    });
    const send = (status, obj, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
    if (mode === 'hang') { heldSockets.add(req.socket); return; }             // never answer
    if (mode === '502') return send(502, { ok: false, email: { sent: false, error: 'Gmail send failed (HTTP 500)' } });
    if (mode === '404') return send(404, '<html>Cannot POST /__internal__/payment-notice</html>', 'text/html');
    if (mode === 'skipped') return send(200, { ok: true, email: { sent: false, skipped: 'actor_is_recipient' } });
    if (mode === 'no-email') return send(200, { ok: true });
    return send(200, { ok: true, email: { sent: true, via: 'gmail', id: 'fake-1' } });
  });
});
await new Promise(r => portal.listen(0, '127.0.0.1', r));
const portalBase = `http://127.0.0.1:${portal.address().port}`;

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
child = spawn(process.execPath, ['--import', FAKE, 'server.mjs'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PORT: String(port), B2B_ADMIN_MOCK: '', B2B_ADMIN_DATA_DIR: dataDir,
    B2B_ADMIN_ALLOW_TEST_SESSION: '1', B2B_ADMIN_ALLOWED_EMAILS: EMAIL,
    SHOPIFY_BRIDGE_BEARER: '',
    B2B_PORTAL_INTERNAL_URL: portalBase, B2B_PORTAL_INTERNAL_TOKEN: PORTAL_TOKEN, PAYMENT_NOTICE_DISABLED: '',
    FAKE_MARKPAID_LOG: logFile, FAKE_MARKPAID_ORDERS: JSON.stringify(SHOPIFY), FAKE_MARKPAID_TOTALS: JSON.stringify(TOTALS),
    FAKE_MARKPAID_ALLOW_URL: portalBase,
  },
});
child.stdout.on('data', d => { serverOut += d; }); child.stderr.on('data', d => { serverOut += d; });
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* not up yet */ }
  await sleep(250);
  if (i === 79) { console.log(`  ✗ server did not start:\n${serverOut}`); process.exit(1); }
}
const sess = await fetch(`${base}/__test__/session?email=${encodeURIComponent(EMAIL)}`);
const sid = (sess.headers.get('set-cookie') || '').match(/b2b_admin_sid=([^;]+)/)?.[1];
assert.ok(sid, 'no session cookie');

// An array value becomes a repeated key, exactly like the checked `ids` boxes of the real bulk form.
const encodeForm = (body) => new URLSearchParams(Object.entries(body).flatMap(([k, v]) => (Array.isArray(v) ? v.map(x => [k, x]) : [[k, v]]))).toString();
const form = (route, body, cookie = `b2b_admin_sid=${sid}`) => fetch(`${base}${route}`, {
  method: 'POST', redirect: 'manual',
  headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: encodeForm(body),
});
const loc = (res) => decodeURIComponent(res.headers.get('location') || '');
const bridgeCalls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const markCalls = (id) => bridgeCalls().filter(c => c.op === 'orderMarkAsPaid' && c.id === String(id)).length;
const noticeCount = () => requests.filter(r => r.url === '/__internal__/payment-notice').length;
async function expectNoNotice(label) { const before = noticeCount(); await sleep(700); assert.equal(noticeCount(), before, label); }

console.log('\n  Payment-received notice (real Admin server, fake Shopify, fake Portal)');

await test('Orders list Mark Paid on 2 orders = ONE digest request: name + current total from Shopify, the staff actor, the internal bearer, no recipient / link / token', async () => {
  mode = 'ok';
  const res = await form('/orders/bulk', { action: 'mark-paid', ids: ['51001', '51002'] });
  assert.equal(res.status, 302);
  assert.ok(loc(res).includes('success=marked_paid'), loc(res));
  assert.ok(await waitFor(() => noticeCount() >= 1), 'the Portal never received a notice');
  await sleep(300);
  assert.equal(noticeCount(), 1, 'one digest for the whole bulk action, not one mail per order');
  const r = requests[0];
  assert.equal(r.method, 'POST'); assert.equal(r.url, '/__internal__/payment-notice');
  assert.equal(r.auth, `Bearer ${PORTAL_TOKEN}`);
  assert.deepEqual(r.body, {
    source: 'mark_paid_bulk', actorEmail: EMAIL,
    orders: [{ orderId: '51001', orderName: '#51001', amount: 123.4, currency: 'USD' }, { orderId: '51002', orderName: '#51002', amount: 50, currency: 'USD' }],
  });
  assert.ok(!/SECRET|secure\.example|helcim|INV0010/i.test(r.raw), 'no Helcim token / pay URL / invoice number may leave Admin: ' + r.raw);
  assert.deepEqual(r.auditedAtArrival.mark_paid.sort(), ['51001', '51002'], 'the notice must go out only AFTER the audit rows exist');
});

await test('a bulk action with one refused order announces only the order Shopify really marked paid', async () => {
  const before = noticeCount();
  const res = await form('/orders/bulk', { action: 'mark-paid', ids: ['51003', '51012'] });     // 51003 is already PAID in Shopify
  assert.ok(loc(res).includes('error=mark_paid_partial'), loc(res));
  assert.ok(await waitFor(() => noticeCount() > before));
  const r = requests.filter(x => x.url === '/__internal__/payment-notice').at(-1);
  assert.deepEqual(r.body.orders.map(o => o.orderId), ['51012']);
  assert.equal(r.body.orders[0].amount, 5.5);
});

await test('nothing marked paid (all refused / no ids / unknown action) = no request at all', async () => {
  await form('/orders/bulk', { action: 'mark-paid', ids: '51003' });
  await expectNoNotice('a refused order must not be announced');
  await form('/orders/bulk', { action: 'mark-paid' });
  await expectNoNotice('no ids');
  await form('/orders/bulk', { action: 'frobnicate', ids: '51013' });
  await expectNoNotice('unknown action');
  assert.equal(markCalls(51013), 0);
});

await test('Mark Paid on the order page sends ONE notice (source mark_paid) after the audit row', async () => {
  const before = noticeCount();
  const res = await form('/orders/51004/mark-paid', {});
  assert.equal(res.status, 302);
  assert.ok(loc(res).includes('success=marked_paid'), loc(res));
  assert.ok(await waitFor(() => noticeCount() > before));
  const r = requests.filter(x => x.url === '/__internal__/payment-notice').at(-1);
  assert.deepEqual(r.body, { source: 'mark_paid', actorEmail: EMAIL, orders: [{ orderId: '51004', orderName: '#51004', amount: 77.77, currency: 'USD' }] });
  assert.ok(r.auditedAtArrival.mark_paid.includes('51004'));
});

await test('Mark Paid refused by Shopify on the order page (already paid) sends nothing', async () => {
  const res = await form('/orders/51003/mark-paid', {});
  assert.ok(loc(res).includes('error='), loc(res));
  await expectNoNotice('Shopify refused: no payment, no mail');
});

await test('IDEMPOTENT: a double submit that gets past Shopify twice still sends ONE notice (order + source + amount)', async () => {
  const before = noticeCount();
  const [a, b] = await Promise.all([form('/orders/51005/mark-paid', {}), form('/orders/51005/mark-paid', {})]);
  assert.ok(loc(a).includes('success=marked_paid') && loc(b).includes('success=marked_paid'));
  assert.equal(markCalls(51005), 2, 'the fake Shopify accepted BOTH clicks, so only the notifier can stop the second mail');
  await sleep(900);
  assert.equal(noticeCount() - before, 1, 'one mail for one payment');
});

await test('Record payment sends ONE notice (source record_payment) with the method and the fresh outstanding balance', async () => {
  const before = noticeCount();
  const res = await form('/orders/51006/record-payment', { paymentMethod: 'Cheque #1182', note: 'deposited Monday' });
  assert.ok(loc(res).includes('success=payment_recorded'), loc(res));
  assert.ok(await waitFor(() => noticeCount() > before));
  const r = requests.filter(x => x.url === '/__internal__/payment-notice').at(-1);
  assert.deepEqual(r.body, {
    source: 'record_payment', actorEmail: EMAIL, paymentMethod: 'Cheque #1182',
    orders: [{ orderId: '51006', orderName: '#51006', amount: 250, currency: 'USD' }],
  });
  assert.ok(r.auditedAtArrival.record_manual_payment.includes('51006'));
  assert.ok(!r.raw.includes('deposited Monday'), 'the free-text note is not part of the notice');
});

await test('Record payment without a method (or on an order with no balance) sends nothing', async () => {
  const noMethod = await form('/orders/51007/record-payment', { paymentMethod: '' });
  assert.ok(loc(noMethod).includes('error=method_required'), loc(noMethod));
  const paid = await form('/orders/51003/record-payment', { paymentMethod: 'Wire' });
  assert.ok(loc(paid).includes('error=payment_failed'), loc(paid));
  await expectNoNotice('nothing was recorded');
});

await test('an unauthenticated POST is bounced to login and sends nothing', async () => {
  const res = await form('/orders/51007/mark-paid', {}, 'b2b_admin_sid=nope');
  assert.ok(loc(res).includes('/login') || res.status === 401 || res.status === 403, `${res.status} ${loc(res)}`);
  assert.equal(markCalls(51007), 0);
  await expectNoNotice('no session, no mail');
});

await test('FAIL-OPEN: a Portal 502 does not fail the payment; the failure is audited as payment_notice_failed with the order', async () => {
  mode = '502';
  const before = noticeCount();
  const res = await form('/orders/51007/mark-paid', {});
  assert.ok(loc(res).includes('success=marked_paid'), 'the payment must still report success: ' + loc(res));
  assert.ok(await waitFor(() => auditRows('payment_notice_failed').some(r => r.target.endsWith('/51007'))), 'failure row expected; server said: ' + serverOut.slice(-400));
  assert.equal(noticeCount() - before, 1);
  const row = auditRows('payment_notice_failed').find(r => r.target.endsWith('/51007'));
  assert.equal(row.email, EMAIL);
  const after = JSON.parse(row.after_val);
  assert.equal(after.source, 'mark_paid'); assert.deepEqual(after.orderIds, ['51007']);
  assert.match(after.error, /Gmail send failed/);
  assert.ok(auditIds('mark_paid').includes('51007'), 'the payment audit row itself is intact');
});

await test('FAIL-OPEN: an older Portal without the route (404 html) is also just audited; the next payment is unaffected', async () => {
  mode = '404';
  const res = await form('/orders/51010/mark-paid', {});
  assert.ok(loc(res).includes('success=marked_paid'), loc(res));
  assert.ok(await waitFor(() => auditRows('payment_notice_failed').some(r => r.target.endsWith('/51010'))));
  mode = 'ok';
  const before = noticeCount();
  const next = await form('/orders/51013/mark-paid', {});
  assert.ok(loc(next).includes('success=marked_paid'));
  assert.ok(await waitFor(() => noticeCount() > before), 'notices resume once the Portal answers again');
});

await test('FAIL-OPEN: a Portal reply that does not confirm a send ({ok:true} with no email) counts as a failure, not a delivery', async () => {
  mode = 'no-email';
  const res = await form('/orders/51014/mark-paid', {});
  assert.ok(loc(res).includes('success=marked_paid'));
  assert.ok(await waitFor(() => auditRows('payment_notice_failed').some(r => r.target.endsWith('/51014'))));
  mode = 'ok';
});

await test('FAIL-OPEN: a Portal that never answers cannot delay the payment redirect (the notice is not awaited)', async () => {
  mode = 'hang';
  const t0 = Date.now();
  const res = await form('/orders/51008/mark-paid', {});
  const ms = Date.now() - t0;
  assert.ok(loc(res).includes('success=marked_paid'), loc(res));
  assert.ok(ms < 5000, `redirect took ${ms} ms - the hung Portal call must not be awaited`);
  assert.ok(await waitFor(() => requests.some(r => r.body?.orders?.[0]?.orderId === '51008')), 'the request was made');
  assert.ok(auditIds('mark_paid').includes('51008'));
  mode = 'ok';
});

await test('a Portal "skipped" (the staff member is the recipient) is not a failure: no payment_notice_failed row', async () => {
  mode = 'skipped';
  const res = await form('/orders/51009/mark-paid', {});
  assert.ok(loc(res).includes('success=marked_paid'));
  assert.ok(await waitFor(() => requests.some(r => r.body?.orders?.[0]?.orderId === '51009')));
  await sleep(500);
  assert.ok(!auditRows('payment_notice_failed').some(r => r.target.endsWith('/51009')), 'skipped is intentional, not an error');
  mode = 'ok';
});

await test('the server never logged the bearer or a Helcim token while doing all of this', () => {
  assert.ok(!serverOut.includes(PORTAL_TOKEN), 'bearer in server output');
  assert.ok(!/SECRET-TOKEN/.test(serverOut), 'Helcim token in server output');
});

stop();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
