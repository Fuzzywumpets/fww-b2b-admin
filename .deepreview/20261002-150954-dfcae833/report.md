# DeepReview report

- Verdict: **CLEAN**
- Repository: `fww-b2b-admin`
- HEAD: `dfcae833af17698384396626c1754c97c109add8`
- Evidence packet SHA-256: `836f84ad35e789606df7287610b0d41e80a761d23831ee160eb70492c40a8195`
- Generated: `2026-10-02T20:14:22.717527+00:00`

The new oldest-first poller preserves its retry window on both warm and cold-start failures, and cross-run resume is timestamp-based rather than Shopify-cursor-based. The candidate impacts are contradicted by the control flow in lib/orders-recent-sync.mjs and server.mjs.

## Findings

No evidence-backed defects survived independent validation.
## Deterministic tests

Not run. This must be stated alongside the review verdict.

## Model receipts

- `deepseek/deepseek-v4.1-flash` → `deepseek/deepseek-v4.1-flash`; input `66162`, output `2193`, cost `$0.01018374`
- `deepseek/deepseek-v4.1-flash` → `deepseek/deepseek-v4.1-flash`; input `66146`, output `1401`, cost `$0.00984886`
- `x-ai/grok-4.7` → `x-ai/grok-4.7`; input `73892`, output `21380`, cost `$0.274336`

## Rejected candidate findings

- **Error path advances the cursor instead of leaving it put, contradicting the module's own INVARIANT and the test's assertion** — On a cold start the catch does write lastSyncedAt = startedAt - 5min, but the next run subtracts SYNC_OVERLAP_MS again, so the query bound is exactly the original sinceMs (T1 - 6min), not a later bound. A repeated failure then takes the warm path, where sinceMs + overlap equals the stored cursor, so the window does not re-anchor or shrink. No order is skipped.
- **Error path advances the cursor by SYNC_OVERLAP_MS instead of leaving it unchanged** — Same arithmetic as the other error-path claim. Warm-path sinceMs is stored cursor minus overlap, so the catch write restores that cursor. Cold-start writes a cursor whose next lower bound is the original 6-minute lookback. The claimed shrinking retry window is not what the next getState/setState cycle does.
- **server.mjs caller no longer catches the rethrown error, so a sync failure now skips reconcileOrderDeletions and leaves _lastSyncAt stale** — The empty scheduler catch is real, but the impact is not. reconcileOrderDeletions also needs Shopify and already swallows its own errors; a failed sync only delays it until the next successful tick. _lastSyncAt not moving does not create an unbounded loop: the interval is 60s and _syncing is cleared in finally, and the Shopify cursor itself is still preserved inside syncRecentOrders.
- **Test fakeShopify uses a numeric offset as endCursor, so the 'page cap hit' test does not exercise the real resume contract** — Production never reuses endCursor across runs. after starts null on every syncRecentOrders call; resume is the updatedAt timestamp written at lib/orders-recent-sync.mjs:83 and re-read as the updated_at:> bound. Within one run the filter is constant, so the fake's index cursor matches the only cursor contract this code uses.
- **normalizeRestFulfillmentStatus applied to fulfillment_status but the display_* pair is left inconsistent for the empty-string case** — The cited server.mjs:12391 lines are the GraphQL upsert, which still stores displayFulfillmentStatus and does not call the normalizer. The webhook change intentionally maps REST null/empty fulfillment_status to UNFULFILLED, and financial_status null handling is a separate pre-existing contract. The packet does not show a reader broken by that difference.

---
This is an AI-assisted code review, not proof of correctness. It does not replace deterministic tests or Gauntlet runtime assessment.
