# fww-b2b-admin — overnight status
STATE: IN_PROGRESS
PHASE: 19E + 20 — catalog status filter + priority customers
LAST_UPDATED: 2026-05-26T23:35:00Z

## What shipped this session
- Phase 19E: Catalog tab product status filter
  — /catalog defaults to Active products only (new default)
  — Status filter chips: Active / Draft / Archived / All with count badges
  — DRAFT / ARCHIVED row badges + archived rows visually dimmed
  — Two new mock catalog products: draft (#207) and archived (#208)
  — Real mode: passes status:active/draft/archived to Shopify query
- Phase 20: Priority customer onboarding
  — /customers default sort changed to lifetime spend ↓ (was arbitrary)
  — Sort dropdown: Lifetime spend ↓ / Order count ↓ / Name A–Z
  — ★ star badges on top-10 customers by spend
  — Order count column now links to /orders?customer=id
  — Dashboard "Top Customers" widget shows order count column + star badges
  — Mock customers now returned sorted by amountSpent desc
  — docs/PRIORITY_CUSTOMERS_BASELINE.md: top-15 customers (Mia Wagner $142K+)
  — docs/SHOPIFY_COMPANIES_RESEARCH.md: Phase 22 migration research preserved
- Tests: 125 API + 46 UI = 171 total, all green

## What's working (URLs)
- https://b2badmin.fuzzywumpets.com (all phases 1–14 + 19E + 20)
- /catalog — status filter chips (Active default, Draft, Archived, All)
- /customers — sorted by lifetime spend, star badges on top customers
- /orders — all orders; order detail has visible-notes card + tax-exempt review link
- /tax-exempt — pending tax cert review queue with approve/reject
- /customers/:id — B2B Customer Settings + per-customer discount
- https://b2b.fuzzyreporting.com/checkout — 3 payment methods
- https://b2b.fuzzyreporting.com/account — stock alerts + tax cert + portal activity
- https://b2b.fuzzyreporting.com/account/alerts — manage back-in-stock alerts
- https://b2b.fuzzyreporting.com/orders/:id — tracking timeline + visible notes

## Test status
- Admin API:  125/125
- Admin UI:    46/46
- Portal API: 114/114 (separate repo)
- Portal UI:   39/39 (separate repo)
- Total: 324 green

## Phases completed
- Phase 0: Research + scaffold
- Phase 1: Google OAuth + dashboard MVP
- Phase 2: Orders + customers
- Phase 3: Catalog + reports + settings + migrate
- Phase 4: Polish (keyboard shortcuts, CSV exports, PWA)
- Phase 5: UPC barcode label engine
- Phase 6: Product CSV + image ZIP exports
- Phase 7+8: Per-customer B2B config + 10-template label engine
- Phase 9+10: Broaden order/customer scope + unified B2B settings
- Phase 13: Final payment spec (ACH + Chase stub, portal side)
- Phase 14: Customer self-service additions (admin side: tax-exempt review, visible notes)
- Phase 19E: Catalog tab product status filter ← NEW
- Phase 20: Priority customer onboarding + Companies research ← NEW

## Phases remaining (spec in HANDOFF.md, code not yet built)
- Phase 15: Customer-specific catalogs (per-customer private tags) + multi-user team accounts
- Phase 16: Admin order editing (modify lines, partial fulfill, backorder, discounts)
- Phase 17: Wholesale leads CRM-lite pipeline
- Phase 18: Xero accounting integration
- Phase 19: Customer profile depth (lifetime spend section, universal hyperlinks, persistent cart)

## Next iteration's plan
Phase 19 (partial — start with 19A):
- 19A: Customer lifetime spend section on /customers/:id
  — GET /api/admin/customers/:id/spend?from=ISO&to=ISO
  — Date range dropdown (Last 30 days / 90 days / 12 months / YTD / All time / Custom)
  — Orders list with clickable links in the range
Phase 17 (wholesale leads CRM):
  — New leads table in admin.db
  — /leads list + /leads/:id + /leads/new routes
  — Status pipeline: new → under_review → approved → converted

## Blockers / decisions alexa needs to make
- Email (Resend): B2B_PORTAL_RESEND_API_KEY not set → emails log to console
  Signup at resend.com (free 100/day), add as B2B_PORTAL_RESEND_API_KEY to Doppler
- Stripe webhook: point https://b2b.fuzzyreporting.com/api/webhooks/stripe in Stripe dashboard
- Chase API: stub only — will go live when Chase merchant API ships
