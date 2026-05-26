# fww-b2b-admin — overnight status
STATE: DONE
PHASE: 7+8 — per-customer overrides + label engine 10 templates — SHIPPED
LAST_UPDATED: 2026-05-26T21:40:00Z

## What shipped this session

### Phase 7: Per-customer B2B config overrides
- `GET /api/admin/customers/:id/b2b-config` — returns { effective, overrides, defaults }
- `PUT /api/admin/customers/:id/b2b-config` — JSON API to set/clear overrides
- `POST /customers/:id/b2b-config` — form handler (redirects to customer page with flash)
- `getB2bConfig()` / `applyB2bConfigUpdate()` helpers — works in mock + calls metafieldsSet/metafieldsDelete in real mode
- **"B2B Pricing & Terms" section** on /customers/:id — shows effective value with
  (default)/(override) badge per field; blank input = clear override; non-blank = set override.
- Audit-logged to admin_audit_log on every change.
- Mock: customer 101 has discount_pct=60 override (demo/test).

### Phase 8: Label engine 10 templates + 6-checkbox fields
- **10 templates total**: Avery 5160, 5161 (NEW), 5163, 5167, 8195 + 5 thermal singles
  (thermal-4x6, thermal-2.25x1.25, thermal-2x1, thermal-3x2, thermal-2x2).
  Thermal = one label per PDF page at exact label dimensions.
- **6-checkbox field selector** replaces old binary product/variant + show-price toggles:
  Product name · Variant name · MSRP · SKU · UPC barcode (graphic) · UPC digits (text)
- Options form always visible on /labels page (not hidden behind item load).
- User's last-used template + fields saved per-email in admin_settings (key: last_label_fields).

## What's working (URLs)
- https://b2badmin.fuzzywumpets.com (live, Google OAuth, all phases)
- /customers/101 — B2B Pricing & Terms section with override badge
- /labels — 10 templates in dropdown, 6-checkbox field selector

## Test status
- API: 97/97
- UI:  41/41
- Total: 138 green

## Blockers / decisions alexa needs to make
None.

## Phases shipped
- Phase 1: Google OAuth + dashboard MVP ✓
- Phase 2: orders + customers ✓
- Phase 3: catalog + reports + settings + migrate ✓
- Phase 4: polish (keyboard shortcuts, PWA, CSV exports) ✓
- Phase 5: UPC barcode label engine ✓
- Phase 6: product CSV + image exports ✓
- Phase 7: per-customer B2B config overrides ✓
- Phase 8: 10 label templates + 6-checkbox fields ✓
