// WHAT: the one place that knows how to pick the total to SHOW for an order.
//
// Shopify freezes `totalPriceSet`/`subtotalPriceSet` at the ORIGINAL amounts the moment an order is
// edited; `currentTotalPriceSet`/`currentSubtotalPriceSet` carry the post-edit truth. orders_cache
// mirrors both pairs (total_price/subtotal_price frozen, current_total/current_subtotal current).
//
// WHY THIS MODULE EXISTS: on 2026-06-29 the writers and the row hydrator were taught the difference
// and a migration added the current_* columns, whose own comment says "the LIST must show
// current_total". The readers were never changed. Two months later order #38953 was edited from
// $4,771.82 down to $4,469.82 and the Dashboard, the Accounting page, the customer sales range and
// the customer outstanding-balance widget all still showed $4,771.82 — a $302 overstatement, on
// every edited order in the system, with the correct number sitting unread in the next column.
// A single shared accessor is the only thing that stops that drifting apart again.
//
// CHANGE-GUARD: use `??`, never `||`. A fully-removed order legitimately has a current total of 0,
// and `||` would fall back to the frozen original — reporting money on an order that has none, which
// is the same class of lie this module exists to remove. The SQL side must use COALESCE for the same
// reason (COALESCE substitutes only NULL, never 0).
//
// INVARIANT(S): current_* is nullable — un-resynced rows and orders written before the 2026-06-29
// migration have NULL, and those legitimately fall back to the frozen value. Never-edited orders
// have current == frozen, so the fallback is invisible there.

// A row straight out of orders_cache (raw column names).
export function cacheRowTotal(row) {
  if (!row) return 0;
  return row.current_total ?? row.total_price ?? 0;
}

export function cacheRowSubtotal(row) {
  if (!row) return 0;
  return row.current_subtotal ?? row.subtotal_price ?? 0;
}

// An order in the Shopify/GraphQL shape — either live from the API or hydrated by
// listOrdersFromCache, which emits both price sets.
export function listRowTotalAmount(o) {
  const cur = o?.currentTotalPriceSet?.presentmentMoney?.amount;
  if (cur != null && cur !== '') return cur;
  return o?.totalPriceSet?.presentmentMoney?.amount;
}
