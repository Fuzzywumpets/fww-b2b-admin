# apiwatch impact report

Entry: 576  
Severity: **critical**

## Summary
Shopify JS Buy SDK is deprecated as of January 2025 and will stop functioning after July 1st, 2025 (hard deadline). The fww-b2b-admin project shares a Shopify backend via shopify-bridge; if that bridge uses JS Buy SDK, purchases will fail post-deadline. Immediate audit of shopify-bridge implementation required.

## Suggested fix
```
1. Check ~/projects/fww-b2b-admin/shopify-bridge for 'js-buy-sdk', 'buySDK', or '@shopify/buy' imports.
2. If found, migrate to Storefront API Client per Shopify's guide (https://shopify.dev/changelog/js-buy-sdk-deprecation-notice).
3. Test cart/checkout flow immediately; deadline is July 1, 2025.
4. If not found in bridge, verify no indirect dependency in package-lock.json that would break.
```

# apiwatch impact report

Entry: 593  
Severity: **high**

## Summary
Shopify is deprecating Content-Type: application/graphql requests and will reject them in 2025-01 schemas. The excerpts show fww-b2b-admin and fww-gmail-sweeper make GraphQL requests to shopify-bridge without explicit Content-Type headers, which likely default to application/graphql and will break when the deadline hits.

## Suggested fix
```
Add `'Content-Type': 'application/json'` to the fetch headers in all GraphQL requests to shopify-bridge. Example:
```
const res = await fetch(BRIDGE, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${BEARER}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query, variables }),
});
```
Search for all `fetch(BRIDGE` calls and ensure the header is set.
```