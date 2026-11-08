// WHAT: the ONE definition of the title the app stamps on its own per-line wholesale discount, plus the
//   matcher that recognises it again when an invoice is drawn.
//
// WHY: Shopify ignores a manual unit price on a catalog variant, so a line staff add with the "add product"
//   edit (and an Undo-restored backorder line) goes onto the order at LIST price and is then brought down
//   to the wholesale price with a per-line percentage discount — orderEditAddLineItemDiscount, titled
//   WHOLESALE_DISCOUNT_TITLE. The order total is right, but the invoice used to reconstruct every
//   discounted line "at its pre-discount price" and print the difference as a separate Discount row, so a
//   wholesale-priced line looked like a list-price line with a discount while every other line showed its
//   net wholesale price (partial invoice #39875-A, SKU 04622: $17.99 + "Discount -$9.00"). That discount is
//   the line's PRICE, not a discount the customer was given, so the invoice must not itemise it.
//
// CHANGE-GUARD: the title is the only thing that tells the invoice a discount is the app's own wholesale
//   price rather than a genuine discount (an order-level code, a Discount-modal "Order discount: …", a
//   "B2B price adj"). Never inline the literal at a mutation site — import this constant. Changing the VALUE
//   makes already-committed Shopify discounts stop matching, so every existing wholesale line would print a
//   Discount row again; if it must change, keep recognising the old value too.
//
// DEPENDS: created by server.mjs (POST /orders/:id/edit "Phase 16F" loop and POST /orders/:id/line/add) and by
//   lib/backorder-edit.mjs stageAddVariantAtPrice (Undo of a backorder); matched by pdf.mjs
//   lineItemInvoiceDiscount / lineItemWholesaleDiscount. Shopify returns the title on
//   discountAllocations[].discountApplication.description (ManualDiscountApplication) — every order read that
//   feeds an invoice (getOrderDetail) must select it.
// SYNC: WHOLESALE_DISCOUNT_TITLE — every orderEditAddLineItemDiscount that applies a wholesale price uses
//   this constant, and nothing else may be written under this title.
export const WHOLESALE_DISCOUNT_TITLE = 'B2B wholesale';

// True when a ManualDiscountApplication description is the app's own wholesale-price discount.
export function isWholesaleDiscountDescription(description) {
  return typeof description === 'string' && description.trim() === WHOLESALE_DISCOUNT_TITLE;
}

// True when one discountAllocation (the shape getOrderDetail returns) is the app's wholesale-price discount.
export function isWholesaleDiscountAllocation(allocation) {
  return isWholesaleDiscountDescription(allocation?.discountApplication?.description);
}
