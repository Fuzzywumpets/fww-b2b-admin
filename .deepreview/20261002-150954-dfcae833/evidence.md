# REVIEW TARGET
{
  "repository": "fww-b2b-admin",
  "root": "C:\\Users\\AlexLass\\projects\\commerce-b2b\\fww-b2b-admin",
  "head": "dfcae833af17698384396626c1754c97c109add8",
  "base": "origin/main",
  "changed_files": [
    "lib/orders-recent-sync.mjs",
    "run-tests.sh",
    "server.mjs",
    "test/orders-recent-sync.test.mjs"
  ],
  "changed_symbols": [
    "normalizeRestFulfillmentStatus",
    "PARTIALLY_FULFILLED",
    "SYNC_COLD_START_MS",
    "ORDER_SYNC_FIELDS",
    "syncRecentOrders",
    "SYNC_OVERLAP_MS",
    "SYNC_PAGE_LIMIT",
    "SYNC_PAGE_SIZE",
    "UNFULFILLED",
    "fakeShopify",
    "UPDATED_AT",
    "maxUpdated",
    "FULFILLED",
    "INVARIANT",
    "RESTOCKED",
    "UNIT_FAIL",
    "startedAt",
    "function",
    "DEPENDS",
    "PARTIAL",
    "harness",
    "hasNext",
    "sinceMs",
    "NEWEST",
    "OLDEST",
    "cursor",
    "orders",
    "passed",
    "synced",
    "EVERY",
    "QUERY",
    "after",
    "async",
    "calls",
    "const",
    "names",
    "since",
    "slice",
    "start",
    "state"
  ],
  "status": ""
}

# REPOSITORY FILE INDEX
.github/workflows/desktop-build.yml
.gitignore
.playwright-mcp/page-2026-05-26T19-19-55-200Z.yml
.playwright-mcp/page-2026-05-26T19-20-10-564Z.yml
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml
ADVERSARIAL_AUDIT_2026-07-02.md
ALEXA_DECISIONS_PENDING.md
APIWATCH_NOTES.md
CLAUDE.md
HANDOFF.md
QA_ADMIN_FINDINGS.md
QA_ADMIN_INVENTORY.md
SCRATCH.md
STATUS.md
assets/fonts/Inter-Bold.ttf
assets/fonts/Inter-Regular.ttf
assets/fonts/Inter-SemiBold.ttf
assets/fonts/PlayfairDisplay-Bold.ttf
assets/fonts/PlayfairDisplay-Regular.ttf
assets/logo.png
data/shopify_to_xero_mapping.json
db.mjs
desktop/.gitignore
desktop/README.md
desktop/assets/icon-128.png
desktop/assets/icon-16.png
desktop/assets/icon-24.png
desktop/assets/icon-256.png
desktop/assets/icon-32.png
desktop/assets/icon-48.png
desktop/assets/icon-512.png
desktop/assets/icon-64.png
desktop/assets/icon.ico
desktop/assets/icon.png
desktop/lib/pdf-headers.js
desktop/lib/unload-prompt.js
desktop/main.js
desktop/package-lock.json
desktop/package.json
desktop/preload.js
desktop/tools/make-ico.js
desktop/tools/make-icons.ps1
desktop/tools/verify-package.js
docs/B2B-ARCHITECTURE.md
docs/HANDOFF-2026-08-11-lead-fields.md
docs/HELCIM-INVOICE-CONTRACT.md
docs/PRIORITY_CUSTOMERS_BASELINE.md
docs/SHOPIFY_COMPANIES_RESEARCH.md
docs/XERO_CUSTOMER_SYNC.md
fww-logsink.mjs
helcim.mjs
labels.mjs
lib/dashboard-paging.mjs
lib/fulfillment-order-paging.mjs
lib/helcim-invoice-message.mjs
lib/helcim-invoice-payload.mjs
lib/line-item-paging.mjs
lib/list-truncation.mjs
lib/order-display-totals.mjs
lib/order-edit-errors.mjs
lib/order-money.mjs
lib/orders-recent-sync.mjs
lib/shopify-user-errors.mjs
lib/xero-customer-sync.mjs
loop.sh
loop.sh.bak
package-lock.json
package.json
pdf.mjs
public/admin.css
public/icon-192.png
public/index.html
run-tests.sh
scripts/backfill-current-totals.mjs
scripts/backfill-orders-per-customer.mjs
scripts/backfill-shopify.mjs
server.mjs
test/admin-allowlist.test.mjs
test/api.test.mjs
test/dashboard-paging.test.mjs
test/desktop-packaging.test.mjs
test/desktop-pdf-headers.test.mjs
test/fulfillment-order-paging.test.mjs
test/helcim-dedupe.test.mjs
test/helcim-message.test.mjs
test/helcim-payload.test.mjs
test/helcim.test.mjs
test/leads-ingest.test.mjs
test/leads-list.test.mjs
test/list-truncation.test.mjs
test/order-cache-integrity.test.mjs
test/order-display-totals.test.mjs
test/order-edit-nav-deadlock.test.mjs
test/order-edit-user-errors.test.mjs
test/order-money.test.mjs
test/orders-recent-sync.test.mjs
test/pagination-completeness.test.mjs
test/test-session-guard.test.mjs
test/ui.test.mjs

# DEPENDENCY MARKERS
.github/workflows/desktop-build.yml:4:# DEPENDS: desktop/package.json's build.publish block — electron-builder bakes that
CLAUDE.md:38:- Mark real coupling with `// DEPENDS:` or `// SYNC:` in the same change that creates it.
db.mjs:6:// SYNC: page-size constants live in lib/list-truncation.mjs so the SQL LIMIT here and the number
db.mjs:22:  // DEPENDS: test/test-session-guard.test.mjs sets this; do not remove without updating that suite.
db.mjs:65:  -- DEPENDS: server.mjs POST /orders/:id/send-credit-card-invoice uses this as the retry ledger.
db.mjs:81:  -- DEPENDS: server.mjs acquires this before the non-idempotent Helcim Invoice API POST.
db.mjs:546:    // SYNC: helcim_invoice_claims is consumed atomically with the retry-ledger write so there is no
db.mjs:869:// DEPENDS: /leads/:id/edit and /leads/new (server.mjs) both write through this allow-list -- any
db.mjs:927:// SYNC: lib/order-display-totals.mjs is the JS half of the current-vs-frozen rule; getOrderSpendFromCache below carries the identical COALESCE.
db.mjs:1152:// DEPENDS: server.mjs getOrdersData/getCustomersData read `.truncated` off these arrays to decide
db.mjs:1346:// DEPENDS: readers that lowercase for display (order badge class in server.mjs) normalize on read
db.mjs:1393:// DEPENDS: callers must pass the COMPLETE current line set for the order, never a partial batch —
db.mjs:1593:  // DEPENDS: scripts/backfill-orders-per-customer.mjs and scripts/backfill-shopify.mjs must keep
desktop/lib/pdf-headers.js:21:// SYNC: desktop/main.js is the only caller; test/desktop-pdf-headers.test.mjs is the only test.
desktop/main.js:34:// DEPENDS: isAdminPdfUrl() and both navigation interceptors gate on this.
desktop/main.js:166:  // DEPENDS: must run BEFORE createMainWindow() — the handler has to be attached to the partition
desktop/main.js:231:        // SYNC: this item exists in BOTH the Help menu and the tray menu — keep them
desktop/main.js:302:  // SYNC: mirrors the PDF branch in setWindowOpenHandler above — both entry points must
desktop/main.js:330:  // DEPENDS: server-rendered pages register the beforeunload guards this answers — the order-detail
desktop/main.js:356:    // SYNC: this item exists in BOTH the Help menu and the tray menu — keep them
desktop/main.js:376:// DEPENDS: the update-not-available / error handlers below, which stay silent for the
docs/HANDOFF-2026-08-11-lead-fields.md:126:validator, not two copies. Mark it `// SYNC:` if it ends up duplicated.
docs/HANDOFF-2026-08-11-lead-fields.md:137:shared `LEAD_BUSINESS_TYPES` constant (marked `// SYNC:`) so the two forms can't drift.
docs/HANDOFF-2026-08-11-lead-fields.md:169:- Mark real coupling with `// DEPENDS:` / `// SYNC:` comments in the same change that creates it.
helcim.mjs:36:  // DEPENDS: docs/B2B-ARCHITECTURE.md documents these exact Doppler keys.
helcim.mjs:144:    // DEPENDS: Portal's public HelcimPay session links the payment to this exact invoice number.
lib/helcim-invoice-message.mjs:2:// DEPENDS: fww-b2b-portal PR #42 accepts `subject` plus the exact optional
lib/list-truncation.mjs:11:// DEPENDS: db.mjs listOrdersFromCache default limit + server.mjs getOrdersData reporting.
lib/list-truncation.mjs:13:// DEPENDS: db.mjs listCustomersFromCache default limit + server.mjs getCustomersData reporting.
lib/list-truncation.mjs:16:// DEPENDS: db.mjs getLeads() default limit + the GET /leads route's truncation reporting.
lib/order-edit-errors.mjs:17:// SYNC: the client half lives in the order-detail script in server.mjs — run() and flushLine() read
lib/order-money.mjs:15: * DEPENDS: POST /orders/:id/edit in server.mjs rejects the whole batch when `invalid` is non-empty.
lib/order-money.mjs:40: * DEPENDS: callers must run this BEFORE orderEditCommit and must let the throw propagate past the
lib/order-money.mjs:107: * DEPENDS: POST /orders/bulk in server.mjs audit-logs 'mark_paid' ONLY for ids in `paid` and
lib/orders-recent-sync.mjs:19:// DEPENDS: server.mjs's upsert callback maps exactly the fields in ORDER_SYNC_FIELDS — adding a
lib/orders-recent-sync.mjs:92:// SYNC: the GraphQL enum names — OrderDisplayFulfillmentStatus.
lib/shopify-user-errors.mjs:6:// DEPENDS: server.mjs order-edit handlers import assertNoUserErrors — it must keep throwing
lib/xero-customer-sync.mjs:18:// SYNC: this literal list must match the INSIDERS Set in server.mjs's
pdf.mjs:49:// DEPENDS: lineItemTrueTotal below — the only reason this exists; do not "simplify" those guards
pdf.mjs:271:    // SYNC: the lime rule below and all three rows share TOTALS_RIGHT — move one, move them all.
public/admin.css:460:  /* DEPENDS: server.mjs layout() renders the mobile menu from the same navItems array as .header-nav. */
scripts/backfill-orders-per-customer.mjs:124:          // DEPENDS: db.mjs getReportsFromCache subtracts this column from SUM(price*quantity).
scripts/backfill-shopify.mjs:234:      // SYNC: same rule as scripts/backfill-orders-per-customer.mjs — prefer Σ discountAllocations.
scripts/backfill-shopify.mjs:237:      // DEPENDS: db.mjs getReportsFromCache subtracts this column from SUM(price*quantity).
server.mjs:51:// DEPENDS: every money surface in this file picks its amount through these two — cacheRowTotal for a
server.mjs:70:// SYNC: same module db.mjs uses for the SQL LIMIT — the banner/footer copy and the query page size
server.mjs:143:// DEPENDS: the webhook HMAC path relies on this parser running; raising the limit is strictly more
server.mjs:1019:// DEPENDS: the MOCK-only /mock-product-image/:name.svg route serves every URL below; keep mock product pages fully same-origin so QA runtime failures represent app defects rather than deliberately nonexistent CDN fixtures.
server.mjs:1590:// DEPENDS: public/admin.css .header-nav/.mobile-nav-menu switch between the two renderings at 480px; both renderings must keep using navItems rather than duplicating the route list.
server.mjs:2143:  // DEPENDS: GET /orders puts `error`/`msg` on `filters`. mark_paid_partial must NEVER render as a
server.mjs:2271:    // SYNC: getOrderDetail line fields — initial selection and drainLineItems continuation must stay
server.mjs:2374:  // DEPENDS: POST /orders/:id/send-credit-card-invoice persists this row before emailing so a
server.mjs:2501:             SYNC: three places enforce this same floor and must move together — this min=, the
server.mjs:2527:  // DEPENDS: getOrderDetail must select discountAllocations{...discountApplication{... on
server.mjs:2855:        <!-- DEPENDS: fww-shipping-bridge /ui parses this exact numeric order_id and opens the exact order independently of queue pagination. -->
server.mjs:2888:                    DEPENDS: showLeaveAnyway() in the autosave controller finds it by this exact id. */''}
server.mjs:3213:                // DEPENDS: the server sets terminal:true on those responses (editErrorResponse +
server.mjs:3517:                      // DEPENDS: toggleEditMode() and markRemove() both read data-line-removed.
server.mjs:3594:                        // SYNC: same floor as min="1" on this input and POST /orders/:id/line/qty.
server.mjs:3876:                    SYNC: re-adding a scope control here requires real per-line fulfillment detail in
server.mjs:4013:                        SYNC: the invoice viewer's orderLabel (GET /orders/:id/invoice) builds this
server.mjs:4306:          // DEPENDS: renderCustomerDetail's Recent Orders table reads this through listRowTotalAmount.
server.mjs:4309:          // SYNC: the live branch of this same function must select currentTotalPriceSet too, or the
server.mjs:5570:    // SYNC: this literal list must match INSIDER_IDS in lib/xero-customer-sync.mjs:18 exactly —
server.mjs:5664:// DEPENDS: layout() links /favicon.ico and the manifest links /icon-192.png; both must serve the same generated PNG so a fresh browser load has no missing-icon request.
server.mjs:5707:// DEPENDS: test/api.test.mjs + test/ui.test.mjs seedSession() read json.sid — that field only
server.mjs:5777:    // SYNC: isAllowedAdminEmail handles BOTH whole-address entries and "@domain" entries — see its
server.mjs:5833:  // DEPENDS: renderOrdersList reads `error`+`msg` to render the partial mark-paid failure banner
server.mjs:5894:    // DEPENDS: audit rows are the only record that this path ran — only log the orders that really
server.mjs:5950:// DEPENDS: uses getOrderDetail(..., {throwOnError:true}) specifically so it can tell "Shopify cleanly
server.mjs:6163:      // SYNC: db.mjs upsertHelcimInvoiceMap atomically consumes helcim_invoice_claims and writes the
server.mjs:6307:// SYNC: used by BOTH /orders/:id/invoice.pdf and /orders/:id/partial-invoice/:letter.pdf — a change
server.mjs:6351:  // DEPENDS: invoicePdfDisposition() honours ?download=1 on BOTH pdf routes reachable from here.
server.mjs:6461:  // DEPENDS: GET /orders/:id/invoice?letter=X renders that viewer, and its Download PDF button
server.mjs:6604:// DEPENDS: pdf.mjs lineItemTrueTotal/lineItemTrueUnit subtract only targetSelection 'ALL'
server.mjs:6647:// SYNC: CALC_LINE_FIELDS — the CalculatedLineItem selection shared by orderEditBegin and by the
server.mjs:6684:// SYNC: ORIG_LINE_FIELDS — the original-order LineItem selection used to pair original line ids with
server.mjs:6713:// SYNC: LINE_STATE_FIELDS is selected twice — inline in the first-page query below and again by the
server.mjs:7034:    // SYNC: must mirror readCommittedLineState's `discounts` shape — the order-discount verify and
server.mjs:7085:  // DEPENDS: lib/order-money.mjs parseLinePrices — a blank/garbage price must NOT become 0. The
server.mjs:7230:    // DEPENDS: lib/order-money.mjs applyLinePriceChanges THROWS when the re-add fails after the
server.mjs:7250:    // DEPENDS: the calculated order is RE-READ here because the qty/remove/price mutations above
server.mjs:7566:  // SYNC: the same floor is enforced client-side by min="1" on .edit-qty-input and by the change
server.mjs:7673:      // DEPENDS: since 2026-08-05 an ORDER discount is itself an EXPLICIT per-line manual discount
server.mjs:7769:// SYNC: mockApplyOrderDiscount ↔ stageOrderDiscount — the basis, the effective-percent rounding and
server.mjs:8168:// DEPENDS: the manual fulfillment route must consume every cursor page before
server.mjs:8307:    // SYNC: the committedLineQuantities accounting below must match the exact
server.mjs:8536:  // DEPENDS: the GET /tax-exempt flash renderer handles success=error and the optional msg param.
server.mjs:8551:  // DEPENDS: the GET /tax-exempt flash renderer handles success=error and the optional msg param.
server.mjs:9462:              <!-- DEPENDS: test/api.test.mjs asserts this state-changing action remains confirmed before submission. -->
server.mjs:10832:// SYNC: keys here must stay in sync with the <option value=...> list rendered by countryOptions()
server.mjs:10889:// SYNC: business_type option list -- renderLeadNew and renderLeadEdit must render the SAME
server.mjs:11301:  // DEPENDS: countLeads shares buildLeadsWhere with getLeads, so `total` always counts the same
server.mjs:11328:    // DEPENDS: phone is normalized to E.164 (or left verbatim if not confidently NANP) before
server.mjs:11359:  // SYNC: every flash code set by a /leads/:id/* route must have a message here, or the redirect
server.mjs:12133:        <!-- DEPENDS: this preset picker must NOT carry the from name — the date input below already owns it,
server.mjs:12292:          // DEPENDS: readers that lowercase for display (badge class, ~line 11640) still work — they
server.mjs:12334:            // SYNC: same rule as scripts/backfill-shopify.mjs + scripts/backfill-orders-per-customer.mjs.
server.mjs:12335:            // DEPENDS: db.mjs getReportsFromCache subtracts this column from SUM(price*quantity).
server.mjs:12375:  // DEPENDS: the fields below must stay in step with ORDER_SYNC_FIELDS in that module.
test/admin-allowlist.test.mjs:9:// SYNC: server.mjs isAllowedAdminEmail()
test/order-display-totals.test.mjs:21:// DEPENDS: these three accessors ARE the contract under test — the current-vs-frozen choice, and the
test/order-display-totals.test.mjs:26:// DEPENDS: orders_cache's schema (total_price/current_total, customer_shopify_id storing the BARE
test/order-edit-user-errors.test.mjs:55:// SYNC: order-edit-batch-loops — if the qty/remove loops in server.mjs stop calling

# DETERMINISTIC TEST RESULTS
[]

# CHANGED AND RELATED FILE CONTENT
### FILE .github/workflows/desktop-build.yml
     1: name: Desktop Shell — Build & Release
     2: 
     3: # WHAT: Builds + releases the Electron desktop shell that lives in desktop/.
     4: # DEPENDS: desktop/package.json's build.publish block — electron-builder bakes that
     5: #   owner/repo into resources/app-update.yml inside the installer, and the INSTALLED
     6: #   app reads it to find its update feed. If publish.repo and the repo this workflow
     7: #   releases into ever disagree, already-installed clients silently stop updating.
     8: # CHANGE-GUARD: the tag MUST be `v<version>` matching desktop/package.json's "version".
     9: #   Two publishers write to the release on a tag build: electron-builder's own GitHub
    10: #   publisher (it uploads the hyphen-named .exe, its .blockmap, and the latest.yml that
    11: #   electron-updater actually reads) and the softprops step below. electron-builder
    12: #   derives its release tag from `v${version}` and ignores the git tag name, so a tag
    13: #   that is not exactly `v${version}` splits the assets across TWO releases and leaves
    14: #   latest.yml pointing at an .exe that isn't on the same release — a broken update feed.
    15: #   This repo has no other tags and no tag-driven server release, so `v*` is uncontended;
    16: #   if the server ever gains tags, prefix them rather than re-prefixing this.
    17: #   The "Verify tag matches" step below ENFORCES this — it is not merely documentation.
    18: 
    19: on:
    20:   push:
    21:     tags:
    22:       - 'v*'
    23:   workflow_dispatch:
    24: 
    25: permissions:
    26:   contents: write
    27: 
    28: defaults:
    29:   run:
    30:     working-directory: desktop
    31: 
    32: jobs:
    33:   build-win:
    34:     runs-on: windows-latest
    35:     steps:
    36:       - uses: actions/checkout@v4
    37: 
    38:       - uses: actions/setup-node@v4
    39:         with:
    40:           node-version: '22'
    41:           cache: 'npm'
    42:           cache-dependency-path: desktop/package-lock.json
    43: 
    44:       # Enforces the invariant the CHANGE-GUARD above describes. Fails BEFORE the build
    45:       # so a mistag costs 20 seconds instead of publishing a half-broken release that
    46:       # then has to be deleted (and deleting a release that clients may already have
    47:       # polled is exactly the mess this avoids).
    48:       - name: Verify tag matches desktop/package.json version
    49:         if: startsWith(github.ref, 'refs/tags/v')
    50:         shell: bash
    51:         run: |
    52:           pkg=$(node -p "require('./package.json').version")
    53:           if [ "$GITHUB_REF_NAME" != "v$pkg" ]; then
    54:             echo "::error::Tag '$GITHUB_REF_NAME' does not match desktop/package.json version '$pkg' (expected 'v$pkg')."
    55:             echo "electron-builder publishes under v\$version regardless of the git tag name, so a"
    56:             echo "mismatch scatters the .exe/.blockmap/latest.yml across two releases and leaves"
    57:             echo "latest.yml pointing at an installer that is not on the same release."
    58:             exit 1
    59:           fi
    60:           echo "Tag '$GITHUB_REF_NAME' matches desktop version '$pkg'."
    61: 
    62:       - name: Install dependencies
    63:         run: npm ci
    64: 
    65:       # WHY THIS RUNS BEFORE THE PUBLISHING BUILD: `npm run dist` publishes as part of itself —
    66:       # electron-builder uploads the installer, blockmap and latest.yml during that step — so any
    67:       # check placed after it gates nothing; the broken artifact is already live and auto-updating.
    68:       # v1.0.3 shipped exactly that way: it built, published and reached staff while being
    69:       # unlaunchable, because main.js required './lib/pdf-headers' and build.files never packaged
    70:       # lib/. This packs the SAME asar (same files config) with publishing off, inspects it, and
    71:       # fails the job before a single byte is uploaded.
    72:       # CHANGE-GUARD: must stay ahead of the publishing build and must keep `--publish never`.
    73:       #   Do not "simplify" by verifying dist/ after `npm run dist` — that is the no-op this exists
    74:       #   to replace.
    75:       - name: Pack (no publish) and verify the packaged app
    76:         run: |
    77:           npx electron-builder --win --dir --publish never
    78:           node tools/verify-package.js dist/win-unpacked/resources/app.asar
    79: 
    80:       - name: Build NSIS installer
    81:         run: npm run dist
    82:         env:
    83:           GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    84: 
    85:       - name: Upload artifacts
    86:         uses: actions/upload-artifact@v4
    87:         with:
    88:           name: installer-windows
    89:           path: desktop/dist/*.exe
    90: 
    91:       - name: Create Release
    92:         if: startsWith(github.ref, 'refs/tags/v')
    93:         uses: softprops/action-gh-release@v2
    94:         with:
    95:           files: |
    96:             desktop/dist/*.exe
    97:             desktop/dist/*.yml
    98:           generate_release_notes: true
    99:         env:
   100:           GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

### FILE CLAUDE.md
     1: # fww-b2b-admin — agent instructions
     2: 
     3: Internal **staff** tool (Node 22 / Express, server-rendered from `server.mjs`). Google OAuth.
     4: Separate from `fww-b2b-portal`, which is the **customer** app.
     5: 
     6: ## Read this first
     7: **`docs/B2B-ARCHITECTURE.md`** is the canonical description of how the two apps fit together —
     8: the onboarding order, the auth models, the cross-app channel, settled decisions, deploy traps.
     9: Read it before any cross-app work. If it disagrees with what you remember, it wins; if it is wrong,
    10: fix it in the same PR.
    11: 
    12: ## The three things most often got wrong
    13: 
    14: 1. **The invitation comes BEFORE any Shopify account exists.** The customer account is created at
    15:    the END of onboarding by the portal's `/api/onboard/complete`. `/leads/:id/convert` is the
    16:    no-portal exception for customers who will never log in — **not** a step in the invite path, and
    17:    never both. Details in §2 of the architecture doc.
    18: 
    19: 2. **This app is not a duplicate of the portal's admin pages.** It is the intended standalone
    20:    internal tool; the portal's `/admin/*` pages are the accident. Never propose tagging a staff
    21:    member as a `b2b` Shopify customer so they can reach the portal's admin UI — staff should not
    22:    have to become customers to use a staff tool, and the storefront's `b2b-redirect` would bounce
    23:    them off fuzzywumpets.com. Expose the operation over `/__internal__/*` instead.
    24: 
    25: 3. **Never grep `.env` for a secret.** This service starts under `doppler run`, so secrets live only
    26:    in the process environment and a grep returns a false negative. Read
    27:    `/proc/<node CHILD pid>/environ` — MainPID is `doppler`, not node. §4 of the architecture doc.
    28: 
    29: ## Tests
    30: `./run-tests.sh` must be green on every commit. `B2B_ADMIN_MOCK=1` is the in-memory mode. Suites that
    31: cannot be reached through the mock HTTP server (anything gated on `if (!MOCK)`, the Google OAuth
    32: gate, DB-level SQL) get their own standalone unit run — follow that pattern rather than adding an
    33: API test that silently exercises nothing.
    34: 
    35: ## House style
    36: - Every change ships as a PR, never a direct push to `main`.
    37: - Non-trivial functions carry `// WHAT:` / `// CHANGE-GUARD:` / `// INVARIANT(S):` headers. Match it.
    38: - Mark real coupling with `// DEPENDS:` or `// SYNC:` in the same change that creates it.
    39: - Before changing anything shared, grep for consumers and update them in the same change.
    40: - Fixing X means touching what X needs. Unrelated cleanup goes in the PR body as a suggestion.

### FILE desktop/package-lock.json
     1: {
     2:   "name": "fww-b2b-admin-desktop",
     3:   "version": "1.0.0",
     4:   "lockfileVersion": 3,
     5:   "requires": true,
     6:   "packages": {
     7:     "": {
     8:       "name": "fww-b2b-admin-desktop",
     9:       "version": "1.0.0",
    10:       "hasInstallScript": true,
    11:       "dependencies": {
    12:         "electron-store": "^8.2.0",
    13:         "electron-updater": "^6.3.0"
    14:       },
    15:       "devDependencies": {
    16:         "electron": "^36.0.0",
    17:         "electron-builder": "^25.1.8"
    18:       }
    19:     },
    20:     "node_modules/@develar/schema-utils": {
    21:       "version": "2.6.5",
    22:       "resolved": "https://registry.npmjs.org/@develar/schema-utils/-/schema-utils-2.6.5.tgz",
    23:       "integrity": "sha512-0cp4PsWQ/9avqTVMCtZ+GirikIA36ikvjtHweU4/j8yLtgObI0+JUPhYFScgwlteveGB1rt3Cm8UhN04XayDig==",
    24:       "dev": true,
    25:       "license": "MIT",
    26:       "dependencies": {
    27:         "ajv": "^6.12.0",
    28:         "ajv-keywords": "^3.4.1"
    29:       },
    30:       "engines": {
    31:         "node": ">= 8.9.0"
    32:       },
    33:       "funding": {
    34:         "type": "opencollective",
    35:         "url": "https://opencollective.com/webpack"
    36:       }
    37:     },
    38:     "node_modules/@electron/asar": {
    39:       "version": "3.4.1",
    40:       "resolved": "https://registry.npmjs.org/@electron/asar/-/asar-3.4.1.tgz",
    41:       "integrity": "sha512-i4/rNPRS84t0vSRa2HorerGRXWyF4vThfHesw0dmcWHp+cspK743UanA0suA5Q5y8kzY2y6YKrvbIUn69BCAiA==",
    42:       "dev": true,
    43:       "license": "MIT",
    44:       "dependencies": {
    45:         "commander": "^5.0.0",
    46:         "glob": "^7.1.6",
    47:         "minimatch": "^3.0.4"
    48:       },
    49:       "bin": {
    50:         "asar": "bin/asar.js"
    51:       },
    52:       "engines": {
    53:         "node": ">=10.12.0"
    54:       }
    55:     },
    56:     "node_modules/@electron/asar/node_modules/balanced-match": {
    57:       "version": "1.0.2",
    58:       "resolved": "https://registry.npmjs.org/balanced-match/-/balanced-match-1.0.2.tgz",
    59:       "integrity": "sha512-3oSeUO0TMV67hN1AmbXsK4yaqU7tjiHlbxRDZOpH0KW9+CeX4bRAaX0Anxt0tx2MrpRpWwQaPwIlISEJhYU5Pw==",
    60:       "dev": true,
    61:       "license": "MIT"
    62:     },
    63:     "node_modules/@electron/asar/node_modules/brace-expansion": {
    64:       "version": "1.1.15",
    65:       "resolved": "https://registry.npmjs.org/brace-expansion/-/brace-expansion-1.1.15.tgz",
    66:       "integrity": "sha512-EwOCDEex4quD37XhqM3omwtMoJjr//isUZz1JopUNWms+4Z2ViyM/k1YIRePpoVNnQhENnxtFjLaxNHrT7xIUg==",
    67:       "dev": true,
    68:       "license": "MIT",
    69:       "dependencies": {
    70:         "balanced-match": "^1.0.0",
    71:         "concat-map": "0.0.1"
    72:       }
    73:     },
    74:     "node_modules/@electron/asar/node_modules/minimatch": {
    75:       "version": "3.1.5",
    76:       "resolved": "https://registry.npmjs.org/minimatch/-/minimatch-3.1.5.tgz",
    77:       "integrity": "sha512-VgjWUsnnT6n+NUk6eZq77zeFdpW2LWDzP6zFGrCbHXiYNul5Dzqk2HHQ5uFH2DNW5Xbp8+jVzaeNt94ssEEl4w==",
    78:       "dev": true,
    79:       "license": "ISC",
    80:       "dependencies": {
    81:         "brace-expansion": "^1.1.7"
    82:       },
    83:       "engines": {
    84:         "node": "*"
    85:       }
    86:     },
    87:     "node_modules/@electron/get": {
    88:       "version": "2.0.3",
    89:       "resolved": "https://registry.npmjs.org/@electron/get/-/get-2.0.3.tgz",
    90:       "integrity": "sha512-Qkzpg2s9GnVV2I2BjRksUi43U5e6+zaQMcjoJy0C+C5oxaKl+fmckGDQFtRpZpZV0NQekuZZ+tGz7EA9TVnQtQ==",
    91:       "dev": true,
    92:       "license": "MIT",
    93:       "dependencies": {
    94:         "debug": "^4.1.1",
    95:         "env-paths": "^2.2.0",
    96:         "fs-extra": "^8.1.0",
    97:         "got": "^11.8.5",
    98:         "progress": "^2.0.3",
    99:         "semver": "^6.2.0",
   100:         "sumchecker": "^3.0.1"
   101:       },
   102:       "engines": {
   103:         "node": ">=12"
   104:       },
   105:       "optionalDependencies": {
   106:         "global-agent": "^3.0.0"
   107:       }
   108:     },
   109:     "node_modules/@electron/notarize": {
   110:       "version": "2.5.0",
   111:       "resolved": "https://registry.npmjs.org/@electron/notarize/-/notarize-2.5.0.tgz",
   112:       "integrity": "sha512-jNT8nwH1f9X5GEITXaQ8IF/KdskvIkOFfB2CvwumsveVidzpSc+mvhhTMdAGSYF3O+Nq49lJ7y+ssODRXu06+A==",
   113:       "dev": true,
   114:       "license": "MIT",
   115:       "dependencies": {
   116:         "debug": "^4.1.1",
   117:         "fs-extra": "^9.0.1",
   118:         "promise-retry": "^2.0.1"
   119:       },
   120:       "engines": {
   121:         "node": ">= 10.0.0"
   122:       }
   123:     },
   124:     "node_modules/@electron/notarize/node_modules/fs-extra": {
   125:       "version": "9.1.0",
   126:       "resolved": "https://registry.npmjs.org/fs-extra/-/fs-extra-9.1.0.tgz",
   127:       "integrity": "sha512-hcg3ZmepS30/7BSFqRvoo3DOMQu7IjqxO5nCDt+zM9XWjb33Wg7ziNT+Qvqbuc3+gWpzO02JubVyk2G4Zvo1OQ==",
   128:       "dev": true,
   129:       "license": "MIT",
   130:       "dependencies": {
   131:         "at-least-node": "^1.0.0",
   132:         "graceful-fs": "^4.2.0",
   133:         "jsonfile": "^6.0.1",
   134:         "universalify": "^2.0.0"
   135:       },
   136:       "engines": {
   137:         "node": ">=10"
   138:       }
   139:     },
   140:     "node_modules/@electron/notarize/node_modules/jsonfile": {
   141:       "version": "6.2.1",
   142:       "resolved": "https://registry.npmjs.org/jsonfile/-/jsonfile-6.2.1.tgz",
   143:       "integrity": "sha512-zwOTdL3rFQ/lRdBnntKVOX6k5cKJwEc1HdilT71BWEu7J41gXIB2MRp+vxduPSwZJPWBxEzv4yH1wYLJGUHX4Q==",
   144:       "dev": true,
   145:       "license": "MIT",
   146:       "dependencies": {
   147:         "universalify": "^2.0.0"
   148:       },
   149:       "optionalDependencies": {
   150:         "graceful-fs": "^4.1.6"
   151:       }
   152:     },
   153:     "node_modules/@electron/notarize/node_modules/universalify": {
   154:       "version": "2.0.1",
   155:       "resolved": "https://registry.npmjs.org/universalify/-/universalify-2.0.1.tgz",
   156:       "integrity": "sha512-gptHNQghINnc/vTGIk0SOFGFNXw7JVrlRUtConJRlvaw6DuX0wO5Jeko9sWrMBhh+PsYAZ7oXAiOnf/UKogyiw==",
   157:       "dev": true,
   158:       "license": "MIT",
   159:       "engines": {
   160:         "node": ">= 10.0.0"
   161:       }
   162:     },
   163:     "node_modules/@electron/osx-sign": {
   164:       "version": "1.3.1",
   165:       "resolved": "https://registry.npmjs.org/@electron/osx-sign/-/osx-sign-1.3.1.tgz",
   166:       "integrity": "sha512-BAfviURMHpmb1Yb50YbCxnOY0wfwaLXH5KJ4+80zS0gUkzDX3ec23naTlEqKsN+PwYn+a1cCzM7BJ4Wcd3sGzw==",
   167:       "dev": true,
   168:       "license": "BSD-2-Clause",
   169:       "dependencies": {
   170:         "compare-version": "^0.1.2",
   171:         "debug": "^4.3.4",
   172:         "fs-extra": "^10.0.0",
   173:         "isbinaryfile": "^4.0.8",
   174:         "minimist": "^1.2.6",
   175:         "plist": "^3.0.5"
   176:       },
   177:       "bin": {
   178:         "electron-osx-flat": "bin/electron-osx-flat.js",
   179:         "electron-osx-sign": "bin/electron-osx-sign.js"
   180:       },
   181:       "engines": {
   182:         "node": ">=12.0.0"
   183:       }
   184:     },
   185:     "node_modules/@electron/osx-sign/node_modules/fs-extra": {
   186:       "version": "10.1.0",
   187:       "resolved": "https://registry.npmjs.org/fs-extra/-/fs-extra-10.1.0.tgz",
   188:       "integrity": "sha512-oRXApq54ETRj4eMiFzGnHWGy+zo5raudjuxN0b8H7s/RU2oW0Wvsx9O0ACRN/kRq9E8Vu/ReskGB5o3ji+FzHQ==",
   189:       "dev": true,
   190:       "license": "MIT",
   191:       "dependencies": {
   192:         "graceful-fs": "^4.2.0",
   193:         "jsonfile": "^6.0.1",
   194:         "universalify": "^2.0.0"
   195:       },
   196:       "engines": {
   197:         "node": ">=12"
   198:       }
   199:     },
   200:     "node_modules/@electron/osx-sign/node_modules/isbinaryfile": {
   201:       "version": "4.0.10",
   202:       "resolved": "https://registry.npmjs.org/isbinaryfile/-/isbinaryfile-4.0.10.tgz",
   203:       "integrity": "sha512-iHrqe5shvBUcFbmZq9zOQHBoeOhZJu6RQGrDpBgenUm/Am+F3JM2MgQj+rK3Z601fzrL5gLZWtAPH2OBaSVcyw==",
   204:       "dev": true,
   205:       "license": "MIT",
   206:       "engines": {
   207:         "node": ">= 8.0.0"
   208:       },
   209:       "funding": {
   210:         "url": "https://github.com/sponsors/gjtorikian/"
   211:       }
   212:     },
   213:     "node_modules/@electron/osx-sign/node_modules/jsonfile": {
   214:       "version": "6.2.1",
   215:       "resolved": "https://registry.npmjs.org/jsonfile/-/jsonfile-6.2.1.tgz",
   216:       "integrity": "sha512-zwOTdL3rFQ/lRdBnntKVOX6k5cKJwEc1HdilT71BWEu7J41gXIB2MRp+vxduPSwZJPWBxEzv4yH1wYLJGUHX4Q==",
   217:       "dev": true,
   218:       "license": "MIT",
   219:       "dependencies": {
   220:         "universalify": "^2.0.0"
   221:       },
   222:       "optionalDependencies": {
   223:         "graceful-fs": "^4.1.6"
   224:       }
   225:     },
   226:     "node_modules/@electron/osx-sign/node_modules/universalify": {
   227:       "version": "2.0.1",
   228:       "resolved": "https://registry.npmjs.org/universalify/-/universalify-2.0.1.tgz",
   229:       "integrity": "sha512-gptHNQghINnc/vTGIk0SOFGFNXw7JVrlRUtConJRlvaw6DuX0wO5Jeko9sWrMBhh+PsYAZ7oXAiOnf/UKogyiw==",
   230:       "dev": true,
   231:       "license": "MIT",
   232:       "engines": {
   233:         "node": ">= 10.0.0"
   234:       }
   235:     },
   236:     "node_modules/@electron/rebuild": {
   237:       "version": "3.6.1",
   238:       "resolved": "https://registry.npmjs.org/@electron/rebuild/-/rebuild-3.6.1.tgz",
   239:       "integrity": "sha512-f6596ZHpEq/YskUd8emYvOUne89ij8mQgjYFA5ru25QwbrRO+t1SImofdDv7kKOuWCmVOuU5tvfkbgGxIl3E/w==",
   240:       "dev": true,
   241:       "license": "MIT",
   242:       "dependencies": {
   243:         "@malept/cross-spawn-promise": "^2.0.0",
   244:         "chalk": "^4.0.0",
   245:         "debug": "^4.1.1",
... [TRUNCATED 5176 LINES] ...
  5422:       "dev": true,
  5423:       "license": "MIT",
  5424:       "engines": {
  5425:         "node": ">= 4.0.0"
  5426:       }
  5427:     },
  5428:     "node_modules/uri-js": {
  5429:       "version": "4.4.1",
  5430:       "resolved": "https://registry.npmjs.org/uri-js/-/uri-js-4.4.1.tgz",
  5431:       "integrity": "sha512-7rKUyy33Q1yc98pQ1DAmLtwX109F7TIfWlW1Ydo8Wl1ii1SeHieeh0HHfPeL2fMXK6z0s8ecKs9frCuLJvndBg==",
  5432:       "dev": true,
  5433:       "license": "BSD-2-Clause",
  5434:       "dependencies": {
  5435:         "punycode": "^2.1.0"
  5436:       }
  5437:     },
  5438:     "node_modules/utf8-byte-length": {
  5439:       "version": "1.0.5",
  5440:       "resolved": "https://registry.npmjs.org/utf8-byte-length/-/utf8-byte-length-1.0.5.tgz",
  5441:       "integrity": "sha512-Xn0w3MtiQ6zoz2vFyUVruaCL53O/DwUvkEeOvj+uulMm0BkUGYWmBYVyElqZaSLhY6ZD0ulfU3aBra2aVT4xfA==",
  5442:       "dev": true,
  5443:       "license": "(WTFPL OR MIT)"
  5444:     },
  5445:     "node_modules/util-deprecate": {
  5446:       "version": "1.0.2",
  5447:       "resolved": "https://registry.npmjs.org/util-deprecate/-/util-deprecate-1.0.2.tgz",
  5448:       "integrity": "sha512-EPD5q1uXyFxJpCrLnCc1nHnq3gOa6DZBocAIiI2TaSCA7VCJ1UJDMagCzIkXNsUYfD1daK//LTEQ8xiIbrHtcw==",
  5449:       "dev": true,
  5450:       "license": "MIT"
  5451:     },
  5452:     "node_modules/verror": {
  5453:       "version": "1.10.1",
  5454:       "resolved": "https://registry.npmjs.org/verror/-/verror-1.10.1.tgz",
  5455:       "integrity": "sha512-veufcmxri4e3XSrT0xwfUR7kguIkaxBeosDg00yDWhk49wdwkSUrvvsm7nc75e1PUyvIeZj6nS8VQRYz2/S4Xg==",
  5456:       "dev": true,
  5457:       "license": "MIT",
  5458:       "optional": true,
  5459:       "dependencies": {
  5460:         "assert-plus": "^1.0.0",
  5461:         "core-util-is": "1.0.2",
  5462:         "extsprintf": "^1.2.0"
  5463:       },
  5464:       "engines": {
  5465:         "node": ">=0.6.0"
  5466:       }
  5467:     },
  5468:     "node_modules/wcwidth": {
  5469:       "version": "1.0.1",
  5470:       "resolved": "https://registry.npmjs.org/wcwidth/-/wcwidth-1.0.1.tgz",
  5471:       "integrity": "sha512-XHPEwS0q6TaxcvG85+8EYkbiCux2XtWG2mkc47Ng2A77BQu9+DqIOJldST4HgPkuea7dvKSj5VgX3P1d4rW8Tg==",
  5472:       "dev": true,
  5473:       "license": "MIT",
  5474:       "dependencies": {
  5475:         "defaults": "^1.0.3"
  5476:       }
  5477:     },
  5478:     "node_modules/which": {
  5479:       "version": "2.0.2",
  5480:       "resolved": "https://registry.npmjs.org/which/-/which-2.0.2.tgz",
  5481:       "integrity": "sha512-BLI3Tl1TW3Pvl70l3yq3Y64i+awpwXqsGBYWkkqMtnbXgrMD+yj7rhW0kuEDxzJaYXGjEW5ogapKNMEKNMjibA==",
  5482:       "dev": true,
  5483:       "license": "ISC",
  5484:       "dependencies": {
  5485:         "isexe": "^2.0.0"
  5486:       },
  5487:       "bin": {
  5488:         "node-which": "bin/node-which"
  5489:       },
  5490:       "engines": {
  5491:         "node": ">= 8"
  5492:       }
  5493:     },
  5494:     "node_modules/wide-align": {
  5495:       "version": "1.1.5",
  5496:       "resolved": "https://registry.npmjs.org/wide-align/-/wide-align-1.1.5.tgz",
  5497:       "integrity": "sha512-eDMORYaPNZ4sQIuuYPDHdQvf4gyCF9rEEV/yPxGfwPkRodwEgiMUUXTx/dex+Me0wxx53S+NgUHaP7y3MGlDmg==",
  5498:       "dev": true,
  5499:       "license": "ISC",
  5500:       "dependencies": {
  5501:         "string-width": "^1.0.2 || 2 || 3 || 4"
  5502:       }
  5503:     },
  5504:     "node_modules/wrap-ansi": {
  5505:       "version": "7.0.0",
  5506:       "resolved": "https://registry.npmjs.org/wrap-ansi/-/wrap-ansi-7.0.0.tgz",
  5507:       "integrity": "sha512-YVGIj2kamLSTxw6NsZjoBxfSwsn0ycdesmc4p+Q21c5zPuZ1pl+NfxVdxPtdHvmNVOQ6XSYG4AUtyt/Fi7D16Q==",
  5508:       "dev": true,
  5509:       "license": "MIT",
  5510:       "dependencies": {
  5511:         "ansi-styles": "^4.0.0",
  5512:         "string-width": "^4.1.0",
  5513:         "strip-ansi": "^6.0.0"
  5514:       },
  5515:       "engines": {
  5516:         "node": ">=10"
  5517:       },
  5518:       "funding": {
  5519:         "url": "https://github.com/chalk/wrap-ansi?sponsor=1"
  5520:       }
  5521:     },
  5522:     "node_modules/wrap-ansi-cjs": {
  5523:       "name": "wrap-ansi",
  5524:       "version": "7.0.0",
  5525:       "resolved": "https://registry.npmjs.org/wrap-ansi/-/wrap-ansi-7.0.0.tgz",
  5526:       "integrity": "sha512-YVGIj2kamLSTxw6NsZjoBxfSwsn0ycdesmc4p+Q21c5zPuZ1pl+NfxVdxPtdHvmNVOQ6XSYG4AUtyt/Fi7D16Q==",
  5527:       "dev": true,
  5528:       "license": "MIT",
  5529:       "dependencies": {
  5530:         "ansi-styles": "^4.0.0",
  5531:         "string-width": "^4.1.0",
  5532:         "strip-ansi": "^6.0.0"
  5533:       },
  5534:       "engines": {
  5535:         "node": ">=10"
  5536:       },
  5537:       "funding": {
  5538:         "url": "https://github.com/chalk/wrap-ansi?sponsor=1"
  5539:       }
  5540:     },
  5541:     "node_modules/wrappy": {
  5542:       "version": "1.0.2",
  5543:       "resolved": "https://registry.npmjs.org/wrappy/-/wrappy-1.0.2.tgz",
  5544:       "integrity": "sha512-l4Sp/DRseor9wL6EvV2+TuQn63dMkPjZ/sp9XkghTEbV9KlPS1xUsZ3u7/IQO4wxtcFB4bgpQPRcR3QCvezPcQ==",
  5545:       "dev": true,
  5546:       "license": "ISC"
  5547:     },
  5548:     "node_modules/xmlbuilder": {
  5549:       "version": "15.1.1",
  5550:       "resolved": "https://registry.npmjs.org/xmlbuilder/-/xmlbuilder-15.1.1.tgz",
  5551:       "integrity": "sha512-yMqGBqtXyeN1e3TGYvgNgDVZ3j84W4cwkOXQswghol6APgZWaff9lnbvN7MHYJOiXsvGPXtjTYJEiC9J2wv9Eg==",
  5552:       "dev": true,
  5553:       "license": "MIT",
  5554:       "engines": {
  5555:         "node": ">=8.0"
  5556:       }
  5557:     },
  5558:     "node_modules/y18n": {
  5559:       "version": "5.0.8",
  5560:       "resolved": "https://registry.npmjs.org/y18n/-/y18n-5.0.8.tgz",
  5561:       "integrity": "sha512-0pfFzegeDWJHJIAmTLRP2DwHjdF5s7jo9tuztdQxAhINCdvS+3nGINqPd00AphqJR/0LhANUS6/+7SCb98YOfA==",
  5562:       "dev": true,
  5563:       "license": "ISC",
  5564:       "engines": {
  5565:         "node": ">=10"
  5566:       }
  5567:     },
  5568:     "node_modules/yallist": {
  5569:       "version": "4.0.0",
  5570:       "resolved": "https://registry.npmjs.org/yallist/-/yallist-4.0.0.tgz",
  5571:       "integrity": "sha512-3wdGidZyq5PB084XLES5TpOSRA3wjXAlIWMhum2kRcv/41Sn2emQ0dycQW4uZXLejwKvg6EsvbdlVL+FYEct7A==",
  5572:       "dev": true,
  5573:       "license": "ISC"
  5574:     },
  5575:     "node_modules/yargs": {
  5576:       "version": "17.7.3",
  5577:       "resolved": "https://registry.npmjs.org/yargs/-/yargs-17.7.3.tgz",
  5578:       "integrity": "sha512-GZtjxm/J/4TSxuL3FNYjCmLktBTnIw/rVmKSIyKeYAZpmJB2ig9VauCC5xsa82GNKVKDAqpOn3KVzNt0zmrU0g==",
  5579:       "dev": true,
  5580:       "license": "MIT",
  5581:       "dependencies": {
  5582:         "cliui": "^8.0.1",
  5583:         "escalade": "^3.1.1",
  5584:         "get-caller-file": "^2.0.5",
  5585:         "require-directory": "^2.1.1",
  5586:         "string-width": "^4.2.3",
  5587:         "y18n": "^5.0.5",
  5588:         "yargs-parser": "^21.1.1"
  5589:       },
  5590:       "engines": {
  5591:         "node": ">=12"
  5592:       }
  5593:     },
  5594:     "node_modules/yargs-parser": {
  5595:       "version": "21.1.1",
  5596:       "resolved": "https://registry.npmjs.org/yargs-parser/-/yargs-parser-21.1.1.tgz",
  5597:       "integrity": "sha512-tVpsJW7DdjecAiFpbIB1e3qxIQsE6NoPc5/eTdrbbIC4h0LVsWhnoa3g+m2HclBIujHzsxZ4VJVA+GUuc2/LBw==",
  5598:       "dev": true,
  5599:       "license": "ISC",
  5600:       "engines": {
  5601:         "node": ">=12"
  5602:       }
  5603:     },
  5604:     "node_modules/yauzl": {
  5605:       "version": "2.10.0",
  5606:       "resolved": "https://registry.npmjs.org/yauzl/-/yauzl-2.10.0.tgz",
  5607:       "integrity": "sha512-p4a9I6X6nu6IhoGmBqAcbJy1mlC4j27vEPZX9F4L4/vZT3Lyq1VkFHw/V/PUcB9Buo+DG3iHkT0x3Qya58zc3g==",
  5608:       "dev": true,
  5609:       "license": "MIT",
  5610:       "dependencies": {
  5611:         "buffer-crc32": "~0.2.3",
  5612:         "fd-slicer": "~1.1.0"
  5613:       }
  5614:     },
  5615:     "node_modules/yocto-queue": {
  5616:       "version": "0.1.0",
  5617:       "resolved": "https://registry.npmjs.org/yocto-queue/-/yocto-queue-0.1.0.tgz",
  5618:       "integrity": "sha512-rVksvsnNCdJ/ohGc6xgPwyN8eheCxsiLM8mxuE/t/mOVqJewPuO1miLpTHQiRgTKCLexL4MeAFVagts7HmNZ2Q==",
  5619:       "dev": true,
  5620:       "license": "MIT",
  5621:       "engines": {
  5622:         "node": ">=10"
  5623:       },
  5624:       "funding": {
  5625:         "url": "https://github.com/sponsors/sindresorhus"
  5626:       }
  5627:     },
  5628:     "node_modules/zip-stream": {
  5629:       "version": "4.1.1",
  5630:       "resolved": "https://registry.npmjs.org/zip-stream/-/zip-stream-4.1.1.tgz",
  5631:       "integrity": "sha512-9qv4rlDiopXg4E69k+vMHjNN63YFMe9sZMrdlvKnCjlCRWeCBswPPMPUfx+ipsAWq1LXHe70RcbaHdJJpS6hyQ==",
  5632:       "dev": true,
  5633:       "license": "MIT",
  5634:       "peer": true,
  5635:       "dependencies": {
  5636:         "archiver-utils": "^3.0.4",
  5637:         "compress-commons": "^4.1.2",
  5638:         "readable-stream": "^3.6.0"
  5639:       },
  5640:       "engines": {
  5641:         "node": ">= 10"
  5642:       }
  5643:     },
  5644:     "node_modules/zip-stream/node_modules/archiver-utils": {
  5645:       "version": "3.0.4",
  5646:       "resolved": "https://registry.npmjs.org/archiver-utils/-/archiver-utils-3.0.4.tgz",
  5647:       "integrity": "sha512-KVgf4XQVrTjhyWmx6cte4RxonPLR9onExufI1jhvw/MQ4BB6IsZD5gT8Lq+u/+pRkWna/6JoHpiQioaqFP5Rzw==",
  5648:       "dev": true,
  5649:       "license": "MIT",
  5650:       "peer": true,
  5651:       "dependencies": {
  5652:         "glob": "^7.2.3",
  5653:         "graceful-fs": "^4.2.0",
  5654:         "lazystream": "^1.0.0",
  5655:         "lodash.defaults": "^4.2.0",
  5656:         "lodash.difference": "^4.5.0",
  5657:         "lodash.flatten": "^4.4.0",
  5658:         "lodash.isplainobject": "^4.0.6",
  5659:         "lodash.union": "^4.6.0",
  5660:         "normalize-path": "^3.0.0",
  5661:         "readable-stream": "^3.6.0"
  5662:       },
  5663:       "engines": {
  5664:         "node": ">= 10"
  5665:       }
  5666:     }
  5667:   }
  5668: }

### FILE desktop/package.json
     1: {
     2:   "name": "fww-b2b-admin-desktop",
     3:   "version": "1.0.5",
     4:   "description": "Fuzzywumpets B2B Admin \u2014 desktop shell with auto-update",
     5:   "author": "Fuzzywumpets",
     6:   "main": "main.js",
     7:   "scripts": {
     8:     "start": "electron .",
     9:     "dist": "electron-builder --win",
    10:     "dist:dir": "electron-builder --win --dir",
    11:     "icons": "powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1 && node tools/make-ico.js",
    12:     "postinstall": "electron-builder install-app-deps",
    13:     "verify:package": "node tools/verify-package.js dist/win-unpacked/resources/app.asar"
    14:   },
    15:   "dependencies": {
    16:     "electron-store": "^8.2.0",
    17:     "electron-updater": "^6.3.0"
    18:   },
    19:   "devDependencies": {
    20:     "electron": "^36.0.0",
    21:     "electron-builder": "^25.1.8"
    22:   },
    23:   "build": {
    24:     "appId": "com.fuzzywumpets.b2badmin",
    25:     "productName": "FWW B2B Admin",
    26:     "copyright": "Copyright \u00a9 2026 Fuzzywumpets",
    27:     "icon": "assets/icon.png",
    28:     "publish": {
    29:       "provider": "github",
    30:       "owner": "Fuzzywumpets",
    31:       "repo": "fww-b2b-admin"
    32:     },
    33:     "win": {
    34:       "target": [
    35:         {
    36:           "target": "nsis",
    37:           "arch": [
    38:             "x64"
    39:           ]
    40:         }
    41:       ],
    42:       "icon": "assets/icon.ico",
    43:       "requestedExecutionLevel": "asInvoker"
    44:     },
    45:     "nsis": {
    46:       "oneClick": false,
    47:       "allowToChangeInstallationDirectory": true,
    48:       "allowElevation": true,
    49:       "installerIcon": "assets/icon.ico",
    50:       "uninstallerIcon": "assets/icon.ico",
    51:       "installerHeaderIcon": "assets/icon.ico",
    52:       "createDesktopShortcut": true,
    53:       "createStartMenuShortcut": true,
    54:       "shortcutName": "FWW B2B Admin",
    55:       "runAfterFinish": true,
    56:       "deleteAppDataOnUninstall": false,
    57:       "license": null
    58:     },
    59:     "files": [
    60:       "main.js",
    61:       "preload.js",
    62:       "lib/**/*",
    63:       "assets/**"
    64:     ]
    65:   }
    66: }

### FILE lib/orders-recent-sync.mjs
     1: // WHAT: the incremental "orders changed since last poll" sync that keeps orders_cache (what the Orders
     2: // list renders) in step with Shopify, plus the REST->GraphQL fulfillment-status normalizer.
     3: //
     4: // WHY: the poller used to fetch `orders(first:50, sortKey:UPDATED_AT, reverse:true)` once, with no
     5: // paging, and then advance its cursor to "now" no matter what. The query covers EVERY order in the
     6: // store (not just B2B), and the shipping app fulfils dozens of DTC orders a day — so after any idle
     7: // stretch (the poller only runs while the dashboard is open) more than 50 orders had changed, the
     8: // 50 NEWEST won, and the older ones — including B2B orders fulfilled in Shopify — were dropped and the
     9: // cursor jumped past them. They then showed UNFULFILLED in the list until something else touched
    10: // them. (Seen 2026-10-02: six March orders already FULFILLED in Shopify still listed UNFULFILLED.)
    11: //
    12: // INVARIANT(S):
    13: //  - pages OLDEST-first (reverse:false) so progress is monotonic: if the page cap is hit we resume
    14: //    from the newest updatedAt we actually stored, never from "now", so nothing is skipped.
    15: //  - the cursor only advances to a time we have fully processed. A thrown error leaves it where it
    16: //    was (the next run re-covers the window) and is rethrown so callers/"Sync now" see the failure
    17: //    instead of a green no-op.
    18: //  - the 60s overlap is kept: updates landing between polls re-appear in the next window.
    19: // DEPENDS: server.mjs's upsert callback maps exactly the fields in ORDER_SYNC_FIELDS — adding a
    20: // field here means mapping it there (and in scripts/backfill-*.mjs, which write the same columns).
    21: 
    22: export const SYNC_PAGE_SIZE = 50;
    23: export const SYNC_PAGE_LIMIT = 40;           // 40 x 50 = 2000 orders per run before we hand back and resume next tick
    24: export const SYNC_OVERLAP_MS = 60_000;
    25: export const SYNC_COLD_START_MS = 6 * 60_000;
    26: 
    27: export const ORDER_SYNC_FIELDS = `id name processedAt updatedAt createdAt cancelledAt
    28:   displayFinancialStatus displayFulfillmentStatus
    29:   totalPriceSet{shopMoney{amount}}
    30:   subtotalPriceSet{shopMoney{amount}}
    31:   currentTotalPriceSet{shopMoney{amount}}
    32:   currentSubtotalPriceSet{shopMoney{amount}}
    33:   totalTaxSet{shopMoney{amount}}
    34:   customer{id email firstName lastName}
    35:   tags sourceName note`;
    36: 
    37: const QUERY = `query($q:String!,$first:Int!,$after:String){
    38:   orders(first:$first,after:$after,query:$q,sortKey:UPDATED_AT,reverse:false){
    39:     edges{node{${ORDER_SYNC_FIELDS}}}
    40:     pageInfo{hasNextPage endCursor}
    41:   }
    42: }`;
    43: 
    44: // Returns { synced, truncated, since }. `upsertNode(node)` must write one order into the cache.
    45: export async function syncRecentOrders({
    46:   shopifyFetch, getState, setState, upsertNode, now = Date.now,
    47:   pageLimit = SYNC_PAGE_LIMIT, pageSize = SYNC_PAGE_SIZE,
    48: }) {
    49:   const startedAt = now();
    50:   const state = getState();
    51:   const sinceMs = state?.last_synced_at
    52:     ? state.last_synced_at - SYNC_OVERLAP_MS
    53:     : startedAt - SYNC_COLD_START_MS;
    54:   const since = new Date(sinceMs).toISOString();
    55: 
    56:   let after = null;
    57:   let synced = 0;
    58:   let maxUpdated = 0;
    59:   let hasNext = false;
    60:   try {
    61:     for (let page = 0; page < pageLimit; page++) {
    62:       const res = await shopifyFetch(QUERY, { q: `updated_at:>${since}`, first: pageSize, after });
    63:       const conn = res.data?.orders;
    64:       if (!conn) throw new Error('orders unavailable while polling');
    65:       for (const { node } of conn.edges || []) {
    66:         upsertNode(node);
    67:         synced++;
    68:         const t = node.updatedAt ? Date.parse(node.updatedAt) : 0;
    69:         if (t > maxUpdated) maxUpdated = t;
    70:       }
    71:       hasNext = !!conn.pageInfo?.hasNextPage;
    72:       if (!hasNext) break;
    73:       if (!conn.pageInfo.endCursor) throw new Error('orders hasNextPage without cursor');
    74:       after = conn.pageInfo.endCursor;
    75:     }
    76:   } catch (err) {
    77:     // Cursor stays put (sinceMs + overlap == the stored value) so the whole window is retried.
    78:     setState({ lastSyncedAt: sinceMs + SYNC_OVERLAP_MS, lastError: err.message });
    79:     throw err;
    80:   }
    81: 
    82:   // Complete: everything up to startedAt is in the cache. Capped: only up to the newest row stored.
    83:   const cursor = hasNext ? Math.max(maxUpdated, sinceMs + SYNC_OVERLAP_MS) : startedAt;
    84:   setState({ lastSyncedAt: cursor, totalSynced: synced });
    85:   return { synced, truncated: hasNext, since };
    86: }
    87: 
    88: // REST webhook payloads use null / 'fulfilled' / 'partial' / 'restocked'; the GraphQL poller and both
    89: // backfills write UNFULFILLED / FULFILLED / PARTIALLY_FULFILLED / ... into the same columns and every
    90: // reader compares those. Without this a partly-shipped order read "PARTIAL" or null depending on which
    91: // writer touched it last.
    92: // SYNC: the GraphQL enum names — OrderDisplayFulfillmentStatus.
    93: export function normalizeRestFulfillmentStatus(v) {
    94:   if (v == null || v === '') return 'UNFULFILLED';
    95:   const s = String(v).toUpperCase();
    96:   return s === 'PARTIAL' ? 'PARTIALLY_FULFILLED' : s;
    97: }

### FILE package-lock.json
     1: {
     2:   "name": "fww-b2b-admin",
     3:   "version": "0.1.0",
     4:   "lockfileVersion": 3,
     5:   "requires": true,
     6:   "packages": {
     7:     "": {
     8:       "name": "fww-b2b-admin",
     9:       "version": "0.1.0",
    10:       "dependencies": {
    11:         "archiver": "^8.0.0",
    12:         "better-sqlite3": "^12.11.1",
    13:         "bwip-js": "^4.10.1",
    14:         "express": "^5.2.1",
    15:         "pdfkit": "^0.18.0"
    16:       },
    17:       "devDependencies": {
    18:         "playwright": "^1.60.0"
    19:       },
    20:       "engines": {
    21:         "node": ">=20"
    22:       }
    23:     },
    24:     "node_modules/@noble/ciphers": {
    25:       "version": "1.3.0",
    26:       "resolved": "https://registry.npmjs.org/@noble/ciphers/-/ciphers-1.3.0.tgz",
    27:       "integrity": "sha512-2I0gnIVPtfnMw9ee9h1dJG7tp81+8Ob3OJb3Mv37rx5L40/b0i7djjCVvGOVqc9AEIQyvyu1i6ypKdFw8R8gQw==",
    28:       "license": "MIT",
    29:       "engines": {
    30:         "node": "^14.21.3 || >=16"
    31:       },
    32:       "funding": {
    33:         "url": "https://paulmillr.com/funding/"
    34:       }
    35:     },
    36:     "node_modules/@noble/hashes": {
    37:       "version": "1.8.0",
    38:       "resolved": "https://registry.npmjs.org/@noble/hashes/-/hashes-1.8.0.tgz",
    39:       "integrity": "sha512-jCs9ldd7NwzpgXDIf6P3+NrHh9/sD6CQdxHyjQI+h/6rDNo88ypBxxz45UDuZHz9r3tNz7N/VInSVoVdtXEI4A==",
    40:       "license": "MIT",
    41:       "engines": {
    42:         "node": "^14.21.3 || >=16"
    43:       },
    44:       "funding": {
    45:         "url": "https://paulmillr.com/funding/"
    46:       }
    47:     },
    48:     "node_modules/@swc/helpers": {
    49:       "version": "0.5.22",
    50:       "resolved": "https://registry.npmjs.org/@swc/helpers/-/helpers-0.5.22.tgz",
    51:       "integrity": "sha512-/e2Ly3Docn9kYByap6TV4oquJ3wQuz3c+kC74riqtkwU9CwTMeuj6t2rW+bRr4pyOx/CYQM4wr0RgaKQwGEz0A==",
    52:       "license": "Apache-2.0",
    53:       "dependencies": {
    54:         "tslib": "^2.8.0"
    55:       }
    56:     },
    57:     "node_modules/abort-controller": {
    58:       "version": "3.0.0",
    59:       "resolved": "https://registry.npmjs.org/abort-controller/-/abort-controller-3.0.0.tgz",
    60:       "integrity": "sha512-h8lQ8tacZYnR3vNQTgibj+tODHI5/+l06Au2Pcriv/Gmet0eaj4TwWH41sO9wnHDiQsEj19q0drzdWdeAHtweg==",
    61:       "license": "MIT",
    62:       "dependencies": {
    63:         "event-target-shim": "^5.0.0"
    64:       },
    65:       "engines": {
    66:         "node": ">=6.5"
    67:       }
    68:     },
    69:     "node_modules/accepts": {
    70:       "version": "2.0.0",
    71:       "resolved": "https://registry.npmjs.org/accepts/-/accepts-2.0.0.tgz",
    72:       "integrity": "sha512-5cvg6CtKwfgdmVqY1WIiXKc3Q1bkRqGLi+2W/6ao+6Y7gu/RCwRuAhGEzh5B4KlszSuTLgZYuqFqo5bImjNKng==",
    73:       "license": "MIT",
    74:       "dependencies": {
    75:         "mime-types": "^3.0.0",
    76:         "negotiator": "^1.0.0"
    77:       },
    78:       "engines": {
    79:         "node": ">= 0.6"
    80:       }
    81:     },
    82:     "node_modules/archiver": {
    83:       "version": "8.0.0",
    84:       "resolved": "https://registry.npmjs.org/archiver/-/archiver-8.0.0.tgz",
    85:       "integrity": "sha512-fV1orZfsnPn9BaSByR/qE67rJCLJEy2Ox5bq7nJh+jquWaNh6Sfec75kJ2T6PtdGUbPQlrVoSVCEOa5SdiTQ1g==",
    86:       "license": "MIT",
    87:       "dependencies": {
    88:         "async": "^3.2.4",
    89:         "buffer-crc32": "^1.0.0",
    90:         "is-stream": "^4.0.0",
    91:         "lazystream": "^1.0.0",
    92:         "normalize-path": "^3.0.0",
    93:         "readable-stream": "^4.0.0",
    94:         "readdir-glob": "^3.0.0",
    95:         "tar-stream": "^3.0.0",
    96:         "zip-stream": "^7.0.2"
    97:       },
    98:       "engines": {
    99:         "node": ">=18"
   100:       }
   101:     },
   102:     "node_modules/archiver/node_modules/buffer": {
   103:       "version": "6.0.3",
   104:       "resolved": "https://registry.npmjs.org/buffer/-/buffer-6.0.3.tgz",
   105:       "integrity": "sha512-FTiCpNxtwiZZHEZbcbTIcZjERVICn9yq/pDFkTl95/AxzD1naBctN7YO68riM/gLSDY7sdrMby8hofADYuuqOA==",
   106:       "funding": [
   107:         {
   108:           "type": "github",
   109:           "url": "https://github.com/sponsors/feross"
   110:         },
   111:         {
   112:           "type": "patreon",
   113:           "url": "https://www.patreon.com/feross"
   114:         },
   115:         {
   116:           "type": "consulting",
   117:           "url": "https://feross.org/support"
   118:         }
   119:       ],
   120:       "license": "MIT",
   121:       "dependencies": {
   122:         "base64-js": "^1.3.1",
   123:         "ieee754": "^1.2.1"
   124:       }
   125:     },
   126:     "node_modules/archiver/node_modules/readable-stream": {
   127:       "version": "4.7.0",
   128:       "resolved": "https://registry.npmjs.org/readable-stream/-/readable-stream-4.7.0.tgz",
   129:       "integrity": "sha512-oIGGmcpTLwPga8Bn6/Z75SVaH1z5dUut2ibSyAMVhmUggWpmDn2dapB0n7f8nwaSiRtepAsfJyfXIO5DCVAODg==",
   130:       "license": "MIT",
   131:       "dependencies": {
   132:         "abort-controller": "^3.0.0",
   133:         "buffer": "^6.0.3",
   134:         "events": "^3.3.0",
   135:         "process": "^0.11.10",
   136:         "string_decoder": "^1.3.0"
   137:       },
   138:       "engines": {
   139:         "node": "^12.22.0 || ^14.17.0 || >=16.0.0"
   140:       }
   141:     },
   142:     "node_modules/archiver/node_modules/tar-stream": {
   143:       "version": "3.2.0",
   144:       "resolved": "https://registry.npmjs.org/tar-stream/-/tar-stream-3.2.0.tgz",
   145:       "integrity": "sha512-ojzvCvVaNp6aOTFmG7jaRD0meowIAuPc3cMMhSgKiVWws1GyHbGd/xvnyuRKcKlMpt3qvxx6r0hreCNITP9hIg==",
   146:       "license": "MIT",
   147:       "dependencies": {
   148:         "b4a": "^1.6.4",
   149:         "bare-fs": "^4.5.5",
   150:         "fast-fifo": "^1.2.0",
   151:         "streamx": "^2.15.0"
   152:       }
   153:     },
   154:     "node_modules/async": {
   155:       "version": "3.2.6",
   156:       "resolved": "https://registry.npmjs.org/async/-/async-3.2.6.tgz",
   157:       "integrity": "sha512-htCUDlxyyCLMgaM3xXg0C0LW2xqfuQ6p05pCEIsXuyQ+a1koYKTuBMzRNwmybfLgvJDMd0r1LTn4+E0Ti6C2AA==",
   158:       "license": "MIT"
   159:     },
   160:     "node_modules/b4a": {
   161:       "version": "1.8.1",
   162:       "resolved": "https://registry.npmjs.org/b4a/-/b4a-1.8.1.tgz",
   163:       "integrity": "sha512-aiqre1Nr0B/6DgE2N5vwTc+2/oQZ4Wh1t4NznYY4E00y8LCt6NqdRv81so00oo27D8MVKTpUa/MwUUtBLXCoDw==",
   164:       "license": "Apache-2.0",
   165:       "peerDependencies": {
   166:         "react-native-b4a": "*"
   167:       },
   168:       "peerDependenciesMeta": {
   169:         "react-native-b4a": {
   170:           "optional": true
   171:         }
   172:       }
   173:     },
   174:     "node_modules/balanced-match": {
   175:       "version": "4.0.4",
   176:       "resolved": "https://registry.npmjs.org/balanced-match/-/balanced-match-4.0.4.tgz",
   177:       "integrity": "sha512-BLrgEcRTwX2o6gGxGOCNyMvGSp35YofuYzw9h1IMTRmKqttAZZVU67bdb9Pr2vUHA8+j3i2tJfjO6C6+4myGTA==",
   178:       "license": "MIT",
   179:       "engines": {
   180:         "node": "18 || 20 || >=22"
   181:       }
   182:     },
   183:     "node_modules/bare-events": {
   184:       "version": "2.8.3",
   185:       "resolved": "https://registry.npmjs.org/bare-events/-/bare-events-2.8.3.tgz",
   186:       "integrity": "sha512-HdUm8EMQBLaJvGUdidNNbqpA1kYkwNcb+MYxkxCLAPJGQzlv9J0C24h8V65Z4c5GLd/JEALDvpFCQgpLJqc0zw==",
   187:       "license": "Apache-2.0",
   188:       "peerDependencies": {
   189:         "bare-abort-controller": "*"
   190:       },
   191:       "peerDependenciesMeta": {
   192:         "bare-abort-controller": {
   193:           "optional": true
   194:         }
   195:       }
   196:     },
   197:     "node_modules/bare-fs": {
   198:       "version": "4.7.1",
   199:       "resolved": "https://registry.npmjs.org/bare-fs/-/bare-fs-4.7.1.tgz",
   200:       "integrity": "sha512-WDRsyVN52eAx/lBamKD6uyw8H4228h/x0sGGGegOamM2cd7Pag88GfMQalobXI+HaEUxpCkbKQUDOQqt9wawRw==",
   201:       "license": "Apache-2.0",
   202:       "dependencies": {
   203:         "bare-events": "^2.5.4",
   204:         "bare-path": "^3.0.0",
   205:         "bare-stream": "^2.6.4",
   206:         "bare-url": "^2.2.2",
   207:         "fast-fifo": "^1.3.2"
   208:       },
   209:       "engines": {
   210:         "bare": ">=1.16.0"
   211:       },
   212:       "peerDependencies": {
   213:         "bare-buffer": "*"
   214:       },
   215:       "peerDependenciesMeta": {
   216:         "bare-buffer": {
   217:           "optional": true
   218:         }
   219:       }
   220:     },
   221:     "node_modules/bare-os": {
   222:       "version": "3.9.1",
   223:       "resolved": "https://registry.npmjs.org/bare-os/-/bare-os-3.9.1.tgz",
   224:       "integrity": "sha512-6M5XjcnsygQNPMCMPXSK379xrJFiZ/AEMNBmFEmQW8d/789VQATvriyi5r0HYTL9TkQ26rn3kgdTG3aisbrXkQ==",
   225:       "license": "Apache-2.0",
   226:       "engines": {
   227:         "bare": ">=1.14.0"
   228:       }
   229:     },
   230:     "node_modules/bare-path": {
   231:       "version": "3.0.0",
   232:       "resolved": "https://registry.npmjs.org/bare-path/-/bare-path-3.0.0.tgz",
   233:       "integrity": "sha512-tyfW2cQcB5NN8Saijrhqn0Zh7AnFNsnczRcuWODH0eYAXBsJ5gVxAUuNr7tsHSC6IZ77cA0SitzT+s47kot8Mw==",
   234:       "license": "Apache-2.0",
   235:       "dependencies": {
   236:         "bare-os": "^3.0.1"
   237:       }
   238:     },
   239:     "node_modules/bare-stream": {
   240:       "version": "2.13.1",
   241:       "resolved": "https://registry.npmjs.org/bare-stream/-/bare-stream-2.13.1.tgz",
   242:       "integrity": "sha512-Vp0cnjYyrEC4whYTymQ+YZi6pBpfiICZO3cfRG8sy67ZNWe951urv1x4eW1BKNngw3U+3fPYb5JQvHbCtxH7Ow==",
   243:       "license": "Apache-2.0",
   244:       "dependencies": {
   245:         "streamx": "^2.25.0",
   246:         "teex": "^1.0.1"
   247:       },
   248:       "peerDependencies": {
   249:         "bare-abort-controller": "*",
... [TRUNCATED 1626 LINES] ...
  1876:       }
  1877:     },
  1878:     "node_modules/strip-json-comments": {
  1879:       "version": "2.0.1",
  1880:       "resolved": "https://registry.npmjs.org/strip-json-comments/-/strip-json-comments-2.0.1.tgz",
  1881:       "integrity": "sha512-4gB8na07fecVVkOI6Rs4e7T6NOTki5EmL7TUduTs6bu3EdnSycntVJ4re8kgZA+wx9IueI2Y11bfbgwtzuE0KQ==",
  1882:       "license": "MIT",
  1883:       "engines": {
  1884:         "node": ">=0.10.0"
  1885:       }
  1886:     },
  1887:     "node_modules/tar-fs": {
  1888:       "version": "2.1.4",
  1889:       "resolved": "https://registry.npmjs.org/tar-fs/-/tar-fs-2.1.4.tgz",
  1890:       "integrity": "sha512-mDAjwmZdh7LTT6pNleZ05Yt65HC3E+NiQzl672vQG38jIrehtJk/J3mNwIg+vShQPcLF/LV7CMnDW6vjj6sfYQ==",
  1891:       "license": "MIT",
  1892:       "dependencies": {
  1893:         "chownr": "^1.1.1",
  1894:         "mkdirp-classic": "^0.5.2",
  1895:         "pump": "^3.0.0",
  1896:         "tar-stream": "^2.1.4"
  1897:       }
  1898:     },
  1899:     "node_modules/tar-stream": {
  1900:       "version": "2.2.0",
  1901:       "resolved": "https://registry.npmjs.org/tar-stream/-/tar-stream-2.2.0.tgz",
  1902:       "integrity": "sha512-ujeqbceABgwMZxEJnk2HDY2DlnUZ+9oEcb1KzTVfYHio0UE6dG71n60d8D2I4qNvleWrrXpmjpt7vZeF1LnMZQ==",
  1903:       "license": "MIT",
  1904:       "dependencies": {
  1905:         "bl": "^4.0.3",
  1906:         "end-of-stream": "^1.4.1",
  1907:         "fs-constants": "^1.0.0",
  1908:         "inherits": "^2.0.3",
  1909:         "readable-stream": "^3.1.1"
  1910:       },
  1911:       "engines": {
  1912:         "node": ">=6"
  1913:       }
  1914:     },
  1915:     "node_modules/teex": {
  1916:       "version": "1.0.1",
  1917:       "resolved": "https://registry.npmjs.org/teex/-/teex-1.0.1.tgz",
  1918:       "integrity": "sha512-eYE6iEI62Ni1H8oIa7KlDU6uQBtqr4Eajni3wX7rpfXD8ysFx8z0+dri+KWEPWpBsxXfxu58x/0jvTVT1ekOSg==",
  1919:       "license": "MIT",
  1920:       "dependencies": {
  1921:         "streamx": "^2.12.5"
  1922:       }
  1923:     },
  1924:     "node_modules/text-decoder": {
  1925:       "version": "1.2.7",
  1926:       "resolved": "https://registry.npmjs.org/text-decoder/-/text-decoder-1.2.7.tgz",
  1927:       "integrity": "sha512-vlLytXkeP4xvEq2otHeJfSQIRyWxo/oZGEbXrtEEF9Hnmrdly59sUbzZ/QgyWuLYHctCHxFF4tRQZNQ9k60ExQ==",
  1928:       "license": "Apache-2.0",
  1929:       "dependencies": {
  1930:         "b4a": "^1.6.4"
  1931:       }
  1932:     },
  1933:     "node_modules/tiny-inflate": {
  1934:       "version": "1.0.3",
  1935:       "resolved": "https://registry.npmjs.org/tiny-inflate/-/tiny-inflate-1.0.3.tgz",
  1936:       "integrity": "sha512-pkY1fj1cKHb2seWDy0B16HeWyczlJA9/WW3u3c4z/NiWDsO3DOU5D7nhTLE9CF0yXv/QZFY7sEJmj24dK+Rrqw==",
  1937:       "license": "MIT"
  1938:     },
  1939:     "node_modules/toidentifier": {
  1940:       "version": "1.0.1",
  1941:       "resolved": "https://registry.npmjs.org/toidentifier/-/toidentifier-1.0.1.tgz",
  1942:       "integrity": "sha512-o5sSPKEkg/DIQNmH43V0/uerLrpzVedkUh8tGNvaeXpfpuwjKenlSox/2O/BTlZUtEe+JG7s5YhEz608PlAHRA==",
  1943:       "license": "MIT",
  1944:       "engines": {
  1945:         "node": ">=0.6"
  1946:       }
  1947:     },
  1948:     "node_modules/tslib": {
  1949:       "version": "2.8.1",
  1950:       "resolved": "https://registry.npmjs.org/tslib/-/tslib-2.8.1.tgz",
  1951:       "integrity": "sha512-oJFu94HQb+KVduSUQL7wnpmqnfmLsOA/nAh6b6EH0wCEoK0/mPeXU6c3wKDV83MkOuHPRHtSXKKU99IBazS/2w==",
  1952:       "license": "0BSD"
  1953:     },
  1954:     "node_modules/tunnel-agent": {
  1955:       "version": "0.6.0",
  1956:       "resolved": "https://registry.npmjs.org/tunnel-agent/-/tunnel-agent-0.6.0.tgz",
  1957:       "integrity": "sha512-McnNiV1l8RYeY8tBgEpuodCC1mLUdbSN+CYBL7kJsJNInOP8UjDDEwdk6Mw60vdLLrr5NHKZhMAOSrR2NZuQ+w==",
  1958:       "license": "Apache-2.0",
  1959:       "dependencies": {
  1960:         "safe-buffer": "^5.0.1"
  1961:       },
  1962:       "engines": {
  1963:         "node": "*"
  1964:       }
  1965:     },
  1966:     "node_modules/type-is": {
  1967:       "version": "2.1.0",
  1968:       "resolved": "https://registry.npmjs.org/type-is/-/type-is-2.1.0.tgz",
  1969:       "integrity": "sha512-faYHw0anBbc/kWF3zFTEnxSFOAGUX9GFbOBthvDdLsIlEoWOFOtS0zgCiQYwIskL9iGXZL3kAXD8OoZ4GmMATA==",
  1970:       "license": "MIT",
  1971:       "dependencies": {
  1972:         "content-type": "^2.0.0",
  1973:         "media-typer": "^1.1.0",
  1974:         "mime-types": "^3.0.0"
  1975:       },
  1976:       "engines": {
  1977:         "node": ">= 18"
  1978:       },
  1979:       "funding": {
  1980:         "type": "opencollective",
  1981:         "url": "https://opencollective.com/express"
  1982:       }
  1983:     },
  1984:     "node_modules/type-is/node_modules/content-type": {
  1985:       "version": "2.0.0",
  1986:       "resolved": "https://registry.npmjs.org/content-type/-/content-type-2.0.0.tgz",
  1987:       "integrity": "sha512-j/O/d7GcZCyNl7/hwZAb606rzqkyvaDctLmckbxLzHvFBzTJHuGEdodATcP3yIRoDrLHkIATJuvzbFlp/ki2cQ==",
  1988:       "license": "MIT",
  1989:       "engines": {
  1990:         "node": ">=18"
  1991:       },
  1992:       "funding": {
  1993:         "type": "opencollective",
  1994:         "url": "https://opencollective.com/express"
  1995:       }
  1996:     },
  1997:     "node_modules/unicode-properties": {
  1998:       "version": "1.4.1",
  1999:       "resolved": "https://registry.npmjs.org/unicode-properties/-/unicode-properties-1.4.1.tgz",
  2000:       "integrity": "sha512-CLjCCLQ6UuMxWnbIylkisbRj31qxHPAurvena/0iwSVbQ2G1VY5/HjV0IRabOEbDHlzZlRdCrD4NhB0JtU40Pg==",
  2001:       "license": "MIT",
  2002:       "dependencies": {
  2003:         "base64-js": "^1.3.0",
  2004:         "unicode-trie": "^2.0.0"
  2005:       }
  2006:     },
  2007:     "node_modules/unicode-trie": {
  2008:       "version": "2.0.0",
  2009:       "resolved": "https://registry.npmjs.org/unicode-trie/-/unicode-trie-2.0.0.tgz",
  2010:       "integrity": "sha512-x7bc76x0bm4prf1VLg79uhAzKw8DVboClSN5VxJuQ+LKDOVEW9CdH+VY7SP+vX7xCYQqzzgQpFqz15zeLvAtZQ==",
  2011:       "license": "MIT",
  2012:       "dependencies": {
  2013:         "pako": "^0.2.5",
  2014:         "tiny-inflate": "^1.0.0"
  2015:       }
  2016:     },
  2017:     "node_modules/unicode-trie/node_modules/pako": {
  2018:       "version": "0.2.9",
  2019:       "resolved": "https://registry.npmjs.org/pako/-/pako-0.2.9.tgz",
  2020:       "integrity": "sha512-NUcwaKxUxWrZLpDG+z/xZaCgQITkA/Dv4V/T6bw7VON6l1Xz/VnrBqrYjZQ12TamKHzITTfOEIYUj48y2KXImA==",
  2021:       "license": "MIT"
  2022:     },
  2023:     "node_modules/unpipe": {
  2024:       "version": "1.0.0",
  2025:       "resolved": "https://registry.npmjs.org/unpipe/-/unpipe-1.0.0.tgz",
  2026:       "integrity": "sha512-pjy2bYhSsufwWlKwPc+l3cN7+wuJlK6uz0YdJEOlQDbl6jo/YlPi4mb8agUkVC8BF7V8NuzeyPNqRksA3hztKQ==",
  2027:       "license": "MIT",
  2028:       "engines": {
  2029:         "node": ">= 0.8"
  2030:       }
  2031:     },
  2032:     "node_modules/util-deprecate": {
  2033:       "version": "1.0.2",
  2034:       "resolved": "https://registry.npmjs.org/util-deprecate/-/util-deprecate-1.0.2.tgz",
  2035:       "integrity": "sha512-EPD5q1uXyFxJpCrLnCc1nHnq3gOa6DZBocAIiI2TaSCA7VCJ1UJDMagCzIkXNsUYfD1daK//LTEQ8xiIbrHtcw==",
  2036:       "license": "MIT"
  2037:     },
  2038:     "node_modules/vary": {
  2039:       "version": "1.1.2",
  2040:       "resolved": "https://registry.npmjs.org/vary/-/vary-1.1.2.tgz",
  2041:       "integrity": "sha512-BNGbWLfd0eUPabhkXUVm0j8uuvREyTh5ovRa/dyow/BqAbZJyC+5fU+IzQOzmAKzYqYRAISoRhdQr3eIZ/PXqg==",
  2042:       "license": "MIT",
  2043:       "engines": {
  2044:         "node": ">= 0.8"
  2045:       }
  2046:     },
  2047:     "node_modules/wrappy": {
  2048:       "version": "1.0.2",
  2049:       "resolved": "https://registry.npmjs.org/wrappy/-/wrappy-1.0.2.tgz",
  2050:       "integrity": "sha512-l4Sp/DRseor9wL6EvV2+TuQn63dMkPjZ/sp9XkghTEbV9KlPS1xUsZ3u7/IQO4wxtcFB4bgpQPRcR3QCvezPcQ==",
  2051:       "license": "ISC"
  2052:     },
  2053:     "node_modules/zip-stream": {
  2054:       "version": "7.0.5",
  2055:       "resolved": "https://registry.npmjs.org/zip-stream/-/zip-stream-7.0.5.tgz",
  2056:       "integrity": "sha512-dSvYKdvLsAHCDqPOhIwk/q5CvuWtTB3Dgpoe0uVEFjTzIOAmsQpprX25InCvrvJsirEbu1OHyy67n/kAj1Sw/w==",
  2057:       "license": "MIT",
  2058:       "dependencies": {
  2059:         "compress-commons": "^7.0.0",
  2060:         "normalize-path": "^3.0.0",
  2061:         "readable-stream": "^4.0.0"
  2062:       },
  2063:       "engines": {
  2064:         "node": ">=18"
  2065:       }
  2066:     },
  2067:     "node_modules/zip-stream/node_modules/buffer": {
  2068:       "version": "6.0.3",
  2069:       "resolved": "https://registry.npmjs.org/buffer/-/buffer-6.0.3.tgz",
  2070:       "integrity": "sha512-FTiCpNxtwiZZHEZbcbTIcZjERVICn9yq/pDFkTl95/AxzD1naBctN7YO68riM/gLSDY7sdrMby8hofADYuuqOA==",
  2071:       "funding": [
  2072:         {
  2073:           "type": "github",
  2074:           "url": "https://github.com/sponsors/feross"
  2075:         },
  2076:         {
  2077:           "type": "patreon",
  2078:           "url": "https://www.patreon.com/feross"
  2079:         },
  2080:         {
  2081:           "type": "consulting",
  2082:           "url": "https://feross.org/support"
  2083:         }
  2084:       ],
  2085:       "license": "MIT",
  2086:       "dependencies": {
  2087:         "base64-js": "^1.3.1",
  2088:         "ieee754": "^1.2.1"
  2089:       }
  2090:     },
  2091:     "node_modules/zip-stream/node_modules/readable-stream": {
  2092:       "version": "4.7.0",
  2093:       "resolved": "https://registry.npmjs.org/readable-stream/-/readable-stream-4.7.0.tgz",
  2094:       "integrity": "sha512-oIGGmcpTLwPga8Bn6/Z75SVaH1z5dUut2ibSyAMVhmUggWpmDn2dapB0n7f8nwaSiRtepAsfJyfXIO5DCVAODg==",
  2095:       "license": "MIT",
  2096:       "dependencies": {
  2097:         "abort-controller": "^3.0.0",
  2098:         "buffer": "^6.0.3",
  2099:         "events": "^3.3.0",
  2100:         "process": "^0.11.10",
  2101:         "string_decoder": "^1.3.0"
  2102:       },
  2103:       "engines": {
  2104:         "node": "^12.22.0 || ^14.17.0 || >=16.0.0"
  2105:       }
  2106:     }
  2107:   }
  2108: }

### FILE package.json
     1: {
     2:   "name": "fww-b2b-admin",
     3:   "version": "0.1.0",
     4:   "description": "Fuzzywumpets internal B2B admin/ops dashboard — separate from the customer-facing b2b portal",
     5:   "type": "module",
     6:   "main": "server.mjs",
     7:   "scripts": {
     8:     "start": "node server.mjs",
     9:     "test": "./run-tests.sh"
    10:   },
    11:   "engines": {
    12:     "node": ">=20"
    13:   },
    14:   "dependencies": {
    15:     "archiver": "^8.0.0",
    16:     "better-sqlite3": "^12.11.1",
    17:     "bwip-js": "^4.10.1",
    18:     "express": "^5.2.1",
    19:     "pdfkit": "^0.18.0"
    20:   },
    21:   "devDependencies": {
    22:     "playwright": "^1.60.0"
    23:   }
    24: }

### FILE run-tests.sh
     1: #!/usr/bin/env bash
     2: set -euo pipefail
     3: cd "$(dirname "$0")"
     4: 
     5: echo ""
     6: echo "======================================================"
     7: echo "         fww-b2b-admin test suite"
     8: echo "======================================================"
     9: 
    10: PORT=8894
    11: echo ""
    12: echo "Starting mock server (B2B_ADMIN_MOCK=1, port $PORT)..."
    13: PORT=$PORT B2B_ADMIN_MOCK=1 B2B_IMPERSONATION_SECRET=test-impersonation-secret-mock SHOPIFY_WEBHOOK_SECRET=test-shopify-webhook-secret node server.mjs &
    14: MOCK_PID=$!
    15: 
    16: cleanup() { kill "$MOCK_PID" 2>/dev/null || true; }
    17: trap cleanup EXIT
    18: 
    19: for i in $(seq 1 20); do
    20:   if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    21:     echo "Mock server ready (pid $MOCK_PID)"
    22:     break
    23:   fi
    24:   sleep 0.5
    25: done
    26: if ! curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    27:   echo "ERROR: mock server did not start" >&2
    28:   exit 1
    29: fi
    30: 
    31: API_FAIL=0
    32: UI_FAIL=0
    33: UNIT_FAIL=0
    34: AUTH_FAIL=0
    35: 
    36: if [ -f test/api.test.mjs ]; then
    37:   echo ""
    38:   TEST_BASE="http://127.0.0.1:$PORT" node test/api.test.mjs || API_FAIL=$?
    39: fi
    40: 
    41: if [ -f test/ui.test.mjs ]; then
    42:   echo ""
    43:   TEST_BASE="http://127.0.0.1:$PORT" node test/ui.test.mjs || UI_FAIL=$?
    44: fi
    45: 
    46: # Standalone unit suites — run WITHOUT the mock HTTP server on purpose, because the code they cover
    47: # is short-circuited under MOCK (getPortalDb returns null) and the API suite would otherwise report
    48: # a false green over an untested ingest.
    49: if [ -f test/leads-ingest.test.mjs ]; then
    50:   echo ""
    51:   B2B_ADMIN_MOCK=1 node test/leads-ingest.test.mjs || UNIT_FAIL=$?
    52: fi
    53: 
    54: # Order/line-item cache integrity (H14 line-item duplication, H15 status casing). Standalone for the
    55: # same reason as above: getOrdersData() short-circuits to the MOCK fixture array and never reads
    56: # orders_cache, so these writes are invisible to the API suite.
    57: if [ -f test/order-cache-integrity.test.mjs ]; then
    58:   echo ""
    59:   B2B_ADMIN_MOCK=1 node test/order-cache-integrity.test.mjs || UNIT_FAIL=$?
    60: fi
    61: 
    62: # Boots its OWN non-MOCK servers (against throwaway sqlite dirs via B2B_ADMIN_DATA_DIR) because the
    63: # /__test__/session allowlist+audit guard only exists on the non-MOCK branch. Deliberately NOT given
    64: # B2B_ADMIN_MOCK.
    65: if [ -f test/test-session-guard.test.mjs ]; then
    66:   echo ""
    67:   node test/test-session-guard.test.mjs || AUTH_FAIL=$?
    68: fi
    69: 
    70: # Incremental orders poller (paging, cursor, error handling) + REST status normalizer. Standalone:
    71: # the poller sits behind `if (!MOCK)` in server.mjs, so the HTTP suite can never reach it.
    72: if [ -f test/orders-recent-sync.test.mjs ]; then
    73:   echo ""
    74:   node test/orders-recent-sync.test.mjs || UNIT_FAIL=$?
    75: fi
    76: 
    77: # Money-correctness helpers (lib/order-money.mjs). Standalone because the branches under test are
    78: # Shopify userError branches — MOCK never calls shopifyFetch, so only an injected fake reaches them.
    79: if [ -f test/order-money.test.mjs ]; then
    80:   echo ""
    81:   node test/order-money.test.mjs || UNIT_FAIL=$?
    82: fi
    83: 
    84: if [ -f test/helcim.test.mjs ]; then
    85:   echo ""
    86:   echo "── Unit: Helcim invoice client (standalone, no server) ──"
    87:   node test/helcim.test.mjs || UNIT_FAIL=$?
    88: fi
    89: 
    90: if [ -f test/helcim-payload.test.mjs ]; then
    91:   echo ""
    92:   echo "── Unit: Helcim itemized payload assembler (standalone, no server) ──"
    93:   node test/helcim-payload.test.mjs || UNIT_FAIL=$?
    94: fi
    95: 
    96: if [ -f test/helcim-dedupe.test.mjs ]; then
    97:   echo ""
    98:   echo "── Unit: Helcim durable creation claim (standalone, no server) ──"
    99:   B2B_ADMIN_MOCK=1 node test/helcim-dedupe.test.mjs || UNIT_FAIL=$?
   100: fi
   101: 
   102: if [ -f test/helcim-message.test.mjs ]; then
   103:   echo ""
   104:   echo "── Unit: Helcim branded email contract (standalone, no server) ──"
   105:   node test/helcim-message.test.mjs || UNIT_FAIL=$?
   106: fi
   107: 
   108: # Order-edit userErrors: the batch /edit handler returns from its MOCK branch before any Shopify
   109: # mutation, so this path can ONLY be covered standalone.
   110: if [ -f test/order-edit-user-errors.test.mjs ]; then
   111:   echo ""
   112:   node test/order-edit-user-errors.test.mjs || UNIT_FAIL=$?
   113: fi
   114: 
   115: # List truncation lives here for the same reason: the cache path is gated on `if (!MOCK)`, so the
   116: # HTTP suite can never reach the capped query that truncates /orders and /customers.
   117: if [ -f test/list-truncation.test.mjs ]; then
   118:   echo ""
   119:   B2B_ADMIN_MOCK=1 node test/list-truncation.test.mjs || UNIT_FAIL=$?
   120: fi
   121: 
   122: # The leads list cap + phone search are DB-level (a REPLACE() chain in SQL, and one shared WHERE
   123: # builder feeding both getLeads and countLeads). Same reasoning as the block above — the HTTP suite
   124: # cannot reach either, so they get their own in-memory unit run.
   125: if [ -f test/leads-list.test.mjs ]; then
   126:   echo ""
   127:   B2B_ADMIN_MOCK=1 node test/leads-list.test.mjs || UNIT_FAIL=$?
   128: fi
   129: 
   130: # Edited orders must be shown and summed at their CURRENT total. total_price/subtotal_price FREEZE at
   131: # the pre-edit amount, so reading them overstates every edited order. DB-layer + template strings —
   132: # the mock HTTP server reaches neither (the cache paths are gated on `if (!MOCK)`).
   133: if [ -f test/order-display-totals.test.mjs ]; then
   134:   echo ""
   135:   node test/order-display-totals.test.mjs || UNIT_FAIL=$?
   136: fi
   137: 
   138: # The #38953 lock-up: a permanently-failing line edit armed a beforeunload guard, and the Electron
   139: # shell cancels a prevented unload SILENTLY — every link, the back button, "Generate PDF" and Quit
   140: # died at once. Standalone: it spans desktop shell code (never loaded by the server) and source-level
   141: # guards on call sites, neither of which the HTTP suites can reach.
   142: if [ -f test/order-edit-nav-deadlock.test.mjs ]; then
   143:   echo ""
   144:   node test/order-edit-nav-deadlock.test.mjs || UNIT_FAIL=$?
   145: fi
   146: 
   147: # Pagination-completeness (2026-09-23 audit, #39355 class): getOrderDetail must drain order
   148: # lineItems beyond first:250 or renderOrderDetail / createXeroInvoice / ship flows under-build.
   149: if [ -f test/pagination-completeness.test.mjs ]; then
   150:   echo ""
   151:   node test/pagination-completeness.test.mjs || UNIT_FAIL=$?
   152: fi
   153: if [ -f test/fulfillment-order-paging.test.mjs ]; then
   154:   echo ""
   155:   node test/fulfillment-order-paging.test.mjs || UNIT_FAIL=$?
   156: fi
   157: if [ -f test/dashboard-paging.test.mjs ]; then
   158:   echo ""
   159:   node test/dashboard-paging.test.mjs || UNIT_FAIL=$?
   160: fi
   161: 
   162: # Electron shell code — never runs inside the Express server, so the HTTP suites cannot reach it.
   163: # Guards the PDF-in-the-main-window trap (no back button; its X quits the whole app).
   164: if [ -f test/desktop-pdf-headers.test.mjs ]; then
   165:   echo ""
   166:   node test/desktop-pdf-headers.test.mjs || UNIT_FAIL=$?
   167: fi
   168: 
   169: # Packaging allowlist. v1.0.3 shipped unlaunchable because main.js required a module that
   170: # build.files never packaged — the build, the tests and the publish all succeeded. This is the
   171: # source-level half of that guard; tools/verify-package.js checks the built artifact in CI.
   172: if [ -f test/desktop-packaging.test.mjs ]; then
   173:   echo ""
   174:   node test/desktop-packaging.test.mjs || UNIT_FAIL=$?
   175: fi
   176: 
   177: # The allowlist gate is pure logic over env, and it guards the WHOLE dashboard. It gets its own run
   178: # because the HTTP suite short-circuits Google OAuth entirely in MOCK and never exercises it.
   179: if [ -f test/admin-allowlist.test.mjs ]; then
   180:   echo ""
   181:   node test/admin-allowlist.test.mjs || UNIT_FAIL=$?
   182: fi
   183: 
   184: echo ""
   185: echo "======================================================"
   186: if [ $API_FAIL -eq 0 ] && [ $UI_FAIL -eq 0 ] && [ $UNIT_FAIL -eq 0 ] && [ $AUTH_FAIL -eq 0 ]; then
   187:   echo "  ALL TESTS PASSED"
   188:   echo "======================================================"
   189:   exit 0
   190: else
   191:   [ $API_FAIL  -ne 0 ] && echo "  API tests:  FAILED"
   192:   [ $UI_FAIL   -ne 0 ] && echo "  UI tests:   FAILED"
   193:   [ $UNIT_FAIL -ne 0 ] && echo "  Unit tests: FAILED"
   194:   [ $AUTH_FAIL -ne 0 ] && echo "  Auth-guard tests: FAILED"
   195:   echo "======================================================"
   196:   exit 1
   197: fi

### FILE server.mjs
     1: /**
     2:  * fww-b2b-admin — Fuzzywumpets internal ops dashboard.
     3:  * Phase 1: Google OAuth + dashboard MVP.
     4:  * Phase 2: Orders + Customers pages.
     5:  * Phase 3: Catalog + Reports + Settings + Migrate.
     6:  * Phase 4: Polish — keyboard shortcuts, CSV exports, PWA manifest.
     7:  * Phase 5: UPC barcode label engine.
     8:  * Phase 6: Product CSV + image ZIP exports.
     9:  */
    10: import express from 'express';
    11: import crypto from 'node:crypto';
    12: import path from 'node:path';
    13: import fs from 'node:fs';
    14: import zlib from 'node:zlib';
    15: import { fileURLToPath } from 'node:url';
    16: import { spawnSync } from 'node:child_process';
    17: import { ZipArchive } from 'archiver';
    18: import {
    19:   createSession, getSession, deleteSession, auditLog,
    20:   getCustomerNotes, setCustomerNotes, getDropshipCache, setDropshipCache,
    21:   getSetting, setSetting, getGlobalSettings, getAuditLog, getAuditLogCount,
    22:   logLabelBatch, logExportBatch,
    23:   createLead, getLeads, countLeads, getLeadCounts, getLead, updateLead, upsertPortalLead,
    24:   addLeadNote, getLeadNotes, addLeadStatusHistory, getLeadStatusHistory,
    25:   upsertBackorder, getBackordersForOrder, getOpenBackorders, fulfillBackorder, logOrderEdit,
    26:   getEditAction, putEditAction,
    27:   getOutstandingBalanceForCustomer,
    28:   getXeroMap, setXeroMap, addXeroPending, getXeroPending, markXeroPendingDone, markXeroPendingFailed, getXeroPendingCount, getXeroInvoiceMaps,
    29:   createImpersonationNonce, consumeImpersonationNonce, gcImpersonationNonces,
    30:   createPartialInvoice, getPartialInvoices, getNextInvoiceLetter,
    31:   getOrderHistory,
    32:   upsertCustomerCache, upsertOrderCache, upsertOrderLineItemsCache, upsertProductCache,
    33:   getOrdersFromCache, getOrderFromCache, getOrderSpendFromCache, getCustomerFromCache,
    34:   getCustomersCountInCache, getOrdersCountInCache, getProductsCountInCache,
    35:   getSyncState, setSyncState, getAllInvoicesForList, getPartialInvoicesAll,
    36:   listCustomersFromCache,
    37:   getCustomerCacheStats,
    38:   listOrdersFromCache, getOrdersCacheStats, getCustomerOrdersFromCache,
    39:   deleteOrderFromCache, getOrderShopifyIdsBatch,
    40:   getReportsDataFromCache,
    41:   getTopCustomersAllTime,
    42:   listImpersonationsForCustomer,
    43:   getOrderByName,
    44:   getOrderInternalNote, setOrderInternalNote,
    45:   getHelcimInvoiceMap, claimHelcimInvoiceCreation, releaseHelcimInvoiceClaim,
    46:   upsertHelcimInvoiceMap, setHelcimInvoiceDelivery,
    47: } from './db.mjs';
    48: import { generateInvoicePdf, lineItemTrueTotal, lineItemTrueUnit, lineItemCurrentQty } from './pdf.mjs';
    49: // Extracted so they can be unit-tested without booting this server (house pattern: lib/*.mjs).
    50: import { isTerminalEditError } from './lib/order-edit-errors.mjs';
    51: // DEPENDS: every money surface in this file picks its amount through these two — cacheRowTotal for a
    52: // raw orders_cache row, listRowTotalAmount for a Shopify/GraphQL-shaped one. A query that feeds one
    53: // of them MUST also select currentTotalPriceSet (or carry current_total), or the accessor silently
    54: // falls back to the frozen pre-edit amount and the surface looks correct while being wrong.
    55: import { cacheRowTotal, listRowTotalAmount, restRowCurrentTotals } from './lib/order-display-totals.mjs';
    56: import { LINE_PAGE_MAX, drainLineItems } from './lib/line-item-paging.mjs';
    57: // loadOpenFulfillmentLineMap is the standalone fail-closed helper. /orders/:id/fulfill stays on
    58: // getOpenFulfillmentOrderLines because PR #45 maps remaining qty per location and never clamps;
    59: // origin/main no longer has /orders/:id/ship/label (handed off to FWW Shipping).
    60: import { loadOpenFulfillmentLineMap } from './lib/fulfillment-order-paging.mjs';
    61: import { syncRecentOrders, normalizeRestFulfillmentStatus } from './lib/orders-recent-sync.mjs';
    62: import { drainDashboardOrders, drainLowStockItems, drainCustomerSpendOrders } from './lib/dashboard-paging.mjs';
    63: import { renderLabelSheet, expandItems, TEMPLATES as LABEL_TEMPLATES, DEFAULT_FIELDS } from './labels.mjs';
    64: import { isInsider, resolveXeroContact, syncCustomerToXero, getXeroSyncStatus } from './lib/xero-customer-sync.mjs';
    65: import { parseLinePrices, applyLinePriceChanges, bulkMarkOrdersPaid } from './lib/order-money.mjs';
    66: import { assertNoUserErrors } from './lib/shopify-user-errors.mjs';
    67: import { createCreditCardInvoice } from './helcim.mjs';
    68: import { buildHelcimInvoicePayload, HelcimInvoiceValidationError } from './lib/helcim-invoice-payload.mjs';
    69: import { buildHelcimInvoiceMessage } from './lib/helcim-invoice-message.mjs';
    70: // SYNC: same module db.mjs uses for the SQL LIMIT — the banner/footer copy and the query page size
    71: // must agree, otherwise the list lies about how much it is showing.
    72: import { ORDERS_LIST_LIMIT, CUSTOMERS_LIST_LIMIT, LEADS_LIST_LIMIT, listCountLabel, truncationNoticeHtml } from './lib/list-truncation.mjs';
    73: // fww-error-sink monitoring (injected 2026-06-30): error-logging shim only. To disable, remove this import, the installGlobalHandlers() call, and the expressErrorMiddleware() app.use. See fww-error-sink RUNBOOK.
    74: import { installGlobalHandlers, expressErrorMiddleware, reportEvent } from './fww-logsink.mjs';
    75: installGlobalHandlers();
    76: 
    77: const __dirname = path.dirname(fileURLToPath(import.meta.url));
    78: const MOCK  = process.env.B2B_ADMIN_MOCK === '1';
    79: 
    80: // Activity-gated Shopify polling (added 2026-05-30 — shopify-bridge perf fix):
    81: // only sync while the dashboard is in active use, so data stays fresh when someone
    82: // is looking but Shopify isn't polled around the clock.
    83: let lastDashboardActivity = 0;
    84: const ACTIVE_WINDOW_MS = 20 * 60 * 1000; // treat as "in use" for 20 min after last request
    85: const dashboardActive = () => (Date.now() - lastDashboardActivity) < ACTIVE_WINDOW_MS;
    86: const PORT  = Number(process.env.PORT || 8794);
    87: 
    88: const GOOGLE_CLIENT_ID     = process.env.B2B_ADMIN_GOOGLE_CLIENT_ID     || '';
    89: const GOOGLE_CLIENT_SECRET = process.env.B2B_ADMIN_GOOGLE_CLIENT_SECRET || '';
    90: const ALLOWED_EMAILS       = (process.env.B2B_ADMIN_ALLOWED_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
    91: const SHOPIFY_BEARER       = process.env.SHOPIFY_BRIDGE_BEARER           || '';
    92: const REDIRECT_URI         = MOCK
    93:   ? `http://127.0.0.1:${PORT}/auth/google/callback`
    94:   : 'https://b2badmin.fuzzywumpets.com/auth/google/callback';
    95: const COOKIE_NAME = 'b2b_admin_sid';
    96: const B2B_PUB_ID  = 'gid://shopify/Publication/199709720811';
    97: const PORTAL_INTERNAL_TOKEN = process.env.B2B_PORTAL_INTERNAL_TOKEN || '';
    98: const PORTAL_INTERNAL_URL   = process.env.B2B_PORTAL_INTERNAL_URL || 'http://127.0.0.1:8793';
    99: const XERO_BRIDGE_URL       = 'https://fww-xero-bridge.alex-037.workers.dev/xero';
   100: const XERO_BEARER           = process.env.XERO_BRIDGE_BEARER || '';
   101: // ─────────────────────────────────────────────────────────────────────────────
   102: // [XERO-DISABLED] TEMPORARY XERO WRITE KILL-SWITCH — added 2026-07-14 by request.
   103: // Alex is cleaning up bad/garbage data on the Xero side and will do a clean
   104: // re-pull once it's fixed. Until then, ALL Xero WRITE + SYNC operations are
   105: // disconnected: they must NOT reach Xero, must NOT enqueue xero_pending retry
   106: // rows, must NOT write local xero-map / mapping-file entries (that queue + those
   107: // files are themselves "garbage" we don't want to accumulate), and must NOT throw
   108: // — a B2B action (create order, mark paid, manual sync, customer sync) still
   109: // succeeds for the user.
   110: //
   111: // ⚠️  SILENT-PASS WARNING FOR THE NEXT REVIEWER  ⚠️
   112: // While this is false, the Xero steps RETURN SUCCESS-SHAPED RESULTS WITHOUT DOING
   113: // ANYTHING. Logs/UI may say the Xero step "synced/skipped/completed" even though
   114: // NO invoice, payment, or contact was pushed to Xero, and NOTHING was queued for
   115: // later — re-enabling will NOT backfill the gap. What is actually NOT happening
   116: // while this is off:
   117: //   • submitNewOrder  → NO ACCREC invoice created in Xero
   118: //   • /orders/:id/mark-paid → NO Xero invoice + NO payment recorded
   119: //   • /orders/:id/xero/sync (manual button) → NO invoice (reports "xero_synced")
   120: //   • /api/admin/xero/sync (drain queue) → processes nothing
   121: //   • customer xero-sync / b2b-tag / lead-convert → NO Xero contact created
   122: // Reads (GET: account list, sync-status lookups) are left ALIVE — they don't
   123: // create garbage. Backstop below in xeroRequest() blocks any write we missed.
   124: // TO RE-ENABLE: flip this to true, then manually re-sync affected orders/customers
   125: // (there is no automatic catch-up). Grep tag: [XERO-DISABLED]
   126: // ─────────────────────────────────────────────────────────────────────────────
   127: const XERO_WRITES_ENABLED   = false;
   128: const IMPERSONATION_SECRET  = process.env.B2B_IMPERSONATION_SECRET || (MOCK ? 'test-impersonation-secret-mock' : '');
   129: const PORTAL_BASE_URL       = MOCK ? `http://127.0.0.1:8793` : 'https://b2b.fuzzyreporting.com';
   130: const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || (MOCK ? 'test-shopify-webhook-secret' : '');
   131: 
   132: const app = express();
   133: // Capture the exact raw bytes of every JSON body so the Shopify webhook route can verify its
   134: // HMAC over the ORIGINAL payload (not a re-serialization). SECURITY: without this, express.json
   135: // parses+re-stringifies before the webhook handler runs and the HMAC never matches → all real
   136: // Shopify webhooks were being rejected.
   137: // LIMIT (2026-08-09, fixes H21): express.json defaults to 100kb. Because the Shopify webhook route
   138: // verifies its HMAC over the rawBody captured by THIS parser (see the CHANGE-GUARD on
   139: // POST /webhooks/shopify), a body over the limit is rejected with 413 by the parser BEFORE the
... [TRUNCATED 12240 LINES] ...
 12380:     upsertNode: (o) => {
 12381:       const shopifyId = shopifyNumericId(o.id);
 12382:       const custId = o.customer?.id ? shopifyNumericId(o.customer.id) : null;
 12383:       upsertOrderCache({
 12384:         shopify_id: shopifyId, gid: o.id, name: o.name,
 12385:         customer_shopify_id: custId,
 12386:         created_at: o.createdAt ? new Date(o.createdAt).getTime() : Date.now(),
 12387:         updated_at: o.updatedAt ? new Date(o.updatedAt).getTime() : null,
 12388:         processed_at: o.processedAt ? new Date(o.processedAt).getTime() : null,
 12389:         cancelled_at: o.cancelledAt ? new Date(o.cancelledAt).getTime() : null,
 12390:         financial_status: o.displayFinancialStatus || null,
 12391:         fulfillment_status: o.displayFulfillmentStatus || null,
 12392:         display_financial_status: o.displayFinancialStatus,
 12393:         display_fulfillment_status: o.displayFulfillmentStatus,
 12394:         total_price: parseFloat(o.totalPriceSet?.shopMoney?.amount) || 0,
 12395:         subtotal_price: parseFloat(o.subtotalPriceSet?.shopMoney?.amount) || 0,
 12396:         // CURRENT-TOTALS (2026-06-29): post-edit truth — totalPriceSet/subtotalPriceSet stay FROZEN at the
 12397:         // original on an edited order, so the LIST must carry the current* totals to show e.g. #37639's $601.24.
 12398:         current_total: o.currentTotalPriceSet?.shopMoney?.amount != null ? parseFloat(o.currentTotalPriceSet.shopMoney.amount) : null,
 12399:         current_subtotal: o.currentSubtotalPriceSet?.shopMoney?.amount != null ? parseFloat(o.currentSubtotalPriceSet.shopMoney.amount) : null,
 12400:         total_tax: parseFloat(o.totalTaxSet?.shopMoney?.amount) || 0,
 12401:         currency: 'USD',
 12402:         tags: o.tags || [], source_name: o.sourceName || null, note: o.note || null,
 12403:         customer_email: o.customer?.email || null,
 12404:       });
 12405:     },
 12406:   });
 12407: }
 12408: 
 12409: // WHAT: verifies a small rotating batch of cached orders still exist in Shopify (nodes(ids:) returns
 12410: // a null entry for a deleted id) and evicts any that don't from orders_cache.
 12411: // CHANGE-GUARD: syncRecentFromShopify (above) can only ADD/UPDATE — Shopify's orders() search
 12412: // silently excludes deleted orders from its results, so polling recent updates can never learn that
 12413: // one is GONE, only that it changed. This is the other half of that: a deleted order still has a
 12414: // well-formed gid, so nodes(ids:) is the one query that distinguishes "deleted" from "never existed."
 12415: // A rotating batch (not the whole cache) keeps the per-cycle query cheap; the offset just wraps
 12416: // around the current total, so a bigger cache takes proportionally more cycles to fully sweep, not
 12417: // more cost per cycle — nothing is permanently skipped.
 12418: // INVARIANT(S): only a clean (non-throwing) nodes() response is trusted as eviction evidence — a
 12419: // shopify-bridge error must leave the batch untouched, or an outage would misread the whole batch as
 12420: // deleted and mass-evict real orders from /orders. Mirrors the CONFIRMED-DELETE guard in GET /orders/:id.
 12421: let _reconcileOffset = 0;
 12422: async function reconcileOrderDeletions() {
 12423:   if (MOCK || !SHOPIFY_BEARER) return;
 12424:   const RECONCILE_BATCH = 25;
 12425:   const stats = getOrdersCacheStats();
 12426:   if (!stats?.total) return;
 12427:   const batch = getOrderShopifyIdsBatch(_reconcileOffset % stats.total, RECONCILE_BATCH);
 12428:   _reconcileOffset = (_reconcileOffset + batch.length) % stats.total;
 12429:   if (!batch.length) return;
 12430:   try {
 12431:     const result = await shopifyFetch(`query($ids:[ID!]!){ nodes(ids:$ids){ id } }`,
 12432:       { ids: batch.map(shopifyOrderGid) });
 12433:     const stillExists = new Set((result.data?.nodes || []).filter(Boolean).map(n => shopifyNumericId(n.id)));
 12434:     for (const shopifyId of batch) {
 12435:       if (!stillExists.has(shopifyId)) {
 12436:         deleteOrderFromCache(shopifyId);
 12437:         console.log('[reconcile] evicted deleted order from cache:', shopifyId);
 12438:       }
 12439:     }
 12440:   } catch (err) {
 12441:     console.error('[reconcile] order-existence check failed, batch left untouched:', err.message);
 12442:   }
 12443: }
 12444: 
 12445: // Activity-gated polling (was a flat 5-min interval). Syncs every ~3 min WHILE the
 12446: // dashboard is being used (fresher than before); zero Shopify calls when idle, and
 12447: // refreshes within ~60s when someone returns after an idle period.
 12448: // WHAT: activity-gated background scheduler — every 60s, if the dashboard is active and >=FRESH_TARGET_MS (~3min) since the last run, invokes syncRecentFromShopify then reconcileOrderDeletions; plus a daily GC of expired impersonation nonces.
 12449: // CHANGE-GUARD: the _syncing flag + _lastSyncAt guard prevent overlapping/over-frequent Shopify calls — don't remove them or an idle-return storm could hammer the API; dashboardActive() is the gate that makes it zero-cost when nobody is looking. reconcileOrderDeletions runs in the SAME gated tick (not its own interval) so it shares that throttling rather than adding a second independent source of Shopify calls.
 12450: // INVARIANT(S): never runs in MOCK (the whole block is !MOCK-gated); a thrown sync error is swallowed (catch{}) and _syncing is always reset in finally so a crash can't wedge the poller permanently; the nonce GC interval is 24h.
 12451: if (!MOCK) {
 12452:   const FRESH_TARGET_MS = 3 * 60 * 1000;
 12453:   let _syncing = false, _lastSyncAt = 0;
 12454:   setInterval(async () => {
 12455:     if (!dashboardActive()) return;            // quiet when nobody is looking
 12456:     if (_syncing || (Date.now() - _lastSyncAt) < FRESH_TARGET_MS) return;
 12457:     _syncing = true;
 12458:     try { await syncRecentFromShopify(); await reconcileOrderDeletions(); _lastSyncAt = Date.now(); }
 12459:     catch {} finally { _syncing = false; }
 12460:   }, 60 * 1000);
 12461:   // Daily GC for expired impersonation nonces
 12462:   setInterval(() => gcImpersonationNonces(), 24 * 60 * 60 * 1000);
 12463: }
 12464: 
 12465: // ── Phase 24E: Unified invoices page ──────────────────────────────────────────
 12466: 
 12467: // WHAT: GET /invoices — unified invoice list merging cache orders (getAllInvoicesForList), Xero invoice maps, and partial portal invoices, keyed by order number.
 12468: // CHANGE-GUARD: cross-references three sources by constructing `gid://shopify/Order/<shopify_id>` to match Xero/partial records — if any source switches between numeric ids and gids this join silently breaks; xeroSet is a Set of x.order_id for O(1) membership.
 12469: // INVARIANT(S): read-only aggregation; partialInvs is the subset of partials whose order_id matches this order's gid; hasXero/xero are derived purely from the gid join.
 12470: app.get('/invoices', requireAuth, (req, res) => {
 12471:   const partials  = getPartialInvoicesAll();
 12472:   const xeroMaps  = getXeroInvoiceMaps();
 12473:   const cacheOrds = getAllInvoicesForList();
 12474:   const xeroSet   = new Set(xeroMaps.map(x => x.order_id));
 12475: 
 12476:   const rows = cacheOrds.map(o => {
 12477:     const ordNum     = o.shopify_id;
 12478:     const hasXero    = xeroSet.has(`gid://shopify/Order/${ordNum}`);
 12479:     const xero       = hasXero ? xeroMaps.find(x => x.order_id === `gid://shopify/Order/${ordNum}`) : null;
 12480:     const partialInvs = partials.filter(p => p.order_id === `gid://shopify/Order/${ordNum}`);
 12481:     return `<tr>
 12482:       <td><a href="/orders/${h(ordNum)}" class="link">${h(o.name || `#${ordNum}`)}</a></td>
 12483:       <td>${o.customer_name ? `<a href="/customers/${h(o.customer_shopify_id)}" class="link">${h(o.customer_name)}</a>` : h(o.customer_email || '—')}</td>
 12484:       <td class="text-muted">${fmtDate(o.created_at ? new Date(o.created_at).toISOString() : null)}</td>
 12485:       ${/* cacheRowTotal: the frozen total_price overstates every edited order — this table is the
 12486:             one staff reconcile against Xero, so it is the worst place to show a stale amount. */''}
 12487:       <td class="text-right mono">${fmtMoney(cacheRowTotal(o))}</td>
 12488:       <td><span class="badge badge-${(o.financial_status||'').toLowerCase()}">${h(o.display_financial_status||o.financial_status||'—')}</span></td>
 12489:       <td>${hasXero ? `<span class="badge badge-success">Xero ✓</span> <small class="text-muted">${(xero?.xero_invoice_id||'').slice(0,8)}…</small>` : '<span class="badge badge-secondary">No Xero</span>'}</td>
 12490:       <td>${partialInvs.length ? partialInvs.map(p => `<a href="/orders/${h(ordNum)}/invoice?letter=${p.invoice_letter}" target="_blank" rel="noopener" class="link">#${ordNum}-${p.invoice_letter}</a>`).join(' ') : `<a href="/orders/${h(ordNum)}/invoice" target="_blank" rel="noopener" class="link btn btn-ghost btn-xs">PDF</a>`}</td>
 12491:     </tr>`;
 12492:   });
 12493: 
 12494:   const emptyState = cacheOrds.length === 0
 12495:     ? '<tr><td colspan="7" class="empty-state">No invoices cached yet. Run the backfill script to import order history.</td></tr>'
 12496:     : '';
 12497: 
 12498:   res.send(layout({ title: 'Invoices', session: req.adminSession, activePath: '/invoices', content: `
 12499:     <h1>Invoices</h1>
 12500:     <p class="text-muted">Unified view across all orders, Xero invoices, and partial invoices.</p>
 12501:     <div class="table-wrap">
 12502:       <table class="data-table" id="invoices-table">
 12503:         <thead><tr>
 12504:           <th>Order</th><th>Customer</th><th>Date</th>
 12505:           <th class="text-right">Total</th><th>Status</th><th>Xero</th><th>Invoice PDF</th>
 12506:         </tr></thead>
 12507:         <tbody>${rows.join('') || emptyState}</tbody>
 12508:       </table>
 12509:     </div>
 12510:   ` }));
 12511: });
 12512: 
 12513: // Static
 12514: app.use(express.static(path.join(__dirname, 'public')));
 12515: 
 12516: // fww-error-sink: error middleware must be LAST (after all routes + static)
 12517: app.use(expressErrorMiddleware());
 12518: 
 12519: app.listen(PORT, '127.0.0.1', () => {
 12520:   console.log(`fww-b2b-admin listening on http://127.0.0.1:${PORT} (MOCK=${MOCK})`);
 12521: });

### FILE test/orders-recent-sync.test.mjs
     1: // Standalone unit test (no server): incremental orders poller + REST status normalizer.
     2: // The poller lives behind `if (!MOCK)` in server.mjs, so the HTTP suite can never reach it.
     3: import { syncRecentOrders, normalizeRestFulfillmentStatus, SYNC_OVERLAP_MS } from '../lib/orders-recent-sync.mjs';
     4: 
     5: let passed = 0, failed = 0;
     6: async function test(name, fn) {
     7:   try { await fn(); console.log(`  ✓ ${name}`); passed++; } catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
     8: }
     9: function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(m || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
    10: 
    11: // Fake Shopify: `orders` sorted ascending by updatedAt, served in pages honouring `updated_at:>` and `after`.
    12: function fakeShopify(orders) {
    13:   const calls = [];
    14:   const fn = async (_q, { q, first, after }) => {
    15:     calls.push({ q, first, after });
    16:     const since = Date.parse(q.replace('updated_at:>', ''));
    17:     const rows = orders.filter(o => Date.parse(o.updatedAt) > since).sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    18:     const start = after ? Number(after) : 0;
    19:     const slice = rows.slice(start, start + first);
    20:     const end = start + slice.length;
    21:     return { data: { orders: { edges: slice.map(node => ({ node })), pageInfo: { hasNextPage: end < rows.length, endCursor: String(end) } } } };
    22:   };
    23:   fn.calls = calls;
    24:   return fn;
    25: }
    26: const mk = (n, iso) => ({ id: `gid://shopify/Order/${n}`, name: `#${n}`, updatedAt: iso, displayFulfillmentStatus: 'FULFILLED' });
    27: function harness(state) {
    28:   const h = { state, stored: [], writes: [] };
    29:   h.getState = () => h.state;
    30:   h.setState = (st) => { h.writes.push(st); if (st.lastSyncedAt != null) h.state = { last_synced_at: st.lastSyncedAt }; };
    31:   h.upsertNode = (n) => h.stored.push(n.name);
    32:   return h;
    33: }
    34: 
    35: console.log('\norders-recent-sync');
    36: 
    37: await test('pages past 50 — none of a 120-order burst is dropped (the original bug)', async () => {
    38:   const base = Date.parse('2026-10-02T10:00:00Z');
    39:   const orders = Array.from({ length: 120 }, (_, i) => mk(i, new Date(base + i * 1000).toISOString()));
    40:   const h = harness({ last_synced_at: base - 3600_000 });
    41:   const r = await syncRecentOrders({ shopifyFetch: fakeShopify(orders), ...h, getState: h.getState, setState: h.setState, upsertNode: h.upsertNode, now: () => base + 999_000 });
    42:   eq(h.stored.length, 120); eq(r.truncated, false);
    43:   eq(h.writes.at(-1).lastSyncedAt, base + 999_000, 'complete run advances to start time');
    44: });
    45: 
    46: await test('page cap hit — cursor resumes from newest stored row, NOT now, and next run finishes the rest', async () => {
    47:   const base = Date.parse('2026-10-02T10:00:00Z');
    48:   const orders = Array.from({ length: 120 }, (_, i) => mk(i, new Date(base + i * 60_000).toISOString()));
    49:   const h = harness({ last_synced_at: base - 3600_000 });
    50:   const f = fakeShopify(orders);
    51:   const run = (now) => syncRecentOrders({ shopifyFetch: f, getState: h.getState, setState: h.setState, upsertNode: h.upsertNode, now: () => now, pageLimit: 1, pageSize: 50 });
    52:   const r1 = await run(base + 10 * 3600_000);
    53:   eq(r1.truncated, true); eq(h.stored.length, 50);
    54:   eq(h.state.last_synced_at, Date.parse(orders[49].updatedAt), 'cursor = newest stored updatedAt');
    55:   await run(base + 10 * 3600_000); await run(base + 10 * 3600_000);
    56:   eq(new Set(h.stored).size, 120, 'every order eventually stored');
    57: });
    58: 
    59: await test('error mid-run — cursor does not advance, error is rethrown, lastError recorded', async () => {
    60:   const base = Date.parse('2026-10-02T10:00:00Z');
    61:   const h = harness({ last_synced_at: base - 5000 });
    62:   let n = 0;
    63:   const f = async () => { if (n++) throw new Error('bridge 502'); return { data: { orders: { edges: [{ node: mk(1, new Date(base).toISOString()) }], pageInfo: { hasNextPage: true, endCursor: 'x' } } } }; };
    64:   let threw = null;
    65:   try { await syncRecentOrders({ shopifyFetch: f, getState: h.getState, setState: h.setState, upsertNode: h.upsertNode, now: () => base + 99_000 }); } catch (e) { threw = e; }
    66:   eq(threw?.message, 'bridge 502');
    67:   eq(h.state.last_synced_at, base - 5000, 'cursor unchanged');
    68:   eq(h.writes.at(-1).lastError, 'bridge 502');
    69: });
    70: 
    71: await test('overlap — window starts SYNC_OVERLAP_MS before the stored cursor', async () => {
    72:   const h = harness({ last_synced_at: Date.parse('2026-10-02T10:00:00Z') });
    73:   const f = fakeShopify([]);
    74:   await syncRecentOrders({ shopifyFetch: f, ...h, getState: h.getState, setState: h.setState, upsertNode: h.upsertNode, now: () => Date.parse('2026-10-02T10:05:00Z') });
    75:   eq(f.calls[0].q, `updated_at:>${new Date(Date.parse('2026-10-02T10:00:00Z') - SYNC_OVERLAP_MS).toISOString()}`);
    76: });
    77: 
    78: await test('malformed response (no orders) throws instead of silently advancing', async () => {
    79:   const h = harness({ last_synced_at: 1000 });
    80:   let threw = false;
    81:   try { await syncRecentOrders({ shopifyFetch: async () => ({ data: {} }), getState: h.getState, setState: h.setState, upsertNode: h.upsertNode, now: () => 9e12 }); } catch { threw = true; }
    82:   eq(threw, true); eq(h.state.last_synced_at, 1000);
    83: });
    84: 
    85: await test('REST fulfillment status maps onto the GraphQL enum', () => {
    86:   eq(normalizeRestFulfillmentStatus(null), 'UNFULFILLED');
    87:   eq(normalizeRestFulfillmentStatus(undefined), 'UNFULFILLED');
    88:   eq(normalizeRestFulfillmentStatus('fulfilled'), 'FULFILLED');
    89:   eq(normalizeRestFulfillmentStatus('partial'), 'PARTIALLY_FULFILLED');
    90:   eq(normalizeRestFulfillmentStatus('restocked'), 'RESTOCKED');
    91: });
    92: 
    93: console.log(`\n${passed} passed, ${failed} failed`);
    94: process.exit(failed ? 1 : 0);

# REFERENCES TO CHANGED SYMBOLS OUTSIDE CHANGED FILES
### fakeShopify
test/order-money.test.mjs:35:function fakeShopify({ removeErrors = [], addErrors = [] } = {}) {
test/order-money.test.mjs:57:  const shopifyFetch = fakeShopify({ addErrors: [{ field: null, message: 'Discount cannot be applied to this line item.' }] });
test/order-money.test.mjs:72:  const shopifyFetch = fakeShopify({ removeErrors: [{ field: null, message: 'Discount not found.' }] });
test/order-money.test.mjs:81:  const shopifyFetch = fakeShopify();
test/order-money.test.mjs:93:  const shopifyFetch = fakeShopify();
test/order-money.test.mjs:100:  const shopifyFetch = fakeShopify();

### UPDATED_AT
scripts/backfill-shopify.mjs:155:          customers(first:$first,after:$after,query:$q,sortKey:UPDATED_AT,reverse:true){
scripts/backfill-shopify.mjs:258:          orders(first:$first,after:$after,query:$q,sortKey:UPDATED_AT,reverse:true){
scripts/backfill-shopify.mjs:337:          products(first:$first,after:$after,query:$q,sortKey:UPDATED_AT,reverse:true){

### FULFILLED
test/list-truncation.test.mjs:55:    fulfillment_status: 'FULFILLED',
test/order-cache-integrity.test.mjs:110:  assertEqual(row.fulfillment_status, 'FULFILLED');

### INVARIANT
CLAUDE.md:37:- Non-trivial functions carry `// WHAT:` / `// CHANGE-GUARD:` / `// INVARIANT(S):` headers. Match it.
db.mjs:502:// INVARIANT(S): one row per Shopify order gid.
db.mjs:510:// INVARIANT(S): INSERT OR IGNORE plus the primary key makes concurrent double-submit single-winner.
db.mjs:525:// INVARIANT(S): callers must retain the claim for every ambiguous mutating outcome.
db.mjs:532:// INVARIANT(S): caller supplies a validated Helcim invoiceId, token, URL, positive amount, and USD/CAD currency.
db.mjs:555:// INVARIANT(S): does not alter invoice identity, amount, token, or URL.
db.mjs:673:// INVARIANT(S): pure function, no I/O; returns {city, state, postal_code} with null for any field it
db.mjs:689:// INVARIANT(S): pure, no I/O. Returns nulls for anything it cannot identify with confidence — a
db.mjs:720:// INVARIANT(S): `leads.email` is UNIQUE, so a duplicate application (the portal has no unique
db.mjs:744:    // address (see INVARIANT above). Only the first portal row to link wins; once
db.mjs:803:// INVARIANT(S): strips + - ( ) space and . only — it never strips digits, so it cannot make two
db.mjs:812:// INVARIANT(S): every user-controlled value is bound with ?, never interpolated. The phone clause is
db.mjs:838:// INVARIANT(S): still returns a plain ARRAY (six call sites in test/leads-ingest.test.mjs index it
db.mjs:851:// INVARIANT(S): shares buildLeadsWhere with getLeads (see its CHANGE-GUARD) so the count always
db.mjs:930:// INVARIANT(S): the status list must match the financial_status strings Shopify actually returns; total is ROUND()ed to 2dp; cancelled orders must be excluded.
db.mjs:1031:// INVARIANT(S): a nonce must be redeemable at most once; expiry (expires_at) and used_at are both hard gates; gcImpersonationNonces prunes rows older than 2h independently.
db.mjs:1084:// INVARIANT(S): pure reads, no writes. Every table access is wrapped so a missing table
db.mjs:1142:// INVARIANT(S): never returns 0/NaN/negative (that would make LIMIT limit+1 return a single row and
db.mjs:1154:// INVARIANT(S): non-enumerable on purpose — map/filter/JSON.stringify consumers stay unaffected.
db.mjs:1190:// INVARIANT(S): return value is still a plain Array of the same row shape — `truncated` is extra,
db.mjs:1240:// INVARIANT(S): the is_b2b=1 join is the B2B scoping guarantee — never widen it without an explicit segment flag; status buckets must mirror FINANCIAL_STATUS_FILTER in server.mjs; q is parameterized (no injection) but the LIKE has no escaping of %/_ .
db.mjs:1316:// INVARIANT(S): offset wraps modulo the current total in the caller — this function just slices.
db.mjs:1396:// INVARIANT(S): is_fww_vendor is derived from vendor === 'Fuzzywumpets' (string-literal coupling shared with the backfill scripts); quantity/price default to 0; taxable normalized to 0/1.
db.mjs:1427:// INVARIANT(S): scoped to one shopify_id; leaves audit_log, xero_invoice_map, and partial-invoice
db.mjs:1501:// INVARIANT(S): last_error_at only advances when last_error is non-null; lastSyncedAt defaults to now(); the 'orders_recent' resource row is owned by the live poller, distinct from the backfill 'orders' row.
db.mjs:1543:// INVARIANT(S): the month grid is pre-seeded for all 12 months so gaps render as zero; revenue uses total_price (order-level) for customers/totals but price*quantity (line-level) for products — these two bases can legitimately differ.
desktop/lib/pdf-headers.js:41:// INVARIANT(S): returns null (not a copy) whenever nothing should change, so the caller can pass a
desktop/lib/unload-prompt.js:20:// INVARIANT(S): "Stay" is both defaultId and cancelId, so Esc / the window's X / any dialog error
desktop/main.js:41:// INVARIANT(S): never throws on a malformed URL; a non-https scheme (file:, data:,
desktop/main.js:116:// INVARIANT(S): never returns an empty name — a blank suggestion is what let the OS dialog open

### function
ADVERSARIAL_AUDIT_2026-07-02.md:42:### 5. Broken webhook auth — HMAC computed over re-serialized body  · HIGH (functional) · **LIVE**
APIWATCH_NOTES.md:7:Shopify JS Buy SDK is deprecated as of January 2025 and will stop functioning after July 1st, 2025 (hard deadline). The fww-b2b-admin project shares a Shopify backend via shopify-bridge; if that bridge uses JS Buy SDK, purchases will fail post-deadline. Immediate audit of shopify-bridge implementation required.
CLAUDE.md:37:- Non-trivial functions carry `// WHAT:` / `// CHANGE-GUARD:` / `// INVARIANT(S):` headers. Match it.
HANDOFF.md:309:export async function renderLabelSheet({ template, items, options }) {
HANDOFF.md:315:export async function barcodePng(code, opts={}) {
HANDOFF.md:679:- Update label rendering function to take a `fields` object: `{ productName, variantName, msrp, sku, upc_barcode, upc_digits }` (all booleans).
HANDOFF.md:2563:export async function resolveXeroContact(shopifyCustomerId) { ... }
HANDOFF.md:2570:export async function syncCustomerToXero(shopifyCustomerId, customerData) { ... }
HANDOFF.md:2575:export function isInsider(shopifyCustomerId) {
HANDOFF.md:2709:- `lib/xero-customer-sync.mjs` exports the 3 functions; full test coverage
HANDOFF.md:2952:function activityMiddleware(req, res, next) {
HANDOFF.md:3034:function purgeOldActivity() {
SCRATCH.md:228:- Audit log: `auditTargetLink()` function parses GID (`gid://shopify/Order/X` → `/orders/X`, Customer same)
STATUS.md:12:  sync_state, products_cache) with indexes + 14 helper functions
db.mjs:446:export function createSession(sid, email, displayName, picture) {
db.mjs:455:export function getSession(sid) {
db.mjs:466:export function deleteSession(sid) {
db.mjs:470:export function auditLog(email, action, target, before, after) {
db.mjs:503:export function getHelcimInvoiceMap(orderId) {
db.mjs:511:export function claimHelcimInvoiceCreation(orderId, { invoiceNumber, amountCents, currency }) {
db.mjs:526:export function releaseHelcimInvoiceClaim(orderId) {
db.mjs:533:export function upsertHelcimInvoiceMap(orderId, invoice) {
db.mjs:556:export function setHelcimInvoiceDelivery(orderId, status, error = null) {
db.mjs:563:export function getCustomerNotes(customerId) {
db.mjs:567:export function setCustomerNotes(customerId, body, email) {
db.mjs:575:export function getOrderInternalNote(orderId) {
db.mjs:578:export function setOrderInternalNote(orderId, body, email) {
db.mjs:585:export function getDropshipCache(customerId) {
db.mjs:589:export function setDropshipCache(customerId, enabled, marginPct) {
db.mjs:596:export function getSetting(key, email = '__global__') {

### DEPENDS
.github/workflows/desktop-build.yml:4:# DEPENDS: desktop/package.json's build.publish block — electron-builder bakes that
CLAUDE.md:38:- Mark real coupling with `// DEPENDS:` or `// SYNC:` in the same change that creates it.
HANDOFF.md:3372:Phase 24 also DEPENDS on:
db.mjs:22:  // DEPENDS: test/test-session-guard.test.mjs sets this; do not remove without updating that suite.
db.mjs:65:  -- DEPENDS: server.mjs POST /orders/:id/send-credit-card-invoice uses this as the retry ledger.
db.mjs:81:  -- DEPENDS: server.mjs acquires this before the non-idempotent Helcim Invoice API POST.
db.mjs:869:// DEPENDS: /leads/:id/edit and /leads/new (server.mjs) both write through this allow-list -- any
db.mjs:1152:// DEPENDS: server.mjs getOrdersData/getCustomersData read `.truncated` off these arrays to decide
db.mjs:1346:// DEPENDS: readers that lowercase for display (order badge class in server.mjs) normalize on read
db.mjs:1393:// DEPENDS: callers must pass the COMPLETE current line set for the order, never a partial batch —
db.mjs:1593:  // DEPENDS: scripts/backfill-orders-per-customer.mjs and scripts/backfill-shopify.mjs must keep
desktop/main.js:34:// DEPENDS: isAdminPdfUrl() and both navigation interceptors gate on this.
desktop/main.js:166:  // DEPENDS: must run BEFORE createMainWindow() — the handler has to be attached to the partition
desktop/main.js:330:  // DEPENDS: server-rendered pages register the beforeunload guards this answers — the order-detail
desktop/main.js:376:// DEPENDS: the update-not-available / error handlers below, which stay silent for the
docs/HANDOFF-2026-08-11-lead-fields.md:169:- Mark real coupling with `// DEPENDS:` / `// SYNC:` comments in the same change that creates it.
helcim.mjs:36:  // DEPENDS: docs/B2B-ARCHITECTURE.md documents these exact Doppler keys.
helcim.mjs:144:    // DEPENDS: Portal's public HelcimPay session links the payment to this exact invoice number.
lib/helcim-invoice-message.mjs:2:// DEPENDS: fww-b2b-portal PR #42 accepts `subject` plus the exact optional
lib/list-truncation.mjs:11:// DEPENDS: db.mjs listOrdersFromCache default limit + server.mjs getOrdersData reporting.
lib/list-truncation.mjs:13:// DEPENDS: db.mjs listCustomersFromCache default limit + server.mjs getCustomersData reporting.
lib/list-truncation.mjs:16:// DEPENDS: db.mjs getLeads() default limit + the GET /leads route's truncation reporting.
lib/order-money.mjs:15: * DEPENDS: POST /orders/:id/edit in server.mjs rejects the whole batch when `invalid` is non-empty.
lib/order-money.mjs:40: * DEPENDS: callers must run this BEFORE orderEditCommit and must let the throw propagate past the
lib/order-money.mjs:107: * DEPENDS: POST /orders/bulk in server.mjs audit-logs 'mark_paid' ONLY for ids in `paid` and
lib/shopify-user-errors.mjs:6:// DEPENDS: server.mjs order-edit handlers import assertNoUserErrors — it must keep throwing
pdf.mjs:49:// DEPENDS: lineItemTrueTotal below — the only reason this exists; do not "simplify" those guards
public/admin.css:460:  /* DEPENDS: server.mjs layout() renders the mobile menu from the same navItems array as .header-nav. */
scripts/backfill-orders-per-customer.mjs:124:          // DEPENDS: db.mjs getReportsFromCache subtracts this column from SUM(price*quantity).
scripts/backfill-shopify.mjs:237:      // DEPENDS: db.mjs getReportsFromCache subtracts this column from SUM(price*quantity).

### PARTIAL
HANDOFF.md:1462:  - no fulfillment + financialStatus PAID (or PARTIALLY_PAID) → "In process"
db.mjs:928:// WHAT: sums each order's CURRENT total for a customer across PENDING/PARTIALLY_PAID/UNPAID, non-cancelled orders (the customer-detail outstanding-balance widget).
db.mjs:933:    'SELECT ROUND(SUM(COALESCE(current_total, total_price)), 2) AS total, COUNT(*) AS count FROM orders_cache WHERE customer_shopify_id = ? AND cancelled_at IS NULL AND financial_status IN (\'PENDING\',\'PARTIALLY_PAID\',\'UNPAID\')'
db.mjs:1251:    where.push("(o.financial_status IN ('PENDING','AUTHORIZED','PARTIALLY_PAID','UNPAID') OR o.financial_status IS NULL)");
db.mjs:1257:    where.push("o.financial_status IN ('REFUNDED','PARTIALLY_REFUNDED')");
db.mjs:1342:// PENDING/PARTIALLY_PAID/UNPAID sum (~line 686). The GraphQL sync paths feed displayFinancialStatus
test/order-cache-integrity.test.mjs:134:    financial_status: 'PARTIALLY_REFUNDED',
test/order-cache-integrity.test.mjs:136:  assertEqual(getOrderFromCache('7400').financial_status, 'PARTIALLY_REFUNDED');

### harness
ADVERSARIAL_AUDIT_2026-07-02.md:15:3. **On-screen dynamic** — real headless-Chromium (Playwright) harness against a MOCK server, seeding payloads through the app's own write endpoints.

### hasNext
SCRATCH.md:62:    pageInfo { hasNextPage }
SCRATCH.md:486:    pageInfo{hasNextPage endCursor}
SCRATCH.md:576:    pageInfo { hasNextPage endCursor }
SCRATCH.md:598:    pageInfo { hasNextPage endCursor }
lib/dashboard-paging.mjs:22:      `query($q:String!,$after:String){orders(first:${DASHBOARD_ORDER_PAGE},query:$q,after:$after,sortKey:PROCESSED_AT,reverse:true){edges{node{id name processedAt customer{id displayName email} displayFinancialStatus totalPriceSet{presentmentMoney{amount currencyCode}} currentTotalPriceSet{presentmentMoney{amount currencyCode}} tags}}pageInfo{hasNextPage endCursor}}}`,
lib/dashboard-paging.mjs:28:    if (!conn.pageInfo?.hasNextPage) return orders;
lib/dashboard-paging.mjs:29:    if (!conn.pageInfo.endCursor) throw new Error('dashboard orders hasNextPage without cursor');
lib/dashboard-paging.mjs:40:      `query($after:String,$pub:ID!){products(first:${DASHBOARD_PRODUCT_PAGE},after:$after,query:"published_status:published"){edges{node{id title publishedOnPublication(publicationId:$pub) variants(first:${DASHBOARD_VARIANT_PAGE}){pageInfo{hasNextPage endCursor}edges{node{sku title inventoryQuantity}}}}}pageInfo{hasNextPage endCursor}}}`,
lib/dashboard-paging.mjs:61:    if (!conn.pageInfo?.hasNextPage) return items;
lib/dashboard-paging.mjs:62:    if (!conn.pageInfo.endCursor) throw new Error('dashboard products hasNextPage without cursor');
lib/dashboard-paging.mjs:71:  while (info?.hasNextPage) {
lib/dashboard-paging.mjs:74:      `query($id:ID!,$after:String){product(id:$id){variants(first:${DASHBOARD_VARIANT_PAGE},after:$after){pageInfo{hasNextPage endCursor}edges{node{sku title inventoryQuantity}}}}}`,
lib/dashboard-paging.mjs:90:      `query($id:ID!,$q:String!,$after:String){customer(id:$id){amountSpent{amount currencyCode} numberOfOrders orders(first:${DASHBOARD_ORDER_PAGE},query:$q,after:$after,sortKey:PROCESSED_AT,reverse:true){edges{node{id name processedAt displayFinancialStatus displayFulfillmentStatus totalPriceSet{presentmentMoney{amount currencyCode}} currentTotalPriceSet{presentmentMoney{amount currencyCode}}}}pageInfo{hasNextPage endCursor}}}}`,
lib/dashboard-paging.mjs:96:    if (!customer.orders?.pageInfo?.hasNextPage) {
lib/dashboard-paging.mjs:99:    if (!customer.orders.pageInfo.endCursor) throw new Error('customer spend orders hasNextPage without cursor');
lib/fulfillment-order-paging.mjs:24:      `query($id:ID!,$after:String){order(id:$id){fulfillmentOrders(first:${FO_PAGE_MAX},after:$after){pageInfo{hasNextPage endCursor}edges{node{id status lineItems(first:${FO_LINE_PAGE_MAX}){pageInfo{hasNextPage endCursor}edges{node{${FO_LINE_FIELDS}}}}}}}}}`,
lib/fulfillment-order-paging.mjs:30:    if (!conn.pageInfo?.hasNextPage) {
lib/fulfillment-order-paging.mjs:34:    if (!conn.pageInfo.endCursor) throw new Error('fulfillmentOrders hasNextPage without cursor');
lib/fulfillment-order-paging.mjs:43:        `query($id:ID!,$after:String){fulfillmentOrder(id:$id){lineItems(first:${FO_LINE_PAGE_MAX},after:$after){pageInfo{hasNextPage endCursor}edges{node{${FO_LINE_FIELDS}}}}}}`,
lib/line-item-paging.mjs:32:  for (let page = 0; info && info.hasNextPage; page++) {
scripts/backfill-current-totals.mjs:49:      pageInfo{hasNextPage endCursor}
scripts/backfill-current-totals.mjs:64:let after = null, hasNext = true;
scripts/backfill-current-totals.mjs:67:while (hasNext) {
scripts/backfill-current-totals.mjs:93:  hasNext = conn?.pageInfo?.hasNextPage || false;
scripts/backfill-orders-per-customer.mjs:50:          pageInfo{hasNextPage endCursor}
scripts/backfill-orders-per-customer.mjs:137:    if (!orders.pageInfo.hasNextPage) break;
scripts/backfill-shopify.mjs:76:// CHANGE-GUARD: the while(hasNext) loop has NO page cap and no rate-limit backoff — a full --full sync of all orders/products will run until the connection is exhausted and can hit Shopify cost limits; re-test --since/--full resume after changing queryFn.
scripts/backfill-shopify.mjs:86:  let hasNext = true;
scripts/backfill-shopify.mjs:88:  while (hasNext) {
scripts/backfill-shopify.mjs:99:    hasNext = pageInfo.hasNextPage;

### cursor
.playwright-mcp/page-2026-05-26T19-19-55-200Z.yml:6:  - link "Sign in with Google" [ref=e7] [cursor=pointer]:
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:4:      - link "FW admin" [ref=e4] [cursor=pointer]:
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:9:        - link "Dashboard" [ref=e8] [cursor=pointer]:
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:11:        - link "Orders" [ref=e9] [cursor=pointer]:
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:13:        - link "Customers" [ref=e10] [cursor=pointer]:
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:15:        - link "Catalog" [ref=e11] [cursor=pointer]:
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:17:        - link "Reports" [ref=e12] [cursor=pointer]:
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:19:        - link "Settings" [ref=e13] [cursor=pointer]:
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:23:        - link "Sign out" [ref=e16] [cursor=pointer]:
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:33:          - link "View all →" [ref=e25] [cursor=pointer]:
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:47:                - link "#1001" [ref=e38] [cursor=pointer]:
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:55:                - link "#1002" [ref=e45] [cursor=pointer]:
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:63:                - link "#1003" [ref=e52] [cursor=pointer]:
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:72:          - link "View →" [ref=e60] [cursor=pointer]:
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:79:          - link "View all →" [ref=e66] [cursor=pointer]:
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:89:                - link "Acme Pet Supply" [ref=e75] [cursor=pointer]:
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:95:                - link "Happy Paws Boutique" [ref=e80] [cursor=pointer]:
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:101:                - link "Doggo Depot" [ref=e85] [cursor=pointer]:
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:107:                - link "Pet Paradise" [ref=e90] [cursor=pointer]:
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:113:                - link "Paw Central" [ref=e95] [cursor=pointer]:
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:120:          - link "Catalog →" [ref=e101] [cursor=pointer]:
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:131:                - link "Elite Collar (Small)" [ref=e111] [cursor=pointer]:
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:138:                - link "Luxe Leash" [ref=e117] [cursor=pointer]:
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:144:                - link "Simplicity Collar" [ref=e122] [cursor=pointer]:
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:151:                - link "Everyday Collar Bundle" [ref=e128] [cursor=pointer]:
HANDOFF.md:723:- Pagination stays 50/page; cursor-based against Shopify.
HANDOFF.md:3262:  last_cursor TEXT,                           -- Shopify GraphQL cursor for resumable pagination
HANDOFF.md:3281:- Paginate Shopify GraphQL `customers(first: 250, after: cursor)` until done
HANDOFF.md:3288:- For each B2B customer, paginate `customer.orders(first: 250, after: cursor)` until done
SCRATCH.md:55:    edges { cursor node {

### orders
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:12:          - /url: /orders
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:34:            - /url: /orders?status=open
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:48:                  - /url: /orders/gid%3A%2F%2Fshopify%2FOrder%2F1001
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:56:                  - /url: /orders/gid%3A%2F%2Fshopify%2FOrder%2F1002
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:64:                  - /url: /orders/gid%3A%2F%2Fshopify%2FOrder%2F1003
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:73:            - /url: /orders?date=7d
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:75:        - paragraph [ref=e62]: B2B orders in last 7 days
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:93:            - row "Happy Paws Boutique orders@happypaws.com $2,890.00" [ref=e78]:
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:94:              - cell "Happy Paws Boutique orders@happypaws.com" [ref=e79]:
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:97:                - generic [ref=e81]: orders@happypaws.com
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:111:            - row "Paw Central orders@pawcentral.com $890.00" [ref=e93]:
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:112:              - cell "Paw Central orders@pawcentral.com" [ref=e94]:
.playwright-mcp/page-2026-05-26T19-20-12-868Z.yml:115:                - generic [ref=e96]: orders@pawcentral.com
ADVERSARIAL_AUDIT_2026-07-02.md:24:### 1. Stored XSS — `/orders/new?customer=` prefill JSON  · CRITICAL · CODE
ADVERSARIAL_AUDIT_2026-07-02.md:30:**Reproduced this session:** seeded title `zzz');window.__xss_onclick=1;//` via `POST /orders/1001/line/custom`; on `/orders/1001` the rendered handler was
ALEXA_DECISIONS_PENDING.md:77:  Shopify locks orders with existing discounts against additional orderEditAddLineItemDiscount calls on those lines.
ALEXA_DECISIONS_PENDING.md:79:- **Verdict:** Cannot apply post-order discounts via Shopify Admin API on B2B-discounted orders. This is a Shopify platform constraint.
ALEXA_DECISIONS_PENDING.md:90:- Fix path: investigate Shopify behavior on unpaid draft-completed orders + maybe require Mark Paid before edit + remove line
ALEXA_DECISIONS_PENDING.md:91:- Severity: low — qty changes still work fine; only line removal on unpaid orders is the issue
APIWATCH_NOTES.md:44:fww-b2b-admin queries the Shopify Customer Account API (via shopify-bridge) to fetch customer orders and details. Starting 2024-08-26, this API now requires Level 1 Protected Customer Data access. If the bridge does not hold this certification, queries will fail and break the backfill and dashboard order-fetching workflows.
APIWATCH_NOTES.md:50:3. Test backfill-orders-per-customer.mjs and backfill-shopify.mjs against production Shopify to confirm access is granted.
APIWATCH_NOTES.md:63:Audit backfill-shopify.mjs and backfill-orders-per-customer.mjs to confirm neither queries fulfillmentService, harmonizedSystemCode, inventoryManagement, requiresShipping, weight, or weightUnit directly. If they do, remove those fields from GraphQL queries and update any downstream code that processes them. Verify the Shopify Bridge (shopify-bridge.alex-037.workers.dev) is updated to target API v2024-07 or later.
HANDOFF.md:19:- See open B2B orders → mark paid → invoice resent
HANDOFF.md:73:  `/home/alexa/projects/fww-b2b-portal/data/portal.db` with tables: sessions, carts, orders_log,
HANDOFF.md:89:   delete products, archive products, delete customers, delete orders, modify product prices.
HANDOFF.md:102:4. **Dashboard /**: after login, show widgets — open B2B orders count, this-week count,
HANDOFF.md:110:## Phase 2 — orders + customers (deeper than what's in b2b-portal /admin)
HANDOFF.md:112:6. **Orders /orders**: list all B2B portal orders (orders tagged b2b-portal in Shopify), filters
HANDOFF.md:115:7. **Order detail /orders/:id**: full Shopify order, line items, customer info, status timeline
HANDOFF.md:122:   lifetime spend, recent orders (last 10), internal notes (customer_notes SQLite table),

### passed
HANDOFF.md:3414:  in the Shopify GraphQL query. Default behavior unless `--all-vendors` flag explicitly passed.
SCRATCH.md:350:- In run-tests.sh: B2B_PORTAL_INTERNAL_TOKEN=test-internal-token-mock; passed to test as INTERNAL_TOKEN
db.mjs:926:// HISTORY (2026-08-28): this widget rendered $0 for EVERY customer for as long as the CHANGE-GUARD below had described why — renderCustomerDetail passed the GID. The call site now passes shopifyNumericId(customer.id). Until that was fixed the COALESCE above was inert here: a query returning no rows cannot sum the wrong column either.
desktop/tools/verify-package.js:10://   pipeline noticed: the build succeeded, the unit tests passed (they import from the REPO, which
pdf.mjs:304:    // (order_internal_notes table) is separate and is NOT passed to the PDF.
test/admin-allowlist.test.mjs:33:let passed = 0, failed = 0;
test/admin-allowlist.test.mjs:35:  try { fn(); console.log(`  ✓ ${name}`); passed++; }
test/admin-allowlist.test.mjs:106:console.log(`\n  ${passed} passed, ${failed} failed\n`);
test/api.test.mjs:11:let passed = 0;
test/api.test.mjs:18:    passed++;
test/api.test.mjs:817:// 422'd on every call in production while these tests passed against a mock that faked it.
test/api.test.mjs:2307:  // "...refine the filters of 342 matching". A substring check for 'showing the first' passed on
test/api.test.mjs:3684:console.log(`\n  ${passed} passed, ${failed} failed`);
test/dashboard-paging.test.mjs:9:let passed = 0, failed = 0;
test/dashboard-paging.test.mjs:11:  try { await fn(); console.log(`  \u2713 ${name}`); passed++; }
test/dashboard-paging.test.mjs:84:console.log(`\n${passed} passed, ${failed} failed`);
test/desktop-packaging.test.mjs:20:let passed = 0, failed = 0;
test/desktop-packaging.test.mjs:22:  try { fn(); console.log(`  ✓ ${name}`); passed++; }
test/desktop-packaging.test.mjs:92:console.log(`\n  ${passed} passed, ${failed} failed\n`);
test/desktop-pdf-headers.test.mjs:12:let passed = 0, failed = 0;
test/desktop-pdf-headers.test.mjs:14:  try { fn(); console.log(`  ✓ ${name}`); passed++; }
test/desktop-pdf-headers.test.mjs:86:console.log(`\n  ${passed} passed, ${failed} failed\n`);
test/fulfillment-order-paging.test.mjs:5:let passed = 0, failed = 0;
test/fulfillment-order-paging.test.mjs:7:  try { await fn(); console.log(`  \u2713 ${name}`); passed++; }
test/fulfillment-order-paging.test.mjs:90:console.log(`\n${passed} passed, ${failed} failed`);
test/helcim-payload.test.mjs:148:else console.log(`\n${tests.length} Helcim payload tests passed`);
test/helcim.test.mjs:116:else console.log(`\n${tests.length} Helcim tests passed`);
test/leads-ingest.test.mjs:16:let passed = 0, failed = 0;
test/leads-ingest.test.mjs:18:  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
test/leads-ingest.test.mjs:291:console.log(`\n  ${passed} passed, ${failed} failed`);

### synced
ADVERSARIAL_AUDIT_2026-07-02.md:39:`server.mjs:4229` & `4233`: `'…<span…>'+d.xeroName+'</span>'` → `el.innerHTML`. `d.xeroName` is the Xero contact name, synced from the Shopify customer/company name (attacker-controlled). Fires on `/customers/:id` load once the xero-status fetch resolves.
HANDOFF.md:2651:- ⚠ **Not synced yet** (yellow) — has `b2b` tag but no Xero match; show "Sync now" button
HANDOFF.md:2680:"Not synced".
HANDOFF.md:2711:- Customer detail page shows clear "Synced with Xero" / "Not synced" / "Insider" badge
HANDOFF.md:3189:  synced_at INTEGER NOT NULL                 -- our local sync timestamp
HANDOFF.md:3228:  synced_at INTEGER NOT NULL,
HANDOFF.md:3251:  synced_at INTEGER NOT NULL,
HANDOFF.md:3261:  last_synced_at INTEGER NOT NULL,
HANDOFF.md:3263:  total_synced INTEGER,
HANDOFF.md:3332:- Header shows "Last synced: 2 min ago · [Sync now]" with manual refresh button
HANDOFF.md:3434:    synced_at INTEGER NOT NULL
SCRATCH.md:208:1. mark-paid: async non-blocking → createXeroInvoice (if not synced) → recordXeroPayment
db.mjs:214:    synced_at INTEGER,
db.mjs:274:    synced_at INTEGER NOT NULL
db.mjs:312:    synced_at INTEGER NOT NULL
db.mjs:334:    synced_at INTEGER NOT NULL
db.mjs:342:    last_synced_at INTEGER NOT NULL,
db.mjs:344:    total_synced INTEGER,
db.mjs:363:    synced_at INTEGER NOT NULL
db.mjs:373:// renderOrdersList falls back to the frozen total — so un-resynced and never-edited orders are unaffected.
db.mjs:398:// product revenue by the number of times each order had been synced. The code fix stops new
db.mjs:401://      one call with the same synced_at, so MAX(synced_at) per order IS the last complete write. This
db.mjs:416:        WHERE synced_at < (
db.mjs:417:          SELECT MAX(x.synced_at) FROM order_line_items_cache x
db.mjs:426:      db.prepare('INSERT INTO sync_state (resource, last_synced_at) VALUES (?, ?)').run(MARKER, Date.now());
db.mjs:574:// Order-level INTERNAL note (staff-only) — never synced to Shopify, never on the invoice.
db.mjs:925:// CURRENT-TOTALS (2026-08-28): COALESCE(current_total, total_price), not total_price. total_price is FROZEN at the pre-edit amount, so every edited order inflated this widget — #38953 alone by $302 after it was edited down to $4,469.82. COALESCE (not `||`/OR) because a fully-removed order's current total is legitimately 0 and must stay 0; only NULL — an un-resynced or pre-migration row — may fall back to the frozen value.
db.mjs:986:    INSERT OR REPLACE INTO xero_invoice_map (order_id, xero_invoice_id, xero_contact_id, status, synced_at, error_text)
db.mjs:1017:  return db.prepare('SELECT * FROM xero_invoice_map ORDER BY synced_at DESC LIMIT ?').all(limit);
db.mjs:1166:     created_at, updated_at, synced_at)

### EVERY
HANDOFF.md:2949:Express middleware in `fww-b2b-portal/server.mjs` runs on EVERY request after auth:
QA_ADMIN_FINDINGS.md:4:- A1 (CRITICAL) admin /orders/new discount decimals -- appliedDiscount PERCENTAGE computed with .toFixed(4); Shopify rejects >2 decimals, so EVERY discounted (B2B-priced) manual order returned 400 ("Applied discount value can have at most 2 digits after decimal point"). Manual B2B order creation was fully broken. Fix: .toFixed(4) -> .toFixed(2). Verified: #37073 created, line shows orig $83.99 / discounted $42.01. STATUS: DEPLOYED to prod admin 2026-05-29 (fww-b2b-admin restarted, pid 263849, HTTP 302 healthy); committed+pushed on apiwatch/entry-783. TODO(hygiene): merge entry-783 -> master at next apiwatch reconciliation (real mainline is 'master' [Task#48]; origin/main is stale at Task#45).
db.mjs:926:// HISTORY (2026-08-28): this widget rendered $0 for EVERY customer for as long as the CHANGE-GUARD below had described why — renderCustomerDetail passed the GID. The call site now passes shopifyNumericId(customer.id). Until that was fixed the COALESCE above was inert here: a query returning no rows cannot sum the wrong column either.
lib/line-item-paging.mjs:16:// INVARIANT(S): the caller gets EVERY line or an exception — never a silent prefix. That is the
lib/order-money.mjs:16: * The edit-mode UI submits a price input for EVERY line, so a field the operator cleared arrives as
test/leads-ingest.test.mjs:123:// Regression: /leads calls this sync on EVERY render. Before this fix, a second (or later)

### QUERY
lib/order-display-totals.mjs:45:// CHANGE-GUARD: the caller's QUERY must select currentTotalPriceSet. This function cannot tell
scripts/backfill-current-totals.mjs:41:const QUERY = `
scripts/backfill-current-totals.mjs:68:  const json = await shopifyFetch(QUERY, { first: 250, after });
test/order-display-totals.test.mjs:212:// ── an accessor can only prefer a value the QUERY actually fetched ───────────

### after
.github/workflows/desktop-build.yml:67:      # check placed after it gates nothing; the broken artifact is already live and auto-updating.
.github/workflows/desktop-build.yml:73:      #   Do not "simplify" by verifying dist/ after `npm run dist` — that is the no-op this exists
ADVERSARIAL_AUDIT_2026-07-02.md:16:4. **Baseline** — `./run-tests.sh` = **81/81 green** before/after; no regressions introduced (audit was read-only + MOCK).
ALEXA_DECISIONS_PENDING.md:5:- Root cause: loop.sh inlined `$(cat HANDOFF.md)` as a CLI arg; HANDOFF.md grew to 158KB after Phase 19/19E/20/21/22/23 appends, exceeding Linux's 128KB per-argument limit (MAX_ARG_STRLEN)
ALEXA_DECISIONS_PENDING.md:15:## 2026-05-27 00:25 UTC — Loop died mid-iter 2 (after Phase 22 shipped)
ALEXA_DECISIONS_PENDING.md:23:- Agent set STATE: DONE after Iter 3 shipped 15B + 19D
ALEXA_DECISIONS_PENDING.md:30:- Root cause: `orderEditSetQuantity` requires the CalculatedLineItem GID (from `calculatedOrder.lineItems` after `orderEditBegin`), NOT the original LineItem GID
ALEXA_DECISIONS_PENDING.md:33:- **Fix:** after orderEditBegin, fetch `calculatedOrder.lineItems` and map old→new IDs by matching variant/sku/title, then use the new IDs in setQuantity calls
ALEXA_DECISIONS_PENDING.md:88:- Order goes into VOIDED state after the commit attempt (a void transaction is added)
APIWATCH_NOTES.md:7:Shopify JS Buy SDK is deprecated as of January 2025 and will stop functioning after July 1st, 2025 (hard deadline). The fww-b2b-admin project shares a Shopify backend via shopify-bridge; if that bridge uses JS Buy SDK, purchases will fail post-deadline. Immediate audit of shopify-bridge implementation required.
HANDOFF.md:78:    - admin_audit_log (id, email, action, target, before, after, ts)
HANDOFF.md:102:4. **Dashboard /**: after login, show widgets — open B2B orders count, this-week count,
HANDOFF.md:187:Maintain `STATUS.md` continuously. **Update after every commit.** Schema:
HANDOFF.md:238:## Phase 5 — UPC Barcode Label Engine (build after Phase 3; can be parallel with Phase 4)
HANDOFF.md:363:- UI: navigate /labels → form renders, preview button works after picking products
HANDOFF.md:373:## Phase 6 — Product CSV + Image Exports (build after Phase 5; can be parallel)
HANDOFF.md:548:  `metafieldDelete` to clear), then audit-logs the change with before+after values.
HANDOFF.md:579:- Audit log row created with before+after
HANDOFF.md:795:"Save" button at the bottom of the section. Audit-log on save with full before/after.
HANDOFF.md:893:to a small spec the agent can implement once alexa decides which to ship and after she's set up
HANDOFF.md:948:- Most-recognized button after digital wallets.
HANDOFF.md:1681:All steps audit-logged (action: `order_edit`, before: original order JSON, after: edited order JSON).
HANDOFF.md:1780:an `admin_audit_log` entry with full before/after.
HANDOFF.md:2166:- Order edited after payment → Credit Note created instead
HANDOFF.md:2350:- Existing localStorage carts on customer browsers get uploaded to server on first cart mutation after deploy (one-shot sync logic in cart JS)
HANDOFF.md:2459:- Manual smoke test: open each of the top 5 customer profiles after Phase 19 ships and confirm
HANDOFF.md:2470:Companies migration is **deferred** to a future phase (likely Phase 22+ after current queue
HANDOFF.md:2847:  reusing same token after exit returns 401 (prevents replay)
HANDOFF.md:2939:| `cart` | add, remove, qty_change, clear, view | variant_id, product_title, qty_before, qty_after, line_total |
HANDOFF.md:2949:Express middleware in `fww-b2b-portal/server.mjs` runs on EVERY request after auth:

### async
HANDOFF.md:309:export async function renderLabelSheet({ template, items, options }) {
HANDOFF.md:315:export async function barcodePng(code, opts={}) {
HANDOFF.md:2563:export async function resolveXeroContact(shopifyCustomerId) { ... }
HANDOFF.md:2570:export async function syncCustomerToXero(shopifyCustomerId, customerData) { ... }
SCRATCH.md:208:1. mark-paid: async non-blocking → createXeroInvoice (if not synced) → recordXeroPayment
desktop/package-lock.json:965:        "async-exit-hook": "^2.0.1",
desktop/package-lock.json:1066:        "async": "^3.2.4",
desktop/package-lock.json:1179:    "node_modules/async": {
desktop/package-lock.json:1181:      "resolved": "https://registry.npmjs.org/async/-/async-3.2.6.tgz",
desktop/package-lock.json:1186:    "node_modules/async-exit-hook": {
desktop/package-lock.json:1188:      "resolved": "https://registry.npmjs.org/async-exit-hook/-/async-exit-hook-2.0.1.tgz",
desktop/package-lock.json:1196:    "node_modules/asynckit": {
desktop/package-lock.json:1198:      "resolved": "https://registry.npmjs.org/asynckit/-/asynckit-0.4.0.tgz",
desktop/package-lock.json:2926:        "asynckit": "^0.4.0",
desktop/package-lock.json:3452:      "deprecated": "This module is not supported, and leaks memory. Do not use it. Check out lru-cache if you want a good and tested way to coalesce async requests by a key value, which is much more comprehensive and powerful.",
desktop/package-lock.json:3590:        "async": "^3.2.6",
desktop/package-lock.json:5281:        "async-exit-hook": "^2.0.1",
docs/XERO_CUSTOMER_SYNC.md:46:1. **Lead conversion** (`/leads/:id/convert`): non-blocking async sync fires after
docs/XERO_CUSTOMER_SYNC.md:49:   async sync fires after the tag is saved.
helcim.mjs:8:async function acquireHelcimCallSlot() {
helcim.mjs:60:export async function helcimRequest(path, {
helcim.mjs:119:export async function createCreditCardInvoice({ payload, amountCents, currency }, options = {}) {
labels.mjs:95:export async function barcodePng(code) {
labels.mjs:132:export async function renderLabelSheet({ template = 'avery-5160', items, fields = DEFAULT_FIELDS }) {
lib/dashboard-paging.mjs:17:export async function drainDashboardOrders(shopifyFetch, query) {
lib/dashboard-paging.mjs:35:export async function drainLowStockItems(shopifyFetch, publicationId) {
lib/dashboard-paging.mjs:68:async function drainProductVariants(shopifyFetch, product) {
lib/dashboard-paging.mjs:85:export async function drainCustomerSpendOrders(shopifyFetch, customerId, query) {
lib/fulfillment-order-paging.mjs:19:export async function loadOpenFulfillmentLineMap(orderId, shopifyFetch) {
lib/fulfillment-order-paging.mjs:41:    const lines = await drainLineItems(fo.lineItems, `FO ${fo.id} lines`, async (cursor) => {

### calls
ALEXA_DECISIONS_PENDING.md:33:- **Fix:** after orderEditBegin, fetch `calculatedOrder.lineItems` and map old→new IDs by matching variant/sku/title, then use the new IDs in setQuantity calls
ALEXA_DECISIONS_PENDING.md:77:  Shopify locks orders with existing discounts against additional orderEditAddLineItemDiscount calls on those lines.
APIWATCH_NOTES.md:35:Search for all `fetch(BRIDGE` calls and ensure the header is set.
HANDOFF.md:1083:3. Our server calls PayPal Invoicing API: `POST /v2/invoicing/invoices` to generate an invoice
HANDOFF.md:1235:6. Watcher calls b2b-admin: `POST /api/admin/zelle/reconcile` with the parsed payload.
HANDOFF.md:1345:- The button calls Chase's `POST /invoice/create` (or whatever endpoint), gets back a hosted
HANDOFF.md:1393:  in wired mode (future), calls real Chase API
HANDOFF.md:1600:   When making Shopify API calls, the portal uses the company's primary_shopify_customer_id.
HANDOFF.md:1690:On submit: calls `orderEditAddLineItemDiscount` for each line proportionally (Shopify doesn't
HANDOFF.md:2684:Phase 18 already calls Xero to book invoices on order placement. It MUST use
HANDOFF.md:2982:**Specialized event hooks** (not just middleware — explicit calls in business logic):
HANDOFF.md:3174:  gid TEXT NOT NULL,                         -- full GID for API calls
QA_ADMIN_FINDINGS.md:10:- A5 (Q) admin does not surface customer REPLIES -- order detail shows outbound visible-notes only. Portal has /api/admin/orders/:id/customer-messages but admin never calls it. So "do replies go back into the admin?" -> currently NO (replies thread in Re:amaze). Enhancement: add internal route + panel.
SCRATCH.md:322:- `sendEmail(to, subject, html)` helper: queues to email_queue, calls Resend REST if key set
desktop/lib/pdf-headers.js:10://   and calls app.quit()). Reported twice by alexa; the second time from
desktop/lib/unload-prompt.js:7://   calls preventDefault() there, Chromium asks the embedder via `will-prevent-unload`, and with no
docs/HELCIM-INVOICE-CONTRACT.md:40:  successful responses expose remaining minute/hour budget and over-limit calls return 429. Admin
docs/SHOPIFY_COMPANIES_RESEARCH.md:41:- No API calls needed — it's a one-click admin action per batch
docs/XERO_CUSTOMER_SYNC.md:90:`createXeroInvoice` in `server.mjs` calls `resolveXeroContact` before creating a
lib/list-truncation.mjs:9:// starting the server (server.mjs calls app.listen at import time and cannot be imported by tests).
loop.sh:22:PARALLELIZE BY DEFAULT: send multiple independent tool calls in a SINGLE message rather than
test/admin-allowlist.test.mjs:6:// CHANGE-GUARD: server.mjs calls app.listen at import time and cannot be imported by a test, so the
test/fulfillment-order-paging.test.mjs:21:  const calls = [];
test/fulfillment-order-paging.test.mjs:23:    calls.push({ query, vars });
test/fulfillment-order-paging.test.mjs:40:  assert.equal(calls.filter((c) => c.query.includes('fulfillmentOrders')).length, 2);
test/helcim.test.mjs:53:  let calls = 0;
test/helcim.test.mjs:59:      calls++;
test/helcim.test.mjs:60:      if (calls === 1) return new Response('not-json', { status: 429, headers: { 'content-type': 'application/json' } });
test/helcim.test.mjs:61:      if (calls < 3) return jsonResponse({}, { status: 429 });
test/helcim.test.mjs:65:  assert.equal(calls, 3);

### const
ADVERSARIAL_AUDIT_2026-07-02.md:52:- **Allowlist add doesn't take effect until restart** · CODE — `ALLOWED_EMAILS` is frozen at startup (`:65`); `/settings/allowlist/add` only writes Doppler + `process.env` (`:8236`), but the OAuth gate reads the frozen const (`:4771`). Settings shows the new admin as authorized while login 403s them. Re-read env/DB in the callback.
ALEXA_DECISIONS_PENDING.md:73:### Phase 16B "Apply order discount" — Shopify constraint, not a fix
ALEXA_DECISIONS_PENDING.md:79:- **Verdict:** Cannot apply post-order discounts via Shopify Admin API on B2B-discounted orders. This is a Shopify platform constraint.
APIWATCH_NOTES.md:29:const res = await fetch(BRIDGE, {
HANDOFF.md:303:export const TEMPLATES = {
HANDOFF.md:405:for await (const variantRow of streamVariants(productIds, columns)) {
HANDOFF.md:424:const zip = archiver('zip', { zlib: { level: 6 } });
HANDOFF.md:428:for (const p of products) {
HANDOFF.md:429:  for (const [i, img] of imagesForProduct(p, mode).entries()) {
HANDOFF.md:431:    const r = await fetch(img.url);
HANDOFF.md:432:    const buf = Buffer.from(await r.arrayBuffer());
HANDOFF.md:433:    const name = mode === 'main-only'
HANDOFF.md:1022:## Phase 11 — REVISION (ACH-only constraint)
HANDOFF.md:1049:### How to actually constrain Stripe to ACH only
HANDOFF.md:1054:const intent = await stripe.paymentIntents.create({
HANDOFF.md:1075:### How to actually constrain PayPal to ACH only
HANDOFF.md:1092:### How to actually constrain Zelle (already inherently 0%)
HANDOFF.md:1180:const eligible = settings.prompt_pay_enabled
HANDOFF.md:1183:const discountPct = eligible ? settings.prompt_pay_discount_pct : 0;
HANDOFF.md:1184:const discountAmount = subtotal * (discountPct / 100);
HANDOFF.md:2046:const order = await getShopifyOrder(orderId);
HANDOFF.md:2047:const contactId = await ensureXeroContact(order.customer);
HANDOFF.md:2048:const xeroInvoice = await xero('POST /api.xro/2.0/Invoices', {
HANDOFF.md:2752:   const payload = {
HANDOFF.md:2760:   const token = base64url(JSON.stringify(payload)) + '.' + hmacSha256(payload, SECRET);
HANDOFF.md:2954:  const start = Date.now();
HANDOFF.md:2956:    const duration = Date.now() - start;
HANDOFF.md:2957:    const eventType = req.path.startsWith('/api/') ? 'api_call' :
HANDOFF.md:3020:  const trackName = e.target.closest('[data-track]')?.dataset.track;
HANDOFF.md:3035:  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;

### names
HANDOFF.md:66:- **Doppler** pre-authenticated. `doppler secrets --only-names` lists secrets.
HANDOFF.md:140:    (research the exact signal — likely `tags includes sparklayer-*` or metafield namespace
HANDOFF.md:514:introduced earlier. Same namespace though.
HANDOFF.md:557:2. In `server.mjs` `/auth/callback`: when looking up the customer, add `metafields(namespace:"b2b")`
HANDOFF.md:813:   `metafields(namespace:"b2b", first:10)`. Parse the 4 values into the session:
HANDOFF.md:1111:method names.)
HANDOFF.md:1551:- New customer metafield `b2b.catalog_access_tags` — comma-separated list of tag names the
HANDOFF.md:2551:— just IDs and names). Don't gate it behind a fetch.
SCRATCH.md:75:    metafields(first: 20, namespace: "b2b") { edges { node { id namespace key value type } } }
SCRATCH.md:84:    metafields { id key namespace value }
SCRATCH.md:89:#   { "ownerId": "gid://shopify/Customer/...", "namespace": "b2b", "key": "dropship_enabled", "value": "true", "type": "boolean" },
SCRATCH.md:90:#   { "ownerId": "gid://shopify/Customer/...", "namespace": "b2b", "key": "dropship_margin_pct", "value": "30", "type": "number_integer" }
SCRATCH.md:309:- Need Resend API key for email: check `doppler secrets --only-names | grep RESEND`
SCRATCH.md:383:- Real mode: metafieldsSet for sets, metafieldsDelete(metafields:[{ownerId,namespace,key}]) for clears
SCRATCH.md:384:- Shopify `metafieldsDelete` mutation takes MetafieldIdentifierInput (ownerId + namespace + key) — no GID needed
SCRATCH.md:394:- Field names in form: field_productName, field_variantName, field_msrp, field_sku, field_upcBarcode, field_upcDigits
SCRATCH.md:593:        metafields(first: 5, namespace: "b2b") {
desktop/lib/pdf-headers.js:23:// Response header names arrive with inconsistent casing depending on the server, so every lookup
docs/B2B-ARCHITECTURE.md:131:caller's human email so the audit trail names a person, not the tool; and note that
docs/SHOPIFY_COMPANIES_RESEARCH.md:55:- SparkLayer uses its own customer metafields (sparklayer.* namespace)
lib/order-display-totals.mjs:20:// WHAT: the display total for a raw orders_cache row (bare column names).
test/api.test.mjs:100:await test('primary list filters and selection controls have accessible names', async () => {
test/api.test.mjs:115:await test('Gauntlet-identified settings, customer-tag, and label inputs have accessible names', async () => {
test/api.test.mjs:142:await test('Dashboard shows mock data (order names, customer names)', async () => {
test/desktop-packaging.test.mjs:27:// exact names, `dir/**`, `dir/**/*`, and `*.ext`.
test/order-edit-user-errors.test.mjs:49:  assert(/orderEditSetQuantity/.test(err.message), 'names the mutation');
test/order-edit-user-errors.test.mjs:50:  assert(/LineItem\/55/.test(err.message), 'names the failing line');

### since
ALEXA_DECISIONS_PENDING.md:24:- I reset STATE: IN_PROGRESS with remaining queue (16D, 24, 25) since alexa standing instruction is "keep churning"
HANDOFF.md:803:  discount above). Typical 25–35% since FWW handles the fulfillment."
HANDOFF.md:1901:  shows business name, contact, last note preview, days-since-last-activity. Drop → status
HANDOFF.md:3274:node scripts/backfill-shopify.mjs --resource=customers [--full | --b2b-only] [--since=ISO]
HANDOFF.md:3275:node scripts/backfill-shopify.mjs --resource=orders [--full | --since=ISO]
HANDOFF.md:3290:- `--since=YYYY-MM-DD`: only pull orders newer than that date
HANDOFF.md:3368:Phase 24 should ship **BEFORE** Phase 19A's spend section gets heavy use, since spend depends
HANDOFF.md:3479:  portion) since the customer paid for the whole order
STATUS.md:17:  (--resource, --b2b-only, --full, --since, --all-vendors flags)
db.mjs:1110:  //     for this order (avoids double-listing, since committed actions write to both today).
desktop/lib/unload-prompt.js:21://   resolves to STAYING — the safe answer, since leaving is what discards work. LEAVE_INDEX is 0
docs/HANDOFF-2026-08-11-lead-fields.md:134:can still write anything; the two `<select>`s are the only actual enforcement. Lead #3 has since
docs/SHOPIFY_COMPANIES_RESEARCH.md:51:- Not a blocker for FWW since credit limits aren't in scope
lib/list-truncation.mjs:29:// CHANGE-GUARD: the no-`total` branch is the exact string /orders and /customers have shipped since
lib/order-display-totals.mjs:26://   not resynced since, hold NULL and legitimately fall back to the frozen value. A never-edited
scripts/backfill-shopify.mjs:13: *   --since=<ISO>                           Only records updated after ISO date
scripts/backfill-shopify.mjs:58:const sinceDate = flagVal('since');
scripts/backfill-shopify.mjs:76:// CHANGE-GUARD: the while(hasNext) loop has NO page cap and no rate-limit backoff — a full --full sync of all orders/products will run until the connection is exhausted and can hit Shopify cost limits; re-test --since/--full resume after changing queryFn.
scripts/backfill-shopify.mjs:147:  const sinceQ = sinceDate ? `updated_at:>${sinceDate}` : '';
scripts/backfill-shopify.mjs:148:  const q = [baseQ, sinceQ].filter(Boolean).join(' ');
scripts/backfill-shopify.mjs:251:  const sinceQ = sinceDate ? `updated_at:>${sinceDate}` : 'tag:b2b';
scripts/backfill-shopify.mjs:284:        { q: sinceQ, first, after: cursor }
scripts/backfill-shopify.mjs:329:  const sinceQ = sinceDate ? `updated_at:>${sinceDate}` : '';
scripts/backfill-shopify.mjs:330:  const q = [vendorQ, sinceQ].filter(Boolean).join(' ') || 'status:active';
scripts/backfill-shopify.mjs:360:console.log(`  options: b2bOnly=${b2bOnly} fullSync=${fullSync} sinceDate=${sinceDate || '(none)'} allVendors=${allVendors}`);
test/api.test.mjs:2471:  // since nothing enforces the vocabulary below the UI layer.
test/api.test.mjs:3015:  // Will redirect since no JSON Accept header and no _redirect body param with value
test/order-display-totals.test.mjs:100:  // Never edited, and never resynced since the migration: current_total is NULL.

### slice
HANDOFF.md:2966:      event_subtype: eventType === 'api_call' ? req.path.split('/').slice(2,4).join('/') : null,
HANDOFF.md:2969:      user_agent: (req.get('user-agent') || '').slice(0, 256),
HANDOFF.md:2970:      ip_hash: sha256(req.ip).slice(0, 32),
HANDOFF.md:2999:    event_data: { message: e.message, file: e.filename, line: e.lineno, col: e.colno, stack: e.error?.stack?.slice(0, 1000) },
db.mjs:559:    .run(status, error ? String(error).slice(0, 500) : null, Date.now(), String(orderId));
db.mjs:582:  `).run(String(orderId), String(body).slice(0, 4000), Date.now(), email || '');
db.mjs:708:  const address1 = parts.length > 2 ? parts.slice(0, -2).join(', ') : null;
db.mjs:1009:  `).run(String(errorText).slice(0, 500), retries, Date.now(), id);
db.mjs:1215:  const rows = truncated ? all.slice(0, limit) : all;
db.mjs:1278:  const rows = truncated ? all.slice(0, limit) : all;
db.mjs:1316:// INVARIANT(S): offset wraps modulo the current total in the caller — this function just slices.
db.mjs:1455:  const withoutHash = nameOrNumber.startsWith('#') ? nameOrNumber.slice(1) : nameOrNumber;
desktop/package-lock.json:1651:        "slice-ansi": "^3.0.0",
desktop/package-lock.json:2827:    "node_modules/fd-slicer": {
desktop/package-lock.json:2829:      "resolved": "https://registry.npmjs.org/fd-slicer/-/fd-slicer-1.1.0.tgz",
desktop/package-lock.json:5011:    "node_modules/slice-ansi": {
desktop/package-lock.json:5013:      "resolved": "https://registry.npmjs.org/slice-ansi/-/slice-ansi-3.0.0.tgz",
desktop/package-lock.json:5612:        "fd-slicer": "~1.1.0"
helcim.mjs:69:  const requestUrl = new URL(path.slice(1), HELCIM_API_BASE_URL);
lib/xero-customer-sync.mjs:157:    throw new Error('Xero contact creation failed: ' + JSON.stringify(createRes.body).slice(0, 300));
pdf.mjs:209:      return s.length > maxChars ? s.slice(0, maxChars - 1) + '…' : s;
scripts/backfill-current-totals.mjs:103:if (missedNames.length) console.log(`  (first 10 not-in-cache: ${missedNames.slice(0,10).join(", ")})`);
scripts/backfill-shopify.mjs:44:const args = process.argv.slice(2);
scripts/backfill-shopify.mjs:48:  return a ? a.split('=').slice(1).join('=') : null;
test/admin-allowlist.test.mjs:21:  const domain = lower.slice(at + 1);
test/admin-allowlist.test.mjs:25:      const allowedDomain = e.slice(1);
test/api.test.mjs:97:  assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
test/api.test.mjs:359:  const data = rows.slice(1);
test/api.test.mjs:387:  const data = rows.slice(1);
test/api.test.mjs:413:  const data = rows.slice(1);

### start
.github/workflows/desktop-build.yml:49:        if: startsWith(github.ref, 'refs/tags/v')
.github/workflows/desktop-build.yml:92:        if: startsWith(github.ref, 'refs/tags/v')
ADVERSARIAL_AUDIT_2026-07-02.md:52:- **Allowlist add doesn't take effect until restart** · CODE — `ALLOWED_EMAILS` is frozen at startup (`:65`); `/settings/allowlist/add` only writes Doppler + `process.env` (`:8236`), but the OAuth gate reads the frozen const (`:4771`). Settings shows the new admin as authorized while login 403s them. Re-read env/DB in the callback.
ALEXA_DECISIONS_PENDING.md:8:- **Restarted loop** at 23:51 UTC with MAX_ITERS=20
ALEXA_DECISIONS_PENDING.md:19:- **Restarted** at 00:25 UTC; loop will continue from current STATE: IN_PROGRESS
ALEXA_DECISIONS_PENDING.md:25:- Restarted loop at 01:00 UTC
CLAUDE.md:25:3. **Never grep `.env` for a secret.** This service starts under `doppler run`, so secrets live only
HANDOFF.md:223:decisions. Read at start of each iteration.
HANDOFF.md:487:- UI: navigate /exports → both cards visible → click "CSV export" → form renders → submit → download starts
HANDOFF.md:566:6. Commit + push to b2b-portal main; restart the portal service.
HANDOFF.md:2732:3. Both apps read it at startup; require it (fail to boot if absent in prod)
HANDOFF.md:2762:4. Audit log entry: `action=impersonation_started, admin=<email>, customer_id=<id>, mode=<mode>, expires_at=<ts>`
HANDOFF.md:2784:       started_at: payload.issued_at,
HANDOFF.md:2803:│ 👁  Viewing as Mia Wagner — started by alex@fuzzywumpets.com         │
HANDOFF.md:2851:- All impersonation activity audit-logged (start, every mutation, every pageview optional,
HANDOFF.md:2914:  session_id TEXT,                     -- portal session cookie value (one row per session start)
HANDOFF.md:2940:| `checkout` | started, method_selected, submitted, succeeded, failed, abandoned | payment_method, order_total, error_msg |
HANDOFF.md:2954:  const start = Date.now();
HANDOFF.md:2956:    const duration = Date.now() - start;
HANDOFF.md:2957:    const eventType = req.path.startsWith('/api/') ? 'api_call' :
HANDOFF.md:2975:      ts: start
HANDOFF.md:3042:purgeOldActivity();  // run on startup too
HANDOFF.md:3316:**Webhook registration**: one-time on admin startup, idempotent via Shopify Admin API
QA_ADMIN_FINDINGS.md:4:- A1 (CRITICAL) admin /orders/new discount decimals -- appliedDiscount PERCENTAGE computed with .toFixed(4); Shopify rejects >2 decimals, so EVERY discounted (B2B-priced) manual order returned 400 ("Applied discount value can have at most 2 digits after decimal point"). Manual B2B order creation was fully broken. Fix: .toFixed(4) -> .toFixed(2). Verified: #37073 created, line shows orig $83.99 / discounted $42.01. STATUS: DEPLOYED to prod admin 2026-05-29 (fww-b2b-admin restarted, pid 263849, HTTP 302 healthy); committed+pushed on apiwatch/entry-783. TODO(hygiene): merge entry-783 -> master at next apiwatch reconciliation (real mainline is 'master' [Task#48]; origin/main is stale at Task#45).
QA_ADMIN_FINDINGS.md:5:- A2 (HIGH) admin "Send note to customer" 500 -- admin proxies POST /__internal__/visible-note (callPortalInternal, Bearer token) but portal had NO /__internal__/* routes -> 404 HTML -> blind r.json() choked -> admin 500. Customer note-emails never worked from the admin. Fix: added POST /__internal__/visible-note (token-auth) to portal reusing addVisibleNote + sendWholesaleEmail. DEPLOYED to prod portal (commit 154b97f, restarted). Verified live: admin note -> portal -> Re:amaze conv + email to alexanderlass@mac.com.
SCRATCH.md:159:sudo systemctl restart fww-b2b-admin.service
SCRATCH.md:165:After editing server.mjs: restart the service to pick up changes.
SCRATCH.md:421:- run-tests.sh starts server on port 8894 with MOCK=1
SCRATCH.md:428:- Old process (from before systemd) sat on 8794 and blocked restarts. Kill manually first.
SCRATCH.md:429:- `lsof -i :8794` to check. `sudo systemctl restart fww-b2b-admin.service` only works if port is free.

### state
ALEXA_DECISIONS_PENDING.md:88:- Order goes into VOIDED state after the commit attempt (a void transaction is added)
HANDOFF.md:75:  portal data in admin. Don't WRITE to portal's DB. For admin-specific state, use your OWN SQLite
HANDOFF.md:754:returns to the same view. Trivial change once the filter state is wired.
HANDOFF.md:834:     city, state, zip, country, phone) AND an optional gift message textarea. On submit,
HANDOFF.md:1193:it. No "remove the discount but keep the order" partial state.
HANDOFF.md:1483:  - If no cert on file: "Upload your resale certificate (PDF, max 5MB)" + state dropdown
HANDOFF.md:1484:    (US states + territories).
HANDOFF.md:1486:  - If approved: "✓ Approved {state} on {date}. Orders are tax-exempt." + "Replace certificate"
HANDOFF.md:1491:- SQLite: `tax_exempt_certs (id, customer_id, state, file_path, status, uploaded_at,
HANDOFF.md:1497:- When approved: write a Shopify customer metafield `b2b.tax_exempt = true` + `b2b.tax_exempt_state = "XX"`.
HANDOFF.md:1841:  sales_tax_state TEXT,
HANDOFF.md:1959:2. If sales tax cert was uploaded: write `b2b.tax_exempt=true` + `b2b.tax_exempt_state` metafields
HANDOFF.md:2127:Processing Fees recorded as expense. Books reconcile cleanly to Chase statement.
HANDOFF.md:2307:   - Table `cart_state (customer_id, items_json, updated_at)` — current cart snapshot
HANDOFF.md:2308:   - On every cart mutation in the UI: POST `/api/cart/event` → server appends to `cart_events` + updates `cart_state` row
HANDOFF.md:2309:   - On portal page load (catalog, PDP, cart): GET `/api/cart` → server returns `cart_state.items_json`; client merges with any local pending changes
HANDOFF.md:2324:     - If `cart_state.items_json` is non-empty:
HANDOFF.md:2345:- `cart_state` is single-row-per-customer, updated in place
HANDOFF.md:2349:- On first deploy, no existing cart_state rows; customers will populate as they interact
HANDOFF.md:2364:- 19D: explicit "Empty cart" clears cart_state + adds audit event
HANDOFF.md:2658:**Endpoint** `GET /api/admin/customers/:id/xero-status` → returns `{state, xeroContactId, xeroName, lastChecked}`.
HANDOFF.md:2816:- Frontend: any "Add to cart" / "Place order" / etc. buttons get a visual disabled state +
HANDOFF.md:3258:-- Sync state tracker
HANDOFF.md:3259:CREATE TABLE sync_state (
SCRATCH.md:34:  - params: client_id, redirect_uri, response_type=code, scope="openid email profile", access_type=offline, prompt=consent, state=<csrf>
SCRATCH.md:153:- Lime accent on active row / selected state
SCRATCH.md:335:- `tax_exempt_certs` table: customer_id, state, file_path, status, uploaded_at, reviewed_at, reviewed_by, rejection_reason
SCRATCH.md:447:- mockOrderOverrides Map<numericId, overrides> holds in-memory state changes
SCRATCH.md:449:- Tests can verify state changes within a single server instance
STATUS.md:12:  sync_state, products_cache) with indexes + 14 helper functions

# DIFF
diff --git a/lib/orders-recent-sync.mjs b/lib/orders-recent-sync.mjs
new file mode 100644
index 0000000..feec588
--- /dev/null
+++ b/lib/orders-recent-sync.mjs
@@ -0,0 +1,97 @@
+// WHAT: the incremental "orders changed since last poll" sync that keeps orders_cache (what the Orders
+// list renders) in step with Shopify, plus the REST->GraphQL fulfillment-status normalizer.
+//
+// WHY: the poller used to fetch `orders(first:50, sortKey:UPDATED_AT, reverse:true)` once, with no
+// paging, and then advance its cursor to "now" no matter what. The query covers EVERY order in the
+// store (not just B2B), and the shipping app fulfils dozens of DTC orders a day — so after any idle
+// stretch (the poller only runs while the dashboard is open) more than 50 orders had changed, the
+// 50 NEWEST won, and the older ones — including B2B orders fulfilled in Shopify — were dropped and the
+// cursor jumped past them. They then showed UNFULFILLED in the list until something else touched
+// them. (Seen 2026-10-02: six March orders already FULFILLED in Shopify still listed UNFULFILLED.)
+//
+// INVARIANT(S):
+//  - pages OLDEST-first (reverse:false) so progress is monotonic: if the page cap is hit we resume
+//    from the newest updatedAt we actually stored, never from "now", so nothing is skipped.
+//  - the cursor only advances to a time we have fully processed. A thrown error leaves it where it
+//    was (the next run re-covers the window) and is rethrown so callers/"Sync now" see the failure
+//    instead of a green no-op.
+//  - the 60s overlap is kept: updates landing between polls re-appear in the next window.
+// DEPENDS: server.mjs's upsert callback maps exactly the fields in ORDER_SYNC_FIELDS — adding a
+// field here means mapping it there (and in scripts/backfill-*.mjs, which write the same columns).
+
+export const SYNC_PAGE_SIZE = 50;
+export const SYNC_PAGE_LIMIT = 40;           // 40 x 50 = 2000 orders per run before we hand back and resume next tick
+export const SYNC_OVERLAP_MS = 60_000;
+export const SYNC_COLD_START_MS = 6 * 60_000;
+
+export const ORDER_SYNC_FIELDS = `id name processedAt updatedAt createdAt cancelledAt
+  displayFinancialStatus displayFulfillmentStatus
+  totalPriceSet{shopMoney{amount}}
+  subtotalPriceSet{shopMoney{amount}}
+  currentTotalPriceSet{shopMoney{amount}}
+  currentSubtotalPriceSet{shopMoney{amount}}
+  totalTaxSet{shopMoney{amount}}
+  customer{id email firstName lastName}
+  tags sourceName note`;
+
+const QUERY = `query($q:String!,$first:Int!,$after:String){
+  orders(first:$first,after:$after,query:$q,sortKey:UPDATED_AT,reverse:false){
+    edges{node{${ORDER_SYNC_FIELDS}}}
+    pageInfo{hasNextPage endCursor}
+  }
+}`;
+
+// Returns { synced, truncated, since }. `upsertNode(node)` must write one order into the cache.
+export async function syncRecentOrders({
+  shopifyFetch, getState, setState, upsertNode, now = Date.now,
+  pageLimit = SYNC_PAGE_LIMIT, pageSize = SYNC_PAGE_SIZE,
+}) {
+  const startedAt = now();
+  const state = getState();
+  const sinceMs = state?.last_synced_at
+    ? state.last_synced_at - SYNC_OVERLAP_MS
+    : startedAt - SYNC_COLD_START_MS;
+  const since = new Date(sinceMs).toISOString();
+
+  let after = null;
+  let synced = 0;
+  let maxUpdated = 0;
+  let hasNext = false;
+  try {
+    for (let page = 0; page < pageLimit; page++) {
+      const res = await shopifyFetch(QUERY, { q: `updated_at:>${since}`, first: pageSize, after });
+      const conn = res.data?.orders;
+      if (!conn) throw new Error('orders unavailable while polling');
+      for (const { node } of conn.edges || []) {
+        upsertNode(node);
+        synced++;
+        const t = node.updatedAt ? Date.parse(node.updatedAt) : 0;
+        if (t > maxUpdated) maxUpdated = t;
+      }
+      hasNext = !!conn.pageInfo?.hasNextPage;
+      if (!hasNext) break;
+      if (!conn.pageInfo.endCursor) throw new Error('orders hasNextPage without cursor');
+      after = conn.pageInfo.endCursor;
+    }
+  } catch (err) {
+    // Cursor stays put (sinceMs + overlap == the stored value) so the whole window is retried.
+    setState({ lastSyncedAt: sinceMs + SYNC_OVERLAP_MS, lastError: err.message });
+    throw err;
+  }
+
+  // Complete: everything up to startedAt is in the cache. Capped: only up to the newest row stored.
+  const cursor = hasNext ? Math.max(maxUpdated, sinceMs + SYNC_OVERLAP_MS) : startedAt;
+  setState({ lastSyncedAt: cursor, totalSynced: synced });
+  return { synced, truncated: hasNext, since };
+}
+
+// REST webhook payloads use null / 'fulfilled' / 'partial' / 'restocked'; the GraphQL poller and both
+// backfills write UNFULFILLED / FULFILLED / PARTIALLY_FULFILLED / ... into the same columns and every
+// reader compares those. Without this a partly-shipped order read "PARTIAL" or null depending on which
+// writer touched it last.
+// SYNC: the GraphQL enum names — OrderDisplayFulfillmentStatus.
+export function normalizeRestFulfillmentStatus(v) {
+  if (v == null || v === '') return 'UNFULFILLED';
+  const s = String(v).toUpperCase();
+  return s === 'PARTIAL' ? 'PARTIALLY_FULFILLED' : s;
+}
diff --git a/run-tests.sh b/run-tests.sh
index 5216595..788e35c 100755
--- a/run-tests.sh
+++ b/run-tests.sh
@@ -30,80 +30,87 @@ fi
 
 API_FAIL=0
 UI_FAIL=0
 UNIT_FAIL=0
 AUTH_FAIL=0
 
 if [ -f test/api.test.mjs ]; then
   echo ""
   TEST_BASE="http://127.0.0.1:$PORT" node test/api.test.mjs || API_FAIL=$?
 fi
 
 if [ -f test/ui.test.mjs ]; then
   echo ""
   TEST_BASE="http://127.0.0.1:$PORT" node test/ui.test.mjs || UI_FAIL=$?
 fi
 
 # Standalone unit suites — run WITHOUT the mock HTTP server on purpose, because the code they cover
 # is short-circuited under MOCK (getPortalDb returns null) and the API suite would otherwise report
 # a false green over an untested ingest.
 if [ -f test/leads-ingest.test.mjs ]; then
   echo ""
   B2B_ADMIN_MOCK=1 node test/leads-ingest.test.mjs || UNIT_FAIL=$?
 fi
 
 # Order/line-item cache integrity (H14 line-item duplication, H15 status casing). Standalone for the
 # same reason as above: getOrdersData() short-circuits to the MOCK fixture array and never reads
 # orders_cache, so these writes are invisible to the API suite.
 if [ -f test/order-cache-integrity.test.mjs ]; then
   echo ""
   B2B_ADMIN_MOCK=1 node test/order-cache-integrity.test.mjs || UNIT_FAIL=$?
 fi
 
 # Boots its OWN non-MOCK servers (against throwaway sqlite dirs via B2B_ADMIN_DATA_DIR) because the
 # /__test__/session allowlist+audit guard only exists on the non-MOCK branch. Deliberately NOT given
 # B2B_ADMIN_MOCK.
 if [ -f test/test-session-guard.test.mjs ]; then
   echo ""
   node test/test-session-guard.test.mjs || AUTH_FAIL=$?
 fi
 
+# Incremental orders poller (paging, cursor, error handling) + REST status normalizer. Standalone:
+# the poller sits behind `if (!MOCK)` in server.mjs, so the HTTP suite can never reach it.
+if [ -f test/orders-recent-sync.test.mjs ]; then
+  echo ""
+  node test/orders-recent-sync.test.mjs || UNIT_FAIL=$?
+fi
+
 # Money-correctness helpers (lib/order-money.mjs). Standalone because the branches under test are
 # Shopify userError branches — MOCK never calls shopifyFetch, so only an injected fake reaches them.
 if [ -f test/order-money.test.mjs ]; then
   echo ""
   node test/order-money.test.mjs || UNIT_FAIL=$?
 fi
 
 if [ -f test/helcim.test.mjs ]; then
   echo ""
   echo "── Unit: Helcim invoice client (standalone, no server) ──"
   node test/helcim.test.mjs || UNIT_FAIL=$?
 fi
 
 if [ -f test/helcim-payload.test.mjs ]; then
   echo ""
   echo "── Unit: Helcim itemized payload assembler (standalone, no server) ──"
   node test/helcim-payload.test.mjs || UNIT_FAIL=$?
 fi
 
 if [ -f test/helcim-dedupe.test.mjs ]; then
   echo ""
   echo "── Unit: Helcim durable creation claim (standalone, no server) ──"
   B2B_ADMIN_MOCK=1 node test/helcim-dedupe.test.mjs || UNIT_FAIL=$?
 fi
 
 if [ -f test/helcim-message.test.mjs ]; then
   echo ""
   echo "── Unit: Helcim branded email contract (standalone, no server) ──"
   node test/helcim-message.test.mjs || UNIT_FAIL=$?
 fi
 
 # Order-edit userErrors: the batch /edit handler returns from its MOCK branch before any Shopify
 # mutation, so this path can ONLY be covered standalone.
 if [ -f test/order-edit-user-errors.test.mjs ]; then
   echo ""
   node test/order-edit-user-errors.test.mjs || UNIT_FAIL=$?
 fi
 
 # List truncation lives here for the same reason: the cache path is gated on `if (!MOCK)`, so the
 # HTTP suite can never reach the capped query that truncates /orders and /customers.
diff --git a/server.mjs b/server.mjs
index 17be2c7..6fbf028 100644
--- a/server.mjs
+++ b/server.mjs
@@ -21,80 +21,81 @@ import {
   getSetting, setSetting, getGlobalSettings, getAuditLog, getAuditLogCount,
   logLabelBatch, logExportBatch,
   createLead, getLeads, countLeads, getLeadCounts, getLead, updateLead, upsertPortalLead,
   addLeadNote, getLeadNotes, addLeadStatusHistory, getLeadStatusHistory,
   upsertBackorder, getBackordersForOrder, getOpenBackorders, fulfillBackorder, logOrderEdit,
   getEditAction, putEditAction,
   getOutstandingBalanceForCustomer,
   getXeroMap, setXeroMap, addXeroPending, getXeroPending, markXeroPendingDone, markXeroPendingFailed, getXeroPendingCount, getXeroInvoiceMaps,
   createImpersonationNonce, consumeImpersonationNonce, gcImpersonationNonces,
   createPartialInvoice, getPartialInvoices, getNextInvoiceLetter,
   getOrderHistory,
   upsertCustomerCache, upsertOrderCache, upsertOrderLineItemsCache, upsertProductCache,
   getOrdersFromCache, getOrderFromCache, getOrderSpendFromCache, getCustomerFromCache,
   getCustomersCountInCache, getOrdersCountInCache, getProductsCountInCache,
   getSyncState, setSyncState, getAllInvoicesForList, getPartialInvoicesAll,
   listCustomersFromCache,
   getCustomerCacheStats,
   listOrdersFromCache, getOrdersCacheStats, getCustomerOrdersFromCache,
   deleteOrderFromCache, getOrderShopifyIdsBatch,
   getReportsDataFromCache,
   getTopCustomersAllTime,
   listImpersonationsForCustomer,
   getOrderByName,
   getOrderInternalNote, setOrderInternalNote,
   getHelcimInvoiceMap, claimHelcimInvoiceCreation, releaseHelcimInvoiceClaim,
   upsertHelcimInvoiceMap, setHelcimInvoiceDelivery,
 } from './db.mjs';
 import { generateInvoicePdf, lineItemTrueTotal, lineItemTrueUnit, lineItemCurrentQty } from './pdf.mjs';
 // Extracted so they can be unit-tested without booting this server (house pattern: lib/*.mjs).
 import { isTerminalEditError } from './lib/order-edit-errors.mjs';
 // DEPENDS: every money surface in this file picks its amount through these two — cacheRowTotal for a
 // raw orders_cache row, listRowTotalAmount for a Shopify/GraphQL-shaped one. A query that feeds one
 // of them MUST also select currentTotalPriceSet (or carry current_total), or the accessor silently
 // falls back to the frozen pre-edit amount and the surface looks correct while being wrong.
 import { cacheRowTotal, listRowTotalAmount, restRowCurrentTotals } from './lib/order-display-totals.mjs';
 import { LINE_PAGE_MAX, drainLineItems } from './lib/line-item-paging.mjs';
 // loadOpenFulfillmentLineMap is the standalone fail-closed helper. /orders/:id/fulfill stays on
 // getOpenFulfillmentOrderLines because PR #45 maps remaining qty per location and never clamps;
 // origin/main no longer has /orders/:id/ship/label (handed off to FWW Shipping).
 import { loadOpenFulfillmentLineMap } from './lib/fulfillment-order-paging.mjs';
+import { syncRecentOrders, normalizeRestFulfillmentStatus } from './lib/orders-recent-sync.mjs';
 import { drainDashboardOrders, drainLowStockItems, drainCustomerSpendOrders } from './lib/dashboard-paging.mjs';
 import { renderLabelSheet, expandItems, TEMPLATES as LABEL_TEMPLATES, DEFAULT_FIELDS } from './labels.mjs';
 import { isInsider, resolveXeroContact, syncCustomerToXero, getXeroSyncStatus } from './lib/xero-customer-sync.mjs';
 import { parseLinePrices, applyLinePriceChanges, bulkMarkOrdersPaid } from './lib/order-money.mjs';
 import { assertNoUserErrors } from './lib/shopify-user-errors.mjs';
 import { createCreditCardInvoice } from './helcim.mjs';
 import { buildHelcimInvoicePayload, HelcimInvoiceValidationError } from './lib/helcim-invoice-payload.mjs';
 import { buildHelcimInvoiceMessage } from './lib/helcim-invoice-message.mjs';
 // SYNC: same module db.mjs uses for the SQL LIMIT — the banner/footer copy and the query page size
 // must agree, otherwise the list lies about how much it is showing.
 import { ORDERS_LIST_LIMIT, CUSTOMERS_LIST_LIMIT, LEADS_LIST_LIMIT, listCountLabel, truncationNoticeHtml } from './lib/list-truncation.mjs';
 // fww-error-sink monitoring (injected 2026-06-30): error-logging shim only. To disable, remove this import, the installGlobalHandlers() call, and the expressErrorMiddleware() app.use. See fww-error-sink RUNBOOK.
 import { installGlobalHandlers, expressErrorMiddleware, reportEvent } from './fww-logsink.mjs';
 installGlobalHandlers();
 
 const __dirname = path.dirname(fileURLToPath(import.meta.url));
 const MOCK  = process.env.B2B_ADMIN_MOCK === '1';
 
 // Activity-gated Shopify polling (added 2026-05-30 — shopify-bridge perf fix):
 // only sync while the dashboard is in active use, so data stays fresh when someone
 // is looking but Shopify isn't polled around the clock.
 let lastDashboardActivity = 0;
 const ACTIVE_WINDOW_MS = 20 * 60 * 1000; // treat as "in use" for 20 min after last request
 const dashboardActive = () => (Date.now() - lastDashboardActivity) < ACTIVE_WINDOW_MS;
 const PORT  = Number(process.env.PORT || 8794);
 
 const GOOGLE_CLIENT_ID     = process.env.B2B_ADMIN_GOOGLE_CLIENT_ID     || '';
 const GOOGLE_CLIENT_SECRET = process.env.B2B_ADMIN_GOOGLE_CLIENT_SECRET || '';
 const ALLOWED_EMAILS       = (process.env.B2B_ADMIN_ALLOWED_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
 const SHOPIFY_BEARER       = process.env.SHOPIFY_BRIDGE_BEARER           || '';
 const REDIRECT_URI         = MOCK
   ? `http://127.0.0.1:${PORT}/auth/google/callback`
   : 'https://b2badmin.fuzzywumpets.com/auth/google/callback';
 const COOKIE_NAME = 'b2b_admin_sid';
 const B2B_PUB_ID  = 'gid://shopify/Publication/199709720811';
 const PORTAL_INTERNAL_TOKEN = process.env.B2B_PORTAL_INTERNAL_TOKEN || '';
 const PORTAL_INTERNAL_URL   = process.env.B2B_PORTAL_INTERNAL_URL || 'http://127.0.0.1:8793';
 const XERO_BRIDGE_URL       = 'https://fww-xero-bridge.alex-037.workers.dev/xero';
 const XERO_BEARER           = process.env.XERO_BRIDGE_BEARER || '';
 // ─────────────────────────────────────────────────────────────────────────────
@@ -12254,213 +12255,192 @@ app.post('/webhooks/shopify', (req, res) => {
   setImmediate(() => {
     try {
       if (topic.startsWith('customers/')) {
         const c = payload;
         const shopifyId = String(c.id);
         const tags = Array.isArray(c.tags) ? c.tags : (c.tags || '').split(',').map(s => s.trim()).filter(Boolean);
         upsertCustomerCache({
           shopify_id: shopifyId,
           gid: `gid://shopify/Customer/${shopifyId}`,
           email: c.email, first_name: c.first_name, last_name: c.last_name,
           display_name: c.first_name && c.last_name ? `${c.first_name} ${c.last_name}` : (c.email || shopifyId),
           company: c.default_address?.company || null,
           tags,
           amount_spent_total: parseFloat(c.total_spent) || 0,
           orders_count: c.orders_count || 0,
           default_address_json: c.default_address || null,
           created_at: c.created_at ? new Date(c.created_at).getTime() : null,
           updated_at: c.updated_at ? new Date(c.updated_at).getTime() : null,
         });
       } else if (topic.startsWith('orders/')) {
         const o = payload;
         const shopifyId = String(o.id);
         const custId = o.customer?.id ? String(o.customer.id) : null;
         upsertOrderCache({
           shopify_id: shopifyId,
           gid: `gid://shopify/Order/${shopifyId}`,
           name: o.name, customer_shopify_id: custId,
           created_at: o.created_at ? new Date(o.created_at).getTime() : Date.now(),
           updated_at: o.updated_at ? new Date(o.updated_at).getTime() : null,
           processed_at: o.processed_at ? new Date(o.processed_at).getTime() : null,
           cancelled_at: o.cancelled_at ? new Date(o.cancelled_at).getTime() : null,
           // STATUS-CASE (2026-08-09, fixes H15): the REST webhook payload carries LOWERCASE statuses
           // ('paid'), while the GraphQL sync writes UPPERCASE ('PAID') into the same columns and every
           // reader compares uppercase — listOrdersFromCache's status buckets (db.mjs) and
           // getOutstandingBalanceForCustomer's PENDING/PARTIALLY_PAID/UNPAID sum (db.mjs). Storing the
           // raw lowercase value made any webhook-updated order vanish from every status-filtered view
           // and from the customer unpaid-balance total until the next full sync overwrote it.
           // DEPENDS: readers that lowercase for display (badge class, ~line 11640) still work — they
           // normalize on read. Keep this uppercase to match the GraphQL sync writer.
           financial_status: o.financial_status?.toUpperCase() || null,
-          fulfillment_status: o.fulfillment_status?.toUpperCase() || null,
+          fulfillment_status: normalizeRestFulfillmentStatus(o.fulfillment_status),
           display_financial_status: o.financial_status?.toUpperCase(),
-          display_fulfillment_status: o.fulfillment_status?.toUpperCase(),
+          display_fulfillment_status: normalizeRestFulfillmentStatus(o.fulfillment_status),
           total_price: parseFloat(o.total_price) || 0,
           subtotal_price: parseFloat(o.subtotal_price) || 0,
           // CURRENT-TOTALS (corrected 2026-08-28): the comment that stood here since 2026-06-29 said
           // "the REST orders webhook returns CURRENT (post-edit) totals in total_price/subtotal_price".
           // It does not. REST sends BOTH pairs and total_price is the FROZEN one — see
           // restRowCurrentTotals for the live verification against #38953.
           // WHY THIS NEVER BIT: Shopify's four order webhooks (ORDERS_CREATE/UPDATED/FULFILLED/
           // CANCELLED) all point at fww-shopify-cache.alex-037.workers.dev, not at this service, so
           // this branch has never received an orders/* topic. It was a landmine under the
           // current-vs-frozen fix, not a live defect — repoint a webhook here and it would have
           // overwritten current_total with the pre-edit amount on every edited order.
           ...restRowCurrentTotals(o),
           total_tax: parseFloat(o.total_tax) || 0,
           total_shipping: parseFloat(o.total_shipping_price_set?.shop_money?.amount || o.total_shipping_price || 0),
           total_discounts: parseFloat(o.total_discounts) || 0,
           currency: o.currency || 'USD',
           tags: Array.isArray(o.tags) ? o.tags : (o.tags || '').split(',').map(s => s.trim()).filter(Boolean),
           source_name: o.source_name || null,
           note: o.note || null,
           customer_email: o.email || o.customer?.email || null,
           customer_phone: o.phone || o.customer?.phone || null,
         });
         if (o.line_items?.length) {
           upsertOrderLineItemsCache(shopifyId, o.line_items.map(li => ({
             line_id: String(li.id),
             variant_shopify_id: li.variant_id ? String(li.variant_id) : null,
             product_shopify_id: li.product_id ? String(li.product_id) : null,
             sku: li.sku, title: li.title, variant_title: li.variant_title,
             quantity: li.quantity, price: parseFloat(li.price) || 0,
             // DISCOUNT-AWARE (2026-08-05): prefer Σ discount_allocations over total_discount.
             // VERIFIED on live order #38611: REST reports total_discount "0.00" while
             // discount_allocations carries the real 37.99 (pre_tax_price 3.00 = 40.99 − 37.99).
             // `price` is the PRE-discount unit price, so caching a 0 discount here makes
             // getReportsFromCache over-state B2B product revenue by the full discount on every
             // discounted order — which order discounts now are, since they stopped being their own
             // negative-priced cached row.
             // SYNC: same rule as scripts/backfill-shopify.mjs + scripts/backfill-orders-per-customer.mjs.
             // DEPENDS: db.mjs getReportsFromCache subtracts this column from SUM(price*quantity).
             total_discount: (li.discount_allocations || []).length
               ? (li.discount_allocations || []).reduce((s, a) => s + (parseFloat(a?.amount ?? a?.amount_set?.shop_money?.amount ?? 0) || 0), 0)
               : parseFloat(li.total_discount) || 0,
             taxable: li.taxable ? 1 : 0, vendor: li.vendor || null,
           })));
         }
       } else if (topic === 'products/update' || topic === 'products/create') {
         const p = payload;
         const shopifyId = String(p.id);
         upsertProductCache({
           shopify_id: shopifyId, gid: `gid://shopify/Product/${shopifyId}`,
           handle: p.handle, title: p.title, vendor: p.vendor,
           product_type: p.product_type, status: p.status,
           tags: Array.isArray(p.tags) ? p.tags : (p.tags || '').split(',').map(s => s.trim()).filter(Boolean),
           variants_json: p.variants || [],
           created_at: p.created_at ? new Date(p.created_at).getTime() : null,
           updated_at: p.updated_at ? new Date(p.updated_at).getTime() : null,
         });
       }
       auditLog('webhook', `webhook:${topic}`, String(payload.id || ''), null, null);
     } catch (err) {
       console.error('[webhook] cache upsert error:', err.message);
     }
   });
 
   res.status(200).json({ ok: true, topic });
 });
 
 // ── Phase 24C: Background polling sync ────────────────────────────────────────
 
 // WHAT: incremental order poller — pulls orders updated since last_synced_at (minus 60s overlap) into orders_cache; the backstop for missed webhooks.
 // CHANGE-GUARD: it queries shopMoney (not presentmentMoney) and assumes currency 'USD'; the webhook path and backfill scripts use different money fields — keep the three in sync or cached totals diverge.
 // INVARIANT(S): runs only when dashboardActive() and at most every FRESH_TARGET_MS (~3min) guarded by the _syncing flag; the 60s lookback overlap is required so updates landing between polls aren't lost; never runs in MOCK or without SHOPIFY_BEARER.
 // WHAT: incremental order backstop poller — pulls orders updated since last_synced_at (minus a 60s overlap, or 6min on cold start) into orders_cache; covers webhooks that were missed.
 // CHANGE-GUARD: it reads totalPriceSet/subtotalPriceSet/totalTaxSet.shopMoney and HARDCODES currency:'USD' — the webhook path and any backfill must use the same money fields or cached totals diverge; query is sortKey:UPDATED_AT reverse with first:50 (no pagination loop, so a burst of >50 updates between polls can drop the oldest — the 60s overlap only helps at the boundary).
 // INVARIANT(S): no-ops in MOCK or without SHOPIFY_BEARER; the 60s lookback overlap is REQUIRED so updates landing between polls aren't lost; success and error both call setSyncState so last_synced_at always advances (an error still moves the cursor, meaning a failed page is not retried — intentional best-effort).
 async function syncRecentFromShopify() {
   if (MOCK || !SHOPIFY_BEARER) return;
-  try {
-    const state = getSyncState('orders_recent');
-    const since = state?.last_synced_at
-      ? new Date(state.last_synced_at - 60000).toISOString()
-      : new Date(Date.now() - 6 * 60 * 1000).toISOString();
-    const result = await shopifyFetch(`
-      query($q:String!){
-        orders(first:50,query:$q,sortKey:UPDATED_AT,reverse:true){
-          edges{node{
-            id name processedAt updatedAt createdAt cancelledAt
-            displayFinancialStatus displayFulfillmentStatus
-            totalPriceSet{shopMoney{amount}}
-            subtotalPriceSet{shopMoney{amount}}
-            currentTotalPriceSet{shopMoney{amount}}
-            currentSubtotalPriceSet{shopMoney{amount}}
-            totalTaxSet{shopMoney{amount}}
-            customer{id email firstName lastName}
-            tags sourceName note
-          }}
-          pageInfo{hasNextPage}
-        }
-      }`, { q: `updated_at:>${since}` });
-    const edges = result.data?.orders?.edges || [];
-    for (const { node: o } of edges) {
+  // Paging/cursor logic lives in lib/orders-recent-sync.mjs (unit-tested); this only maps a node to a row.
+  // DEPENDS: the fields below must stay in step with ORDER_SYNC_FIELDS in that module.
+  await syncRecentOrders({
+    shopifyFetch,
+    getState: () => getSyncState('orders_recent'),
+    setState: (st) => setSyncState('orders_recent', st),
+    upsertNode: (o) => {
       const shopifyId = shopifyNumericId(o.id);
       const custId = o.customer?.id ? shopifyNumericId(o.customer.id) : null;
       upsertOrderCache({
         shopify_id: shopifyId, gid: o.id, name: o.name,
         customer_shopify_id: custId,
         created_at: o.createdAt ? new Date(o.createdAt).getTime() : Date.now(),
         updated_at: o.updatedAt ? new Date(o.updatedAt).getTime() : null,
         processed_at: o.processedAt ? new Date(o.processedAt).getTime() : null,
         cancelled_at: o.cancelledAt ? new Date(o.cancelledAt).getTime() : null,
         financial_status: o.displayFinancialStatus || null,
         fulfillment_status: o.displayFulfillmentStatus || null,
         display_financial_status: o.displayFinancialStatus,
         display_fulfillment_status: o.displayFulfillmentStatus,
         total_price: parseFloat(o.totalPriceSet?.shopMoney?.amount) || 0,
         subtotal_price: parseFloat(o.subtotalPriceSet?.shopMoney?.amount) || 0,
         // CURRENT-TOTALS (2026-06-29): post-edit truth — totalPriceSet/subtotalPriceSet stay FROZEN at the
         // original on an edited order, so the LIST must carry the current* totals to show e.g. #37639's $601.24.
         current_total: o.currentTotalPriceSet?.shopMoney?.amount != null ? parseFloat(o.currentTotalPriceSet.shopMoney.amount) : null,
         current_subtotal: o.currentSubtotalPriceSet?.shopMoney?.amount != null ? parseFloat(o.currentSubtotalPriceSet.shopMoney.amount) : null,
         total_tax: parseFloat(o.totalTaxSet?.shopMoney?.amount) || 0,
         currency: 'USD',
         tags: o.tags || [], source_name: o.sourceName || null, note: o.note || null,
         customer_email: o.customer?.email || null,
       });
-    }
-    setSyncState('orders_recent', { lastSyncedAt: Date.now(), totalSynced: edges.length });
-  } catch (err) {
-    console.error('[sync] polling error:', err.message);
-    setSyncState('orders_recent', { lastSyncedAt: Date.now(), lastError: err.message });
-  }
+    },
+  });
 }
 
 // WHAT: verifies a small rotating batch of cached orders still exist in Shopify (nodes(ids:) returns
 // a null entry for a deleted id) and evicts any that don't from orders_cache.
 // CHANGE-GUARD: syncRecentFromShopify (above) can only ADD/UPDATE — Shopify's orders() search
 // silently excludes deleted orders from its results, so polling recent updates can never learn that
 // one is GONE, only that it changed. This is the other half of that: a deleted order still has a
 // well-formed gid, so nodes(ids:) is the one query that distinguishes "deleted" from "never existed."
 // A rotating batch (not the whole cache) keeps the per-cycle query cheap; the offset just wraps
 // around the current total, so a bigger cache takes proportionally more cycles to fully sweep, not
 // more cost per cycle — nothing is permanently skipped.
 // INVARIANT(S): only a clean (non-throwing) nodes() response is trusted as eviction evidence — a
 // shopify-bridge error must leave the batch untouched, or an outage would misread the whole batch as
 // deleted and mass-evict real orders from /orders. Mirrors the CONFIRMED-DELETE guard in GET /orders/:id.
 let _reconcileOffset = 0;
 async function reconcileOrderDeletions() {
   if (MOCK || !SHOPIFY_BEARER) return;
   const RECONCILE_BATCH = 25;
   const stats = getOrdersCacheStats();
   if (!stats?.total) return;
   const batch = getOrderShopifyIdsBatch(_reconcileOffset % stats.total, RECONCILE_BATCH);
   _reconcileOffset = (_reconcileOffset + batch.length) % stats.total;
   if (!batch.length) return;
   try {
     const result = await shopifyFetch(`query($ids:[ID!]!){ nodes(ids:$ids){ id } }`,
       { ids: batch.map(shopifyOrderGid) });
     const stillExists = new Set((result.data?.nodes || []).filter(Boolean).map(n => shopifyNumericId(n.id)));
     for (const shopifyId of batch) {
       if (!stillExists.has(shopifyId)) {
         deleteOrderFromCache(shopifyId);
         console.log('[reconcile] evicted deleted order from cache:', shopifyId);
       }
     }
   } catch (err) {
     console.error('[reconcile] order-existence check failed, batch left untouched:', err.message);
   }
 }
 
 // Activity-gated polling (was a flat 5-min interval). Syncs every ~3 min WHILE the
 // dashboard is being used (fresher than before); zero Shopify calls when idle, and
diff --git a/test/orders-recent-sync.test.mjs b/test/orders-recent-sync.test.mjs
new file mode 100644
index 0000000..47e13e1
--- /dev/null
+++ b/test/orders-recent-sync.test.mjs
@@ -0,0 +1,94 @@
+// Standalone unit test (no server): incremental orders poller + REST status normalizer.
+// The poller lives behind `if (!MOCK)` in server.mjs, so the HTTP suite can never reach it.
+import { syncRecentOrders, normalizeRestFulfillmentStatus, SYNC_OVERLAP_MS } from '../lib/orders-recent-sync.mjs';
+
+let passed = 0, failed = 0;
+async function test(name, fn) {
+  try { await fn(); console.log(`  ✓ ${name}`); passed++; } catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
+}
+function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(m || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
+
+// Fake Shopify: `orders` sorted ascending by updatedAt, served in pages honouring `updated_at:>` and `after`.
+function fakeShopify(orders) {
+  const calls = [];
+  const fn = async (_q, { q, first, after }) => {
+    calls.push({ q, first, after });
+    const since = Date.parse(q.replace('updated_at:>', ''));
+    const rows = orders.filter(o => Date.parse(o.updatedAt) > since).sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
+    const start = after ? Number(after) : 0;
+    const slice = rows.slice(start, start + first);
+    const end = start + slice.length;
+    return { data: { orders: { edges: slice.map(node => ({ node })), pageInfo: { hasNextPage: end < rows.length, endCursor: String(end) } } } };
+  };
+  fn.calls = calls;
+  return fn;
+}
+const mk = (n, iso) => ({ id: `gid://shopify/Order/${n}`, name: `#${n}`, updatedAt: iso, displayFulfillmentStatus: 'FULFILLED' });
+function harness(state) {
+  const h = { state, stored: [], writes: [] };
+  h.getState = () => h.state;
+  h.setState = (st) => { h.writes.push(st); if (st.lastSyncedAt != null) h.state = { last_synced_at: st.lastSyncedAt }; };
+  h.upsertNode = (n) => h.stored.push(n.name);
+  return h;
+}
+
+console.log('\norders-recent-sync');
+
+await test('pages past 50 — none of a 120-order burst is dropped (the original bug)', async () => {
+  const base = Date.parse('2026-10-02T10:00:00Z');
+  const orders = Array.from({ length: 120 }, (_, i) => mk(i, new Date(base + i * 1000).toISOString()));
+  const h = harness({ last_synced_at: base - 3600_000 });
+  const r = await syncRecentOrders({ shopifyFetch: fakeShopify(orders), ...h, getState: h.getState, setState: h.setState, upsertNode: h.upsertNode, now: () => base + 999_000 });
+  eq(h.stored.length, 120); eq(r.truncated, false);
+  eq(h.writes.at(-1).lastSyncedAt, base + 999_000, 'complete run advances to start time');
+});
+
+await test('page cap hit — cursor resumes from newest stored row, NOT now, and next run finishes the rest', async () => {
+  const base = Date.parse('2026-10-02T10:00:00Z');
+  const orders = Array.from({ length: 120 }, (_, i) => mk(i, new Date(base + i * 60_000).toISOString()));
+  const h = harness({ last_synced_at: base - 3600_000 });
+  const f = fakeShopify(orders);
+  const run = (now) => syncRecentOrders({ shopifyFetch: f, getState: h.getState, setState: h.setState, upsertNode: h.upsertNode, now: () => now, pageLimit: 1, pageSize: 50 });
+  const r1 = await run(base + 10 * 3600_000);
+  eq(r1.truncated, true); eq(h.stored.length, 50);
+  eq(h.state.last_synced_at, Date.parse(orders[49].updatedAt), 'cursor = newest stored updatedAt');
+  await run(base + 10 * 3600_000); await run(base + 10 * 3600_000);
+  eq(new Set(h.stored).size, 120, 'every order eventually stored');
+});
+
+await test('error mid-run — cursor does not advance, error is rethrown, lastError recorded', async () => {
+  const base = Date.parse('2026-10-02T10:00:00Z');
+  const h = harness({ last_synced_at: base - 5000 });
+  let n = 0;
+  const f = async () => { if (n++) throw new Error('bridge 502'); return { data: { orders: { edges: [{ node: mk(1, new Date(base).toISOString()) }], pageInfo: { hasNextPage: true, endCursor: 'x' } } } }; };
+  let threw = null;
+  try { await syncRecentOrders({ shopifyFetch: f, getState: h.getState, setState: h.setState, upsertNode: h.upsertNode, now: () => base + 99_000 }); } catch (e) { threw = e; }
+  eq(threw?.message, 'bridge 502');
+  eq(h.state.last_synced_at, base - 5000, 'cursor unchanged');
+  eq(h.writes.at(-1).lastError, 'bridge 502');
+});
+
+await test('overlap — window starts SYNC_OVERLAP_MS before the stored cursor', async () => {
+  const h = harness({ last_synced_at: Date.parse('2026-10-02T10:00:00Z') });
+  const f = fakeShopify([]);
+  await syncRecentOrders({ shopifyFetch: f, ...h, getState: h.getState, setState: h.setState, upsertNode: h.upsertNode, now: () => Date.parse('2026-10-02T10:05:00Z') });
+  eq(f.calls[0].q, `updated_at:>${new Date(Date.parse('2026-10-02T10:00:00Z') - SYNC_OVERLAP_MS).toISOString()}`);
+});
+
+await test('malformed response (no orders) throws instead of silently advancing', async () => {
+  const h = harness({ last_synced_at: 1000 });
+  let threw = false;
+  try { await syncRecentOrders({ shopifyFetch: async () => ({ data: {} }), getState: h.getState, setState: h.setState, upsertNode: h.upsertNode, now: () => 9e12 }); } catch { threw = true; }
+  eq(threw, true); eq(h.state.last_synced_at, 1000);
+});
+
+await test('REST fulfillment status maps onto the GraphQL enum', () => {
+  eq(normalizeRestFulfillmentStatus(null), 'UNFULFILLED');
+  eq(normalizeRestFulfillmentStatus(undefined), 'UNFULFILLED');
+  eq(normalizeRestFulfillmentStatus('fulfilled'), 'FULFILLED');
+  eq(normalizeRestFulfillmentStatus('partial'), 'PARTIALLY_FULFILLED');
+  eq(normalizeRestFulfillmentStatus('restocked'), 'RESTOCKED');
+});
+
+console.log(`\n${passed} passed, ${failed} failed`);
+process.exit(failed ? 1 : 0);



