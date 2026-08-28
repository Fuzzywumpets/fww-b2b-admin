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

// Regression (H19): the activity filter form used to carry a preset <select name="from"> AND a date
// <input name="from">. A real submit therefore produced from=<preset>&from=<date>; Express's qs
// parser turned req.query.from into an array, the date comparison matched nothing, and staff saw
// "No activity in this range" for a customer whose events existed. Drive the real controls (typed
// keystrokes, real <select> change) and assert the URL that actually reaches the server.
await test('/customers/101/activity filter submit sends ONE from + ONE to', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/customers/101/activity`);

  // Only one control may own each date name.
  assert.equal(await page.locator('form [name="from"]').count(), 1,
    'more than one control named "from" — every submit will send an array param');
  assert.equal(await page.locator('form [name="to"]').count(), 1, 'expected one control named "to"');

  // Real keystrokes into the date inputs (scripted .value assignment is a false pass).
  // Click near the left edge so the caret lands on the FIRST (month) segment, then type MMDDYYYY.
  const fromInput = page.locator('form input[type="date"][name="from"]');
  await fromInput.click({ position: { x: 6, y: 10 } });
  await fromInput.pressSequentially('01012026', { delay: 30 });
  const toInput = page.locator('form input[type="date"][name="to"]');
  await toInput.click({ position: { x: 6, y: 10 } });
  await toInput.pressSequentially('02012026', { delay: 30 });
  assert.equal(await fromInput.inputValue(), '2026-01-01', 'typed from-date did not land in the field');
  assert.equal(await toInput.inputValue(), '2026-02-01', 'typed to-date did not land in the field');

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.click('form button[type="submit"]'),
  ]);

  const params = new URL(page.url()).searchParams;
  assert.deepEqual(params.getAll('from'), ['2026-01-01'],
    `expected a single from param, got ${JSON.stringify(params.getAll('from'))}`);
  assert.deepEqual(params.getAll('to'), ['2026-02-01'],
    `expected a single to param, got ${JSON.stringify(params.getAll('to'))}`);
  // The page must still render its table rather than an error.
  assert.ok((await page.content()).includes('Activity log'), 'filtered page failed to render');
});

await test('/customers/101/activity date preset sets BOTH from and to, once each', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/customers/101/activity`);

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.selectOption('#date-preset', { label: 'Last 30d' }),
  ]);

  const params = new URL(page.url()).searchParams;
  assert.equal(params.getAll('from').length, 1, 'preset must not add a second from param');
  assert.equal(params.getAll('to').length, 1, 'preset must set exactly one to param');
  const from = new Date(params.get('from'));
  const to = new Date(params.get('to'));
  const spanDays = Math.round((to - from) / 86400000);
  assert.equal(spanDays, 30, `Last 30d preset should span 30 days, got ${spanDays}`);
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

// ── ui-truthfulness: list footers + failed-action feedback ───────────────────
// The truncation BANNER itself can only be reached on the cache path (`if (!MOCK)`), so it is
// covered by test/list-truncation.test.mjs at the db + copy level. What these browser tests pin
// down is the half that IS reachable here: the untruncated footer must still read as a plain
// count (the copy change must not regress the normal case), and a failed tax-exempt action must
// produce a visible banner instead of a silent same-page reload.

await test('orders list: untruncated footer is a plain count and shows no truncation banner', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  await page.goto(`${BASE}/orders`);
  await page.waitForSelector('.pagination');
  const footer = (await page.textContent('.pagination .text-muted')).trim();
  assert.ok(/^\d+ orders?$/.test(footer), `Expected a plain count footer, got "${footer}"`);
  assert.equal(await page.locator('[data-truncation-notice]').count(), 0,
    'a complete list must not claim it was truncated');

  // Real keystrokes into the search box — a scripted .value assignment would bypass focus/submit.
  const search = page.locator('input[name="q"]');
  await search.click();
  await search.type('#1001', { delay: 20 });
  await page.keyboard.press('Enter');
  await page.waitForSelector('.pagination');
  const filtered = (await page.textContent('.pagination .text-muted')).trim();
  assert.ok(/^\d+ orders?$/.test(filtered), `Expected a plain count on the filtered view, got "${filtered}"`);
  assert.equal(await page.locator('[data-truncation-notice]').count(), 0);
});

await test('customers list: untruncated footer is a plain count and shows no truncation banner', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  await page.goto(`${BASE}/customers`);
  await page.waitForSelector('.pagination');
  const footer = (await page.textContent('.pagination .text-muted')).trim();
  assert.ok(/^\d+ customers?$/.test(footer), `Expected a plain count footer, got "${footer}"`);
  assert.equal(await page.locator('[data-truncation-notice]').count(), 0);
});

await test('tax-exempt: a FAILED approve/reject renders a visible error banner', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  // Clean page: no flash at all.
  await page.goto(`${BASE}/tax-exempt`);
  await page.waitForSelector('.data-table');
  assert.equal(await page.locator('.alert').count(), 0, 'no flash expected on a clean load');

  // This is exactly where POST /tax-exempt/:id/approve lands when callPortalInternal fails
  // (portal unreachable, or PORTAL_INTERNAL_TOKEN unset -> error:'no_internal_token').
  await page.goto(`${BASE}/tax-exempt?success=error&msg=no_internal_token`);
  const banner = page.locator('[data-taxexempt-error]');
  await banner.waitFor({ timeout: 4000 });
  const text = await banner.textContent();
  assert.ok(/failed/i.test(text), `SILENT FAILURE: expected a failure message, got "${text}"`);
  assert.ok(text.includes('PORTAL_INTERNAL_TOKEN'), 'banner should point at the likely misconfiguration');
  assert.ok(text.includes('no_internal_token'), 'the portal-side error code should be surfaced');

  // The success flashes must still work.
  await page.goto(`${BASE}/tax-exempt?success=approved`);
  assert.ok((await page.textContent('.alert-success')).includes('approved'));
  await page.goto(`${BASE}/tax-exempt?success=rejected`);
  assert.ok((await page.textContent('.alert-success')).includes('rejected'));
});

await test('tax-exempt: the error msg param is escaped, not injected', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  const payload = encodeURIComponent('<img src=x onerror=window.__xss=1>');
  await page.goto(`${BASE}/tax-exempt?success=error&msg=${payload}`);
  await page.locator('[data-taxexempt-error]').waitFor({ timeout: 4000 });
  assert.equal(await page.evaluate(() => window.__xss), undefined, 'msg must not execute');
  assert.equal(await page.locator('[data-taxexempt-error] img').count(), 0, 'msg must not inject markup');
});

// ── REGRESSION: $80-shipping custom-line loss (2026-07-21) ───────────────────
// Reproduces Alex's exact keystroke sequence: type a partial title, PAUSE past the old 600ms
// debounce, finish the title, enter the price, commit. On the pre-fix build the pause committed
// "UPS world" × 1 @ $0.00 and the corrected data was replay-swallowed; this asserts the server
// truth (line-state) ends with exactly ONE custom line carrying the FULL title and price.
console.log('\nUI tests — REGRESSION: custom-line explicit commit (real keystrokes):');

await test('slow-typed custom line commits ONCE, with full title and $80 price', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/orders/1007`);
  await page.waitForSelector('#edit-form', { timeout: 8000 });
  await page.click('#edit-btn'); // custom-line controls live behind edit mode
  await page.click('button[onclick="addCustomLineRow()"]');
  await page.waitForSelector('tr.custom-line-new .ncl-title', { timeout: 4000 });

  // Real keystrokes with a mid-title pause LONGER than the old debounce window.
  await page.type('tr.custom-line-new .ncl-title', 'UPS world', { delay: 25 });
  await page.waitForTimeout(900); // old build: premature $0 commit fired here
  await page.type('tr.custom-line-new .ncl-title', 'wide saver', { delay: 25 });
  await page.click('tr.custom-line-new .ncl-price', { clickCount: 3 });
  await page.type('tr.custom-line-new .ncl-price', '80', { delay: 25 });
  await page.waitForTimeout(900); // old build: second flush replay-swallowed here

  // The row must NOT have auto-committed during either pause.
  const premature = await page.$eval('tr.custom-line-new', tr => tr.dataset.committedLiId || null);
  assert.equal(premature, null, `row auto-committed during a typing pause (liId=${premature}) — the premature-$0 bug is back`);

  // Explicit commit via the Add button.
  await page.click('tr.custom-line-new .ncl-add');
  await page.waitForFunction(() => {
    const tr = document.querySelector('tr.custom-line-new');
    return tr && tr.dataset.committedLiId;
  }, { timeout: 8000 });

  // Assert SERVER truth, not UI chrome: exactly one UPS line, full title, price 80.
  const state = await page.evaluate(async () => {
    const r = await fetch('/api/orders/1007/line-state', { credentials: 'same-origin' });
    return r.json();
  });
  const ups = (state.lines || []).filter(l => (l.title || '').startsWith('UPS'));
  assert.equal(ups.length, 1, `expected exactly 1 UPS line, got ${ups.length}: ${JSON.stringify(ups.map(l => l.title))}`);
  assert.equal(ups[0].title, 'UPS worldwide saver', `title truncated: "${ups[0].title}"`);
  assert.equal(Number(ups[0].unitPrice), 80, `price lost: got ${ups[0].unitPrice}, expected 80`);
});

await test('committed custom row: price edit re-routes to line/price (not silently dropped)', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/orders/1008`);
  await page.waitForSelector('#edit-form', { timeout: 8000 });
  await page.click('#edit-btn'); // custom-line controls live behind edit mode
  await page.click('button[onclick="addCustomLineRow()"]');
  await page.waitForSelector('tr.custom-line-new .ncl-title', { timeout: 4000 });
  await page.type('tr.custom-line-new .ncl-title', 'Handling fee', { delay: 20 });
  await page.click('tr.custom-line-new .ncl-price', { clickCount: 3 });
  await page.type('tr.custom-line-new .ncl-price', '10', { delay: 20 });
  await page.click('tr.custom-line-new .ncl-add');
  await page.waitForFunction(() => document.querySelector('tr.custom-line-new')?.dataset.committedLiId, { timeout: 8000 });

  // Now CORRECT the price on the committed row — pre-fix this was silently ignored.
  await page.click('tr.custom-line-new .ncl-price', { clickCount: 3 });
  await page.type('tr.custom-line-new .ncl-price', '25', { delay: 20 });
  await page.keyboard.press('Tab'); // real focus move fires the change event
  await page.waitForTimeout(1200); // let the per-line debounce (500ms) flush

  const state = await page.evaluate(async () => {
    const r = await fetch('/api/orders/1008/line-state', { credentials: 'same-origin' });
    return r.json();
  });
  const fee = (state.lines || []).find(l => l.title === 'Handling fee');
  assert.ok(fee, 'Handling fee line missing from server state');
  assert.equal(Number(fee.unitPrice), 25, `post-commit price edit dropped: got ${fee.unitPrice}, expected 25`);
});

// REGRESSION (caught by adversarial review of the 30d3709 fix itself, 2026-07-21):
// the custom-line idemKey MUST stay row-scoped (sticky). A fresh uuid per Add click means that
// when Shopify commits but the HTTP response is lost, the retry stages a SECOND real money line
// that Shopify cannot delete. This drops the response of the first Add AFTER the server has
// processed it — exactly that scenario — and asserts the retry replays instead of double-adding.
await test('REGRESSION: lost response on Add → retry REPLAYS, does not double-add a money line', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  let dropOnce = true;
  await page.route('**/line/custom', async route => {
    if (dropOnce) {
      dropOnce = false;
      await route.fetch();          // server DOES receive + commit it
      await route.abort('failed');  // ...but the browser never sees the response
      return;
    }
    await route.continue();
  });

  await page.goto(`${BASE}/orders/1007`);
  await page.waitForSelector('#edit-form', { timeout: 8000 });
  await page.click('#edit-btn');
  await page.click('button[onclick="addCustomLineRow()"]');
  await page.waitForSelector('tr.custom-line-new .ncl-title', { timeout: 4000 });
  await page.type('tr.custom-line-new .ncl-title', 'Lost response fee', { delay: 20 });
  await page.click('tr.custom-line-new .ncl-price', { clickCount: 3 });
  await page.type('tr.custom-line-new .ncl-price', '42', { delay: 20 });

  const keyBefore = await page.$eval('tr.custom-line-new', tr => tr.dataset.idemKey || null);
  await page.click('tr.custom-line-new .ncl-add');
  await page.waitForFunction(() => {
    const c = document.querySelector('tr.custom-line-new .row-save-chip');
    return c && c.dataset.state === 'failed';
  }, { timeout: 10000 });

  // The row must have STAMPED a key on the first attempt and must REUSE it on retry.
  const keyAfter = await page.$eval('tr.custom-line-new', tr => tr.dataset.idemKey || null);
  assert.ok(keyAfter, 'row did not stamp a sticky idemKey — a fresh key per click double-adds');
  assert.equal(keyBefore, null, 'key should be minted at first submit, not at row creation');

  await page.click('tr.custom-line-new .ncl-add'); // operator retries the "failed" line
  await page.waitForFunction(() => document.querySelector('tr.custom-line-new')?.dataset.committedLiId, { timeout: 10000 });

  const retryKey = await page.$eval('tr.custom-line-new', tr => tr.dataset.idemKey || null);
  assert.equal(retryKey, keyAfter, `retry minted a NEW key (${retryKey} != ${keyAfter}) — this is the double-add regression`);

  // Server truth: exactly ONE such line, at the right price.
  const state = await page.evaluate(async () => {
    const r = await fetch('/api/orders/1007/line-state', { credentials: 'same-origin' });
    return r.json();
  });
  const fees = (state.lines || []).filter(l => l.title === 'Lost response fee' && (l.currentQuantity || 0) > 0);
  assert.equal(fees.length, 1, `DOUBLE-ADD: expected 1 "Lost response fee" line, got ${fees.length}`);
  assert.equal(Number(fees[0].unitPrice), 42, `price wrong: got ${fees[0].unitPrice}`);
});

// REGRESSION (order-discount latch, 2026-07-21): the discount bar used to commit on BLUR behind a
// one-way latch, so a half-typed value committed and every correction was silently discarded — no
// request, no error, inputs still editable. Real keystrokes, asserting server truth.
await test('REGRESSION: discount does NOT commit on blur, and a correction is NOT silently discarded', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/orders/1008`);
  await page.waitForSelector('#edit-form', { timeout: 8000 });
  await page.click('#edit-btn');
  await page.waitForSelector('#edit-discount-bar', { state: 'visible', timeout: 4000 });

  // NB: no eval() — the page's CSP is script-src 'self' 'unsafe-inline' (no 'unsafe-eval'),
  // so a stringified predicate throws. Inline the filter.
  // 2026-08-05: an order discount is a per-line discount ALLOCATION, not a line item, so this reads
  // the line-state `discount` summary instead of filtering lines on an "Order discount: " title.
  // Still returns an array so the surrounding "exactly 1" assertions keep their meaning: 0 entries =
  // nothing applied, 1 entry = exactly one distinct order discount on the order.
  const readDisc = () => page.evaluate(async () => {
    const r = await fetch('/api/orders/1008/line-state', { credentials: 'same-origin' });
    const s = await r.json();
    const d = s.discount || { amount: 0 };
    return d.amount > 0 ? [{ title: d.reason, amt: d.amount }] : [];
  });

  // Type a WRONG percentage and tab away — the old build committed right here.
  await page.type('#edit-discount-bar input[name="discountPct"]', '10', { delay: 25 });
  await page.type('#edit-discount-bar input[name="discountReason"]', 'Bulk deal', { delay: 25 });
  await page.keyboard.press('Tab');
  await page.waitForTimeout(1200);
  assert.equal((await readDisc()).length, 0, 'discount committed on BLUR — the premature-commit bug is back');

  // Correct it to 20 BEFORE applying, then apply explicitly.
  await page.click('#edit-discount-bar input[name="discountPct"]', { clickCount: 3 });
  await page.type('#edit-discount-bar input[name="discountPct"]', '20', { delay: 25 });
  await page.click('#discount-apply-btn');
  await page.waitForFunction(() => document.getElementById('discount-chip')?.dataset.state === 'saved', { timeout: 10000 });

  const afterFirst = await readDisc();
  assert.equal(afterFirst.length, 1, `expected 1 discount line, got ${afterFirst.length}`);

  // Now CORRECT an already-applied discount — the old latch swallowed this entirely.
  await page.click('#edit-discount-bar input[name="discountPct"]', { clickCount: 3 });
  await page.type('#edit-discount-bar input[name="discountPct"]', '5', { delay: 25 });
  await page.click('#discount-apply-btn');
  await page.waitForFunction(() => document.getElementById('discount-chip')?.dataset.state === 'saved', { timeout: 10000 });

  const afterSecond = await readDisc();
  assert.equal(afterSecond.length, 1, `DOUBLE-DISCOUNT: expected exactly 1 active discount line, got ${afterSecond.length}`);
  assert.ok(afterSecond[0].amt < afterFirst[0].amt,
    `correction to a SMALLER % was discarded: was ${afterFirst[0].amt}, now ${afterSecond[0].amt}`);
});

// ── REGRESSION: catalog-row qty loss + batch-Save double-add (2026-07-21) ────
console.log('\nUI tests — REGRESSION: catalog row edits + Save race:');

// Catalog picker rows auto-commit at qty 1 (INTENTIONAL — see the auto-save test above), but had
// NO listener on .cl-qty/.cl-price and no name attribute, and serializeCustomLines skips a row once
// committedLiId is set. So a qty typed after the auto-add was dropped by BOTH paths: the order
// shipped 1 while the pill read "All changes saved".
await test('REGRESSION: qty typed on a committed catalog row PERSISTS (was silently dropped)', async (page, ctx) => {
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/orders/1001`);
  await page.waitForSelector('#edit-btn');
  await page.click('#edit-btn');
  await page.waitForSelector('#edit-product-search', { state: 'visible' });
  await page.fill('#edit-product-search', 'pinpoint');
  await page.waitForSelector('#edit-product-results .edit-var-cb', { timeout: 5000 });
  await page.locator('#edit-product-results .edit-var-cb').nth(0).check();
  await page.click('#edit-add-selected');

  const row = page.locator('#edit-form tr.catalog-line-new').first();
  await row.waitFor();
  await page.waitForFunction(() => document.querySelector('#edit-form tr.catalog-line-new')?.dataset.committedLiId, { timeout: 8000 });
  const liId = await row.evaluate(el => el.dataset.committedLiId);

  // Real keystrokes: correct the quantity from the auto-committed 1 to 12.
  await row.locator('.cl-qty').click({ clickCount: 3 });
  await row.locator('.cl-qty').type('12', { delay: 25 });
  // NB: wait for the actual /line/qty round trip. The pill is NOT a valid signal here — the
  // per-line editor debounces 500ms before it increments `inflight`, so the pill still reads
  // "saved" from the previous state and asserting on it races the write.
  const qtyResp = page.waitForResponse(r => /\/line\/qty$/.test(new URL(r.url()).pathname), { timeout: 10000 });
  await page.keyboard.press('Tab');           // fire change
  await qtyResp;
  await page.waitForTimeout(150);

  const state = await page.evaluate(async () => (await (await fetch('/api/orders/1001/line-state', { credentials: 'same-origin' })).json()));
  const line = (state.lines || []).find(l => l.liId === liId);
  assert.ok(line, `committed catalog line ${liId} missing from server state`);
  assert.equal(line.currentQuantity, 12,
    `SILENT QTY LOSS: typed 12, server holds ${line.currentQuantity} — the order would ship the wrong amount`);
  assert.equal(errors.length, 0, 'no page errors; got: ' + errors.join(' | '));
});

// serializeCustomLines skipped a row only on committedLiId, which is stamped ON SUCCESS — so during
// the multi-second round trip the row looked uncommitted and the batch Save re-sent it through the
// no-idempotency batch path, adding the SAME line twice.
await test('REGRESSION: batch Save during an in-flight Add does NOT double-add', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/orders/1008`);
  await page.waitForSelector('#edit-btn');
  await page.click('#edit-btn');

  // Hold the incremental commit open so the in-flight window is deterministic.
  let release;
  const held = new Promise(r => { release = r; });
  await page.route('**/line/custom', async route => {
    await held;
    await route.continue();
  });

  await page.click('button[onclick="addCustomLineRow()"]');
  await page.waitForSelector('tr.custom-line-new .ncl-title', { timeout: 4000 });
  await page.type('tr.custom-line-new .ncl-title', 'Race fee', { delay: 15 });
  await page.click('tr.custom-line-new .ncl-price', { clickCount: 3 });
  await page.type('tr.custom-line-new .ncl-price', '30', { delay: 15 });
  await page.click('tr.custom-line-new .ncl-add');

  // Mid-flight: the row must be hidden from the serializer AND the Save button disabled.
  await page.waitForFunction(() => document.querySelector('tr.custom-line-new')?.dataset.committing === '1', { timeout: 4000 });
  const serialized = await page.evaluate(() => {
    window.serializeCustomLines();
    return document.getElementById('addCustomLinesInput').value;
  });
  assert.equal(serialized, '[]',
    `DOUBLE-ADD: an in-flight row was serialized into the batch payload (${serialized}) — Save would re-add it`);
  const saveDisabled = await page.$eval('#edit-save-btn', b => b.disabled);
  assert.equal(saveDisabled, true, 'Save must be disabled while an incremental write is in flight');

  release();
  await page.waitForFunction(() => document.querySelector('tr.custom-line-new')?.dataset.committedLiId, { timeout: 10000 });

  const state = await page.evaluate(async () => (await (await fetch('/api/orders/1008/line-state', { credentials: 'same-origin' })).json()));
  const fees = (state.lines || []).filter(l => l.title === 'Race fee' && (l.currentQuantity || 0) > 0);
  assert.equal(fees.length, 1, `expected exactly 1 "Race fee" line, got ${fees.length}`);
  const reEnabled = await page.$eval('#edit-save-btn', b => b.disabled);
  assert.equal(reEnabled, false, 'Save must re-enable once writes settle');
});

// Edits typed DURING the in-flight add previously landed on an unset committedLiId and were
// stranded forever — the inputs never change again, so no later event could flush them.
await test('REGRESSION: qty typed WHILE the add is in flight is flushed after commit', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/orders/1001`);
  await page.waitForSelector('#edit-btn');
  await page.click('#edit-btn');

  let release;
  const held = new Promise(r => { release = r; });
  await page.route('**/line/add', async route => { await held; await route.continue(); });

  await page.waitForSelector('#edit-product-search', { state: 'visible' });
  await page.fill('#edit-product-search', 'pinpoint');
  await page.waitForSelector('#edit-product-results .edit-var-cb', { timeout: 5000 });
  await page.locator('#edit-product-results .edit-var-cb').nth(0).check();
  await page.click('#edit-add-selected');

  const row = page.locator('#edit-form tr.catalog-line-new').first();
  await row.waitFor();
  // Type while still in flight — committedLiId is not set yet.
  await row.locator('.cl-qty').click({ clickCount: 3 });
  await row.locator('.cl-qty').type('7', { delay: 15 });
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => document.querySelector('#edit-form tr.catalog-line-new')?.dataset.dirty, { timeout: 4000 });

  // Same caveat as above — wait for the flushed /line/qty round trip, not the pill.
  const flushed = page.waitForResponse(r => /\/line\/qty$/.test(new URL(r.url()).pathname), { timeout: 15000 });
  release();
  await page.waitForFunction(() => document.querySelector('#edit-form tr.catalog-line-new')?.dataset.committedLiId, { timeout: 10000 });
  await flushed;
  await page.waitForTimeout(150);

  const liId = await row.evaluate(el => el.dataset.committedLiId);
  const state = await page.evaluate(async () => (await (await fetch('/api/orders/1001/line-state', { credentials: 'same-origin' })).json()));
  const line = (state.lines || []).find(l => l.liId === liId);
  assert.ok(line, 'committed line missing from server state');
  assert.equal(line.currentQuantity, 7,
    `in-flight edit stranded: typed 7 while adding, server holds ${line.currentQuantity}`);
});

// REGRESSION (found by adversarial review of the catalog fix — 5 of 6 reviewers independently):
// debouncedLine waits 500ms BEFORE it increments `inflight`. Gating the Save button on inflight
// alone therefore left a 500ms window where the pill read "All changes saved" and Save was
// ENABLED while a typed quantity sat in a timer. Clicking Save there navigates away, abandoning
// the write — and serializeCustomLines skips the row because it has a committedLiId, so the
// quantity reaches the server through NEITHER path. Same silent loss this change exists to kill.
await test('REGRESSION: Save is blocked during the 500ms debounce, not just while in flight', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/orders/1001`);
  await page.waitForSelector('#edit-btn');
  await page.click('#edit-btn');
  await page.waitForSelector('#edit-product-search', { state: 'visible' });
  await page.fill('#edit-product-search', 'pinpoint');
  await page.waitForSelector('#edit-product-results .edit-var-cb', { timeout: 5000 });
  await page.locator('#edit-product-results .edit-var-cb').nth(0).check();
  await page.click('#edit-add-selected');

  const row = page.locator('#edit-form tr.catalog-line-new').first();
  await row.waitFor();
  await page.waitForFunction(() => document.querySelector('#edit-form tr.catalog-line-new')?.dataset.committedLiId, { timeout: 8000 });
  // Settle fully so any residual busy-state is gone before we measure.
  await page.waitForFunction(() => document.getElementById('edit-save-btn') && !document.getElementById('edit-save-btn').disabled, { timeout: 8000 });

  // Type a qty and inspect the window BEFORE the debounce fires (no request yet).
  await row.locator('.cl-qty').click({ clickCount: 3 });
  await row.locator('.cl-qty').type('9', { delay: 10 });
  await page.keyboard.press('Tab');

  const during = await page.evaluate(() => ({
    saveDisabled: document.getElementById('edit-save-btn')?.disabled,
    pill: document.getElementById('autosave-pill')?.dataset.state,
  }));
  assert.equal(during.saveDisabled, true,
    'SILENT LOSS WINDOW: Save was clickable while a typed qty was still only scheduled — submitting here abandons the write');
  assert.equal(during.pill, 'saving', `pill should show unsaved work during the debounce, got "${during.pill}"`);

  // And it must recover — a permanently disabled Save would be its own outage.
  await page.waitForResponse(r => /\/line\/qty$/.test(new URL(r.url()).pathname), { timeout: 10000 });
  await page.waitForFunction(() => {
    const b = document.getElementById('edit-save-btn');
    const p = document.getElementById('autosave-pill');
    return b && !b.disabled && p && p.dataset.state === 'saved';
  }, { timeout: 10000 });

  const liId = await row.evaluate(el => el.dataset.committedLiId);
  const state = await page.evaluate(async () => (await (await fetch('/api/orders/1001/line-state', { credentials: 'same-origin' })).json()));
  const line = (state.lines || []).find(l => l.liId === liId);
  assert.equal(line?.currentQuantity, 9, `qty did not persist: server holds ${line?.currentQuantity}`);
});

// REGRESSION (reconciler follow-up, 2026-07-21): flushDirty used to hang off the ORIGINAL run()
// promise, which had already settled when the Add failed. A chip RETRY is a fresh run() that the
// old promise knew nothing about, so a quantity typed between the failure and the retry was never
// sent: the row displayed the new number with a green chip while the server held the original.
// Worse, re-typing the same number fires no change event, so the operator could not dislodge it.
await test('REGRESSION: qty typed after a FAILED add is flushed by the chip retry', async (page, ctx) => {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);

  // Fail the first /line/add, let everything after it through.
  let failOnce = true;
  await page.route('**/line/add', async route => {
    if (failOnce) {
      failOnce = false;
      await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ ok: false, errors: ['simulated failure'] }) });
      return;
    }
    await route.continue();
  });

  await page.goto(`${BASE}/orders/1001`);
  await page.waitForSelector('#edit-btn');
  await page.click('#edit-btn');
  await page.waitForSelector('#edit-product-search', { state: 'visible' });
  await page.fill('#edit-product-search', 'pinpoint');
  await page.waitForSelector('#edit-product-results .edit-var-cb', { timeout: 5000 });
  await page.locator('#edit-product-results .edit-var-cb').nth(0).check();
  await page.click('#edit-add-selected');

  const row = page.locator('#edit-form tr.catalog-line-new').first();
  await row.waitFor();
  // The add failed — chip red, no committed id.
  await page.waitForFunction(() => {
    const c = document.querySelector('#edit-form tr.catalog-line-new .row-save-chip');
    return c && c.dataset.state === 'failed';
  }, { timeout: 10000 });
  assert.equal(await row.evaluate(el => el.dataset.committedLiId || null), null, 'failed add must not stamp a committed id');

  // Operator corrects the quantity BEFORE retrying.
  await row.locator('.cl-qty').click({ clickCount: 3 });
  await row.locator('.cl-qty').type('12', { delay: 15 });
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => document.querySelector('#edit-form tr.catalog-line-new')?.dataset.dirty, { timeout: 4000 });

  // Retry via the chip. The corrected qty must be flushed by whichever attempt commits.
  const qtyReq = page.waitForRequest(r => /\/line\/qty$/.test(new URL(r.url()).pathname) && r.method() === 'POST', { timeout: 15000 });
  await page.click('#edit-form tr.catalog-line-new .row-save-chip');
  await page.waitForFunction(() => document.querySelector('#edit-form tr.catalog-line-new')?.dataset.committedLiId, { timeout: 15000 });
  const req = await qtyReq;
  assert.equal(JSON.parse(req.postData() || '{}').qty, 12, 'the retry must carry the CORRECTED quantity');

  await page.waitForFunction(() => {
    const p = document.getElementById('autosave-pill');
    return p && p.dataset.state === 'saved';
  }, { timeout: 10000 });

  const liId = await row.evaluate(el => el.dataset.committedLiId);
  const state = await page.evaluate(async () => (await (await fetch('/api/orders/1001/line-state', { credentials: 'same-origin' })).json()));
  const line = (state.lines || []).find(l => l.liId === liId);
  assert.equal(line?.currentQuantity, 12,
    `SILENT LOSS: row shows 12 with a green chip but server holds ${line?.currentQuantity}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Order #38953, 2026-08-28: the page locked the whole desktop app.
//
// An operator typed 0 into a line's quantity box. Quantity 0 is a REMOVAL in Shopify's order-edit
// model, so the line was destroyed with no confirmation; typing a number back then failed with "The
// line item cannot be edited because it is removed" — permanently. The autosave controller counted
// that unfixable failure as unsaved work and armed a beforeunload guard on it, and Electron cancels
// a prevented unload SILENTLY (no dialog unless the app answers will-prevent-unload, which it did
// not). Result: "Generate PDF" (a form POST), the ← Orders link, every nav item and Quit itself all
// stopped responding, with no error, and the app had to be ended from Task Manager.
//
// These tests probe the guard DIRECTLY — dispatching a cancelable beforeunload and reading
// defaultPrevented — rather than trying to navigate. Playwright auto-dismisses beforeunload dialogs,
// so a successful goto() here would prove nothing about what Electron does; defaultPrevented is the
// exact bit Electron reads.
// ─────────────────────────────────────────────────────────────────────────────

const unloadBlocked = (page) => page.evaluate(() => {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
});

async function openEditMode(page, ctx, orderId = 1001) {
  const sid = await seedSession();
  await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  await page.goto(`${BASE}/orders/${orderId}`);
  await page.waitForSelector('#edit-btn');
  await page.click('#edit-btn');
  await page.waitForSelector('#edit-form tr[data-existing="1"] .edit-qty-input', { state: 'visible' });
  return page.locator('#edit-form tr[data-existing="1"]').first();
}

await test('THE #38953 LOCK-UP: a TERMINAL rejection must not make the page unleavable', async (page, ctx) => {
  // Exactly what Shopify answers for a line a prior edit removed.
  await page.route('**/line/qty', route => route.fulfill({
    status: 422, contentType: 'application/json',
    body: JSON.stringify({ ok: false, terminal: true, errors: ['The line item cannot be edited because it is removed'] }),
  }));

  const row = await openEditMode(page, ctx);
  assert.equal(await unloadBlocked(page), false, 'a freshly opened edit mode must not block navigation');

  await row.locator('.edit-qty-input').fill('3');
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => {
    const c = document.querySelector('#edit-form tr[data-existing="1"] .row-save-chip');
    return c && c.dataset.state === 'failed';
  }, { timeout: 10000 });

  // The operator MUST still see that it did not save...
  const chip = row.locator('.row-save-chip');
  assert.equal(await chip.getAttribute('data-terminal'), '1', 'the rejection must be marked terminal');
  assert.match(await chip.textContent(), /Rejected/, 'the row has to show the edit did not land');
  assert.match(await chip.getAttribute('title'), /cannot be edited because it is removed/,
    'the real Shopify reason must be readable, not swallowed');

  // ...and must NOT be held on the page for it. This assertion is the whole bug.
  assert.equal(await unloadBlocked(page), false,
    'THE LOCK-UP: an unfixable rejection armed beforeunload, and Electron then killed every link, ' +
    'the back button, Generate PDF and Quit with no dialog at all');
  assert.notEqual(await page.locator('#autosave-pill').getAttribute('data-state'), 'failed',
    'a rejection nothing can save is not "unsaved work"');

  // A retry click would only re-run a guaranteed failure, so it must not be offered.
  assert.equal(await chip.evaluate(el => el.style.cursor), 'default', 'terminal chips offer no retry');
});

await test('a RETRYABLE failure still warns — and "Leave anyway" gets the operator out', async (page, ctx) => {
  await page.route('**/line/qty', route => route.fulfill({
    status: 422, contentType: 'application/json',
    body: JSON.stringify({ ok: false, errors: ['Throttled'] }),   // no `terminal` — this one can be retried
  }));

  const row = await openEditMode(page, ctx);
  await row.locator('.edit-qty-input').fill('4');
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => document.getElementById('autosave-pill')?.dataset.state === 'failed', { timeout: 10000 });

  // Warning is CORRECT here: the edit really could still be saved, so leaving really would lose it.
  assert.equal(await unloadBlocked(page), true, 'genuinely unsaved work must still warn');
  assert.equal(await row.locator('.row-save-chip').getAttribute('data-terminal'), null, 'transient failures stay retryable');
  await page.waitForSelector('#autosave-leave-anyway', { state: 'visible' });

  // But it must always be escapable from inside the page — an operator on an older desktop build
  // has no Leave/Stay dialog, and this button is the only thing standing between them and Task Manager.
  await page.click('#autosave-leave-anyway');
  assert.equal(await unloadBlocked(page), false, '"Leave anyway" must actually release the page');
  assert.match(await page.locator('#autosave-pill').textContent(), /unlocked/i, 'and say so, so the state is not a mystery');
});

await test('quantity 0 never reaches the wire — the box reverts instead of destroying the line', async (page, ctx) => {
  const qtyPosts = [];
  page.on('request', r => { if (/\/line\/qty$/.test(new URL(r.url()).pathname) && r.method() === 'POST') qtyPosts.push(r); });

  const row = await openEditMode(page, ctx);
  const qty = row.locator('.edit-qty-input');
  const before = await qty.inputValue();

  await qty.fill('0');
  await page.keyboard.press('Tab');
  // Proving a NEGATIVE: wait past the 500ms debounce, or "no request yet" means nothing.
  await page.waitForTimeout(900);

  assert.equal(qtyPosts.length, 0,
    'qty 0 is an IRREVERSIBLE removal in Shopify — it must never be sent as an ordinary quantity edit');
  assert.equal(await qty.inputValue(), before, `the box must revert to its last accepted value (${before})`);
  const chip = row.locator('.row-save-chip');
  assert.match(await chip.getAttribute('title'), /at least 1/i, 'and say why, pointing at the Remove control');
  assert.equal(await chip.getAttribute('data-terminal'), '1', 'a refusal we made ourselves is not retryable work');
  assert.equal(await unloadBlocked(page), false, 'refusing to send something must not strand the operator');

  // min= is only advisory while typing, but it must still be right — it is one of the three copies
  // of this floor, and the browser's own spinner obeys it.
  assert.equal(await qty.getAttribute('min'), '1');
});

await test('a committed removal LOCKS its row — no un-toggle, no editable inputs', async (page, ctx) => {
  // Stubbed so the shared mock fixture is not mutated for later runs; the server half of removal is
  // covered in api.test.mjs.
  await page.route('**/line/remove', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }),
  }));

  const row = await openEditMode(page, ctx);
  await row.locator('button.edit-remove-btn:not(.bo-action-btn)').click();
  await page.waitForFunction(() => document.querySelector('#edit-form tr[data-existing="1"]')?.dataset.lineRemoved === '1',
    { timeout: 10000 });

  assert.equal(await row.locator('.edit-qty-input').isDisabled(), true, 'a removed line must not look editable');
  assert.equal(await row.locator('.edit-price-input').isDisabled(), true);
  assert.equal(await row.locator('button.edit-remove-btn:not(.bo-action-btn)').isDisabled(), true,
    'markRemove was a TOGGLE — clicking ✕ again un-dimmed the row while the line stayed gone from the order');

  // Leaving and re-entering edit mode must not resurrect it either.
  await page.click('#edit-mode-bar button.btn-ghost');
  await page.click('#edit-btn');
  await page.waitForSelector('#edit-form tr[data-existing="1"] .edit-qty-input', { state: 'visible' });
  assert.equal(await row.evaluate(el => el.dataset.lineRemoved), '1', 'the removal must survive an edit-mode round trip');
  assert.equal(await row.locator('.edit-qty-input').isDisabled(), true,
    'toggleEditMode re-enabled the inputs of a removed line — the next edit could then only ever fail');
  assert.equal(await unloadBlocked(page), false);
});

await browser.close();

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
