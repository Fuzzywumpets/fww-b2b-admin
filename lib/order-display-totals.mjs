// The one place that knows how to pick the total to SHOW for an order.
//
// Shopify freezes `totalPriceSet`/`subtotalPriceSet` the moment an order is edited;
// `currentTotalPriceSet`/`currentSubtotalPriceSet` carry the post-edit truth. orders_cache mirrors
// both pairs (total_price/subtotal_price frozen, current_total/current_subtotal current).
//
// WHY THIS MODULE EXISTS: on 2026-06-29 the writers and the row hydrator were taught the difference
// and a migration added the current_* columns, whose own comment says "the LIST must show
// current_total". The readers were never changed. Two months later order #38953 was edited from
// $4,771.82 down to $4,469.82 and the Dashboard, the Accounting page, the customer Recent Orders
// table, the customer spend API and the outstanding-balance widget all still showed $4,771.82 — with
// the correct number sitting unread in the next column. A single shared accessor is the only thing
// that stops that drifting apart again.
//
// THE OTHER HALF OF THE RULE, and the way this was still got wrong once: an accessor can only prefer
// a value that was actually fetched. Any query feeding these MUST select currentTotalPriceSet (or
// carry current_total), or the fallback fires silently and the surface looks fixed while showing the
// pre-edit amount. PR #33 shipped three sites in exactly that state.

// WHAT: the display total for a raw orders_cache row (bare column names).
// CHANGE-GUARD: `??`, never `||`. An order edited down to nothing legitimately has a current total of
//   0, and `||` would fall back to the frozen original — reporting money on an order that has none,
//   the same lie pointing the other way. The SQL side uses COALESCE for this reason (it substitutes
//   only NULL, never 0).
// INVARIANT(S): current_total is nullable — rows written before the 2026-06-29 migration, and rows
//   not resynced since, hold NULL and legitimately fall back to the frozen value. A never-edited
//   order has current == frozen, so the fallback is invisible there. Never throws: a missing row
//   yields 0 rather than propagating.
export function cacheRowTotal(row) {
  if (!row) return 0;
  return row.current_total ?? row.total_price ?? 0;
}

// WHAT: the display SUBTOTAL for a raw orders_cache row.
// CHANGE-GUARD: identical `??` semantics to cacheRowTotal — see the note there before changing this.
// INVARIANT(S): same nullability contract as cacheRowTotal; current_subtotal NULL means "unknown,
//   use the frozen subtotal", while 0 means "this order really is worth nothing now".
export function cacheRowSubtotal(row) {
  if (!row) return 0;
  return row.current_subtotal ?? row.subtotal_price ?? 0;
}

// WHAT: the display total for an order in the Shopify/GraphQL shape — either live from the API or
//   hydrated by listOrdersFromCache, which emits both price sets.
// CHANGE-GUARD: the caller's QUERY must select currentTotalPriceSet. This function cannot tell
//   "unedited order" from "field not requested" — both look like absent — so a query that omits it
//   gets the frozen total back with no error and no warning. That is how #33 shipped three surfaces
//   still showing pre-edit amounts after they had supposedly been fixed.
// INVARIANT(S): returns the amount as a STRING (the shape callers pass to fmtMoney), or undefined
//   when neither price set is present; an explicit '0.00' current total is honoured, never treated as
//   missing.
export function listRowTotalAmount(o) {
  const cur = o?.currentTotalPriceSet?.presentmentMoney?.amount;
  if (cur != null && cur !== '') return cur;
  return o?.totalPriceSet?.presentmentMoney?.amount;
}

// WHAT: the current_total / current_subtotal values to STORE from a Shopify REST order payload
//   (the orders/* webhook body).
// CHANGE-GUARD: REST exposes BOTH pairs and `total_price`/`subtotal_price` are the FROZEN ones —
//   despite a comment in the webhook handler that claimed the opposite from 2026-06-29 until it was
//   corrected. Verified against live order #38953 after an edit: `total_price` 4831.82,
//   `current_total_price` 4469.82. Writing the frozen value into current_total stamps the PRE-EDIT
//   amount into the column every reader now trusts, silently undoing the current-vs-frozen fix for
//   every order that path touches — as wrong money, with no error.
// INVARIANT(S): the result is NULLABLE by design. null means "unknown, fall back to the frozen
//   value"; a real 0 (an order edited down to nothing) is stored as 0 and must never be collapsed to
//   null or to the frozen amount — hence the presence check BEFORE the parse, mirroring COALESCE
//   rather than OR on the SQL side. Falls back to the frozen field only when the current one is
//   genuinely absent, which is what a pre-order-edit Shopify payload looks like.
export function restRowCurrentTotals(o) {
  const pick = (cur, frozen) => {
    if (cur != null && cur !== '') return parseFloat(cur) || 0;
    if (frozen != null && frozen !== '') return parseFloat(frozen) || 0;
    return null;
  };
  return {
    current_total:    pick(o?.current_total_price,    o?.total_price),
    current_subtotal: pick(o?.current_subtotal_price, o?.subtotal_price),
  };
}
