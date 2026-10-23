# Handoff — b2badmin safe click-testing (2026-10-22)

Start here in a fresh session. Full detail: canonical memory `project_b2badmin_test_environment_2026_10_22.md`.

## Standing permission
Alex: on the **dev/test store** (`fww-b2b-admin-test`) and the **test copy** of the admin, click and change
anything without asking — "worst thing that could happen is we have to start over." This does NOT cover
the production store (`parttwoenterprises`) or production b2badmin.

## Done
- **PRs merged in fww-b2b-admin:**
  - #51: sortKey AMOUNT_SPENT.
  - #55: cache search matches company.
  - #56: metafieldsDelete payload.
  - #57: offline Shopify schema validation of all GraphQL docs; fixed orderCancel `refund` → `refundMethod` and labels `Product.barcode`.
  - #58: `B2B_ADMIN_TEST_ENV` isolation guard, configurable bridge/Xero/portal URLs and publication id, TEST banner.
- **Prod** runs branch `deploy/prod-plus-sortkey` (main's fixes cherry-picked onto `155483a`), currently at `d646df0`. It does NOT have #58. #58 is a no-op in prod, so deploying it isn't required yet.
- **Dev store** `fww-b2b-admin-test.myshopify.com`, Grow plan.
- **Dev Dashboard app** "FWW B2B Admin Test Bridge", id 438896164865, installed on the dev store only.
- **Bridge** `https://shopify-bridge-b2badmin-test.alex-037.workers.dev`:
  - Source is `commerce-b2b/shopify-bridge-b2badmin-test`, local git only, not pushed.
  - Verified: `/health` responds, a request without the bearer gets 401, and a GraphQL call returns the dev store.
- **Test admin on fww-vps-1:** unit `fww-b2b-admin-test`, address 127.0.0.1:8796, env file `~/fww-b2b-admin-test.env`.
  - Verified: the test login works; `/ /customers /orders /catalog /settings /labels` all return 200 with the banner and no errors; customer search shows an empty store; the allowlist editor refuses.

## Next
1. **Seed and reset script** (in admin repo `scripts/seed-test-store.mjs`, refuses unless the bridge is the test bridge). It should create:
   - a "B2B" publication, then set `B2B_ADMIN_B2B_PUBLICATION_ID` in the env file;
   - B2B-tagged customers: one with company "Champ Dog", one with no company, and some with b2b metafields filled or blank;
   - products whose variants have 12/13-digit barcodes;
   - a few orders.

   Re-running the script resets everything.
2. **Gauntlet** (`C:\Users\AlexLass\Documents\Codex\Gauntlet`):
   - Destructive-label allowlist: allow named destructive selectors only when `disposableEnvironmentConfirmed` and `#test-env-banner` is visible. Today `DESTRUCTIVE_PATTERN` in `src\application\manifest.js` blocks "reset" and "cancel", i.e. the exact button that crashed.
   - Write a confirmed `gauntlet.app-scope.v3` manifest (about 12 routes) plus workflows: B2B settings save, clear and toggle; customer search; order cancel with and without refund; labels; order edit; internal note.
   - Run via the operator: `POST /api/runs` with `assessmentMode:"application"`, headed, on Windows, tunnelled to the VPS port.
3. **Suggestions not yet done:**
   - `fww-logsink.installGlobalHandlers()` swallows uncaught exceptions, so any fatal startup error exits 0 silently.
   - The `order-display-totals` test marker on main is stale (pre-existing failure).
   - Reconcile prod's deploy branch with main.
