#!/usr/bin/env node
// WHAT: seeds — and on every re-run RESETS — the Shopify DEV store behind the isolated test copy of
// b2badmin (B2B_ADMIN_TEST_ENV=1), so Gauntlet has known data to click and save against:
//   - a catalog-less "B2B" publication, reused via B2B_ADMIN_B2B_PUBLICATION_ID (written by --env-file)
//   - b2b-tagged customers: company "Champ Dog", one with no company, b2b metafields filled / blank
//   - products whose variants carry 12/13-digit barcodes (plus one variant with none, for "skipped")
//   - a few b2b-portal orders (paid ones for cancel with/without refund, a pending one, an edit target)
//
// Usage (env as the test admin has it — the VPS env file works with `set -a; . file`):
//   B2B_ADMIN_SHOPIFY_BRIDGE_URL=<test bridge> SHOPIFY_BRIDGE_BEARER=<test bearer> \
//     node scripts/seed-test-store.mjs [--env-file ~/fww-b2b-admin-test.env] [--cache-db <test data dir>/admin.db]
//
// CHANGE-GUARD: this script WRITES AND DELETES. It refuses unless the bridge URL is exactly
// TEST_BRIDGE_URL AND the shop answering is TEST_SHOP_DOMAIN — two independent checks, both before the
// first write. Never relax either into a pattern match.
// INVARIANT(S):
//  - customers and products are upserted in place (keyed by email / handle), so their ids — which the
//    Gauntlet manifest's routes use — survive a reset. Only fww-seed orders are deleted and recreated.
//  - every object the script owns carries the SEED_TAG tag; nothing untagged is ever deleted.
//  - --cache-db only accepts a path containing "test" and only clears cache tables + sync cursors, so
//    the restarted app re-reads the reset store instead of showing deleted orders.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const TEST_BRIDGE_URL = 'https://shopify-bridge-b2badmin-test.alex-037.workers.dev/api/graphql';
export const TEST_SHOP_DOMAIN = 'fww-b2b-admin-test.myshopify.com';
export const SEED_TAG = 'fww-seed';
export const PUBLICATION_ENV_KEY = 'B2B_ADMIN_B2B_PUBLICATION_ID';

export function assertSeedTarget(bridgeUrl) {
  if (bridgeUrl !== TEST_BRIDGE_URL) {
    throw new Error(`refusing to seed: B2B_ADMIN_SHOPIFY_BRIDGE_URL must be exactly ${TEST_BRIDGE_URL} (got ${bridgeUrl || '<unset>'})`);
  }
}

// Seed data. Customer emails / product handles are the upsert keys — do not rename casually.
// DEPENDS: gauntlet manifest workflows (docs/gauntlet/) find "Champ Dog" by search and the
// filled/blank B2B settings customers by name.
export const SEED_CUSTOMERS = [
  { email: 'champdog@seed.test', firstName: 'Casey', lastName: 'Champ', company: 'Champ Dog',
    b2b: { discount_pct: 55, dropship_enabled: true, dropship_margin_pct: 25, allow_order_on_invoice: true } },
  { email: 'nocompany@seed.test', firstName: 'Nora', lastName: 'Nocompany', company: null, b2b: {} },
  { email: 'filled@seed.test', firstName: 'Fiona', lastName: 'Filled', company: 'Filled Pet Supply',
    b2b: { discount_pct: 40, dropship_enabled: false, dropship_margin_pct: 35, allow_order_on_invoice: false, catalog_access_tags: 'wholesale' } },
  { email: 'blank@seed.test', firstName: 'Blake', lastName: 'Blank', company: 'Blank Kennels', b2b: {} },
];

const B2B_TYPES = { discount_pct: 'number_integer', dropship_margin_pct: 'number_integer',
  dropship_enabled: 'boolean', allow_order_on_invoice: 'boolean', catalog_access_tags: 'single_line_text_field' };

export const SEED_PRODUCTS = [
  { handle: 'seed-plush-bear', title: 'Seed Plush Bear', options: ['Size'], variants: [
    { opt: ['Small'], sku: 'SEED-BEAR-S', price: '18.00', barcode: '012345678905', qty: 40 },
    { opt: ['Large'], sku: 'SEED-BEAR-L', price: '28.00', barcode: '4006381333931', qty: 2 } ] },
  { handle: 'seed-chew-rope', title: 'Seed Chew Rope', options: ['Colour'], variants: [
    { opt: ['Red'], sku: 'SEED-ROPE-R', price: '9.50', barcode: '036000291452', qty: 25 },
    { opt: ['Blue'], sku: 'SEED-ROPE-B', price: '9.50', barcode: '5901234123457', qty: 25 },
    { opt: ['Green'], sku: 'SEED-ROPE-G', price: '9.50', barcode: '', qty: 10 } ] },
];

// [order name, customer email, [[sku, qty]...], paid?]. Order ids change on every reset; the NAMES do not,
// so Gauntlet workflows reach an order by its exact link text.
// DEPENDS: docs/gauntlet/b2badmin-test.app-scope.json clicks text="<name>" for these four.
export const SEED_ORDERS = [
  ['#S-REFUND', 'champdog@seed.test', [['SEED-BEAR-S', 6], ['SEED-ROPE-R', 12]], true],   // cancel, refund ON
  ['#S-NOREFUND', 'champdog@seed.test', [['SEED-BEAR-L', 2]], true],                      // cancel, refund OFF
  ['#S-PENDING', 'filled@seed.test', [['SEED-ROPE-B', 10], ['SEED-BEAR-S', 3]], false],   // pending (invoice)
  ['#S-EDIT', 'blank@seed.test', [['SEED-ROPE-R', 4], ['SEED-ROPE-B', 4]], true],         // order edit / note
];

export function upsertEnvLine(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) return text.replace(re, line);
  return (text && !text.endsWith('\n') ? text + '\n' : text) + line + '\n';
}

function makeGql(url, bearer) {
  return async function gql(query, variables = {}) {
    const res = await fetch(url, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ query, variables }) });
    if (!res.ok) throw new Error(`bridge ${res.status}: ${await res.text()}`);
    const json = await res.json();
    if (json.errors?.length) throw new Error(json.errors.map(e => e.message).join('; '));
    return json.data;
  };
}

function check(payload, what) {
  const errs = payload?.userErrors || [];
  if (errs.length) throw new Error(`${what}: ${errs.map(e => `${(e.field || []).join('.')} ${e.message}`).join('; ')}`);
  return payload;
}

async function ensurePublication(gql, knownId) {
  // Shopify gives a catalog-less publication no name AND leaves it out of `publications`, so it cannot
  // be found by listing. The id is kept in the test env file (PUBLICATION_ENV_KEY) and reused when it
  // still resolves; otherwise a new one is created and --env-file records it.
  if (knownId && !/199709720811$/.test(knownId)) {  // never the production default from server.mjs
    const d = await gql(`query($id:ID!){ publication(id:$id){ id } }`, { id: knownId });
    if (d.publication) return d.publication.id;
  }
  const c = await gql(`mutation{ publicationCreate(input:{defaultState:EMPTY,autoPublish:false}){ publication{ id } userErrors{field message} } }`);
  return check(c.publicationCreate, 'publicationCreate').publication.id;
}

async function deleteSeedOrders(gql) {
  let n = 0;
  for (;;) {
    const d = await gql(`query($q:String!){ orders(first:50,query:$q){ nodes{ id } } }`, { q: `tag:${SEED_TAG}` });
    if (!d.orders.nodes.length) return n;
    for (const o of d.orders.nodes) {
      check((await gql(`mutation($id:ID!){ orderDelete(orderId:$id){ deletedId userErrors{field message} } }`, { id: o.id })).orderDelete, 'orderDelete');
      n++;
    }
  }
}

async function upsertCustomer(gql, c) {
  const found = await gql(`query($q:String!){ customers(first:1,query:$q){ nodes{ id addresses{ id } metafields(first:20,namespace:"b2b"){ nodes{ key } } } } }`, { q: `email:${c.email}` });
  let node = found.customers.nodes[0];
  const input = { email: c.email, firstName: c.firstName, lastName: c.lastName, tags: ['b2b', SEED_TAG], note: null };
  if (node) {
    check((await gql(`mutation($input:CustomerInput!){ customerUpdate(input:$input){ customer{ id } userErrors{field message} } }`, { input: { ...input, id: node.id } })).customerUpdate, 'customerUpdate');
    // Reset: drop every b2b metafield, then set the seeded ones below.
    const keys = node.metafields.nodes.map(m => m.key);
    if (keys.length) {
      check((await gql(`mutation($m:[MetafieldIdentifierInput!]!){ metafieldsDelete(metafields:$m){ deletedMetafields{ key } userErrors{field message} } }`,
        { m: keys.map(key => ({ ownerId: node.id, namespace: 'b2b', key })) })).metafieldsDelete, 'metafieldsDelete');
    }
    for (const a of node.addresses) {
      check((await gql(`mutation($c:ID!,$a:ID!){ customerAddressDelete(customerId:$c,addressId:$a){ deletedAddressId userErrors{field message} } }`, { c: node.id, a: a.id })).customerAddressDelete, 'customerAddressDelete');
    }
  } else {
    node = check((await gql(`mutation($input:CustomerInput!){ customerCreate(input:$input){ customer{ id } userErrors{field message} } }`, { input })).customerCreate, 'customerCreate').customer;
  }
  const address = { firstName: c.firstName, lastName: c.lastName, address1: '1 Seed Street', city: 'Portland',
    provinceCode: 'OR', zip: '97201', countryCode: 'US', ...(c.company ? { company: c.company } : {}) };
  check((await gql(`mutation($c:ID!,$a:MailingAddressInput!){ customerAddressCreate(customerId:$c,address:$a,setAsDefault:true){ address{ id } userErrors{field message} } }`, { c: node.id, a: address })).customerAddressCreate, 'customerAddressCreate');
  const sets = Object.entries(c.b2b).map(([key, v]) => ({ ownerId: node.id, namespace: 'b2b', key, type: B2B_TYPES[key], value: String(v) }));
  if (sets.length) {
    check((await gql(`mutation($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ metafields{ key } userErrors{field message} } }`, { m: sets })).metafieldsSet, 'metafieldsSet');
  }
  return node.id;
}

async function upsertProduct(gql, p, locationId, publicationIds) {
  const input = {
    handle: p.handle, title: p.title, vendor: 'FWW Seed', status: 'ACTIVE', tags: [SEED_TAG],
    productOptions: p.options.map((name, i) => ({ name, values: [...new Set(p.variants.map(v => v.opt[i]))].map(name => ({ name })) })),
    variants: p.variants.map(v => ({
      optionValues: v.opt.map((name, i) => ({ optionName: p.options[i], name })),
      sku: v.sku, price: v.price, barcode: v.barcode || null,
      inventoryItem: { tracked: true },
      inventoryQuantities: [{ locationId, name: 'available', quantity: v.qty }],
    })),
  };
  const d = await gql(`mutation($input:ProductSetInput!,$id:ProductSetIdentifiers){ productSet(input:$input,identifier:$id,synchronous:true){ product{ id variants(first:20){ nodes{ id sku price } } } userErrors{field message} } }`,
    { input, id: { handle: p.handle } });
  const product = check(d.productSet, 'productSet').product;
  check((await gql(`mutation($id:ID!,$input:[PublicationInput!]!){ publishablePublish(id:$id,input:$input){ userErrors{field message} } }`,
    { id: product.id, input: publicationIds.map(publicationId => ({ publicationId })) })).publishablePublish, 'publishablePublish');
  return product.variants.nodes;
}

async function createOrder(gql, name, customerId, email, lines, variantsBySku, paid) {
  const lineItems = lines.map(([sku, quantity]) => ({ variantId: variantsBySku[sku].id, quantity }));
  const total = lines.reduce((s, [sku, q]) => s + Number(variantsBySku[sku].price) * q, 0).toFixed(2);
  const order = {
    name, customer: { toAssociate: { id: customerId } }, email, lineItems, tags: ['b2b-portal', SEED_TAG],
    currency: 'USD', financialStatus: paid ? 'PAID' : 'PENDING',
    ...(paid ? { transactions: [{ kind: 'SALE', status: 'SUCCESS', gateway: 'manual',
      amountSet: { shopMoney: { amount: total, currencyCode: 'USD' } } }] } : {}),
  };
  // Dev stores throttle orderCreate ("Too many attempts") after a handful per minute — wait it out.
  for (let attempt = 1; ; attempt++) {
    const d = await gql(`mutation($order:OrderCreateOrderInput!,$options:OrderCreateOptionsInput){ orderCreate(order:$order,options:$options){ order{ id name } userErrors{field message} } }`,
      { order, options: { sendReceipt: false, sendFulfillmentReceipt: false, inventoryBehaviour: 'BYPASS' } });
    const throttled = d.orderCreate.userErrors.some(e => /too many attempts/i.test(e.message));
    if (!throttled || attempt >= 8) return check(d.orderCreate, 'orderCreate').order;
    await new Promise(r => setTimeout(r, 20_000 * attempt));
  }
}

// Empties the TEST app's Shopify caches so the restarted service re-reads the reset store.
export async function clearTestCache(dbPath) {
  if (!/test/i.test(dbPath)) throw new Error(`refusing --cache-db ${dbPath}: path must be the TEST data dir`);
  if (!existsSync(dbPath)) throw new Error(`--cache-db ${dbPath} does not exist`);
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath);
  for (const t of ['order_line_items_cache', 'orders_cache', 'customers_cache', 'products_cache']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare(`DELETE FROM sync_state WHERE resource IN ('orders_recent','customers_recent')`).run();
  db.close();
}

export async function seed({ bridgeUrl, bearer, publicationId: publicationId0, log = console.log }) {
  assertSeedTarget(bridgeUrl);
  if (!bearer) throw new Error('SHOPIFY_BRIDGE_BEARER is not set');
  const gql = makeGql(bridgeUrl, bearer);
  const shop = await gql(`query{ shop{ myshopifyDomain } locations(first:1){ nodes{ id } } publications(first:50){ nodes{ id name } } }`);
  if (shop.shop.myshopifyDomain !== TEST_SHOP_DOMAIN) {
    throw new Error(`refusing to seed: bridge answered for ${shop.shop.myshopifyDomain}, expected ${TEST_SHOP_DOMAIN}`);
  }
  const locationId = shop.locations.nodes[0].id;
  const onlineStore = shop.publications.nodes.find(p => p.name === 'Online Store')?.id;

  const publicationId = await ensurePublication(gql, publicationId0);
  log(`publication ${publicationId}`);
  log(`deleted ${await deleteSeedOrders(gql)} seed orders`);

  const customers = {};
  for (const c of SEED_CUSTOMERS) {
    customers[c.email] = await upsertCustomer(gql, c);
    log(`customer ${c.email} ${customers[c.email]}`);
  }
  const variantsBySku = {};
  for (const p of SEED_PRODUCTS) {
    for (const v of await upsertProduct(gql, p, locationId, [publicationId, onlineStore].filter(Boolean))) variantsBySku[v.sku] = v;
    log(`product ${p.handle}`);
  }
  const orders = [];
  for (const [name, email, lines, paid] of SEED_ORDERS) {
    const o = await createOrder(gql, name, customers[email], email, lines, variantsBySku, paid);
    orders.push(o);
    log(`order ${o.name} ${o.id} (${paid ? 'paid' : 'pending'})`);
  }
  return { publicationId, customers, orders };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const result = await seed({ bridgeUrl: process.env.B2B_ADMIN_SHOPIFY_BRIDGE_URL, bearer: process.env.SHOPIFY_BRIDGE_BEARER,
    publicationId: process.env[PUBLICATION_ENV_KEY] });
  const envFile = opt('--env-file');
  if (envFile) {
    writeFileSync(envFile, upsertEnvLine(readFileSync(envFile, 'utf8'), PUBLICATION_ENV_KEY, result.publicationId));
    console.log(`wrote ${PUBLICATION_ENV_KEY} to ${envFile}`);
  }
  const cacheDb = opt('--cache-db');
  if (cacheDb) { await clearTestCache(cacheDb); console.log(`cleared caches in ${cacheDb}`); }
  console.log('done — restart fww-b2b-admin-test so it picks up the publication id and re-syncs');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
