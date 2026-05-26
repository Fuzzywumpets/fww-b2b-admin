# fww-b2b-admin — overnight status
STATE: DONE
PHASE: All phases complete (1–6 + Phase 4 polish)
LAST_UPDATED: 2026-05-26T20:15:00Z

## What shipped this session
- **Phase 4 DONE**: Polish — keyboard shortcuts, PWA manifest, CSV exports, nav links
  - Keyboard shortcuts: `/` focus search, `g d/o/c/l/r/b/e` nav, `?` overlay
  - PWA manifest.json + lime-green icon-192.png (installable on home screen)
  - GET /orders/export.csv — streams all B2B orders as CSV
  - GET /customers/export.csv — streams all b2b-tagged customers as CSV
  - Labels + Exports added to nav
- **Phase 5 DONE**: UPC barcode label engine
  - labels.mjs — bwip-js engine; Avery 5160/5163/5167/8195 templates
  - /labels — two-tab page (from order, from products); product/variant mode
  - POST /labels/preview (inline PDF) + /labels/print (download PDF)
  - Per-user prefs saved in admin_settings; batches logged in label_batches
- **Phase 6 DONE**: Product CSV + Image exports
  - /exports — landing page with two cards
  - /exports/csv — column-select product CSV (streaming, no buffering)
  - /exports/images — ZIP download (main-only or gallery mode, streams via ZipArchive)
  - Batches logged to export_batches; archiver dep added
- 117/117 tests green (81 API + 36 UI)

## What's working (URLs)
- https://b2badmin.fuzzywumpets.com/login — login page (LIVE)
- https://b2badmin.fuzzywumpets.com/ — dashboard with real Shopify stats
- https://b2badmin.fuzzywumpets.com/orders — orders list (LIVE)
- https://b2badmin.fuzzywumpets.com/orders/:id — order detail + mark paid + PDF invoice (LIVE)
- https://b2badmin.fuzzywumpets.com/orders/new — manual order form (LIVE)
- https://b2badmin.fuzzywumpets.com/orders/export.csv — orders CSV download
- https://b2badmin.fuzzywumpets.com/customers — customers list (LIVE)
- https://b2badmin.fuzzywumpets.com/customers/:id — customer detail + notes + dropship (LIVE)
- https://b2badmin.fuzzywumpets.com/customers/export.csv — customers CSV download
- https://b2badmin.fuzzywumpets.com/catalog — B2B catalog, toggle publish, bulk actions (LIVE)
- https://b2badmin.fuzzywumpets.com/reports — revenue charts + CSV exports (LIVE)
- https://b2badmin.fuzzywumpets.com/settings — config editor + allowlist manager (LIVE)
- https://b2badmin.fuzzywumpets.com/migrate — SparkLayer → b2b migrator (LIVE)
- https://b2badmin.fuzzywumpets.com/audit — paginated audit log (LIVE)
- https://b2badmin.fuzzywumpets.com/labels — barcode label generator (LIVE)
- https://b2badmin.fuzzywumpets.com/exports — product CSV + image ZIP (LIVE)
- https://b2badmin.fuzzywumpets.com/manifest.json — PWA manifest

## Test status
- API: 81/81 ✓
- UI:  36/36 ✓ (incl. mobile 390px)

## Blockers / decisions alexa needs to make
- None. All phases complete.

## Completed phases
- Phase 1: Google OAuth + dashboard MVP ✓
- Phase 2: Orders + customers ✓
- Phase 3: Catalog + reports + settings + migrate + audit ✓
- Phase 4: Polish (keyboard shortcuts, CSV exports, PWA manifest) ✓
- Phase 5: UPC barcode label engine ✓
- Phase 6: Product CSV + image ZIP exports ✓
