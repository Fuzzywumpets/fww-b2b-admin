// WHAT: configuration for the isolated TEST copy of b2badmin (B2B_ADMIN_TEST_ENV=1) — the copy that
// Gauntlet is allowed to click and save against. Resolves the outside-service URLs and refuses to
// start if any of them still points at production.
// CHANGE-GUARD: the PROD_* constants are the production defaults server.mjs used to hardcode. A prod
// run (no TEST_ENV) must resolve to exactly these values, or every live Shopify/Xero call moves.
// INVARIANT(S): assertTestEnvIsolated() throws (process exits before listen) rather than warns — a
// mis-set test copy writing to the live store is the one failure this module exists to prevent.

export const PROD_SHOPIFY_BRIDGE_URL = 'https://shopify-bridge.alex-037.workers.dev/api/graphql';
export const PROD_XERO_BRIDGE_URL = 'https://fww-xero-bridge.alex-037.workers.dev/xero';
export const PROD_PORTAL_INTERNAL_URL = 'http://127.0.0.1:8793';
const PROD_HOST_MARKERS = ['shopify-bridge.alex-037.', 'fww-xero-bridge.alex-037.', 'parttwoenterprises'];

// DEPENDS: server.mjs reads these once at startup (shopifyFetch, xeroRequest, callPortalInternal).
// Admin-specific env names on purpose: Doppler prd already has a generic SHOPIFY_BRIDGE_URL that a
// copied test config could carry, so the test copy must opt in under a name only it sets.
export function resolveServiceConfig(env = process.env) {
  const testEnv = env.B2B_ADMIN_TEST_ENV === '1';
  return {
    testEnv,
    shopifyBridgeUrl: env.B2B_ADMIN_SHOPIFY_BRIDGE_URL || PROD_SHOPIFY_BRIDGE_URL,
    xeroBridgeUrl: env.B2B_ADMIN_XERO_BRIDGE_URL || PROD_XERO_BRIDGE_URL,
    portalInternalUrl: env.B2B_PORTAL_INTERNAL_URL || PROD_PORTAL_INTERNAL_URL,
    xeroBearerSet: Boolean(env.XERO_BRIDGE_BEARER),
    portalTokenSet: Boolean(env.B2B_PORTAL_INTERNAL_TOKEN),
    helcimTokenSet: Boolean(env.HELCIM_API_TOKEN),
  };
}

const isProdUrl = (url, prodUrl) =>
  url === prodUrl || PROD_HOST_MARKERS.some(m => String(url).includes(m));

// Returns the list of problems; empty means the test copy is isolated from production.
export function testEnvProblems(cfg) {
  if (!cfg.testEnv) return [];
  const p = [];
  if (isProdUrl(cfg.shopifyBridgeUrl, PROD_SHOPIFY_BRIDGE_URL))
    p.push('B2B_ADMIN_SHOPIFY_BRIDGE_URL must point at the dev-store bridge, not production');
  // Xero: either no bearer (requests stay in-process mock) or a non-production bridge.
  if (cfg.xeroBearerSet && isProdUrl(cfg.xeroBridgeUrl, PROD_XERO_BRIDGE_URL))
    p.push('XERO_BRIDGE_BEARER is set while the Xero bridge URL is production — unset it or point B2B_ADMIN_XERO_BRIDGE_URL elsewhere');
  // Portal: it emails customers and posts customer-visible notes. Without a token every call
  // fails closed ({ok:false}); with one, the URL must not be the production portal.
  if (cfg.portalTokenSet && cfg.portalInternalUrl === PROD_PORTAL_INTERNAL_URL)
    p.push('B2B_PORTAL_INTERNAL_TOKEN is set while the portal URL is the production default — unset it or point B2B_PORTAL_INTERNAL_URL at a test portal');
  if (cfg.helcimTokenSet)
    p.push('HELCIM_API_TOKEN must not be set in the test environment (credit-card invoices are real charges)');
  return p;
}

export function assertTestEnvIsolated(cfg) {
  const problems = testEnvProblems(cfg);
  if (problems.length) {
    throw new Error('B2B_ADMIN_TEST_ENV=1 but the test copy is not isolated from production:\n  - ' + problems.join('\n  - '));
  }
}
