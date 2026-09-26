// WHAT: complete Shopify walks for dashboard KPIs and the live customer-spend fallback.
//
// WHY: getDashboardData used orders(first:50) and products(first:100)/variants(first:10)
// with no continuation. Open/week counts and the low-stock widget then treated that
// prefix as the whole book. Customer spend's live path used orders(first:250) the
// same way.
//
// INVARIANT: a short or looping page throws; callers must not present a prefix as
// a complete count. The dashboard renderer already surfaces .error instead of fake zeros.

export const DASHBOARD_ORDER_PAGE = 50;
export const DASHBOARD_ORDER_PAGE_LIMIT = 40;
export const DASHBOARD_PRODUCT_PAGE = 100;
export const DASHBOARD_PRODUCT_PAGE_LIMIT = 40;
export const DASHBOARD_VARIANT_PAGE = 50;

export async function drainDashboardOrders(shopifyFetch, query) {
  const orders = [];
  let after = null;
  for (let page = 0; page < DASHBOARD_ORDER_PAGE_LIMIT; page++) {
    const result = await shopifyFetch(
      `query($q:String!,$after:String){orders(first:${DASHBOARD_ORDER_PAGE},query:$q,after:$after,sortKey:PROCESSED_AT,reverse:true){edges{node{id name processedAt customer{id displayName email} displayFinancialStatus totalPriceSet{presentmentMoney{amount currencyCode}} currentTotalPriceSet{presentmentMoney{amount currencyCode}} tags}}pageInfo{hasNextPage endCursor}}}`,
      { q: query, after },
    );
    const conn = result.data?.orders;
    if (!conn) throw new Error('dashboard orders unavailable while paging');
    for (const edge of conn.edges || []) orders.push(edge.node);
    if (!conn.pageInfo?.hasNextPage) return orders;
    if (!conn.pageInfo.endCursor) throw new Error('dashboard orders hasNextPage without cursor');
    after = conn.pageInfo.endCursor;
  }
  throw new Error(`dashboard orders did not paginate to completion after ${DASHBOARD_ORDER_PAGE_LIMIT} pages`);
}

export async function drainLowStockItems(shopifyFetch, publicationId) {
  const items = [];
  let after = null;
  for (let page = 0; page < DASHBOARD_PRODUCT_PAGE_LIMIT; page++) {
    const result = await shopifyFetch(
      `query($after:String,$pub:ID!){products(first:${DASHBOARD_PRODUCT_PAGE},after:$after,query:"published_status:published"){edges{node{id title publishedOnPublication(publicationId:$pub) variants(first:${DASHBOARD_VARIANT_PAGE}){pageInfo{hasNextPage endCursor}edges{node{sku title inventoryQuantity}}}}}pageInfo{hasNextPage endCursor}}}`,
      { after, pub: publicationId },
    );
    const conn = result.data?.products;
    if (!conn) throw new Error('dashboard products unavailable while paging');
    for (const edge of conn.edges || []) {
      const product = edge.node;
      if (!product?.publishedOnPublication) continue;
      const variants = await drainProductVariants(shopifyFetch, product);
      for (const variant of variants) {
        if (typeof variant.inventoryQuantity === 'number' && variant.inventoryQuantity < 10) {
          items.push({
            productId: product.id,
            productTitle: product.title,
            variantTitle: variant.title,
            sku: variant.sku,
            qty: variant.inventoryQuantity,
          });
        }
      }
    }
    if (!conn.pageInfo?.hasNextPage) return items;
    if (!conn.pageInfo.endCursor) throw new Error('dashboard products hasNextPage without cursor');
    after = conn.pageInfo.endCursor;
  }
  throw new Error(`dashboard products did not paginate to completion after ${DASHBOARD_PRODUCT_PAGE_LIMIT} pages`);
}

async function drainProductVariants(shopifyFetch, product) {
  const variants = (product.variants?.edges || []).map((edge) => edge.node);
  let info = product.variants?.pageInfo;
  while (info?.hasNextPage) {
    if (!info.endCursor) throw new Error(`dashboard variants missing cursor for ${product.id}`);
    const next = await shopifyFetch(
      `query($id:ID!,$after:String){product(id:$id){variants(first:${DASHBOARD_VARIANT_PAGE},after:$after){pageInfo{hasNextPage endCursor}edges{node{sku title inventoryQuantity}}}}}`,
      { id: product.id, after: info.endCursor },
    );
    const conn = next.data?.product?.variants;
    if (!conn) throw new Error(`dashboard variants unavailable for ${product.id}`);
    for (const edge of conn.edges || []) variants.push(edge.node);
    info = conn.pageInfo;
  }
  return variants;
}

export async function drainCustomerSpendOrders(shopifyFetch, customerId, query) {
  const orders = [];
  let after = null;
  for (let page = 0; page < DASHBOARD_ORDER_PAGE_LIMIT; page++) {
    const result = await shopifyFetch(
      `query($id:ID!,$q:String!,$after:String){customer(id:$id){amountSpent{amount currencyCode} numberOfOrders orders(first:${DASHBOARD_ORDER_PAGE},query:$q,after:$after,sortKey:PROCESSED_AT,reverse:true){edges{node{id name processedAt displayFinancialStatus displayFulfillmentStatus totalPriceSet{presentmentMoney{amount currencyCode}} currentTotalPriceSet{presentmentMoney{amount currencyCode}}}}pageInfo{hasNextPage endCursor}}}}`,
      { id: customerId, q: query, after },
    );
    const customer = result.data?.customer;
    if (!customer) return null;
    for (const edge of customer.orders?.edges || []) orders.push(edge.node);
    if (!customer.orders?.pageInfo?.hasNextPage) {
      return { customer, orders };
    }
    if (!customer.orders.pageInfo.endCursor) throw new Error('customer spend orders hasNextPage without cursor');
    after = customer.orders.pageInfo.endCursor;
  }
  throw new Error(`customer spend orders did not paginate to completion after ${DASHBOARD_ORDER_PAGE_LIMIT} pages`);
}
