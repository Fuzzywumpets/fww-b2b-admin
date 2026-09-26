// WHAT: walks Shopify fulfillmentOrders and their nested lineItems to the end.
//
// WHY: /orders/:id/fulfill and /orders/:id/ship/label asked for
// fulfillmentOrders(first:10) and lineItems(first:50) with no pageInfo. An order
// with more open fulfillment orders or more than 50 remaining lines silently
// dropped overflow from auto-fulfill mapping — the same class as #39355.
//
// INVARIANT: callers get a complete original-line-id map or an exception.
// CHANGE-GUARD: paging errors stay retryable plain Errors.

import { drainLineItems } from './line-item-paging.mjs';

export const FO_PAGE_MAX = 50;
export const FO_PAGE_LIMIT = 20;
export const FO_LINE_PAGE_MAX = 50;

const FO_LINE_FIELDS = 'id remainingQuantity lineItem{id title}';

export async function loadOpenFulfillmentLineMap(orderId, shopifyFetch) {
  const fos = [];
  let after = null;
  for (let page = 0; page < FO_PAGE_LIMIT; page++) {
    const res = await shopifyFetch(
      `query($id:ID!,$after:String){order(id:$id){fulfillmentOrders(first:${FO_PAGE_MAX},after:$after){pageInfo{hasNextPage endCursor}edges{node{id status lineItems(first:${FO_LINE_PAGE_MAX}){pageInfo{hasNextPage endCursor}edges{node{${FO_LINE_FIELDS}}}}}}}}}`,
      { id: orderId, after },
    );
    const conn = res.data?.order?.fulfillmentOrders;
    if (!conn) throw new Error('fulfillmentOrders unavailable while paging');
    for (const edge of conn.edges || []) fos.push(edge.node);
    if (!conn.pageInfo?.hasNextPage) {
      after = null;
      break;
    }
    if (!conn.pageInfo.endCursor) throw new Error('fulfillmentOrders hasNextPage without cursor');
    after = conn.pageInfo.endCursor;
  }
  if (after) throw new Error(`fulfillmentOrders did not paginate to completion after ${FO_PAGE_LIMIT} pages`);

  const liMap = {};
  for (const fo of fos) {
    const lines = await drainLineItems(fo.lineItems, `FO ${fo.id} lines`, async (cursor) => {
      const next = await shopifyFetch(
        `query($id:ID!,$after:String){fulfillmentOrder(id:$id){lineItems(first:${FO_LINE_PAGE_MAX},after:$after){pageInfo{hasNextPage endCursor}edges{node{${FO_LINE_FIELDS}}}}}}`,
        { id: fo.id, after: cursor },
      );
      return next.data?.fulfillmentOrder?.lineItems;
    });
    if (fo.status !== 'OPEN' && fo.status !== 'IN_PROGRESS') continue;
    for (const foLi of lines) {
      const origId = foLi.lineItem?.id;
      if (origId && foLi.remainingQuantity > 0) {
        liMap[origId] = { foId: fo.id, foLiId: foLi.id, remaining: foLi.remainingQuantity };
      }
    }
  }
  return liMap;
}
