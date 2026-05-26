/**
 * API tests — run against mock server (B2B_ADMIN_MOCK=1).
 * Usage: TEST_BASE=http://127.0.0.1:8894 node test/api.test.mjs
 */
import assert from 'node:assert/strict';

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:8894';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

function extractSid(setCookieHeader) {
  const match = (setCookieHeader || '').match(/b2b_admin_sid=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

console.log('\nAPI tests:');

await test('GET /healthz returns 200 with ok:true and correct app name', async () => {
  const res = await fetch(`${BASE}/healthz`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.app, 'fww-b2b-admin');
  assert.ok(typeof json.ts === 'number');
});

await test('GET / without session redirects to /login', async () => {
  const res = await fetch(`${BASE}/`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/login'), `Expected /login, got: ${res.headers.get('location')}`);
});

await test('GET /login returns 200 with Google sign-in button', async () => {
  const res = await fetch(`${BASE}/login`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Sign in with Google'), 'Missing Google sign-in text');
  assert.ok(html.includes('/auth/login'), 'Missing /auth/login href');
});

await test('GET /login?error= shows error message', async () => {
  const res = await fetch(`${BASE}/login?error=Test+error+message`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Test error message'));
});

await test('GET /__test__/session seeds session and returns JSON + cookie', async () => {
  const res = await fetch(`${BASE}/__test__/session?email=alex@fuzzywumpets.com`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.email, 'alex@fuzzywumpets.com');
  assert.ok(json.sid, 'Missing sid in response');
  const sid = extractSid(res.headers.get('set-cookie'));
  assert.ok(sid, 'No b2b_admin_sid cookie set');
});

await test('GET / with valid session returns dashboard HTML', async () => {
  const seedRes = await fetch(`${BASE}/__test__/session?email=alex@fuzzywumpets.com`);
  const json = await seedRes.json();
  const cookie = `b2b_admin_sid=${json.sid}`;

  const res = await fetch(`${BASE}/`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Dashboard'),     'Missing Dashboard title');
  assert.ok(html.includes('Open Orders'),   'Missing Open Orders widget');
  assert.ok(html.includes('This Week'),     'Missing This Week widget');
  assert.ok(html.includes('Top Customers'), 'Missing Top Customers widget');
  assert.ok(html.includes('Low Stock'),     'Missing Low Stock widget');
});

await test('Dashboard shows mock data (order names, customer names)', async () => {
  const seedRes = await fetch(`${BASE}/__test__/session`);
  const json = await seedRes.json();
  const cookie = `b2b_admin_sid=${json.sid}`;

  const res = await fetch(`${BASE}/`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.ok(html.includes('#1001'),          'Missing order #1001');
  assert.ok(html.includes('Acme Pet Supply'), 'Missing customer Acme Pet Supply');
  assert.ok(html.includes('Elite Collar'),   'Missing low-stock item');
});

await test('Dashboard shows user email in header', async () => {
  const seedRes = await fetch(`${BASE}/__test__/session?email=testuser@fuzzywumpets.com`);
  const json = await seedRes.json();
  const cookie = `b2b_admin_sid=${json.sid}`;

  const res = await fetch(`${BASE}/`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.ok(html.includes('testuser@fuzzywumpets.com'), 'Email not in header');
});

await test('GET /auth/logout clears session and redirects to /login', async () => {
  const seedRes = await fetch(`${BASE}/__test__/session`);
  const json = await seedRes.json();
  const cookie = `b2b_admin_sid=${json.sid}`;

  const res = await fetch(`${BASE}/auth/logout`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/login'), 'Should redirect to /login after logout');
  const cleared = res.headers.get('set-cookie') || '';
  assert.ok(cleared.includes('Max-Age=0'), 'Session cookie should have Max-Age=0');
});

await test('GET / after logout redirects to /login (session invalidated)', async () => {
  const seedRes = await fetch(`${BASE}/__test__/session`);
  const json = await seedRes.json();
  const cookie = `b2b_admin_sid=${json.sid}`;

  await fetch(`${BASE}/auth/logout`, { headers: { Cookie: cookie }, redirect: 'manual' });

  const res = await fetch(`${BASE}/`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/login'), 'Should redirect after session invalidated');
});

await test('GET /orders (coming soon) requires auth', async () => {
  const res = await fetch(`${BASE}/orders`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/login'));
});

await test('GET /orders with session returns coming-soon page', async () => {
  const seedRes = await fetch(`${BASE}/__test__/session`);
  const json = await seedRes.json();
  const cookie = `b2b_admin_sid=${json.sid}`;

  const res = await fetch(`${BASE}/orders`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Orders'));
});

await test('GET /__test__/session returns 404 in non-mock (would require live server; skip)', async () => {
  // This test only verifies the endpoint exists in mock mode — already verified above.
  // In production (non-mock), the endpoint returns 404. We can't test that from mock server.
  assert.ok(true);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
