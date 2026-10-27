// Standalone suite for lib/helcim-reconcile.mjs — the Helcim -> Shopify "paid sync".
//
// No server, no network, no DB: every dependency (Helcim lookup, Shopify read/mutation, the ledger store, the audit
// log, the clock) is a fake injected through the deps object, so this file can prove the money rules that the mock HTTP
// server can never reach (the real path is gated on `if (!MOCK)`). The SQL half lives in helcim-paid-migration.test.mjs.
//
// The rule being protected: an order is marked PAID in Shopify only when Helcim says the invoice is PAID for exactly the
// ledger amount AND the Shopify order still owes exactly that amount. Anything else is left alone and flagged.

import assert from 'node:assert/strict';
import {
  MONEY_EPSILON, assessInvoice, assessOrder, syncHelcimPayment, syncAllHelcimPayments, createHelcimSyncDeps,
} from '../lib/helcim-reconcile.mjs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${err.message}`); failed++; }
}

const GID = 'gid://shopify/Order/40091';
const ledgerRow = (over = {}) => ({
  order_id: GID, invoice_id: '73767296', invoice_number: 'INV001003', amount: 1, currency: 'USD',
  paid_state: null, paid_note: null, ...over,
});
const invoice = (over = {}) => ({
  invoiceId: '73767296', invoiceNumber: 'INV001003', status: 'PAID', amount: 1, amountPaid: 1, amountDue: 0,
  currency: 'USD', datePaid: '2026-10-26 16:07:40', ...over,
});
const order = (over = {}) => ({ financialStatus: 'PENDING', cancelledAt: null, outstanding: 1, currency: 'USD', ...over });

// ── assessInvoice: what Helcim says, before Shopify is even consulted ────────────────────────────────────────
console.log('\n  assessInvoice');

await test('a DUE invoice is simply not paid yet (no Shopify lookup needed)', () => {
  const r = assessInvoice(ledgerRow(), invoice({ status: 'DUE', amountPaid: 0, amountDue: 1 }));
  assert.equal(r.action, 'none');
});

await test('an OVERDUE / unknown unpaid status is still just "not paid yet"', () => {
  for (const status of ['OVERDUE', 'SENT', 'DRAFT', 'CANCELLED', 'VOID', 'SOMETHING_NEW']) {
    assert.equal(assessInvoice(ledgerRow(), invoice({ status, amountPaid: 0, amountDue: 1 })).action, 'none', status);
  }
});

await test('PAID for exactly the ledger amount advances to the Shopify check', () => {
  assert.equal(assessInvoice(ledgerRow(), invoice()).action, 'check_order');
});

await test('money compares with a tolerance, not float equality (601.24 vs 601.2400000001)', () => {
  const l = ledgerRow({ amount: 601.24 });
  assert.equal(assessInvoice(l, invoice({ amount: 601.2400000001, amountPaid: 601.24 })).action, 'check_order');
  assert.ok(MONEY_EPSILON > 0 && MONEY_EPSILON < 0.01);
});

await test('a partial payment (not PAID but money received) is flagged, never written to Shopify', () => {
  const r = assessInvoice(ledgerRow({ amount: 10 }), invoice({ status: 'DUE', amount: 10, amountPaid: 4, amountDue: 6 }));
  assert.equal(r.action, 'needs_review');
  assert.match(r.reason, /partial/i);
});

await test('PAID but with a balance still due is flagged', () => {
  assert.equal(assessInvoice(ledgerRow(), invoice({ amountDue: 0.5, amountPaid: 0.5 })).action, 'needs_review');
});

await test('PAID but less than the invoice amount, or MORE (tip/fee), is flagged', () => {
  assert.equal(assessInvoice(ledgerRow({ amount: 10 }), invoice({ amount: 10, amountPaid: 9 })).action, 'needs_review');
  const over = assessInvoice(ledgerRow({ amount: 10 }), invoice({ amount: 10, amountPaid: 12 }));
  assert.equal(over.action, 'needs_review');
  assert.match(over.reason, /more than/i);
});

await test('PAID for a different amount than the ledger recorded is flagged (invoice edited in Helcim)', () => {
  const r = assessInvoice(ledgerRow({ amount: 1 }), invoice({ amount: 5, amountPaid: 5 }));
  assert.equal(r.action, 'needs_review');
  assert.match(r.reason, /amount/i);
});

await test('a currency mismatch is flagged', () => {
  assert.equal(assessInvoice(ledgerRow({ currency: 'USD' }), invoice({ currency: 'CAD' })).action, 'needs_review');
});

await test('an invoice id that is not the ledger invoice is flagged (never trust a mis-routed lookup)', () => {
  assert.equal(assessInvoice(ledgerRow(), invoice({ invoiceId: '999' })).action, 'needs_review');
});

// ── assessOrder: Shopify must still owe exactly what Helcim collected ────────────────────────────────────────
console.log('\n  assessOrder');

await test('a pending order owing exactly the invoice amount is marked paid', () => {
  assert.equal(assessOrder(ledgerRow(), invoice(), order()).action, 'mark_paid');
});

await test('a partially-paid order is judged on what it still OWES, not its total', () => {
  const l = ledgerRow({ amount: 40 });
  assert.equal(assessOrder(l, invoice({ amount: 40, amountPaid: 40 }), order({ financialStatus: 'PARTIALLY_PAID', outstanding: 40 })).action, 'mark_paid');
});

await test('an order Shopify already shows as PAID is NOT written again; it is recorded as already_paid with a duplicate warning', () => {
  const r = assessOrder(ledgerRow(), invoice(), order({ financialStatus: 'PAID', outstanding: 0 }));
  assert.equal(r.action, 'already_paid');
  assert.match(r.reason, /duplicate|already/i);
});

await test('zero outstanding counts as already paid even if the status text lags', () => {
  assert.equal(assessOrder(ledgerRow(), invoice(), order({ financialStatus: 'PENDING', outstanding: 0 })).action, 'already_paid');
});

await test('an order edited after invoicing (balance differs) is flagged, not marked paid', () => {
  const r = assessOrder(ledgerRow(), invoice(), order({ outstanding: 3.5 }));
  assert.equal(r.action, 'needs_review');
  assert.match(r.reason, /balance/i);
});

await test('cancelled / refunded / voided orders are flagged', () => {
  assert.equal(assessOrder(ledgerRow(), invoice(), order({ cancelledAt: '2026-10-27T00:00:00Z' })).action, 'needs_review');
  for (const financialStatus of ['REFUNDED', 'PARTIALLY_REFUNDED', 'VOIDED']) {
    assert.equal(assessOrder(ledgerRow(), invoice(), order({ financialStatus })).action, 'needs_review', financialStatus);
  }
});

await test('a missing order, or a currency mismatch with Shopify, is flagged', () => {
  assert.equal(assessOrder(ledgerRow(), invoice(), null).action, 'needs_review');
  assert.equal(assessOrder(ledgerRow(), invoice(), order({ currency: 'CAD' })).action, 'needs_review');
});

// ── syncHelcimPayment: the orchestrator, against fakes ───────────────────────────────────────────────────────
console.log('\n  syncHelcimPayment');

function harness({ ledger = ledgerRow(), inv = invoice(), ord = order(), ordSecond, markResult = { ok: true }, claimOk = true, throwInvoice = null, throwAudit = null, throwOnPaidSynced = null } = {}) {
  const calls = { invoice: 0, order: 0, mark: 0, claim: 0 };
  const audits = [];
  const state = { ...ledger };
  const patches = [];
  const orders = [ord, ordSecond === undefined ? ord : ordSecond];
  const deps = {
    getLedger: (gid) => (gid === GID && ledger ? { ...state } : null),
    claim: () => { calls.claim++; if (!claimOk) return false; state.paid_state = 'syncing'; return true; },
    setState: (gid, patch) => { if (throwOnPaidSynced && patch.paid_state === 'paid_synced') throw throwOnPaidSynced; patches.push(patch); Object.assign(state, patch); },
    fetchInvoice: async () => { calls.invoice++; if (throwInvoice) throw throwInvoice; return inv; },
    fetchOrder: async () => orders[Math.min(calls.order++, 1)],
    markOrderPaid: async () => { calls.mark++; return markResult; },
    audit: (actor, action, gid, before, after) => { if (throwAudit) throw throwAudit; audits.push({ actor, action, gid, after }); },
    now: () => 1_793_000_000_000,
  };
  return { deps, calls, audits, state, patches };
}

await test('NOT PAID: records the Helcim status, releases the claim, and never touches Shopify', async () => {
  const h = harness({ inv: invoice({ status: 'DUE', amountPaid: 0, amountDue: 1 }) });
  const r = await syncHelcimPayment(GID, h.deps, { actor: 'a@x' });
  assert.equal(r.outcome, 'unpaid');
  assert.equal(h.calls.order, 0);
  assert.equal(h.calls.mark, 0);
  assert.equal(h.state.paid_state, null, 'claim released back to NULL so the next poll re-checks');
  assert.equal(h.state.helcim_status, 'DUE');
  assert.equal(h.audits.length, 0, 'an unpaid check is not an audit event');
});

await test('PAID happy path: marks the order paid exactly once, stores the result, audits it under the actor', async () => {
  const h = harness();
  const r = await syncHelcimPayment(GID, h.deps, { actor: 'staff@fww' });
  assert.equal(r.outcome, 'synced');
  assert.equal(h.calls.mark, 1);
  assert.equal(h.state.paid_state, 'paid_synced');
  assert.equal(h.state.paid_amount, 1);
  assert.equal(h.state.helcim_status, 'PAID');
  assert.ok(h.state.paid_synced_at > 0);
  assert.equal(h.audits.length, 1);
  assert.equal(h.audits[0].action, 'helcim_payment_synced');
  assert.equal(h.audits[0].actor, 'staff@fww');
  assert.deepEqual(
    { invoiceNumber: h.audits[0].after.invoiceNumber, amount: h.audits[0].after.amount, currency: h.audits[0].after.currency },
    { invoiceNumber: 'INV001003', amount: 1, currency: 'USD' },
  );
});

await test('the audit row never carries the pay URL/token (only invoice number, amount, currency, dates)', async () => {
  const h = harness();
  await syncHelcimPayment(GID, h.deps, { actor: 'a' });
  const text = JSON.stringify(h.audits);
  assert.ok(!/token|myhelcim|http/i.test(text), text);
});

await test('IDEMPOTENT: a second call on a synced ledger does nothing (no Helcim call, no mutation, no audit)', async () => {
  const h = harness();
  await syncHelcimPayment(GID, h.deps, { actor: 'a' });
  const before = { ...h.calls }; const auditsBefore = h.audits.length;
  const r = await syncHelcimPayment(GID, h.deps, { actor: 'a' });
  assert.equal(r.outcome, 'done');
  assert.deepEqual(h.calls, before);
  assert.equal(h.audits.length, auditsBefore);
});

await test('a ledger already marked already_paid is also a no-op', async () => {
  const h = harness({ ledger: ledgerRow({ paid_state: 'already_paid' }) });
  assert.equal((await syncHelcimPayment(GID, h.deps, { actor: 'a' })).outcome, 'done');
  assert.equal(h.calls.invoice, 0);
});

await test('BUSY: if another sync holds the claim, nothing is fetched or written', async () => {
  const h = harness({ claimOk: false });
  const r = await syncHelcimPayment(GID, h.deps, { actor: 'a' });
  assert.equal(r.outcome, 'busy');
  assert.equal(h.calls.invoice + h.calls.order + h.calls.mark, 0);
});

await test('no ledger row for the order => no_invoice, nothing called', async () => {
  const h = harness();
  h.deps.getLedger = () => null;
  assert.equal((await syncHelcimPayment(GID, h.deps, { actor: 'a' })).outcome, 'no_invoice');
  assert.equal(h.calls.claim, 0);
});

await test('Shopify already PAID: no mutation, ledger already_paid, audited as synced with the duplicate warning', async () => {
  const h = harness({ ord: order({ financialStatus: 'PAID', outstanding: 0 }) });
  const r = await syncHelcimPayment(GID, h.deps, { actor: 'a' });
  assert.equal(r.outcome, 'already_paid');
  assert.equal(h.calls.mark, 0);
  assert.equal(h.state.paid_state, 'already_paid');
  assert.equal(h.audits[0].action, 'helcim_payment_synced');
  assert.equal(h.audits[0].after.shopifyAlreadyPaid, true);
});

await test('balance mismatch: flagged needs_review with the reason stored, no mutation, one audit row', async () => {
  const h = harness({ ord: order({ outstanding: 7 }) });
  const r = await syncHelcimPayment(GID, h.deps, { actor: 'a' });
  assert.equal(r.outcome, 'needs_review');
  assert.equal(h.calls.mark, 0);
  assert.equal(h.state.paid_state, 'needs_review');
  assert.match(h.state.paid_note, /balance/i);
  assert.equal(h.audits.length, 1);
  assert.equal(h.audits[0].action, 'helcim_payment_needs_review');
});

await test('re-checking an UNCHANGED needs_review case does not add another audit row (no log spam)', async () => {
  const h = harness({ ord: order({ outstanding: 7 }) });
  await syncHelcimPayment(GID, h.deps, { actor: 'a' });
  await syncHelcimPayment(GID, h.deps, { actor: 'a' });
  await syncHelcimPayment(GID, h.deps, { actor: 'a' });
  assert.equal(h.audits.length, 1);
});

await test('a needs_review order that staff then fix is picked up on the next manual check', async () => {
  const h = harness({ ord: order({ outstanding: 7 }), ordSecond: order({ outstanding: 7 }) });
  await syncHelcimPayment(GID, h.deps, { actor: 'a' });
  assert.equal(h.state.paid_state, 'needs_review');
  // staff correct the order so it owes exactly the invoice amount again
  h.deps.fetchOrder = async () => order({ outstanding: 1 });
  const r = await syncHelcimPayment(GID, h.deps, { actor: 'a' });
  assert.equal(r.outcome, 'synced');
  assert.equal(h.state.paid_state, 'paid_synced');
});

await test('RACE: the order changes between the first read and the pre-write re-read => nothing is written', async () => {
  const h = harness({ ord: order({ outstanding: 1 }), ordSecond: order({ outstanding: 9 }) });
  const r = await syncHelcimPayment(GID, h.deps, { actor: 'a' });
  assert.equal(r.outcome, 'needs_review');
  assert.equal(h.calls.mark, 0);
  assert.equal(h.calls.order, 2, 'the order is re-read immediately before the mutation');
});

await test('Shopify refuses the mutation (userErrors): state=error, NOT marked paid, claim released, failure audited', async () => {
  const h = harness({ markResult: { ok: false, error: 'Order cannot be marked as paid' } });
  const r = await syncHelcimPayment(GID, h.deps, { actor: 'a' });
  assert.equal(r.outcome, 'error');
  assert.equal(h.state.paid_state, 'error');
  assert.match(h.state.paid_note, /cannot be marked/);
  assert.equal(h.audits.at(-1).action, 'helcim_payment_sync_failed');
});

await test('a Helcim/network failure leaves state=error (retryable), never stuck in syncing, and does not call Shopify', async () => {
  const h = harness({ throwInvoice: new Error('Helcim API request timed out') });
  const r = await syncHelcimPayment(GID, h.deps, { actor: 'a' });
  assert.equal(r.outcome, 'error');
  assert.equal(h.state.paid_state, 'error');
  assert.equal(h.calls.mark, 0);
});

// Found by DeepReview 2026-10-27: once Shopify has said ok, a failing audit/ledger write must never turn the result into an
// 'error' ("nothing was marked paid") — that would be a lie about money that really moved.
await test('AFTER A SUCCESSFUL SHOPIFY WRITE: an audit failure still reports "synced" (with a warning), keeps paid_synced, writes Shopify once', async () => {
  const h = harness({ throwAudit: new Error('SQLITE_FULL: database or disk is full') });
  const r = await syncHelcimPayment(GID, h.deps, { actor: 'a' });
  assert.equal(r.outcome, 'synced');
  assert.match(r.warning, /could not be (fully )?saved|not be recorded/i);
  assert.equal(h.calls.mark, 1);
  assert.equal(h.state.paid_state, 'paid_synced', 'the success record must not be downgraded to error');
  assert.equal(h.patches.some(p => p.paid_state === 'error'), false);
});

await test('AFTER A SUCCESSFUL SHOPIFY WRITE: a ledger write failure still reports "synced"; the next check finds the order paid and does NOT write Shopify again', async () => {
  const h = harness({ throwOnPaidSynced: new Error('SQLITE_BUSY') });
  const r = await syncHelcimPayment(GID, h.deps, { actor: 'a' });
  assert.equal(r.outcome, 'synced');
  assert.ok(r.warning);
  assert.equal(h.calls.mark, 1);
  assert.equal(h.state.paid_state, 'syncing', 'the claim is left to expire; it is never rewritten to error');
  // The claim expires; the next sync reads Shopify, sees the order PAID, and records it instead of writing again.
  h.deps.fetchOrder = async () => order({ financialStatus: 'PAID', outstanding: 0 });
  h.deps.setState = (gid, patch) => Object.assign(h.state, patch);
  const again = await syncHelcimPayment(GID, h.deps, { actor: 'a' });
  assert.equal(again.outcome, 'already_paid');
  assert.equal(h.calls.mark, 1, 'no second orderMarkAsPaid');
});

await test('INVARIANT: no outcome ever leaves the ledger in "syncing"', async () => {
  const scenarios = [
    harness(),
    harness({ inv: invoice({ status: 'DUE', amountPaid: 0, amountDue: 1 }) }),
    harness({ ord: order({ outstanding: 7 }) }),
    harness({ ord: order({ financialStatus: 'PAID', outstanding: 0 }) }),
    harness({ markResult: { ok: false, error: 'x' } }),
    harness({ throwInvoice: new Error('boom') }),
    harness({ ordSecond: order({ outstanding: 9 }) }),
  ];
  for (const h of scenarios) {
    await syncHelcimPayment(GID, h.deps, { actor: 'a' });
    assert.notEqual(h.state.paid_state, 'syncing');
  }
});

await test('the audit actor defaults to a system label when none is given', async () => {
  const h = harness();
  await syncHelcimPayment(GID, h.deps);
  assert.match(h.audits[0].actor, /system/);
});

// ── syncAllHelcimPayments: the poller's sweep ────────────────────────────────────────────────────────────────
console.log('\n  syncAllHelcimPayments');

await test('sweeps every due row, survives one failure, and reports counts', async () => {
  const seen = [];
  const rows = ['gid://shopify/Order/1', 'gid://shopify/Order/2', 'gid://shopify/Order/3', 'gid://shopify/Order/4'];
  const outcomes = { 'gid://shopify/Order/1': 'synced', 'gid://shopify/Order/2': 'THROW', 'gid://shopify/Order/3': 'unpaid', 'gid://shopify/Order/4': 'needs_review' };
  const deps = { listDue: ({ limit }) => rows.slice(0, limit).map(order_id => ({ order_id })) };
  const summary = await syncAllHelcimPayments(deps, {
    limit: 10, syncOne: async (gid) => { seen.push(gid); if (outcomes[gid] === 'THROW') throw new Error('kaboom'); return { outcome: outcomes[gid] }; },
  });
  assert.deepEqual(seen, rows);
  assert.deepEqual(summary, { checked: 4, synced: 1, already_paid: 0, needs_review: 1, unpaid: 1, error: 1, busy: 0, done: 0, no_invoice: 0 });
});

await test('respects the per-sweep limit so a backlog cannot hammer Helcim', async () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ order_id: `gid://shopify/Order/${i}` }));
  const seen = [];
  await syncAllHelcimPayments({ listDue: ({ limit }) => rows.slice(0, limit) }, { limit: 7, syncOne: async (g) => { seen.push(g); return { outcome: 'unpaid' }; } });
  assert.equal(seen.length, 7);
});

// ── createHelcimSyncDeps: the real wiring (GraphQL shapes) against a fake shopifyFetch ───────────────────────
console.log('\n  createHelcimSyncDeps (Shopify wiring)');

function wiring(responses) {
  const queries = [];
  const shopifyFetch = async (query, variables) => {
    queries.push({ query, variables });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const store = { getLedger: () => null, claim: () => true, setState: () => {}, listDue: () => [] };
  const deps = createHelcimSyncDeps({ shopifyFetch, getInvoice: async () => invoice(), store, auditLog: () => {}, now: () => 5 });
  return { deps, queries };
}

await test('fetchOrder reads financial status, cancelledAt and the OUTSTANDING (not total) with its currency', async () => {
  const w = wiring([{ data: { order: { displayFinancialStatus: 'PENDING', cancelledAt: null, totalOutstandingSet: { presentmentMoney: { amount: '1.00', currencyCode: 'USD' } } } } }]);
  const o = await w.deps.fetchOrder(GID);
  assert.deepEqual(o, { financialStatus: 'PENDING', cancelledAt: null, outstanding: 1, currency: 'USD' });
  assert.match(w.queries[0].query, /totalOutstandingSet/);
  assert.deepEqual(w.queries[0].variables, { id: GID });
});

await test('fetchOrder returns null for a missing order and throws on a Shopify failure (never guesses)', async () => {
  assert.equal(await wiring([{ data: { order: null } }]).deps.fetchOrder(GID), null);
  await assert.rejects(wiring([new Error('shopify down')]).deps.fetchOrder(GID), /shopify down/);
  await assert.rejects(wiring([{ errors: [{ message: 'throttled' }] }]).deps.fetchOrder(GID), /throttled/);
});

await test('markOrderPaid uses orderMarkAsPaid on exactly this order and reports ok', async () => {
  const w = wiring([{ data: { orderMarkAsPaid: { order: { id: GID, displayFinancialStatus: 'PAID' }, userErrors: [] } } }]);
  assert.deepEqual(await w.deps.markOrderPaid(GID), { ok: true });
  assert.match(w.queries[0].query, /orderMarkAsPaid/);
  assert.deepEqual(w.queries[0].variables, { input: { id: GID } });
});

await test('markOrderPaid turns userErrors into { ok:false, error } and never throws for them', async () => {
  const w = wiring([{ data: { orderMarkAsPaid: { order: null, userErrors: [{ field: ['id'], message: 'Order is already paid' }, { field: null, message: 'other' }] } } }]);
  const r = await w.deps.markOrderPaid(GID);
  assert.equal(r.ok, false);
  assert.match(r.error, /already paid/);
});

await test('markOrderPaid does not claim success when the response is missing (fail closed)', async () => {
  const r = await wiring([{ data: {} }]).deps.markOrderPaid(GID);
  assert.equal(r.ok, false);
});

await test('fetchInvoice passes the LEDGER invoice id to the Helcim client', async () => {
  let asked;
  const store = { getLedger: () => null, claim: () => true, setState: () => {}, listDue: () => [] };
  const deps = createHelcimSyncDeps({ shopifyFetch: async () => ({}), getInvoice: async (id) => { asked = id; return invoice(); }, store, auditLog: () => {} });
  await deps.fetchInvoice(ledgerRow({ invoice_id: '555' }));
  assert.equal(asked, '555');
});

console.log(`\n  HELCIM-RECONCILE: ${passed} passed, ${failed} failed ${failed ? '✗' : '✓'}`);
process.exit(failed ? 1 : 0);
