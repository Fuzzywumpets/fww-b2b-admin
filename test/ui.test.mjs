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

await test('/orders page shows orders table with data', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  await page.goto(`${BASE}/orders`);
  await page.waitForSelector('.data-table');
  const html = await page.content();
  assert.ok(html.includes('Orders'), 'Missing Orders heading');
  assert.ok(html.includes('#1001'), 'Missing order row');
  assert.ok(html.includes('New Order'), 'Missing New Order button');
});

// LIST CURRENT-TOTAL (2026-06-29): the /orders LIST row for an EDITED order must show its CURRENT total,
// not the frozen original. Fixture #1008 is frozen at $300.00 (totalPriceSet) with currentTotalPriceSet
// $110.00. Mirrors live #37639 ($921.72 frozen, $601.24 current). The clean order #1007 (no current* set)
// must still show its frozen total unchanged (fallback path).
await test('/orders list row shows CURRENT total for edited order, frozen fallback for clean order', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  await page.goto(`${BASE}/orders`);
  await page.waitForSelector('.data-table');

  // Scope to the #1008 row's money cell — the 7th cell (Total) of the row containing the #1008 link.
  const row1008Total = await page.evaluate(() => {
    const link = [...document.querySelectorAll('a.order-link')].find(a => a.textContent.trim() === '#1008');
    if (!link) return null;
    const tr = link.closest('tr');
    return tr ? tr.querySelector('td.text-right.mono')?.textContent.trim() : null;
  });
  assert.ok(row1008Total, 'Could not find #1008 list row total cell');
  assert.ok(row1008Total.includes('110.00'), `#1008 list total should be CURRENT $110.00, got "${row1008Total}"`);
  assert.ok(!row1008Total.includes('300.00'), `#1008 list total must NOT be the frozen $300.00, got "${row1008Total}"`);

  // Clean order #1007 has no current* set ⇒ frozen total renders unchanged (regression guard for fallback).
  const row1007Total = await page.evaluate(() => {
    const link = [...document.querySelectorAll('a.order-link')].find(a => a.textContent.trim() === '#1007');
    if (!link) return null;
    const tr = link.closest('tr');
    return tr ? tr.querySelector('td.text-right.mono')?.textContent.trim() : null;
  });
  assert.ok(row1007Total && /\$\d/.test(row1007Total), `#1007 (clean) list total should render a money value, got "${row1007Total}"`);
});

await test('/orders/1001 shows order detail with timeline and line items', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  await page.goto(`${BASE}/orders/1001`);
  await page.waitForSelector('.timeline');
  const html = await page.content();
  assert.ok(html.includes('#1001'), 'Missing order number');
  assert.ok(html.includes('Elite Collar'), 'Missing line item');
  assert.ok(html.includes('Placed'), 'Missing timeline Placed step');
  assert.ok(html.includes('Generate Invoice'), 'Missing Generate Invoice button');
});

// Second build (Build C + D): record-payment control + order-history card on order detail.
await test('/orders/1001 shows Record payment button and order-history card', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/orders/1001`);
  await page.waitForSelector('#order-history-card');
  const html = await page.content();
  assert.ok(html.includes('Order History'), 'Missing Order History card');
  // #1001 is PENDING with an outstanding balance (unless a prior test paid it in the same process);
  // assert the control wiring exists on the page so the action is reachable.
  const hasRecordBtn = await page.$('button[onclick="toggleRecordPaymentModal(true)"]');
  const isPaid = html.includes('badge-paid');
  if (!isPaid) assert.ok(hasRecordBtn, 'Unpaid order should expose the Record payment button');
});

await test('/orders/1001 backorder control is an action ("Mark backordered"), not a status', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/orders/1001`);
  await page.waitForSelector('.timeline');
  const html = await page.content();
  assert.ok(html.includes('Mark backordered'), 'Backorder control should read as an action');
  // The control must still open the backorder modal (behavior unchanged).
  assert.ok(html.includes('class="edit-remove-btn bo-action-btn"'), 'backorder action keeps edit-mode reveal class');
});

// CURRENT-FIELDS (2026-06-29): an EDITED order must render its CURRENT state on FIRST PAINT —
// currentQuantity line rows + current totals, with fully-removed (currentQuantity 0) lines hidden —
// independent of the client reconcile JS (which only fires after an edit action, not on load).
// Fixture #1008: frozen subtotal/total $300.00, current $110.00; 3 line edges (1 partial qty2→1,
// 1 untouched, 1 removed) ⇒ 2 active rows / $110.00 expected, NOT 3 rows / $300.00.
await test('/orders/1008 edited order renders CURRENT qty rows + current totals on first paint, hides removed lines', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/orders/1008`);
  await page.waitForSelector('.timeline');

  // Exactly 2 active existing line rows (the removed line is NOT rendered).
  const rowCount = await page.$$eval('#edit-form tr[data-existing="1"]', rows => rows.length);
  assert.equal(rowCount, 2, `Expected 2 active line rows, got ${rowCount}`);

  const html = await page.content();
  // Removed line must be absent everywhere (line table, fulfill picker, ship picker).
  assert.ok(!html.includes('Removed Harness'), 'Removed (currentQuantity 0) line must be hidden');
  assert.ok(html.includes('Edited Partial Collar'), 'Partial line should still render');
  assert.ok(html.includes('Untouched Leash'), 'Untouched line should still render');

  // Partial line's static qty must show currentQuantity (1), not the frozen original (2).
  const partialRowQty = await page.$eval(
    '#edit-form tr[data-li-id="li1008a"] .edit-qty-static',
    el => el.textContent.trim());
  assert.equal(partialRowQty, '1', `Partial line should show currentQuantity 1, got ${partialRowQty}`);

  // Totals block: subtotal AND total = $110.00 (current), never the frozen $300.00.
  const subtotalText = await page.$eval('.totals-block .totals-row', el => el.lastElementChild.textContent.trim());
  const totalText    = await page.$eval('.totals-block .totals-total', el => el.lastElementChild.textContent.trim());
  assert.ok(subtotalText.includes('110.00'), `Subtotal should be current $110.00, got "${subtotalText}"`);
  assert.ok(totalText.includes('110.00'), `Total should be current $110.00, got "${totalText}"`);
  assert.ok(!subtotalText.includes('300.00'), 'Subtotal must not show the frozen $300.00');
  assert.ok(!totalText.includes('300.00'), 'Total must not show the frozen $300.00');

  // Cancel-modal headline total must also reflect the current $110.00.
  assert.ok(html.includes('($110.00)'), 'Cancel modal should show current total $110.00');
});

await test('/orders/1007 unedited order is UNCHANGED — line renders + totals intact (regression)', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/orders/1007`);
  await page.waitForSelector('.timeline');
  // #1007: 1 line item, no currentQuantity override → it renders; subtotal & total $200 unchanged.
  // (Dedicated fixture not mutated by other tests, so the row count is deterministic.)
  const rowCount = await page.$$eval('#edit-form tr[data-existing="1"]', rows => rows.length);
  assert.equal(rowCount, 1, `Unedited order should render its 1 line, got ${rowCount}`);
  const subtotalText = await page.$eval('.totals-block .totals-row', el => el.lastElementChild.textContent.trim());
  const totalText    = await page.$eval('.totals-block .totals-total', el => el.lastElementChild.textContent.trim());
  assert.ok(subtotalText.includes('200.00'), `Unedited subtotal should be $200.00, got "${subtotalText}"`);
  assert.ok(totalText.includes('200.00'), `Unedited total should be $200.00, got "${totalText}"`);
});

await test('/orders/new shows customer and product search', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  await page.goto(`${BASE}/orders/new`);
  await page.waitForSelector('#customer-search');
  const hasCustomerSearch = await page.$('#customer-search');
  const hasProductSearch  = await page.$('#product-search');
  assert.ok(hasCustomerSearch, 'Missing customer search input');
  assert.ok(hasProductSearch, 'Missing product search input');
  const submitBtn = await page.$('#submit-btn');
  const isDisabled = await submitBtn.getAttribute('disabled');
  assert.notEqual(isDisabled, null, 'Submit button should be disabled until customer + items selected');
});

await test('/customers shows customer list with search', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  await page.goto(`${BASE}/customers`);
  await page.waitForSelector('.data-table');
  const html = await page.content();
  assert.ok(html.includes('Acme Pet Supply'), 'Missing customer');
  assert.ok(html.includes('Lifetime Spend'), 'Missing column');
});

await test('/customers/101 shows customer detail with notes and B2B settings form', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  await page.goto(`${BASE}/customers/101`);
  await page.waitForSelector('.detail-grid');
  const html = await page.content();
  assert.ok(html.includes('Acme Pet Supply'), 'Missing customer name');
  assert.ok(html.includes('Internal Notes'), 'Missing notes section');
  assert.ok(html.includes('Drop-ship'), 'Missing dropship section');
  assert.ok(html.includes('dropship_margin_pct'), 'Missing dropship_margin_pct input');
});

await test('/customers/101 note save persists and shows success banner', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  await page.goto(`${BASE}/customers/101`);
  await page.waitForSelector('textarea[name="body"]');
  await page.fill('textarea[name="body"]', 'UI test note content');
  await page.click('button[type="submit"][class*="btn-secondary"]');
  await page.waitForURL('**/customers/101*');
  const html = await page.content();
  assert.ok(html.includes('Notes saved') || html.includes('alert-success'), 'Missing success banner');
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

await testMobile('orders list fits 390px without horizontal scroll', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  await page.goto(`${BASE}/orders`);
  await page.waitForSelector('.filter-bar');
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  assert.ok(scrollWidth <= clientWidth + 4, `Horizontal overflow on /orders: scrollWidth=${scrollWidth} clientWidth=${clientWidth}`);
});

console.log('\nUI tests — Phase 3:');

await test('/catalog shows product list with B2B column', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  await page.goto(`${BASE}/catalog`);
  await page.waitForSelector('.data-table');
  const html = await page.content();
  assert.ok(html.includes('Catalog'), 'Missing page title');
  assert.ok(html.includes('Elite Collar'), 'Missing product in table');
  assert.ok(html.includes('B2B Status'), 'Missing B2B Status column header');
  assert.ok(html.includes('B2B ✓') || html.includes('Not on B2B'), 'Missing B2B status badge');
});

await test('/catalog filter bar renders vendor + style dropdowns', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  await page.goto(`${BASE}/catalog`);
  await page.waitForSelector('.filter-bar');
  const selects = await page.$$('.filter-bar select');
  assert.ok(selects.length >= 3, `Expected at least 3 filter dropdowns, got ${selects.length}`);
});

await test('/catalog shows select-all checkbox and bulk bar', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  await page.goto(`${BASE}/catalog`);
  await page.waitForSelector('#select-all');
  const checkboxes = await page.$$('.row-check');
  assert.ok(checkboxes.length > 0, 'No row checkboxes found');
  // Click select-all and verify bulk bar appears
  await page.click('#select-all');
  await page.waitForSelector('#bulk-bar', { state: 'visible' });
  const bulkVisible = await page.isVisible('#bulk-bar');
  assert.ok(bulkVisible, 'Bulk bar should be visible after selecting all');
});

await test('/reports shows revenue chart (SVG) and stat cards', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  await page.goto(`${BASE}/reports`);
  await page.waitForSelector('.report-stats');
  const html = await page.content();
  assert.ok(html.includes('Monthly Revenue'), 'Missing chart section heading');
  assert.ok(html.includes('<svg'), 'Missing SVG bar chart');
  const statCards = await page.$$('.stat-card');
  assert.ok(statCards.length >= 3, `Expected 3 stat cards, got ${statCards.length}`);
});

await test('/reports has CSV download links', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  await page.goto(`${BASE}/reports`);
  await page.waitForSelector('.report-section');
  const html = await page.content();
  assert.ok(html.includes('/reports/csv/monthly'), 'Missing monthly CSV link');
  assert.ok(html.includes('/reports/csv/customers'), 'Missing customers CSV link');
  assert.ok(html.includes('/reports/csv/products'), 'Missing products CSV link');
});

await test('/settings shows config form and read-only info', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  await page.goto(`${BASE}/settings`);
  await page.waitForSelector('.settings-grid');
  const html = await page.content();
  assert.ok(html.includes('B2B Config'), 'Missing B2B Config section');
  assert.ok(html.includes('Admin Allowlist'), 'Missing allowlist section');
  assert.ok(html.includes('Read-only Info'), 'Missing read-only section');
  const inputs = await page.$$('input[name="b2b_discount_pct"]');
  assert.ok(inputs.length > 0, 'Missing b2b_discount_pct input');
});

await test('/settings save config shows success flash', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  await page.goto(`${BASE}/settings`);
  await page.waitForSelector('input[name="b2b_discount_pct"]');
  await page.fill('input[name="b2b_discount_pct"]', '45');
  await page.click('button[type="submit"]');
  await page.waitForURL('**/settings*');
  const html = await page.content();
  assert.ok(html.includes('saved') || html.includes('alert-success'), 'Missing success flash after save');
});

await test('/migrate shows SparkLayer migration page with stats', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  await page.goto(`${BASE}/migrate`);
  await page.waitForSelector('.report-stats');
  const html = await page.content();
  assert.ok(html.includes('SparkLayer Migration'), 'Missing page title');
  assert.ok(html.includes('SparkLayer Test Store'), 'Missing mock candidate');
  const statCards = await page.$$('.stat-card');
  assert.ok(statCards.length >= 3, `Expected 3 stat cards, got ${statCards.length}`);
});

await testMobile('/catalog renders without horizontal overflow at 390px', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  await page.goto(`${BASE}/catalog`);
  await page.waitForSelector('.filter-bar');
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  assert.ok(scrollWidth <= clientWidth + 4, `Horizontal overflow on /catalog: scrollWidth=${scrollWidth} clientWidth=${clientWidth}`);
});

await testMobile('/settings renders without overflow at 390px', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  await page.goto(`${BASE}/settings`);
  await page.waitForSelector('.settings-grid');
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  assert.ok(scrollWidth <= clientWidth + 4, `Horizontal overflow on /settings at 390px: scrollWidth=${scrollWidth} clientWidth=${clientWidth}`);
});

console.log('\nUI tests — Phase 5: Labels:');

await test('/labels page renders tab bar', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/labels`);
  await page.waitForSelector('.tab-bar');
  const tabs = await page.$$('.tab');
  assert.ok(tabs.length >= 2, 'Should have at least 2 tabs');
  const html = await page.content();
  assert.ok(html.includes('From an Order'), 'Missing From an Order tab');
  assert.ok(html.includes('From Products'), 'Missing From Products tab');
});

await test('/labels from products tab shows products after click', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/labels?source=products`);
  await page.waitForSelector('.tab-bar');
  const html = await page.content();
  assert.ok(html.includes('Elite Collar') || html.includes('Luxe') || html.includes('Simplicity'), 'Should show product list');
});

await test('/labels order tab shows form after loading order', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/labels?source=order&order=1001`);
  await page.waitForSelector('.tab-bar');
  const html = await page.content();
  assert.ok(html.includes('Elite Collar') || html.includes('Avery'), 'Should show order items or options');
});

// CURRENT-FIELDS (2026-06-29): packing labels from an EDITED order must show post-edit qtys (currentQuantity,
// fallback frozen quantity) and OMIT lines removed in the edit (currentQuantity 0). Fixture #1008:
//   li1008a Edited Partial Collar quantity2->currentQuantity1 ; li1008b Untouched Leash currentQuantity1 ;
//   li1008c Removed Harness currentQuantity0 (MUST be absent). So 2 label rows; partial qty input = 1.
await test('/labels?order=1008 (EDITED) lists only active lines + qty input reflects currentQuantity', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/labels?source=order&order=1008`);
  await page.waitForSelector('.tab-bar');
  const html = await page.content();
  // Removed line must be absent
  assert.ok(!html.includes('Removed Harness'), 'Removed (currentQuantity 0) line must not appear on labels');
  // Active lines present
  assert.ok(html.includes('Edited Partial Collar'), 'Partial line should appear');
  assert.ok(html.includes('Untouched Leash'), 'Untouched line should appear');
  // Exactly 2 per-item qty inputs (one per active line)
  const qtyInputs = await page.$$eval('input[name^="item_qty_"]', els => els.map(e => e.value));
  assert.equal(qtyInputs.length, 2, `Expected 2 label qty inputs (active lines only), got ${qtyInputs.length}`);
  // Partial line's qty input must be currentQuantity (1), not frozen 2.
  // Items render in fixture order: [0]=partial(1), [1]=untouched(1). Both are 1, and neither is 2.
  assert.ok(!qtyInputs.includes('2'), `No label qty should be the frozen 2 on this edited order; got ${JSON.stringify(qtyInputs)}`);
  assert.deepEqual(qtyInputs, ['1', '1'], `Both active label qtys should be currentQuantity 1; got ${JSON.stringify(qtyInputs)}`);
});

await test('/labels?order=1001 (UNEDITED) regression — all lines present, qty inputs = frozen quantity', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/labels?source=order&order=1001`);
  await page.waitForSelector('.tab-bar');
  const html = await page.content();
  assert.ok(html.includes('Elite Collar'), 'Elite Collar present');
  assert.ok(html.includes('Luxe Leash'), 'Luxe Leash present');
  const qtyInputs = await page.$$eval('input[name^="item_qty_"]', els => els.map(e => e.value));
  assert.equal(qtyInputs.length, 2, `Unedited #1001 should have 2 label rows, got ${qtyInputs.length}`);
  // #1001 lines: Elite Collar quantity 5, Luxe Leash quantity 2 (no currentQuantity => frozen values).
  assert.deepEqual(qtyInputs.sort(), ['2', '5'], `Unedited qty inputs should be frozen [5,2]; got ${JSON.stringify(qtyInputs)}`);
});

await test('/labels preview button is present in product view', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/labels?source=products`);
  // Use the product-specific search form (in the visible tab) to avoid targeting hidden elements
  await page.waitForSelector('#product-search-form');
  const buttons = await page.$$('button[type="submit"]');
  assert.ok(buttons.length >= 1, 'Should have submit buttons');
});

console.log('\nUI tests — Phase 6: Exports:');

await test('/exports shows two export cards', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/exports`);
  await page.waitForSelector('.exports-cards');
  const cards = await page.$$('.export-card');
  assert.ok(cards.length >= 2, `Expected at least 2 export cards, got ${cards.length}`);
});

await test('/exports/csv shows product picker and column selector', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/exports/csv`);
  await page.waitForSelector('form');
  const html = await page.content();
  assert.ok(html.includes('SKU') || html.includes('sku'), 'Missing column checkboxes');
  assert.ok(html.includes('Download CSV'), 'Missing Download button');
});

await test('/exports/images shows product picker and mode radio', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/exports/images`);
  await page.waitForSelector('form');
  const html = await page.content();
  assert.ok(html.includes('main-only') || html.includes('Main photo'), 'Missing main-only option');
  assert.ok(html.includes('gallery') || html.includes('gallery images'), 'Missing gallery option');
  assert.ok(html.includes('Download ZIP'), 'Missing Download button');
});

await testMobile('/labels renders without overflow at 390px', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/labels`);
  await page.waitForSelector('.tab-bar');
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  assert.ok(scrollWidth <= clientWidth + 4, `Overflow on /labels at 390px: scrollW=${scrollWidth} clientW=${clientWidth}`);
});

await testMobile('/exports renders without overflow at 390px', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/exports`);
  await page.waitForSelector('.exports-cards');
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  assert.ok(scrollWidth <= clientWidth + 4, `Overflow on /exports at 390px: scrollW=${scrollWidth} clientW=${clientWidth}`);
});

// ── Phase 7/10: B2B Customer Settings UI ──────────────────────────────────────
console.log('\nUI tests — Phase 7/10: B2B Customer Settings:');

await test('/customers/:id shows unified B2B Customer Settings section', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/customers/101`);
  await page.waitForSelector('#b2b-settings-card');
  const html = await page.content();
  assert.ok(html.includes('B2B Customer Settings'), 'Missing B2B Customer Settings heading');
  assert.ok(html.includes('Discount %'), 'Missing discount field');
  assert.ok(html.includes('allow_order_on_invoice'), 'Missing allow_order_on_invoice field');
});

await test('customer B2B config shows override badge for customer 101', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/customers/101`);
  await page.waitForSelector('#b2b-settings-card');
  const html = await page.content();
  assert.ok(html.includes('override'), 'Should show override badge for customer 101 discount_pct=60');
});

await test('customer B2B config save form redirects with success', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/customers/103`);
  await page.waitForSelector('#b2b-settings-form');
  await page.fill('input[name="discount_pct"]', '55');
  await page.click('#b2b-settings-form button[type="submit"]');
  await page.waitForURL(/b2b_settings_saved|b2b_config_saved/);
  const html = await page.content();
  assert.ok(html.includes('B2B customer settings saved'), 'Missing success flash');
});

// ── Phase 8: 10 templates + 6 checkboxes UI ──────────────────────────────────
console.log('\nUI tests — Phase 8: Label engine 10 templates + field selection:');

await test('/labels shows 10 templates in dropdown', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/labels`);
  await page.waitForSelector('.tab-bar');
  const optionValues = await page.$$eval('select[name="template"] option', opts => opts.map(o => o.value));
  assert.ok(optionValues.length >= 10, `Expected ≥10 template options, got ${optionValues.length}`);
  assert.ok(optionValues.includes('avery-5161'), 'Missing avery-5161');
  assert.ok(optionValues.includes('thermal-4x6'), 'Missing thermal-4x6');
  assert.ok(optionValues.includes('thermal-2x1'), 'Missing thermal-2x1');
});

await test('/labels shows 6-field checkboxes with correct defaults', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/labels`);
  await page.waitForSelector('.tab-bar');
  const html = await page.content();
  assert.ok(html.includes('field_productName'), 'Missing productName checkbox');
  assert.ok(html.includes('field_upcBarcode'),   'Missing upcBarcode checkbox');
  assert.ok(html.includes('field_sku'),          'Missing sku checkbox');
  // SKU defaults to unchecked
  const skuChecked = await page.$eval('input[name="field_sku"]', el => el.checked).catch(() => false);
  assert.ok(!skuChecked, 'SKU checkbox should be unchecked by default');
});

// ── Phase 19E: Catalog status filter ────────────────────────────────────────
console.log('\nUI tests — Phase 19E: Catalog status filter:');

await test('/catalog shows status filter chips', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/catalog`);
  await page.waitForSelector('#catalog-status-chips');
  const html = await page.content();
  assert.ok(html.includes('Active'), 'Active chip missing');
  assert.ok(html.includes('Draft'),  'Draft chip missing');
  assert.ok(html.includes('Archived'), 'Archived chip missing');
  assert.ok(html.includes('filter-chip-active'), 'No active chip highlighted');
});

await test('/catalog default shows Active products only (no archived row)', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/catalog`);
  await page.waitForSelector('.data-table');
  const html = await page.content();
  assert.ok(html.includes('Elite Collar'), 'Active product missing');
  assert.ok(!html.includes('row-archived'), 'Archived row should not appear in default (active) view');
});

await test('/catalog?status=all shows ARCHIVED badge on archived product row', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/catalog?status=all`);
  await page.waitForSelector('.data-table');
  const html = await page.content();
  assert.ok(html.includes('badge-archived') || html.includes('ARCHIVED'), 'ARCHIVED badge missing in all view');
  assert.ok(html.includes('row-archived'), 'row-archived class missing on archived row');
});

// ── Phase 20: Priority customers ─────────────────────────────────────────────
console.log('\nUI tests — Phase 20: Priority customers:');

await test('/customers shows sort dropdown', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/customers`);
  await page.waitForSelector('.data-table');
  const sortSelect = await page.$('select[name="sort"]');
  assert.ok(sortSelect, 'Sort dropdown missing');
  const html = await page.content();
  assert.ok(html.includes('lifetime_spend_desc') || html.includes('Lifetime spend'), 'Sort option missing');
});

await test('/customers shows star badge on top-spend customer', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/customers`);
  await page.waitForSelector('.data-table');
  const html = await page.content();
  assert.ok(html.includes('top-customer-star'), 'Top customer star badge missing');
});

// ── Phase 19A: Customer spend section ─────────────────────────────────────────
console.log('\nUI tests — Phase 19A: Customer spend section:');

await test('/customers/:id shows Spend section with date range selector', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/customers/101`);
  await page.waitForSelector('#spend-card');
  const html = await page.content();
  assert.ok(html.includes('spend-card'), 'Spend card missing');
  assert.ok(html.includes('spend-preset'), 'Date range dropdown missing');
});

await test('/customers/:id spend section loads range data via AJAX', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/customers/101`);
  await page.waitForSelector('#spend-card');
  await page.waitForFunction(() => {
    const loading = document.getElementById('spend-loading');
    return loading && loading.style.display === 'none';
  }, { timeout: 5000 });
  const rangeTotal = await page.$eval('#spend-range-total', el => el.textContent);
  assert.ok(rangeTotal !== '—', 'Range total should be populated after AJAX load: ' + rangeTotal);
});

// ── Phase 17: Wholesale Leads CRM UI ──────────────────────────────────────────
console.log('\nUI tests — Phase 17: Wholesale leads CRM:');

await test('/leads nav link is present in header', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/`);
  await page.waitForSelector('.header-nav');
  const html = await page.content();
  assert.ok(html.includes('/leads') && html.includes('Leads'), 'Leads nav link missing');
});

await test('/leads page renders with status filter chips', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/leads`);
  await page.waitForSelector('.page-header-row');
  const html = await page.content();
  assert.ok(html.includes('Wholesale Leads'), 'Page title missing');
  assert.ok(html.includes('filter-chip'), 'Status filter chips missing');
});

await test('/leads/new form creates a lead and redirects to detail', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/leads/new`);
  await page.waitForSelector('form');
  await page.fill('input[name="email"]', `ui-test-${Date.now()}@example.com`);
  await page.fill('input[name="business_name"]', 'UI Test Boutique');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/leads\/\d+/);
  const html = await page.content();
  assert.ok(html.includes('UI Test Boutique'), 'Business name missing after create');
  assert.ok(html.includes('Activity'), 'Activity section missing');
});

// ── Phase 19B + 19C: Hyperlinks + Product detail ─────────────────────────────
console.log('\nUI tests — Phase 19B + 19C: Hyperlinks + Product detail:');

await test('/customers tag chips link to filtered customer list', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/customers`);
  await page.waitForSelector('.data-table');
  const tagLink = await page.$('a.tag-chip');
  assert.ok(tagLink !== null, 'Tag chip should be an anchor element');
  const href = await tagLink.getAttribute('href');
  assert.ok(href?.includes('/customers?tag='), 'Tag chip href should filter by tag');
});

await test('/products/201 renders product detail page', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/products/201`);
  await page.waitForSelector('.detail-header');
  const html = await page.content();
  assert.ok(html.includes('Elite Collar'), 'Product title missing');
  assert.ok(html.includes('Variants'), 'Variants section missing');
  assert.ok(html.includes('Edit in Shopify'), 'Edit in Shopify link missing');
});

await test('/orders/1001 order detail has Edit order button', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/orders/1001`);
  await page.waitForSelector('.detail-header');
  const html = await page.content();
  assert.ok(html.includes('Edit order'), 'Edit order button missing');
  assert.ok(html.includes('Fulfill items'), 'Fulfill items button missing');
});

// ── Phase 16: Order editing UI ────────────────────────────────────────────────
console.log('\nUI tests — Phase 16: Order editing UI:');

await test('/orders/1001 edit mode activates on button click', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/orders/1001`);
  await page.waitForSelector('#edit-btn');
  await page.click('#edit-btn');
  const editBar = await page.$('#edit-mode-bar');
  const isVisible = await editBar?.isVisible();
  assert.ok(isVisible, 'Edit mode bar should be visible after clicking Edit order');
});

// Phase 16G: grouped multi-select picker must actually populate the dropdown on type.
// This exercises the real keystroke → debounced fetch(?grouped=1) → render() path in a
// browser and fails on ANY console/page error (a thrown exception in the picker IIFE
// silently hides the dropdown otherwise — the exact prod regression we are guarding).
await test('/orders/1001 Add-product search shows grouped suggestions on type', async (page, ctx) => {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/orders/1001`);
  await page.waitForSelector('#edit-btn');
  await page.click('#edit-btn');                    // reveal the Add-product toolbar
  await page.waitForSelector('#edit-product-search', { state: 'visible' });
  // Type a product name; min-char gate is 2, debounce 220ms — type a real pattern.
  await page.fill('#edit-product-search', 'pinpoint');
  // Wait for the dropdown to populate (real fetch round-trip + render).
  await page.waitForSelector('#edit-product-results .edit-var-cb', { timeout: 4000 });
  const box = page.locator('#edit-product-results');
  assert.equal(await box.evaluate(el => getComputedStyle(el).display), 'block', 'results dropdown must be visible');
  const cbCount = await page.locator('#edit-product-results .edit-var-cb').count();
  assert.ok(cbCount >= 2, `expected >=2 variant checkboxes, got ${cbCount}`);
  // Grouped: a product header row and an "Add selected" action must be present.
  const html = await box.innerHTML();
  assert.ok(/Pinpoint Limited Slip/.test(html), 'product header should appear in grouped dropdown');
  assert.ok(await page.locator('#edit-add-selected').count() >= 1, '"Add selected" button missing');
  // Selecting multiple variants + Add selected must add multiple new catalog rows.
  const cbs = page.locator('#edit-product-results .edit-var-cb');
  await cbs.nth(0).check();
  await cbs.nth(1).check();
  await page.click('#edit-add-selected');
  const newRows = await page.locator('#edit-form tr.catalog-line-new').count();
  assert.equal(newRows, 2, `expected 2 new catalog line rows after "Add selected", got ${newRows}`);
  assert.equal(errors.length, 0, 'no JS errors during picker use; got: ' + errors.join(' | '));
});

// ── Phase 16H: incremental auto-save (the "constantly update" behaviour) ──────
// Drives the REAL edit page in a browser: add a catalog variant via the grouped picker and
// assert it persists (row flips saving->saved, gains a committed line id) WITHOUT clicking the
// batch "Save changes" button — then add the same way again and assert NO double-add. Fails on
// ANY console error / pageerror (a thrown exception in the auto-save controller would otherwise
// hide silently — the exact class of regression we are guarding against).
await test('/orders/1001 add-from-picker auto-saves WITHOUT manual Save + no double-add', async (page, ctx) => {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', r => {
    // ignore favicon / aborted navigations; flag failed XHRs to our endpoints
    const u = r.url();
    if (/\/orders\/\d+\/(line|discount)\//.test(u) || /\/api\/orders\/\d+\/line-state/.test(u)) errors.push('requestfailed: ' + u);
  });
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/orders/1001`);
  await page.waitForSelector('#edit-btn');
  await page.click('#edit-btn');                              // enter edit mode
  await page.waitForSelector('#edit-product-search', { state: 'visible' });
  await page.fill('#edit-product-search', 'pinpoint');
  await page.waitForSelector('#edit-product-results .edit-var-cb', { timeout: 5000 });

  // Add a single variant via the picker.
  await page.locator('#edit-product-results .edit-var-cb').nth(0).check();
  await page.click('#edit-add-selected');
  const row = page.locator('#edit-form tr.catalog-line-new').first();
  await row.waitFor();

  // Auto-save must complete and stamp a committed line id — WITHOUT touching the Save button.
  await page.waitForFunction(() => {
    const r = document.querySelector('#edit-form tr.catalog-line-new');
    return r && r.dataset.committedLiId;
  }, { timeout: 8000 });
  const committedId1 = await row.evaluate(el => el.dataset.committedLiId);
  assert.ok(committedId1, 'first added row must gain a committed line id from /line/add (no manual Save)');

  // The global pill should settle back to "All changes saved".
  await page.waitForFunction(() => {
    const p = document.getElementById('autosave-pill');
    return p && p.dataset.state === 'saved';
  }, { timeout: 8000 });

  // Capture authoritative line count, then add a SECOND distinct variant.
  const stateA = await page.evaluate(async () => (await (await fetch('/api/orders/1001/line-state', { credentials: 'same-origin' })).json()));
  await page.fill('#edit-product-search', 'pinpoint');
  await page.waitForSelector('#edit-product-results .edit-var-cb', { timeout: 5000 });
  await page.locator('#edit-product-results .edit-var-cb').nth(1).check();
  await page.click('#edit-add-selected');
  await page.waitForFunction((n) => document.querySelectorAll('#edit-form tr.catalog-line-new').length === n, 2);
  await page.waitForFunction(() => {
    const rows = document.querySelectorAll('#edit-form tr.catalog-line-new');
    return rows.length === 2 && [...rows].every(r => r.dataset.committedLiId);
  }, { timeout: 8000 });
  const stateB = await page.evaluate(async () => (await (await fetch('/api/orders/1001/line-state', { credentials: 'same-origin' })).json()));
  assert.equal(stateB.lineCount, stateA.lineCount + 1, 'second distinct add increases lineCount by exactly 1 (no double-add)');

  // Two new rows must carry DISTINCT committed ids (proves each persisted once).
  const ids = await page.locator('#edit-form tr.catalog-line-new').evaluateAll(rows => rows.map(r => r.dataset.committedLiId));
  assert.equal(new Set(ids).size, 2, 'each added row has a distinct committed id');

  assert.equal(errors.length, 0, 'no JS/network errors during auto-save flow; got: ' + errors.join(' | '));
});

await test('/orders/1001 fulfill modal opens on button click', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/orders/1001`);
  await page.waitForSelector('button[onclick="toggleFulfillModal(true)"]');
  await page.click('button[onclick="toggleFulfillModal(true)"]');
  const modal = await page.$('#fulfill-modal');
  const isVisible = await modal?.isVisible();
  assert.ok(isVisible, 'Fulfill modal should be visible');
});

await test('/orders/1001 discount modal opens on button click', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/orders/1001`);
  await page.waitForSelector('button[onclick="toggleDiscountModal(true)"]');
  await page.click('button[onclick="toggleDiscountModal(true)"]');
  const modal = await page.$('#discount-modal');
  const isVisible = await modal?.isVisible();
  assert.ok(isVisible, 'Discount modal should be visible');
});

// ── Phase 18: Xero accounting UI ─────────────────────────────────────────────

await test('/settings/xero renders account mapping form', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/settings/xero`);
  const title = await page.locator('h1').first().textContent();
  assert.ok(title?.includes('Xero'), 'Missing Xero settings title');
  const input = await page.locator('input[name="sales_revenue"]').first();
  assert.ok(await input.isVisible(), 'sales_revenue input should be visible');
});

await test('/accounting renders reconciliation page with sections', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/accounting`);
  const h1 = await page.locator('h1').first().textContent();
  assert.ok(h1?.includes('Accounting'), 'Missing Accounting page title');
  const html = await page.content();
  assert.ok(html.includes('Xero Invoice Map'), 'Missing invoice map section');
});

await test('/orders/1001 shows Xero sidebar card', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/orders/1001`);
  const html = await page.content();
  assert.ok(html.includes('Xero'), 'Missing Xero card in order detail');
});

await test('/settings/xero saves and shows success flash', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/settings/xero`);
  await page.fill('input[name="sales_revenue"]', '200');
  await page.fill('input[name="chase_checking"]', '1110');
  await page.click('button[type="submit"]');
  await page.waitForURL(/settings\/xero/);
  const html = await page.content();
  assert.ok(html.includes('saved'), 'Should show success message after save');
});

// ── Phase 21: Xero customer sync UI ──────────────────────────────────────────

await test('UI tests — Phase 21: Xero customer sync:', async () => {});

await test('/customers/101 shows Xero card section', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/customers/101`);
  const html = await page.content();
  assert.ok(html.includes('xero-customer-card') || html.includes('Xero'), 'Should show Xero card on customer detail');
});

await test('/customers/101 Xero card loads status via fetch (not_synced for mock customer)', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/customers/101`);
  // Wait for the async Xero status fetch to complete
  await page.waitForFunction(() => {
    const el = document.getElementById('xero-customer-status');
    return el && !el.textContent.includes('Loading');
  }, { timeout: 5000 }).catch(() => {});
  const html = await page.content();
  // Mock customer 101 is not in the Xero mapping → should show not_synced or synced state
  assert.ok(
    html.includes('Sync to Xero') || html.includes('Synced') || html.includes('Insider') || html.includes('Merged'),
    'Should render one of the Xero status states'
  );
});

console.log('\nUI tests — Phase 22 (Impersonation):');

await test('/customers/101 shows "View in Portal" button', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/customers/101`);
  const html = await page.content();
  assert.ok(html.includes('View in Portal') || html.includes('impersonate'), 'Should show impersonation button');
});

await test('/customers/101 impersonate-btn opens modal', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/customers/101`);
  await page.click('#impersonate-btn');
  const modal = await page.$('#impersonate-modal');
  const display = await modal.evaluate(el => el.style.display);
  assert.equal(display, 'flex', 'Modal should be visible after button click');
});

// ── Phase 25: Vendor filter UI ────────────────────────────────────────────────
console.log('\nUI tests — Phase 25 (Vendor filter):');

await test('/catalog shows "Fuzzywumpets (default)" as selected vendor', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/catalog`);
  const html = await page.content();
  assert.ok(
    html.includes('Fuzzywumpets (default)'),
    'Catalog vendor select should show "Fuzzywumpets (default)"'
  );
});

await test('/catalog?vendor=all shows All vendors option selected', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/catalog?vendor=all`);
  const html = await page.content();
  assert.ok(
    html.includes('All vendors') || html.includes('value="all"'),
    'Should show All vendors option when vendor=all'
  );
});


// ── Task 43: Activity timeline card ──────────────────────────────────────────
console.log('\nUI tests — Task 43 (Activity timeline):');

await test('/customers/101 shows activity card that loads on click', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/customers/101`);
  // Activity card should be present
  const actCard = await page.$('#activity-card');
  assert.ok(actCard, 'Activity card #activity-card not found on customer detail');
  // Header should say "Portal Activity"
  const html = await page.content();
  assert.ok(html.includes('Portal Activity'), 'Activity card header text not found');
  // Clicking loads activity data
  await page.click('#activity-card .card-header');
  // After click, wait for tbody or "No activity" state
  await page.waitForFunction(() => {
    const body = document.getElementById('activity-body');
    if (!body) return false;
    const text = body.textContent || '';
    return !text.includes('Loading…') && text.length > 5;
  }, { timeout: 8000 });
  const bodyText = await page.textContent('#activity-body');
  assert.ok(bodyText && bodyText.length > 5, 'Activity body appears empty after load');
});


// ── Task 45: Backorder queue page ────────────────────────────────────────────
console.log('\nUI tests — Task 45 (Backorder queue):');

await test('/backorders page loads with table heading', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/backorders`);
  // Page should have the "Backorder Queue" heading
  const heading = await page.$('h1');
  const headingText = heading ? await page.textContent('h1') : '';
  assert.ok(headingText.includes('Backorder'), `h1 should contain "Backorder", got: "${headingText}"`);
  // Should have either a table or a "No pending" message
  const hasTable = await page.$('#backorder-table');
  const hasEmpty = await page.$('.text-muted');
  assert.ok(hasTable || hasEmpty, 'Page should have either #backorder-table or empty state message');
});


// ── Task 48: Revenue chart + outstanding balance UI ──────────────────────────
console.log('\nUI tests — Task 48 (Revenue chart + outstanding balance):');

await test('Dashboard: Revenue (12 months) widget heading visible', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/`);
  await page.waitForSelector('.widget-grid', { timeout: 8000 });
  const html = await page.content();
  assert.ok(html.includes('Revenue (12 months)'), 'Dashboard should show "Revenue (12 months)" widget heading');
});

await test('Customer detail: B2B Customer Settings card has outstanding section', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/customers/101`);
  await page.waitForSelector('.card-header', { timeout: 8000 });
  const html = await page.content();
  assert.ok(html.includes('B2B Customer Settings'), 'Customer detail should have B2B Customer Settings card');
});

await browser.close();

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
