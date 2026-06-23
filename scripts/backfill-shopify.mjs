#!/usr/bin/env node
/**
 * One-shot historical import from Shopify into local SQLite cache.
 *
 * Usage:
 *   doppler run -- node scripts/backfill-shopify.mjs [flags]
 *
 * Flags:
 *   --resource=customers|orders|products    Import a single resource
 *   --all                                   Import all resources (default)
 *   --b2b-only                              Customers: filter tag:b2b
 *   --full                                  Full re-sync (ignore last cursor)
 *   --since=<ISO>                           Only records updated after ISO date
 *   --all-vendors                           Products: include non-FWW vendors
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Import db helpers from parent directory
const dbPath = path.join(__dirname, '..', 'db.mjs');
const {
  upsertCustomerCache,
  upsertOrderCache,
  upsertOrderLineItemsCache,
  upsertProductCache,
  getSyncState,
  setSyncState,
} = await import(dbPath);

const BEARER = process.env.SHOPIFY_BRIDGE_BEARER || '';
const BRIDGE = 'https://shopify-bridge.alex-037.workers.dev/api/graphql';
const FWW_VENDOR = 'Fuzzywumpets';

if (!BEARER) {
  console.error('ERROR: SHOPIFY_BRIDGE_BEARER not set. Run via: doppler run -- node scripts/backfill-shopify.mjs');
  process.exit(1);
}

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name) { return args.some(a => a === `--${name}`); }
function flagVal(name) {
  const a = args.find(a => a.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : null;
}

const resourceArg = flagVal('resource');
const doAll = flag('all') || !resourceArg;
const doCustomers = doAll || resourceArg === 'customers';
const doOrders = doAll || resourceArg === 'orders';
const doProducts = doAll || resourceArg === 'products';
const b2bOnly = flag('b2b-only');
const fullSync = flag('full');
const sinceDate = flagVal('since');
const allVendors = flag('all-vendors');

// ── Shopify GQL helper ────────────────────────────────────────────────────────
async function gql(query, variables = {}) {
  const res = await fetch(BRIDGE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BEARER}` },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`shopify-bridge ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

// ── Cursor-based paginator ────────────────────────────────────────────────────
// WHAT: generic cursor paginator that walks every page of a Shopify connection and upserts each node, persisting the final cursor to sync_state for resume.
// CHANGE-GUARD: the while(hasNext) loop has NO page cap and no rate-limit backoff — a full --full sync of all orders/products will run until the connection is exhausted and can hit Shopify cost limits; re-test --since/--full resume after changing queryFn.
// INVARIANT(S): without --full it resumes from sync_state.last_cursor; the cursor written at the end is the LAST page's endCursor (null when exhausted) — interrupting mid-run and re-running without --full resumes from the previous run's cursor, not the interruption point.
async function paginate({ resource, queryFn, transformFn, upsertFn, pageSize = 50 }) {
  let cursor = null;
  if (!fullSync) {
    const state = getSyncState(resource);
    cursor = state?.last_cursor || null;
  }

  let totalUpserted = 0;
  let hasNext = true;

  while (hasNext) {
    const data = await queryFn(cursor, pageSize);
    const edges = data?.edges || [];
    const pageInfo = data?.pageInfo || {};

    for (const edge of edges) {
      const transformed = transformFn(edge.node);
      upsertFn(transformed);
      totalUpserted++;
    }

    hasNext = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor || null;

    process.stdout.write(`\r  ${resource}: ${totalUpserted} upserted...`);
  }

  process.stdout.write('\n');
  setSyncState(resource, {
    lastSyncedAt: Date.now(),
    lastCursor: cursor,
    totalSynced: totalUpserted,
  });

  return totalUpserted;
}

// ── Customers ─────────────────────────────────────────────────────────────────
function transformCustomer(node) {
  const tags = node.tags || [];
  const isB2b = tags.includes('b2b') ? 1 : 0;
  const shopifyId = node.id.replace('gid://shopify/Customer/', '');
  const addr = node.defaultAddress || null;
  return {
    shopify_id: shopifyId,
    gid: node.id,
    email: node.email || null,
    first_name: node.firstName || null,
    last_name: node.lastName || null,
    display_name: node.displayName || null,
    company: node.defaultAddress?.company || null,
    tags: tags.join(','),
    is_b2b: isB2b,
    amount_spent_total: parseFloat(node.amountSpent?.amount || 0),
    orders_count: node.numberOfOrders || 0,
    first_order_at: null,
    last_order_at: null,
    default_address_json: addr ? JSON.stringify(addr) : null,
    created_at: node.createdAt ? new Date(node.createdAt).getTime() : null,
    updated_at: node.updatedAt ? new Date(node.updatedAt).getTime() : null,
    synced_at: Date.now(),
  };
}

async function backfillCustomers() {
  console.log(`\nBackfilling customers (b2bOnly=${b2bOnly}, fullSync=${fullSync})...`);

  const queryParts = ['query:$q'];
  const baseQ = b2bOnly ? 'tag:b2b' : '';
  const sinceQ = sinceDate ? `updated_at:>${sinceDate}` : '';
  const q = [baseQ, sinceQ].filter(Boolean).join(' ');

  const total = await paginate({
    resource: 'customers',
    queryFn: async (cursor, first) => {
      const data = await gql(
        `query($q:String!,$first:Int!,$after:String){
          customers(first:$first,after:$after,query:$q,sortKey:UPDATED_AT,reverse:true){
            edges{node{
              id email firstName lastName displayName createdAt updatedAt
              numberOfOrders amountSpent{amount currencyCode}
              tags
              defaultAddress{company address1 address2 city province country zip}
            }}
            pageInfo{hasNextPage endCursor}
          }
        }`,
        { q, first, after: cursor }
      );
      return data.customers;
    },
    transformFn: transformCustomer,
    upsertFn: upsertCustomerCache,
  });

  console.log(`  Done: ${total} customers upserted.`);
}

// ── Orders ────────────────────────────────────────────────────────────────────
// WHAT: maps a Shopify order GraphQL node to the orders_cache row shape, using presentmentMoney amounts.
// CHANGE-GUARD: this path reads presentmentMoney while the live poller (syncRecentFromShopify) reads shopMoney and the per-customer backfill also uses shopMoney — pick one basis or cached totals will disagree depending on which writer touched the row last (see bugs[]).
// INVARIANT(S): shopify_id is the numeric id (gid stripped); customer_shopify_id is the numeric customer id; total_refunded is hardcoded 0 here (refunds not backfilled).
function transformOrder(node) {
  const shopifyId = node.id.replace('gid://shopify/Order/', '');
  const custId = node.customer?.id?.replace('gid://shopify/Customer/', '') || null;
  return {
    shopify_id: shopifyId,
    gid: node.id,
    name: node.name,
    customer_shopify_id: custId,
    created_at: node.createdAt ? new Date(node.createdAt).getTime() : null,
    updated_at: node.updatedAt ? new Date(node.updatedAt).getTime() : null,
    processed_at: node.processedAt ? new Date(node.processedAt).getTime() : null,
    cancelled_at: node.cancelledAt ? new Date(node.cancelledAt).getTime() : null,
    closed_at: node.closedAt ? new Date(node.closedAt).getTime() : null,
    financial_status: node.displayFinancialStatus || null,
    fulfillment_status: node.displayFulfillmentStatus || null,
    display_financial_status: node.displayFinancialStatus || null,
    display_fulfillment_status: node.displayFulfillmentStatus || null,
    total_price: parseFloat(node.totalPriceSet?.presentmentMoney?.amount || 0),
    subtotal_price: parseFloat(node.subtotalPriceSet?.presentmentMoney?.amount || 0),
    total_tax: parseFloat(node.totalTaxSet?.presentmentMoney?.amount || 0),
    total_shipping: parseFloat(node.totalShippingPriceSet?.presentmentMoney?.amount || 0),
    total_discounts: parseFloat(node.totalDiscountsSet?.presentmentMoney?.amount || 0),
    total_refunded: 0,
    currency: node.totalPriceSet?.presentmentMoney?.currencyCode || null,
    tags: (node.tags || []).join(','),
    source_name: node.sourceName || null,
    channel_name: null,
    note: node.note || null,
    shipping_address_json: node.shippingAddress ? JSON.stringify(node.shippingAddress) : null,
    billing_address_json: node.billingAddress ? JSON.stringify(node.billingAddress) : null,
    customer_email: node.customer?.email || node.email || null,
    customer_phone: node.customer?.phone || null,
    fulfillments_json: node.fulfillments ? JSON.stringify(node.fulfillments) : null,
    refunds_json: null,
    metafields_json: null,
    synced_at: Date.now(),
  };
}

function transformLineItems(orderShopifyId, lineItemsEdges) {
  return (lineItemsEdges || []).map(e => {
    const n = e.node;
    const variantId = n.variant?.id?.replace('gid://shopify/ProductVariant/', '') || null;
    const productId = n.product?.id?.replace('gid://shopify/Product/', '') || null;
    const vendor = n.vendor || null;
    return {
      line_id: n.id || null,
      variant_shopify_id: variantId,
      product_shopify_id: productId,
      sku: n.sku || null,
      title: n.title || null,
      variant_title: n.variantTitle || null,
      quantity: n.quantity || 0,
      price: parseFloat(n.originalUnitPriceSet?.presentmentMoney?.amount || 0),
      total_discount: parseFloat(n.totalDiscountSet?.presentmentMoney?.amount || 0),
      taxable: n.taxable ? 1 : 0,
      vendor,
      is_fww_vendor: vendor === FWW_VENDOR ? 1 : 0,
    };
  });
}

async function backfillOrders() {
  console.log(`\nBackfilling orders (fullSync=${fullSync})...`);

  const sinceQ = sinceDate ? `updated_at:>${sinceDate}` : 'tag:b2b';

  const total = await paginate({
    resource: 'orders',
    queryFn: async (cursor, first) => {
      const data = await gql(
        `query($q:String!,$first:Int!,$after:String){
          orders(first:$first,after:$after,query:$q,sortKey:UPDATED_AT,reverse:true){
            edges{node{
              id name createdAt updatedAt processedAt cancelledAt closedAt
              displayFinancialStatus displayFulfillmentStatus
              sourceName note tags
              totalPriceSet{presentmentMoney{amount currencyCode}}
              subtotalPriceSet{presentmentMoney{amount}}
              totalTaxSet{presentmentMoney{amount}}
              totalShippingPriceSet{presentmentMoney{amount}}
              totalDiscountsSet{presentmentMoney{amount}}
              customer{id email phone}
              shippingAddress{address1 address2 city province country zip}
              billingAddress{address1 address2 city province country zip}
              fulfillments{id status trackingInfo{number url}}
              lineItems(first:50){edges{node{
                id title variantTitle sku quantity taxable vendor
                variant{id}
                product{id}
                originalUnitPriceSet{presentmentMoney{amount}}
                totalDiscountSet{presentmentMoney{amount}}
              }}}
            }}
            pageInfo{hasNextPage endCursor}
          }
        }`,
        { q: sinceQ, first, after: cursor }
      );
      return data.orders;
    },
    transformFn: (node) => {
      const order = transformOrder(node);
      const lineItems = transformLineItems(order.shopify_id, node.lineItems?.edges || []);
      return { order, lineItems };
    },
    upsertFn: ({ order, lineItems }) => {
      upsertOrderCache(order);
      if (lineItems.length > 0) {
        upsertOrderLineItemsCache(order.shopify_id, lineItems);
      }
    },
  });

  console.log(`  Done: ${total} orders upserted.`);
}

// ── Products ──────────────────────────────────────────────────────────────────
function transformProduct(node) {
  const shopifyId = node.id.replace('gid://shopify/Product/', '');
  return {
    shopify_id: shopifyId,
    gid: node.id,
    handle: node.handle || null,
    title: node.title || null,
    vendor: node.vendor || null,
    product_type: node.productType || null,
    status: node.status || null,
    tags: (node.tags || []).join(','),
    publications_json: null,
    variants_json: node.variants ? JSON.stringify(node.variants.edges?.map(e => e.node) || []) : null,
    images_json: node.images ? JSON.stringify(node.images.edges?.map(e => e.node) || []) : null,
    created_at: node.createdAt ? new Date(node.createdAt).getTime() : null,
    updated_at: node.updatedAt ? new Date(node.updatedAt).getTime() : null,
    synced_at: Date.now(),
  };
}

async function backfillProducts() {
  console.log(`\nBackfilling products (allVendors=${allVendors}, fullSync=${fullSync})...`);

  const vendorQ = allVendors ? '' : `vendor:"${FWW_VENDOR}"`;
  const sinceQ = sinceDate ? `updated_at:>${sinceDate}` : '';
  const q = [vendorQ, sinceQ].filter(Boolean).join(' ') || 'status:active';

  const total = await paginate({
    resource: 'products',
    queryFn: async (cursor, first) => {
      const data = await gql(
        `query($q:String!,$first:Int!,$after:String){
          products(first:$first,after:$after,query:$q,sortKey:UPDATED_AT,reverse:true){
            edges{node{
              id handle title vendor productType status tags createdAt updatedAt
              variants(first:20){edges{node{id sku title inventoryQuantity price}}}
              images(first:3){edges{node{id url altText}}}
            }}
            pageInfo{hasNextPage endCursor}
          }
        }`,
        { q, first, after: cursor }
      );
      return data.products;
    },
    transformFn: transformProduct,
    upsertFn: upsertProductCache,
  });

  console.log(`  Done: ${total} products upserted.`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log('fww-b2b-admin backfill script');
console.log(`  resources: ${[doCustomers && 'customers', doOrders && 'orders', doProducts && 'products'].filter(Boolean).join(', ')}`);
console.log(`  options: b2bOnly=${b2bOnly} fullSync=${fullSync} sinceDate=${sinceDate || '(none)'} allVendors=${allVendors}`);

const t0 = Date.now();

if (doCustomers) await backfillCustomers();
if (doOrders) await backfillOrders();
if (doProducts) await backfillProducts();

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nBackfill complete in ${elapsed}s.`);
