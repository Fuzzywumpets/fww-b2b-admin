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

## Phase 9 — Show real customer + order data (broaden default scope)

The admin pages currently filter very narrowly (only orders tagged `b2b-portal`, only customers
tagged `b2b`), so they're nearly empty in production because the portal just launched. alexa
wants to use the admin against REAL existing data — SparkLayer orders, retail orders, all
historical customers — so she can iterate on the invoice print tool, manual order workflow,
etc. against real volume.

### `/admin/orders` — show ALL Shopify orders by default, filter by source

- Change default Shopify query in `/api/admin/orders` from `tag:b2b-portal` to `""` (no filter)
  → returns all orders, most recent first (sortKey: PROCESSED_AT, reverse: true).
- Add **filter chips** above the orders table (UI clickable, also bind to `?source=` query):
  - **All** (default, no filter)
  - **B2B portal** — `tag:b2b-portal`
  - **SparkLayer** — `tag:sparklayer*` (verify exact tag pattern by sampling a SparkLayer order
    via shopify-bridge; document the actual signal in SCRATCH.md)
  - **POS** — `source_name:pos`
  - **Manual / draft** — `source_name:draft_order`
- Per-row badge column showing source (B2B / SparkLayer / POS / Online / Manual / Other) derived
  from order.tags + order.app + order.sourceName. One small colored chip per row.
- Pagination stays 50/page; cursor-based against Shopify.
- The bulk actions (mark paid, add note) MUST still work on ALL orders, not just b2b-portal ones.
  If they previously had a "must be tagged b2b-portal" check, remove that.

### `/admin/customers` — show ALL customers, highlight by tag

- Change default query in `/api/admin/customers` from `tag:b2b` to `""` (all customers), sorted
  by `total_spent` desc (highest-spend first — best signal for "who matters").
- Add filter chips:
  - **All** (default)
  - **B2B-tagged** — `tag:b2b`
  - **SparkLayer** — `tag:sparklayer*`
  - **Has orders** — `orders_count:>0`
  - **No orders** — `orders_count:0` (gives alexa a list of accounts to clean up or chase)
- Per-row tag badges: green for `b2b`, blue for `sparklayer*`, gray for `b2b-admin`,
  gold/star for `b2b-tier:gold`, etc. Show up to 3, "+N more" tooltip.
- Lifetime spend column stays.

### Invoice + PDF on ANY order

- Verify `/admin/orders/:id/invoice.pdf` works for orders WITHOUT the `b2b-portal` tag. If there's
  a tag check, remove it (alexa needs to invoice a SparkLayer order, a POS order, etc.).
- PDF should pull the actual order's `note` field, payment terms from the customer's
  `b2b.payment_terms` metafield (Phase 7) or fall back to default. MSRP and line items come
  straight from order line items (NOT recomputed from customer pricing — preserve historical
  pricing).
- Add a "Print invoice" toolbar action visible on every order detail page.

### Filter persistence

Save the most-recently-used filter chip per user in `admin_settings` so reloading `/admin/orders`
returns to the same view. Trivial change once the filter state is wired.

### Tests

- API: GET /api/admin/orders → 50 orders, mixed sources
- API: GET /api/admin/orders?source=sparklayer → only orders tagged sparklayer*
- API: GET /api/admin/orders?source=pos → only POS orders
- API: GET /api/admin/customers → returns customers sorted by total_spent
- API: GET /api/admin/orders/:id/invoice.pdf works on a non-b2b-portal-tagged order
- UI: filter chips render, clicking each updates table
- UI: source badges render per row

### Acceptance

- alexa opens /admin/orders → sees recent real orders from all sources (not empty)
- alexa filters to "SparkLayer" → sees historical SparkLayer wholesale orders
- alexa clicks any historical order → can download a PDF invoice
- alexa opens /admin/customers → sees actual customer list, sorted by spend, with tag badges
- alexa picks a high-spend customer with no `b2b` tag → can add the tag from customer detail page

## Phase 10 — Per-customer config (REFINES Phase 7)

alexa's clarified the exact 3 (well, 4) per-customer fields she wants on `/admin/customers/:id`.
This supersedes the Phase 7 "per-customer overrides" list. Specifically:

- **DROP** from Phase 7: `min_order_usd` and `payment_terms` are NOT per-customer; they stay as
  global defaults in `/settings`.
- **KEEP** from Phase 7: `discount_pct` per-customer override.
- **KEEP** from Phase 2 (already shipped): `dropship_enabled` + `dropship_margin_pct`.
- **NEW**: `allow_order_on_invoice` boolean.

### The 4 per-customer fields (final spec)

| Field | Type | Metafield | Default | UX |
|---|---|---|---|---|
| Discount % | integer 0–95 | `b2b.discount_pct` | 50 (from /settings) | numeric input + "Reset to default" |
| Drop-ship allowed | boolean | `b2b.dropship_enabled` | false | toggle |
| Drop-ship discount % | integer 0–95 | `b2b.dropship_margin_pct` | 30 | numeric input (only enabled when toggle on) |
| Allow order on invoice | boolean | `b2b.allow_order_on_invoice` | true | toggle |

Group all four into a single "B2B Customer Settings" section on `/admin/customers/:id`. Single
"Save" button at the bottom of the section. Audit-log on save with full before/after.

### Help text per toggle (visible under each input)

- **Discount %**: "What percent off MSRP this customer pays. Default 50% comes from store settings."
- **Drop-ship allowed**: "If on, this customer can choose to ship orders directly to their end
  customer at checkout. Useful for resellers who don't carry inventory."
- **Drop-ship discount %**: "Discount applied on drop-ship orders only (separate from standard
  discount above). Typical 25–35% since FWW handles the fulfillment."
- **Allow order on invoice**: "If on, the customer can place orders without paying upfront —
  we invoice them. If off, they must pay at checkout."

### Portal-side wiring (cross-repo, authorized for this loop)

The b2b-portal repo at `~/projects/fww-b2b-portal` already exists on the VPS — touch it for
these specific changes:

1. **Auth callback** (`server.mjs` `/auth/callback`): when looking up the customer, also fetch
   `metafields(namespace:"b2b", first:10)`. Parse the 4 values into the session:
   `req.session.b2b = { discount_pct, dropship_enabled, dropship_margin_pct, allow_order_on_invoice }`.
   Use defaults when missing.

2. **Catalog pricing** (`/api/catalog`): instead of `applyDiscount(price)` using `B2B_DISCOUNT`,
   use `session.b2b.discount_pct` (effective). NOTE: this breaks the simple shared cache. Two
   options:
   - **Cache RAW products** (with MSRP only); apply per-customer discount on each request from
     the cached raw catalog. Simple + fast.
   - Or: separate cache per discount-rate bucket (e.g., 50% bucket vs 45% bucket vs 60% bucket).
     More complex; not worth it unless there are many distinct rates.
   Recommended: option A. The cache layer was just added in commit `99e2aba` — refactor to
   store raw products in `catalogCache.rawProducts` and apply discount at `/api/catalog` request time.

3. **Checkout flow** (`/checkout` + `/api/checkout`):
   - If `!session.b2b.allow_order_on_invoice`: replace the "Place order on invoice" submit
     button with a message: "Online checkout for your account requires upfront payment. We
     don't have card processing built yet — please email wholesale@fuzzywumpets.com to place
     this order, or contact us to enable invoiced orders on your account."
   - If `session.b2b.dropship_enabled`: above the shipping address section, show a toggle
     "Drop-ship this order?" When on, reveal end-customer fields (recipient name, addr1/2,
     city, state, zip, country, phone) AND an optional gift message textarea. On submit,
     order's `shippingAddress` = end-customer; `billingAddress` = wholesale customer;
     add tag `b2b-dropship`; set note `Drop-ship for {customer.displayName}`. Apply
     `dropship_margin_pct` to line item prices INSTEAD of `discount_pct`.

4. **Cart min-order display** (`/cart`): can stay using global default for now; alexa explicitly
   said min order is NOT per-customer.

### Admin UI flow

`/customers/:id` page should have these sections (in order):

```
[ Customer profile — name, email, phone, tags editor ] (existing)
[ B2B Customer Settings ]                              (Phase 10 — NEW SECTION)
    Discount %               [50]   default applied   [Reset]
    Drop-ship allowed        [○ off]
    Drop-ship discount %     [30]   (disabled while drop-ship is off)
    Allow order on invoice   [● on]
                             [ Save changes ]
[ Internal notes ]                                     (existing from Phase 2)
[ Recent orders ]                                      (existing)
```

When "Drop-ship allowed" toggle is off, the "Drop-ship discount %" input should be visually
disabled (gray, ignoring input) but its value preserved (so toggling back on restores the saved
margin %).

### Tests

- API: PUT /api/admin/customers/:id/b2b-config writes the 4 metafields correctly
- API: PUT with `dropship_enabled: false` does not delete `dropship_margin_pct` (preserve)
- API: GET returns all 4 values with effective/override/default for each
- API: PUT with `allow_order_on_invoice: false` writes the metafield as boolean
- UI: toggling drop-ship off greys the discount input
- UI: clicking Reset on discount → metafield deleted → "default applied" badge returns
- Portal: customer with `allow_order_on_invoice: false` sees the "contact us" message at checkout
- Portal: customer with `dropship_enabled: true` sees the drop-ship toggle on checkout
- Portal: order created with drop-ship has the right shipping/billing split + tags + note

### Acceptance

- alexa opens any customer's detail page → sees the 4-field B2B Settings section with current
  values + reset buttons
- alexa changes a customer's discount to 40% → saves → customer logs into portal → sees
  60%-of-MSRP pricing (40% off)
- alexa toggles drop-ship on for a customer + sets 30% margin → customer sees drop-ship
  option at checkout that asks for end-customer address
- alexa toggles "Allow order on invoice" off for a customer who's been slow paying → customer
  hits checkout and sees the "contact us" message instead of the invoice button
- All actions audit-logged. Tests green.

## Phase 11 — Payment methods at checkout (research + phased plan)

The b2b portal currently has ONE checkout path: create a Shopify draft order marked unpaid, which
the customer hits via a "Place order on invoice" button (gated by Phase 10's
`allow_order_on_invoice`). alexa wants multiple payment methods at the customer-facing checkout.

This phase is **mostly research + scoping** plus the first easy build. Each payment method maps
to a small spec the agent can implement once alexa decides which to ship and after she's set up
any required merchant accounts.

### Payment method comparison (current as of 2026)

| Method | Card/ACH fees (2026) | Integration effort | Merchant account needed |
|---|---|---|---|
| **Invoice (NET)** | 0% | TRIVIAL (already partly built) | none |
| **Zelle "pay-on-trust"** | 0% (P2P) | EASY (~1 day) | Chase Business already has Zelle |
| **Stripe** (unlocks cards + Apple Pay + Google Pay + ACH) | 2.9% + $0.30 cards; **$5 flat ACH for $1k+** | MEDIUM (~3 days) | new Stripe account |
| **PayPal Checkout** | 3.49% + $0.49 cards; **1% capped $10 ACH via PayPal Invoicing** | EASY (~2 days) | existing PayPal Business account |
| **Amazon Pay** | 2.9% + $0.35 (US); +20–30% conversion via trusted brand | EASY (~2 days) | new Amazon Pay merchant |
| **Shop Pay** (Shopify Pay) | 2.9% + $0.30, but only via Shopify Checkout redirect | EASY (~1 day) — redirect-based | existing Shopify Payments |
| **Chase Payment Solutions** | TBD | UNAVAILABLE — wait for GA | n/a yet |

Sources: searches 2026-05-26 (PayPal/Stripe/Amazon Pay 2026 fee comparisons; Chase Developer
portal status — currently only Account Data Sharing APIs, not merchant payment APIs).

### Recommended phased rollout (build in this order)

#### Phase 11A — Zelle pseudo-flow (build first; no SDK, no merchant setup)

- 0% fees, alexa already accepts Zelle via Chase Business.
- No JS SDK; this is a "manual reconciliation" flow.
- At checkout: new "Pay via Zelle" radio option. Selecting it shows:
  ```
  Send $XXX.XX via Zelle to wholesale@fuzzywumpets.com
  Include "Order #XXXX" in the memo.
  Your order is reserved for 72 hours pending receipt of payment.
  ```
- On submit: creates Shopify order, `financialStatus=PENDING`, tagged `payment:zelle-pending`,
  note "Awaiting Zelle from {email}, order placed {timestamp}".
- alexa marks paid in admin once she sees the Zelle hit her bank (existing mark-paid flow).
- **Effort**: ~1 day. Pure copy + tagging logic.

#### Phase 11B — Stripe (cards + Apple Pay + Google Pay + ACH in one shot)

- ONE integration unlocks 4 payment methods. Best ROI.
- Recommended: **Stripe Payment Element** (modern, one-line embed). Renders cards + Apple Pay +
  Google Pay + Link automatically based on customer's device.
- **ACH support is the killer feature for B2B**: $5 flat fee on $1k+ orders vs 2.9% on cards
  saves alexa real money on wholesale-sized invoices.
- Flow:
  1. Customer hits /checkout, picks "Credit card / Apple Pay / Google Pay" tab → loads Stripe
     Payment Element
  2. Customer enters card / selects digital wallet
  3. On submit, our server creates a Stripe PaymentIntent for the cart total
  4. Stripe processes payment, webhook fires → server creates Shopify order with
     `financialStatus=PAID`
- **What alexa needs to do**: create a Stripe account (~10 min, free), share publishable + secret
  keys → I push to Doppler as `B2B_PORTAL_STRIPE_PK` + `_SK`.
- **Effort**: ~3 days for full flow + webhook + tests.

#### Phase 11C — PayPal Checkout

- Most-recognized button after digital wallets.
- Mature JS SDK: `<script src="https://www.paypal.com/sdk/js?client-id=...&components=buttons">`
- Renders a PayPal button → user pays in popup → callback returns order id → server captures →
  Shopify order created `PAID`.
- alexa already has a PayPal Business account (per memory `convention_shopify_paypal_categorization`)
- **Effort**: ~2 days.
- Note: PayPal's "Pay in 4" / BNPL options come for free with the same SDK if enabled.

#### Phase 11D — Shop Pay (lightest weight, but redirects out)

- Easy because Shopify's hosted checkout already accepts Shop Pay.
- Implementation: instead of customer paying in portal, redirect to Shopify's hosted draft-order
  checkout URL (we already create the draft order). Shop Pay button appears there alongside
  other methods Shopify supports.
- Pro: zero new integration; leverages Shopify Payments PCI compliance.
- Con: customer leaves our domain briefly during checkout. UX feels less integrated.
- **Effort**: ~1 day. Just a "Pay via Shopify checkout" button that opens the draft order's
  `invoiceUrl`.

#### Phase 11E — Amazon Pay (later, optional)

- 20-30% conversion lift per merchant data, but requires Amazon Pay Business account setup.
- JS SDK + server-side checkout-session creation.
- Worth doing once Stripe + PayPal + Zelle + Invoice are live and we want one more option.
- **Effort**: ~2-3 days.

#### Phase 11F — Chase Payment Solutions (deferred — not GA yet)

- Chase Developer portal currently exposes Account Data Sharing APIs (banking), NOT a merchant
  checkout API for browser modal flows.
- Chase Paymentech (the older gateway) requires a full gateway integration (Orbital, etc.) and
  is complex/legacy.
- Action: **monitor https://developer.chase.com/ quarterly** for a public "Chase Pay" merchant
  SDK launch. When it ships, file a new Phase to integrate.
- Until then, do not build against the older Paymentech gateway.

### Checkout UI changes (applies to all options above)

Replace today's single "Place order on invoice" button with a payment-method picker:

```
┌─ Payment method ─────────────────────────────────┐
│  ◯ Pay later (invoice)           NET 30 default  │  ← only if allow_order_on_invoice
│  ◯ Credit card / Apple Pay / Google Pay (Stripe) │
│  ◯ PayPal                                        │
│  ◯ Zelle                                         │
│  ◯ Shop Pay (Shopify checkout)                   │
└──────────────────────────────────────────────────┘
[ Place order — $XXX.XX ]
```

Per-option visibility rules:
- "Invoice" only if `customer.allow_order_on_invoice` (Phase 10)
- "Zelle" / "PayPal" / "Stripe" / "Shop Pay" — show for everyone with the relevant accounts set up

Server endpoint pattern: `POST /api/checkout?method={invoice|stripe|paypal|zelle|shoppay}` →
branch based on method → orchestrate the right flow.

### What alexa needs to set up (in order)

1. **Zelle** — already have via Chase Business. No setup. (0 minutes)
2. **Stripe account** — go to https://stripe.com/register, ~10 min signup. Give me the publishable
   + secret keys (I push to Doppler). (10 minutes)
3. **PayPal Developer app** — alexa already has PayPal Business. Go to
   https://developer.paypal.com → My Apps → create REST API app → get client_id + secret. (~10 minutes)
4. **Amazon Pay** — only if she wants it. Apply at https://pay.amazon.com/signup. (1-2 days for approval)

### Acceptance for Phase 11 (research-only completion)

- Document checked in: this section in HANDOFF.md
- alexa confirms which methods to actually build (recommend: Invoice ✓ already, Zelle next, then
  Stripe, then PayPal, then Shop Pay as cheap addition)
- Future Phases 11A-F each ship one method when alexa has set up the corresponding merchant account

## Phase 11 — REVISION (ACH-only constraint)

**alexa's decision 2026-05-26:** Stripe and PayPal are only acceptable if we can RESTRICT them
to ACH-only. Her existing Chase merchant account has much lower CC fees than Stripe (2.9%+30¢)
or PayPal (3.49%+49¢), so any credit-card processing stays at Chase (handled out-of-band for
now until Chase's checkout API GA).

This drops several options from the earlier Phase 11 plan. Revised payment methods:

### IN — methods to build (all 0–1% fees)

| # | Method | Fees | Effort | Why it survives |
|---|---|---|---|---|
| 1 | **Invoice (NET terms)** | 0% | already partly built | direct, no third party |
| 2 | **Zelle pseudo-flow** | 0% | ~1d | Chase Business already has Zelle |
| 3 | **Stripe ACH** (`us_bank_account` only) | 0.8% capped at $5 | ~2d | massive savings on B2B-sized orders |
| 4 | **PayPal Invoicing** (ACH only via invoice link) | 1% capped at $10 | ~1d | leverages existing PayPal Business |

### OUT — methods to NOT build

- ❌ **Stripe Payment Element with cards** — would default to CC; we'd be paying 2.9% instead of Chase's lower rate
- ❌ **Apple Pay / Google Pay** — these tokenize a credit card. Same problem.
- ❌ **PayPal Checkout** (regular) — defaults to CC fallback if PayPal balance is insufficient
- ❌ **Shop Pay** — runs through Shopify Payments at 2.9%+30¢, not Chase
- ❌ **Amazon Pay** — CC-based
- ❌ **Chase Payment Solutions** — still deferred (no GA merchant API)

### How to actually constrain Stripe to ACH only

Set up the PaymentIntent with explicit method restriction. Stripe's API:

```js
const intent = await stripe.paymentIntents.create({
  amount: cents,
  currency: 'usd',
  payment_method_types: ['us_bank_account'],          // EXPLICIT: only ACH
  payment_method_options: {
    us_bank_account: {
      verification_method: 'instant',                  // Plaid/Financial Connections (instant)
      financial_connections: { permissions: ['payment_method'] }
    }
  },
});
```

On the front-end, Stripe Elements (`paymentElement` with `paymentMethodTypes: ['us_bank_account']`)
renders ONLY the bank-account flow — no card field visible at all. Customer connects bank via
Stripe's Plaid integration (Financial Connections), authorizes the debit, and we capture.

ACH verifications take 1-2 business days unless using Stripe's Financial Connections (then it's
instant). Either way the order can be created on submit with `financialStatus=PENDING` until
the bank transfer settles.

### How to actually constrain PayPal to ACH only

This is harder. PayPal Checkout's standard JS button always includes card fallback. **The
workaround is to skip PayPal Checkout entirely and use PayPal Invoicing.**

PayPal Invoicing flow:
1. Customer hits "Pay via PayPal Invoice" at checkout
2. Our server creates a Shopify draft order (financialStatus=PENDING)
3. Our server calls PayPal Invoicing API: `POST /v2/invoicing/invoices` to generate an invoice
4. PayPal emails the customer (or we can show the invoice link in-app)
5. Customer opens the PayPal invoice and selects "Pay by bank" → 1% capped $10
6. We webhook on `INVOICING.INVOICE.PAID` → mark Shopify order PAID

The customer CAN still pay the PayPal invoice with a card, BUT the prominent option on PayPal's
invoice page is "Pay by bank" (ACH). To strongly steer them: include a note in the invoice
description saying "ACH bank transfer preferred to save processing fees."

### How to actually constrain Zelle (already inherently 0%)

No changes needed — Zelle is peer-to-peer 0%. The pseudo-flow remains: customer selects Zelle,
sees instructions, manually pays to wholesale@fuzzywumpets.com, alexa marks paid in admin.

### Revised checkout UI

```
┌─ Payment method ─────────────────────────────────────────┐
│  ◯ Pay later (invoice)                NET 30 default     │ ← if allow_order_on_invoice
│  ◯ Zelle                              free, manual        │
│  ◯ Bank transfer (Stripe ACH)         0.8% capped $5      │
│  ◯ PayPal Invoice (ACH)               1% capped $10       │
│                                                            │
│  Cards: please contact us — wholesale@fuzzywumpets.com    │
└────────────────────────────────────────────────────────────┘
```

(The fee labels visible to the customer can be hidden — that's internal info. UI just shows the
method names.)

### Setup needed (alexa)

1. **Zelle** — already done
2. **Stripe account** — sign up at https://stripe.com/register (~10 min). Tell me when done; I'll
   grab pk/sk and push to Doppler. Enable **Financial Connections** in dashboard for instant
   bank verification (free).
3. **PayPal Developer app** — your PayPal Business has Invoicing built in; just need REST API
   client_id+secret from https://developer.paypal.com → My Apps. (~10 min)

### Acceptance for revised Phase 11

- 4 payment methods visible at checkout (when their merchant setup is done)
- Stripe ACH option only shows bank-account flow (no card UI ever)
- PayPal Invoicing option creates a PayPal invoice and links the customer to pay
- All methods create the Shopify order with appropriate financial status
- Webhook handling for Stripe + PayPal sets order to PAID once funds settle
- Cards stay routed to Chase out-of-band — UI explicitly tells the customer to contact for CC

## Phase 12 — Prompt-pay discount + Zelle auto-reconciliation

Two related additions to the payment system from Phase 11 (revised).

### 12A — 3% prompt-pay discount

Encourage customers to pay immediately via low-fee methods (Stripe ACH or Zelle) instead of
taking the NET-30 invoice. The discount is conditional on BOTH:
- Payment completes upon order (not deferred / invoiced)
- Method is **Stripe ACH** OR **Zelle**

(Specifically NOT: invoice/NET, PayPal Invoicing where payment lands later via email link, or
any future card method. The discount is for IMMEDIATE pay-at-checkout via low-fee rails only.)

#### Settings

In `/settings`, add two fields:

- **`prompt_pay_discount_pct`** (integer, default 3) — the percent off subtotal
- **`prompt_pay_enabled`** (boolean, default true) — global toggle

In `/customers/:id` B2B Settings (Phase 10's section), add ONE optional override:

- **`block_prompt_pay_discount`** (boolean override, default unset → inherits global setting) —
  use case: customer is on bad terms / abusing the discount → admin turns it off for them.
  Persisted as metafield `b2b.block_prompt_pay_discount`.

#### Checkout UX

When the customer picks "Bank transfer (Stripe ACH)" or "Zelle" at checkout, the order total
updates dynamically to show:

```
Subtotal:                          $1,250.00
Prompt-pay discount (3%):           −$37.50
Total:                             $1,212.50
```

For Invoice / NET / PayPal Invoicing methods, the discount line disappears and total returns
to subtotal.

A help tooltip next to the discount line: "Save 3% by paying immediately via ACH or Zelle.
Available on bank transfers and Zelle only."

#### Server logic

When the order is created (`POST /api/checkout`), compute:

```js
const eligible = settings.prompt_pay_enabled
              && !customer.block_prompt_pay_discount
              && (method === 'stripe_ach' || method === 'zelle');
const discountPct = eligible ? settings.prompt_pay_discount_pct : 0;
const discountAmount = subtotal * (discountPct / 100);
```

Apply as a Shopify discount line on the order (use `draftOrderCreate` with
`appliedDiscount: { value: discountPct, valueType: 'PERCENTAGE', title: 'Prompt-pay (ACH/Zelle)' }`).

**Critical for Zelle**: the discount is applied OPTIMISTICALLY at order creation, but the order
is `financialStatus=PENDING` until Zelle is verified. If Zelle never arrives within the
reservation window (default 72 hours), the order gets voided entirely — discount goes away with
it. No "remove the discount but keep the order" partial state.

For Stripe ACH: same optimism. Order pending until ACH settles (instant via Financial
Connections, otherwise 1-2 business days). If ACH fails, order voids.

#### Tests

- Customer picks Stripe ACH → discount applied
- Customer picks Zelle → discount applied
- Customer picks Invoice → no discount
- Customer picks PayPal Invoicing → no discount
- Customer with `block_prompt_pay_discount=true` → no discount on any method
- Settings discount = 5 → applies 5% instead of default 3%
- Settings `prompt_pay_enabled=false` → no discount for anyone

---

### 12B — Zelle auto-reconciliation via Gmail (extend bill scanner)

#### The problem

Zelle has no merchant API, webhook, or reconciliation endpoint. The order arrives unpaid; alexa
has to check Chase manually and mark paid. That's friction we can remove.

#### The solution

**Chase sends an email to your business email every time a Zelle payment hits.** Your existing
`fww-bill-scanner` project on fww-vps-1 already watches Gmail + processes structured data from
emails via Claude. Extend it (or build a sibling) to watch for Zelle-receipt emails and
auto-mark matching b2b orders paid.

#### How it works

1. Customer places order at b2b portal, picks Zelle → order created with:
   - `financialStatus: PENDING`
   - `tag: payment:zelle-pending`
   - `note: "Awaiting Zelle from {customer.email}, expected $XXX.XX, order #YYYY"`
2. Customer goes to their bank app, sends Zelle to `wholesale@fuzzywumpets.com` (or whatever
   alias alexa picks). Memo: `Order #YYYY`.
3. Chase sends an email: *"You received a Zelle payment of $XXX.XX from {customer name}"*.
4. fww-bill-scanner Gmail watcher catches the email (subject pattern: `received a Zelle payment`).
5. Claude parses: amount, sender name+email, memo (extract order #), date.
6. Watcher calls b2b-admin: `POST /api/admin/zelle/reconcile` with the parsed payload.
7. b2b-admin queries pending orders tagged `payment:zelle-pending` with matching amount +
   (if memo had order #) matching order name.
8. Match found → mark order `PAID` via `orderMarkAsPaid` mutation → add note "Auto-reconciled
   from Zelle email at {ts}" → audit-log.
9. No match → escalate: tag the Zelle email "needs-review" and add to a `/admin/zelle/unmatched`
   queue for alexa to manually reconcile.

#### What changes in each codebase

**fww-bill-scanner** (existing project at `~/projects/fww-bill-scanner` on VPS):
- Add new email handler: `chase-zelle-handler.mjs`
- Subject filter: regex match on Chase's Zelle-received subject template (sample needed; alexa
  can forward a recent Zelle-received email so we know the exact format)
- Claude prompt: extract { amount_usd, sender_name, sender_email, memo, received_at }
- POST result to `https://b2badmin.fuzzywumpets.com/api/admin/zelle/reconcile` with shared
  bearer token (new Doppler secret `B2B_ADMIN_ZELLE_RECONCILE_TOKEN`)

**fww-b2b-admin**:
- New endpoint: `POST /api/admin/zelle/reconcile` (bearer auth, not Google OAuth — server-to-
  server from bill scanner)
- Matching logic: scan SQLite `orders_log` (or Shopify directly) for orders with tag
  `payment:zelle-pending`, financialStatus PENDING, and (a) amount matches within ±$0.50,
  AND (b) if memo included order #, that takes priority
- On match: call `orderMarkAsPaid` via shopify-bridge, update tag from `pending` to `received`,
  add note, audit-log
- On no match / multiple ambiguous matches: respond 200 with `{ status: 'queued_for_review' }`
  + insert into `zelle_unmatched` SQLite table for `/admin/zelle/unmatched` review page

#### Build sequence

1. **First**: alexa forwards a recent Chase Zelle-received email so we know the exact subject
   + body format
2. **Second**: extend bill-scanner with the new handler (~half day)
3. **Third**: add /api/admin/zelle/reconcile + admin queue page (~half day)
4. **Fourth**: end-to-end test — send yourself a small Zelle, verify auto-reconcile

#### Acceptance for Phase 12B

- A Zelle payment lands in Chase → email arrives → within 5 min, matching b2b order is
  auto-marked paid in admin with note "Auto-reconciled from Zelle email"
- Unmatched Zelle payments show up at `/admin/zelle/unmatched` for manual review (alexa picks
  the matching order, clicks "Reconcile to this order")
- alexa never has to manually mark a Zelle order paid in the happy path

## Phase 13 — Final payment spec (supersedes 11, 11-rev, 12)

alexa's decision 2026-05-26: drop Zelle + PayPal entirely. Assume Chase Merchant Services API
will eventually handle both invoice links and on-screen card payments. Stub those workflows
in the UI now so the experience is in place; wire to real Chase API once it ships (deferred).

### Final payment method matrix

| # | Method | Provider | Fees | Status |
|---|---|---|---|---|
| 1 | Pay later (invoice / NET) | Internal | 0% | mostly built |
| 2 | Bank transfer (ACH) | **Stripe today, Chase later** (swap when GA) | 0.8% capped $5 (Stripe) | build now via Stripe |
| 3 | Card payment (Chase Pay Now modal) | Chase MS | TBD (alexa's existing merchant rate) | **STUB the UI; backend wiring deferred** |
| 4 | Chase invoice link (admin-sent) | Chase MS | same as #3 | **STUB the admin button; backend wiring deferred** |

**Dropped from earlier phases:** Zelle (any flow), PayPal Invoicing, Apple/Google Pay, Amazon
Pay, Shop Pay. Reasons recorded in HANDOFF history; do not re-add without alexa's say-so.

### Customer-side checkout `/checkout` UI

Replace today's single "Place order on invoice" button with this picker:

```
┌─ Payment method ─────────────────────────────────────────┐
│                                                          │
│  ◯ Pay later (invoice)                                   │ ← only if allow_order_on_invoice
│     We'll send you a NET 30 invoice. No upfront payment. │
│                                                          │
│  ◯ Bank transfer (ACH)                  Save 3% now      │
│     Connect your bank, pay direct. Usually instant       │
│     verification via Stripe's Plaid integration.         │
│                                                          │
│  ◯ Pay with card (Chase)                                 │
│     Visa / Mastercard / Amex / Discover                  │
│     (coming soon — pending Chase API enablement)         │ ← STUB
│                                                          │
└──────────────────────────────────────────────────────────┘

[ Place order — $XXX.XX ]
```

Visibility rules per method:
- **Invoice**: visible only if `customer.allow_order_on_invoice` is true
- **ACH**: visible if `B2B_PORTAL_STRIPE_PK` is configured (Doppler). If not configured, hide.
- **Card via Chase**: ALWAYS VISIBLE (as a stub) — clicking opens a placeholder modal:
  ```
  Card payments coming soon
  We're finalizing our Chase merchant integration. For now, please contact
  us at wholesale@fuzzywumpets.com to pay by credit card.
  [ OK ]
  ```
  When Chase API is wired, this stub becomes the real flow.

### Admin order detail — "Send Chase invoice link" button (stub)

On `/admin/orders/:id`, in the actions toolbar, add a button: **"Send Chase invoice link"**.

Clicking it (today, stub mode):
- Shows a confirm dialog: "Send a Chase-hosted invoice link to {customer.email}? (Note: Chase
  API not yet wired; this will log the intent + email a placeholder.)"
- On confirm: writes an audit log row `action: 'chase_invoice_queued'` with order id + customer
  email; emails alexa a "Chase invoice link requested by you for order #X — wire up Chase API
  to send the real link." for now; returns success to UI.

When Chase API is wired:
- The button calls Chase's `POST /invoice/create` (or whatever endpoint), gets back a hosted
  invoice URL, emails the customer the link, updates order tag to `payment:chase-invoice-sent`.

### 3% prompt-pay discount (revision of 12A)

Applies ONLY when payment method = **ACH (Stripe or future Chase ACH)**. Does NOT apply to:
- Invoice/NET (you're not paying upfront, no incentive needed)
- Card via Chase (alexa eats Chase's CC fee — no extra discount to compound)
- Anything else

Settings stay as in 12A:
- `prompt_pay_discount_pct` (integer, default 3) in /settings
- `prompt_pay_enabled` (boolean, default true) in /settings
- `b2b.block_prompt_pay_discount` per-customer override (boolean, metafield)

UI shows the discount line when the customer selects ACH; vanishes for other methods.

### Implementation order

1. **First** (~1 day): Wire the new checkout UI with 3 methods (invoice / ACH / Chase stub) +
   prompt-pay discount logic. Mock the ACH backend (no real Stripe yet) — just create the
   Shopify order with appropriate tags and PENDING financial status. Tests for each branch.
2. **Second** (~2 days): Real Stripe ACH backend. Once alexa creates a Stripe account and pushes
   pk/sk to Doppler (`B2B_PORTAL_STRIPE_PK`, `B2B_PORTAL_STRIPE_SK`), wire the Payment Element
   restricted to `us_bank_account` only. Webhook on `payment_intent.succeeded` marks order PAID.
3. **Third** (~30 min when Chase ships): Replace Chase stub modal with real Chase modal SDK +
   wire `/api/admin/orders/:id/send-chase-invoice` to the real Chase invoice API. No UI changes
   needed beyond removing the "coming soon" labels.

### Doppler keys

- `B2B_PORTAL_STRIPE_PK` — Stripe publishable key (write when alexa shares)
- `B2B_PORTAL_STRIPE_SK` — Stripe secret key (same)
- `B2B_PORTAL_STRIPE_WEBHOOK_SECRET` — for verifying webhooks
- `B2B_PORTAL_CHASE_MERCHANT_ID` — placeholder, set when Chase API is wired
- `B2B_PORTAL_CHASE_API_KEY` — placeholder

### Tests

- /checkout shows invoice option only when allow_order_on_invoice is true
- /checkout shows ACH option only when Stripe PK is set
- /checkout always shows the Chase stub button
- Clicking Chase stub opens placeholder modal (no order created)
- Picking ACH applies 3% discount to total
- Picking invoice or Chase stub does NOT apply 3% discount
- Submit with ACH → creates Shopify order PENDING + tag `payment:stripe-ach-pending`
- Submit with invoice → creates Shopify order PENDING + tag `b2b-portal`
- Admin "Send Chase invoice link" button: in stub mode, creates audit log entry + alerts alexa;
  in wired mode (future), calls real Chase API
- /api/admin/orders/:id/send-chase-invoice endpoint stub returns 200 with `{ status: 'stubbed' }`

### Acceptance for Phase 13

- Customer at /checkout sees 3 payment methods (or 2, if invoice not allowed for them)
- Customer picks ACH → 3% off + Stripe Element renders bank-only flow → order submits
- Customer clicks Chase stub button → sees placeholder modal explaining card support is coming
- Admin clicks "Send Chase invoice link" on any order → audit log entry created + notification
  to alexa
- All tests green

## Phase 14 — Customer self-service additions (Tier A subset)

Per alexa's review of the feature research doc, build these 4 from Tier A (the 5th — onboarding
form — is pending alexa's own form app + signature pad work). Tier A features cherry-picked
because they're highest-impact for FWW's specific business.

### 14A — Stock alerts (back-in-stock notifications)

**Customer side** (b2b portal):
- On any product detail page (`/p/:handle`), when a variant has `inventoryQuantity <= 0` and
  `inventoryPolicy=DENY`: show "🔔 Notify me when restocked" button next to the variant selector
  or out-of-stock indicator.
- Clicking opens a small inline form: "Email me at [customer.email] when this is back in stock"
  → button "Subscribe". POST to `/api/stock-alerts` with `{variantId, productId}`.
- Customer can manage their alerts from `/account/alerts` — list of all subscriptions, remove
  button per row, "Clear all" button.

**Server**:
- New SQLite table on b2b portal: `stock_alerts (id, customer_id, variant_id, product_id,
  product_title, variant_title, subscribed_at, notified_at, unsubscribed_at)`.
- POST `/api/stock-alerts` (auth required): creates row; idempotent (no duplicate per
  customer+variant).
- DELETE `/api/stock-alerts/:id`: marks unsubscribed_at.
- GET `/api/stock-alerts`: returns customer's active subscriptions.

**Notification trigger**:
- Background job on portal server: `setInterval` every 15 min, query Shopify (via shopify-
  bridge) for variants currently in stock. Cross-reference with active stock_alerts where
  notified_at IS NULL. Send email to subscriber + set notified_at = now().
- Email subject: "Back in stock at Fuzzywumpets: {product_title} – {variant_title}"
- Email body: link to PDP + "if you no longer want these alerts, unsubscribe at /account/alerts"
- Email transport: Resend API (already provisioned as `B2B_PORTAL_RESEND_API_KEY` — check
  Doppler; create if missing — sign up at https://resend.com if needed, free tier 100/day)

**Tests**:
- POST creates alert, idempotent on dup
- DELETE marks unsubscribed
- Background job detects restock + sets notified_at + (mock email) sends
- Email queued only once per (customer, variant) pair

### 14B — Live order tracking ("In process" → shipped tracking)

**Customer side** (b2b portal):
- On `/orders/:id`, replace today's order timeline / status badge with:
  - "Received" — order placed
  - "In process" — paid (or invoiced + admin acknowledged), Shopify fulfillment NOT yet created
  - "Shipped" — fulfillment created in Shopify; show carrier + tracking number; link to carrier's
    tracking URL
  - "Delivered" — fulfillment tracked status = DELIVERED
- Order detail page polls `/api/orders/:id` every 60 seconds while on the page (lightweight) to
  refresh status without page reload.

**Server**:
- Update `/api/orders/:id` GraphQL query to include `fulfillments { trackingInfo { number url
  company } status }` + `displayFulfillmentStatus`.
- Map Shopify's fulfillment status → portal-friendly status:
  - no fulfillment + financialStatus PENDING → "Received"
  - no fulfillment + financialStatus PAID (or PARTIALLY_PAID) → "In process"
  - has fulfillment + status SUCCESS → "Shopify completed" — show tracking; portal status
    = "Shipped"
  - tracked status = DELIVERED → "Delivered"
- Surface the FIRST tracking number + URL prominently when shipped.

**ShipStation integration (already exists via fww-shipping-bridge)**:
- For orders fulfilled outside Shopify (manual fulfillment / ShipStation imports), check if
  fww-shipping-bridge has the tracking info. If so, surface that too.
- Document in SCRATCH.md the actual data path (test against one real fulfilled order).

**Tests**:
- Mock order without fulfillment → status "Received" or "In process" based on financial status
- Mock order with fulfillment + tracking → status "Shipped" + tracking shown
- Mock order tracked DELIVERED → status "Delivered"
- Polling refresh updates without page reload

### 14C — Tax exemption certificate upload

**Customer side** (b2b portal):
- On `/account`, new section "Tax exemption":
  - If no cert on file: "Upload your resale certificate (PDF, max 5MB)" + state dropdown
    (US states + territories).
  - If pending review: "Your certificate is being reviewed. We'll email you when it's approved."
  - If approved: "✓ Approved {state} on {date}. Orders are tax-exempt." + "Replace certificate"
    button.
  - If rejected: "❌ Certificate rejected: {reason}. Upload a new one." + upload form.

**Server**:
- SQLite: `tax_exempt_certs (id, customer_id, state, file_path, status, uploaded_at,
  reviewed_at, reviewed_by, rejection_reason)`.
- POST `/api/tax-exempt` with multipart file → save under `data/tax-certs/{customer_id}-{ts}.pdf`
  (gitignored), insert row with status='pending', notify admin via email.
- Admin: new `/admin/tax-exempt` page (paginated queue of pending certs); per row "View PDF" +
  "Approve" + "Reject (reason)" actions. Audit-logged.
- When approved: write a Shopify customer metafield `b2b.tax_exempt = true` + `b2b.tax_exempt_state = "XX"`.
- At order creation (admin manual order builder + customer self-serve checkout): if
  customer has `b2b.tax_exempt=true`, set order line item taxable=false.

**Tests**:
- Upload, status='pending'
- Admin approve → status='approved', metafield written
- Customer with approved cert → next order created tax-exempt
- Upload >5MB → 413
- Upload non-PDF → 400

### 14D — Customer-visible internal notes (with email notification)

This expands the existing `customer_notes` SQLite table (internal-only) — we now distinguish:
- **Internal notes**: admin-only, never shown to customer (existing behavior — keep)
- **Visible notes**: admin types, shows on customer's order detail, EMAILS the customer when added

**Admin side** (b2b admin):
- On `/admin/orders/:id`, alongside the existing internal note editor, add a **second** note
  editor labeled "Note visible to customer". Textarea + Save button. When saved:
  - Write to SQLite `visible_notes (id, order_id, customer_id, body, added_at, added_by)`.
  - Send email to customer (Resend) with subject "Update on your order #{order_name}" and body
    excerpting the note + link to `/orders/{order_id}`.
  - Audit-log.

**Customer side** (b2b portal):
- On `/orders/:id`, render a "Notes from Fuzzywumpets" section above line items showing the
  most recent visible note(s) with timestamp. Lime-accent border to draw the eye.

**Tests**:
- Admin adds visible note → SQLite row + email queued
- Customer order detail shows the note
- Internal note path unchanged (no email, not visible to customer)

### Acceptance for Phase 14

- A customer can subscribe to stock alerts on any out-of-stock product and gets emailed when it
  comes back
- A customer's order detail shows live status: Received → In process → Shipped (with tracking
  link) → Delivered
- A customer can upload a resale cert; admin approves; subsequent orders are tax-exempt
- An admin can leave a customer-visible note on an order; customer gets emailed + sees it
- All tests green

---

## Phase 15 — Customer-specific catalogs + multi-user team accounts

### 15A — Customer-specific catalogs via custom tag

Allow alexa to expose certain products only to certain customers — for private SKUs, trade-only
lines, or one-off customizations.

**Mechanism**:
- New customer metafield `b2b.catalog_access_tags` — comma-separated list of tag names the
  customer can access (e.g., `"private-acme,deerskin-trade"`).
- Products that should be restricted get a Shopify tag matching one of these access tags
  (e.g., a product tagged `private-acme` shows only to customers whose `catalog_access_tags`
  contains `private-acme`).
- Products WITHOUT any of these "private" tags are visible to all B2B customers (default).
- "Private" tag list maintained in `/admin/settings` as a global string (e.g., "private-*").

**Admin UI** (`/admin/customers/:id` B2B section):
- New input "Custom catalog tags" (multi-select chip-style) — pick from the global list of
  private tags. Stored as the metafield.

**Server-side filter** (b2b portal `/api/catalog`):
- For each product, derive `productPrivateTags = product.tags ∩ globalPrivateTagSet`.
- If `productPrivateTags.length === 0`: visible to everyone.
- Else: visible only if `session.b2b.catalog_access_tags ∩ productPrivateTags ≠ ∅`.
- Same filter applied to `/api/product/:handle` (404 for unauthorized access).
- Updates the cached catalog response — cache key needs to incorporate the customer's
  catalog_access_tags (or we filter the cached raw catalog per request).

**Tests**:
- Customer with no access_tags → only sees products with no private tags
- Customer with access_tag "private-acme" → also sees products tagged private-acme
- Customer hits /p/private-acme-collar without access → 404

### 15B — Multi-user team accounts (NEW)

A B2B customer (the primary) can invite additional team members to log in to the portal under
their account. Invited users authenticate via magic-link email (separate from Shopify Customer
Account API).

**Data model** (b2b portal SQLite):
- `companies (id, primary_shopify_customer_id, display_name, created_at)`
- `company_users (id, company_id, email, display_name, role, status, invited_at, last_login_at)`
  - `role` ∈ ['primary', 'member', 'admin'] — primary is the Shopify customer; member places
    orders; admin = member + can manage other team members
  - `status` ∈ ['invited', 'active', 'revoked']
- `magic_link_codes (id, email, code_hash, company_id, expires_at, consumed_at)`

**Auth flow for invited users**:
1. Primary user goes to `/account/team` → "Invite team member" → enters email + role
2. Portal creates company_users row with status='invited'; emails the invitee a magic link:
   `https://b2b.fuzzyreporting.com/team-login?email=invitee@x.com&token=<one-time>`
3. Invitee clicks link → enters their name → portal mints session for them tied to the
   company_id → status='active', last_login_at=now()
4. Future logins: invitee goes to `/team-login` → enters email → portal emails a 6-digit code
   (15-min TTL) → enters code → session minted
5. Sessions for invited users use the SAME session cookie scheme as Shopify-authed sessions
   but session record stores `company_user_id` + `company_id` instead of customer_id directly.
   When making Shopify API calls, the portal uses the company's primary_shopify_customer_id.

**Portal behavior for invited users**:
- See the same catalog (with the company's catalog_access_tags applied)
- See the same per-customer pricing (the company's discount %, dropship config)
- Place orders on behalf of the company (orders show the primary's name + an optional
  "Placed by {member.name}" note)
- Cannot see/edit the primary's payment methods, tax cert, addresses (unless role=admin)
- See shared order history + saved lists (everyone on the team sees the same data)

**Primary's team management UI** (`/account/team`):
- List of team members with email, role, status, last active
- "Invite member" form (email + role)
- "Revoke access" button per row
- "Change role" (member ↔ admin)
- Primary cannot revoke themselves

**Constraint**: only the primary (Shopify-authed customer) can invite/revoke. Admin role can
manage other team members but not the primary.

**Tests**:
- Primary invites a member → email sent + row created
- Member clicks magic link → session minted
- Member places an order → order tagged with primary's customer_id + note "Placed by {member.email}"
- Member tries to access primary-only routes (payment methods, tax cert) → 403
- Revoked member's session is invalidated immediately

**Magic link security**:
- Codes are 6-digit numeric (avoid confusion with O/0)
- Stored as bcrypt hash, not plaintext
- 15-minute TTL
- Rate limit: max 3 code requests per email per hour
- Single-use (consumed_at set on first use)

### Acceptance for Phase 15

- alexa can configure custom catalog tags per customer in admin → those customers see
  additional private products
- A primary customer can invite team members from /account/team
- Invited members get a magic-link email, click it, set their name, get session, can browse
  the catalog + place orders on the company's behalf
- Orders placed by team members are attributed to the primary's Shopify customer but carry
  a "Placed by {member.email}" note
- Tests green

## Phase 16 — Admin order editing (modify, partial fulfill, backorder, discounts)

Real-world wholesale ops needs: alexa needs to be able to change an existing order — add/remove
items, fix prices, adjust quantities, ship some items now and backorder the rest, apply
order-level discounts.

Shopify's `orderEdit*` mutation suite supports this on ANY order (even fulfilled/paid).
`fulfillmentCreate` (current API name) supports partial fulfillment natively.

### 16A — Edit order line items

**UI** on `/admin/orders/:id`:

Add an "Edit order" button at the top of the page. Clicking enters **edit mode** where:
- Each existing line item shows: title (read-only) · qty (editable input) · price (editable $)
  · line total · **Remove** button (× icon)
- Below line items: **Add line item** button → opens product/variant picker → picks variant +
  qty + price → adds to the edit calculation
- A running diff panel on the right: "Original total: $X → New total: $Y (delta: ±$Z)"
- **Save changes** + **Discard** buttons at the bottom

**Server flow** (call sequence to Shopify Admin API via shopify-bridge):

1. `orderEditBegin(orderId)` → returns `calculatedOrder.id`
2. For each removed line: `orderEditSetQuantity(calculatedOrderId, lineItemId, quantity: 0)`
3. For each qty change: `orderEditSetQuantity(calculatedOrderId, lineItemId, quantity: newQty)`
4. For each price change: `orderEditAddLineItemDiscount(calculatedOrderId, lineItemId,
   discountAmount: oldPrice - newPrice, description: "Adjusted price")` —
   (Shopify doesn't let you directly mutate line price; we apply a discount to achieve the
   new effective unit price)
5. For each new line: `orderEditAddVariant(calculatedOrderId, variantId, quantity, locationId)`
   — supports a custom unit price via `orderEditAddCustomItem` if needed
6. Preview: `orderEditCalculate(calculatedOrderId)` (refreshed live as admin edits)
7. On Save: `orderEditCommit(calculatedOrderId, notifyCustomer: alexa-chooses,
   staffNote: optional)`

All steps audit-logged (action: `order_edit`, before: original order JSON, after: edited order JSON).

### 16B — Order-level discount

In edit mode, add **"Apply order discount"** button → modal:
- Type: Percentage (%) OR Fixed amount ($)
- Value: numeric input
- Reason: text (required — e.g. "Loyalty discount", "Damaged packaging compensation")

On submit: calls `orderEditAddLineItemDiscount` for each line proportionally (Shopify doesn't
have a single "order-level" discount mutation post-creation; we proportion across lines), OR
use a Cart Transform / Discount API entry. Simplest path: add a single negative-amount custom
line item titled "Order discount: {reason}".

Show the discount line clearly in the order detail. Customer's invoice (PDF) shows it as a
discount line above the total.

### 16C — Partial fulfillment

**UI**: existing order detail gets a **"Fulfill items"** action button. Clicking opens modal:

```
Mark items as shipped
─────────────────────────────────────────
☑ Everyday Limited Slip Collar — Small × [3 of 5 remaining]
☑ Everyday Walking Lead — Medium    × [2 of 2 remaining]
☐ Luxe Houndstooth Martingale       × [0 of 4 remaining]
                                       
Carrier:   [USPS Priority ▾]
Tracking:  [_______________]   (optional)
☑ Email customer with tracking info
                                       
[ Cancel ]   [ Fulfill selected ]
```

**Server**: `fulfillmentCreate(input: { orderId, lineItems: [{id, quantity}], trackingInfo,
notifyCustomer })`. Multiple partial fulfillments are allowed — the order can have N
fulfillments, each shipping some of the remaining items.

Customer's order detail (b2b portal) shows each fulfillment as its own row in a timeline:
- "Shipment 1 — shipped 2026-05-27 via USPS Priority (track: ...)" — line items A, B
- "Shipment 2 — shipped 2026-06-02 via UPS Ground (track: ...)" — line items C
- "Pending shipment — 2 items remaining" — line item D

### 16D — Backorder flag (explicit)

Sometimes you fulfill MOST of an order and explicitly mark certain items as backordered with
an expected ship date. Different from "we just haven't shipped them yet."

**UI**: in the order detail, for any unfulfilled line item, **"Mark as backorder"** action →
modal:
- Expected ship date: date picker (optional)
- Notify customer: checkbox (default ON)

**Server**:
- Add per-line-item metafield: `b2b.line_backorder_status = pending` + optional
  `b2b.line_backorder_eta` (ISO date)
- Or store in our own SQLite `backorders (id, order_id, line_item_id, eta_date, status,
  created_at)` — simpler, no Shopify metafield write per line
- If notify=true: email customer "Some items on your order are backordered" with the line items
  + ETA + link to portal order detail

**Customer-side** (b2b portal order detail): shows clearly:
> ⚠ Backordered: Luxe Houndstooth Martingale (qty 4) — expected to ship around June 15

When the backordered item later ships (via 16C partial fulfillment), email customer "Your
backordered item has shipped" with tracking info.

### 16E — Billing alignment with partial fulfillment

The tricky one. For invoiced orders, when partial fulfillment happens, alexa wants to bill for
ONLY the shipped items now (not the full order).

**Approach: bill against fulfilled, not against order.**

When admin clicks "Generate invoice" on an order with mixed fulfilled+pending lines, modal:
- Radio: **"Invoice for fulfilled items only"** OR **"Invoice for entire order"**
- Preview shows the line items + total being invoiced

When "fulfilled only" selected:
- PDF invoice generation filters line items to only those currently fulfilled (or marked
  fulfilled in any shipment)
- Total = sum of fulfilled line items + shipping (if any) + tax (if any) — does NOT include
  unfulfilled / backordered lines
- Invoice number gets a suffix: `#1234-A` for first partial, `#1234-B` for second, etc.
- Save record in `partial_invoices` SQLite table (order_id, invoice_letter, total, line_items_json, sent_at)
- On the order detail, show "Invoices issued: #1234-A ($72.50, fulfilled portion) · pending..."

Later, when the backordered/remaining items ship, alexa generates another invoice (next letter)
for that batch. Customer ends up with potentially multiple invoices per Shopify order — that's
fine for B2B accounting.

**Tax/shipping handling**: prorate based on fulfilled line subtotal vs full order subtotal,
unless alexa wants to put all shipping on the first invoice (more common in wholesale — make
that the default + offer a toggle).

### 16F — Audit + customer-side visibility

Every order edit, partial fulfillment, backorder flag, discount, and partial invoice creates
an `admin_audit_log` entry with full before/after.

The customer's order detail (b2b portal) reflects all changes in real time:
- Edited line item shows as crossed-out → new value (with strikethrough) for a few days, then
  just the new value
- Order discount shows as a line "Order discount: {reason} − $X"
- Partial fulfillments listed as timeline rows
- Backorder badges on affected lines
- Partial invoices each as a separate PDF download link

### Tests

- Edit qty: original qty 5 → set to 3, calculated total reflects 2-unit reduction
- Remove line: line removed, total drops by line amount
- Add line: pick variant + qty + price, total goes up
- Price change: line gets a discount applied = old*qty - new*qty
- Order-level percentage discount: proportional discount lines applied
- Order-level fixed discount: single negative line item added
- Partial fulfillment: 2 of 3 lines shipped, 1 remains pending. Customer order detail shows
  shipment 1 with tracking + pending shipment notice
- Backorder mark: line shows backorder badge + ETA on customer side
- Partial invoice: invoice generated for fulfilled portion only, ${fulfilledSubtotal} total
- Subsequent partial invoice gets next letter (A → B)

### Acceptance for Phase 16

- alexa can edit any existing order: add/remove lines, change qty, change price, apply
  order-level discount. Customer sees the updated order in real time.
- alexa can ship 2 of 5 items, customer gets shipping notification for those 2, order shows
  "2 of 5 shipped, 3 pending".
- alexa can explicitly mark items as backordered with an ETA; customer sees the backorder
  status + ETA on their order detail; customer is emailed when the backordered items
  eventually ship.
- alexa can generate a "fulfilled-only" invoice; customer sees that invoice covering the
  partial shipment; remaining items get their own invoice when they ship.
- All admin actions audit-logged.
- All tests green.

## Phase 17 — Wholesale leads pipeline (CRM-lite)

A built-in CRM for pre-customer wholesale leads. People who've submitted an application but
haven't been converted to a B2B customer yet. Replaces emailed-spreadsheet workflow with a
structured pipeline view.

### Data model (b2b-admin SQLite)

```sql
CREATE TABLE leads (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  business_name TEXT,
  contact_name TEXT,
  phone TEXT,
  website TEXT,
  business_type TEXT,                 -- boutique | trainer | kennel | show-vendor | groomer | other
  estimated_monthly_volume_usd INTEGER,
  source TEXT,                        -- tradeshow | website-form | instagram | referral | cold-outreach | other
  source_detail TEXT,                 -- "IKC 2026", "@petboutique referred", etc.
  status TEXT NOT NULL DEFAULT 'new', -- see status table below
  application_data_json TEXT,         -- raw form submission
  application_signed_pdf_path TEXT,
  sales_tax_state TEXT,
  sales_tax_id TEXT,
  sales_tax_cert_path TEXT,
  w9_path TEXT,
  business_license_path TEXT,
  custom_tags TEXT,                   -- comma-separated chips: high-value, recurring-show-visitor, etc.
  assigned_to TEXT,                   -- admin email (currently alexa); future-proof for team
  next_followup_due DATE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  converted_at INTEGER,
  shopify_customer_id TEXT,           -- filled in upon conversion
  rejected_reason TEXT
);

CREATE TABLE lead_notes (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER REFERENCES leads(id),
  author_email TEXT NOT NULL,
  body TEXT NOT NULL,
  note_type TEXT NOT NULL,            -- call | email | meeting | system | general
  created_at INTEGER NOT NULL
);

CREATE TABLE lead_status_history (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER REFERENCES leads(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT,
  changed_by TEXT,
  changed_at INTEGER NOT NULL
);
```

### Status workflow

| Status | Meaning | Allowed transitions |
|---|---|---|
| `new` | Just submitted, no review yet | under_review, rejected |
| `under_review` | Sales director (alexa) actively reviewing | waiting_on_docs, waiting_on_sales_tax, waiting_on_w9, approved, rejected, dormant |
| `waiting_on_docs` | Asked for additional documents | under_review (on receipt), dormant, rejected |
| `waiting_on_sales_tax` | Needs resale cert before approval | under_review, dormant, rejected |
| `waiting_on_w9` | Needs W9 (for ≥$600 contracted vendors) | under_review, dormant, rejected |
| `approved` | Approved but not yet converted to Shopify customer | converted (terminal), rejected (rare reversal) |
| `converted` | Shopify customer created, lead archived | (terminal) |
| `rejected` | Not a good fit | (terminal, with reason) |
| `dormant` | No response for 30+ days | under_review (on re-engagement), rejected |

Status transitions auto-create a `lead_status_history` row + a `system` note. Optional free-text
note on every transition for context ("Customer texted, said they'd send W9 by Friday").

### Pages

**`/admin/leads`** — main pipeline view, two layouts (toggle):

- **List view**: filterable table — search by name/email/business, filter by status chip,
  sort by created/updated/follow-up date. Columns: business · contact · status · last activity
  · next follow-up. Bulk actions: change status, send canned email, export CSV.
- **Kanban view**: vertical columns per status, lead cards draggable between columns. Card
  shows business name, contact, last note preview, days-since-last-activity. Drop → status
  transition (with optional note modal).

Top of page: stats strip showing counts per status + "leads needing attention" (next_followup_due
≤ today OR status unchanged for > N days where N varies by status).

**`/admin/leads/:id`** — lead detail page:

- Header: business name + contact + email + status badge
- Action buttons: change status (dropdown), add note, upload doc, convert to customer
- Two-column body:
  - Left: profile (all fields editable), document list (with viewer), custom tag chips editor
  - Right: timeline (chronological merged view of status changes + notes + doc uploads)
- "Next follow-up" date picker

**`/admin/leads/new`** — manual entry (in case alexa meets someone at a show before they hit
the form)

**`/admin/leads/:id/convert`** — convert-to-customer workflow:
- Prefilled customer creation form (name, email, phone, address from application)
- Pick discount % (default from settings), dropship config, allow_order_on_invoice
- Submit → creates Shopify customer with `b2b` tag via shopify-bridge, sets all metafields
  per Phase 10, marks lead `converted_at` + stores `shopify_customer_id`
- Lead archived (stays in DB for history; appears under "Converted" filter)
- Sends customer the welcome email with portal login instructions

### Canned email templates (stored in admin_settings, editable)

- `welcome` — sent on form submission ("Thanks for applying, we'll be in touch in 1-2 business days")
- `request_docs` — when status flips to waiting_on_docs ("Please send us...")
- `request_sales_tax` — when status flips to waiting_on_sales_tax
- `request_w9` — when status flips to waiting_on_w9
- `approved` — when converted ("Welcome! Log in at b2b.fuzzywumpets.com...")
- `rejected` — when rejected (with optional custom reason)
- `dormant_followup` — re-engagement email

Each template editable in /admin/settings/email-templates with merge tags ({contact_name},
{business_name}, etc.). "Send email" buttons on lead detail use these.

### Follow-up reminders

Background job (15-min cron via setInterval):
- Find leads where `next_followup_due ≤ today` AND status is not terminal → flag as "needs
  attention" (visible in stats strip + sortable in list view)
- Find leads in any `waiting_on_*` status with no activity in 14 days → suggest moving to
  dormant (banner on lead detail: "No activity in 14 days. Move to Dormant?")

### Bulk actions on list view

- Change status for selected (with confirm + note)
- Send canned email to selected
- Export selected to CSV
- Mark "needs attention" / clear flag

### Convert-to-customer side effects

When a lead is converted:
1. Shopify customer created with all the lead's profile data + `b2b` tag
2. If sales tax cert was uploaded: write `b2b.tax_exempt=true` + `b2b.tax_exempt_state` metafields
3. If application included a signed PDF: store it linked to the customer for future reference
4. All lead notes copied/linked to the new customer as initial notes (so history isn't lost)
5. Welcome email sent
6. Audit log row

### Tests

- POST /api/leads creates lead with status='new'
- Status transition logs history + creates system note
- Upload document → file saved + path stored
- Convert: lead.converted_at set + shopify_customer_id linked + Shopify customer created
- Bulk status change: 5 selected → all get history rows
- Email template rendering with merge tags
- Follow-up overdue logic flags correct leads

### Acceptance for Phase 17

- alexa can see all pending wholesale leads in /admin/leads with status, last activity, next
  follow-up at a glance
- Can drag-drop a lead between status columns in Kanban view to update status
- Can add timestamped notes per lead; full timeline visible
- Can upload + view application/sales tax/W9 docs per lead
- "Convert to customer" creates a real Shopify customer + carries all profile + tax cert
- Email templates send via canned button presses
- Tests green

---

## Phase 18 — Xero accounting integration

Auto-book orders, edits, and payments into Xero. Replaces manual journal entries with
real-time double-entry bookkeeping triggered by the portal/admin.

### Why this matters

Without this: every wholesale order requires alexa to manually record a journal in Xero
(DR A/R, CR Sales), then when payment hits, manually post the payment + reconcile the fee
deduction. At scale that's hours per week.

With this: order placement = invoice issued in Xero automatically. Payment received =
auto-allocated. Stripe payout = fee + deposit split automatically. Books stay clean.

### Architecture

Use the existing `fww-xero-bridge` worker (per memory `reference_fww_xero_bridge`) as the
proxy. Bearer token in Doppler as `XERO_BRIDGE_BEARER`. Endpoints we'll call:

- `POST /api.xro/2.0/Contacts` — create/upsert customer-as-Xero-contact
- `POST /api.xro/2.0/Invoices` — create invoice on order placement
- `POST /api.xro/2.0/Invoices/{id}` — update on order edit
- `POST /api.xro/2.0/Payments` — record payment against invoice
- `POST /api.xro/2.0/BankTransactions` — Stripe payout deposit + fee split

### Xero account mapping (configurable in /admin/settings/xero)

Settings UI lets alexa map our concepts → Xero account codes (with sensible defaults):

| Our concept | Default Xero account code | Type |
|---|---|---|
| Sales revenue | `200` (Sales) | Revenue |
| Accounts receivable | `610` (Accounts Receivable) | Current Asset |
| Stripe clearing | `1120` (Stripe Clearing) — alexa creates if missing | Current Asset |
| Chase Business Checking | `1110` (existing per QBO→Xero memory) | Bank |
| Payment processing fees | `6100` (Bank Fees) or new "Payment Processing Fees" expense account | Expense |
| Discounts given | `400` (Discounts) | Contra-revenue |

Stored in `admin_settings.xero_account_map` JSON.

### Xero contact auto-create

When the first event hits Xero for a customer:
1. Check if Shopify customer has metafield `b2b.xero_contact_id`
2. If present: use it
3. If not: call Xero `POST /Contacts` with name=business_name, email=email,
   PrimaryPerson details, address. Get back contact ID. Write back to Shopify customer
   metafield for future use.

This way the mapping is durable and shared across portal + admin.

### Order placement → Xero invoice

**Trigger**: any time a Shopify order is created via our system (portal checkout, admin
manual order builder, draft → completed):

```js
// pseudocode
const order = await getShopifyOrder(orderId);
const contactId = await ensureXeroContact(order.customer);
const xeroInvoice = await xero('POST /api.xro/2.0/Invoices', {
  Type: 'ACCREC',
  Contact: { ContactID: contactId },
  Date: order.processedAt,
  DueDate: addDays(order.processedAt, paymentTermsDays),
  InvoiceNumber: order.name,  // e.g. "#1234"
  Reference: 'b2b-portal',
  LineItems: order.lineItems.map(li => ({
    Description: `${li.title} — ${li.variantTitle}`,
    Quantity: li.quantity,
    UnitAmount: li.priceSet.shopMoney.amount,
    AccountCode: settings.xero_account_map.sales_revenue,
    LineAmount: li.lineTotal,
    TaxType: order.taxExempt ? 'NONE' : 'OUTPUT', // adjust to actual Xero tax codes
  })),
  // Order-level discount as a negative line if present (Phase 16)
  Status: 'AUTHORISED',
});
// Persist mapping: order ↔ xero invoice id
db.run('INSERT OR REPLACE INTO xero_invoice_map (order_id, xero_invoice_id) VALUES (?, ?)',
  [order.id, xeroInvoice.InvoiceID]);
```

Status `AUTHORISED` (vs `DRAFT`) means it's a real recognized invoice in Xero — books reflect
the sale immediately.

### Order edit → Xero invoice update (ties into Phase 16)

When admin edits an order via Phase 16's flow:
1. Look up xero_invoice_id
2. If invoice is unpaid: call `POST /Invoices/{id}` with updated LineItems → Xero recalcs
3. If invoice is paid: can't edit directly. Create a Credit Note for the delta if items
   removed or prices reduced; or a new Invoice if items added.
4. Audit-log the Xero side too

### Payment → Xero payment + fee handling

Three payment paths from Phase 13:

**A) Invoice / NET (admin marks paid)** — no fees:
```
POST /api.xro/2.0/Payments
{
  Invoice: { InvoiceID },
  Account: { Code: settings.xero_account_map.chase_checking },
  Date: today,
  Amount: invoice.AmountDue
}
```
Result: A/R clears, Chase increases by full amount.

**B) Stripe ACH payment** (Stripe webhook `payment_intent.succeeded`):
```
// Step 1: record payment against invoice using Stripe Clearing as the account
POST /Payments {
  Invoice: { InvoiceID },
  Account: { Code: settings.xero_account_map.stripe_clearing },
  Date: payment.created,
  Amount: payment.amount_cents / 100  // full invoice amount
}
// Result so far: A/R cleared, Stripe Clearing increased by full amount

// Step 2: when Stripe payout to Chase lands (Stripe webhook payout.created):
POST /api.xro/2.0/BankTransactions {
  Type: 'RECEIVE',
  Contact: { Name: 'Stripe Payouts' },  // generic; doesn't tie to customer
  BankAccount: { Code: settings.xero_account_map.chase_checking },
  Date: payout.arrival_date,
  LineItems: [
    { Description: 'Stripe payout (gross)', Quantity: 1,
      UnitAmount: payout.gross_cents / 100,
      AccountCode: settings.xero_account_map.stripe_clearing },  // CR Stripe Clearing
    { Description: 'Stripe processing fees', Quantity: 1,
      UnitAmount: -payout.fee_cents / 100,
      AccountCode: settings.xero_account_map.processing_fees }  // DR Fees Expense
  ]
}
```
Net effect: A/R cleared, Chase increases by net deposit, Stripe Clearing nets to zero,
Processing Fees recorded as expense. Books reconcile cleanly to Chase statement.

**C) Future Chase card path** — when Chase MS API is wired: same pattern but route through
a "Chase Card Clearing" account instead of Stripe Clearing. Settings UI just needs a new
mapping entry.

### Order-level discounts (Phase 16) → Xero

Discount lines get their own LineItem on the Xero Invoice with negative UnitAmount mapped to
the Discounts account. Shows up cleanly on the invoice + as contra-revenue on the P&L.

### Reconciliation view in admin (`/admin/accounting`)

Per-order: order # | Xero invoice # | invoice status (draft/authorised/paid) | payment date |
processing fee captured | discrepancy ($ amount that should reconcile but doesn't)

Helps alexa spot any orders where Xero booking failed (e.g., bridge was down) so she can
manually re-trigger.

### Failure handling

- Xero call failures get retried 3× with exponential backoff
- If all retries fail: queue the event in a `xero_pending_actions` table for later retry via
  cron / manual button
- Audit logs include both Shopify and Xero results
- Admin email alert if more than N pending actions accumulate

### Settings UI (`/admin/settings/xero`)

- Xero account mapping (the table above, with dropdowns of fetched Xero account codes)
- "Test connection" button — pings the bridge, fetches first 5 accounts, displays "OK"
- "Sync now" button — manually re-trigger pending Xero actions
- Toggle: pause Xero booking entirely (for catch-up periods)
- Display: count of pending actions, last successful sync timestamp

### Tests

- Order placed → Xero invoice posted (mock the bridge response)
- Order edited (qty change) → Xero invoice updated
- Order edited after payment → Credit Note created instead
- Stripe payment_intent.succeeded webhook → Xero payment recorded against Stripe Clearing
- Stripe payout.created webhook → BankTransaction posted with gross + fee split
- Invoice payment via admin "mark paid" → Xero payment to Chase Checking, no fee
- Xero bridge 500 → action queued for retry, audit-logged
- Settings UI account mapping persists + is used by all flows

### Acceptance for Phase 18

- alexa places (or has a customer place) a B2B order → opens Xero, sees the invoice
  AUTHORISED with correct customer, line items, total, due date
- alexa edits an unpaid order → Xero invoice reflects the change
- A Stripe ACH payment lands → Xero payment recorded against the invoice immediately
- A Stripe payout to Chase lands → bank transaction posted to Chase with the processing
  fee correctly recorded as expense; Stripe Clearing nets to zero
- Reconciliation page shows zero discrepancies for orders that processed cleanly
- All tests green

## Phase 19 — Customer profile depth + universal navigation + persistent cart

Three pieces, all about making the admin tool a real operator console and making the customer's
cart feel like THEIR cart (not a session blip).

### 19A — Customer profile: lifetime spend + date-range filter + linked orders

On `/admin/customers/:id`, add a new **"Spend"** section above the existing settings card.

**Layout:**

```
┌─ Spend ──────────────────────────────────────────────────┐
│                                                          │
│  Lifetime spend:  $42,318.50  ·  127 orders              │
│                                                          │
│  Show spend for:  [ Last 30 days ▾ ]                     │
│                    ▾ Last 7 days                         │
│                    ▾ Last 30 days  (default)             │
│                    ▾ Last 90 days                        │
│                    ▾ Last 12 months                      │
│                    ▾ Year to date                        │
│                    ▾ All time                            │
│                    ▾ Custom range...                     │
│                                                          │
│  Custom range:   [ 2026-01-01 ] to [ 2026-05-26 ]        │ ← only if "Custom"
│                                                          │
│  In range:  $8,440.20  ·  17 orders                      │
│                                                          │
│  ┌─ Orders in range ────────────────────────────────┐    │
│  │ #1234  2026-05-20  $312.50  Paid  → invoice PDF  │    │  ← rows hyperlinked
│  │ #1233  2026-05-18  $890.00  Paid  → invoice PDF  │    │     to /admin/orders/:id
│  │ #1232  2026-05-15  $42.50   Pending invoice      │    │
│  │  ...                                              │    │
│  └─────────────────────────────────────────────────┘    │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

**Implementation:**

- New endpoint `GET /api/admin/customers/:id/spend?from=ISO&to=ISO`
  - Returns: `{ lifetimeTotal, lifetimeCount, rangeTotal, rangeCount, orders: [{id, name, createdAt, total, financialStatus, fulfillmentStatus}] }`
  - Lifetime: SUM(total_price) WHERE customer_id = :id AND voided=false AND refunded_amount < total_price (refunds prorated)
  - Range: same WHERE + AND createdAt BETWEEN :from AND :to
  - Server-side computation; cache 60s per customer (invalidate on order create/edit/cancel)
- Frontend: dropdown changes trigger refetch; custom range shows two date pickers
- Hyperlink every order # to `/admin/orders/:id`
- Hyperlink every "→ invoice PDF" cell to the existing PDF generation endpoint

**Data source:** Shopify orders via shopify-bridge GraphQL — `customer.orders(first: 250, query: "created_at:>YYYY-MM-DD AND created_at:<YYYY-MM-DD")`. Paginate if customer has >250 orders in range.

**Edge cases:**
- Customer with 0 orders → "No spend yet" in lifetime, "No orders in range" in range section
- Voided/cancelled orders → excluded from totals but still show in list (dim/strikethrough)
- Refunded orders → total reduced by refund amount; show original + refund delta on hover

### 19B — Universal hyperlinks across admin

Every reference to an entity should be a clickable link to that entity's detail page.

**Affected components (audit + fix):**

1. **Orders list** (`/admin/orders`)
   - Order # → `/admin/orders/:id` (already linked — verify)
   - Customer name → `/admin/customers/:id`  ← FIX
   - Source badge (POS/SparkLayer/etc) → filter the list by that source

2. **Order detail** (`/admin/orders/:id`)
   - Customer name (top of page) → `/admin/customers/:id`  ← FIX
   - Each line item product name → `/admin/products/:id` (NEW PAGE if needed — see 19C below)  ← FIX
   - Each line item variant title → same as above with `?variant=:id` anchor
   - Related orders (if cross-referenced via notes) → `/admin/orders/:otherId`
   - Invoice numbers (in audit log) → PDF download link

3. **Customers list** (`/admin/customers`)
   - Customer name → `/admin/customers/:id` (already linked — verify)
   - Order count → `/admin/orders?customer=:id`  ← FIX
   - Tag chips → `/admin/customers?tag=:tag`  ← FIX

4. **Customer detail** (`/admin/customers/:id`)
   - All orders listed in spend section → `/admin/orders/:id` (per 19A)
   - Tag chips → `/admin/customers?tag=:tag`
   - Notes timeline: any `#1234` mention auto-linked to order, `@username` to user

5. **Audit log viewer** (`/admin/audit`)
   - Actor email → `mailto:` link
   - Resource ID (order/customer/product) → relevant detail page
   - Action type → filter the log by that action

6. **Wholesale leads (Phase 17)**
   - Once converted, "Customer #X" → `/admin/customers/:id`
   - Notes: same `#1234` and `@username` auto-link rules

**Convention:**
- Hyperlinks use `class="link"` with consistent styling (Marquee Blue underline on hover)
- Open in same tab by default; cmd/ctrl-click opens new tab (standard browser behavior)
- Long titles truncate with ellipsis + `title=` attr for full text

### 19C — Product detail in admin (NEW PAGE if not already built)

For 19B link targets to work, admin needs `/admin/products/:id`:

- Header: product title + handle + status (Active/Draft/Archived) + vendor + product type
- Tags as chips, each linking to `/admin/products?tag=:tag`
- Publications: which sales channels published to (B2B / OS / SparkLayer / POS) as colored badges
- Variants table: SKU · barcode · price · inventory per location · weight
- "Edit in Shopify" deep-link button → opens Shopify admin product page in new tab
- Image gallery (thumbnails)
- Recent orders containing this product: list with date, customer link, qty, total

This page is read-mostly; edits flow through "Edit in Shopify" until/unless we build a full product editor (defer).

### 19D — Persistent cart (b2b portal, cross-repo)

**Cross-repo change** — touches `fww-b2b-portal`. Keep `fww-b2b-admin` changes minimal here (just the admin-visible cart audit log entry per customer if relevant).

**Current behavior** (assumed): cart is in localStorage on the customer's browser; clearing localStorage / changing device = cart gone.

**New behavior:**

1. **Server-side cart storage** — every add/remove/qty-change syncs to portal SQLite:
   - Table `cart_events (id, customer_id, event_type, variant_id, quantity, prev_quantity, ts)` — append-only log of every change
   - Table `cart_state (customer_id, items_json, updated_at)` — current cart snapshot
   - On every cart mutation in the UI: POST `/api/cart/event` → server appends to `cart_events` + updates `cart_state` row
   - On portal page load (catalog, PDP, cart): GET `/api/cart` → server returns `cart_state.items_json`; client merges with any local pending changes
   - LocalStorage stays as a write-through cache; source of truth is server

2. **No automatic clearing**:
   - Cart contents persist forever until the customer explicitly clicks "Empty cart"
   - Order placement does NOT clear the cart automatically — items just get marked `purchased_at = order_id`; the cart resets to empty AFTER successful order confirmation (so a failed checkout still keeps their cart intact)
   - On `Empty cart` button click: confirm modal ("Empty your cart? You'll lose your saved items.") → POST `/api/cart/clear`

3. **Exit warning when cart has items + order not placed**:
   - `window.addEventListener('beforeunload', ...)` if `cart.items.length > 0` AND not currently on `/checkout/success`
   - Browser shows native "Leave site? Changes you made may not be saved" prompt
   - Triggered only when leaving the portal entirely (not on internal nav)

4. **Admin visibility**:
   - On `/admin/customers/:id`, NEW section "Active cart":
     - If `cart_state.items_json` is non-empty:
       ```
       ┌─ Active cart  ·  3 items  ·  $87.50  ·  last updated 2 hours ago ─┐
       │ • Everyday Limited Slip Collar — Small × 2 — $30.00              │  ← product links
       │ • Everyday Walking Lead — Medium × 1 — $25.50                    │
       │ • Luxe Houndstooth Martingale × 1 — $32.00                       │
       │                                                                    │
       │ [ Convert to order... ] [ Email reminder ] [ Empty their cart ]   │
       └────────────────────────────────────────────────────────────────────┘
       ```
     - Else: "No active cart"
   - "Convert to order..." → opens manual order builder pre-populated with cart items
   - "Email reminder" → sends "you have items waiting in your cart" email (Resend)
   - "Empty their cart" → confirm modal + admin action audit-logged

5. **Cart history viewer**:
   - Admin can click "Cart activity" on customer detail → modal/page showing last 100 cart_events with timestamps
   - Useful for diagnosing "I added 5 of X but only see 3" type complaints

**Data retention:**
- `cart_events` is append-only forever
- `cart_state` is single-row-per-customer, updated in place
- No TTL, no auto-prune (matches alexa's explicit "in perpetuity" instruction)

**Migration**:
- On first deploy, no existing cart_state rows; customers will populate as they interact
- Existing localStorage carts on customer browsers get uploaded to server on first cart mutation after deploy (one-shot sync logic in cart JS)

### Tests

- 19A: customer with 5 orders across 2 years → lifetime total matches sum; range filter narrows correctly
- 19A: change date range dropdown → orders list refetches + total updates
- 19A: custom range with from > to → frontend validation prevents fetch
- 19B: order detail page — clicking customer name navigates to customer detail
- 19B: customer detail — clicking tag chip navigates to filtered customers list
- 19B: any `#1234` in note text auto-renders as link to order 1234
- 19C: /admin/products/:id loads product with variants + tags + publication badges
- 19D: cart event API records each add/remove/qty-change
- 19D: cart persists across browser refresh + new device login
- 19D: order placement does NOT clear cart until confirmation success
- 19D: explicit "Empty cart" clears cart_state + adds audit event
- 19D: admin sees active cart on customer detail
- 19D: admin "Convert to order" pre-populates manual order builder

### Acceptance for Phase 19

- alexa can open any customer profile and see lifetime spend, date-range spend, and a list of
  orders in that range — every order links to its detail page
- alexa can navigate from any order to its customer, from any customer to their orders, from
  any product line item to that product's detail page — no copy-paste of IDs required
- A wholesale customer's cart is preserved forever across sessions / devices / logouts;
  if they accidentally close the tab with items in it, the browser warns them; clicking
  through doesn't lose the cart; only an explicit "Empty cart" or completed-order confirmation
  resets it
- alexa can see any customer's active cart from the admin and either convert it to an order
  or email the customer a reminder
- All tests green

### 19E — Catalog tab: product status filter (admin)

On `/admin/catalog` (admin tool products list), add a filter chip row at the top:

```
Status:  [ All ]  [ Active (default) ]  [ Draft ]  [ Archived ]
         (count)  (count)               (count)    (count)
```

**Behavior:**
- Page loads showing **Active** products by default (most common operator need)
- Each chip shows a count badge in parens
- Clicking a chip swaps the visible set; URL updates with `?status=active|draft|archived|all` for shareable links
- "All" chip shows every status (matches today's behavior — currently no filter)
- Visually distinguish status in the list:
  - Active: no badge (default)
  - Draft: yellow "DRAFT" badge next to title
  - Archived: gray "ARCHIVED" badge + entire row dim

**Implementation:**
- Server: `GET /api/admin/catalog?status=active` → adds `query: "status:active"` to Shopify GraphQL `products` query (Shopify supports `status:` directly)
- Counts: lightweight query at page load `productsCount(query: "status:active")`, same for draft + archived; total = all three
- Frontend: chip-style toggle component (same pattern as Phase 9 order source chips)
- Default param if none provided: `status=active`

**Tests:**
- /admin/catalog with no query → shows only Active products
- /admin/catalog?status=draft → shows only Draft
- /admin/catalog?status=all → shows every product regardless of status
- Status chip counts match the filtered list size
- Archived row visibly dimmed

## Phase 20 — Priority customer onboarding + Companies research archive

alexa's directive 2026-05-26: when bringing real customer/order data into the admin, **prioritize
customers with significant order history**. Surface Mia Wagner, Mike Ward, etc first so the admin
gets battle-tested against high-volume accounts before lower-tier ones.

Companies migration deferred to future loop (Path A — ship current queue first, migrate later).
Companies research preserved in docs for that future phase.

### 20A — Priority customer surfacing in admin

**Goal:** when alexa opens `/admin/customers` she sees the most operationally important customers
first by default, not alphabetical or arbitrary order.

**Default sort on `/admin/customers`:**
- Change default sort from name → **lifetime spend descending**
- Sort options dropdown: Lifetime spend ↓ (default) · Recent activity ↓ · Order count ↓ · Name A-Z · Newest first
- URL persists sort: `?sort=lifetime_spend_desc`

**Priority customers (top 15 by lifetime spend as of 2026-05-26):**

| # | Name | Orders | Lifetime |
|---|---|---|---|
| 1 | Mia Wagner | 254 | $142,838.99 |
| 2 | James Mohs | 36 | $46,063.98 |
| 3 | Angie Roe | 27 | $42,477.55 |
| 4 | Mike Ward | 19 | $28,727.87 |
| 5 | Kathi Luljak | 34 | $18,895.14 |
| 6 | Susan Arafat | 5 | $15,154.47 |
| 7 | Amber McCune | 10 | $15,005.69 |
| 8 | Tina Medley | 6 | $11,131.84 |
| 9 | Mary Holsen | 10 | $9,086.69 |
| 10 | Cyndi Skinner | 3 | $8,549.48 |
| 11 | Stephan Olschewski | 11 | $8,034.99 |
| 12 | Pat Walsh | 12 | $6,827.31 |
| 13 | Megan Schriefer | 11 | $6,318.54 |
| 14 | Lisa Zilney | 5 | $3,771.70 |
| 15 | Tracy Best | 3 | $2,415.00 |

Combined lifetime revenue: ~$355K across top 15.

**Test fixtures + dev seed:**
- Save current top-15 snapshot to `docs/PRIORITY_CUSTOMERS_BASELINE.md` (the table above + the
  shopify-bridge query used to generate it)
- Phase 19A's lifetime-spend computation MUST work end-to-end on each of these 15 first
- Manual smoke test: open each of the top 5 customer profiles after Phase 19 ships and confirm
  lifetime spend matches Shopify admin

**Quick wins flagged for top customers:**
- Add a small ⭐ badge next to top-10-by-spend customer rows ("top customer" indicator)
- Customer detail page: show "Rank: #N of B2B customers by lifetime spend" small text under name
- Dashboard widget: "Top 5 B2B customers by lifetime spend" with quick links — gives alexa
  one-click access to her most important accounts

### 20B — Shopify Companies research archive (no code, docs only)

Companies migration is **deferred** to a future phase (likely Phase 22+ after current queue
settles). Preserve the research now so the next loop iteration has full context without
re-researching.

**Action:**
- Create `docs/SHOPIFY_COMPANIES_RESEARCH.md` in the repo with the full research brief
- Key facts to record:
  1. Companies available on Basic/Grow/Advanced as of 2026-04-02 changelog
  2. Same OAuth flow as standard Customer Account API — no re-arch needed
  3. Native multi-buyer + multi-location + payment terms + tax exemption + catalog assignment
  4. Built-in admin UI for Customer → Company migration (up to 250 at a time, order history follows)
  5. 3-catalog cap on non-Plus (FWW has 1, fine)
  6. Native NOT supported: credit limits (still metafield-based)
  7. SparkLayer + Companies don't interoperate — our SparkLayer-replacement strategy is right
- Include the source citations (Shopify changelog, help docs, GraphQL refs, SparkLayer docs)

**Future Phase 22 outline** (record in docs/SHOPIFY_COMPANIES_RESEARCH.md):
- Migrate the top 15 priority customers (above) to Shopify Companies via admin bulk action
- Per-customer metafields (`b2b.discount_pct`, `allow_order_on_invoice`, `dropship_*`)
  → migrate to native Company/Location config (payment terms, catalog assignment)
- Phase 15B magic-link team accounts → retire in favor of native Company Contacts
- Phase 14C tax cert upload → consider retiring in favor of native Location-level tax exemption
  (keep the upload-and-approve UX but write to Company instead of SQLite)
- Portal session model: detect `company_id` from logged-in Contact; route B2B logic via Company

**Not in scope for this Phase 20:**
- No code changes to Customer/Customer-API integration
- No new GraphQL queries for Company objects yet
- No migration of any customer record
- Magic-link team accounts (Phase 15B) STAYS on the current queue per Path A

### Tests

- `/admin/customers` loads with lifetime-spend-descending default
- Sort dropdown switches between options + URL updates
- Mia Wagner's profile renders correctly with $142K+ lifetime
- Dashboard widget shows top 5 customers with click-through
- docs/SHOPIFY_COMPANIES_RESEARCH.md exists and includes all 10 research points + sources

### Acceptance for Phase 20

- alexa opens /admin/customers → Mia Wagner is at the top
- Each of the top-15 customer profiles loads cleanly (Phase 19A spend section validated against them)
- Dashboard has a "Top customers" widget linking directly to the heavy hitters
- Companies research is preserved in repo for the future migration phase
- All tests green

## Phase 21 — Xero customer sync on B2B creation

alexa's directive 2026-05-26 (from companion Xero thread): every new B2B customer in Shopify
must be immediately pushed to Xero as a Contact, keyed by Shopify customer ID. Existing 40 B2B
contacts already migrated by hand 2026-05-26 — this phase handles **new** customers going
forward + reads the migration mapping for **existing** customer references.

### Reference doc

Full setup notes shipped by alexa pasted into `docs/XERO_CUSTOMER_SYNC.md` (created in 21A
below). Read it before implementing. Key facts:

- **Primary mapping key:** Xero `Contact.AccountNumber` = numeric Shopify customer ID (e.g.
  `"8902606455019"`)
- **Migration mapping JSON:** `data/shopify_to_xero_mapping.json` (scp'd from alexa's
  ~/projects/qbo-to-xero/b2b-push/) — has `by_shopify_id` + `by_xero_contact_id` indexes
- **B2B ContactGroup:** `c5afb0f1-8a59-4db8-be57-83548c361669`
- **Tracking category:** Customer Type → B2B (`d7d93d75-877a-4e9e-89de-69e7159dc9d2` /
  `5fe38929-9904-412c-8e43-ecb410d6749d`)
- **Wholesale income account:** `4150` (Sales:B2B Sales)
- **Default currency:** USD
- **Xero bridge:** `https://fww-xero-bridge.alex-037.workers.dev/xero` w/ Doppler
  `XERO_BRIDGE_BEARER`
- **Insider exclusions:** Shopify customer IDs `4742401425601` (Alexander Lass) and
  `5163530813633` (Mason Flowers) — never sync

### 21A — Mapping file + reference doc placement

**Files to create/place** (loop will do this):
- `data/shopify_to_xero_mapping.json` — the migration map (alexa will scp from local)
- `docs/XERO_CUSTOMER_SYNC.md` — the full setup notes alexa pasted (copy-paste from HANDOFF.md
  section above into a dedicated doc)

**`.gitignore` rule**: keep `data/shopify_to_xero_mapping.json` IN git (small, useful, public-safe
— just IDs and names). Don't gate it behind a fetch.

### 21B — Sync helper module

Create `lib/xero-customer-sync.mjs` exporting:

```js
/**
 * Resolve a Shopify customer ID to a Xero ContactID.
 * Tries (1) the local mapping JSON first, then (2) live Xero query by AccountNumber.
 * Returns { xeroContactId, xeroName, isMerged, source } or null if not in Xero.
 */
export async function resolveXeroContact(shopifyCustomerId) { ... }

/**
 * Create a new Xero contact for a freshly b2b-tagged Shopify customer.
 * Idempotent — checks mapping + live AccountNumber first; no-op if already exists.
 * Returns { xeroContactId, created: bool }.
 */
export async function syncCustomerToXero(shopifyCustomerId, customerData) { ... }

/**
 * Check if a Shopify customer is on the insider exclusion list.
 */
export function isInsider(shopifyCustomerId) {
  return ['4742401425601', '5163530813633'].includes(String(shopifyCustomerId));
}
```

**Behavior of `syncCustomerToXero`:**
1. If insider → log + return `{xeroContactId: null, skipped: 'insider'}`
2. Look up in `shopify_to_xero_mapping.json` → if hit, return existing
3. Live query Xero `GET /Contacts?where=AccountNumber=="<id>"` via bridge → if hit, return existing + update local mapping
4. If still no hit → create new:
   ```
   POST /api.xro/2.0/Contacts
   {
     "Contacts": [{
       "Name": "<business name OR firstName+lastName if no company>",
       "AccountNumber": "<numeric Shopify customer ID>",
       "EmailAddress": "<primary>",
       "ContactPersons": [{ FirstName, LastName, EmailAddress, IncludeInEmails: true }],
       "Addresses": [{ AddressType: "STREET", AddressLine1, City, Region, PostalCode, Country }],
       "DefaultCurrency": "USD",
       "SalesDefaultAccountCode": "4150",
       "SalesTrackingCategories": [{
         "TrackingCategoryName": "Customer Type",
         "TrackingOptionName": "B2B"
       }]
     }]
   }
   ```
5. Add to B2B ContactGroup:
   ```
   PUT /api.xro/2.0/ContactGroups/c5afb0f1-8a59-4db8-be57-83548c361669/Contacts
   { "Contacts": [{ "ContactID": "<new id>" }] }
   ```
6. Append to `shopify_to_xero_mapping.json` so subsequent lookups are local
7. Audit log: `xero_customer_sync_created` with both IDs
8. Return `{xeroContactId, created: true}`

**Customer name derivation** (`customerData.businessName` preferred, fallback to person name):
- If `customer.defaultAddress?.company` present → use that
- Else `firstName + ' ' + lastName`
- Else `email` (last resort)

### 21C — Sync triggers (when to call `syncCustomerToXero`)

**Three trigger paths** that should all result in Xero sync:

1. **Lead conversion (Phase 17)**: when `/leads/:id/convert` creates the Shopify customer +
   adds `b2b` tag → immediately call `syncCustomerToXero(newShopifyId, customerData)` →
   surface result in conversion success modal ("✓ Synced to Xero as contact <name>")

2. **Manual b2b tag add (admin UI)**: on `/admin/customers/:id`, when admin adds the `b2b`
   tag → fire post-save hook → `syncCustomerToXero` → flash success/failure

3. **Webhook backfill (defensive)**: register a Shopify `customers/update` webhook on the
   admin (path `/webhooks/shopify/customer-update`). When a customer gets the `b2b` tag added
   externally (e.g. via Shopify admin directly), the webhook fires → sync to Xero. Idempotent
   (returns existing on second call).

### 21D — "Synced with Xero" indicator on customer detail

On `/admin/customers/:id`, add a small badge near the customer header:

```
┌─ Customer ──────────────────────────────────────────────┐
│ Mia Wagner                          [B2B]               │
│ mia@example.com                                          │
│                                                          │
│ ✓ Synced with Xero  ·  contact: cea397fa-c20b-...       │ ← NEW
│   (last verified: 2 minutes ago) [refresh]              │
│                                                          │
│ ... (existing settings card etc) ...                    │
└──────────────────────────────────────────────────────────┘
```

**States:**
- ✓ **Synced** (green) — resolved via mapping or live query; show first 8 chars of ContactID + tooltip with full
- ⚠ **Not synced yet** (yellow) — has `b2b` tag but no Xero match; show "Sync now" button
- ⊘ **Insider** (gray) — on exclusion list; no action needed
- ✗ **Error** (red) — last sync attempt failed; show error tooltip + "Retry" button

**Click the Xero contact ID** → opens `https://go.xero.com/Contacts/View/{contactId}` in new tab
(deep link to Xero admin for the contact).

**Endpoint** `GET /api/admin/customers/:id/xero-status` → returns `{state, xeroContactId, xeroName, lastChecked}`.

### 21E — Merged contact awareness

The mapping file already encodes 2 merge cases:
- Shopify `6909696999659` (Angie Roe) → Xero "Pro-Mohs Canine Supply" (primary `5462357967041`)
- Shopify `7669502509291` (Bradley Phifer) → Xero "The Dog Shoppe" (primary `8902606455019`)

When admin views one of these "merged child" customers:
- Show banner: "⚭ This Shopify customer is merged into Xero contact **Pro-Mohs Canine Supply**
  along with Mike Ward (#5462357967041). Invoices for this customer post to the merged contact."
- Link to the primary's `/admin/customers/<primaryShopifyId>`

### 21F — Pending Pat Walsh resolution

Per alexa's notes: Pat Walsh (Shopify ID — look up from top-15) is still pending review in
`approved.json` on alexa's local. Action item for next manual ops session: run
`node review.mjs` from `~/projects/qbo-to-xero/b2b-push/` to push her contact. Once done,
re-export `shopify_to_xero_mapping.json` and update the VPS copy.

**No code changes required for this phase** — just record the TODO in `docs/XERO_CUSTOMER_SYNC.md`
and surface a "1 customer pending Xero sync" widget on the dashboard if her status is
"Not synced".

### 21G — Cross-reference with Phase 18 (Xero invoice booking)

Phase 18 already calls Xero to book invoices on order placement. It MUST use
`resolveXeroContact(order.customer.id)` before booking — never blindly create a duplicate
contact. If `resolveXeroContact` returns null AND customer is `b2b`-tagged, call
`syncCustomerToXero` first, then proceed with invoice. If customer is NOT b2b (e.g. retail
walk-in via portal), skip Xero booking entirely.

This makes Phase 21 a hard prerequisite for Phase 18's customer-side logic. Order Phase 21
BEFORE Phase 18 in the implementation queue.

### Tests

- 21B: `resolveXeroContact` for known Shopify ID `8902606455019` returns "The Dog Shoppe"
- 21B: `resolveXeroContact` for merged case `6909696999659` returns "Pro-Mohs Canine Supply" with `isMerged=true`
- 21B: `resolveXeroContact` for insider `4742401425601` returns null (insider check)
- 21B: `syncCustomerToXero` for new (non-existing) Shopify customer creates + adds to B2B group + updates mapping
- 21B: `syncCustomerToXero` second call same ID returns existing (idempotent)
- 21C: Phase 17 lead conversion triggers Xero sync — verify mapping has new entry
- 21D: Customer detail page shows green "Synced with Xero" badge for known customers
- 21D: Insider customer shows gray "Insider" badge
- 21E: Merged customer shows the merge banner
- 21G: Phase 18 invoice booking uses `resolveXeroContact` and doesn't create dup

### Acceptance for Phase 21

- Mapping JSON + reference doc live in repo at agreed paths
- `lib/xero-customer-sync.mjs` exports the 3 functions; full test coverage
- Lead conversion (Phase 17) and manual b2b-tag add both trigger Xero sync
- Customer detail page shows clear "Synced with Xero" / "Not synced" / "Insider" badge
- Merged contacts show the merge banner
- Phase 18 invoice booking respects the resolve helper (no dup creation)
- All tests green

## Phase 22 — Admin "View portal as customer" (impersonation)

alexa's directive 2026-05-26: admin needs a "View portal as ..." button on customer profiles to
debug customer-side issues, walk customers through the cart, see exactly what they see.

Cross-repo: BOTH `fww-b2b-admin` AND `fww-b2b-portal` need changes. Similar pattern to
Phases 13/14 cross-repo wiring.

### 22A — Shared impersonation secret

**New Doppler secret:** `B2B_IMPERSONATION_SECRET` (random 64-char hex, used to sign + verify
the impersonation token by both apps).

If missing in Doppler, the loop should:
1. Generate via `openssl rand -hex 32`
2. Push to Doppler: `doppler secrets set B2B_IMPERSONATION_SECRET=<value>`
3. Both apps read it at startup; require it (fail to boot if absent in prod)

### 22B — Admin: "View portal as ..." button + token mint

On `/admin/customers/:id` (admin server), add a button in the customer header card:

```
[ View portal as Mia Wagner ... ]   ← purple/lime accent to stand out
```

Click flow:
1. Admin clicks → confirms with modal: "Open portal as Mia Wagner? You will see her catalog,
   prices, cart, and order history. Actions you take WILL affect her account unless you stay
   in read-only mode."
   - Radio option: ◉ Read-only (default — browse only, cart mutations blocked) / ◯ Interactive
     (full simulation including cart/checkout)
   - [Cancel] [Open portal]
2. On confirm: POST `/api/admin/customers/:id/impersonate` with `{mode: 'readonly'|'interactive'}`
3. Admin server creates signed JWT-style token:
   ```js
   const payload = {
     customer_id: id,
     admin_email: session.email,
     mode: 'readonly' | 'interactive',
     issued_at: Date.now(),
     expires_at: Date.now() + 60*60*1000,  // 1-hour TTL
     nonce: crypto.randomBytes(16).toString('hex')
   };
   const token = base64url(JSON.stringify(payload)) + '.' + hmacSha256(payload, SECRET);
   ```
4. Audit log entry: `action=impersonation_started, admin=<email>, customer_id=<id>, mode=<mode>, expires_at=<ts>`
5. Response: `{ url: 'https://b2b.fuzzyreporting.com/__impersonate__?token=<token>' }`
6. Admin frontend: `window.open(url, '_blank')` — opens portal in new tab

**Endpoint:** `POST /api/admin/customers/:id/impersonate` — requires admin auth, returns the
URL. Rate limit: 10/min per admin.

### 22C — Portal: token validation + impersonation session

In `fww-b2b-portal/server.mjs`, add new route `GET /__impersonate__?token=<token>`:

1. Parse + HMAC-verify token using `B2B_IMPERSONATION_SECRET`
2. Check `expires_at > now()` → 401 if expired
3. Check `customer_id` is valid + b2b-tagged via existing customer fetch path
4. Create session record with extra flags:
   ```js
   session = {
     customer_id, /* normal session fields */,
     impersonation: {
       active: true,
       admin_email: payload.admin_email,
       mode: payload.mode,  // 'readonly' | 'interactive'
       started_at: payload.issued_at,
       expires_at: payload.expires_at,
       nonce: payload.nonce
     }
   }
   ```
5. Set session cookie (separate name from normal session: `b2b_impersonation_session` so it
   doesn't collide with the customer's actual session if they're also logged in)
6. Redirect to `/` (portal home)

**Audit log on portal:** every page request during impersonation logs `impersonation_view`
with admin_email + customer_id + path.

### 22D — Portal: impersonation banner + mode enforcement

On every portal page (sticky top), render banner when `session.impersonation?.active`:

```
┌─────────────────────────────────────────────────────────────────────┐
│ 👁  Viewing as Mia Wagner — started by alex@fuzzywumpets.com         │
│     Mode: READ-ONLY  ·  Expires in 47 min  ·  [Exit impersonation]  │ ← red bg, sticky
└─────────────────────────────────────────────────────────────────────┘
```

Color: bright red/orange background (#dc2626 / #ea580c) so admin can't miss it. Sticky at top
of viewport on every page.

**Read-only mode enforcement** (in portal server middleware):
- Block POST/PUT/DELETE to: `/api/cart/*`, `/api/checkout`, `/api/orders`, `/api/stock-alerts`,
  `/api/tax-exempt`, `/api/team-members`, `/account/*` mutations
- Allow GET on everything
- Blocked requests return 403 with body: `{ error: 'Read-only impersonation mode' }`
- Frontend: any "Add to cart" / "Place order" / etc. buttons get a visual disabled state +
  tooltip "Read-only mode — switch to interactive to perform actions"

**Interactive mode**:
- All routes work normally BUT every mutation gets an extra audit log entry:
  `impersonation_mutation` with admin_email, customer_id, route, body_summary
- Cart mutations + order placement get an extra client-side confirm:
  `"You are impersonating <customer>. This action will affect their cart/order. Continue?"`

### 22E — Exit impersonation

[Exit impersonation] button on the banner:
- POST `/__impersonate__/exit` → destroys impersonation session cookie
- Audit log: `impersonation_ended, admin_email, customer_id, duration_seconds`
- Redirect to `/exited?customer=<name>` showing a brief "Impersonation ended" confirmation page
- Optional: window.close() if opened via window.open (when admin clicked the button) — fall
  back to redirect if not popup-spawned

Auto-expiry: if `expires_at < now()` on any page load → force-exit + audit log
`impersonation_expired`.

### 22F — Admin: active impersonation indicator

On admin sidebar/header, show small badge if current admin has any active impersonation
session (queried from audit log + token TTL check). Click → list of active impersonations with
"Force-end" button per row. Useful when admin forgets to exit.

### 22G — Security guarantees

- Token TTL: 1 hour max
- Single-use nonce: nonce stored in admin DB on issue; portal records nonce on first use;
  reusing same token after exit returns 401 (prevents replay)
- Cannot impersonate other admins (only `b2b`-tagged Shopify customers via this path)
- Insiders (Alexander Lass, Mason Flowers per Phase 21) → block impersonation with error
  "Cannot impersonate insider accounts"
- All impersonation activity audit-logged (start, every mutation, every pageview optional,
  end) — searchable in admin audit log viewer
- Cookies: HttpOnly, Secure, SameSite=Lax; expires when token does

### 22H — UX nicety: impersonation history on customer detail

On `/admin/customers/:id`, add a section "Recent impersonation sessions":

```
┌─ Impersonation history ─────────────────────────────────┐
│ alex@fuzzywumpets.com — 2026-05-26 14:32 (READ-ONLY)    │
│   Duration: 23 min  ·  Pages viewed: 18  ·  Actions: 0  │
│                                                          │
│ alex@fuzzywumpets.com — 2026-05-25 10:14 (INTERACTIVE)  │
│   Duration: 8 min  ·  Pages viewed: 5  ·  Actions: 2 -> │
│   [view actions]                                         │
└──────────────────────────────────────────────────────────┘
```

Helpful audit trail for customer support — "When did we last help this customer?" answerable
without grepping logs.

### Tests

- 22B: POST impersonate creates audit log + returns valid token URL
- 22B: token signed with wrong secret → admin endpoint rejects
- 22C: portal /__impersonate__ accepts valid token, creates impersonation session
- 22C: portal rejects expired token (401)
- 22C: portal rejects reused token (401 — nonce already consumed)
- 22D: banner renders on every page during impersonation
- 22D: read-only mode blocks POST /api/cart/event with 403
- 22D: interactive mode allows POST /api/cart/event but logs impersonation_mutation
- 22E: exit destroys session + redirects + audit log
- 22G: insider customer ID → impersonation endpoint returns 403
- 22H: impersonation history section renders on customer detail

### Acceptance for Phase 22

- alexa opens any B2B customer's profile in admin → clicks "View portal as ..."
- New tab opens with the b2b portal showing exactly what the customer sees: their catalog,
  their pricing, their cart, their order history
- Sticky red banner shows "Viewing as <name>" with mode + expires-in + Exit button
- Read-only mode (default): can browse but can't add to cart or place orders
- Interactive mode: can add to cart and check out, but every action is audit-logged + admin
  gets a confirm dialog on mutations
- Click [Exit impersonation] → portal session ends, audit logged, back to admin
- All tests green
