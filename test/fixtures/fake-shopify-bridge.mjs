// Test helper (not a suite): preloaded into a REAL (non-MOCK) server by test/backorder-roundtrips.test.mjs
// (`node --import <this file> server.mjs`).
//
// WHAT: replaces globalThis.fetch with a stateful fake of the shopify-bridge worker, so the REAL order-edit
//   path in server.mjs (runOrderEdit -> orderEditBegin -> stage -> orderEditCommit -> read-back) runs end to
//   end with no network. Every GraphQL document the server sends is (1) appended to a JSONL call log so a test
//   can count and order the round trips, and (2) VALIDATED against the Admin schema snapshot, which is the only
//   place an interpolated selection (BACKORDER_LINE_FIELDS inside the commit mutation) is ever type-checked.
// WHY: B2B_ADMIN_MOCK=1 never calls Shopify, so the number of sequential round trips behind "Mark backordered"
//   (the 2026-10-26 "seems slow" report) cannot be seen, let alone pinned, through the mock HTTP suite.
// CHANGE-GUARD: this models only what order-edit needs (one order, a few line-level mutations). It is NOT a
//   Shopify emulator - do not teach it more than a test needs. Every other URL is answered 503 and logged as
//   `blocked`, so a test can prove the server reached for nothing else.
// INVARIANT(S): never forwards a request anywhere (there is no real fetch in this module). Refuses to run
//   without a throwaway B2B_ADMIN_DATA_DIR and a log path, and refuses under B2B_ADMIN_MOCK=1 (mock never
//   calls Shopify, so loading this there would test nothing).
// DEPENDS: server.mjs document shapes - the dispatch below matches on the mutation/query NAMES the order-edit
//   path sends (orderEditBegin, orderEditSetQuantity, orderEditAddVariant, orderEditAddLineItemDiscount,
//   orderEditAddCustomItem, orderEditCommit, the order/CalculatedOrder lineItems pages, and the
//   currentSubtotalPriceSet line-state read). A new Shopify call in that path lands in the `other` bucket and
//   the round-trip test fails loudly rather than silently passing.
// SYNC: the field names in lineNode()/calcNode() mirror BACKORDER_LINE_FIELDS (lib/backorder-edit.mjs),
//   LINE_STATE_FIELDS and CALC_LINE_FIELDS (server.mjs). The fake returns a SUPERSET, so adding a field to
//   those selections needs no change here unless the new field must carry a value.
//
// Control file (FAKE_BRIDGE_CONTROL, JSON, re-read on every call so a test can change behaviour between
// requests): { commitStale, commitNoLines, commitHasNextPage, commitDrops, commitThrows, commitUserError,
// failSetQty, readLag }.
import fs from 'node:fs';
import { buildClientSchema, parse, validate } from 'graphql';

if (process.env.B2B_ADMIN_MOCK === '1') throw new Error('fake-shopify-bridge: loaded under B2B_ADMIN_MOCK=1 - it is for the real server only');
if (!process.env.FAKE_BRIDGE_LOG || !process.env.B2B_ADMIN_DATA_DIR) {
  throw new Error('fake-shopify-bridge: refusing to run without FAKE_BRIDGE_LOG and a throwaway B2B_ADMIN_DATA_DIR');
}

const BRIDGE_URL = 'https://shopify-bridge.alex-037.workers.dev/api/graphql';
const LOG = process.env.FAKE_BRIDGE_LOG;
const CONTROL = process.env.FAKE_BRIDGE_CONTROL || '';
const STATE_FILE = `${LOG}.state.json`;
const ORDER_NUM = process.env.FAKE_BRIDGE_ORDER || '39875';
const LINE_COUNT = Number(process.env.FAKE_BRIDGE_LINES || 118);
const LIST_PRICE = 36, WHOLESALE_PRICE = 18;

const schema = buildClientSchema(JSON.parse(fs.readFileSync(new URL('./shopify-admin-schema.json', import.meta.url), 'utf8')).data);

const mb = (n) => ({ presentmentMoney: { amount: Number(n).toFixed(2), currencyCode: 'USD' } });
const clone = (x) => JSON.parse(JSON.stringify(x));

// ── the one order ────────────────────────────────────────────────────────────────────────────────────
// quantity = the frozen original; cq = currentQuantity (the post-edit truth; 0 = removed). unit is the net
// per-unit price, list the retail one; unit < list is a wholesale line discount (an EXPLICIT allocation).
let nextNum = 900_000;
let order = { lines: [] };
for (let i = 0; i < LINE_COUNT; i++) {
  order.lines.push({ num: 5000 + i, title: `Wholesale item ${i}`, variantTitle: 'Small / Navy', sku: `SKU-${String(i).padStart(4, '0')}`,
    variantId: `gid://shopify/ProductVariant/${9000 + i}`, quantity: 10, cq: 10, unit: WHOLESALE_PRICE, list: LIST_PRICE });
}
let before = clone(order);          // the state before the last commit - what a lagging read replica would serve
let readLagLeft = 0;
const calcs = new Map();            // calculated order id -> { lines }

const orderGid = `gid://shopify/Order/${ORDER_NUM}`;
function lineNode(l) {
  return {
    id: `gid://shopify/LineItem/${l.num}`, title: l.title, variantTitle: l.variantTitle, sku: l.sku,
    quantity: l.quantity, currentQuantity: l.cq, unfulfilledQuantity: l.cq,
    variant: l.variantId ? { id: l.variantId, title: l.variantTitle, sku: l.sku } : null,
    originalUnitPriceSet: mb(l.list), discountedUnitPriceSet: mb(l.unit),
    // discountedTotalSet is for the ORIGINAL quantity (pdf.mjs lineItemTrueTotal scales it by cq/quantity).
    discountedTotalSet: mb(l.unit * l.quantity),
    discountAllocations: l.list > l.unit
      ? [{ allocatedAmountSet: mb((l.list - l.unit) * l.quantity), discountApplication: { targetSelection: 'EXPLICIT', description: 'B2B wholesale' } }]
      : [],
  };
}
function calcNode(c) {
  return {
    id: c.id, title: c.title, quantity: c.quantity, variant: c.variantId ? { id: c.variantId } : null,
    discountedUnitPriceSet: mb(c.unit), originalUnitPriceSet: mb(c.list),
    calculatedDiscountAllocations: c.list > c.unit
      ? [{ allocatedAmountSet: mb((c.list - c.unit) * c.quantity), discountApplication: { id: `gid://shopify/DiscountApplication/${c.num}`, targetType: 'LINE_ITEM', targetSelection: 'EXPLICIT', description: 'B2B wholesale' } }]
      : [],
  };
}
// A real page: honours `first:` and the cursor, so paging bugs (a prefix returned as if complete) are visible.
function connection(nodes, query, after) {
  const m = /lineItems\(first:(\d+)/.exec(query);
  const first = m ? Number(m[1]) : nodes.length;
  const start = after ? Number(after) : 0;
  const slice = nodes.slice(start, start + first);
  const end = start + slice.length;
  return { pageInfo: { hasNextPage: end < nodes.length, endCursor: end < nodes.length ? String(end) : null }, edges: slice.map(node => ({ node })) };
}
const control = () => { try { return CONTROL ? JSON.parse(fs.readFileSync(CONTROL, 'utf8')) : {}; } catch { return {}; } };
function writeState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(Object.fromEntries(order.lines.map(l => [l.num, { cq: l.cq, unit: l.unit, title: l.title }])))); } catch { /* best effort */ }
}
writeState();

// Which snapshot a plain read sees: normally the truth; with control.readLag = N the next N reads see the
// pre-commit state (a lagging replica).
function visibleLines() {
  if (readLagLeft > 0) { readLagLeft--; return before.lines; }
  return order.lines;
}
const sum = (lines) => lines.reduce((s, l) => s + l.unit * l.cq, 0);

// ── dispatch ─────────────────────────────────────────────────────────────────────────────────────────
function classify(query) {
  if (/orderEditBegin/.test(query)) return 'begin';
  if (/orderEditSetQuantity/.test(query)) return 'setQty';
  if (/orderEditAddVariant/.test(query)) return 'addVariant';
  if (/orderEditAddLineItemDiscount/.test(query)) return 'addDiscount';
  if (/orderEditAddCustomItem/.test(query)) return 'addCustom';
  if (/orderEditCommit/.test(query)) return 'commit';
  if (/on CalculatedOrder/.test(query)) return 'calcLines';
  if (/currentSubtotalPriceSet/.test(query) && /order\(id:\$id\)/.test(query)) return 'lineState';
  if (/order\(id:\$id\)\{\s*lineItems\(first:/.test(query)) return 'orderLines';
  return 'other';
}
const ok = (data) => ({ data });
function userError(field, message) { return { field, message }; }

function handle(op, query, vars, ctl) {
  switch (op) {
    case 'orderLines':
      return ok({ order: { id: orderGid, lineItems: connection(visibleLines().map(lineNode), query, vars.after) } });
    case 'lineState': {
      const lines = visibleLines();
      return ok({ order: {
        subtotalPriceSet: mb(sum(lines)), totalPriceSet: mb(sum(lines)),
        currentSubtotalPriceSet: mb(sum(lines)), currentTotalPriceSet: mb(sum(lines)), currentShippingPriceSet: mb(0),
        lineItems: connection(lines.map(lineNode), query, vars.after),
      } });
    }
    case 'begin': {
      const id = `gid://shopify/CalculatedOrder/${++nextNum}`;
      const lines = order.lines.map(l => ({ id: `gid://shopify/CalculatedLineItem/${l.num}`, num: l.num, title: l.title, quantity: l.cq,
        variantId: l.variantId, unit: l.unit, list: l.list, sku: l.sku, variantTitle: l.variantTitle, added: false }));
      calcs.set(id, { lines });
      return ok({ orderEditBegin: { calculatedOrder: { id, lineItems: connection(lines.map(calcNode), query, null) }, orderEditSession: { id: `${id}/session` }, userErrors: [] } });
    }
    case 'calcLines': {
      const calc = calcs.get(vars.id);
      return ok({ node: calc ? { lineItems: connection(calc.lines.map(calcNode), query, vars.after) } : null });
    }
    case 'setQty': {
      const calc = calcs.get(vars.id);
      const line = calc?.lines.find(l => l.id === vars.li);
      if (!line) return ok({ orderEditSetQuantity: { calculatedOrder: null, userErrors: [userError(['lineItemId'], 'Line item not found in this edit')] } });
      if (ctl.failSetQty) return ok({ orderEditSetQuantity: { calculatedOrder: null, userErrors: [userError(['quantity'], String(ctl.failSetQty))] } });
      line.quantity = vars.qty;
      return ok({ orderEditSetQuantity: { calculatedOrder: { id: vars.id }, userErrors: [] } });
    }
    case 'addVariant': {
      const calc = calcs.get(vars.id);
      const num = ++nextNum;
      const line = { id: `gid://shopify/CalculatedLineItem/${num}`, num, title: `Re-added ${vars.v.split('/').pop()}`, quantity: vars.q,
        variantId: vars.v, unit: LIST_PRICE, list: LIST_PRICE, sku: `SKU-NEW-${num}`, variantTitle: 'Small / Navy', added: true };
      calc.lines.push(line);
      return ok({ orderEditAddVariant: { calculatedLineItem: { id: line.id, originalUnitPriceSet: mb(LIST_PRICE), calculatedDiscountAllocations: [] }, calculatedOrder: { id: vars.id }, userErrors: [] } });
    }
    case 'addDiscount': {
      const line = calcs.get(vars.id)?.lines.find(l => l.id === vars.li);
      if (!line) return ok({ orderEditAddLineItemDiscount: { calculatedOrder: null, userErrors: [userError(['lineItemId'], 'Line item not found in this edit')] } });
      line.unit = Math.round(line.list * (1 - Number(vars.d.percentValue) / 100) * 100) / 100;
      return ok({ orderEditAddLineItemDiscount: { calculatedOrder: { id: vars.id }, userErrors: [] } });
    }
    case 'addCustom': {
      const calc = calcs.get(vars.id);
      const num = ++nextNum;
      const price = Number(vars.price.amount);
      calc.lines.push({ id: `gid://shopify/CalculatedLineItem/${num}`, num, title: vars.title, quantity: vars.qty, variantId: null, unit: price, list: price, sku: '', variantTitle: '', added: true });
      return ok({ orderEditAddCustomItem: { calculatedOrder: { id: vars.id }, userErrors: [] } });
    }
    case 'commit': {
      const calc = calcs.get(vars.id);
      if (ctl.commitUserError) return ok({ orderEditCommit: { order: null, userErrors: [userError(['id'], String(ctl.commitUserError))] } });
      const changed = calc && calc.lines.some(c => c.added || order.lines.find(l => l.num === c.num)?.cq !== c.quantity);
      if (!changed) return ok({ orderEditCommit: { order: null, userErrors: [userError([], 'There must be at least one change to be made.')] } });
      const prior = clone(order);
      if (!ctl.commitDrops) {            // commitDrops: a clean "success" that changes nothing (the mis-mapped-line shape)
        for (const c of calc.lines) {
          const existing = order.lines.find(l => l.num === c.num);
          if (existing) existing.cq = c.quantity;
          else if (c.added && c.quantity > 0) {
            order.lines.push({ num: ++nextNum, title: c.title, variantTitle: c.variantTitle, sku: c.sku, variantId: c.variantId,
              quantity: c.quantity, cq: c.quantity, unit: c.unit, list: c.list });
          }
        }
        before = prior; readLagLeft = Number(ctl.readLag || 0);
        writeState();
      }
      const orderOut = { id: orderGid };
      if (/lineItems\(first:/.test(query) && !ctl.commitNoLines) {
        const shown = ctl.commitStale ? prior.lines : order.lines;
        orderOut.lineItems = connection(shown.map(lineNode), query, null);
        if (ctl.commitHasNextPage) orderOut.lineItems.pageInfo = { hasNextPage: true, endCursor: 'more' };
      }
      return ok({ orderEditCommit: { order: orderOut, userErrors: [] } });
    }
    default:
      return ok({});
  }
}

function log(entry) { try { fs.appendFileSync(LOG, JSON.stringify(entry) + '\n'); } catch { /* best effort */ } }
let seq = 0;

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : (input?.url || String(input));
  if (!url.startsWith(BRIDGE_URL)) {
    log({ seq: ++seq, op: 'blocked', url: url.slice(0, 160) });
    return new Response(JSON.stringify({ error: 'blocked by fake-shopify-bridge' }), { status: 503, headers: { 'content-type': 'application/json' } });
  }
  const { query, variables } = JSON.parse(init.body || '{}');
  const op = classify(query);
  const ctl = control();
  let schemaErrors = [];
  try { schemaErrors = validate(schema, parse(query)).map(e => e.message); } catch (e) { schemaErrors = [`parse: ${e.message}`]; }
  const body = handle(op, query, variables || {}, ctl);
  const bytes = JSON.stringify(body).length;
  log({ seq: ++seq, op, bytes, schemaErrors, query: op === 'other' ? query.slice(0, 200) : undefined });
  if (op === 'commit' && ctl.commitThrows) {
    // The edit WAS applied above; the caller just never hears a clean answer (a gateway timeout).
    return new Response('upstream timeout', { status: 504 });
  }
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};
