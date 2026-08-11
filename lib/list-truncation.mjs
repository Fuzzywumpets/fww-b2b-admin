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

// DEPENDS: db.mjs getLeads() default limit + the GET /leads route's truncation reporting.
// The leads list had the same defect /orders and /customers had — a hardcoded LIMIT 100 with no
// pagination and no notice — made worse by the status filter chips, whose counts come from an
// UNBOUNDED `GROUP BY status`. A chip could read "New (150)" directly above a 100-row table, so the
// page visibly contradicted itself with no explanation.
export const LEADS_LIST_LIMIT = 100;

// WHAT: the footer count line for a list page. When the result set hit the cap we say "showing the
// first N" instead of "N orders", because the cache path has no pagination and the bare count reads
// as a complete total.
// `total` is OPTIONAL and only some callers can supply it. /orders and /customers read from a cache
// path that has no true total, so they omit it and get the original wording. /leads pairs getLeads
// with countLeads and CAN say the real number, which is strictly more useful than "more match".
// CHANGE-GUARD: the no-`total` branch is the exact string /orders and /customers have shipped since
// PR #13 — do not reword it here without re-checking those two pages. Callers must NOT append their
// own suffix to the truncated branch: it already returns a complete sentence, and concatenating
// (e.g. `... refine the filters` + ` of 342 matching`) produced malformed copy on /leads.
export function listCountLabel({ count, noun, truncated, total }) {
  const plural = count === 1 ? noun : `${noun}s`;
  if (!truncated) return `${count} ${plural}`;
  if (Number.isFinite(total) && total > count) {
    return `showing the first ${count} of ${total} ${noun}s — refine the filters`;
  }
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
