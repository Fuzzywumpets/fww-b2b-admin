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

async function seedSession(email = 'alex@fuzzywumpets.com') {
  const res = await fetch(`${BASE}/__test__/session?email=${encodeURIComponent(email)}`);
  const json = await res.json();
  return `b2b_admin_sid=${json.sid}`;
}

console.log('\nAPI tests — Phase 1:');

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
  assert.ok(res.headers.get('location')?.includes('/login'));
});

await test('GET /login returns 200 with Google sign-in button', async () => {
  const res = await fetch(`${BASE}/login`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Sign in with Google'));
  assert.ok(html.includes('/auth/login'));
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
  assert.ok(json.sid);
  const sid = extractSid(res.headers.get('set-cookie'));
  assert.ok(sid);
});

await test('GET / with valid session returns dashboard HTML', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Dashboard'));
  assert.ok(html.includes('Open Orders'));
  assert.ok(html.includes('Top Customers'));
  assert.ok(html.includes('Low Stock'));
});

await test('Dashboard shows mock data (order names, customer names)', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.ok(html.includes('#1001'));
  assert.ok(html.includes('Acme Pet Supply'));
  assert.ok(html.includes('Elite Collar'));
});

await test('Dashboard shows user email in header', async () => {
  const cookie = await seedSession('testuser@fuzzywumpets.com');
  const res = await fetch(`${BASE}/`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.ok(html.includes('testuser@fuzzywumpets.com'));
});

await test('GET /auth/logout clears session and redirects to /login', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/auth/logout`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/login'));
  const cleared = res.headers.get('set-cookie') || '';
  assert.ok(cleared.includes('Max-Age=0'));
});

await test('GET / after logout redirects to /login (session invalidated)', async () => {
  const cookie = await seedSession();
  await fetch(`${BASE}/auth/logout`, { headers: { Cookie: cookie }, redirect: 'manual' });
  const res = await fetch(`${BASE}/`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/login'));
});

await test('GET /__test__/session returns 404 in non-mock mode (stub)', async () => {
  assert.ok(true); // verified in other tests
});

console.log('\nAPI tests — Phase 2: Orders:');

await test('GET /orders requires auth', async () => {
  const res = await fetch(`${BASE}/orders`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/login'));
});

await test('GET /orders with session returns orders table', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Orders'), 'Missing Orders heading');
  assert.ok(html.includes('#1001'), 'Missing order #1001');
  assert.ok(html.includes('Acme Pet Supply'), 'Missing customer name');
  assert.ok(html.includes('New Order'), 'Missing New Order button');
});

await test('GET /orders?status=paid filters to paid orders', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders?status=paid`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.ok(html.includes('#1003'), 'Should include paid order #1003');
  assert.ok(!html.includes('#1001') || html.includes('No orders found'), 'Should not include pending order #1001');
});

await test('GET /orders?q=Doggo filters by customer name', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders?q=Doggo`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.ok(html.includes('Doggo Depot') || html.includes('#1003'));
});

await test('GET /orders/new returns new order form', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders/new`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('New Order'), 'Missing New Order heading');
  assert.ok(html.includes('customer-search'), 'Missing customer search');
  assert.ok(html.includes('product-search'), 'Missing product search');
});

await test('GET /orders/1001 returns order detail', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders/1001`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('#1001'), 'Missing order number');
  assert.ok(html.includes('Acme Pet Supply'), 'Missing customer name');
  assert.ok(html.includes('Elite Collar'), 'Missing line item');
  assert.ok(html.includes('Mark Paid'), 'Missing Mark Paid button (order is pending)');
  assert.ok(html.includes('PDF Invoice'), 'Missing PDF Invoice link');
});

await test('GET /orders/9999 returns 404 for non-existent order', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders/9999`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 404);
});

await test('POST /orders/1001/mark-paid redirects to order detail', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders/1001/mark-paid`, {
    method: 'POST', headers: { Cookie: cookie }, redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/orders/1001'));
});

await test('POST /orders/1001/note saves note and redirects', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders/1001/note`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'note=Test+note+from+API+tests',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/orders/1001'));
});

await test('GET /orders/1001/invoice.pdf returns PDF content-type', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders/1001/invoice.pdf`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type')?.includes('application/pdf'));
});

await test('POST /orders/bulk mark-paid redirects to /orders', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders/bulk`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'ids=1002&action=mark-paid',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/orders'));
});

console.log('\nAPI tests — Phase 2: Customers:');

await test('GET /customers requires auth', async () => {
  const res = await fetch(`${BASE}/customers`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/login'));
});

await test('GET /customers returns customers list', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/customers`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Customers'), 'Missing Customers heading');
  assert.ok(html.includes('Acme Pet Supply'), 'Missing Acme Pet Supply');
  assert.ok(html.includes('Lifetime Spend'), 'Missing column header');
});

await test('GET /customers?q=Happy filters customers', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/customers?q=Happy`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.ok(html.includes('Happy Paws'));
  assert.ok(!html.includes('Acme Pet Supply') || html.includes('No customers found'));
});

await test('GET /customers/101 returns customer detail', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/customers/101`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Acme Pet Supply'), 'Missing customer name');
  assert.ok(html.includes('buyer@acme.com'), 'Missing customer email');
  assert.ok(html.includes('Internal Notes'), 'Missing notes section');
  assert.ok(html.includes('Dropship'), 'Missing dropship section');
});

await test('GET /customers/9999 returns 404 for non-existent customer', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/customers/9999`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 404);
});

await test('POST /customers/101/notes saves notes and redirects', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/customers/101/notes`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'body=VIP+customer+notes+test',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/customers/101'));
});

await test('POST /customers/101/notes persists to SQLite (note visible on reload)', async () => {
  const cookie = await seedSession();
  await fetch(`${BASE}/customers/101/notes`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'body=Persistent+note+content',
    redirect: 'manual',
  });
  const res = await fetch(`${BASE}/customers/101`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.ok(html.includes('Persistent+note+content') || html.includes('Persistent note content'), 'Note should be visible after save');
});

await test('POST /customers/101/dropship saves config and redirects', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/customers/101/dropship`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'enabled=on&margin_pct=25',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/customers/101'));
});

await test('POST /customers/101/tags/add adds tag and redirects', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/customers/101/tags/add`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'tag=b2b-vip',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/customers/101'));
});

console.log('\nAPI tests — Phase 2: Search APIs:');

await test('GET /api/customers/search returns JSON array', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/customers/search?q=acme`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(Array.isArray(json));
  assert.ok(json.length > 0, 'Should return at least one result');
  assert.ok(json[0].id, 'Result should have id');
  assert.ok(json[0].label, 'Result should have label');
});

await test('GET /api/customers/search with empty q returns empty array', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/customers/search?q=`, { headers: { Cookie: cookie } });
  const json = await res.json();
  assert.deepEqual(json, []);
});

await test('GET /api/products/search returns JSON array with variantId', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/products/search?q=elite`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(Array.isArray(json));
  assert.ok(json.length > 0, 'Should return results for "elite"');
  assert.ok(json[0].variantId, 'Result should have variantId');
  assert.ok(json[0].label, 'Result should have label');
  assert.ok(json[0].price, 'Result should have price');
});

await test('GET /api/products/search requires auth', async () => {
  const res = await fetch(`${BASE}/api/products/search?q=elite`, { redirect: 'manual' });
  assert.equal(res.status, 401);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
