// Standalone unit test for lib/edit-mode-resume.mjs (2026-10-26 hot-fix: "takes the screen out of edit mode
// after every change"). Standalone because the redirect rewrite is a pure function + a middleware that the
// HTTP suites would only exercise through the mock server's happy paths; the failure-path and "this is not an
// open redirect" cases are cheaper and sharper here. The browser half (re-entering edit mode, scroll) is in
// test/ui.test.mjs; the server wiring (Location headers of the real routes) is in test/api.test.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  KEEP_EDIT_ACTIONS, KEEP_EDIT_PATH_RE, keepEditClientPattern, wantsEditMode, withEditMode, keepEditModeRedirects, EDIT_ANCHOR,
} from '../lib/edit-mode-resume.mjs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

console.log('\nedit-mode resume (lib/edit-mode-resume.mjs):');

await test('wantsEditMode accepts only the exact string "1"', () => {
  assert.equal(wantsEditMode({ editMode: '1' }), true);
  for (const bad of ['0', '', 'true', 'yes', 1, true, [], ['1'], null, undefined]) {
    assert.equal(wantsEditMode({ editMode: bad }), false, `editMode=${JSON.stringify(bad)}`);
  }
  assert.equal(wantsEditMode(undefined), false);
  assert.equal(wantsEditMode(null), false);
  assert.equal(wantsEditMode('editMode=1'), false);
});

await test('withEditMode adds edit=1 and the line-items anchor to a success redirect', () => {
  assert.equal(withEditMode('/orders/1001?success=backorder_flagged', '1001'), '/orders/1001?success=backorder_flagged&edit=1#line-items');
  assert.equal(withEditMode('/orders/1001', '1001'), '/orders/1001?edit=1#line-items');
  assert.equal(EDIT_ANCHOR, 'line-items');
});

await test('withEditMode keeps an error redirect and its ?msg= bytes exactly as the route encoded them', () => {
  const msg = encodeURIComponent('Only 3 unit(s) of "Pinpoint Leash" — can\'t remove 5 & more');
  const url = `/orders/1002?error=backorder_shopify_failed&msg=${msg}`;
  assert.equal(withEditMode(url, '1002'), `${url}&edit=1#line-items`);
});

await test('withEditMode is idempotent and keeps an existing anchor', () => {
  const once = withEditMode('/orders/7?success=x', '7');
  assert.equal(withEditMode(once, '7'), once);
  assert.equal(withEditMode('/orders/7?success=x#notes', '7'), '/orders/7?success=x&edit=1#notes');
  assert.equal(withEditMode('/orders/7?edit=1', '7'), '/orders/7?edit=1#line-items');
});

await test('withEditMode never rewrites a redirect that leaves THIS order page (no open redirect, no cross-order bleed)', () => {
  for (const loc of [
    '/orders/2002?success=x',                 // another order
    '/orders/1001/invoice',                   // a sub-resource
    '/orders',                                // the list
    '/auth/login',
    'https://evil.example/orders/1001',       // absolute
    '//evil.example/orders/1001',             // protocol-relative
    '/orders/1001x?success=x',
  ]) assert.equal(withEditMode(loc, '1001'), loc, loc);
  assert.equal(withEditMode(undefined, '1001'), undefined);
  assert.equal(withEditMode(302, '1001'), 302);
});

await test('only edit-adjacent order actions can keep edit mode; Save, Cancel and the invoice routes cannot', () => {
  for (const a of KEEP_EDIT_ACTIONS) assert.ok(KEEP_EDIT_PATH_RE.test(`/orders/123/${a}`), a);
  for (const p of [
    '/orders/123/edit',                       // "Save changes" ends the edit session by design
    '/orders/123/cancel',
    '/orders/123/partial-invoice',
    '/orders/123/send-credit-card-invoice',
    '/orders/123/line/qty',
    '/orders/abc/backorder',
    '/orders/123/backorder/undo/extra',
    '/orders/123/',
  ]) assert.equal(KEEP_EDIT_PATH_RE.test(p), false, p);
});

await test('the browser pattern is built from the same list (nothing to hand-sync)', () => {
  const client = new RegExp(keepEditClientPattern());
  for (const p of [...KEEP_EDIT_ACTIONS.map(a => `/orders/9/${a}`), '/orders/9/edit', '/orders/9/cancel', '/orders/x/note', '/orders/9/backorder/undo']) {
    assert.equal(client.test(p), KEEP_EDIT_PATH_RE.test(p), p);
  }
});

function run(method, body, path, redirectTo) {
  const calls = [];
  const res = { redirect(...a) { calls.push(a); } };
  const req = { method, body, baseUrl: '/orders', path };
  let nexted = false;
  keepEditModeRedirects(req, res, () => { nexted = true; });
  if (redirectTo !== undefined) res.redirect(...redirectTo);
  return { nexted, calls, res };
}

await test('middleware: an opted-in POST to a kept action has its redirect rewritten (1- and 2-arg forms)', () => {
  let r = run('POST', { editMode: '1' }, '/1001/backorder', ['/orders/1001?success=backorder_flagged']);
  assert.equal(r.nexted, true);
  assert.deepEqual(r.calls, [['/orders/1001?success=backorder_flagged&edit=1#line-items']]);
  r = run('POST', { editMode: '1' }, '/1001/backorder/undo', [302, '/orders/1001?error=backorder_shopify_failed&msg=no']);
  assert.deepEqual(r.calls, [[302, '/orders/1001?error=backorder_shopify_failed&msg=no&edit=1#line-items']]);
});

await test('middleware: no opt-in, a GET, Save (/edit) or another path leaves redirect untouched', () => {
  const untouched = (method, body, path) => {
    const r = run(method, body, path, ['/orders/1001?success=x']);
    assert.equal(r.nexted, true);
    assert.deepEqual(r.calls, [['/orders/1001?success=x']], `${method} ${path} ${JSON.stringify(body)}`);
  };
  untouched('POST', {}, '/1001/backorder');
  untouched('POST', undefined, '/1001/backorder');
  untouched('POST', { editMode: '0' }, '/1001/backorder');
  untouched('GET', { editMode: '1' }, '/1001/backorder');
  untouched('POST', { editMode: '1' }, '/1001/edit');
  untouched('POST', { editMode: '1' }, '/1001/cancel');
  untouched('POST', { editMode: '1' }, '/1001/partial-invoice');
});

await test('middleware: a rewritten route cannot be steered to another order or another host', () => {
  const r = run('POST', { editMode: '1' }, '/1001/fulfill', ['/orders/2002?success=fulfilled']);
  assert.deepEqual(r.calls, [['/orders/2002?success=fulfilled']]);
  const r2 = run('POST', { editMode: '1' }, '/1001/fulfill', ['https://evil.example/']);
  assert.deepEqual(r2.calls, [['https://evil.example/']]);
});

// Source-level guards on the wiring that no unit can reach.
const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
await test('server.mjs mounts the middleware after the body parsers and before the order routes', () => {
  const mount = server.indexOf("app.use('/orders', keepEditModeRedirects)");
  assert.ok(mount > 0, 'middleware is mounted on /orders');
  assert.ok(mount > server.indexOf('app.use(express.urlencoded('), 'it must run AFTER the body parser (it reads req.body.editMode)');
  assert.ok(mount < server.indexOf("app.get('/orders/:id', requireAuth"), 'and BEFORE the first order route');
});
await test('the order page marks its Line Items card as the anchor and wires ?edit=1 to the page', () => {
  assert.match(server, /<div class="card" id="line-items">/);
  assert.match(server, /renderOrderDetail\(req\.adminSession, order, [^;]*resumeEdit:\s*req\.query\.edit === '1'/);
  assert.match(server, /rememberEditMode\(f\);\s*f\.submit\(\)/, 'the Undo button calls form.submit(), which fires no submit event, so it must opt in explicitly');
});

await test('every programmatic form.submit() on the order page opts in first (form.submit() fires no submit event)', () => {
  const a = server.indexOf('function renderOrderDetail(');
  const b = server.indexOf('\nfunction sortCustomers(', a);
  assert.ok(a > 0 && b > a, 'located renderOrderDetail');
  const page = server.slice(a, b).replace(/^\s*\/\/.*$/gm, '');   // comments may mention form.submit()
  const calls = [...page.matchAll(/\.submit\(\)/g)];
  assert.ok(calls.length >= 3, `expected the Undo button and the two note Delete buttons, found ${calls.length}`);
  for (const m of calls) {
    const before = page.slice(Math.max(0, m.index - 140), m.index);
    assert.ok(/rememberEditMode\([\w.]+\);\s*[\w.]+$/.test(before), `a .submit() without rememberEditMode just before it: …${before.slice(-90)}`);
  }
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
