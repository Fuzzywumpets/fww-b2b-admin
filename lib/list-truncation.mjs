// WHAT: shared page-size constants + the "this list was cut off" copy used by the cache-backed
// /orders and /customers lists. Exists so the SQL LIMIT (db.mjs) and the number printed in the UI
// (server.mjs) can never drift apart — before this, db.mjs hardcoded LIMIT 200/100 while the footer
// printed `orders.length` as if it were the complete total.
// CHANGE-GUARD: db.mjs imports these constants as the DEFAULT limit for listOrdersFromCache /
// listCustomersFromCache; server.mjs imports the copy helpers for the list footers. Changing a value
// here changes both the query and the banner — that is the point; do not re-hardcode either side.
// INVARIANT(S): pure module — no db, no express, no side effects, so it is unit-testable without
// starting the server (server.mjs calls app.listen at import time and cannot be imported by tests).

// DEPENDS: db.mjs listOrdersFromCache default limit + server.mjs getOrdersData reporting.
export const ORDERS_LIST_LIMIT = 200;
// DEPENDS: db.mjs listCustomersFromCache default limit + server.mjs getCustomersData reporting.
export const CUSTOMERS_LIST_LIMIT = 100;

// WHAT: the footer count line for a list page. When the result set hit the cap we say "showing the
// first N" instead of "N orders", because the cache path has no pagination and the bare count reads
// as a complete total.
export function listCountLabel({ count, noun, truncated }) {
  const plural = count === 1 ? noun : `${noun}s`;
  if (!truncated) return `${count} ${plural}`;
  return `showing the first ${count} ${plural} — more match, refine the filters`;
}

// WHAT: the warning banner shown above a capped list. Returns '' when nothing was cut off.
// INVARIANT(S): output is static HTML (no interpolation of user input) — safe to inject verbatim.
export function truncationNoticeHtml({ truncated, limit, noun }) {
  if (!truncated) return '';
  const plural = `${noun}s`;
  return `<div class="alert alert-warning" data-truncation-notice>` +
    `Showing only the first ${limit} ${plural}. More ${plural} match this view than can be listed — ` +
    `narrow the search, status or date filters to see the rest.` +
    `</div>`;
}
