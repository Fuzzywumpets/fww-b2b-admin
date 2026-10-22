// WHAT: keeps customers_cache (what /customers, the dashboard and every B2B-only join read) in step
// with Shopify — a single-customer refresh used by the customers/* webhook, and an incremental
// "customers updated since last poll" sync used by "Sync now" and the background poller.
//
// WHY (2026-10-12): the customers/* webhook used to upsert straight from the REST payload. For this
// app/API version that payload arrives WITHOUT tags / total_spent / orders_count, so every
// CUSTOMERS_UPDATE wrote tags='' (is_b2b=0), spend 0 and orders 0 — demoting a B2B customer out of
// every B2B-only view each time Shopify touched them (seen on customer 5662285201601). The payload is
// now only a trigger: the row is rebuilt from an authoritative GraphQL read, and nothing is written
// if that read fails or comes back without the fields.
//
// INVARIANT(S):
//  - a row is written ONLY from a GraphQL customer node that carries tags, amountSpent and
//    numberOfOrders. A node missing any of them is skipped, never written as ''/0.
//  - the cache stays B2B-scoped: a customer is inserted only when tagged b2b, but a customer who is
//    ALREADY cached is always updated, so removing the tag demotes them (is_b2b=0) instead of
//    leaving a stale is_b2b=1 row behind.
//  - the incremental cursor only advances over what was fully processed; a thrown error leaves it
//    where it was and is rethrown (same contract as lib/orders-recent-sync.mjs).
// DEPENDS: db.mjs upsertCustomerCache derives is_b2b from tags.split(',').includes('b2b') — the row
// built here passes tags as an array, which it joins with ','. scripts/backfill-shopify.mjs
// transformCustomer writes the same columns from the same GraphQL fields.

export const CUSTOMER_B2B_TAG = 'b2b';
export const CUSTOMER_SYNC_PAGE_SIZE = 50;
export const CUSTOMER_SYNC_PAGE_LIMIT = 20;
export const CUSTOMER_SYNC_OVERLAP_MS = 60_000;
export const CUSTOMER_SYNC_COLD_START_MS = 24 * 60 * 60_000;

// SYNC: same field set as scripts/backfill-shopify.mjs backfillCustomers — keep them in step.
export const CUSTOMER_SYNC_FIELDS = `id email firstName lastName displayName createdAt updatedAt
  numberOfOrders amountSpent{amount currencyCode}
  tags
  defaultAddress{company address1 address2 city province country zip}`;

const ONE_QUERY = `query($id:ID!){ customer(id:$id){ ${CUSTOMER_SYNC_FIELDS} } }`;
const LIST_QUERY = `query($q:String!,$first:Int!,$after:String){
  customers(first:$first,after:$after,query:$q,sortKey:UPDATED_AT,reverse:false){
    edges{node{${CUSTOMER_SYNC_FIELDS}}}
    pageInfo{hasNextPage endCursor}
  }
}`;

export function customerGid(id) {
  const s = String(id ?? '').trim();
  if (!s) return null;
  if (s.startsWith('gid://shopify/Customer/')) return s;
  return /^\d+$/.test(s) ? `gid://shopify/Customer/${s}` : null;
}

// Returns the customers_cache row for a complete GraphQL node, or null when the node lacks any of
// the fields the row is derived from (the exact failure the REST webhook payload had).
export function customerNodeToCacheRow(node) {
  if (!node?.id || !Array.isArray(node.tags) || node.amountSpent?.amount == null || node.numberOfOrders == null) return null;
  const amount = parseFloat(node.amountSpent.amount);
  const orders = parseInt(node.numberOfOrders, 10);   // UnsignedInt64 arrives as a string
  if (!Number.isFinite(amount) || !Number.isFinite(orders)) return null;
  const addr = node.defaultAddress || null;
  return {
    shopify_id: node.id.replace('gid://shopify/Customer/', ''),
    gid: node.id,
    email: node.email || null,
    first_name: node.firstName || null,
    last_name: node.lastName || null,
    display_name: node.displayName || [node.firstName, node.lastName].filter(Boolean).join(' ') || node.email || null,
    company: addr?.company || null,
    tags: node.tags,
    amount_spent_total: amount,
    orders_count: orders,
    default_address_json: addr,
    created_at: node.createdAt ? Date.parse(node.createdAt) : null,
    updated_at: node.updatedAt ? Date.parse(node.updatedAt) : null,
  };
}

export function isB2bRow(row) {
  return Array.isArray(row?.tags) && row.tags.includes(CUSTOMER_B2B_TAG);
}

// Applies the B2B-scoping rule. Returns 'upserted' | 'skipped-non-b2b' | 'skipped-incomplete'.
export function applyCustomerNode(node, { upsert, isCached }) {
  const row = customerNodeToCacheRow(node);
  if (!row) return 'skipped-incomplete';
  if (!isB2bRow(row) && !isCached(row.shopify_id)) return 'skipped-non-b2b';
  upsert(row);
  return 'upserted';
}

// Re-reads one customer from Shopify and applies it. Throws on a transport/GraphQL error (nothing is
// written). Returns 'missing' when Shopify has no such customer — the cached row is left alone.
export async function refreshCustomerFromShopify(id, { shopifyFetch, upsert, isCached }) {
  const gid = customerGid(id);
  if (!gid) throw new Error(`invalid customer id: ${id}`);
  const res = await shopifyFetch(ONE_QUERY, { id: gid });
  const node = res?.data?.customer;
  if (!node) return 'missing';
  return applyCustomerNode(node, { upsert, isCached });
}

// Returns { scanned, upserted, truncated, since }.
export async function syncRecentCustomers({
  shopifyFetch, getState, setState, upsert, isCached, now = Date.now,
  pageLimit = CUSTOMER_SYNC_PAGE_LIMIT, pageSize = CUSTOMER_SYNC_PAGE_SIZE,
}) {
  const startedAt = now();
  const state = getState();
  const sinceMs = state?.last_synced_at
    ? state.last_synced_at - CUSTOMER_SYNC_OVERLAP_MS
    : startedAt - CUSTOMER_SYNC_COLD_START_MS;
  const since = new Date(sinceMs).toISOString();

  let after = null, scanned = 0, upserted = 0, maxUpdated = 0, hasNext = false;
  try {
    for (let page = 0; page < pageLimit; page++) {
      const res = await shopifyFetch(LIST_QUERY, { q: `updated_at:>${since}`, first: pageSize, after });
      const conn = res?.data?.customers;
      if (!conn) throw new Error('customers unavailable while polling');
      for (const { node } of conn.edges || []) {
        scanned++;
        if (applyCustomerNode(node, { upsert, isCached }) === 'upserted') upserted++;
        const t = node?.updatedAt ? Date.parse(node.updatedAt) : 0;
        if (t > maxUpdated) maxUpdated = t;
      }
      hasNext = !!conn.pageInfo?.hasNextPage;
      if (!hasNext) break;
      if (!conn.pageInfo.endCursor) throw new Error('customers hasNextPage without cursor');
      after = conn.pageInfo.endCursor;
    }
  } catch (err) {
    setState({ lastSyncedAt: sinceMs + CUSTOMER_SYNC_OVERLAP_MS, lastError: err.message });
    throw err;
  }
  // Complete: everything up to startedAt is in the cache. Capped: only up to the newest row stored
  // (oldest-first paging) — never "now", and never behind where this run started.
  // SYNC: same cursor rule as lib/orders-recent-sync.mjs.
  const truncated = hasNext;
  const nextCursor = truncated ? Math.max(maxUpdated, sinceMs + CUSTOMER_SYNC_OVERLAP_MS) : startedAt;
  setState({ lastSyncedAt: nextCursor, totalSynced: upserted, lastError: null });
  return { scanned, upserted, truncated, since };
}
