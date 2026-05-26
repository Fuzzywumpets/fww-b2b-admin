# fww-b2b-admin — overnight status
STATE: IN_PROGRESS
PHASE: 19B + 19C + 16 — hyperlinks, product detail, order editing
LAST_UPDATED: 2026-05-27T04:00:00Z

## What shipped this session
- Phase 19B: Universal hyperlinks
  — Tag chips in customer list are clickable links → /customers?tag=X
  — Audit log email column is mailto: link
  — Audit log GID targets (gid://shopify/Order/*, Customer/*) link to detail pages
  — Lead targets link to /leads/:id
- Phase 19C: Product detail page /products/:id
  — Fetches product from Shopify (or MOCK_PRODUCTS in mock mode)
  — Shows: variants table (SKU, barcode, price, inventory), tags, publication status,
    related orders, image gallery thumbnails, Edit in Shopify deep link
  — /catalog/:id now redirects to /products/:id
  — Order detail line item titles link to /products/:id (resolved from variant.product.id
    or mock MOCK_VARIANT_PRODUCT lookup map)
- Phase 16: Admin order editing
  — 16A: Edit order mode — "Edit order" button activates qty inputs + Remove buttons per line;
    POST /orders/:id/edit via orderEditBegin/commit (real mode) or mockOrderOverrides (mock)
  — 16B: Order discount modal — percentage or fixed, reason required;
    POST /orders/:id/discount
  — 16C: Partial fulfillment modal — per-line checkboxes + qty, carrier + tracking number;
    POST /orders/:id/fulfill → fulfillmentCreate mutation (real) or mock override
  — 16D: Backorder flag — per-line "Backorder" button (visible in edit mode), ETA date;
    POST /orders/:id/backorder saves to SQLite backorders table; badge on line item if active;
    GET /api/orders/:id/backorders returns JSON
  — SQLite: backorders + order_edit_log tables; new db helper functions
  — express.urlencoded extended:true to correctly parse bracket-notation form fields
- Tests: 151 API + 57 UI = 208 total, all green

## What's working (URLs)
- https://b2badmin.fuzzywumpets.com (all phases 1–14 + 16 + 17 + 19A–C + 19E + 20)
- /products/:id — product detail page with variants, publications, related orders
- /orders/:id — edit mode (qty/remove/add), discount modal, fulfill modal, backorder per line
- /leads — wholesale leads pipeline with status workflow
- /leads/new — create new lead
- /leads/:id — lead detail with timeline, status change, notes, convert to customer
- /customers — sorted by lifetime spend, star badges, clickable tag chips
- /customers/:id — Spend section with date range + orders list
- /audit — audit log with mailto: email links + GID target links to order/customer detail
- /catalog — status filter chips (Active default, Draft, Archived, All)
- /tax-exempt — pending tax cert review queue with approve/reject
- https://b2b.fuzzyreporting.com/checkout — 3 payment methods
- https://b2b.fuzzyreporting.com/account — stock alerts + tax cert + portal activity

## Test status
- Admin API:  151/151
- Admin UI:    57/57
- Portal API: 114/114 (separate repo)
- Portal UI:   39/39 (separate repo)
- Total: 361 green

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
- Phase 16: Admin order editing (edit lines, discount, partial fulfillment, backorder) ← NEW
- Phase 17: Wholesale leads CRM
- Phase 19A: Customer spend section on /customers/:id
- Phase 19B: Universal hyperlinks (tag chips, audit log GID links, mailto) ← NEW
- Phase 19C: Product detail page /products/:id ← NEW
- Phase 19E: Catalog tab product status filter
- Phase 20: Priority customer onboarding + Companies research

## Phases remaining (spec in HANDOFF.md, code not yet built)
- Phase 15: Customer-specific catalogs (per-customer private tags) + multi-user team accounts
- Phase 18: Xero accounting integration
- Phase 19D: Persistent cart (b2b portal cross-repo)
- Phase 16E: Billing alignment with partial fulfillment (partial invoices with letter suffix)

## Next iteration's plan
Phase 18 (Xero accounting integration — high business value):
  — xero_invoice_map SQLite table
  — /api/admin/xero/* endpoints (order placed → invoice, payment → Xero payment)
  — Settings page /settings/xero with account mapping UI
  — Trigger on order mark-paid → Xero payment record
  — Accounting reconciliation view /admin/accounting
Phase 15 (customer-specific catalogs + team accounts) if Phase 18 is complex

## Blockers / decisions alexa needs to make
- Email (Resend): B2B_PORTAL_RESEND_API_KEY not set → emails log to console
  Signup at resend.com (free 100/day), add as B2B_PORTAL_RESEND_API_KEY to Doppler
- Stripe webhook: point https://b2b.fuzzyreporting.com/api/webhooks/stripe in Stripe dashboard
- Chase API: stub only — will go live when Chase merchant API ships
