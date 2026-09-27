// Pagination + cursor-advance rules for the orders backstop poller (syncRecentFromShopify).
// Pure logic, extracted so the "did we lose anything?" decisions are testable without Shopify,
// sqlite, or the 12k-line server.
//
// WHY THIS EXISTS (2026-08-28): the poller was `orders(first:50, sortKey:UPDATED_AT, reverse:true)`
// with NO pagination loop — it selected pageInfo{hasNextPage}, never read it, then advanced its
// cursor to now(), permanently dropping every update past 50 in a busy window (and reverse:true
// meant the OLDEST updates were the ones dropped). On error it advanced the cursor anyway, dropping
// the whole window of a failed poll. With webhooks now carrying the real-time load, this poller is
// the backstop for missed deliveries — and a backstop that loses data silently is the one kind not
// worth having.

// DEPENDS: server.mjs syncRecentFromShopify builds its page query from ORDER_SYNC_PAGE_SIZE and
// feeds drainRecentOrders/nextSyncCursorMs; test/order-sync-paging.test.mjs pins both the wiring
// (source guards) and the semantics — change behavior here and that suite says exactly what broke.
export const ORDER_SYNC_PAGE_SIZE = 50; // per-request page — same cost profile as the old single query
export const ORDER_SYNC_PAGE_LIMIT = 6; // hard cap per run (300 orders); nextSyncCursorMs makes hitting it lossless

// WHAT: walks the orders connection page by page, collecting up to ORDER_SYNC_PAGE_LIMIT pages.
// fetchPage(afterCursor) -> a raw GraphQL connection page: { edges:[{node}], pageInfo:{hasNextPage,endCursor} }.
// CHANGE-GUARD: NEVER throws — a mid-drain fetch error returns the pages already collected with
// `error` set, so the caller can still ingest them and advance the cursor over ONLY what landed.
// Contrast lib/line-item-paging.mjs, which THROWS on a partial drain: there a silent prefix poisons
// money math, here a prefix is safe precisely because the cursor rules below refuse to skip past it.
// INVARIANT(S): `drained` is true ONLY when Shopify said hasNextPage:false — hitting the page cap or
// erroring reports drained:false; nodes preserve fetch order; pagesFetched counts pages that
// returned successfully; hasNextPage:true with a missing endCursor aborts with an error rather than
// refetching page 1 forever.
export async function drainRecentOrders(fetchPage) {
  const nodes = [];
  let after = null;
  let pagesFetched = 0;
  try {
    for (;;) {
      const page = await fetchPage(after);
      const edges = page?.edges || [];
      for (const e of edges) if (e?.node) nodes.push(e.node);
      pagesFetched++;
      const pi = page?.pageInfo || {};
      if (!pi.hasNextPage) return { nodes, pagesFetched, drained: true, error: null };
      if (pagesFetched >= ORDER_SYNC_PAGE_LIMIT) return { nodes, pagesFetched, drained: false, error: null };
      if (!pi.endCursor) return { nodes, pagesFetched, drained: false, error: new Error('hasNextPage with no endCursor — cannot continue the walk') };
      after = pi.endCursor;
    }
  } catch (error) {
    return { nodes, pagesFetched, drained: false, error };
  }
}

// WHAT: newest updatedAt (ms epoch) among the ingested nodes, or null when nothing usable landed.
// INVARIANT(S): a node with a missing/unparseable updatedAt is skipped rather than poisoning the max
// with NaN — NaN comparisons are always false, which would silently freeze the cursor.
export function maxUpdatedAtMs(nodes) {
  let max = null;
  for (const n of nodes || []) {
    const t = n?.updatedAt ? new Date(n.updatedAt).getTime() : NaN;
    if (Number.isFinite(t) && (max === null || t > max)) max = t;
  }
  return max;
}

// WHAT: decides how far the poller's since-cursor may HONESTLY advance after a run.
// CHANGE-GUARD: this function IS the fix for "advances its cursor past data it never fetched" — any
// edit must preserve the rule that the cursor never moves past an update that was not ingested.
// INVARIANT(S):
//   drained            -> syncStartMs (everything Shopify had for the window is in the cache;
//                         updates landing DURING the drain fall after syncStart and the caller's 60s
//                         lookback overlap re-reads the boundary next run);
//   partial with nodes -> newest ingested updatedAt (the tail past the page cap / error point is
//                         refetched next run because the cursor sits AT it, not past it — the 60s
//                         overlap also absorbs `updated_at:>` excluding exact-tie timestamps);
//   nothing ingested   -> prevCursorMs unchanged — a failed poll must NOT eat its window (null on a
//                         cold start, so the caller re-arms the same cold-start lookback instead).
export function nextSyncCursorMs({ drained, nodes, syncStartMs, prevCursorMs = null }) {
  if (drained) return syncStartMs;
  const max = maxUpdatedAtMs(nodes);
  if (max !== null) return max;
  return prevCursorMs;
}
