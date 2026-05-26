# fww-b2b-admin — overnight status
STATE: IN_PROGRESS
PHASE: 14 — Customer self-service additions
LAST_UPDATED: 2026-05-26T22:30:00Z

## What shipped this session
- Phase 13: multi-payment checkout on b2b-portal (cross-repo) + Chase stub on admin
  — b2b-portal: Stripe ACH (us_bank_account only), Invoice (gated by allow_order_on_invoice),
    Chase stub modal, 3% prompt-pay discount on ACH
  — b2b-portal: per-customer discount_pct from b2b.* metafields replaces flat 50%
  — b2b-portal: auth callback fetches metafields, session stores b2b config
  — b2b-admin: "Send Chase invoice link" button + stub endpoint on order detail
  — 7 new portal API tests + 3 new admin API tests, all green

## What's working (URLs)
- https://b2badmin.fuzzywumpets.com (Phases 1-10 + Phase 13 admin additions)
- /orders — all orders with source filter chips + "Send Chase Invoice" button
- /customers — all customers with segment filter chips
- /customers/:id — B2B Customer Settings (4 fields) + per-customer discount
- https://b2b.fuzzyreporting.com/checkout — 3 payment methods:
  Invoice (NET 30, gated) / Bank transfer ACH (Stripe, 3% off) / Chase stub (modal)

## Test status
- Admin API: 108/108
- Admin UI:  41/41
- Portal API: 92/92
- Portal UI:  39/39
- Total: 280 green

## Blockers / decisions alexa needs to make
- Stripe webhook secret: create endpoint in Stripe dashboard pointing to
  https://b2b.fuzzyreporting.com/api/webhooks/stripe and add secret to Doppler as
  B2B_PORTAL_STRIPE_WEBHOOK_SECRET (without it, webhooks still work but w/o sig verification)
- Chase API: Phase 13 Chase button is stubbed — logs intent only; will become real
  when Chase merchant API ships

## Next iteration's plan
Phase 14 — Customer self-service additions (on b2b-portal):
- 14A: Stock alerts (back-in-stock notifications) — new stock_alerts SQLite table,
  /api/stock-alerts CRUD, 15-min background job, Resend API email
- 14B: Live order tracking — Received→In process→Shipped→Delivered timeline on /orders/:id,
  includes Shopify fulfillment trackingInfo + polling
- 14C: Tax exemption cert upload — multipart file upload, admin review queue,
  b2b.tax_exempt metafield, orders created tax-exempt when approved
- 14D: Customer-visible notes on orders — visible_notes SQLite, admin adds note on order,
  customer sees on portal, email sent via Resend

Check Doppler for B2B_PORTAL_RESEND_API_KEY before starting 14A/14D.
Resend signup: https://resend.com (free tier 100/day) if key not present.
