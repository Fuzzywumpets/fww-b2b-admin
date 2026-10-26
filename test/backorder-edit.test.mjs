// Standalone suite for lib/backorder-edit.mjs — the flag/undo orchestration and its Shopify staging.
//
// Why standalone (in addition to the mock-server API tests): the dangerous paths are the ones the mock HTTP
// server cannot produce — Shopify committing and THEN erroring, a read-back that fails, a process dying
// between the Shopify write and our status flip. They are driven here with a fake Shopify "world" and the
// REAL db.mjs SQL (in-memory, B2B_ADMIN_MOCK=1), so what is asserted is the actual state machine.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildClientSchema, parse, validate } from 'graphql';
import * as dbm from '../db.mjs';
import {
  flagBackorder, undoBackorder, parseBackorderRequest, priceAdjustment, pricesMatch, BACKORDER_LINE_FIELDS,
  stageRemoveUnits, stageRaiseUnits, stageAddVariantAtPrice, stageAddCustomAtPrice, DUPLICATE_WINDOW_MS,
} from '../lib/backorder-edit.mjs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${err.stack?.split('\n').slice(0, 3).join('\n      ') || err.message}`); failed++; }
}

// ── a fake Shopify order + the deps the core needs ─────────────────────────────────────────────────
let orderSeq = 8000;
function world(lineSpecs, { orderId } = {}) {
  const w = {
    orderId: orderId || `gid://shopify/Order/${++orderSeq}`,
    lines: lineSpecs.map((l, i) => ({
      liId: `gid://shopify/LineItem/${1000 + i}`, title: 'Elite Collar', variantTitle: 'Small / Navy', sku: 'EC-1',
      variantId: 'gid://shopify/ProductVariant/55', currentQuantity: 10, unitPrice: 18, currency: 'USD', ...l,
    })),
    nextId: 5000, clock: 1_700_000_000_000, errors: [], warns: [], calls: [],
    rejectRemove: null, rejectRestore: null, throwAfterApply: false, readFailsAfter: null, readCount: 0,
    ledger: new Map(),
  };
  w.deps = {
    db: dbm,
    getEditAction: (k) => w.ledger.get(k) || null,
    readLines: async () => {
      w.readCount++;
      if (w.readFailsAfter != null && w.readCount > w.readFailsAfter) throw new Error('shopify read timeout');
      return w.lines.map(l => ({ ...l }));
    },
    removeUnits: async ({ line, quantity, idemKey, payload }) => {
      w.calls.push({ kind: 'remove', liId: line.liId, quantity, idemKey, payload });
      if (w.rejectRemove) throw new Error(w.rejectRemove);
      const l = w.lines.find(x => x.liId === line.liId);
      l.currentQuantity -= quantity;
      if (w.throwAfterApply) throw new Error('orderEditCommit timed out');
      w.ledger.set(idemKey, { status: 'committed', action: 'backorder/flag', payload_json: JSON.stringify(payload) });
    },
    restoreUnits: async ({ mode, row, live, quantity, unitPrice, idemKey }) => {
      w.calls.push({ kind: 'restore', mode, quantity, unitPrice, idemKey });
      if (w.rejectRestore) throw new Error(w.rejectRestore);
      if (mode === 'raise') w.lines.find(x => x.liId === live.liId).currentQuantity += quantity;
      else w.lines.push({ liId: `gid://shopify/LineItem/${++w.nextId}`, title: row.line_item_title, variantTitle: row.variant_title || '', sku: row.sku || '', variantId: row.variant_id, currentQuantity: quantity, unitPrice: w.restoredPrice ?? unitPrice, currency: row.currency });
      if (w.throwAfterApply) throw new Error('orderEditCommit timed out');
      return { warnings: [] };
    },
    now: () => w.clock,
    log: { warn: (m) => w.warns.push(m), error: (m) => w.errors.push(m) },
  };
  return w;
}
const flag = (w, over = {}) => flagBackorder(w.deps, { orderId: w.orderId, lineItemId: w.lines[0].liId, quantity: 4, email: 'a@fww', idemKey: null, ...over });
const undo = (w, over = {}) => undoBackorder(w.deps, { orderId: w.orderId, lineItemId: w.lines[0].liId, email: 'a@fww', ...over });
const row = (w, liId = w.lines[0].liId) => dbm.getBackorderRow(w.orderId, liId);

console.log('\n  request validation');
await test('quantity must be a plain whole number >= 1', () => {
  for (const bad of ['', '0', '-1', 'abc', '2.5', '1e2', ' ', null, undefined, '3 units']) {
    assert.equal(parseBackorderRequest({ lineItemId: 'x', quantity: bad }).ok, false, `accepted ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(parseBackorderRequest({ lineItemId: 'x', quantity: ' 3 ' }), { ok: true, lineItemId: 'x', quantity: 3 });
});
await test('an eta field from a stale client is ignored: not validated, not returned (expected ship date was removed)', () => {
  for (const eta of ['2026-12-01', '', 'soon', '2026-02-30']) {
    assert.deepEqual(parseBackorderRequest({ lineItemId: 'x', quantity: '1', eta }), { ok: true, lineItemId: 'x', quantity: 1 }, eta);
  }
  assert.equal(parseBackorderRequest({ quantity: '1' }).ok, false, 'missing line id');
});

console.log('\n  price maths');
await test('priceAdjustment: exact → none, lower → percent, higher → refuse, free → 100%', () => {
  assert.deepEqual(priceAdjustment(36, 36), { kind: 'none' });
  assert.deepEqual(priceAdjustment(36, 18), { kind: 'discount', pct: 50 });
  assert.deepEqual(priceAdjustment(36, 17.33), { kind: 'discount', pct: 51.8611 });
  assert.deepEqual(priceAdjustment(45.99, 0), { kind: 'discount', pct: 100 });
  assert.deepEqual(priceAdjustment(20, 25), { kind: 'above' });
  assert.equal(pricesMatch(18.0, 18.01), true);
  assert.equal(pricesMatch(18.0, 18.5), false);
});

console.log('\n  Shopify staging');
function fetchFake(respond) {
  const calls = [];
  const fn = async (query, vars) => { calls.push({ query, vars }); const name = /orderEdit\w+/.exec(query)[0]; return respond(name, vars, calls.length); };
  fn.calls = calls; return fn;
}
const okPayload = (extra = {}) => ({ calculatedOrder: { id: 'calc' }, userErrors: [], ...extra });
await test('full removal sets quantity 0 with restock:true; partial lowers to current − N, also restock:true', async () => {
  const f = fetchFake((n) => ({ data: { [n]: okPayload() } }));
  await stageRemoveUnits({ shopifyFetch: f, calcId: 'c', calcLiId: 'l', calcQty: 5, quantity: 5 });
  await stageRemoveUnits({ shopifyFetch: f, calcId: 'c', calcLiId: 'l', calcQty: 10, quantity: 4 });
  assert.deepEqual(f.calls.map(c => [c.vars.qty, c.vars.r]), [[0, true], [6, true]]);
  assert.match(f.calls[0].query, /orderEditSetQuantity/);
});
await test('removal refuses quantity above the session quantity BEFORE any mutation', async () => {
  const f = fetchFake((n) => ({ data: { [n]: okPayload() } }));
  await assert.rejects(stageRemoveUnits({ shopifyFetch: f, calcId: 'c', calcLiId: 'l', calcQty: 3, quantity: 4 }), /Only 3 unit/);
  await assert.rejects(stageRemoveUnits({ shopifyFetch: f, calcId: 'c', calcLiId: 'l', calcQty: undefined, quantity: 1 }), /did not report/);
  assert.equal(f.calls.length, 0);
});
await test('a userError, a missing payload or a top-level error all THROW (the edit session is then abandoned, never committed)', async () => {
  await assert.rejects(stageRemoveUnits({ shopifyFetch: fetchFake((n) => ({ data: { [n]: { userErrors: [{ message: 'Line item has been fulfilled' }] } } })), calcId: 'c', calcLiId: 'l', calcQty: 5, quantity: 2 }), /fulfilled/);
  await assert.rejects(stageRemoveUnits({ shopifyFetch: fetchFake(() => ({})), calcId: 'c', calcLiId: 'l', calcQty: 5, quantity: 2 }), /did not confirm/);
  await assert.rejects(stageRemoveUnits({ shopifyFetch: fetchFake(() => ({ errors: [{ message: 'throttled' }], data: null })), calcId: 'c', calcLiId: 'l', calcQty: 5, quantity: 2 }), /did not confirm/);
});
await test('raise adds N to the session quantity with restock:false', async () => {
  const f = fetchFake((n) => ({ data: { [n]: okPayload() } }));
  await stageRaiseUnits({ shopifyFetch: f, calcId: 'c', calcLiId: 'l', calcQty: 6, quantity: 4 });
  assert.deepEqual([f.calls[0].vars.qty, f.calls[0].vars.r], [10, false]);
});
const addResp = (list, allocs = []) => (n) => ({ data: { [n]: okPayload({ calculatedLineItem: { id: 'new-li', originalUnitPriceSet: { presentmentMoney: { amount: String(list) } }, calculatedDiscountAllocations: allocs } }) } });
await test('re-add at the stored price: list 36 → stored 18 stages a 50% "B2B wholesale" line discount on the NEW line', async () => {
  const f = fetchFake(addResp(36));
  const r = await stageAddVariantAtPrice({ shopifyFetch: f, calcId: 'c', variantGid: 'gid://shopify/ProductVariant/55', quantity: 4, unitPrice: 18 });
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0].vars, { id: 'c', v: 'gid://shopify/ProductVariant/55', q: 4 });
  assert.deepEqual(f.calls[1].vars, { id: 'c', li: 'new-li', d: { percentValue: 50, description: 'B2B wholesale' } });
  assert.deepEqual(r, { listPrice: 36, discountPct: 50 });
});
await test('re-add when stored price already equals list: no discount mutation at all', async () => {
  const f = fetchFake(addResp(18));
  await stageAddVariantAtPrice({ shopifyFetch: f, calcId: 'c', variantGid: 'v', quantity: 1, unitPrice: 18 });
  assert.equal(f.calls.length, 1);
});
await test('FAILS CLOSED: stored price above current list, or an order-level discount in the way — nothing is silently billed at list', async () => {
  const f1 = fetchFake(addResp(10));
  await assert.rejects(stageAddVariantAtPrice({ shopifyFetch: f1, calcId: 'c', variantGid: 'v', quantity: 1, unitPrice: 18 }), /above the variant's current price/);
  assert.equal(f1.calls.length, 1, 'only the add was attempted; the caller abandons the session');
  const f2 = fetchFake(addResp(36, [{ discountApplication: { targetSelection: 'ALL' } }]));
  await assert.rejects(stageAddVariantAtPrice({ shopifyFetch: f2, calcId: 'c', variantGid: 'v', quantity: 1, unitPrice: 18 }), /order-level discount/);
  const f3 = fetchFake((n) => ({ data: { [n]: n === 'orderEditAddVariant' ? okPayload({ calculatedLineItem: { id: 'x', originalUnitPriceSet: { presentmentMoney: { amount: '36' } }, calculatedDiscountAllocations: [] } }) : { userErrors: [{ message: 'discount rejected' }] } } }));
  await assert.rejects(stageAddVariantAtPrice({ shopifyFetch: f3, calcId: 'c', variantGid: 'v', quantity: 1, unitPrice: 18 }), /discount rejected/);
});
await test('a comped (price 0) line is restored with a 100% discount', async () => {
  const f = fetchFake(addResp(45.99));
  await stageAddVariantAtPrice({ shopifyFetch: f, calcId: 'c', variantGid: 'v', quantity: 2, unitPrice: 0 });
  assert.equal(f.calls[1].vars.d.percentValue, 100);
});
await test('a custom (no-variant) line is re-added at the exact stored price and currency', async () => {
  const f = fetchFake((n) => ({ data: { [n]: okPayload() } }));
  await stageAddCustomAtPrice({ shopifyFetch: f, calcId: 'c', title: 'Rush fee', quantity: 1, unitPrice: 9.99, currency: 'CAD' });
  assert.deepEqual(f.calls[0].vars.price, { amount: '9.99', currencyCode: 'CAD' });
});

console.log('\n  flagBackorder');
await test('FULL line: removed from Shopify, row finalized with the complete invoice snapshot', async () => {
  const w = world([{ currentQuantity: 4 }]);
  const r = await flag(w, { quantity: 4 });
  assert.equal(r.ok, true);
  assert.equal(w.lines[0].currentQuantity, 0);
  const [b] = dbm.getBackorderedLinesForOrder(w.orderId);
  assert.deepEqual(
    { ...b, createdAt: undefined },
    { lineItemId: w.lines[0].liId, variantId: 'gid://shopify/ProductVariant/55', sku: 'EC-1', title: 'Elite Collar', variantTitle: 'Small / Navy', quantity: 4, unitPrice: 18, currency: 'USD', lineTotal: 72, createdAt: undefined, createdBy: 'a@fww' });
  assert.equal(row(w).claim_prior_qty, 4);
  assert.equal(row(w).eta_date, null, 'no ETA is ever written to a new row');
});
await test('PARTIAL: Shopify line goes to current − N and only N is recorded', async () => {
  const w = world([{ currentQuantity: 10 }]);
  assert.equal((await flag(w, { quantity: 3 })).ok, true);
  assert.equal(w.lines[0].currentQuantity, 7);
  assert.equal(dbm.getBackorderedLinesForOrder(w.orderId)[0].quantity, 3);
});
await test('quantity 0, negative-equivalent, above the line, or a vanished line are rejected with NO Shopify call and NO row', async () => {
  const w = world([{ currentQuantity: 3 }]);
  const r = await flag(w, { quantity: 4 });
  assert.equal(r.ok, false);
  assert.match(r.message, /between 1 and 3/);
  const gone = await flag(w, { lineItemId: 'gid://shopify/LineItem/404', quantity: 1 });
  assert.equal(gone.ok, false);
  assert.equal(w.calls.length, 0);
  assert.equal(row(w), null);
});
await test('FAIL CLOSED: Shopify rejects → error, line untouched, NO row claims it is backordered', async () => {
  const w = world([{ currentQuantity: 5 }]);
  w.rejectRemove = 'Line item cannot be removed';
  const r = await flag(w, { quantity: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'not_applied');
  assert.match(r.message, /cannot be removed/);
  assert.equal(row(w), null);
  assert.deepEqual(dbm.getBackorderedLinesForOrder(w.orderId), []);
  assert.equal(w.lines[0].currentQuantity, 5);
});
await test('a rejected flag puts back the LEGACY flag-only row it had overwritten', async () => {
  const w = world([{ currentQuantity: 5 }]);
  dbm.upsertBackorder(w.orderId, w.lines[0].liId, 'Elite Collar', 5, '2026-01-01', 'old@fww');
  const before = row(w);
  w.rejectRemove = 'nope';
  assert.equal((await flag(w, { quantity: 2 })).ok, false);
  assert.deepEqual(row(w), before);
});
await test('Shopify COMMITTED then errored (timeout): read-back proves it, row is finalized — the record is never lost', async () => {
  const w = world([{ currentQuantity: 6 }]);
  w.throwAfterApply = true;
  const r = await flag(w, { quantity: 6 });
  assert.equal(r.ok, true);
  assert.equal(row(w).status, 'pending');
  assert.equal(dbm.getBackorderedLinesForOrder(w.orderId)[0].quantity, 6);
  assert.ok(w.errors.some(m => /removal IS in effect/.test(m)), 'logged loudly');
});
await test('error AND the read-back also fails: outcome unknown → row stays applying, loud log, user told to check Shopify', async () => {
  const w = world([{ currentQuantity: 6 }]);
  w.throwAfterApply = true;
  w.readFailsAfter = 1;          // the initial read works, the read-back does not
  const r = await flag(w, { quantity: 6 });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'unconfirmed');
  assert.equal(row(w).status, 'applying');
  assert.ok(w.errors.some(m => /UNCONFIRMED flag/.test(m)));
  assert.deepEqual(dbm.getBackorderedLinesForOrder(w.orderId), [], 'not shown as backordered until confirmed');
});
await test('a "successful" edit whose read-back shows NO change is NOT recorded as backordered', async () => {
  const w = world([{ currentQuantity: 5 }]);
  w.deps.removeUnits = async () => {};                 // claims success, changes nothing
  const r = await flag(w, { quantity: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'not_applied');
  assert.equal(row(w), null);
});
await test('success with no read-back available is trusted (the edit itself was confirmed)', async () => {
  const w = world([{ currentQuantity: 5 }]);
  w.readFailsAfter = 1;
  assert.equal((await flag(w, { quantity: 2 })).ok, true);
  assert.equal(row(w).status, 'pending');
});
await test('DOUBLE SUBMIT (no token): an identical request right after is a no-op success, not a second removal', async () => {
  const w = world([{ currentQuantity: 10 }]);
  assert.equal((await flag(w, { quantity: 4 })).ok, true);
  w.clock += 5_000;
  const again = await flag(w, { quantity: 4 });
  assert.deepEqual([again.ok, again.duplicate], [true, true]);
  assert.equal(w.lines[0].currentQuantity, 6, 'removed once');
  assert.equal(w.calls.filter(c => c.kind === 'remove').length, 1);
});
await test('a DIFFERENT second flag on an already-backordered line is refused (undo first)', async () => {
  const w = world([{ currentQuantity: 10 }]);
  await flag(w, { quantity: 4 });
  const r = await flag(w, { quantity: 2 });
  assert.equal(r.ok, false);
  assert.match(r.message, /already has 4 unit/);
  assert.equal(w.lines[0].currentQuantity, 6);
  w.clock += DUPLICATE_WINDOW_MS + 1;
  const late = await flag(w, { quantity: 4 });
  assert.equal(late.ok, false, 'outside the window the same request is a new (refused) one, not a silent success');
});
await test('DOUBLE SUBMIT (client token): a committed ledger entry for the token answers success without touching Shopify', async () => {
  const w = world([{ currentQuantity: 10 }]);
  assert.equal((await flag(w, { quantity: 4, idemKey: 'tok-abcdef123456' })).ok, true);
  const again = await flag(w, { quantity: 4, idemKey: 'tok-abcdef123456' });
  assert.deepEqual([again.ok, again.duplicate], [true, true]);
  assert.equal(w.calls.length, 1);
  const reuse = await flag(w, { quantity: 2, idemKey: 'tok-abcdef123456' });
  assert.equal(reuse.ok, false, 'same token, different request: refused, not replayed');
});
await test('RECONCILE: an orphaned applying row whose removal DID land is finalized on the next flag', async () => {
  const w = world([{ currentQuantity: 10 }]);
  dbm.claimBackorderRemoval({ orderId: w.orderId, lineItemId: w.lines[0].liId, title: 'Elite Collar', variantId: 'v', sku: 'EC-1', variantTitle: '', unitPrice: '18.00', currency: 'USD', quantity: 4, priorQty: 10, createdBy: 'a@fww', now: w.clock });
  w.lines[0].currentQuantity = 6;                              // process died after Shopify applied it
  const r = await flag(w, { quantity: 4 });   // same qty/user as the orphan
  assert.equal(row(w).status, 'pending');
  assert.equal(row(w).shopify_removed_qty, 4);
  assert.equal(r.ok, true, 'identical to the recovered row, so it reads as the same request');
  assert.ok(w.errors.some(m => /RECOVERED interrupted flag/.test(m)));
  assert.equal(w.calls.length, 0, 'no second removal');
});
await test('RECONCILE: an orphaned applying row whose removal did NOT land is discarded, then the new flag proceeds', async () => {
  const w = world([{ currentQuantity: 10 }]);
  dbm.claimBackorderRemoval({ orderId: w.orderId, lineItemId: w.lines[0].liId, title: 'Elite Collar', variantId: 'v', sku: 'EC-1', variantTitle: '', unitPrice: '18.00', currency: 'USD', quantity: 4, priorQty: 10, createdBy: 'a@fww', now: w.clock });
  assert.equal((await flag(w, { quantity: 2 })).ok, true);
  assert.equal(w.lines[0].currentQuantity, 8);
  assert.equal(row(w).shopify_removed_qty, 2);
});
await test('RECONCILE never guesses: an orphan whose Shopify quantity matches neither outcome blocks the line with a clear message', async () => {
  const w = world([{ currentQuantity: 7 }]);
  dbm.claimBackorderRemoval({ orderId: w.orderId, lineItemId: w.lines[0].liId, title: 'Elite Collar', variantId: 'v', sku: 'EC-1', variantTitle: '', unitPrice: '18.00', currency: 'USD', quantity: 4, priorQty: 10, createdBy: 'a@fww', now: w.clock });
  const r = await flag(w, { quantity: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'unconfirmed');
  assert.match(r.message, /did not finish/);
  assert.equal(row(w).status, 'applying', 'kept, not deleted');
  assert.equal(w.lines[0].currentQuantity, 7);
});

console.log('\n  undoBackorder');
await test('UNDO after a FULL removal re-adds the variant as a NEW line at the STORED price', async () => {
  const w = world([{ currentQuantity: 4, unitPrice: 14 }]);
  const oldId = w.lines[0].liId;
  await flag(w, { quantity: 4 });
  const r = await undo(w, { lineItemId: oldId });
  assert.equal(r.ok, true);
  assert.equal(w.calls.at(-1).mode, 'add');
  assert.equal(w.calls.at(-1).unitPrice, 14);
  const added = w.lines.find(l => l.liId !== oldId);
  assert.deepEqual([added.currentQuantity, added.unitPrice, added.variantId], [4, 14, 'gid://shopify/ProductVariant/55']);
  assert.equal(w.lines.find(l => l.liId === oldId).currentQuantity, 0, 'the removed line stays removed — Shopify cannot revive it');
  assert.equal(row(w, oldId).status, 'restored');
  assert.deepEqual(dbm.getBackorderedLinesForOrder(w.orderId), []);
  assert.deepEqual(r.warnings, []);
});
await test('UNDO of a PARTIAL flag raises the existing line back (same line, same price)', async () => {
  const w = world([{ currentQuantity: 10 }]);
  await flag(w, { quantity: 4 });
  assert.equal((await undo(w)).ok, true);
  assert.equal(w.calls.at(-1).mode, 'raise');
  assert.equal(w.lines.length, 1);
  assert.equal(w.lines[0].currentQuantity, 10);
  assert.equal(row(w).status, 'restored');
});
await test('UNDO adds a separate line at the stored price when the surviving line\'s price has since been edited', async () => {
  const w = world([{ currentQuantity: 10, unitPrice: 18 }]);
  await flag(w, { quantity: 4 });
  w.lines[0].unitPrice = 20;                                    // staff re-priced the remaining 6
  assert.equal((await undo(w)).ok, true);
  assert.equal(w.calls.at(-1).mode, 'add');
  assert.equal(w.lines.length, 2);
  assert.equal(w.lines[0].currentQuantity, 6);
  assert.deepEqual([w.lines[1].currentQuantity, w.lines[1].unitPrice], [4, 18]);
});
await test('UNDO surfaces a warning when the restored line lands at a different price', async () => {
  const w = world([{ currentQuantity: 4, unitPrice: 14 }]);
  await flag(w, { quantity: 4 });
  w.restoredPrice = 28;                                         // e.g. a discount did not take
  const r = await undo(w);
  assert.equal(r.ok, true);
  assert.match(r.warnings.join(' '), /\$28\.00 instead of the stored \$14\.00/);
});
await test('UNDO rejected by Shopify: row stays PENDING (still backordered), nothing added', async () => {
  const w = world([{ currentQuantity: 4 }]);
  await flag(w, { quantity: 4 });
  w.rejectRestore = 'variant is archived';
  const r = await undo(w);
  assert.equal(r.ok, false);
  assert.equal(r.state, 'not_applied');
  assert.equal(row(w).status, 'pending');
  assert.equal(dbm.getBackorderedLinesForOrder(w.orderId).length, 1);
  assert.equal(w.lines.length, 1);
  w.rejectRestore = null;
  assert.equal((await undo(w)).ok, true, 'a retry after the failure works');
});
await test('UNDO that Shopify committed but errored on: read-back proves it → restored, not left pending (no double-add on retry)', async () => {
  const w = world([{ currentQuantity: 4 }]);
  await flag(w, { quantity: 4 });
  w.throwAfterApply = true;
  assert.equal((await undo(w)).ok, true);
  assert.equal(row(w).status, 'restored');
  w.throwAfterApply = false;
  const again = await undo(w);
  assert.deepEqual([again.ok, again.duplicate], [true, true]);
  assert.equal(w.lines.length, 2, 'exactly one re-added line');
});
await test('UNDO twice is idempotent; undo of an unknown line is refused', async () => {
  const w = world([{ currentQuantity: 4 }]);
  await flag(w, { quantity: 4 });
  await undo(w);
  const callsBefore = w.calls.length;
  const r2 = await undo(w);
  assert.deepEqual([r2.ok, r2.duplicate], [true, true]);
  assert.equal(w.calls.length, callsBefore);
  assert.equal((await undo(w, { lineItemId: 'gid://shopify/LineItem/nope' })).ok, false);
});
await test('UNDO of a LEGACY flag-only row just clears the flag — it never reaches Shopify', async () => {
  const w = world([{ currentQuantity: 5 }]);
  dbm.upsertBackorder(w.orderId, w.lines[0].liId, 'Elite Collar', 5, null, 'old@fww');
  const r = await undo(w);
  assert.deepEqual([r.ok, r.legacy], [true, true]);
  assert.equal(row(w).status, 'restored');
  assert.equal(w.calls.length, 0);
  assert.equal(w.readCount, 0);
});
await test('UNDO cannot proceed without a stored price (never falls back to list)', async () => {
  const w = world([{ currentQuantity: 4 }]);
  await flag(w, { quantity: 4 });
  dbm.default.prepare('UPDATE backorders SET unit_price = NULL WHERE order_id = ?').run(w.orderId);
  const r = await undo(w);
  assert.equal(r.ok, false);
  assert.match(r.message, /price saved/);
  assert.equal(w.calls.filter(c => c.kind === 'restore').length, 0);
  assert.equal(row(w).status, 'pending');
});
await test('RECONCILE: an orphaned restoring row whose units are back is marked restored — no second add', async () => {
  const w = world([{ currentQuantity: 4 }]);
  const oldId = w.lines[0].liId;
  await flag(w, { quantity: 4 });
  assert.equal(dbm.beginBackorderRestore(w.orderId, oldId, 0), true);   // crash after this …
  w.lines.push({ ...w.lines[0], liId: 'gid://shopify/LineItem/9999', currentQuantity: 4 }); // … but Shopify did add them
  const callsBefore = w.calls.length;
  const r = await undo(w, { lineItemId: oldId });
  assert.deepEqual([r.ok, r.duplicate], [true, true]);
  assert.equal(row(w, oldId).status, 'restored');
  assert.equal(w.calls.length, callsBefore, 'nothing was added again');
});
await test('RECONCILE: an orphaned restoring row whose units never came back returns to pending and the undo proceeds', async () => {
  const w = world([{ currentQuantity: 4 }]);
  const oldId = w.lines[0].liId;
  await flag(w, { quantity: 4 });
  dbm.beginBackorderRestore(w.orderId, oldId, 0);
  assert.equal((await undo(w, { lineItemId: oldId })).ok, true);
  assert.equal(w.lines.filter(l => l.currentQuantity > 0).length, 1);
  assert.equal(row(w, oldId).status, 'restored');
});
await test('the restore idempotency key is derived from the backorder row, not the request (a retry replays the ledger)', async () => {
  const w = world([{ currentQuantity: 4 }]);
  await flag(w, { quantity: 4 });
  w.rejectRestore = 'transient';
  await undo(w); await undo(w);
  const keys = w.calls.filter(c => c.kind === 'restore').map(c => c.idemKey);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
});

console.log('\n  Shopify documents');
await test('BACKORDER_LINE_FIELDS validates against the Admin schema snapshot (the schema scan cannot see interpolated selections)', () => {
  const snap = JSON.parse(readFileSync(new URL('./fixtures/shopify-admin-schema.json', import.meta.url), 'utf8'));
  const schema = buildClientSchema(snap.data);
  // The real query pages order.lineItems (fetchAllOrderLineItems); only the per-node selection is under test
  // here, so wrap it in a plain node() lookup - no connection, nothing for the pagination guard to flag.
  const doc = parse(`query($id:ID!){ node(id:$id){ ... on LineItem { ${BACKORDER_LINE_FIELDS} } } }`);
  const errs = validate(schema, doc).map(e => e.message);
  assert.deepEqual(errs, []);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
