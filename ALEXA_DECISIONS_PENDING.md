# Pending decisions / autonomous fixes log

## 2026-05-26 23:50 UTC — Loop crashed (E2BIG)
- Iters 8-20 all exited 126 due to `/usr/bin/claude: Argument list too long`
- Root cause: loop.sh inlined `$(cat HANDOFF.md)` as a CLI arg; HANDOFF.md grew to 158KB after Phase 19/19E/20/21/22/23 appends, exceeding Linux's 128KB per-argument limit (MAX_ARG_STRLEN)
- **Fix applied**: removed the inlining from loop.sh line 33. CONT prompt already instructs agent to "Read HANDOFF.md in full" so no behavior change.
- Backup at loop.sh.bak (kept for safety)
- **Restarted loop** at 23:51 UTC with MAX_ITERS=20

## Pre-crash status
- ✅ Phase 18 (Xero accounting) SHIPPED before crash — 222 tests green
- Remaining queue: 15 (catalogs+teams), 16D (backorder), 19D (persistent cart), 21 (Xero customer sync), 22 (impersonation), 23 (activity warehouse)
- Phase 18 used mock ensureXeroContact; Phase 21 will add real customer sync — agent should reconcile when 21 ships

## 2026-05-27 00:25 UTC — Loop died mid-iter 2 (after Phase 22 shipped)
- Iter 2 commit Phase 22 cleanly (commits 1101431 + 8e3bfc7, 399 tests green)
- tmux session gone, no ITER 2 EXIT logged
- Possible cause: tmux disconnect, claude -p crash post-commit, or OS-level kill
- **Restarted** at 00:25 UTC; loop will continue from current STATE: IN_PROGRESS

## 2026-05-27 01:00 UTC — Loop self-declared DONE but queue not exhausted
- 17 phases shipped, 450 tests green
- Agent set STATE: DONE after Iter 3 shipped 15B + 19D
- I reset STATE: IN_PROGRESS with remaining queue (16D, 24, 25) since alexa standing instruction is "keep churning"
- Restarted loop at 01:00 UTC

## 2026-05-27 ~15:00 UTC — Bugs found in browser E2E test

### Phase 16A "Edit order" line qty changes FAIL with "invalid id"
- Root cause: `orderEditSetQuantity` requires the CalculatedLineItem GID (from `calculatedOrder.lineItems` after `orderEditBegin`), NOT the original LineItem GID
- The form submits original Shopify LineItem IDs (e.g. `gid://shopify/LineItem/12345`)
- Shopify expects `gid://shopify/CalculatedLineItem/67890` (a different ID returned post-begin)
- **Fix:** after orderEditBegin, fetch `calculatedOrder.lineItems` and map old→new IDs by matching variant/sku/title, then use the new IDs in setQuantity calls
- Severity: blocking — edit order is broken in real mode
- Mock mode works fine (no Shopify roundtrip)

### Phase 16A "Edit order" — PRICE editing NOT implemented
- Spec called for "price (editable $)" inline edit per line
- Current UI only has qty input + remove button
- **Fix:** add price input column, on save use `orderEditAddLineItemDiscount` with delta = old_qty*old_price - old_qty*new_price

### Phase 16B "Apply order discount" — silent failure
- After MoneyInput fix, orderEditAddCustomItem accepts the call but the resulting line item doesnt show in the order
- Hypothesis: Shopify rejects negative MoneyInput.amount silently (returns userErrors but commit still succeeds with empty edit)
- **Fix path:** check userErrors on addCustomItem result; if rejected, use orderEditAddLineItemDiscount on existing lines proportionally instead
- Severity: medium — admin says "Discount applied." but Shopify total unchanged

### Phase 16C "Fulfill items" — Shopify API drift
- Current code uses `fulfillmentCreate(input: FulfillmentInput!)` — DEPRECATED
- New API is `fulfillmentCreate(fulfillment: FulfillmentV2Input!)` and requires fetching `fulfillmentOrderId` first via `order.fulfillmentOrders` query
- Error from server: "Field fulfillmentCreate is missing required arguments: fulfillment"
- **Fix path:** (1) before mutation, query order.fulfillmentOrders to get IDs (2) restructure input with fulfillmentOrderLineItems mapping
- Severity: blocking — fulfillment is broken in real mode

### Phase 18 Xero payment record — validation error
- Xero rejected payment record: ContactID 00000000... + AccountNumber 4742401425601 — contact lookup failed
- Reason: Alexander Lass is on insider exclusion list (Phase 21) so resolveXeroContact returns null, but the payment recorder still tried to post
- Already retry-queued, so wont lose data

### Phase 16C "Fulfill items" — Shopify API drift
- Current code uses fulfillmentCreate(input: FulfillmentInput!) — DEPRECATED
- New API is fulfillmentCreate(fulfillment: FulfillmentV2Input!) and requires fetching fulfillmentOrderId first via order.fulfillmentOrders query
- Error: "Field fulfillmentCreate is missing required arguments: fulfillment"
- Fix path: (1) query order.fulfillmentOrders to get IDs (2) restructure input with fulfillmentOrderLineItems mapping
- Severity: blocking — fulfillment broken in real mode

### Phase 18 Xero payment record — validation error
- Xero rejected payment record for Alexander Lass (insider). ContactID 00000000.
- Insider exclusion (Phase 21) only applied to resolveXeroContact, not to payment recording
- Retry queued so no data loss
- Fix path: check isInsider() in mark-paid handler before recording Xero payment

### Phase 16B "Apply order discount" — Shopify constraint, not a fix
- After fixing the calc-id mapping, the mutation now reaches Shopify and gets a real validation error:
  "The order has a discount which prevents applying additional discounts to this line item."
- Cause: every B2B order has the 50% B2B discount applied at draftOrderCreate via appliedDiscount.
  Shopify locks orders with existing discounts against additional orderEditAddLineItemDiscount calls on those lines.
- Tried targeting different line items (first vs last vs custom) — all rejected.
- **Verdict:** Cannot apply post-order discounts via Shopify Admin API on B2B-discounted orders. This is a Shopify platform constraint.
- **Workaround paths:**
  1. Use Shopify Refund mechanism to credit back the discount amount (issues a partial refund as the order-level discount)
  2. Set the B2B discount via per-line price overrides instead of appliedDiscount at draft creation, leaving the order free for later discounts (refactor)
  3. Manual Shopify admin UI "Edit order" allows this in Shopify Plus only

### Phase 16A Remove line — Shopify VOIDED order edge case
- Remove-line mutation reaches Shopify (calc-id mapping correct, idMap finds match) and orderEditCommit succeeds
- But the underlying order.lineItems STILL shows the removed item at qty 1 — the change is queued in calculatedOrder but never persists to the order
- Order goes into VOIDED state after the commit attempt (a void transaction is added)
- Hypothesis: orderEditCommit on a draft-completed PENDING order without payment behaves oddly — payment void instead of line item removal
- Fix path: investigate Shopify behavior on unpaid draft-completed orders + maybe require Mark Paid before edit + remove line
- Severity: low — qty changes still work fine; only line removal on unpaid orders is the issue
