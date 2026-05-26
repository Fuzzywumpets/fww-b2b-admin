# fww-b2b-admin — overnight status
STATE: IN_PROGRESS
PHASE: 13 — payment methods at checkout (b2b-portal cross-repo)
LAST_UPDATED: 2026-05-26T22:15:00Z

## What shipped this session
- Phase 9: Broadened /orders and /customers default scope to ALL data
  — filter chips (source for orders, segment for customers)
  — source badge per order row
  — colored tag chips per customer row
  — SparkLayer + POS mock data for testing
- Phase 10: Unified "B2B Customer Settings" section (4 fields)
  — merged Dropship Config + B2B Pricing into one card
  — added allow_order_on_invoice boolean toggle
  — dropped min_order_usd + payment_terms from per-customer scope
  — help text under each field

## What's working (URLs)
- https://b2badmin.fuzzywumpets.com (login page + full Phase 1-10 dashboard)
- /orders — all orders, filter chips: All / B2B portal / SparkLayer / POS / Manual
- /customers — all customers, filter chips: All / B2B-tagged / SparkLayer / Has orders / No orders
- /customers/:id — unified B2B Customer Settings section (4 fields)

## Test status
- API: 105/105
- UI:  41/41
- Total: 130/130 green

## Blockers / decisions alexa needs to make
- Phase 13 (Stripe ACH): Stripe account needed → keys in Doppler as B2B_PORTAL_STRIPE_PK + _SK
  If not yet created: https://stripe.com/register (~10 min)
- Phase 12B (Zelle auto-reconcile): Needs alexa to forward a Chase Zelle-received email
  so the bill-scanner handler knows the exact subject + body format

## Next iteration's plan
1. **Phase 13**: payment methods at checkout on b2b-portal
   - New checkout UI: Invoice / ACH (Stripe) / Chase stub
   - 3% prompt-pay discount when ACH selected
   - Changes are in ~/projects/fww-b2b-portal/server.mjs
   - Stub Chase "Pay with card" modal (no backend yet)
   - Stub "Send Chase invoice link" button on /admin/orders/:id
   - If Stripe keys in Doppler → wire real Stripe ACH flow
   - If no Stripe keys → build mock Stripe flow (tag payment:stripe-ach-pending)

2. **After Phase 13**: Phase 14 (stock alerts, live tracking, tax cert, visible notes)
   and Phase 15 (catalog visibility, multi-user team accounts) — all on b2b-portal

## Notes
- Phase 11/12 superseded by Phase 13 (final payment spec)
- b2b-portal cross-repo changes authorized per HANDOFF.md Phase 10/13
