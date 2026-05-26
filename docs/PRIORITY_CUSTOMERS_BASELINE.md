# Priority Customers Baseline — 2026-05-26

Top 15 customers by lifetime spend as of 2026-05-26. Used as smoke-test targets for
Phase 19A (customer lifetime spend) and Phase 20 (priority customer onboarding).

## Top 15 by Lifetime Spend

| Rank | Name | Orders | Lifetime Spend |
|------|------|--------|----------------|
| 1  | Mia Wagner           | 254 | $142,838.99 |
| 2  | James Mohs           |  36 | $46,063.98  |
| 3  | Angie Roe            |  27 | $42,477.55  |
| 4  | Mike Ward            |  19 | $28,727.87  |
| 5  | Kathi Luljak         |  34 | $18,895.14  |
| 6  | Susan Arafat         |   5 | $15,154.47  |
| 7  | Amber McCune         |  10 | $15,005.69  |
| 8  | Tina Medley          |   6 | $11,131.84  |
| 9  | Mary Holsen          |  10 |  $9,086.69  |
| 10 | Cyndi Skinner        |   3 |  $8,549.48  |
| 11 | Stephan Olschewski   |  11 |  $8,034.99  |
| 12 | Pat Walsh            |  12 |  $6,827.31  |
| 13 | Megan Schriefer      |  11 |  $6,318.54  |
| 14 | Lisa Zilney          |   5 |  $3,771.70  |
| 15 | Tracy Best           |   3 |  $2,415.00  |

**Combined lifetime revenue (top 15):** ~$355K

## Query Used to Generate This List

```graphql
query {
  customers(first: 20, sortKey: AMOUNT_SPENT, reverse: true, query: "") {
    edges {
      node {
        id displayName email numberOfOrders
        amountSpent { amount currencyCode }
      }
    }
  }
}
```

Run via shopify-bridge POST with Bearer token (see SCRATCH.md).

## Verification Checklist

After shipping Phase 19A (customer lifetime spend section):
- [ ] Open Mia Wagner's profile → lifetime spend should show ~$142,839
- [ ] Open James Mohs's profile → lifetime spend should show ~$46,064
- [ ] Open Mike Ward's profile → lifetime spend should show ~$28,728
- [ ] Open Kathi Luljak's profile → lifetime spend should show ~$18,895
- [ ] Open Angie Roe's profile → lifetime spend should show ~$42,478

Cross-check against Shopify admin: Customers → sort by total spent.
