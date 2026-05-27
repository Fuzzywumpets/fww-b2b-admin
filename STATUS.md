# fww-b2b-admin — overnight status
STATE: DONE
PHASE: 24 + 25 — data import + vendor filter — COMPLETE
LAST_UPDATED: 2026-05-27T02:30:00Z

## Shipped this session (20 phases)
Phases 9, 10, 13, 14, 15A, 15B, 16A, 16B, 16C, 16D, 16E, 17, 18, 19A, 19B, 19C, 19D, 19E, 20, 21, 22, 23, 24, 25
- Admin tests: 209 API + 68 UI = 277 green (up from 450 total, all green)

## Phase 24 (data import + sync) — shipped
- db.mjs: 5 new cache tables (customers_cache, orders_cache, order_line_items_cache,
  sync_state, products_cache) with indexes + 14 helper functions
- POST /webhooks/shopify: HMAC-SHA256 verified; routes orders/customers/products topics
- Background syncRecentFromShopify() polling every 5 min (live mode only)
- GET /invoices: unified regular + partial invoices with Xero status
- scripts/backfill-shopify.mjs: one-shot CLI for historical backfill
  (--resource, --b2b-only, --full, --since, --all-vendors flags)
- Doppler: SHOPIFY_WEBHOOK_SECRET added for webhook HMAC

## Phase 25 (vendor filter) — shipped
- Catalog defaults to vendor:Fuzzywumpets; ?vendor=all bypasses
- Vendor select shows "Fuzzywumpets (default)" as selected option
- Non-FWW product detail shows informational banner

## No pending phases
All queued phases from HANDOFF.md are complete.
Next work: run backfill against live Shopify (doppler run -- node scripts/backfill-shopify.mjs --all --b2b-only)
then register webhooks in Shopify admin pointing to https://<host>/webhooks/shopify
