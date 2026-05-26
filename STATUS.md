# fww-b2b-admin — overnight status
STATE: IN_PROGRESS
PHASE: 18 — Xero accounting integration
LAST_UPDATED: 2026-05-27T05:30:00Z

## What shipped this session
- Phase 18: Xero accounting integration
  — xero_invoice_map + xero_pending_actions SQLite tables + 8 helper functions
  — xeroRequest() bridge helper (mock: stubs Contacts/Invoices/Payments/Accounts endpoints)
  — ensureXeroContact(), createXeroInvoice(), recordXeroPayment() core logic
  — retryXeroPending() with 3x retry cap; syncOrderToXero() on-demand
  — GET/POST /settings/xero: account code mapping (sales_revenue, A/R, chase_checking,
    stripe_clearing, processing_fees, discounts, payment_terms_days)
  — GET /accounting: reconciliation view (invoice map + pending retry queue + counts)
  — POST /api/admin/xero/test: connection test, returns account count
  — POST /api/admin/xero/sync: manual retry trigger for pending actions
  — POST /orders/:id/xero/sync: per-order Xero invoice sync button
  — mark-paid route: non-blocking async Xero payment record (queue on failure)
  — Order detail: Xero sidebar card (synced/retry-queued/not-synced states)
  — "Accounting" added to header nav
  — 10 new API tests + 4 new UI tests

## What's working (URLs)
- https://b2badmin.fuzzywumpets.com (all phases 1–20)
- /accounting — Xero reconciliation view (synced orders, pending retries, counts)
- /settings/xero — account code mapping + connection test button
- /orders/:id — Xero sidebar card + "Sync to Xero" button in action bar
- /orders/:id/xero/sync — creates Xero AUTHORISED invoice for any order
- mark-paid → auto-triggers Xero payment recording (non-blocking)
- /products/:id — product detail page with variants, publications, related orders
- /orders/:id — edit mode (qty/remove/add), discount modal, fulfill modal, backorder per line
- /leads — wholesale leads pipeline with status workflow
- /customers — sorted by lifetime spend, star badges, clickable tag chips
- /customers/:id — Spend section with date range + orders list
- /catalog — status filter chips (Active default, Draft, Archived, All)
- /tax-exempt — pending tax cert review queue with approve/reject
- https://b2b.fuzzyreporting.com/checkout — 3 payment methods
- https://b2b.fuzzyreporting.com/account — stock alerts + tax cert + portal activity

## Test status
- Admin API:  161/161
- Admin UI:    61/61
- Portal API: 114/114 (separate repo)
- Portal UI:   39/39 (separate repo)
- Total: 375 green

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
- Phase 16: Admin order editing (edit lines, discount, partial fulfillment, backorder)
- Phase 17: Wholesale leads CRM
- Phase 18: Xero accounting integration ← NEW
- Phase 19A: Customer spend section on /customers/:id
- Phase 19B: Universal hyperlinks (tag chips, audit log GID links, mailto)
- Phase 19C: Product detail page /products/:id
- Phase 19E: Catalog tab product status filter
- Phase 20: Priority customer onboarding + Companies research

## Phases remaining (spec in HANDOFF.md, code not yet built)
- Phase 15: Customer-specific catalogs (per-customer private tags) + multi-user team accounts
- Phase 19D: Persistent cart (b2b portal cross-repo)
- Phase 16E: Billing alignment with partial fulfillment (partial invoices with letter suffix)

## Xero integration details (for alexa)
- Bridge: https://fww-xero-bridge.alex-037.workers.dev/xero (XERO_BRIDGE_BEARER in Doppler ✓)
- Trigger: admin marks an order paid → Xero payment auto-recorded (non-blocking)
- Manual: any order detail page → "Sync to Xero" button → creates AUTHORISED invoice
- Account codes: defaults are 200/610/1110/1120/6100/400 — configure at /settings/xero
- Failures: queued in xero_pending_actions; retry at /accounting → "Retry pending actions"
- Connection test: /settings/xero → "Test connection" button → shows account count

## Next iteration's plan
Phase 15 (customer-specific catalogs + multi-user team accounts):
  15A: catalog_access_tags per-customer metafield
      — admin: chip-style multi-select on /customers/:id B2B Settings
      — portal: filter catalog per customer's access tags
      — private tag list in /admin/settings
  15B: multi-user team accounts (magic-link invite flow)
      — companies + company_users + magic_link_codes SQLite tables
      — POST /account/team/invite (primary user sends email invite)
      — GET /team-login?email=&token= (invitee clicks link → session)
      — POST /team-login (future logins: email + 6-digit code)
      — Session carries company_id; orders attributed to primary customer

OR Phase 16E (partial invoices):
  — Partial invoice (fulfilled items only), letter suffix (#1234-A, #1234-B)
  — partial_invoices SQLite table
  — "Generate invoice for fulfilled items only" mode on /orders/:id

## Blockers / decisions alexa needs to make
- Email (Resend): B2B_PORTAL_RESEND_API_KEY not set → emails log to console
  Signup at resend.com (free 100/day), add as B2B_PORTAL_RESEND_API_KEY to Doppler
- Stripe webhook: point https://b2b.fuzzyreporting.com/api/webhooks/stripe in Stripe dashboard
- Chase API: stub only — will go live when Chase merchant API ships
- Xero: account codes default to 200/610/1110/1120/6100/400 — verify these match your Xero COA
  Then test via /settings/xero → "Test connection"
