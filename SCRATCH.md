# SCRATCH — cross-iteration notes for fww-b2b-admin overnight loop

(Seed file. Append your own notes as you work. Future iterations have NO in-context memory
of prior runs — write down anything you'll need.)

## Critical IDs (don't re-discover these)

- **B2B publication** ("Fuzzywumpets B2B"): `gid://shopify/Publication/199709720811`
- **SparkLayer publication** (read-only, transition only): `gid://shopify/Publication/107823366379`
- **Online Store publication**: `gid://shopify/Publication/71671611585`
- **GCP project**: `fww-bill-scanner`
- **OAuth client name**: `fww-b2b-admin`
- **Google OAuth redirect URI**: `https://b2badmin.fuzzywumpets.com/auth/google/callback`

## Tag conventions (Shopify customers)

- `b2b` — required for portal login (separate app)
- `b2b-admin` — extra signal for admin users (we ALSO check email allowlist in Doppler)
- `b2b-tier:gold` / `b2b-tier:silver` etc. — pricing tier (informational only for now; flat 50% applies)
- `b2b-dropship` will appear on orders when customer's dropship is enabled

## Shopify Admin API via shopify-bridge (ONLY path for Shopify writes)

```
POST https://shopify-bridge.alex-037.workers.dev/api/graphql
Authorization: Bearer $SHOPIFY_BRIDGE_BEARER
Content-Type: application/json
{ "query": "...", "variables": {...} }
```

## Google OAuth flow (auth that you're building)

- Authorization endpoint: `https://accounts.google.com/o/oauth2/v2/auth`
  - params: client_id, redirect_uri, response_type=code, scope="openid email profile", access_type=offline, prompt=consent, state=<csrf>
- Token endpoint: `https://oauth2.googleapis.com/token`
  - POST form: grant_type=authorization_code, code, redirect_uri, client_id, client_secret
- Userinfo endpoint: `https://openidconnect.googleapis.com/v1/userinfo`
  - GET with Bearer access_token; returns { email, email_verified, name, picture, sub }
- After verify email is in allowlist: mint own session, set cookie, redirect /

## Reading b2b-portal SQLite (read-only)

```js
import Database from 'better-sqlite3';
const portalDb = new Database('/home/alexa/projects/fww-b2b-portal/data/portal.db', { readonly: true, fileMustExist: true });
// portal tables: sessions, carts, cart_items, orders_log, admin_audit_log, saved_lists, saved_list_items, favorites
```

## Useful GraphQL queries (tested-working as of 2026-05-26)

### Orders tagged `b2b-portal` (the orders the b2b portal creates)
```graphql
query($q: String!, $after: String) {
  orders(first: 50, query: $q, after: $after, sortKey: PROCESSED_AT, reverse: true) {
    edges { cursor node {
      id name processedAt customer { id displayName email }
      displayFinancialStatus displayFulfillmentStatus
      totalPriceSet { presentmentMoney { amount currencyCode } }
      lineItems(first: 5) { edges { node { title quantity variant { sku } } } }
      note tags
    }}
    pageInfo { hasNextPage }
  }
}
# variables: { "q": "tag:b2b-portal created_at:>2026-04-01" }
```

### Customer detail with tags + metafields
```graphql
query($id: ID!) {
  customer(id: $id) {
    id email displayName phone tags
    addresses(first: 5) { id firstName lastName address1 city province zip country }
    defaultAddress { id firstName lastName address1 city province zip country phone }
    metafields(first: 20, namespace: "b2b") { edges { node { id namespace key value type } } }
  }
}
```

### Set metafield (dropship config)
```graphql
mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { id key namespace value }
    userErrors { field message }
  }
}
# variables: { "metafields": [
#   { "ownerId": "gid://shopify/Customer/...", "namespace": "b2b", "key": "dropship_enabled", "value": "true", "type": "boolean" },
#   { "ownerId": "gid://shopify/Customer/...", "namespace": "b2b", "key": "dropship_margin_pct", "value": "30", "type": "number_integer" }
# ]}
```

### Mark order as paid
```graphql
mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
  orderMarkAsPaid(input: $input) {
    order { id displayFinancialStatus }
    userErrors { field message }
  }
}
# variables: { "input": { "id": "gid://shopify/Order/..." } }
```

### Add note to order
```graphql
mutation orderUpdate($input: OrderInput!) {
  orderUpdate(input: $input) {
    order { id note }
    userErrors { field message }
  }
}
# variables: { "input": { "id": "gid://shopify/Order/...", "note": "Marked paid via admin 2026-05-26" } }
```

### Add tags to customer (idempotent)
```graphql
mutation tagsAdd($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } }
}
```

### Publish a product TO the B2B publication
```graphql
mutation pub($id: ID!, $input: [PublicationInput!]!) {
  publishablePublish(id: $id, input: $input) {
    userErrors { field message }
  }
}
# variables: { "id": "gid://shopify/Product/...", "input": [{ "publicationId": "gid://shopify/Publication/199709720811" }] }
```

### Unpublish a product FROM the B2B publication
```graphql
mutation unpub($id: ID!, $input: [PublicationInput!]!) {
  publishableUnpublish(id: $id, input: $input) {
    userErrors { field message }
  }
}
```

## Brand kit

Colors: Lime Light `#9BBC0E`, Ivory Curtain `#FFFFFF`, Marquee Blue `#D9E8FF`,
Curtain Call Blue `#2086BA`, Backstage Black `#000000`.
Fonts: Inter (body), Playfair Display (headings).
Google Fonts: `family=Inter:wght@400;500;600;700&family=Playfair+Display:wght@600;700`

For admin (vs portal), lean denser + more utilitarian. Use:
- Smaller heading sizes
- More monospace-feel data tables
- Sticky table headers
- Lime accent on active row / selected state
- Marquee Blue for header background instead of pure white

## Service management

```
sudo systemctl restart fww-b2b-admin.service
sudo systemctl status fww-b2b-admin.service
journalctl -u fww-b2b-admin.service -n 100
tail -n 100 ~/projects/fww-b2b-admin/runs/serverlog.log
```

After editing server.mjs: restart the service to pick up changes.

## File layout

```
fww-b2b-admin/
├── HANDOFF.md
├── SCRATCH.md            # this file
├── STATUS.md
├── RESEARCH.md           # Phase 0 output (you write this)
├── README.md
├── server.mjs            # Express app
├── db.mjs                # SQLite migrations + helpers (build in Phase 1)
├── public/
│   └── index.html        # placeholder for now; replace with login page
├── test/
│   ├── api.test.mjs      # build in Phase 1
│   └── ui.test.mjs       # build in Phase 1
├── data/                 # gitignored — admin.db lives here
├── runs/                 # gitignored — logs, screenshots
├── package.json
├── run-tests.sh
└── loop.sh
```

## Append below this line, future iterations
---

## Phase 1 complete (2026-05-26, commit dde366c)

### Files built
- db.mjs — SQLite (in-memory in MOCK mode, ./data/admin.db in prod)
- server.mjs — full rewrite: cookie helpers (no cookie-parser dep), requireAuth, OAuth flow, dashboard
- public/admin.css — dense operator CSS, brand colors, responsive
- test/api.test.mjs + test/ui.test.mjs — 24 tests all green

### Cookie handling note
- No cookie-parser dep. Manual getCookie() parses req.headers.cookie.
- Session IDs are 64-char hex (crypto.randomBytes(32).toString('hex')), URL-safe, no encoding issues.
- `sessionCookie(sid)` helper builds Set-Cookie string; `sessionCookie(null, true)` clears it.
- Secure flag is set in prod (MOCK=false), not in mock mode.

### Mock mode
- B2B_ADMIN_MOCK=1: uses :memory: SQLite, returns hardcoded dashboard data, /auth/login auto-logins
- /__test__/session?email=X seeds a session + sets cookie + returns { ok, sid, email }
- run-tests.sh starts server on port 8894 with MOCK=1

### Gotcha: stale process on port 8894
- If run-tests.sh crashed without cleanup, port 8894 stays occupied.
- Next run sees wrong server. Fix: `kill $(lsof -ti:8894)` then re-run.

### Service management
- Old process (from before systemd) sat on 8794 and blocked restarts. Kill manually first.
- `lsof -i :8794` to check. `sudo systemctl restart fww-b2b-admin.service` only works if port is free.

## Phase 2 complete (2026-05-26, commit 2e6812a)

### Files changed
- server.mjs — full rewrite with orders + customers routes (~1650 lines)
- pdf.mjs — new file, pdfkit invoice generator
- db.mjs — added getCustomerNotes/setCustomerNotes/getDropshipCache/setDropshipCache
- public/admin.css — 250 lines of Phase 2 styles (buttons, tables, cards, etc.)
- test/api.test.mjs — 35 tests
- test/ui.test.mjs — 17 tests

### URL / numeric ID pattern
- Orders: /orders/1001 → numericId=1001 → GID=gid://shopify/Order/1001
- Customers: /customers/101 → numericId=101 → GID=gid://shopify/Customer/101
- shopifyNumericId(gid) extracts the last segment after /

### Mock order mutations
- mockOrderOverrides Map<numericId, overrides> holds in-memory state changes
- getMockOrder(numericId) merges MOCK_ORDERS base with overrides
- Tests can verify state changes within a single server instance

### Route ordering is important
- GET /orders/new MUST be defined before GET /orders/:id
- POST /orders/bulk MUST be defined before POST /orders/:id/* 
  (not actually a conflict because sub-paths differ, but good practice)

### Note persistence in tests
- customer_notes writes to :memory: SQLite in mock mode
- Because mock server runs continuously during test suite, notes persist within the test run
- Tests pass because seedSession() creates new session but shares the same SQLite instance

## Phase 3 complete (2026-05-26, commit 3c4a747)

### Files changed
- db.mjs — added admin_settings, label_batches, export_batches tables; getSetting/setSetting/getGlobalSettings/getAuditLog helpers
- server.mjs — full Phase 3: catalog, reports, settings, migrate, audit routes (~815 new lines)
- public/admin.css — Phase 3 styles: bulk-bar, tag-chip, stat-card, report-section, settings-grid, form-input, pagination
- test/api.test.mjs — 57 tests total (20 new Phase 3 tests)
- test/ui.test.mjs — 27 tests total (10 new Phase 3 tests)

### Key gotchas
- Catalog table needs `.table-wrap` (overflow-x:auto) for mobile — without it, document.documentElement.scrollWidth overflows
- For SparkLayer migration: query `tag:sparklayer` in real mode (Shopify tag search)
- Settings allowlist write: use spawnSync('doppler', ['secrets', 'set', `B2B_ADMIN_ALLOWED_EMAILS=...`]) — NOT execSync with shell
- renderBarChart/renderSparkline return inline SVG — no JS charting lib needed
- csvLine() escapes commas/quotes/newlines correctly

### GraphQL for catalog (real mode)
```graphql
query($q:String!,$after:String){
  products(first:50,query:$q,after:$after,sortKey:TITLE){
    edges{node{
      id title handle vendor tags
      publishedOnPublication(publicationId:"gid://shopify/Publication/199709720811")
      variants(first:15){edges{node{sku title inventoryQuantity}}}
    }}
    pageInfo{hasNextPage endCursor}
  }
}
```

## Phase 4 starting next iteration

Remaining items per HANDOFF.md:
1. Keyboard shortcuts: global keydown handler in layout(), `g d`/`g o`/`g c` navigation, `/` focus search, `?` overlay
2. Orders CSV export: GET /orders/export.csv
3. Customers CSV export: GET /customers/export.csv  
4. PWA manifest: manifest.json + <link rel="manifest"> in layout()
5. Mobile polish: already OK for main pages; check /reports table on 390px

### Keyboard shortcut implementation plan
```js
// In layout() extraHead:
`<script>
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  if (e.key === '/') { e.preventDefault(); document.querySelector('.search-input, #filter-q, input[type="search"]')?.focus(); }
  if (e.key === '?') { toggleShortcutOverlay(); }
  if (e.key === 'g') { window._gPressed = true; setTimeout(()=>{ window._gPressed=false; }, 1000); }
  if (window._gPressed) {
    if (e.key === 'd') { window.location = '/'; }
    if (e.key === 'o') { window.location = '/orders'; }
    if (e.key === 'c') { window.location = '/customers'; }
    if (e.key === 'l') { window.location = '/catalog'; }
    if (e.key === 'r') { window.location = '/reports'; }
  }
});
</script>`
```

### PWA manifest
```json
{
  "name": "FWW Admin",
  "short_name": "FWWadmin",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#FFFFFF",
  "theme_color": "#9BBC0E",
  "icons": [{ "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" }]
}
```
Need to create a simple 192x192 PNG icon (lime green with "FW" text).

## Phase 3 starting next iteration

### Draft orders mutation (manual order builder)
```graphql
mutation draftOrderCreate($input: DraftOrderInput!) {
  draftOrderCreate(input: $input) {
    draftOrder { id invoiceUrl totalPrice }
    userErrors { field message }
  }
}
# variables: { "input": {
#   "lineItems": [{ "variantId": "gid://shopify/ProductVariant/...", "quantity": 2, "appliedDiscount": { "value": 50, "valueType": "PERCENTAGE" } }],
#   "customerId": "gid://shopify/Customer/...",
#   "shippingAddress": { ... },
#   "note": "Manual order via b2b-admin",
#   "tags": ["b2b-portal", "b2b-manual-order"]
# }}

mutation draftOrderComplete($id: ID!, $paymentPending: Boolean!) {
  draftOrderComplete(id: $id, paymentPending: $paymentPending) {
    draftOrder { order { id name } }
    userErrors { field message }
  }
}
# variables: { "id": "gid://shopify/DraftOrder/...", "paymentPending": true }
```

### B2B orders list query (paginated)
```graphql
query($q: String!, $first: Int!, $after: String) {
  orders(first: $first, query: $q, after: $after, sortKey: PROCESSED_AT, reverse: true) {
    edges {
      cursor
      node {
        id name processedAt
        customer { id displayName email }
        displayFinancialStatus displayFulfillmentStatus
        totalPriceSet { presentmentMoney { amount currencyCode } }
        note tags
        lineItems(first: 3) { edges { node { title quantity variant { sku } } } }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}
```

### Customer list query (b2b-tagged, sorted by amountSpent)
```graphql
query($q: String!, $first: Int!, $after: String) {
  customers(first: $first, query: $q, after: $after, sortKey: AMOUNT_SPENT, reverse: true) {
    edges {
      cursor
      node {
        id displayName email phone
        tags
        amountSpent { amount currencyCode }
        numberOfOrders
        defaultAddress { city province country }
        metafields(first: 5, namespace: "b2b") {
          edges { node { key value } }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}
# variables: { "q": "tag:b2b", "first": 50 }
```

### Order detail (full)
```graphql
query($id: ID!) {
  order(id: $id) {
    id name processedAt createdAt cancelledAt
    customer { id displayName email phone }
    displayFinancialStatus displayFulfillmentStatus
    totalPriceSet { presentmentMoney { amount currencyCode } }
    subtotalPriceSet { presentmentMoney { amount currencyCode } }
    totalShippingPriceSet { presentmentMoney { amount currencyCode } }
    totalTaxSet { presentmentMoney { amount currencyCode } }
    note tags
    shippingAddress { firstName lastName address1 address2 city province zip country }
    billingAddress { firstName lastName address1 address2 city province zip country }
    lineItems(first: 50) {
      edges { node {
        id title quantity
        variant { id sku price inventoryQuantity }
        discountedUnitPriceSet { presentmentMoney { amount currencyCode } }
        originalUnitPriceSet { presentmentMoney { amount currencyCode } }
      }}
    }
    fulfillments { status trackingInfo { number url company } createdAt }
    transactions(first: 10) { id status kind gateway createdAt amountSet { presentmentMoney { amount currencyCode } } }
  }
}
```

### PDF invoice
- Install pdfkit: `npm install pdfkit`
- Build in server.mjs or a separate pdf.mjs helper
- Response: res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', ...)
- Fields: FWW logo text, order number, date, customer info, line items table, totals, "PAYMENT PENDING" stamp if not paid


## Phase 4+5+6 complete (2026-05-26, commit 953919e)

### Phase 4 notes
- Keyboard shortcut overlay: `g+key` with 1s window (gDown flag), `?` toggles overlay, `/` focuses `.search-input`
- PWA icon: generated from raw PNG bytes using zlib.deflateSync (no canvas dep). Solid lime-green #9BBC0E 192×192.
- Orders CSV: route must be BEFORE `/orders/:id` (added between /orders/bulk and /orders/:id)
- Customers CSV: route must be BEFORE `/customers/:id` (placed correctly from the start)

### Phase 5 notes
- bwip-js import: `import bwipjs from 'bwip-js'` works (has default export)
- TEMPLATES: Avery 5160 verified: 2×13.5 + 3×189 + 2×9 = 612pt ✓, 2×36 + 10×72 = 792pt ✓
- expandItems() skips barcodes not matching /^\d{12,13}$/
- renderLabelsPage() must NOT reference `req` — pass `queryOrder` and `queryQ` as string params
- Tab system: two `<div class="tab-content">` divs, JS swaps `hidden` class on tab click
- `waitForSelector('form')` in Playwright can pick up hidden form (in display:none tab) — use ID selector instead (#product-search-form)
- Multi-value URLSearchParams: use `.append('sel', '0'); body.append('sel', '1')` NOT `{sel: ['0','1']}`

### Phase 6 notes
- archiver ESM: NO default export. Use `import { ZipArchive } from 'archiver'` + `new ZipArchive({ zlib: { level: 6 } })`
- ZipArchive API: `.pipe(res)`, `.append(buf, {name})`, `.finalize()`, `.on('error', ...)`
- In MOCK mode, image exports use `Buffer.from('mock image: ' + url)` placeholder
- Product CSV streaming: `res.write(csvLine(row))` per variant, `res.end()` at end
- Column selection: saved per-user in admin_settings table; retrieved on next visit

