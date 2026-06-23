#!/usr/bin/env node
// Per-customer orders backfill — iterates every b2b customer in cache, paginates their orders.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const db = (await import(path.join('/home/alexa/projects/fww-b2b-admin', 'db.mjs')));
const {
  upsertOrderCache,
  upsertOrderLineItemsCache,
  listCustomersFromCache,
} = db;

const BEARER = process.env.SHOPIFY_BRIDGE_BEARER;
const BRIDGE = 'https://shopify-bridge.alex-037.workers.dev/api/graphql';

// WHAT: per-customer order backfill — paginates a single customer's orders (50/page, up to 50 line items each) and upserts orders + line items into the local cache.
// CHANGE-GUARD: uses shopMoney amounts (matching the live poller, NOT the bulk backfill's presentmentMoney) — keep consistent with whichever writer is authoritative; lineItems(first:50) silently truncates orders with >50 lines.
// INVARIANT(S): iterates only customers where listCustomersFromCache segment:'b2b'; total is per-customer; on a GraphQL error it returns the partial count and moves on (best-effort, not transactional).
async function fetchOrdersForCustomer(customerGid) {
  let cursor = null;
  let total = 0;
  while (true) {
    const query = `query($cid:ID!,$first:Int!,$after:String){
      customer(id:$cid){
        orders(first:$first,after:$after,sortKey:CREATED_AT,reverse:true){
          edges{cursor node{
            id name createdAt updatedAt processedAt cancelledAt closedAt
            displayFinancialStatus displayFulfillmentStatus
            totalPriceSet{shopMoney{amount}}
            subtotalPriceSet{shopMoney{amount}}
            totalTaxSet{shopMoney{amount}}
            totalShippingPriceSet{shopMoney{amount}}
            totalDiscountsSet{shopMoney{amount}}
            currencyCode
            tags sourceName note
            customer{id email phone}
            shippingAddress{firstName lastName company address1 address2 city province zip country phone}
            billingAddress{firstName lastName company address1 address2 city province zip country phone}
            lineItems(first:50){edges{node{
              id sku title variantTitle quantity
              vendor
              originalUnitPriceSet{shopMoney{amount}}
              totalDiscountSet{shopMoney{amount}}
              variant{id product{id}}
              taxable
            }}}
          }}
          pageInfo{hasNextPage endCursor}
        }
      }
    }`;
    const res = await fetch(BRIDGE, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${BEARER}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { cid: customerGid, first: 50, after: cursor } })
    });
    const json = await res.json();
    if (json.errors?.length) {
      console.error('  error:', json.errors[0].message);
      return total;
    }
    const orders = json.data?.customer?.orders;
    if (!orders) return total;
    for (const edge of orders.edges) {
      const o = edge.node;
      const shopifyId = o.id.split('/').pop();
      const customerSId = o.customer?.id ? o.customer.id.split('/').pop() : null;
      const created = new Date(o.createdAt).getTime();
      const updated = o.updatedAt ? new Date(o.updatedAt).getTime() : null;
      upsertOrderCache({
        shopify_id: shopifyId,
        gid: o.id,
        name: o.name,
        customer_shopify_id: customerSId,
        created_at: created,
        updated_at: updated,
        processed_at: o.processedAt ? new Date(o.processedAt).getTime() : null,
        cancelled_at: o.cancelledAt ? new Date(o.cancelledAt).getTime() : null,
        closed_at: o.closedAt ? new Date(o.closedAt).getTime() : null,
        financial_status: o.displayFinancialStatus || null,
        fulfillment_status: o.displayFulfillmentStatus || null,
        display_financial_status: o.displayFinancialStatus || null,
        display_fulfillment_status: o.displayFulfillmentStatus || null,
        total_price: parseFloat(o.totalPriceSet?.shopMoney?.amount || 0),
        subtotal_price: parseFloat(o.subtotalPriceSet?.shopMoney?.amount || 0),
        total_tax: parseFloat(o.totalTaxSet?.shopMoney?.amount || 0),
        total_shipping: parseFloat(o.totalShippingPriceSet?.shopMoney?.amount || 0),
        total_discounts: parseFloat(o.totalDiscountsSet?.shopMoney?.amount || 0),
        total_refunded: 0,
        currency: o.currencyCode || 'USD',
        tags: (o.tags || []).join(','),
        source_name: o.sourceName || null,
        channel_name: null,
        note: o.note || null,
        shipping_address_json: o.shippingAddress ? JSON.stringify(o.shippingAddress) : null,
        billing_address_json: o.billingAddress ? JSON.stringify(o.billingAddress) : null,
        customer_email: o.customer?.email || null,
        customer_phone: o.customer?.phone || null,
        fulfillments_json: null,
        refunds_json: null,
        metafields_json: null,
        synced_at: Date.now()
      });
      // Line items
      const items = (o.lineItems?.edges || []).map(li => {
        const n = li.node;
        return {
          order_shopify_id: shopifyId,
          line_id: n.id,
          variant_shopify_id: n.variant?.id ? n.variant.id.split('/').pop() : null,
          product_shopify_id: n.variant?.product?.id ? n.variant.product.id.split('/').pop() : null,
          sku: n.sku || null,
          title: n.title || null,
          variant_title: n.variantTitle || null,
          quantity: n.quantity || 0,
          price: parseFloat(n.originalUnitPriceSet?.shopMoney?.amount || 0),
          total_discount: parseFloat(n.totalDiscountSet?.shopMoney?.amount || 0),
          taxable: n.taxable ? 1 : 0,
          vendor: n.vendor || null,
          is_fww_vendor: (n.vendor === 'Fuzzywumpets') ? 1 : 0,
          synced_at: Date.now()
        };
      });
      if (items.length) upsertOrderLineItemsCache(shopifyId, items);
      total++;
    }
    if (!orders.pageInfo.hasNextPage) break;
    cursor = orders.pageInfo.endCursor;
  }
  return total;
}

const customers = listCustomersFromCache({ segment: 'b2b' });
console.log(`Backfilling orders for ${customers.length} B2B customers...`);
let grand = 0;
for (const c of customers) {
  const n = await fetchOrdersForCustomer(c.id);
  console.log(`  ${c.displayName.padEnd(30)} ${n} orders`);
  grand += n;
}
console.log(`\nTotal upserted: ${grand} orders`);
