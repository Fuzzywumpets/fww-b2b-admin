# fww-b2b-admin — overnight status
STATE: IN_PROGRESS
PHASE: 3 — catalog + reports + settings
LAST_UPDATED: 2026-05-26T19:37:00Z

## What shipped this session
- **Phase 2 DONE**: Orders + Customers pages (commit 2e6812a)
  - /orders: filterable list, bulk mark-paid, 50/page pagination
  - /orders/:id: full detail — line items, timeline, mark-paid, note editor, PDF invoice
  - /orders/new: manual order builder (customer + product autocomplete, submit as draft order)
  - /customers: b2b-tagged list, sorted by spend, tag filter, search
  - /customers/:id: profile, notes, dropship config, tags editor, recent orders
  - pdf.mjs: pdfkit invoice with PAYMENT PENDING watermark
  - db.mjs: new helpers for customer_notes + dropship_config_cache
  - 52/52 tests green (35 API + 17 UI)

## What's working (URLs)
- https://b2badmin.fuzzywumpets.com/login — login page (LIVE)
- https://b2badmin.fuzzywumpets.com/ — dashboard with real Shopify stats
- https://b2badmin.fuzzywumpets.com/orders — orders list (LIVE)
- https://b2badmin.fuzzywumpets.com/orders/:id — order detail + mark paid + PDF invoice (LIVE)
- https://b2badmin.fuzzywumpets.com/orders/new — manual order form (LIVE)
- https://b2badmin.fuzzywumpets.com/customers — customers list (LIVE)
- https://b2badmin.fuzzywumpets.com/customers/:id — customer detail + notes + dropship (LIVE)
- /catalog, /reports, /settings — stub pages (coming Phase 3)

## Test status
- API: 35/35 ✓
- UI:  17/17 ✓ (incl. mobile 390px)

## Blockers / decisions alexa needs to make
- None. Continue to Phase 3.

## Phase 3 — next iteration's plan
Per HANDOFF.md §"Phase 3 — catalog + reports + settings":

11. **/catalog**: list all products on B2B publication (pub 199709720811).
    Filters: vendor, style (from Style_* tag), in-stock. Per-product: toggle B2B
    inclusion (publishablePublish/Unpublish). Bulk publish/unpublish. Variant inventory.

12. **/migrate** (SparkLayer migrator): find customers with sparklayer-* tags or
    metafields. Bulk-tag them `b2b`. Idempotent. Audit-logged.

13. **/reports**:
    - Sales by customer (top 20 with sparkline)
    - Sales by product (top 50)
    - Month-over-month revenue (last 12 months, inline SVG bar chart)
    - AOV trend
    - All exportable as CSV

14. **/settings**: editable config (B2B discount %, order minimum, payment terms).
    Read-only: pub ID, OAuth issuer, admin allowlist (+ add email form → Doppler).

### Key implementation notes for Phase 3
- B2B publication: gid://shopify/Publication/199709720811
- publishablePublish / publishableUnpublish mutations (already in SCRATCH.md)
- For reports: query last 12 months of b2b-portal orders, group by month/customer/product
- Inline SVG bar chart: pure SVG, no JS charting lib — compute rects server-side
- Settings: read Doppler secrets for display, `doppler secrets set` for writes
  (run child_process.execSync — only for B2B_ADMIN_ALLOWED_EMAILS writes)
- admin_settings SQLite table needed (Phase 5 also uses it): add in db.mjs
