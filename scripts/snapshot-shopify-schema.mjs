// WHAT: Re-introspects the Shopify Admin GraphQL schema (through the same shopify-bridge the app
// calls) into test/fixtures/shopify-admin-schema.json for test/shopify-schema.test.mjs.
// Run when the bridge's Shopify API version changes:  doppler run -- node scripts/snapshot-shopify-schema.mjs
// DEPENDS: must hit the SAME endpoint as server.mjs shopifyFetch, or the snapshot validates against
// a different API version than production uses.
import { writeFileSync } from 'node:fs';
import { getIntrospectionQuery } from 'graphql';

const res = await fetch(process.env.B2B_ADMIN_SHOPIFY_BRIDGE_URL || 'https://shopify-bridge.alex-037.workers.dev/api/graphql', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SHOPIFY_BRIDGE_BEARER}` },
  body: JSON.stringify({ query: getIntrospectionQuery({ descriptions: false }) }),
});
const json = await res.json();
if (!res.ok || json.errors?.length || !json.data?.__schema) {
  console.error('introspection failed', res.status, JSON.stringify(json.errors || json).slice(0, 500));
  process.exit(1);
}
const out = { capturedAt: new Date().toISOString(), data: json.data };
writeFileSync(new URL('../test/fixtures/shopify-admin-schema.json', import.meta.url), JSON.stringify(out));
console.log('wrote schema:', json.data.__schema.types.length, 'types');
