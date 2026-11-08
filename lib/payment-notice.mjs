// lib/payment-notice.mjs — Admin half of the "payment received" email to the owner (Alex, 2026-10-27).
//
// SCOPE: payments STAFF record in this app only - Mark Paid on the Orders list (POST /orders/bulk), Mark Paid on the
// order page (POST /orders/:id/mark-paid) and Record payment (POST /orders/:id/record-payment). A customer paying the
// Helcim card invoice is announced by Helcim's own merchant copy; nothing here may be called from the Helcim paid-sync
// path (it would double-notify every card payment).
//
// HOW: after Shopify accepted the payment AND the audit row is written, server.mjs calls notifier.notify(...) WITHOUT
// awaiting it. This module POSTs { source, actorEmail, paymentMethod?, orders[] } to the Portal's
// POST /__internal__/payment-notice (the Portal owns the Gmail broker env and decides the recipient, and sends nothing
// when the staff member IS the recipient). Admin sends no recipient, subject, sender or link.
//
// DEPENDS: Portal payment-notice.mjs validatePaymentNoticeInput / handlePaymentNotice define the request and response
// shapes read here; source names, field names and MAX_ORDERS must stay in step with it, and the Portal must be deployed
// FIRST (an Admin that calls a Portal without the route gets a 404, which is logged + audited and never affects a payment).
// DEPENDS: server.mjs wires `callPortal` (callPortalInternal with a timeout), `audit` (db.mjs auditLog) and the three call sites.

// SYNC: Portal payment-notice.mjs SOURCES - the same three names.
export const PAYMENT_NOTICE_SOURCES = Object.freeze(['mark_paid_bulk', 'mark_paid', 'record_payment']);
// SYNC: Portal payment-notice.mjs MAX_ORDERS - more orders than this go out as several requests, never as a 400.
export const MAX_ORDERS = 250;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_KEYS = 5000;

// WHAT: the idempotency key for one announced payment: source + order + amount in cents.
// CHANGE-GUARD: amount is part of the key so two DIFFERENT payments on one order (e.g. two part-payments of different
// sizes) are both announced; the TTL in the notifier is what lets a later payment of the SAME size through.
export function paymentNoticeKey({ source, orderId, amount }) {
  return `${source}|${orderId}|${Math.round(Number(amount) * 100)}`;
}

// WHAT: turns the `order` object of an orderMarkAsPaid payload into the notice's order entry. The amount is the CURRENT
// total (post-edit truth, presentment money) - the frozen totalPriceSet over-states an edited order (see server.mjs
// CURRENT-FIELDS note). Returns amount: null when Shopify sent no usable money, so the notifier drops-and-audits that
// order instead of announcing a made-up $0.00.
// CHANGE-GUARD: never throws; accepts null/garbage. The Mark Paid mutation selection (lib/order-money.mjs
// ORDER_MARK_AS_PAID_MUTATION) must keep selecting `name` and `currentTotalPriceSet{presentmentMoney{amount currencyCode}}`.
export function orderNoticeFields(numId, order) {
  const id = String(numId);
  const money = order?.currentTotalPriceSet?.presentmentMoney;
  const amount = money && money.amount != null && String(money.amount).trim() !== '' ? Number(money.amount) : NaN;
  const currency = typeof money?.currencyCode === 'string' ? money.currencyCode : '';
  const valid = Number.isFinite(amount) && amount >= 0 && /^[A-Z]{3}$/.test(currency);
  return {
    orderId: id,
    orderName: typeof order?.name === 'string' && order.name.trim() ? order.name.trim() : `#${id}`,
    amount: valid ? amount : null,
    currency: valid ? currency : null,
  };
}

const validOrder = (x) => x && /^\d{1,20}$/.test(String(x.orderId))
  && typeof x.amount === 'number' && Number.isFinite(x.amount) && x.amount >= 0
  && typeof x.currency === 'string' && /^[A-Z]{3}$/.test(x.currency);

// WHAT: builds the notifier. Everything it touches is injected so it can be unit-tested without a server:
//   callPortal(body) -> Promise<{ ok, email?:{sent,skipped,error}, error? }>   (server.mjs: callPortalInternal + timeout)
//   audit({ email, action, target, after })                                     (server.mjs: db.mjs auditLog)
//   log(...args), now(), enabled, ttlMs, maxKeys.
// notify({ source, actorEmail, orders:[{orderId,orderName,amount,currency}], paymentMethod? }) ALWAYS resolves, with
//   { status: 'sent' | 'skipped' | 'duplicate' | 'disabled' | 'nothing' | 'failed', ... } - it never throws.
// CHANGE-GUARD: FAIL-OPEN is the whole point. The payment already happened in Shopify; any problem here (Portal down,
//   404 from an older Portal, Gmail error, bad data, a throwing audit/log) is swallowed, logged and audited as
//   `payment_notice_failed`, and must never reach the staff member's redirect. IDEMPOTENT: the key (source|order|cents) is
//   taken BEFORE the Portal call, so two overlapping requests (a double click) send once; a FAILED send keeps its key too
//   (at most once - the audit row is the record, and Shopify refuses a second identical Mark Paid anyway). Keys live in
//   memory for ttlMs (15 min, so a genuine second payment of the same amount later is still announced) and are lost on
//   restart (a double click spanning a restart is accepted). The call sites must NOT await notify().
// INVARIANT(S): at most one request per <=250 orders; a reply counts as delivered only if the Portal says
//   email.sent === true, and as intentionally skipped only if it names email.skipped; anything else is a failure.
export function createPaymentNotifier({
  callPortal, audit = () => {}, log = () => {}, enabled = true,
  ttlMs = DEFAULT_TTL_MS, maxKeys = DEFAULT_MAX_KEYS, now = Date.now,
} = {}) {
  const seen = new Map();   // key -> expiry ms; Map keeps insertion order, so the first key is the oldest

  const safe = (fn) => { try { return fn(); } catch { /* fail-open: logging/auditing must never throw */ return undefined; } };
  const fail = (email, source, orders, error, reason, { record = true } = {}) => {
    const ids = orders.map(x => String(x.orderId)).filter(id => /^\d{1,20}$/.test(id));
    safe(() => log(`[payment-notice] ${reason || 'failed'} (${source}) orders ${ids.join(',') || '-'}: ${error}`));
    if (!record) return { status: 'failed', error };   // a caller bug (bad source / no actor): logged, not an operational failure
    safe(() => audit({
      email: email || 'system:payment-notice', action: 'payment_notice_failed',
      target: ids[0] ? `gid://shopify/Order/${ids[0]}` : null,
      after: { source, orderIds: ids, error },
    }));
    return { status: 'failed', error };
  };
  const prune = (t) => {
    for (const [k, exp] of seen) if (exp <= t) seen.delete(k);
    while (seen.size > maxKeys) seen.delete(seen.keys().next().value);
  };

  async function notify(input) {
    try {
      if (!enabled) return { status: 'disabled' };
      const source = input?.source;
      const actorEmail = typeof input?.actorEmail === 'string' ? input.actorEmail.trim() : '';
      const orders = Array.isArray(input?.orders) ? input.orders : [];
      if (!PAYMENT_NOTICE_SOURCES.includes(source)) return fail(actorEmail, String(source), orders, 'unknown source', 'refused', { record: false });
      if (!actorEmail) return fail(actorEmail, source, orders, 'no actor email', 'refused', { record: false });
      if (!orders.length) return { status: 'nothing' };

      const good = orders.filter(validOrder);
      const bad = orders.filter(x => !validOrder(x));
      if (bad.length) fail(actorEmail, source, bad, 'invalid order data (no usable id / amount / currency) - not announced', 'dropped');
      if (!good.length) return { status: 'failed', error: 'no valid orders' };

      const t = now();
      prune(t);
      const fresh = [];
      for (const x of good) {
        const key = paymentNoticeKey({ source, orderId: x.orderId, amount: x.amount });
        if (seen.has(key)) continue;       // also collapses a repeat of the same order inside one request
        seen.set(key, t + ttlMs);
        fresh.push({ orderId: String(x.orderId), orderName: x.orderName, amount: x.amount, currency: x.currency });
      }
      if (!fresh.length) return { status: 'duplicate' };

      const method = typeof input.paymentMethod === 'string' && input.paymentMethod.trim() ? input.paymentMethod.trim() : null;
      let sent = 0, skipped = null, failure = null;
      for (let i = 0; i < fresh.length; i += MAX_ORDERS) {
        const chunk = fresh.slice(i, i + MAX_ORDERS);
        const body = { source, actorEmail, ...(method ? { paymentMethod: method } : {}), orders: chunk };
        let reply;
        try { reply = await callPortal(body); }
        catch (err) { reply = { ok: false, error: String(err?.message || err) }; }
        if (reply?.ok && reply.email?.sent === true) sent += chunk.length;
        else if (reply?.ok && reply.email?.skipped) skipped = String(reply.email.skipped);
        else {
          const error = String(reply?.email?.error || reply?.error || (reply?.ok ? 'Portal reply did not confirm a send' : 'Portal call failed'));
          fail(actorEmail, source, chunk, error);
          failure = failure || error;
        }
      }
      if (failure) return { status: 'failed', error: failure };
      if (sent) return { status: 'sent', count: sent };
      return { status: 'skipped', reason: skipped };
    } catch (err) {
      // Belt and braces: nothing above should throw, but a payment must never see an exception from here.
      safe(() => log('[payment-notice] unexpected error:', String(err?.message || err)));
      return { status: 'failed', error: String(err?.message || err) };
    }
  }

  return { notify };
}
