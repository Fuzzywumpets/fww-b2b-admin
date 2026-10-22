// Standalone source test: metafieldsDelete must select fields that exist on MetafieldsDeletePayload.
//
// Why standalone: applyB2bConfigUpdate only calls Shopify outside MOCK, so the mock HTTP server never
// sends this mutation. Shopify rejects the WHOLE request for an unknown field, which crashed the
// customer B2B-settings save whenever a field was cleared (2026-10-22, Champ Dog dropship rules).
// Valid payload fields (live introspection, 2026-10-22): deletedMetafields, userErrors.

import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}

console.log('\n── Unit: metafieldsDelete payload selection ──\n');
test('no query selects the removed deletedMetafieldIds field', () => {
  if (src.includes('deletedMetafieldIds')) throw new Error('deletedMetafieldIds is not on MetafieldsDeletePayload');
});
test('every metafieldsDelete selection uses only deletedMetafields / userErrors', () => {
  const sels = [...src.matchAll(/metafieldsDelete\(metafields:\$m\)\{([^]*?)\}\s*\}`/g)].map(m => m[1]);
  if (!sels.length) throw new Error('could not find the metafieldsDelete mutation — did it move?');
  for (const s of sels) {
    const top = s.replace(/\{[^{}]*\}/g, '').trim().split(/\s+/);
    for (const f of top) if (!['deletedMetafields', 'userErrors'].includes(f)) throw new Error(`unknown field: ${f}`);
  }
});
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
