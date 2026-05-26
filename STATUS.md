# fww-b2b-admin — overnight status
STATE: IN_PROGRESS
PHASE: 21 — Xero customer sync on B2B creation
LAST_UPDATED: 2026-05-26T23:57:00Z

## What shipped this session
- Phase 21: Xero customer sync on B2B creation
  — lib/xero-customer-sync.mjs: resolveXeroContact (mapping→live), syncCustomerToXero
    (idempotent), isInsider (exclusion list), getXeroSyncStatus (4 states)
  — GET /api/admin/customers/:id/xero-status — returns sync state JSON
  — POST /api/admin/customers/:id/xero-sync — on-demand sync trigger
  — /customers/:id sidebar: async-loading Xero card (synced/merged/insider/not_synced)
    Merged contacts show "⚭ Merged contact" banner; insiders show gray "not applicable"
  — Lead conversion → non-blocking Xero sync fires after Shopify customer creation
  — b2b tag-add → non-blocking Xero sync fires when 'b2b' tag added
  — ensureXeroContact (Phase 18) now uses resolveXeroContact first (avoids dup contacts)
  — docs/XERO_CUSTOMER_SYNC.md: reference doc (mapping key, merged contacts, Pat Walsh TODO)
  — 13 new API tests + 2 new UI tests (238 total, all green)

## What's working (URLs)
- https://b2badmin.fuzzywumpets.com (all phases 1–21)
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
- Admin API:  174/174
- Admin UI:    64/64
- Portal API: 114/114 (separate repo)
- Portal UI:   39/39 (separate repo)
- Total: 391 green

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
- Phase 21: Xero customer sync on B2B creation ← NEW

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
Phase 22 (Admin "View portal as customer" impersonation):
  22A: B2B_IMPERSONATION_SECRET Doppler secret (generate + push if missing)
  22B: POST /api/admin/customers/:id/impersonate → HMAC-signed token + URL
       Modal: read-only (default) vs interactive mode
  22C: Portal GET /__impersonate__?token=<tok> → validates + creates impersonation session
  22D: Portal: sticky red banner "Viewing as <name>" on every page; read-only enforcement
  22E: Exit impersonation (portal + audit log)
  22G: Security: 1hr TTL, nonce single-use, insider block, full audit trail

OR Phase 23 (Customer activity warehouse):
  23A: customer_activity SQLite table in portal (90-day, IP hashed, events by type)
  23B: Express middleware auto-logs page_view + api_call on every authed request
  23E: Admin /customers/:id/activity viewer (date range filter, event type filter)
  23F: Quick lookup "did customer place order on date X?"

## Blockers / decisions alexa needs to make
- Email (Resend): B2B_PORTAL_RESEND_API_KEY not set → emails log to console
  Signup at resend.com (free 100/day), add as B2B_PORTAL_RESEND_API_KEY to Doppler
- Stripe webhook: point https://b2b.fuzzyreporting.com/api/webhooks/stripe in Stripe dashboard
- Chase API: stub only — will go live when Chase merchant API ships
- Xero: account codes default to 200/610/1110/1120/6100/400 — verify these match your Xero COA
  Then test via /settings/xero → "Test connection"
