// WHAT: the incremental "orders changed since last poll" sync that keeps orders_cache (what the Orders
// list renders) in step with Shopify, plus the REST->GraphQL fulfillment-status normalizer.
//
// WHY: the poller used to fetch `orders(first:50, sortKey:UPDATED_AT, reverse:true)` once, with no
// paging, and then advance its cursor to "now" no matter what. The query covers EVERY order in the
// store (not just B2B), and the shipping app fulfils dozens of DTC orders a day — so after any idle
// stretch (the poller only runs while the dashboard is open) more than 50 orders had changed, the
// 50 NEWEST won, and the older ones — including B2B orders fulfilled in Shopify — were dropped and the
// cursor jumped past them. They then showed UNFULFILLED in the list until something else touched
// them. (Seen 2026-10-02: six March orders already FULFILLED in Shopify still listed UNFULFILLED.)
//
// INVARIANT(S):
//  - pages OLDEST-first (reverse:false) so progress is monotonic: if the page cap is hit we resume
//    from the newest updatedAt we actually stored, never from "now", so nothing is skipped.
//  - the cursor only advances to a time we have fully processed. A thrown error leaves it where it
//    was (the next run re-covers the window) and is rethrown so callers/"Sync now" see the failure
//    instead of a green no-op.
//  - the 60s overlap is kept: updates landing between polls re-appear in the next window.
// DEPENDS: server.mjs's upsert callback maps exactly the fields in ORDER_SYNC_FIELDS — adding a
// field here means mapping it there (and in scripts/backfill-*.mjs, which write the same columns).

export const SYNC_PAGE_SIZE = 50;
export const SYNC_PAGE_LIMIT = 40;           // 40 x 50 = 2000 orders per run before we hand back and resume next tick
export const SYNC_OVERLAP_MS = 60_000;
export const SYNC_COLD_START_MS = 6 * 60_000;

export const ORDER_SYNC_FIELDS = `id name processedAt updatedAt createdAt cancelledAt
  displayFinancialStatus displayFulfillmentStatus
  totalPriceSet{shopMoney{amount}}
  subtotalPriceSet{shopMoney{amount}}
  currentTotalPriceSet{shopMoney{amount}}
  currentSubtotalPriceSet{shopMoney{amount}}
  totalTaxSet{shopMoney{amount}}
  customer{id email firstName lastName}
  tags sourceName note`;

const QUERY = `query($q:String!,$first:Int!,$after:String){
  orders(first:$first,after:$after,query:$q,sortKey:UPDATED_AT,reverse:false){
    edges{node{${ORDER_SYNC_FIELDS}}}
    pageInfo{hasNextPage endCursor}
  }
}`;

// Returns { synced, truncated, since }. `upsertNode(node)` must write one order into the cache.
export async function syncRecentOrders({
  shopifyFetch, getState, setState, upsertNode, now = Date.now,
  pageLimit = SYNC_PAGE_LIMIT, pageSize = SYNC_PAGE_SIZE,
}) {
  const startedAt = now();
  const state = getState();
  const sinceMs = state?.last_synced_at
    ? state.last_synced_at - SYNC_OVERLAP_MS
    : startedAt - SYNC_COLD_START_MS;
  const since = new Date(sinceMs).toISOString();

  let after = null;
  let synced = 0;
  let maxUpdated = 0;
  let hasNext = false;
  try {
    for (let page = 0; page < pageLimit; page++) {
      const res = await shopifyFetch(QUERY, { q: `updated_at:>${since}`, first: pageSize, after });
      const conn = res.data?.orders;
      if (!conn) throw new Error('orders unavailable while polling');
      for (const { node } of conn.edges || []) {
        upsertNode(node);
        synced++;
        const t = node.updatedAt ? Date.parse(node.updatedAt) : 0;
        if (t > maxUpdated) maxUpdated = t;
      }
      hasNext = !!conn.pageInfo?.hasNextPage;
      if (!hasNext) break;
      if (!conn.pageInfo.endCursor) throw new Error('orders hasNextPage without cursor');
      after = conn.pageInfo.endCursor;
    }
  } catch (err) {
    // Cursor stays put (sinceMs + overlap == the stored value) so the whole window is retried.
    setState({ lastSyncedAt: sinceMs + SYNC_OVERLAP_MS, lastError: err.message });
    throw err;
  }

  // Complete: everything up to startedAt is in the cache. Capped: only up to the newest row stored.
  const cursor = hasNext ? Math.max(maxUpdated, sinceMs + SYNC_OVERLAP_MS) : startedAt;
  setState({ lastSyncedAt: cursor, totalSynced: synced });
  return { synced, truncated: hasNext, since };
}

// REST webhook payloads use null / 'fulfilled' / 'partial' / 'restocked'; the GraphQL poller and both
// backfills write UNFULFILLED / FULFILLED / PARTIALLY_FULFILLED / ... into the same columns and every
// reader compares those. Without this a partly-shipped order read "PARTIAL" or null depending on which
// writer touched it last.
// SYNC: the GraphQL enum names — OrderDisplayFulfillmentStatus.
export function normalizeRestFulfillmentStatus(v) {
  if (v == null || v === '') return 'UNFULFILLED';
  const s = String(v).toUpperCase();
  return s === 'PARTIAL' ? 'PARTIALLY_FULFILLED' : s;
}
