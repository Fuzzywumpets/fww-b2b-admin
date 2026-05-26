/**
 * UI tests — Playwright, run against mock server (B2B_ADMIN_MOCK=1).
 * Usage: TEST_BASE=http://127.0.0.1:8894 node test/ui.test.mjs
 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:8894';

let passed = 0;
let failed = 0;
const browser = await chromium.launch({ headless: true });

async function seedSession(email = 'alex@fuzzywumpets.com') {
  const res = await fetch(`${BASE}/__test__/session?email=${encodeURIComponent(email)}`);
  const json = await res.json();
  return json.sid;
}

async function authContext(email = 'alex@fuzzywumpets.com') {
  const sid = await seedSession(email);
  const ctx = await browser.newContext();
  await ctx.addCookies([{
    name:   'b2b_admin_sid',
    value:  sid,
    domain: '127.0.0.1',
    path:   '/',
  }]);
  return ctx;
}

async function test(name, fn) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await fn(page, ctx);
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    failed++;
  } finally {
    await ctx.close();
  }
}

async function testMobile(name, fn) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  try {
    await fn(page, ctx);
    console.log(`  ✓ [mobile 390px] ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ [mobile 390px] ${name}: ${err.message}`);
    failed++;
  } finally {
    await ctx.close();
  }
}

console.log('\nUI tests:');

await test('login page renders with Google button and tagline', async (page) => {
  await page.goto(`${BASE}/login`);
  await page.waitForSelector('.btn-google');
  const btnText = await page.textContent('.btn-google');
  assert.ok(btnText.includes('Sign in with Google'), 'Missing button text');
  const tagline = await page.textContent('.login-tagline');
  assert.ok(tagline.includes('Fuzzywumpets'), 'Missing tagline');
});

await test('unauthenticated / redirects to login', async (page) => {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  assert.ok(page.url().includes('/login'), `Expected /login, got: ${page.url()}`);
});

await test('authenticated dashboard shows all 4 widgets', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  await page.goto(`${BASE}/`);
  await page.waitForSelector('.widget-grid');

  const widgets = await page.$$('.widget');
  assert.ok(widgets.length >= 4, `Expected 4 widgets, got ${widgets.length}`);

  const html = await page.content();
  assert.ok(html.includes('Open Orders'),   'Missing Open Orders widget');
  assert.ok(html.includes('This Week'),     'Missing This Week widget');
  assert.ok(html.includes('Top Customers'), 'Missing Top Customers widget');
  assert.ok(html.includes('Low Stock'),     'Missing Low Stock widget');
});

await test('dashboard header has all 6 nav links', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  await page.goto(`${BASE}/`);
  await page.waitForSelector('.header-nav');
  const navLinks = await page.$$('.header-nav .nav-link');
  assert.ok(navLinks.length >= 6, `Expected 6+ nav links, got ${navLinks.length}`);
});

await test('dashboard shows mock order data', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  await page.goto(`${BASE}/`);
  await page.waitForSelector('.mini-table');

  const html = await page.content();
  assert.ok(html.includes('#1001'), 'Missing order #1001 in dashboard');
  assert.ok(html.includes('Acme Pet Supply'), 'Missing top customer');
  assert.ok(html.includes('Elite Collar'), 'Missing low-stock item');
});

await test('user email visible in header after login', async (page, ctx) => {
  const sid = await seedSession('alexa@fuzzywumpets.com');
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  await page.goto(`${BASE}/`);
  const html = await page.content();
  assert.ok(html.includes('alexa@fuzzywumpets.com'), 'Email not shown in header');
});

await test('sign out link clears session and redirects to login', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  await page.goto(`${BASE}/`);
  await page.click('.btn-signout');
  await page.waitForURL('**/login');
  assert.ok(page.url().includes('/login'), 'Should be at /login after sign out');
});

await test('/orders coming-soon page shows Orders heading', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  await page.goto(`${BASE}/orders`);
  const html = await page.content();
  assert.ok(html.includes('Orders'), 'Orders page missing');
});

// ── Mobile viewport tests ────────────────────────────────────────────────────

await testMobile('login card fits within 390px without overflow', async (page) => {
  await page.goto(`${BASE}/login`);
  const card = await page.$('.login-card');
  assert.ok(card, 'No .login-card found');
  const box = await card.boundingBox();
  assert.ok(box.width <= 390, `Login card too wide: ${box.width}px`);
  assert.ok(box.width > 0, 'Login card has zero width');
});

await testMobile('dashboard renders without horizontal overflow at 390px', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  await page.goto(`${BASE}/`);
  await page.waitForSelector('.widget-grid');

  const scrollWidth  = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth  = await page.evaluate(() => document.documentElement.clientWidth);
  assert.ok(scrollWidth <= clientWidth + 2, `Horizontal overflow: scrollWidth=${scrollWidth} clientWidth=${clientWidth}`);
});

await testMobile('mobile dashboard has at least 1 visible widget', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  await page.goto(`${BASE}/`);
  await page.waitForSelector('.widget');
  const widgets = await page.$$('.widget');
  assert.ok(widgets.length >= 1, 'No widgets visible on mobile');
});

await browser.close();

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
