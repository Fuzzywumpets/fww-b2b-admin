// Standalone unit test: the isolated TEST copy (B2B_ADMIN_TEST_ENV=1) must refuse to start while any
// outside service still points at production, and a normal prod run must resolve the exact production
// URLs server.mjs used to hardcode.
//
// Why standalone: the guard runs at module load, before the mock HTTP server exists, and its whole
// point is the non-MOCK path.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  resolveServiceConfig, testEnvProblems, assertTestEnvIsolated,
  PROD_SHOPIFY_BRIDGE_URL, PROD_XERO_BRIDGE_URL, PROD_PORTAL_INTERNAL_URL,
} from '../lib/test-env.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const DEV_BRIDGE = 'https://shopify-bridge-dev.example.workers.dev/api/graphql';

console.log('\n── Unit: test-environment isolation guard ──\n');

test('prod run (no TEST_ENV) resolves the exact production URLs and has no problems', () => {
  const c = resolveServiceConfig({});
  assert(!c.testEnv);
  assert(c.shopifyBridgeUrl === PROD_SHOPIFY_BRIDGE_URL, c.shopifyBridgeUrl);
  assert(c.xeroBridgeUrl === PROD_XERO_BRIDGE_URL, c.xeroBridgeUrl);
  assert(c.portalInternalUrl === PROD_PORTAL_INTERNAL_URL, c.portalInternalUrl);
  assert(testEnvProblems(c).length === 0);
});

test('TEST_ENV with no Shopify override is refused', () => {
  const p = testEnvProblems(resolveServiceConfig({ B2B_ADMIN_TEST_ENV: '1' }));
  assert(p.some(x => x.includes('SHOPIFY_BRIDGE_URL')), JSON.stringify(p));
});

test('TEST_ENV pointed at the prod bridge explicitly is refused', () => {
  const p = testEnvProblems(resolveServiceConfig({ B2B_ADMIN_TEST_ENV: '1', B2B_ADMIN_SHOPIFY_BRIDGE_URL: PROD_SHOPIFY_BRIDGE_URL + '?x' }));
  assert(p.length === 1, JSON.stringify(p));
});

test('TEST_ENV with Xero bearer + prod Xero bridge is refused; without the bearer it is allowed', () => {
  const base = { B2B_ADMIN_TEST_ENV: '1', B2B_ADMIN_SHOPIFY_BRIDGE_URL: DEV_BRIDGE };
  assert(testEnvProblems(resolveServiceConfig({ ...base, XERO_BRIDGE_BEARER: 't' })).some(x => x.includes('Xero')));
  assert(testEnvProblems(resolveServiceConfig(base)).length === 0);
});

test('TEST_ENV with a portal token on the default (production) portal URL is refused', () => {
  const base = { B2B_ADMIN_TEST_ENV: '1', B2B_ADMIN_SHOPIFY_BRIDGE_URL: DEV_BRIDGE };
  assert(testEnvProblems(resolveServiceConfig({ ...base, B2B_PORTAL_INTERNAL_TOKEN: 't' })).some(x => x.includes('PORTAL')));
  assert(testEnvProblems(resolveServiceConfig({ ...base, B2B_PORTAL_INTERNAL_TOKEN: 't', B2B_PORTAL_INTERNAL_URL: 'http://127.0.0.1:18793' })).length === 0);
});

test('TEST_ENV with a Helcim token is refused', () => {
  const p = testEnvProblems(resolveServiceConfig({ B2B_ADMIN_TEST_ENV: '1', B2B_ADMIN_SHOPIFY_BRIDGE_URL: DEV_BRIDGE, HELCIM_API_TOKEN: 't' }));
  assert(p.some(x => x.includes('HELCIM')), JSON.stringify(p));
});

test('assertTestEnvIsolated throws with every problem listed', () => {
  let msg = '';
  try { assertTestEnvIsolated(resolveServiceConfig({ B2B_ADMIN_TEST_ENV: '1', HELCIM_API_TOKEN: 't' })); } catch (e) { msg = e.message; }
  assert(msg.includes('SHOPIFY_BRIDGE_URL') && msg.includes('HELCIM'), msg);
});

test('server.mjs itself exits before listening when TEST_ENV is not isolated', () => {
  const server = fileURLToPath(new URL('../server.mjs', import.meta.url));
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, B2B_ADMIN_TEST_ENV: '1', PORT: '18999' };
  const r = spawnSync(process.execPath, [server], { env, encoding: 'utf8', timeout: 20000 });
  assert(r.status !== 0 && r.status !== null, `expected a non-zero exit, got status ${r.status}`);
  assert(/not isolated from production/.test(r.stderr), r.stderr.slice(0, 300));
  assert(!/listening/.test(r.stdout), 'server started listening');
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
