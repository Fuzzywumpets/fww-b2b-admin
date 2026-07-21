import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:8896';
const DELAY_EDIT_MS = parseInt(process.env.DELAY_EDIT_MS || '0', 10);

const res = await fetch(`${BASE}/__test__/session?email=alex@fuzzywumpets.com`);
const { sid } = await res.json();
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
await ctx.addCookies([{ name: 'b2b_admin_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
const page = await ctx.newPage();

const reqs = [];
page.on('request', r => reqs.push(r.method() + ' ' + new URL(r.url()).pathname));

// Simulate real-mode Shopify latency on the batch navigation POST.
if (DELAY_EDIT_MS) {
  await page.route('**/orders/*/edit', async route => {
    if (route.request().method() === 'POST') {
      await new Promise(r => setTimeout(r, DELAY_EDIT_MS));
    }
    await route.continue();
  });
}

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
console.log('committed liId:', liId);

// THE OPERATOR GESTURE: type 12, then immediately click Save.
await row.locator('.cl-qty').click({ clickCount: 3 });
await row.locator('.cl-qty').type('12', { delay: 20 });

const btnState = await page.$eval('#edit-save-btn', b => ({ disabled: b.disabled }));
console.log('Save button state BEFORE click:', JSON.stringify(btnState));

// Real click on Save — this blurs the qty input (fires change) and submits.
await Promise.all([
  page.waitForNavigation({ timeout: 20000 }).catch(e => console.log('nav err:', e.message)),
  page.click('#edit-save-btn'),
]);

await page.waitForTimeout(1500);
console.log('requests seen:');
reqs.filter(r => /line|edit/.test(r)).forEach(r => console.log('   ', r));
console.log('  /line/qty issued? ', reqs.some(r => r.endsWith('/line/qty')));

const state = await (await fetch(`${BASE}/api/orders/1001/line-state`, { headers: { cookie: `b2b_admin_sid=${sid}` } })).json();
const line = (state.lines || []).find(l => l.liId === liId);
console.log('SERVER QTY for that line:', line ? line.currentQuantity : '(line missing)');
console.log(line && line.currentQuantity === 12 ? 'RESULT: qty PERSISTED (12)' : 'RESULT: QTY LOST');

await browser.close();
