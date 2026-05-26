# Shopify Companies Research — 2026-05-26

Research brief for future Phase 22: migration of FWW B2B customers to Shopify Companies.
Preserved here so the next loop iteration has full context without re-researching.

## Status: DEFERRED — do not build yet

Per alexa's directive 2026-05-26 (Path A): ship current queue (Phases 19–20) first,
migrate to Companies in a future phase once current features are stable.

## Key Facts

### 1. Availability
- Shopify Companies became available on Basic/Grow/Advanced plans as of 2026-04-02 changelog
  (previously Plus-only)
- FWW is on a non-Plus plan → NOW eligible without upgrading
- Source: https://changelog.shopify.com/posts/company-management-now-available-on-all-plans

### 2. Authentication — no re-arch needed
- Shopify Companies use the same Customer Account API OAuth flow as standard customer auth
- A Company Contact authenticates with their email just like a regular Customer Account
- The session object gains a `company` context alongside the `customer` context
- Minimal portal changes: when auth callback fires, check if `company_id` is in the session;
  route B2B logic via the company's metafields instead of the individual customer's

### 3. Native capabilities Companies provides

| Capability | Currently (metafield-based) | With Companies (native) |
|---|---|---|
| Multi-buyer accounts | Phase 15B magic-link hack | Native Company Contacts |
| Per-customer pricing | b2b.discount_pct metafield | Native price lists + catalogs |
| Payment terms | b2b.payment_terms metafield | Native payment terms on Location |
| Tax exemption | b2b.tax_exempt metafield | Native Location-level tax exemption |
| Multiple locations | Single shipping address | Multiple Company Locations |
| Order history shared | N/A (manual) | Shared across all Contacts |

### 4. Bulk migration tool
- Shopify admin has a built-in Customer → Company migration UI
- Supports up to 250 customers at a time
- Order history follows the primary customer automatically
- No API calls needed — it's a one-click admin action per batch

### 5. Catalog cap on non-Plus
- Maximum 3 catalogs on non-Plus plans
- FWW currently uses 1 catalog (B2B publication, gid://shopify/Publication/199709720811)
- Plenty of headroom; not a concern

### 6. Credit limits
- Native Companies does NOT support credit limits natively
- Still must be metafield-based if needed (b2b.credit_limit_usd)
- Not a blocker for FWW since credit limits aren't in scope

### 7. SparkLayer incompatibility
- SparkLayer and Shopify Companies do NOT interoperate
- SparkLayer uses its own customer metafields (sparklayer.* namespace)
- Migration path: tag SparkLayer customers b2b → migrate to Companies → remove SparkLayer tags
- SparkLayer will stop functioning for migrated customers (expected — we're replacing it)

## Future Phase 22 — Migration Plan

### Step 1: Migrate top-15 priority customers to Companies
- Use Shopify admin bulk migration tool
- Priority list: see PRIORITY_CUSTOMERS_BASELINE.md
- Per-customer: verify metafields (b2b.discount_pct etc.) carry over to Company Location

### Step 2: Map existing metafields to native Company config
- b2b.discount_pct → native Price List assignment (or keep as metafield until custom pricing API is stable)
- b2b.payment_terms → native Location payment terms
- b2b.tax_exempt → native Location tax exemption
- b2b.dropship_* → keep as Company metafields (no native equivalent)
- b2b.allow_order_on_invoice → keep as Company metafield

### Step 3: Retire Phase 15B magic-link team accounts
- Replace with native Company Contacts
- Primary = Company's main Contact (Shopify-authed)
- Team members = additional Contacts on the same Company
- Invitation flow: Shopify handles email → contact accepts → portal session minted with company context

### Step 4: Portal session model update
- Auth callback: detect `company_id` from logged-in Contact → load Company's pricing/config
- Cache key: `company_id` (not `customer_id`) for catalog pricing

### Step 5: Phase 14C tax cert upload → optional retirement
- Native Location-level tax exemption could replace the upload-and-approve UX
- Keep the UX but write to Company Location instead of SQLite
- Admin review step remains the same (approve → set native tax exemption on Location)

## GraphQL references (for when we build Phase 22)

```graphql
# Fetch a customer's company
query($customerId: ID!) {
  customer(id: $customerId) {
    id email
    companyContactProfiles {
      company {
        id name
        locations(first: 10) {
          edges {
            node {
              id name
              billingAddress { address1 city province zip country }
              taxExemptions
              paymentTermsTemplate { id name }
            }
          }
        }
      }
    }
  }
}

# Create a Company from a Customer
mutation companyCreate($input: CompanyCreateInput!) {
  companyCreate(input: $input) {
    company { id name }
    userErrors { field message }
  }
}
```

## Source Citations

1. Shopify changelog 2026-04-02: "Company management now available on all plans"
   https://changelog.shopify.com/posts/company-management-now-available-on-all-plans

2. Shopify Help: Getting started with Companies
   https://help.shopify.com/en/manual/b2b/companies

3. Customer Account API + Companies docs
   https://shopify.dev/docs/api/customer

4. GraphQL Admin API — Company object
   https://shopify.dev/docs/api/admin-graphql/latest/objects/Company

5. SparkLayer docs — known incompatibilities with Shopify Companies
   (No public URL; sourced from SparkLayer support documentation 2026-05)
