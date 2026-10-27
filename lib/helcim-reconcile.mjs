// lib/helcim-reconcile.mjs — Helcim -> Shopify "paid sync".
//
// A customer who pays a Helcim credit-card invoice (sent by POST /orders/:id/send-credit-card-invoice) pays Helcim, not
// Shopify, so the Shopify order stays PENDING and Admin keeps showing it as unpaid. This module closes that loop: it
// asks Helcim whether the invoice is PAID and, only when every money check agrees, marks the Shopify order paid.
//
// Everything here is dependency-injected (Helcim lookup, Shopify read/mutation, ledger store, audit log, clock) so the money
// rules are unit-tested without a server or network (test/helcim-reconcile.test.mjs). server.mjs builds the real deps with
// createHelcimSyncDeps(); nothing in this file imports db.mjs, helcim.mjs or Shopify directly.
//
// THE RULE: mark an order PAID only when (1) Helcim says the invoice is PAID, for exactly the ledger amount and currency,
// with nothing still due, and (2) the Shopify order is open and still owes exactly that amount. Anything else is left alone
// and recorded as `needs_review` for a human. Nothing here refunds, voids, edits an order, or posts to Xero.
//
// DEPENDS: db.mjs helcim_invoice_map paid_* columns + getHelcimInvoiceMap / claimHelcimPaymentSync / setHelcimPaymentState /
//   listHelcimInvoicesForPaymentSync (the `store` shape below); helcim.mjs getInvoice() (the normalized invoice shape);
//   server.mjs POST /orders/:id/sync-helcim-payment and the HELCIM_PAYMENT_SYNC poller; server.mjs summarizeAudit() renders the
//   three audit verbs below. Rename any of those together.

// Money tolerance: Helcim and Shopify both carry 2dp amounts as floats; compare within half a cent, never with ===.
export const MONEY_EPSILON = 0.005;
// A claim older than this is treated as an interrupted sync (process died mid-write) and may be re-claimed.
// SYNC: db.mjs claimHelcimPaymentSync takes this as its staleMs argument.
export const STALE_CLAIM_MS = 10 * 60 * 1000;

const DEFAULT_ACTOR = 'system:helcim-sync';
const CANCELLED_FINANCIAL = new Set(['REFUNDED', 'PARTIALLY_REFUNDED', 'VOIDED']);
const near = (a, b) => Math.abs(Number(a) - Number(b)) <= MONEY_EPSILON;
const money = (n) => Number(n).toFixed(2);

// WHAT: judges the Helcim side alone (no Shopify call): is it unpaid, paid-and-clean, or paid-but-odd?
// CHANGE-GUARD: returns `check_order` ONLY for a fully clean PAID invoice, so an unpaid poll never costs a Shopify call.
//   Partial payments are `needs_review`, never `none`, so money Helcim holds is never silently ignored.
// INVARIANT(S): pure; never throws; the invoice must be the ledger's own invoice, in the ledger's currency and amount.
export function assessInvoice(ledger, invoice) {
  if (String(invoice.invoiceId) !== String(ledger.invoice_id)) {
    return { action: 'needs_review', reason: `Helcim returned invoice ${invoice.invoiceId}, not the order's invoice ${ledger.invoice_id}` };
  }
  if (invoice.status !== 'PAID') {
    if (invoice.amountPaid > MONEY_EPSILON) {
      return { action: 'needs_review', reason: `Helcim shows a partial payment on this invoice (status ${invoice.status}, paid ${money(invoice.amountPaid)} of ${money(invoice.amount)}); nothing was recorded in Shopify` };
    }
    return { action: 'none', reason: `Helcim status ${invoice.status}` };
  }
  if (invoice.currency !== String(ledger.currency).toUpperCase()) {
    return { action: 'needs_review', reason: `Helcim invoice currency ${invoice.currency} differs from the recorded ${ledger.currency}` };
  }
  if (!near(invoice.amount, ledger.amount)) {
    return { action: 'needs_review', reason: `Helcim invoice amount ${money(invoice.amount)} differs from the amount recorded when it was sent (${money(ledger.amount)})` };
  }
  if (invoice.amountDue > MONEY_EPSILON) {
    return { action: 'needs_review', reason: `Helcim shows PAID but ${money(invoice.amountDue)} is still due` };
  }
  if (invoice.amountPaid < invoice.amount - MONEY_EPSILON) {
    return { action: 'needs_review', reason: `Helcim shows PAID but only ${money(invoice.amountPaid)} of ${money(invoice.amount)} was collected` };
  }
  if (invoice.amountPaid > invoice.amount + MONEY_EPSILON) {
    return { action: 'needs_review', reason: `Helcim collected more than the invoice amount (${money(invoice.amountPaid)} vs ${money(invoice.amount)}): tip or fee?` };
  }
  return { action: 'check_order', reason: 'Helcim invoice is paid in full' };
}

// WHAT: judges the Shopify side for a clean PAID invoice: may the order be marked paid, is it already, or does a human decide?
// CHANGE-GUARD: `outstanding` is what the order still OWES (totalOutstandingSet), not its total, so a partly-paid order is
//   compared on the right number. An order that already shows paid is NOT written again (duplicate-payment warning instead).
// INVARIANT(S): pure; `mark_paid` requires an open order whose outstanding equals the invoice amount in the same currency.
export function assessOrder(ledger, invoice, order) {
  if (!order) return { action: 'needs_review', reason: 'The Shopify order could not be found' };
  if (order.cancelledAt || CANCELLED_FINANCIAL.has(String(order.financialStatus).toUpperCase())) {
    return { action: 'needs_review', reason: `The Shopify order is cancelled or refunded (${order.cancelledAt ? 'cancelled' : String(order.financialStatus).toLowerCase()}) but Helcim shows the invoice paid` };
  }
  if (String(order.currency).toUpperCase() !== invoice.currency) {
    return { action: 'needs_review', reason: `The Shopify order currency ${order.currency} differs from the Helcim invoice currency ${invoice.currency}` };
  }
  if (String(order.financialStatus).toUpperCase() === 'PAID' || order.outstanding <= MONEY_EPSILON) {
    return { action: 'already_paid', reason: 'Shopify already showed this order as paid when the Helcim payment was found (recorded by staff, or an interrupted earlier sync): check the payment is not a duplicate' };
  }
  if (!near(order.outstanding, invoice.amount)) {
    return { action: 'needs_review', reason: `The order's balance (${money(order.outstanding)}) differs from the Helcim invoice (${money(invoice.amount)}): was the order edited after the invoice was sent?` };
  }
  return { action: 'mark_paid', reason: 'Order owes exactly the paid invoice amount' };
}

// WHAT: runs one order through the sync: read Helcim, (only if paid and clean) read Shopify, decide, write, record, audit.
// CHANGE-GUARD: the ledger row is CLAIMED ('syncing') before any external call and ALWAYS left in a non-syncing state on every
//   path (unpaid -> NULL, synced, already_paid, needs_review, error), so a crash can only leave a claim that expires after
//   STALE_CLAIM_MS. The order is re-read immediately before the mutation and re-assessed, so an edit made while Helcim was being
//   polled can never be paid at the old balance. A needs_review result is audited ONCE per distinct reason (a poller or a staff
//   re-click must not spam the order history). Shopify userErrors are an `error` outcome, never a silent success.
// INVARIANT(S): never marks paid unless assessInvoice and a fresh assessOrder both say so; never throws (every failure is an
//   `error` outcome with the ledger state recorded); idempotent (a synced/already_paid ledger returns 'done' without any call);
//   audit rows carry only invoice number, amounts and reasons, never the pay URL or token.
export async function syncHelcimPayment(orderGid, deps, { actor = DEFAULT_ACTOR } = {}) {
  const prev = deps.getLedger(orderGid);
  if (!prev) return { outcome: 'no_invoice' };
  if (prev.paid_state === 'paid_synced' || prev.paid_state === 'already_paid') return { outcome: 'done' };
  if (!deps.claim(orderGid)) return { outcome: 'busy' };

  const now = deps.now();
  const base = { invoiceNumber: prev.invoice_number || null, amount: Number(prev.amount), currency: prev.currency };
  const setState = (patch) => deps.setState(orderGid, { paid_checked_at: now, ...patch });
  const flag = (reason, helcimStatus) => {
    setState({ paid_state: 'needs_review', paid_note: reason, ...(helcimStatus ? { helcim_status: helcimStatus } : {}) });
    if (!(prev.paid_state === 'needs_review' && prev.paid_note === reason)) {
      deps.audit(actor, 'helcim_payment_needs_review', orderGid, null, { ...base, reason });
    }
    return { outcome: 'needs_review', reason };
  };

  try {
    const invoice = await deps.fetchInvoice(prev);
    const first = assessInvoice(prev, invoice);
    if (first.action === 'none') {
      setState({ paid_state: null, helcim_status: invoice.status, paid_note: null });
      return { outcome: 'unpaid', status: invoice.status };
    }
    if (first.action === 'needs_review') return flag(first.reason, invoice.status);

    let order = await deps.fetchOrder(orderGid);
    let verdict = assessOrder(prev, invoice, order);
    if (verdict.action === 'mark_paid') {
      // Re-read right before writing: an edit made while we were talking to Helcim must not be paid at the old balance.
      order = await deps.fetchOrder(orderGid);
      verdict = assessOrder(prev, invoice, order);
    }
    if (verdict.action === 'needs_review') return flag(verdict.reason, invoice.status);

    const paidFacts = { ...base, amount: invoice.amountPaid, helcimDatePaid: invoice.datePaid };
    if (verdict.action === 'already_paid') {
      setState({ paid_state: 'already_paid', helcim_status: invoice.status, paid_amount: invoice.amountPaid, paid_note: verdict.reason, paid_synced_at: now });
      deps.audit(actor, 'helcim_payment_synced', orderGid, null, { ...paidFacts, shopifyAlreadyPaid: true, note: verdict.reason });
      return { outcome: 'already_paid', reason: verdict.reason };
    }

    const result = await deps.markOrderPaid(orderGid);
    if (!result?.ok) {
      const error = String(result?.error || 'Shopify did not confirm the payment').slice(0, 300);
      setState({ paid_state: 'error', helcim_status: invoice.status, paid_note: error });
      deps.audit(actor, 'helcim_payment_sync_failed', orderGid, null, { ...base, error });
      return { outcome: 'error', error };
    }
    setState({ paid_state: 'paid_synced', helcim_status: invoice.status, paid_amount: invoice.amountPaid, paid_note: null, paid_synced_at: now });
    deps.audit(actor, 'helcim_payment_synced', orderGid, null, paidFacts);
    return { outcome: 'synced' };
  } catch (err) {
    const error = String(err?.message || err || 'Payment sync failed').slice(0, 300);
    try { setState({ paid_state: 'error', paid_note: error }); } catch { /* the claim expires on its own */ }
    return { outcome: 'error', error };
  }
}

// WHAT: the poller's sweep — syncs every ledger row that is due for a check, up to `limit`, one at a time.
// CHANGE-GUARD: sequential on purpose (Helcim and Shopify rate limits); one failing order never stops the sweep; the limit caps a
//   backlog so a restart after a long outage cannot burst the Helcim API. `syncOne` is injectable for tests.
// INVARIANT(S): returns counts only (no ids, amounts or URLs) so the caller can log it freely.
export async function syncAllHelcimPayments(deps, { limit = 20, actor = DEFAULT_ACTOR, syncOne } = {}) {
  const run = syncOne || ((gid) => syncHelcimPayment(gid, deps, { actor }));
  const summary = { checked: 0, synced: 0, already_paid: 0, needs_review: 0, unpaid: 0, error: 0, busy: 0, done: 0, no_invoice: 0 };
  for (const row of deps.listDue({ limit })) {
    summary.checked++;
    let outcome;
    try { outcome = (await run(row.order_id))?.outcome; } catch { outcome = 'error'; }
    summary[outcome in summary ? outcome : 'error']++;
  }
  return summary;
}

// WHAT: builds the real dependency set for syncHelcimPayment/syncAllHelcimPayments from the app's own helpers.
// CHANGE-GUARD: shopifyFetch must be the app's authenticated GraphQL helper; getInvoice is helcim.mjs getInvoice; `store` is the
//   four db.mjs ledger functions. `fetchOrder` reads totalOutstandingSet (what is still OWED), never the total, and throws on a
//   Shopify failure rather than guessing. `markOrderPaid` uses orderMarkAsPaid (full outstanding — the only payment mutation this
//   store's Shopify plan allows, same as POST /orders/:id/record-payment) and fails closed unless Shopify returns the order with
//   no userErrors.
// INVARIANT(S): no secret is read or returned here; userErrors become { ok:false, error } and never throw.
export function createHelcimSyncDeps({ shopifyFetch, getInvoice, store, auditLog, now = Date.now }) {
  return {
    getLedger: (gid) => store.getLedger(gid),
    claim: (gid) => store.claim(gid, now(), STALE_CLAIM_MS),
    setState: (gid, patch) => store.setState(gid, patch),
    listDue: ({ limit }) => store.listDue({ limit, nowMs: now(), staleMs: STALE_CLAIM_MS }),
    fetchInvoice: (ledger) => getInvoice(ledger.invoice_id),
    fetchOrder: async (gid) => {
      const r = await shopifyFetch(
        `query($id:ID!){ order(id:$id){ id displayFinancialStatus cancelledAt totalOutstandingSet{ presentmentMoney{ amount currencyCode } } } }`,
        { id: gid },
      );
      if (r?.errors?.length) throw new Error(String(r.errors[0]?.message || 'Shopify returned an error'));
      const o = r?.data?.order;
      if (!o) return null;
      const m = o.totalOutstandingSet?.presentmentMoney;
      return {
        financialStatus: o.displayFinancialStatus,
        cancelledAt: o.cancelledAt || null,
        outstanding: Number(m?.amount),
        currency: m?.currencyCode,
      };
    },
    markOrderPaid: async (gid) => {
      const r = await shopifyFetch(
        `mutation orderMarkAsPaid($input:OrderMarkAsPaidInput!){ orderMarkAsPaid(input:$input){ order{ id displayFinancialStatus } userErrors{ field message } } }`,
        { input: { id: gid } },
      );
      const payload = r?.data?.orderMarkAsPaid;
      if (!payload) return { ok: false, error: 'Shopify returned no orderMarkAsPaid result' };
      const userErrors = Array.isArray(payload.userErrors) ? payload.userErrors : null;
      if (!userErrors) return { ok: false, error: 'Shopify returned no userErrors list' };
      if (userErrors.length) return { ok: false, error: userErrors.map((e) => e.message).join('; ') };
      if (!payload.order) return { ok: false, error: 'Shopify did not return the order' };
      return { ok: true };
    },
    audit: (...args) => auditLog(...args),
    now,
  };
}
