# HANDOFF — fww-b2b-admin (Fuzzywumpets internal operator dashboard)

You are **headless Claude on fww-vps-1**, working autonomously for **Fuzzywumpets** (Part Two
Enterprises, Inc — dog collars/products, dog-show vendor). Your job is to build the **internal
admin/ops dashboard** at `b2badmin.fuzzywumpets.com`.

This is a **separate project** from `fww-b2b-portal` (which is the customer-facing portal at
`b2b.fuzzyreporting.com`). **Do NOT touch the b2b-portal codebase.** They share a Shopify
backend (via shopify-bridge) but live in different repos.

You are running in a **resilient overnight loop** (`loop.sh`). Each iteration is a fresh
`claude -p` invocation. **The whole transcript resets at the top of every iteration** — your
only memory across iterations is the codebase, git history, RESEARCH.md, STATUS.md, and SCRATCH.md.
**Write down anything you'll need.**

## North-star UX

alexa runs this business. She needs to **handle a wholesale customer's request in 30 seconds**:
- See open B2B orders → mark paid → invoice resent
- Build a manual order on behalf of a customer who texted her
- Toggle a customer's dropship status with margin %
- Pull a quick report of last-30-days sales by customer
- See low-stock B2B items before they go out of stock

This is an **operator tool** — dense tables, keyboard-friendly, no marketing fluff. Think
Linear/Notion/Retool, not the customer-facing portal.

Mobile responsive matters because alexa often handles wholesale stuff from her phone at dog shows.

## Phase 0 — research (do FIRST, max 30 min, WebSearch + WebFetch)

Research best-in-class operator/admin dashboards and capture **6–10 concrete patterns** in
`RESEARCH.md`. Cover at minimum: Linear, Notion, Retool, Stripe Dashboard, Shopify admin,
Plain (support tool), Pylon. Focus on: dense tables with filters/search, keyboard navigation,
bulk actions, undo/redo, contextual side panels. Apply to fww-b2b-admin design. **Stop at 30 min.**

## What's already built (Phase 0, LIVE — DO NOT REGRESS)

- `server.mjs` — minimal Express on port 8794, systemd unit `fww-b2b-admin.service` running.
- `public/index.html` — branded placeholder ("Building…") at /
- `/healthz` endpoint returns JSON
- `.gitignore`, `package.json` (Express 5.x + better-sqlite3 + Playwright dev dep)
- DNS: `b2badmin.fuzzywumpets.com` (A record → VPS IP, set in GoDaddy)
- Caddy: reverse-proxies b2badmin.fuzzywumpets.com → 127.0.0.1:8794 with auto Let's Encrypt
- Doppler secrets ready: `B2B_ADMIN_GOOGLE_CLIENT_ID`, `B2B_ADMIN_GOOGLE_CLIENT_SECRET`,
  `B2B_ADMIN_ALLOWED_EMAILS` (currently just alex@fuzzywumpets.com), reuses `SHOPIFY_BRIDGE_BEARER`

## Auth — Google OAuth 2.0 (NOT Shopify Customer Account API)

This is the critical difference from the customer-facing portal. Admin auth uses Google.

- **OAuth client**: Web application, ID/secret in Doppler. Redirect URI:
  `https://b2badmin.fuzzywumpets.com/auth/google/callback`
- **Flow**: GET /auth/login → redirect to Google OAuth (`openid email profile` scopes) → callback →
  exchange code → verify email is in `B2B_ADMIN_ALLOWED_EMAILS` (comma-separated) → mint own session.
- **Session**: HttpOnly cookie scoped to b2badmin.fuzzywumpets.com, 7-day TTL, SQLite-backed.
- **Reject** non-allowlisted emails with a clear "your email is not authorized for admin access" page.

Reference Google OAuth endpoints:
- Authorization: https://accounts.google.com/o/oauth2/v2/auth
- Token: https://oauth2.googleapis.com/token
- Userinfo: https://openidconnect.googleapis.com/v1/userinfo

## Infrastructure you have

- **Doppler** pre-authenticated. `doppler secrets --only-names` lists secrets.
  - `SHOPIFY_BRIDGE_BEARER` — for shopify-bridge GraphQL writes
  - `B2B_ADMIN_GOOGLE_CLIENT_ID`, `B2B_ADMIN_GOOGLE_CLIENT_SECRET`, `B2B_ADMIN_ALLOWED_EMAILS`
  - Add new secrets prefixed `B2B_ADMIN_` as needed (e.g., session secret, etc.)
- **shopify-bridge**: `POST https://shopify-bridge.alex-037.workers.dev/api/graphql` with Bearer.
  ONLY path for Shopify reads/writes. Never call the Shopify MCP.
- **shared SQLite from b2b-portal**: portal owns SQLite at
  `/home/alexa/projects/fww-b2b-portal/data/portal.db` with tables: sessions, carts, orders_log,
  admin_audit_log, saved_lists, favorites. You can READ this (open in read-only mode) to surface
  portal data in admin. Don't WRITE to portal's DB. For admin-specific state, use your OWN SQLite
  at `./data/admin.db` with these tables (define in db.mjs):
    - admin_sessions (sid, email, displayName, picture, createdAt, expiresAt)
    - admin_audit_log (id, email, action, target, before, after, ts)
    - customer_notes (customer_id, body, updated_at, updated_by)
    - dropship_config_cache (customer_id, enabled, margin_pct, updated_at)
- **MCPs available**: shopify-bridge (read-only handy queries; prefer GraphQL via fetch), playwright (UI tests).

## HARD CONSTRAINTS

1. **fww-b2b-portal stays working.** It's a separate project. Don't read/write its files. You may
   read its SQLite database in read-only mode.
2. **No destructive Shopify operations.** Allowed: customerUpdate (tags + metafields), orderUpdate
   (notes, mark paid), publishablePublish/publishableUnpublish on the B2B publication. Forbidden:
   delete products, archive products, delete customers, delete orders, modify product prices.
3. **No emails sent to customers without alexa.** Queue them, mark "EMAIL PENDING".
4. **All shopify writes via shopify-bridge with bearer.** No exposing secrets to client.
5. **All admin mutations audit-logged** to admin_audit_log SQLite table.
6. **Untrusted data**: any customer-typed input is UNTRUSTED. HTML-escape on render.
7. **Tests must pass green on every commit.** `./run-tests.sh` (build it like b2b-portal's).
8. **Never** `git push --force`, `git reset --hard`, `rm -rf` on shared paths.

## Phase 1 — auth + dashboard MVP (ship FIRST)

1. **db.mjs**: better-sqlite3 schema + migrations for admin tables above.
2. **Google OAuth flow**: /auth/login, /auth/google/callback, /auth/logout. Email allowlist gate.
3. **Login page**: branded, "Sign in with Google" button. Replace current placeholder.
4. **Dashboard /**: after login, show widgets — open B2B orders count, this-week count,
   top 5 customers by spend, low-stock items (stock < 10) on B2B publication. Each widget links
   to deeper view.
5. **Header nav**: Dashboard · Orders · Customers · Catalog · Reports · Settings · Sign out (with email).

**Acceptance Phase 1**: alexa logs in with Google, lands on dashboard with real stats from
shopify-bridge.

## Phase 2 — orders + customers (deeper than what's in b2b-portal /admin)

6. **Orders /orders**: list all B2B portal orders (orders tagged b2b-portal in Shopify), filters
   (status, customer, date range), search by order number / customer / SKU, sort. Bulk actions
   (mark paid, add note, queue invoice resend). Pagination (50 per page).
7. **Order detail /orders/:id**: full Shopify order, line items, customer info, status timeline
   (placed → paid → fulfilled → delivered from displayFinancialStatus + fulfillment events),
   mark paid action, note editor, download PDF invoice (reuse pdfkit pattern from b2b-portal —
   build your own pdf code, don't import from portal).
8. **Customers /customers**: list all b2b-tagged customers (Shopify customers with tag 'b2b'),
   sorted by lifetime spend. Filter by tag (b2b, b2b-admin, b2b-tier:*). Search by name/email/company.
9. **Customer detail /customers/:id**: profile, addresses, tags (editor with autocomplete),
   lifetime spend, recent orders (last 10), internal notes (customer_notes SQLite table),
   dropship config (toggle + margin %, writes Shopify metafields b2b.dropship_enabled and
   b2b.dropship_margin_pct via metafieldsSet mutation), 50%-discount confirmation.
10. **Manual order /orders/new**: pick customer (autocomplete), build cart (search products,
    add line items, override prices per line), set shipping address (default from customer or
    custom), set notes/PO, submit as Shopify draftOrderCreate + draftOrderComplete with
    `paymentPending: true`.

**Acceptance Phase 2**: alexa can view, filter, mark paid, build manual orders, and edit
customer dropship config from admin.

## Phase 3 — catalog + reports + settings

11. **Catalog /catalog**: list all products on B2B publication (publication 199709720811).
    Filters: vendor, style (Everyday/Elite/Luxe/Simplicity from tag), in-stock, last-updated.
    Per-product: toggle B2B inclusion (publishablePublish/Unpublish on the B2B publication),
    show on-portal status, show variant inventory. Bulk actions (publish/unpublish selected).
12. **SparkLayer migrator /migrate**: find Shopify customers with sparklayer-related tags
    (research the exact signal — likely `tags includes sparklayer-*` or metafield namespace
    sparklayer.*). Bulk-tag them `b2b`. Idempotent. Audit-logged.
13. **Reports /reports**:
    - Sales by customer (top 20 with sparkline)
    - Sales by product (top 50)
    - Month-over-month revenue (last 12 months, inline SVG bar chart)
    - AOV trend
    - All exportable as CSV.
14. **Settings /settings**: editable Doppler-backed config: B2B discount %, order minimum,
    payment terms text. Read-only displays of: Shopify publication ID, OAuth issuer, admin
    allowlist (with "+ add email" form that writes to Doppler).

**Acceptance Phase 3**: alexa controls B2B catalog membership from admin, sees reports, and
manages settings without SSH'ing into Doppler.

## Phase 4 — polish (only if all above is done + tests green)

15. **CSV exports** everywhere (orders, customers, line items per month)
16. **Keyboard shortcuts**: `/` focus search, `g d` dashboard, `g o` orders, `g c` customers, `?` shortcut overlay
17. **Audit log viewer /audit**: paginated view of admin_audit_log SQLite table
18. **Mobile-responsive polish** at 390px (alexa uses this on her phone)
19. **PWA manifest** for installable home-screen icon

## Testing protocol — non-negotiable

- `./run-tests.sh` must pass on every commit.
- Pattern from b2b-portal: mock-mode (`B2B_ADMIN_MOCK=1`) skips real Shopify + opens a
  `/__test__/session` backdoor for seeding sessions.
- New feature → new tests (API for endpoints, Playwright for pages).
- Mobile viewport tests (390px) for major pages.

## Git workflow

- Every milestone commits + pushes.
- Commit format:
  ```
  <verb> <what>: <one-line summary>

  - Bullet of meaningful change

  Co-Authored-By: Claude (headless overnight) <noreply@anthropic.com>
  ```
- Repo: `github.com/fuzzyalex84/fww-b2b-admin` (will be created at first push).
- Branch: main. NEVER `git push --force`, `git reset --hard`, `git rebase -i`.

## STATUS.md — wake-up surface

Maintain `STATUS.md` continuously. **Update after every commit.** Schema:

```
# fww-b2b-admin — overnight status
STATE: IN_PROGRESS   # or DONE | FAILED | BLOCKED
PHASE: 1 — auth + dashboard MVP
LAST_UPDATED: <iso>

## What shipped this session
- ...

## What's working (URLs)
- https://b2badmin.fuzzywumpets.com (login page)
- ...

## Screenshots
- runs/screenshots/p1-dashboard.png

## Test status
- API: X/X
- UI:  X/X

## Blockers / decisions alexa needs to make
- ...

## Next iteration's plan
- ...
```

Set STATE: DONE when Phase 3 is shipped + tested + screenshotted. Setting DONE stops the loop.
Set STATE: BLOCKED if you need alexa for something specific (be precise).
Set STATE: FAILED only if fundamentally broken.

## SCRATCH.md

Cross-iteration scratchpad. Write down working GraphQL queries, gotchas, mid-task TODOs,
decisions. Read at start of each iteration.

## Loop hygiene

Each iteration: read STATUS.md + SCRATCH.md + RESEARCH.md + `git log --oneline -20`. Decide
next concrete step. Build, test, commit, push, update STATUS.md, exit. If turns running low
(~20 remaining), commit partial work with `wip:` prefix and exit.

## You have agency. Use it.

alexa authorized full autonomous execution. Install deps, create secrets, set up systemd, write
to Doppler — just do it. Document in STATUS.md. Only pause for the FORBIDDEN list.

Now: ship.

## Phase 5 — UPC Barcode Label Engine (build after Phase 3; can be parallel with Phase 4)

A self-service tool for alexa (or any admin user) to generate printable UPC barcode label sheets,
either from a specific order or from a manually-selected list of products.

### Routes

- **`/labels`** — landing page with two flows:
  - **From an order**: order picker (search by order number, customer, recent orders), review
    line items × qty, optionally edit qty per row, set options, preview, download PDF
  - **From products**: product multi-select picker (search by title/SKU/handle, paginated, filter
    by B2B publication and/or vendor), set quantity per row (default 1), set options, preview,
    download PDF
- **`/labels/preview`** (POST) — accepts labels payload + options, returns inline PDF preview
- **`/labels/print`** (POST) — accepts labels payload + options, returns `Content-Disposition: attachment` PDF

### Options (form on every label run)

- **Label size** dropdown — at minimum these Avery sheet templates:
  - `Avery 5160` — 1" × 2-5/8", 30/sheet (Letter, 3 columns × 10 rows). DEFAULT.
  - `Avery 5163` — 2" × 4", 10/sheet (Letter, 2 columns × 5 rows)
  - `Avery 5167` — 1/2" × 1-3/4", 80/sheet (Letter, 4 columns × 20 rows). Smallest, useful for collars.
  - `Avery 8195` — 2/3" × 1-3/4", 60/sheet
  - Add more templates over time as alexa requests them.
- **Show retail price** toggle (default ON)
- **Detail level** radio:
  - `Product only` — just the product title + UPC + (optional price). Used when you want a single
    label per product regardless of variant.
  - `Product + variant` — product title + variant title (e.g. "Small / Red") + UPC + (optional price)
- **Quantity** per row (in product/order list) — defaults to line-item qty for orders, 1 for products

### Data sourcing

- UPC code = Shopify variant's `barcode` field (12-digit UPC-A typical; could also be 13-digit EAN-13).
  - If barcode field is empty → skip that variant and surface a "X variants have no UPC, skipping"
    warning in the UI before generating.
- Product title = `product.title`
- Variant title = `variant.title` (use `variant.displayName` if cleaner)
- Retail price = `variant.price` (MSRP) — labels go on physical product, MSRP not B2B discount
- For "Product only" mode where a product has multiple variants: use the first variant's barcode and
  hide variant title. (Or: use product-level barcode if Shopify product has one in `product.barcode`.)

### PDF generation

- Use **pdfkit** (already a dep) for PDF layout + **bwip-js** (add as new dep) for barcodes — bwip-js
  is the most maintained Node-friendly UPC/EAN generator and outputs PNG buffers that pdfkit can embed.
- Layout per template: precompute label rect coordinates from Avery spec (margins + gutter). Draw
  each label centered within its rect:
    - Title (auto-shrink font if too long; allow 2 lines max)
    - Variant subtitle (if mode == product+variant; smaller font, gray)
    - Barcode image (centered horizontally, scaled to fit width minus 2mm padding)
    - Human-readable digits under barcode
    - Price line (right-aligned, bold) if "Show retail price" is on
- Test with a sample sheet at every commit (render a PDF, assert page size + label-count match the
  template).

### Engine architecture

Put the label engine in its own module `labels.mjs`:

```js
// labels.mjs (sketch)
import PDFDocument from 'pdfkit';
import bwipjs from 'bwip-js';

export const TEMPLATES = {
  'avery-5160': { pageW:612, pageH:792, cols:3, rows:10, labelW:189, labelH:72, marginX:18, marginY:36, gutterX:9, gutterY:0 },
  'avery-5163': { pageW:612, pageH:792, cols:2, rows:5, labelW:288, labelH:144, marginX:18, marginY:36, gutterX:18, gutterY:0 },
  // ... etc
};

export async function renderLabelSheet({ template, items, options }) {
  // items: [{ title, variantTitle?, barcode, price?, qty }]
  // options: { showPrice: bool, mode: 'product'|'product+variant' }
  // Returns a Buffer (PDF).
}

export async function barcodePng(code, opts={}) {
  return bwipjs.toBuffer({ bcid: 'upca', text: code, scale: 3, height: 10, includetext: true, textxalign: 'center' });
}
```

### UI sketch

**`/labels`** is a simple two-tab page:

```
┌─ Labels ────────────────────────────────────────────────────┐
│  [ From an order ]   [ From products ]                       │
│                                                              │
│  ┌── Pick an order ─────────────────────────────────────┐    │
│  │ Search: [ #1234 or customer name ____________  ] 🔍 │    │
│  │ Recent: • #1042 — Pawsitive Inc — Mar 12             │    │
│  │         • #1041 — Top Dog Boutique — Mar 11          │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌── Options ──────────────────────────────────────────┐    │
│  │ Label size:  [Avery 5160 (1×2⅝, 30/sheet) ▾]        │    │
│  │ ☑ Show retail price                                  │    │
│  │ ○ Product only   ● Product + variant                 │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  [ Preview ]   [ Download PDF ]                              │
└──────────────────────────────────────────────────────────────┘
```

After picking an order or products, show an editable table of items:
- Checkbox · Title · Variant · UPC · Qty (editable) · Price
- "Generate" disabled if 0 items or any qty <= 0
- "X variants missing barcode" warning visible at top if any

### Persistence

- Save the user's last-used template + options in `admin_settings` SQLite table (per-user via
  email key) so the next visit pre-fills.
- Optionally log each label batch generated to `label_batches` SQLite table (id, email, ts,
  template, item_count, total_labels) for an audit history. Skip the actual PDF blob — too big.

### Tests

- API: POST /labels/preview with mock items → returns PDF Content-Type
- API: POST /labels/print with mock order → returns PDF with attachment header
- Engine unit: rendering 30 items on avery-5160 yields exactly 1 page
- Engine unit: rendering 31 items on avery-5160 yields exactly 2 pages
- Engine unit: items with missing barcode are skipped, warning surfaced
- UI: navigate /labels → form renders, preview button works after picking products

### Acceptance for Phase 5

- alexa can navigate to /labels, pick an order, choose Avery 5160, click Download → gets a printable PDF
- alexa can switch to "From products" tab, search "luxe", multi-select 3 products, set qty 5 each → 15 labels generated
- alexa can toggle "Show retail price" and see the PDF change
- alexa can switch detail level (product vs product+variant) and see the labels change
- 15+ tests added for the engine + UI, all green

## Phase 6 — Product CSV + Image Exports (build after Phase 5; can be parallel)

Two related operator features for getting Shopify product data + media OUT of Shopify in formats
alexa can hand to vendors, photographers, accountants, marketing, etc.

### Routes

- **`/exports`** — landing page with two cards: "CSV export" and "Image export"
- **`/exports/csv`** — product picker + column selector → CSV download
- **`/exports/images`** — product picker + image option toggle → ZIP download

Reuse the same product-picker component built for Phase 5 (`/labels`). Source of truth = the B2B
publication by default (publication 199709720811), with a filter toggle to expand to "all active
products". Multi-select, search by title/handle/SKU, paginated.

### CSV export — `/exports/csv`

Default columns (all enabled, user can uncheck before generating):

- `product_handle`, `product_title`, `vendor`, `product_type`, `style` (derived from `Style_*` tag),
  `tags` (pipe-joined)
- `variant_id` (numeric Shopify id), `variant_title`, `sku`, `barcode` (UPC), `price` (MSRP),
  `b2b_price` (MSRP × 0.5), `compare_at_price`, `inventory_qty`, `inventory_policy`
- `created_at`, `updated_at`

One row per VARIANT (product info repeats for products with multiple variants). Use streaming
CSV response (don't buffer 5000 rows in memory):

```js
res.setHeader('Content-Type', 'text/csv; charset=utf-8');
res.setHeader('Content-Disposition', `attachment; filename="fww-products-${ts}.csv"`);
res.write(headerRow);
for await (const variantRow of streamVariants(productIds, columns)) {
  res.write(csvLine(variantRow));
}
res.end();
```

No new deps needed — implement CSV escape inline (`s => /[",\n\r]/.test(s) ? '"' + String(s).replace(/"/g,'""') + '"' : String(s)`).

### Image export — `/exports/images`

Two modes (radio):
- **Main photo only** — one image per product: `{handle}.jpg`
- **Main + all gallery images** — every product image: `{handle}_01.jpg`, `{handle}_02.jpg`, ...

Output: single ZIP archive. Use the `archiver` npm package (new dep) which streams to the
response. Don't buffer in memory:

```js
import archiver from 'archiver';
const zip = archiver('zip', { zlib: { level: 6 } });
res.setHeader('Content-Type', 'application/zip');
res.setHeader('Content-Disposition', `attachment; filename="fww-images-${ts}.zip"`);
zip.pipe(res);
for (const p of products) {
  for (const [i, img] of imagesForProduct(p, mode).entries()) {
    // Fetch from Shopify CDN, pipe directly into zip entry
    const r = await fetch(img.url);
    const buf = Buffer.from(await r.arrayBuffer());
    const name = mode === 'main-only'
      ? `${p.handle}${path.extname(new URL(img.url).pathname) || '.jpg'}`
      : `${p.handle}_${String(i+1).padStart(2,'0')}${path.extname(new URL(img.url).pathname) || '.jpg'}`;
    zip.append(buf, { name });
  }
}
zip.finalize();
```

Shopify Admin GraphQL for fetching all images per product:

```graphql
query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Product {
      id handle title
      featuredImage { url altText }
      images(first: 30) { edges { node { url altText } } }
    }
  }
}
```

Use `featuredImage.url` for main-only, all `images.edges[].node.url` for main+gallery.

### Image source URLs

Shopify CDN URLs come from the GraphQL response unmodified. They include the original
upload's extension (jpg, png, etc.). If the original was uploaded as PNG, the ZIP entry should
keep .png. Default to `.jpg` if extension can't be parsed.

You can request specific transforms by appending `?width=` to the URL but for these exports
**use the original** (no transform) — alexa may want full-resolution for print/photography.

### UI patterns

Mirror the `/labels` page style (two-flow tabs work here too if you want, but a simple form
that toggles "CSV vs Images" mode also works). Show a count of selected products and an estimated
file size warning ("~5 MB" for CSVs over 1000 rows, "~250 MB for image ZIPs over 500 images") so
alexa knows what's coming.

### Persistence + audit

- Save user's last-used columns + image mode in `admin_settings` SQLite table (same table as
  Phase 5's label preferences).
- Log every export to `export_batches` SQLite (id, email, ts, type='csv'|'images', product_count,
  row_or_image_count, bytes_out_approx). Optional but useful for "what did I download last week?".

### Tests

- API: GET /exports/csv?ids=mock1,mock2&cols=handle,title,sku → returns CSV with right header + N data rows
- API: GET /exports/images?ids=mock1&mode=main-only → returns Zip with N entries
- API: GET /exports/images?ids=mock1&mode=gallery → returns Zip with > N entries
- Engine unit: CSV escape handles commas/quotes/newlines in product titles
- UI: navigate /exports → both cards visible → click "CSV export" → form renders → submit → download starts
- UI: navigate /exports/images → toggle main-only ↔ gallery shows different "estimated images: X" count

### Acceptance for Phase 6

- alexa can select 50 products on /exports/csv, uncheck "compare_at_price" and "tags", click Download → gets a CSV with 200 rows (variants) and the right columns
- alexa can select 10 products on /exports/images, choose "Main + all gallery", click Download → gets a ZIP with subfolders or flat-named files for ~40 images
- Tests pass, including stream-based ones (don't load full ZIP into memory in tests; just assert headers + entry count via the archiver event)

## Phase 7 — Per-customer B2B config overrides

The /settings page already stores DEFAULTS for `b2b_discount_pct`, `b2b_min_order_usd`, and
`b2b_payment_terms`. Phase 7 adds per-customer overrides on top: any individual customer can be
configured to a different discount %, min order, and/or payment terms than the store default.

### Where the override lives

Per-customer overrides are stored as Shopify customer **metafields** (so they survive in
Shopify forever even if our SQLite is wiped):

| Metafield | Namespace | Key | Type | Default behavior |
|---|---|---|---|---|
| Discount % override | `b2b` | `discount_pct` | `number_integer` | unset → portal uses /settings default |
| Min order override | `b2b` | `min_order_usd` | `number_integer` | unset → portal uses /settings default |
| Payment terms override | `b2b` | `payment_terms` | `single_line_text_field` | unset → portal uses /settings default |

These are SEPARATE from the dropship metafields (`b2b.dropship_enabled`, `b2b.dropship_margin_pct`)
introduced earlier. Same namespace though.

### Admin UI — `/customers/:id`

Add a new section "B2B Pricing & Terms" under the existing dropship section. For each of the three
fields, show:
- **Current effective value** with a badge — either `(default)` or `(override)` — and the actual number/string.
- **Editable input** with a placeholder showing the current default.
- **Save** button (per row, or one Save at the bottom of the section — either works).
- **Reset to default** button (only visible when an override is set).

Example layout:

```
B2B Pricing & Terms
─────────────────────────────────────────────────
Discount %              [50] override   [Reset to default]   (default: 50)
Minimum order ($)       [150]           default applied      (no override)
Payment terms           [NET 30]        default applied      (no override)
                                                      [ Save changes ]
```

### Server endpoints

- `GET /api/admin/customers/:id/b2b-config` — returns current values:
  ```json
  {
    "effective":  { "discount_pct": 50, "min_order_usd": 150, "payment_terms": "NET 30" },
    "overrides":  { "discount_pct": 50, "min_order_usd": null, "payment_terms": null },
    "defaults":   { "discount_pct": 50, "min_order_usd": 150, "payment_terms": "NET 30" }
  }
  ```
- `PUT /api/admin/customers/:id/b2b-config` — body: `{ discount_pct, min_order_usd, payment_terms }`
  (null/missing = clear that override). Calls `metafieldsSet` on the Shopify customer (or
  `metafieldDelete` to clear), then audit-logs the change with before+after values.

### How it gets used by the b2b-portal

You also need to wire the portal to actually USE these overrides. This is one of the few cases
where the b2b-admin agent is authorized to also touch the `fww-b2b-portal` repo. Specifically:

1. Clone the b2b-portal repo into `/tmp/fww-b2b-portal-clone` (or use existing
   `~/projects/fww-b2b-portal` on the VPS — it's already cloned).
2. In `server.mjs` `/auth/callback`: when looking up the customer, add `metafields(namespace:"b2b")`
   to the GraphQL query. Cache the per-customer override values in the portal session.
3. In `/api/catalog`: when computing `b2bPrice`, use the customer's `discount_pct` override if set,
   else `B2B_DISCOUNT`. Note: this means catalog pricing becomes per-customer; you'll need to
   re-think the shared cache. Simplest approach: cache RAW products (with MSRP only), apply
   discount at request time per customer. The cache TTL still applies. Mark this as
   PORTAL-CACHE-CHANGE in your commit.
4. In the cart min-order check: use customer's `min_order_usd` override if set.
5. In the PDF invoice footer: use customer's `payment_terms` override if set.
6. Commit + push to b2b-portal main; restart the portal service.

If portal changes feel too risky to do alongside admin work, **build only the admin write side
in Phase 7** and leave portal-side reading for a follow-up phase. Set a clear
`PORTAL-PENDING` note in STATUS.md so alexa knows the override exists on the customer record
but isn't being consumed yet.

### Tests

- API: PUT /api/admin/customers/:id/b2b-config writes correct metafieldsSet payload (mock)
- API: PUT with null/missing fields → metafield deletes (mock)
- API: GET returns combined effective/overrides/defaults
- UI: customer detail page shows current effective + override status, edit/save round-trips
- Audit log row created with before+after

### Acceptance for Phase 7

- alexa opens /customers/:id for a customer, sees current effective values (default or override)
- alexa changes "Discount %" to 60 → saves → reload shows "(override)" badge with 60%
- alexa clicks "Reset to default" on discount → metafield deleted → "(default)" badge returns
- (if portal updated) the customer logs into b2b.fuzzyreporting.com → sees 60%-off pricing instead of 50%-off
- All actions audit-logged

---

## Phase 8 — Label engine: 10 templates + checkbox field selection

Extends Phase 5. The current engine has 4 Avery sheet templates and a binary product/variant
toggle. Phase 8 expands to 10 templates total (5 Avery sheets + 5 thermal singles) and replaces
the binary detail toggle with a 6-checkbox field selector.

### Templates to support (all 10)

**Avery sheet templates** (multi-label PDFs, US Letter):

| Avery # | Dimensions | Labels/sheet | Layout |
|---|---|---|---|
| 5160 | 1" × 2⅝" | 30 | 3 cols × 10 rows (DEFAULT) |
| 5161 | 1" × 4" | 20 | 2 cols × 10 rows |
| 5163 | 2" × 4" | 10 | 2 cols × 5 rows |
| 5167 | ½" × 1¾" | 80 | 4 cols × 20 rows |
| 8195 | ⅔" × 1¾" | 60 | 4 cols × 15 rows |

**Thermal single templates** (one label per PDF page, page size = label size):

| Name | Dimensions | Typical use |
|---|---|---|
| `thermal-4x6` | 4" × 6" | Shipping (Zebra/Rollo/Dymo 4XL/Munbyn) |
| `thermal-2.25x1.25` | 2¼" × 1¼" | Small product/barcode (Dymo 30334) |
| `thermal-2x1` | 2" × 1" | Tight retail barcode |
| `thermal-3x2` | 3" × 2" | Warehouse organization |
| `thermal-2x2` | 2" × 2" | Square branding+barcode |

Page dimensions for thermal templates = the label dimensions (in points, 72/inch). Each PDF
page contains exactly one label, sized to fill the page with a small inner margin (~2-3mm).

Add a `type: 'sheet' | 'thermal'` flag on each template in the `TEMPLATES` map so the engine
can branch its layout logic.

### Field selection UI — replaces the existing binary toggle

Replace the current "Show retail price" toggle + "Product only / Product + variant" radio with
a **checkbox group** labeled "Include on label". Six checkboxes:

```
Include on label:
  ☑ Product name
  ☑ Variant name
  ☑ Retail price (MSRP)
  ☐ SKU
  ☑ UPC barcode (graphic)
  ☑ UPC digits (12-digit human-readable text)
```

Defaults: Product name, Variant name, MSRP, UPC barcode, UPC digits. SKU off by default.

If the user unchecks all → save button disabled with hint "Pick at least one field."

If the user unchecks both UPC options → still allowed (useful for non-barcoded labels like a
plain product-name tag).

### Layout rules

For each label rectangle (sheet or single thermal page):

1. Stack enabled fields vertically:
   - **Product name** (bold, auto-shrink to fit; max 2 lines truncating with `…`)
   - **Variant name** (smaller font, gray)
   - **UPC barcode graphic** (centered horizontally, scaled to fit width with a 2-3mm margin)
   - **UPC digits** (centered under barcode in monospace font; only shown if both barcode AND
     digits enabled — barcode without digits is allowed, digits without barcode is allowed)
   - **SKU** (smaller, gray, prefixed "SKU: ")
   - **MSRP** (right-aligned, bold, prefixed "$")

2. Auto-shrink fonts when content overflows.

3. Spacing: ~2mm vertical between elements.

4. Thermal templates with very small dimensions (2×1, 2.25×1.25) may not fit all 6 fields. In
   that case, render what fits in priority order: barcode → product name → MSRP → digits → variant → SKU. Surface a "Some fields don't fit on label X" warning in the UI before generating.

### Persistence

Save user's last-used template + field selection in `admin_settings` per email (already done
for the template; just add a `label_fields_json` column).

### Engine changes (`labels.mjs`)

- Update `TEMPLATES` map: add 5 new entries with their exact dimensions in points (72 pt = 1 in).
- Add `type` field per template (`'sheet'` or `'thermal'`).
- Update `renderLabelSheet` to branch on template type:
  - Sheet: existing grid logic
  - Thermal: page-per-label, page size = label size, single centered label
- Update label rendering function to take a `fields` object: `{ productName, variantName, msrp, sku, upc_barcode, upc_digits }` (all booleans).
- Compute the layout from the enabled subset.

### Tests (extend existing label tests)

- Engine: renders correctly for each of the 10 templates with a 3-item input
- Engine: page count matches template (1 page per item for thermal, ceil(n/per-sheet) for sheets)
- Engine: with only `{ msrp: true }` enabled → label shows only price (no barcode, no name)
- Engine: with only `{ upc_barcode: true }` → label shows only barcode
- Engine: missing barcode + only barcode enabled → label shows fallback text + warning
- UI: /labels page shows 10 templates in dropdown
- UI: 6 checkboxes render and persist via admin_settings
- UI: unchecking all checkboxes disables Generate button

### Acceptance for Phase 8

- alexa can pick any of the 10 templates from a dropdown labeled "Label size"
- alexa can independently toggle 6 fields on each label
- For a sheet template: alexa downloads a multi-label PDF
- For a thermal template: alexa downloads a one-label-per-page PDF at the exact label dimensions
- Settings persist between visits per user
- All tests green
