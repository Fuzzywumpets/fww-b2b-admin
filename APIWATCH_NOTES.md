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