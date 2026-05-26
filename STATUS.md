# fww-b2b-admin — overnight status
STATE: IN_PROGRESS
PHASE: 2 — orders + customers
LAST_UPDATED: 2026-05-26T19:20:00Z

## What shipped this session
- **Phase 1 DONE**: Google OAuth + dashboard MVP (commit dde366c)
  - db.mjs: SQLite schema (admin_sessions, audit_log, customer_notes, dropship_config_cache)
  - Full Google OAuth flow: /auth/login → callback → email allowlist gate → session mint
  - Login page: branded FWW card with Google sign-in
  - Dashboard /: 4 widgets — open orders, this-week count, top 5 customers, low-stock B2B items
  - Header nav with all 6 sections
  - Mobile-responsive (390px tested)
  - 24/24 tests green (13 API + 11 UI/Playwright)

## What's working (URLs)
- https://b2badmin.fuzzywumpets.com/login — login page (LIVE)
- https://b2badmin.fuzzywumpets.com/healthz — health check (LIVE)
- https://b2badmin.fuzzywumpets.com/ — dashboard after Google login (LIVE)
- /orders, /customers, /catalog, /reports, /settings — stub pages (auth-gated, coming soon)

## Screenshots
- runs/screenshots/p1-login.png
- runs/screenshots/p1-dashboard.png

## Test status
- API: 13/13 ✓
- UI:  11/11 ✓ (incl. mobile 390px)

## Blockers / decisions alexa needs to make
- None. Continue to Phase 2.

## Phase 2 — next iteration's plan
Per HANDOFF.md §"Phase 2 — orders + customers":

6. **/orders**: list all b2b-portal tagged orders; filters (status, customer, date); search;
   bulk actions (mark paid, add note); pagination 50/page.

7. **/orders/:id**: full order detail — line items, status timeline, mark paid action,
   note editor, PDF invoice (pdfkit).

8. **/customers**: list b2b-tagged customers sorted by lifetime spend; filter/search.

9. **/customers/:id**: profile, tags editor, lifetime spend, recent orders, internal notes
   (customer_notes SQLite), dropship config (Shopify metafields via shopify-bridge).

10. **/orders/new**: manual order builder — pick customer, add line items, set shipping,
    submit as draftOrderCreate + draftOrderComplete (paymentPending: true).

### Key implementation notes
- All Shopify writes via shopify-bridge (SHOPIFY_BRIDGE_BEARER from Doppler)
- All mutations → auditLog() call
- Mark paid: orderMarkAsPaid mutation (see SCRATCH.md)
- Dropship: metafieldsSet with namespace b2b, keys dropship_enabled + dropship_margin_pct
- PDF: use pdfkit (install as dep), don't import from b2b-portal
- Bulk actions: form POST with array of order IDs, action type
- Pagination: cursor-based (Shopify) mapped to ?after= query param
