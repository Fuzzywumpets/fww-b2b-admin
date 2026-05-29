# b2b-admin QA Live-Test Inventory -- 2026-05-29
Write-lifecycle audit vs real Shopify/ShipStation. Customer: Alexander Lass (insider 4742401425601). ALL REVERSED.

| time(UTC) | action | system | object | reversed? |
|---|---|---|---|---|
| 00:43 | create order (admin /orders/new) | Shopify | #37073 (6951718453483) qty1 SM @ $42.01 vs $83.99 MSRP | YES - cancelled+restocked 01:09 |
| 00:43 | tag qa-delete | Shopify | #37073 | YES (order cancelled) |
| 00:58 | mark-paid | Shopify | #37073 -> PAID | YES (order cancelled; no real txn) |
| 01:00 | visible-note + Re:amaze email | portal DB + Re:amaze | note rows + conv update-on-your-wholesale-order-number-37073 | YES - 4 note rows deleted; conv left (own addr) |
| 01:05 | ship rates | ShipStation (read) | 22 rates | n/a read-only |
| 03:06 | ship label buy(TEST)+void | ShipStation | label se-test-743169976 ($0 test) | YES - voided |
| 01:09 | cancel + restock | Shopify | #37073 cancelled; inv 2000->2000 | YES (this is the reversal) |

NET: order cancelled + inventory restored to 2000; test notes deleted; test label voided. No real money moved. Xero correctly SKIPPED (insider) at create and mark-paid.
