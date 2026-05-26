# fww-b2b-admin — overnight status
STATE: COMPLETE
PHASE: 14 — Customer self-service additions ✓
LAST_UPDATED: 2026-05-26T23:15:00Z

## What shipped this session
- Phase 14A: Stock alerts (back-in-stock)
  — portal: stock_alerts SQLite table, GET/POST/DELETE /api/stock-alerts (idempotent upsert)
  — portal: /account/alerts page to manage alerts
  — portal: background job every 15 min checks variant inventory, emails customer on restock
  — portal: sendEmail helper — queues to email_queue (logs to console until Resend key set)
  — product.html: "Notify me when restocked" button on OOS variants
  — account.html: "Stock alerts" card linking to /account/alerts
- Phase 14B: Live order tracking timeline
  — portal: /api/orders/:id now returns trackingStatus (received/in_process/shipped/delivered)
    and fulfillments array with carrier + tracking number
  — order-detail.html: visual 4-step timeline, shipment cards, 60s polling (stops on delivered)
- Phase 14C: Tax exemption cert upload + admin review
  — portal: multer PDF upload (5MB max), /api/tax-exempt, /api/tax-exempt/status
  — portal: /__internal__/tax-exempt/:id/approve|reject (bearer token auth)
  — portal: approve writes b2b.tax_exempt=true Shopify metafield
  — admin: GET /tax-exempt review queue page (reads portal.db read-only)
  — admin: POST /tax-exempt/:id/approve|reject proxies to portal internal API
  — account.html: tax exemption card (upload form / pending / approved / rejected states)
- Phase 14D: Customer-visible notes on orders
  — portal: visible_notes SQLite table, addVisibleNote/getVisibleNotes helpers
  — portal: /__internal__/visible-note (bearer token) — adds note + emails customer
  — portal: GET /api/admin/orders/:id/visible-notes + POST /api/admin/orders/:id/visible-note
  — admin: POST /api/orders/:id/visible-note proxies to portal internal (with audit log)
  — admin: GET /api/orders/:id/visible-notes reads portal.db directly
  — admin: order detail page has "Note visible to customer" card with live-refresh
  — order-detail.html: shows visible notes from Fuzzywumpets with lime accent
- Navigation: added "Tax Exempt" to admin nav header
- Tests: 114 portal API + 39 portal UI + 122 admin API + 41 admin UI = 316 passing

## What's working (URLs)
- https://b2badmin.fuzzywumpets.com (Phases 1-10, 13, 14)
- /orders — all orders; order detail has visible-notes card + tax-exempt review link
- /tax-exempt — pending tax cert review queue with approve/reject
- /customers/:id — B2B Customer Settings + per-customer discount
- https://b2b.fuzzyreporting.com/checkout — 3 payment methods
- https://b2b.fuzzyreporting.com/account — stock alerts + tax cert + portal activity
- https://b2b.fuzzyreporting.com/account/alerts — manage back-in-stock alerts
- https://b2b.fuzzyreporting.com/orders/:id — tracking timeline + visible notes

## Test status
- Admin API:  122/122
- Admin UI:    41/41
- Portal API: 114/114 (+ was 92 before Phase 14)
- Portal UI:   39/39
- Total: 316 green

## Blockers / decisions alexa needs to make
- Email (Resend): B2B_PORTAL_RESEND_API_KEY not set → emails log to console + queue
  in email_queue table as status='pending_setup'. Signup at resend.com (free 100/day),
  add key to Doppler as B2B_PORTAL_RESEND_API_KEY, from-address as B2B_PORTAL_RESEND_FROM
- Stripe webhook: point https://b2b.fuzzyreporting.com/api/webhooks/stripe in Stripe
  dashboard, add secret to Doppler as B2B_PORTAL_STRIPE_WEBHOOK_SECRET
- Chase API: stub only — will go live when Chase merchant API ships

## Next iteration's plan
Phase 15 — Wholesale leads CRM is already complete (Phase 17+18 shipped earlier).
Check HANDOFF.md for remaining phases:
- Phase 15: Restock / purchase order suggestions (admin: suggest POs from low-stock data)
- Phase 16: Multi-warehouse routing (fulfillment location picker on order detail)
- Any remaining phases in HANDOFF.md not yet started
