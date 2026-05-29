# b2b-admin Audit Findings -- 2026-05-29 (write-lifecycle, real data)

## FIXED
- A1 (CRITICAL) admin /orders/new discount decimals -- appliedDiscount PERCENTAGE computed with .toFixed(4); Shopify rejects >2 decimals, so EVERY discounted (B2B-priced) manual order returned 400 ("Applied discount value can have at most 2 digits after decimal point"). Manual B2B order creation was fully broken. Fix: .toFixed(4) -> .toFixed(2). Verified: #37073 created, line shows orig $83.99 / discounted $42.01. STATUS: DEPLOYED to prod admin 2026-05-29 (fww-b2b-admin restarted, pid 263849, HTTP 302 healthy); committed+pushed on apiwatch/entry-783. TODO(hygiene): merge entry-783 -> master at next apiwatch reconciliation (real mainline is 'master' [Task#48]; origin/main is stale at Task#45).
- A2 (HIGH) admin "Send note to customer" 500 -- admin proxies POST /__internal__/visible-note (callPortalInternal, Bearer token) but portal had NO /__internal__/* routes -> 404 HTML -> blind r.json() choked -> admin 500. Customer note-emails never worked from the admin. Fix: added POST /__internal__/visible-note (token-auth) to portal reusing addVisibleNote + sendWholesaleEmail. DEPLOYED to prod portal (commit 154b97f, restarted). Verified live: admin note -> portal -> Re:amaze conv + email to alexanderlass@mac.com.

## OPEN
- A3 (MED) tax-exempt approve/reject broken -- SAME root cause as A2. Admin posts /__internal__/tax-exempt/:id/{approve,reject}; portal lacks them -> 500. Needs same internal-route + Shopify customer taxExempt mutation on approve.
- A4 (LOW) shipping-bridge handleLabel has no try/catch -- expired/invalid rate_id -> ShipStation error throws uncaught -> Cloudflare 1101 (non-JSON 500) -> admin r.json() chokes (same mode as A2). Catch + return clean JSON. Happy path verified (rates/buy/void OK).
- A5 (Q) admin does not surface customer REPLIES -- order detail shows outbound visible-notes only. Portal has /api/admin/orders/:id/customer-messages but admin never calls it. So "do replies go back into the admin?" -> currently NO (replies thread in Re:amaze). Enhancement: add internal route + panel.
- A6 (Q/config) tax on B2B order -- #37073 had $3.37 tax. Confirm real B2B customers are flagged taxExempt in Shopify (insider test acct may not be representative).
- A7 (minor) PO goes into note text but Shopify poNumber stays null; percentage-discount rounding can be +/-1c ($42.01 vs $42.00).

## VERIFIED WORKING (live, real data)
order create @ correct B2B price; mark-paid (+ Xero correctly SKIPPED for insider); visible-note -> Re:amaze email; ship rates (22); ship label buy+void (ShipStation test mode); cancel + restock (inv 2000->2000).
