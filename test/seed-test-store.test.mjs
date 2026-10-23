// Standalone unit test for scripts/seed-test-store.mjs — the guards that keep a destructive seed/reset
// script off the production store. The Shopify calls themselves are covered by shopify-schema.test.mjs
// (which scans this script) and by running it against the dev store.
import assert from 'node:assert/strict';
import { assertSeedTarget, upsertEnvLine, clearTestCache, seed, TEST_BRIDGE_URL, SEED_CUSTOMERS } from '../scripts/seed-test-store.mjs';
import { PROD_SHOPIFY_BRIDGE_URL } from '../lib/test-env.mjs';

let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log('  ok', name); };
console.log('── Unit: seed-test-store guards ──');

await t('refuses the production bridge', () => assert.throws(() => assertSeedTarget(PROD_SHOPIFY_BRIDGE_URL), /refusing/));
await t('refuses unset / look-alike bridge', () => {
  assert.throws(() => assertSeedTarget(undefined), /refusing/);
  assert.throws(() => assertSeedTarget(TEST_BRIDGE_URL + '?x'), /refusing/);
});
await t('accepts the test bridge', () => assertSeedTarget(TEST_BRIDGE_URL));
await t('seed() refuses before any network call', async () => {
  const realFetch = globalThis.fetch; let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('no'); };
  try { await assert.rejects(seed({ bridgeUrl: PROD_SHOPIFY_BRIDGE_URL, bearer: 'x' }), /refusing/); }
  finally { globalThis.fetch = realFetch; }
  assert.equal(called, false);
});
await t('seed() refuses when the shop is not the dev store', async () => {
  const realFetch = globalThis.fetch; const bodies = [];
  globalThis.fetch = async (_u, o) => { bodies.push(o.body); return new Response(JSON.stringify({ data: {
    shop: { myshopifyDomain: 'parttwoenterprises.myshopify.com' }, locations: { nodes: [] }, publications: { nodes: [] } } })); };
  try { await assert.rejects(seed({ bridgeUrl: TEST_BRIDGE_URL, bearer: 'x' }), /expected fww-b2b-admin-test/); }
  finally { globalThis.fetch = realFetch; }
  assert.equal(bodies.length, 1);
  assert.doesNotMatch(bodies[0], /mutation/);
});
await t('upsertEnvLine replaces or appends', () => {
  assert.equal(upsertEnvLine('A=1\nB2B_ADMIN_B2B_PUBLICATION_ID=old\nC=2\n', 'B2B_ADMIN_B2B_PUBLICATION_ID', 'new'), 'A=1\nB2B_ADMIN_B2B_PUBLICATION_ID=new\nC=2\n');
  assert.equal(upsertEnvLine('A=1', 'K', 'v'), 'A=1\nK=v\n');
});
await t('--cache-db refuses a non-test path', () => assert.rejects(clearTestCache('/home/alexa/projects/fww-b2b-admin/data/admin.db'), /TEST data dir/));
await t('seed covers Champ Dog, no-company, filled and blank', () => {
  assert.ok(SEED_CUSTOMERS.some(c => c.company === 'Champ Dog'));
  assert.ok(SEED_CUSTOMERS.some(c => !c.company));
  assert.ok(SEED_CUSTOMERS.some(c => Object.keys(c.b2b).length >= 4));
  assert.ok(SEED_CUSTOMERS.some(c => c.company && !Object.keys(c.b2b).length));
});
console.log(`  ${pass} passed`);
