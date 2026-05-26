# fww-b2b-admin — overnight status
STATE: IN_PROGRESS
PHASE: 4 — polish (keyboard shortcuts, CSV exports, audit log viewer, PWA)
LAST_UPDATED: 2026-05-26T21:00:00Z

## What shipped this session
- **Phase 3 DONE**: Catalog + Reports + Settings + Migrate (commit TBD)
  - /catalog: all products with B2B publication toggle, filters (vendor/style/stock/b2b), bulk publish/unpublish
  - /reports: 12-month revenue SVG bar chart, top customers + top products tables, CSV exports for all three
  - /settings: B2B discount %, order min, payment terms (SQLite), admin allowlist viewer + add email (Doppler in prod)
  - /migrate: SparkLayer migration tool — finds sparklayer-tagged customers, bulk-tags them b2b, audit-logged
  - /audit: paginated audit log viewer
  - db.mjs: admin_settings, label_batches, export_batches tables added
  - 84/84 tests green (57 API + 27 UI)

## What's working (URLs)
- https://b2badmin.fuzzywumpets.com/login — login page (LIVE)
- https://b2badmin.fuzzywumpets.com/ — dashboard with real Shopify stats
- https://b2badmin.fuzzywumpets.com/orders — orders list (LIVE)
- https://b2badmin.fuzzywumpets.com/orders/:id — order detail + mark paid + PDF invoice (LIVE)
- https://b2badmin.fuzzywumpets.com/orders/new — manual order form (LIVE)
- https://b2badmin.fuzzywumpets.com/customers — customers list (LIVE)
- https://b2badmin.fuzzywumpets.com/customers/:id — customer detail + notes + dropship (LIVE)
- https://b2badmin.fuzzywumpets.com/catalog — B2B catalog, toggle publish, bulk actions (LIVE)
- https://b2badmin.fuzzywumpets.com/reports — revenue charts + CSV exports (LIVE)
- https://b2badmin.fuzzywumpets.com/settings — config editor + allowlist manager (LIVE)
- https://b2badmin.fuzzywumpets.com/migrate — SparkLayer → b2b migrator (LIVE)
- https://b2badmin.fuzzywumpets.com/audit — paginated audit log (LIVE)

## Test status
- API: 57/57 ✓
- UI:  27/27 ✓ (incl. mobile 390px)

## Blockers / decisions alexa needs to make
- None. Phase 3 is complete. Phase 5 (Label Engine) and Phase 6 (CSV/Image Exports) are already
  shipped in older commits. Phase 4 polish items remain.

## Phase 4 — next iteration's plan
Per HANDOFF.md §"Phase 4 — polish":

15. **CSV exports** everywhere (orders, customers — line items per month already done in reports)
16. **Keyboard shortcuts**: `/` focus search, `g d` dashboard, `g o` orders, `g c` customers, `?` overlay
17. **Audit log viewer /audit** — DONE (shipped this iteration)
18. **Mobile-responsive polish** at 390px — ongoing; tables already in .table-wrap containers
19. **PWA manifest** for installable home-screen icon

Key implementation notes:
- Add `<link rel="manifest" href="/manifest.json">` to layout() extraHead
- manifest.json: name, short_name, start_url, display:standalone, theme_color:#9BBC0E
- Keyboard shortcuts: add a `<script>` block in layout() for global keydown handler
- Orders CSV: GET /orders/export.csv?status=&q=&date= → streams order rows
- Customers CSV: GET /customers/export.csv → streams customer rows
