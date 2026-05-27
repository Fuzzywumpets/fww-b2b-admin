# fww-b2b-admin — overnight status
STATE: IN_PROGRESS
PHASE: 22 — Admin "View portal as customer" impersonation
LAST_UPDATED: 2026-05-27T01:30:00Z

## What shipped this session
- Phase 22: Admin "View portal as customer" impersonation
  — B2B_IMPERSONATION_SECRET Doppler secret (64-char hex, generated + pushed)
  — Admin db.mjs: impersonation_nonces table (nonce, customerId, adminEmail, readOnly, exp, used_at)
    + createImpersonationNonce / consumeImpersonationNonce / gcImpersonationNonces helpers
  — Admin server.mjs: makeImpersonationToken (HMAC-SHA256 signed, base64url encoded)
    POST /api/admin/customers/:id/impersonate → 1-hr single-use token, audit-logged
  — Customer detail /customers/:id: "View in Portal" button → modal with read-only toggle
    (opens portal in new tab via fetch → token URL)
  — Portal db.mjs: sessions.impersonation column (ALTER TABLE migration), used_impersonation_nonces table
    + setImpersonationOnSession, isNonceUsed, markNonceUsed, gcUsedNonces
  — Portal server.mjs: GET /__impersonate__?tok=<token>
    → verifies HMAC sig + exp + single-use nonce → creates 1-hr portal session with impersonation flag
    → requireMutable middleware blocks /api/cart/* and /api/checkout POST for read-only sessions
    → /api/me now includes impersonation object {adminEmail, readOnly, startedAt, expiresAt}
  — Portal app.js: sticky red banner "Viewing as <name> (read-only) [Exit impersonation]"
    injected by boot() when session.impersonation is set
  — Security: 1-hr TTL on token, single-use nonce (portal stores used nonces), HMAC-SHA256 sig
  — Exit: portal's /auth/logout clears the impersonation session
  — 4 new admin API tests + 2 new admin UI tests → 244 total (178 API + 66 UI), all green
  — 6 new portal API tests → 155 total (116 API + 39 UI), all green

## What's working (URLs)
- https://b2badmin.fuzzywumpets.com (all phases 1–22)
- /customers/:id → "View in Portal" button → modal → opens portal as that customer
- https://b2b.fuzzyreporting.com/__impersonate__?tok=... → validates + creates session
- Red banner on portal pages when in impersonation mode
- POST cart/checkout blocked in read-only mode
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
- Admin API:  178/178
- Admin UI:    66/66
- Portal API: 116/116 (separate repo)
- Portal UI:   39/39 (separate repo)
- Total: 399 green

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
- Phase 18: Xero accounting integration
- Phase 19A: Customer spend section on /customers/:id
- Phase 19B: Universal hyperlinks (tag chips, audit log GID links, mailto)
- Phase 19C: Product detail page /products/:id
- Phase 19E: Catalog tab product status filter
- Phase 20: Priority customer onboarding + Companies research
- Phase 21: Xero customer sync on B2B creation
- Phase 22: Admin "View portal as customer" impersonation ← NEW

## Phases remaining (spec in HANDOFF.md, code not yet built)
- Phase 15: Customer-specific catalogs (per-customer private tags) + multi-user team accounts
- Phase 19D: Persistent cart (b2b portal cross-repo)
- Phase 16E: Billing alignment with partial fulfillment (partial invoices with letter suffix)
- Phase 23: Customer activity warehouse (90-day audit trail for dispute resolution)

## Xero integration details (for alexa)
- Bridge: https://fww-xero-bridge.alex-037.workers.dev/xero (XERO_BRIDGE_BEARER in Doppler ✓)
- Trigger: admin marks an order paid → Xero payment auto-recorded (non-blocking)
- Manual: any order detail page → "Sync to Xero" button → creates AUTHORISED invoice
- Account codes: defaults are 200/610/1110/1120/6100/400 — configure at /settings/xero
- Failures: queued in xero_pending_actions; retry at /accounting → "Retry pending actions"
- Connection test: /settings/xero → "Test connection" button → shows account count

## Impersonation details (for alexa)
- Admin side: /customers/:id → "View in Portal" button → modal → "Open Portal →"
- Read-only (default): can browse catalog and orders, cart/checkout blocked
- Interactive: full access as that customer (test checkout flows, etc.)
- Token TTL: 1 hour, single-use
- Exit: click "Exit impersonation" in the red banner → /auth/logout

## Next iteration's plan
Phase 23 (Customer activity warehouse):
  23A: customer_activity SQLite table in portal (90-day, events by type)
  23B: Express middleware auto-logs page_view + api_call on every authed request
  23E: Admin /customers/:id/activity viewer (date range filter, event type filter)
  23F: Quick lookup "did customer access portal on date X?"

## Blockers / decisions alexa needs to make
- Email (Resend): B2B_PORTAL_RESEND_API_KEY not set → emails log to console
  Signup at resend.com (free 100/day), add as B2B_PORTAL_RESEND_API_KEY to Doppler
- Stripe webhook: point https://b2b.fuzzyreporting.com/api/webhooks/stripe in Stripe dashboard
- Chase API: stub only — will go live when Chase merchant API ships
- Xero: account codes default to 200/610/1110/1120/6100/400 — verify these match your Xero COA
  Then test via /settings/xero → "Test connection"
