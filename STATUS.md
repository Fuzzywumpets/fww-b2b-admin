# fww-b2b-admin — overnight status

STATE: IN_PROGRESS
PHASE: 9 → 10 → 13 → 14 → 15 (resume + ship pending phases)
LAST_UPDATED: 2026-05-26T22:30:00Z

## Where things stand
Phases 1-8 SHIPPED. Phases 9, 10, 11-rev, 12, 13, 14, 15 are pending — most spec'd in
HANDOFF.md, agent should ship them in order. Phase 11/12 superseded by Phase 13 (final
payment spec).

Tests baseline: 117/117 green (from Phase 1-8). New tests land with each phase.

## Phase build order this loop
1. **Phase 9**: broaden /admin/orders + /admin/customers default scope to ALL orders/customers
   (currently filtered to b2b-portal-tagged orders only — leaving page nearly empty in prod)
2. **Phase 10**: refine the per-customer overrides to exactly 4 fields (drop min_order_usd
   + payment_terms from per-customer scope; add allow_order_on_invoice boolean)
3. **Phase 13**: payment methods at checkout — invoice + Stripe ACH + Chase stubs + 3%
   prompt-pay (supersedes Phase 11/12). Stripe keys ALREADY IN DOPPLER (B2B_PORTAL_STRIPE_PK
   + _SK). Build the customer-side checkout flow on b2b-portal repo (cross-repo authorized
   for this work).
4. **Phase 14**: customer self-service — stock alerts, live tracking (in-process → shipped),
   tax-exempt cert upload, customer-visible notes with email
5. **Phase 15**: per-customer catalog visibility via custom tag + multi-user team accounts
   via magic-link auth

## Pending external deps
- Phase 1 onboarding form deferred until alexa provides her app code
- Phase 14 signature pad: use SignaturePad.js (open source) + pdfkit
- Phase 14 email transport: Resend (free 100/day) — sign up + push API key to Doppler as
  B2B_PORTAL_RESEND_API_KEY if not already there
- Phase 14B ShipStation tracking: pull from existing fww-shipping-bridge worker
