# fww-b2b-admin — overnight status

STATE: IN_PROGRESS
PHASE: 7+8 — per-customer overrides + label engine extensions
LAST_UPDATED: 2026-05-26T22:00:00Z

## Where things stand
Phases 1-6 SHIPPED in earlier overnight run (117/117 tests green).
- Phase 1: Google OAuth + dashboard MVP
- Phase 2: orders + customers (incl. dropship config on customer detail)
- Phase 3: catalog + reports + settings + migrate + audit
- Phase 4: polish (keyboard shortcuts, PWA, CSV exports)
- Phase 5: UPC barcode label engine (4 Avery templates, product/variant mode, MSRP toggle)
- Phase 6: product CSV + image exports

Live at https://b2badmin.fuzzywumpets.com behind Google OAuth + email allowlist.

## Phase 7+8 — current focus
Per HANDOFF.md §Phase 7 and §Phase 8 (appended at end of file):
- Phase 7: per-customer B2B pricing/terms overrides via Shopify customer metafields
  (b2b.discount_pct, b2b.min_order_usd, b2b.payment_terms). Admin UI on /customers/:id.
- Phase 8: extend label engine to 10 templates (5 Avery + 5 thermal singles) and replace
  binary product/variant toggle with 6-checkbox field selector (product/variant/MSRP/SKU/
  UPC barcode/UPC digits).

## Test status (Phase 1-6 baseline)
- API: 81/81
- UI:  36/36
- Total: 117 green
