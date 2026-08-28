// WHAT: walks a Shopify `lineItems` connection to the END, given a first page the caller already
//   has and a way to fetch the next one.
//
// WHY: every query in the order-edit path asked for `first:100` with no pageInfo and no cursor. On
//   order #38953 — 131 lines, an ordinary wholesale order — that silently hid 31 lines from the
//   entire path (alexa, 2026-08-28):
//     * the batch "Save changes" logged `no calc map for <id>` 31 times, skipped every one of them,
//       and still finished with `commit was a NO-OP — treating as success`;
//     * mapOrigToCalc could not find a line past the 100th, so editing it answered "line not found
//       on order" on every attempt — a permanent failure decided purely by list position;
//     * deriveCurrentOrderTotals got a partial line set, so its Σ-lines fallback subtotal was short
//       by whatever had been cut off.
//   The orders where a dropped line costs the most money are exactly the ones long enough to
//   truncate, and none of it surfaced to the operator.
//
// INVARIANT(S): the caller gets EVERY line or an exception — never a silent prefix. That is the
//   whole point, so the LINE_PAGE_LIMIT backstop THROWS rather than returning what it has.
//
// CHANGE-GUARD: paging errors must stay RETRYABLE (see lib/order-edit-errors.mjs) — they are
//   transient by nature, so these throw plain Errors and deliberately use wording that no
//   TERMINAL_EDIT_ERRORS pattern matches.

// Shopify's per-page ceiling for a connection.
export const LINE_PAGE_MAX = 250;
// Backstop on one walk: 40 × 250 = 10,000 lines. No real order approaches this; the bound exists so
// a malformed or looping cursor cannot spin forever.
export const LINE_PAGE_LIMIT = 40;

export async function drainLineItems(conn, label, fetchNextPage) {
  const nodes = (conn?.edges || []).map(e => e.node);
  let info = conn?.pageInfo;
  for (let page = 0; info && info.hasNextPage; page++) {
    if (page >= LINE_PAGE_LIMIT) {
      throw new Error(`${label}: line items did not paginate to completion after ${LINE_PAGE_LIMIT} pages`);
    }
    const next = await fetchNextPage(info.endCursor);
    if (!next) throw new Error(`${label}: line items unavailable while paging`);
    for (const e of (next.edges || [])) nodes.push(e.node);
    info = next.pageInfo;
  }
  return nodes;
}
