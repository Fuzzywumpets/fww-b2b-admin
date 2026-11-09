// DeepReview 0.4.1 of #73, finding 4: deriveCurrentOrderTotals treated "current total == the frozen original total on an edited
// order" as Shopify LAGGING and replaced a correct total with subtotal + original extras. After a shipping edit that brings an edited
// order back to its original total (fixture #1008: frozen $300, lines now $110, shipping $190) the page then showed total $110.
//
// Own mock server: the shipping edit changes #1008 for good, and test/ui.test.mjs asserts #1008's fixture state on the shared server.
// Run: node test/order-total-coincidence.test.mjs
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; } catch (e) { console.log(`  ✗ ${name}\n      ${e.stack?.split('\n').slice(0, 4).join('\n      ')}`); failed++; }
}
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
async function startMockServer() {
  const port = await freePort();
  const env = {};
  for (const k of ['PATH', 'HOME', 'TEMP', 'TMP', 'NODE_OPTIONS']) if (process.env[k] != null) env[k] = process.env[k];
  Object.assign(env, { PORT: String(port), B2B_ADMIN_MOCK: '1', B2B_IMPERSONATION_SECRET: 'test-impersonation-secret-mock', SHOPIFY_WEBHOOK_SECRET: 'test-shopify-webhook-secret' });
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60 && child.exitCode == null; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) return { base, child }; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  child.kill();
  throw new Error(`mock server did not start:\n${log.slice(-800)}`);
}

const { base, child } = await startMockServer();
try {
  const sid = (await (await fetch(`${base}/__test__/session?email=alex@fuzzywumpets.com`)).json()).sid;
  const cookie = `b2b_admin_sid=${sid}`;
  const totals = async () => {
    const html = await (await fetch(`${base}/orders/1008`, { headers: { Cookie: cookie } })).text();
    const block = html.match(/<div class="totals-block">([\s\S]*?)<\/div>\s*<div id="edit-add-bar"/)[1];
    const row = label => (block.match(new RegExp(`<span>${label}</span><span>([^<]*)</span>`)) || [])[1];
    return { subtotal: row('Subtotal'), shipping: row('Shipping'), total: row('Total') };
  };
  console.log('\nOrder totals: a correct current total that equals the frozen original is not "lagging"');
  await test('the fixture starts at subtotal $110, shipping $0, total $110', async () => {
    assert.deepEqual(await totals(), { subtotal: '$110.00', shipping: '$0.00', total: '$110.00' });
  });
  await test('shipping $190 on edited #1008 (lines $110, frozen total $300) renders total $300, not $110', async () => {
    const res = await fetch(`${base}/orders/1008/shipping-charge`, {
      method: 'POST', redirect: 'manual',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ amount: '190', expectedAmount: '0', title: 'UPS', idemKey: 'coincidence-0001-abcdef' }),
    });
    assert.match(res.headers.get('location') || '', /success=shipping_saved/);
    assert.deepEqual(await totals(), { subtotal: '$110.00', shipping: '$190.00', total: '$300.00' });
  });
} finally { child.kill(); }
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
