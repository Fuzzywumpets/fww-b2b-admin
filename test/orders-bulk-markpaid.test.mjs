// Standalone suite: ticking orders on the Orders list and pressing "Mark Paid" (POST /orders/bulk).
//
// THE REPORT (2026-10-27, Alex, screenshot of the Electron admin): after Mark Paid the page came back with the
// green "Order(s) marked as paid." banner - and the order he had just marked (#39748) still said PENDING, with a
// "0 selected" bar. Prod evidence (admin_audit_log + the Shopify orders/updated webhook rows) shows Shopify DID mark
// #39748 and #39930 paid; the list was simply stale: GET /orders is served from orders_cache, which only the
// Shopify webhook (2-3 s after the mutation) and the 3-minute poller refresh, while /orders/bulk redirects at once.
// Two smaller defects rode along: the bulk bar was never hidden (`.bulk-bar{display:flex}` beat the `hidden`
// attribute, so "0 selected" + a live Mark Paid button were always on screen), and a request that marked nothing
// (no ids, or an unknown action) still redirected with the SUCCESS banner.
//
// WHY standalone: B2B_ADMIN_MOCK=1 never calls Shopify and the list only takes the orders_cache path when NOT
// mocked, so the mock HTTP suite cannot even express this. This boots the REAL (non-MOCK) server in a throwaway
// data dir with test/fixtures/fake-shopify-markpaid.mjs preloaded (no network, never the live admin.db) and drives
// a REAL Chromium through the real form: tick checkbox -> click Mark Paid -> read the page the server sends back.
// The fake deliberately never delivers the webhook, so a green here means the response itself tells the truth.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FAKE = pathToFileURL(path.join(ROOT, 'test', 'fixtures', 'fake-shopify-markpaid.mjs')).href;
const EMAIL = 'tester@example.com';

// Shopify's truth (the fake) and what orders_cache believes (seeded below). 40003 is the drift case: the cache
// still says PENDING but Shopify already has it PAID, so Shopify refuses the second Mark Paid.
const SHOPIFY = { 40001: 'PENDING', 40002: 'PENDING', 40003: 'PAID', 40004: 'PAID', 40005: 'PENDING' };
const CACHED = [
  { id: 40001, status: 'PENDING' }, { id: 40002, status: 'PENDING' }, { id: 40003, status: 'PENDING' }, { id: 40004, status: 'PAID' },
];   // 40005 exists in Shopify but is NOT in orders_cache on purpose (fail-open: nothing to write through to)

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${err.stack?.split('\n').slice(0, 4).join('\n      ') || err.message}`); failed++; }
}
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2b-markpaid-'));
const logFile = path.join(dataDir, 'bridge-calls.jsonl');
let child = null, browser = null, serverOut = '';
function stop() {
  try { child?.kill(); } catch { /* already gone */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows file lock */ }
}
process.on('exit', stop);

// ── seed orders_cache through the real db.mjs, in a throwaway data dir, BEFORE the server boots ──────────────
// Guarded: db.mjs opens <B2B_ADMIN_DATA_DIR>/admin.db, so refuse to import it unless that is our temp dir.
process.env.B2B_ADMIN_DATA_DIR = dataDir;
delete process.env.B2B_ADMIN_MOCK;
assert.ok(path.resolve(process.env.B2B_ADMIN_DATA_DIR).startsWith(path.resolve(os.tmpdir())), 'refusing to seed outside the temp dir');
const db = await import('../db.mjs');
db.upsertCustomerCache({ shopify_id: '9001', gid: 'gid://shopify/Customer/9001', email: 'buyer@example.com', display_name: 'Test Buyer', tags: ['b2b'], created_at: Date.now() });
const now = Date.now();
CACHED.forEach((o, i) => db.upsertOrderCache({
  shopify_id: String(o.id), gid: `gid://shopify/Order/${o.id}`, name: `#${o.id}`, customer_shopify_id: '9001',
  created_at: now - i * 60_000, processed_at: now - i * 60_000, updated_at: now - i * 60_000,
  financial_status: o.status, display_financial_status: o.status, fulfillment_status: 'UNFULFILLED',
  total_price: 10 + i, currency: 'USD',
}));
// For the "marked paid manually" note: 40002 already carries a staff note (must be appended to, never replaced) and
// 40001 has a Helcim invoice on file (its number may appear in the note; its token/pay URL must never).
db.setOrderInternalNote('40002', 'Customer asked for net-30', 'sam@example.com');
db.upsertHelcimInvoiceMap('gid://shopify/Order/40001', { invoiceId: '55', invoiceNumber: 'INV001003', token: 'SECRET-TOKEN-xyz', url: 'https://secure.example.test/pay/SECRET', amount: 10, currency: 'USD' });

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
child = spawn(process.execPath, ['--import', FAKE, 'server.mjs'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PORT: String(port), B2B_ADMIN_MOCK: '', B2B_ADMIN_DATA_DIR: dataDir,       // real code path, throwaway sqlite
    B2B_ADMIN_ALLOW_TEST_SESSION: '1', B2B_ADMIN_ALLOWED_EMAILS: EMAIL,
    SHOPIFY_BRIDGE_BEARER: '',                                                  // pollers stay off; the fake never forwards anything
    FAKE_MARKPAID_LOG: logFile, FAKE_MARKPAID_ORDERS: JSON.stringify(SHOPIFY),
  },
});
child.stdout.on('data', d => { serverOut += d; }); child.stderr.on('data', d => { serverOut += d; });
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* not up yet */ }
  await new Promise(r => setTimeout(r, 250));
  if (i === 79) { console.log(`  ✗ server did not start:\n${serverOut}`); process.exit(1); }
}
const sess = await fetch(`${base}/__test__/session?email=${encodeURIComponent(EMAIL)}`);
const sid = (sess.headers.get('set-cookie') || '').match(/b2b_admin_sid=([^;]+)/)?.[1];
assert.ok(sid, 'no session cookie');

const calls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const markCalls = () => calls().filter(c => c.op === 'orderMarkAsPaid').map(c => c.id);
const fakeState = () => JSON.parse(fs.readFileSync(`${logFile}.state.json`, 'utf8'));
const readDb = (fn) => { const d = new Database(path.join(dataDir, 'admin.db'), { readonly: true }); try { return fn(d); } finally { d.close(); } };
const auditPaid = () => readDb(d => d.prepare("SELECT target FROM admin_audit_log WHERE action = 'mark_paid' ORDER BY id").all().map(r => r.target.split('/').pop()));
const cachedStatus = (id) => readDb(d => d.prepare('SELECT financial_status FROM orders_cache WHERE shopify_id = ?').get(String(id))?.financial_status);
const internalNote = (id) => readDb(d => d.prepare('SELECT body, updated_by FROM order_internal_notes WHERE order_id = ?').get(String(id)));
const post = (body) => fetch(`${base}/orders/bulk`, {
  method: 'POST', redirect: 'manual',
  headers: { Cookie: `b2b_admin_sid=${sid}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});

browser = await chromium.launch({ headless: true });
async function openOrders() {
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  const page = await ctx.newPage();
  await page.goto(`${base}/orders`);
  await page.waitForSelector('#bulk-form');
  return { ctx, page };
}
const payment = (page) => page.$$eval('tbody tr', trs => Object.fromEntries(
  trs.filter(tr => tr.querySelector('.order-link')).map(tr => [tr.querySelector('.order-link').textContent.trim(), tr.querySelector('td:nth-child(7) .badge')?.textContent.trim()])));
const alerts = (page) => page.$$eval('.alert', els => els.map(e => ({ cls: e.className, text: e.textContent.trim() })));

console.log('\n  Orders list: tick + Mark Paid (real server, fake Shopify, real Chromium form submit)');

await test('the bulk bar is HIDDEN until a row is ticked (display:flex used to beat the hidden attribute)', async () => {
  const { ctx, page } = await openOrders();
  try {
    assert.equal(await page.isVisible('#bulk-bar'), false, 'bulk bar (with "0 selected" and a live Mark Paid button) must not show on load');
    await page.check('input[name=ids][value="40001"]');
    assert.equal(await page.isVisible('#bulk-bar'), true, 'bar must appear once a row is ticked');
    assert.equal((await page.textContent('#bulk-count')).trim(), '1 selected');
    await page.uncheck('input[name=ids][value="40001"]');
    assert.equal(await page.isVisible('#bulk-bar'), false, 'bar must hide again when nothing is ticked');
  } finally { await ctx.close(); }
});

await test('REGRESSION: the page that comes back after Mark Paid already shows the orders PAID (no wait for the webhook)', async () => {
  const { ctx, page } = await openOrders();
  try {
    const before = await payment(page);
    assert.equal(before['#40001'], 'PENDING'); assert.equal(before['#40002'], 'PENDING');
    await page.check('input[name=ids][value="40001"]');
    await page.check('input[name=ids][value="40002"]');
    const [resp] = await Promise.all([
      page.waitForNavigation({ url: /\/orders\?/ }),
      page.click('button[name=action][value=mark-paid]'),
    ]);
    assert.ok(resp, 'form submit must navigate');
    const posted = markCalls();
    assert.deepEqual(posted, ['40001', '40002'], 'Shopify must have been asked to mark exactly the ticked orders');
    assert.equal(fakeState()['40001'], 'PAID');
    const rows = await payment(page);
    assert.equal(rows['#40001'], 'PAID', 'the order the banner says was paid must not still say PENDING: ' + JSON.stringify(rows));
    assert.equal(rows['#40002'], 'PAID', 'same for the second ticked order: ' + JSON.stringify(rows));
    assert.equal(rows['#40004'], 'PAID', 'an untouched PAID order stays PAID');
    const banners = await alerts(page);
    assert.ok(banners.some(b => b.cls.includes('alert-success') && b.text.includes('marked as paid')), 'success banner expected: ' + JSON.stringify(banners));
    assert.deepEqual(auditPaid(), ['40001', '40002'], 'one mark_paid audit row per order that really moved');
    assert.equal(cachedStatus(40001), 'PAID');
  } finally { await ctx.close(); }
});

await test('a refused order (Shopify says already paid) shows the ERROR banner, is not audit-logged, and no success banner appears', async () => {
  const { ctx, page } = await openOrders();
  try {
    const auditBefore = auditPaid().length;
    await page.check('input[name=ids][value="40003"]');
    await Promise.all([page.waitForNavigation({ url: /\/orders\?/ }), page.click('button[name=action][value=mark-paid]')]);
    const banners = await alerts(page);
    assert.ok(banners.some(b => b.cls.includes('alert-error') && /#40003/.test(b.text)), 'error banner naming #40003 expected: ' + JSON.stringify(banners));
    assert.ok(!banners.some(b => b.cls.includes('alert-success')), 'must not claim success: ' + JSON.stringify(banners));
    assert.equal(auditPaid().length, auditBefore, 'a refused order must not be audit-logged as paid');
  } finally { await ctx.close(); }
});

// ALEX 2026-10-27: "a note left that it was parked paid manually". Mark Paid writes one line into the Admin-only
// order note (NOT the Shopify note, which holds customer instructions). By this point 40001 and 40002 were marked
// paid by the REGRESSION test above and 40003 was refused.
await test('Mark Paid leaves a "Marked paid manually by <who>" line in the Admin-only note; a refused order gets none', () => {
  const n1 = internalNote(40001);
  assert.ok(n1, 'order 40001 was marked paid, so it needs a note');
  assert.match(n1.body, /^\[\d{4}-\d\d-\d\d \d\d:\d\d UTC\] Marked paid manually by tester@example\.com/, n1.body);
  assert.equal(n1.updated_by, EMAIL);
  assert.ok(n1.body.includes('INV001003') && /not check/i.test(n1.body), 'a linked Helcim invoice is named, and the note says it was not checked: ' + n1.body);
  assert.ok(!n1.body.includes('SECRET') && !n1.body.includes('http'), 'the Helcim token / pay URL must never reach a note: ' + n1.body);
  const n2 = internalNote(40002);
  assert.ok(n2.body.startsWith('Customer asked for net-30\n'), 'an existing staff note must be kept, not replaced: ' + n2.body);
  assert.ok(/Marked paid manually by tester@example\.com/.test(n2.body), n2.body);
  assert.ok(!/helcim/i.test(n2.body), 'no Helcim invoice on 40002, so no Helcim wording: ' + n2.body);
  assert.equal(internalNote(40003), undefined, 'Shopify refused 40003 (already paid): it must not be annotated as marked paid');
});

await test('a request that marks nothing never gets the success banner (no ids)', async () => {
  const before = markCalls().length;
  const res = await post({ action: 'mark-paid' });
  assert.equal(res.status, 302);
  const loc = decodeURIComponent(res.headers.get('location') || '');
  assert.ok(!loc.includes('success=marked_paid'), 'nothing was marked: ' + loc);
  assert.ok(loc.includes('error=mark_paid_none'), 'tell the operator nothing was selected: ' + loc);
  assert.equal(markCalls().length, before, 'no Shopify call without ids');
  const page = await fetch(`${base}${res.headers.get('location')}`, { headers: { Cookie: `b2b_admin_sid=${sid}` } });
  const html = await page.text();
  assert.ok(html.includes('No orders selected'), 'the list must say why nothing happened');
  assert.ok(!html.includes('Order(s) marked as paid.'));
});

await test('a request with an unknown action never gets the success banner and never calls Shopify', async () => {
  const before = markCalls().length;
  const res = await post({ action: 'frobnicate', ids: '40005' });
  assert.equal(res.status, 302);
  const loc = decodeURIComponent(res.headers.get('location') || '');
  assert.ok(!loc.includes('success=marked_paid'), 'unknown action must not claim success: ' + loc);
  assert.ok(loc.includes('error=bulk_unknown_action'), loc);
  assert.equal(markCalls().length, before, 'an unknown action must not mark anything');
  const html = await (await fetch(`${base}${res.headers.get('location')}`, { headers: { Cookie: `b2b_admin_sid=${sid}` } })).text();
  assert.ok(html.includes('alert-error') && !html.includes('Order(s) marked as paid.'));
});

await test('FAIL-OPEN: an order that is in Shopify but not in orders_cache still marks paid and reports success', async () => {
  const res = await post({ action: 'mark-paid', ids: '40005' });
  assert.equal(res.status, 302);
  assert.ok(decodeURIComponent(res.headers.get('location') || '').includes('success=marked_paid'), res.headers.get('location'));
  assert.equal(fakeState()['40005'], 'PAID');
  assert.ok(auditPaid().includes('40005'));
  assert.equal(cachedStatus(40005), undefined, 'the write-through must not invent a cache row');
  assert.ok(!/write-through failed/.test(serverOut), 'a missing cache row is normal, not an error: ' + serverOut);
  assert.match(internalNote(40005)?.body || '', /Marked paid manually by/, 'the note does not depend on the cache row existing');
});

await browser.close();
stop();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
