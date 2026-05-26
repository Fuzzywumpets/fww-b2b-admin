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
