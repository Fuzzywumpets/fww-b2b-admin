// WHAT: shared fail-closed walker for Shopify GraphQL connections (2026-10-14 pagination sweep).
//   paginateConnection(fetchPage, label) walks a connection from its FIRST page; the caller supplies
//   fetchPage(after) -> { edges|nodes, pageInfo{hasNextPage endCursor} }.
//   drainRemaining(conn, label, fetchNextPage) finishes a connection whose first page the caller already
//   holds (nested connections that arrived inline in a parent query).
//
// WHY: a `first:N` with no follow-up silently treats page 1 as the whole list (order #39355 lost 36
//   lines; Brain order #39875 lost ~14 lines / $413). Partial data must be an error, never a success.
//
// INVARIANT(S): returns EVERY node or throws. Throws on: missing pageInfo, hasNextPage without an
//   endCursor, a repeated cursor, a null page, or more than maxPages pages. Never returns a prefix.
//
// DEPENDS: lib/line-item-paging.mjs drainLineItems (order lineItems) has the same contract and is
//   kept separate because it predates this file and its errors are matched by order-edit-errors.mjs.
// SYNC: contract mirrors scripts/pagination_guard.py's expectations (cursor loop + pageInfo read).

export const DEFAULT_MAX_PAGES = 40;

function nodesOf(conn) {
  if (Array.isArray(conn?.edges)) return conn.edges.map(e => e.node);
  if (Array.isArray(conn?.nodes)) return conn.nodes;
  return [];
}

export async function drainRemaining(conn, label, fetchNextPage, { maxPages = DEFAULT_MAX_PAGES } = {}) {
  if (!conn) throw new Error(`${label}: connection unavailable`);
  const out = nodesOf(conn);
  const seen = new Set();
  let info = conn.pageInfo;
  if (!info) throw new Error(`${label}: pageInfo missing from connection`);
  for (let page = 0; info.hasNextPage; page++) {
    if (page >= maxPages) throw new Error(`${label}: did not paginate to completion after ${maxPages} pages`);
    if (!info.endCursor) throw new Error(`${label}: hasNextPage without endCursor`);
    if (seen.has(info.endCursor)) throw new Error(`${label}: cursor repeated (${info.endCursor})`);
    seen.add(info.endCursor);
    const next = await fetchNextPage(info.endCursor);
    if (!next) throw new Error(`${label}: page unavailable while paging`);
    if (!next.pageInfo) throw new Error(`${label}: pageInfo missing from continuation page`);
    out.push(...nodesOf(next));
    info = next.pageInfo;
  }
  return out;
}

export async function paginateConnection(fetchPage, label, opts = {}) {
  const first = await fetchPage(null);
  return drainRemaining(first, label, fetchPage, opts);
}
