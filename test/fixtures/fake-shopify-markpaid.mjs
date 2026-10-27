// Test helper (not a suite): preloaded into a REAL (non-MOCK) server by test/orders-bulk-markpaid.test.mjs
// (`node --import <this file> server.mjs`).
//
// WHAT: replaces globalThis.fetch with a tiny stateful fake of the shopify-bridge worker that understands ONE
//   mutation, orderMarkAsPaid, so the REAL POST /orders/bulk route (bulkMarkOrdersPaid -> audit -> orders_cache ->
//   redirect -> GET /orders) runs end to end with no network. Each document the server sends is appended to a
//   JSONL call log and VALIDATED against the Admin schema snapshot (test/fixtures/shopify-admin-schema.json).
// WHY: B2B_ADMIN_MOCK=1 never calls Shopify and the orders list only takes the orders_cache path when NOT mocked,
//   so the 2026-10-27 report ("banner says marked as paid, the order still shows PENDING") cannot be reproduced
//   through the mock HTTP suite at all.
// CHANGE-GUARD: models only orderMarkAsPaid's observable contract: PENDING -> PAID with the new status, the order
//   name and the CURRENT total in the payload; an already PAID / REFUNDED order is refused with a userError; an unknown
//   id is refused. A status of PENDING_STICKY accepts orderMarkAsPaid any number of times and stays PENDING_STICKY (two
//   overlapping clicks that both get past Shopify - the double-submit case). It also answers the one fresh-outstanding
//   query POST /orders/:id/record-payment makes before it marks the balance paid. It
//   deliberately does NOT deliver the orders/updated webhook - the real one lands 2-3 s AFTER the mutation, which
//   is exactly the window the regression test pins. Every other URL is answered 503 and logged as `blocked`.
// INVARIANT(S): never forwards a request anywhere EXCEPT to URLs starting with FAKE_MARKPAID_ALLOW_URL (a test's own
//   127.0.0.1 fake Portal, set by test/payment-notice-routes.test.mjs); everything else is answered 503. Refuses to run
//   without a throwaway B2B_ADMIN_DATA_DIR and a log path, and refuses under B2B_ADMIN_MOCK=1.
// DEPENDS: server.mjs / lib/order-money.mjs send `mutation orderMarkAsPaid($input:OrderMarkAsPaidInput!)`; the
//   dispatch below matches on that name. The test file reads the fake's own order state from `${log}.state.json`.
import fs from 'node:fs';
import { buildClientSchema, parse, validate } from 'graphql';

if (process.env.B2B_ADMIN_MOCK === '1') throw new Error('fake-shopify-markpaid: loaded under B2B_ADMIN_MOCK=1 - it is for the real server only');
if (!process.env.FAKE_MARKPAID_LOG || !process.env.B2B_ADMIN_DATA_DIR) {
  throw new Error('fake-shopify-markpaid: refusing to run without FAKE_MARKPAID_LOG and a throwaway B2B_ADMIN_DATA_DIR');
}

const BRIDGE_URL = 'https://shopify-bridge.alex-037.workers.dev/api/graphql';
const LOG = process.env.FAKE_MARKPAID_LOG;
const STATE_FILE = `${LOG}.state.json`;
const schema = buildClientSchema(JSON.parse(fs.readFileSync(new URL('./shopify-admin-schema.json', import.meta.url), 'utf8')).data);

const realFetch = globalThis.fetch;                                   // only ever used for FAKE_MARKPAID_ALLOW_URL
const ALLOW_URL = process.env.FAKE_MARKPAID_ALLOW_URL || '';
// FAKE_MARKPAID_TOTALS: JSON { "<id>": { name, amount, currency } } - the order name and current total in the payload (default #<id>, 10.00 USD).
const totals = JSON.parse(process.env.FAKE_MARKPAID_TOTALS || '{}');
const totalOf = (num) => ({ name: `#${num}`, amount: '10.00', currency: 'USD', ...(totals[num] || {}) });
// FAKE_MARKPAID_ORDERS: JSON { "<numeric order id>": "<displayFinancialStatus>" } - Shopify's truth for each order.
const orders = new Map(Object.entries(JSON.parse(process.env.FAKE_MARKPAID_ORDERS || '{}')));
const writeState = () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(Object.fromEntries(orders))); } catch { /* best effort */ } };
const log = (entry) => { try { fs.appendFileSync(LOG, JSON.stringify(entry) + '\n'); } catch { /* best effort */ } };
writeState();

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

globalThis.fetch = async (url, init = {}) => {
  if (ALLOW_URL && String(url).startsWith(ALLOW_URL)) return realFetch(url, init);
  if (String(url) !== BRIDGE_URL) { log({ op: 'blocked', url: String(url) }); return new Response('blocked by fake-shopify-markpaid', { status: 503 }); }
  const { query, variables = {} } = JSON.parse(init.body || '{}');
  const problems = validate(schema, parse(query)).map(e => e.message);
  if (problems.length) { log({ op: 'invalid', problems }); return json({ errors: [{ message: `schema: ${problems[0]}` }] }); }
  const gid = variables?.input?.id || variables?.id || '';
  const num = gid.split('/').pop();
  if (!/orderMarkAsPaid/.test(query) && /totalOutstandingSet/.test(query) && /^\s*query/.test(query)) {
    // POST /orders/:id/record-payment: the fresh outstanding balance, read right before the mutation.
    log({ op: 'outstanding', id: num });
    if (!orders.has(num)) return json({ data: { order: null } });
    const t = totalOf(num);
    const open = ['PAID', 'REFUNDED'].includes(orders.get(num)) ? '0.00' : t.amount;
    return json({ data: { order: { name: t.name, displayFinancialStatus: orders.get(num), totalOutstandingSet: { presentmentMoney: { amount: open, currencyCode: t.currency } } } } });
  }
  if (!/orderMarkAsPaid/.test(query)) { log({ op: 'other', query: query.slice(0, 120) }); return json({ errors: [{ message: 'fake-shopify-markpaid: unexpected document' }] }); }

  log({ op: 'orderMarkAsPaid', id: num });
  if (!orders.has(num)) {
    return json({ data: { orderMarkAsPaid: { order: null, userErrors: [{ field: ['id'], message: 'Order does not exist' }] } } });
  }
  if (['PAID', 'REFUNDED'].includes(orders.get(num))) {
    return json({ data: { orderMarkAsPaid: { order: null, userErrors: [{ field: null, message: 'Order cannot be marked as paid.' }] } } });
  }
  const sticky = orders.get(num) === 'PENDING_STICKY';
  if (!sticky) orders.set(num, 'PAID');
  writeState();
  const t = totalOf(num);
  const money = { presentmentMoney: { amount: t.amount, currencyCode: t.currency } };
  return json({ data: { orderMarkAsPaid: { order: { id: gid, name: t.name, displayFinancialStatus: 'PAID', currentTotalPriceSet: money, totalReceivedSet: money }, userErrors: [] } } });
};
