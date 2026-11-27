import assert from 'node:assert/strict';
import { syncHelcimPayment } from '../lib/helcim-reconcile.mjs';
import { buildCreditCardInvoicePayload } from '../lib/helcim-note.mjs';
import { createPaymentNotifier } from '../lib/payment-notice.mjs';

const gid = 'gid://shopify/Order/42';
function fixture({ invoice = {}, ledger = {}, order = {}, failNotice = false, failOrder = false } = {}) {
  let row = { invoice_id: '123', invoice_number: 'INV123', amount: 10, currency: 'USD', ...ledger };
  const calls = [], audit = [];
  return { calls, audit, deps: {
    getLedger: () => row, claim: () => true, now: () => 1,
    setState: (_, patch) => Object.assign(row, patch),
    fetchInvoice: async () => ({ invoiceId: '123', invoiceNumber: 'INV123', status: 'PAID', amount: 10,
      amountPaid: 10, amountDue: 0, currency: 'USD', datePaid: '2026-11-27 12:00:00', ...invoice }),
    fetchOrder: async () => { if (failOrder) throw new Error('Shopify unavailable'); return { name: '#42', outstanding: 10, currency: 'USD', financialStatus: 'PENDING', ...order }; },
    notifyOwner: async notice => { calls.push(notice); if (failNotice) throw new Error('Gmail unavailable'); return { status: 'sent' }; },
    markOrderPaid: async () => { calls.push('write'); return { ok: true }; },
    audit: (...args) => audit.push(args), log: () => {},
  } };
}
for (const invoice of [{ status: 'DUE', amountPaid: 0 }, { amount: 11 }, { currency: 'CAD' }, { amountPaid: NaN }, { amountDue: undefined }]) {
  const f = fixture({ invoice }); await syncHelcimPayment(gid, f.deps); assert.deepEqual(f.calls, []);
}
for (const paid_state of ['paid_synced', 'already_paid']) {
  const f = fixture({ ledger: { paid_state } }); assert.equal((await syncHelcimPayment(gid, f.deps)).outcome, 'done'); assert.deepEqual(f.calls, []);
}
for (const options of [{}, { failNotice: true }, { order: { outstanding: 11 } }, { failOrder: true }]) {
  const f = fixture(options); const result = await syncHelcimPayment(gid, f.deps, { actor: 'alex@fuzzywumpets.com' });
  assert.equal(f.calls[0].source, 'helcim_invoice_paid'); assert.equal(f.calls[0].actorEmail, 'payments@fuzzywumpets.com');
  assert.equal(f.calls[0].invoiceId, '123'); assert.equal(f.calls[0].orders[0].amount, 10);
  assert.equal(result.outcome, options.failOrder ? 'error' : options.order ? 'needs_review' : 'synced');
  if (options.failNotice) assert.ok(f.audit.some(x => x[1] === 'payment_notice_failed'));
}
const payload = buildCreditCardInvoicePayload({ invoiceId: '123', invoiceNumber: 'INV123', note: 'Thank you', url: 'https://example.test' });
assert.equal(payload.creditCardInvoice.invoiceId, '123'); assert.match(payload.body, /> Thank you/);
for (const input of [{ invoiceId: '123' }, { invoiceId: 'x', invoiceNumber: 'INV123' }, { invoiceId: '123', invoiceNumber: 'x\ny' }]) assert.throws(() => buildCreditCardInvoicePayload(input));
const forwarded = [];
const notifier = createPaymentNotifier({ callPortal: async body => { forwarded.push(body); return { ok: true, email: { skipped: 'duplicate' } }; } });
const notice = fixture(); await syncHelcimPayment(gid, notice.deps);
await notifier.notify(notice.calls[0]); await notifier.notify(notice.calls[0]);
assert.equal(forwarded.length, 2, 'Portal durable dedupe receives every Helcim repeat, including changed payloads');
assert.equal(forwarded[0].invoiceNumber, 'INV123');
console.log('Helcim owner-notice identity, gating, failure isolation and forwarding passed');
