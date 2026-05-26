# fww-b2b-admin — overnight status
STATE: IN_PROGRESS
PHASE: 19A + 17 — customer spend section + wholesale leads CRM
LAST_UPDATED: 2026-05-27T00:30:00Z

## What shipped this session
- Phase 19A: Customer spend section on /customers/:id
  — GET /api/admin/customers/:id/spend?from=ISO&to=ISO endpoint
  — Date range dropdown: Last 7/30/90 days, 12 months, YTD, All time, Custom
  — AJAX-powered orders list in range, lifetime + range totals
  — Clickable order links + inline invoice PDF download
- Phase 17: Wholesale leads CRM
  — SQLite: leads, lead_notes, lead_status_history tables
  — /leads — list with status filter chips + count badges, search, follow-up dates
  — /leads/new — create form
  — /leads/:id — detail with merged timeline (notes + status history), change-status form
  — Status workflow: new → under_review → waiting_on_docs/tax/w9 → approved → converted
  — /leads/:id/convert — creates Shopify customer + b2b tag + metafields
  — Leads nav item in header (between Customers and Catalog)
- Tests: 136 API + 51 UI = 187 total, all green

## What's working (URLs)
- https://b2badmin.fuzzywumpets.com (all phases 1–14 + 17 + 19A + 19E + 20)
- /leads — wholesale leads pipeline with status workflow
- /leads/new — create new lead
- /leads/:id — lead detail with timeline, status change, notes, convert to customer
- /customers/:id — Spend section with date range + orders list
- /catalog — status filter chips (Active default, Draft, Archived, All)
- /customers — sorted by lifetime spend, star badges on top customers
- /orders — all orders; order detail has visible-notes card + tax-exempt review link
- /tax-exempt — pending tax cert review queue with approve/reject
- https://b2b.fuzzyreporting.com/checkout — 3 payment methods
- https://b2b.fuzzyreporting.com/account — stock alerts + tax cert + portal activity

## Test status
- Admin API:  136/136
- Admin UI:    51/51
- Portal API: 114/114 (separate repo)
- Portal UI:   39/39 (separate repo)
- Total: 340 green

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
- Phase 17: Wholesale leads CRM ← NEW
- Phase 19A: Customer spend section on /customers/:id ← NEW
- Phase 19E: Catalog tab product status filter
- Phase 20: Priority customer onboarding + Companies research

## Phases remaining (spec in HANDOFF.md, code not yet built)
- Phase 15: Customer-specific catalogs (per-customer private tags) + multi-user team accounts
- Phase 16: Admin order editing (modify lines, partial fulfill, backorder, discounts)
- Phase 18: Xero accounting integration
- Phase 19B: Universal hyperlinks across admin (audit + fix all entity cross-links)
- Phase 19C: Product detail page /admin/products/:id
- Phase 19D: Persistent cart (b2b portal cross-repo)

## Next iteration's plan
Phase 19B (universal hyperlinks — easiest wins first):
  — Order list: customer name → /customers/:id link (fix)
  — Customer list: order count → /orders?customer=id link (fix)
  — Audit log: resource IDs → relevant detail page links
  — Order detail: customer name → /customers/:id (fix)
Phase 16 (admin order editing):
  — Edit order line items (qty, price, remove/add)
  — Order-level discount
  — Partial fulfillment modal
  — Backorder flagging

## Blockers / decisions alexa needs to make
- Email (Resend): B2B_PORTAL_RESEND_API_KEY not set → emails log to console
  Signup at resend.com (free 100/day), add as B2B_PORTAL_RESEND_API_KEY to Doppler
- Stripe webhook: point https://b2b.fuzzyreporting.com/api/webhooks/stripe in Stripe dashboard
- Chase API: stub only — will go live when Chase merchant API ships
