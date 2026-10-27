// Standalone unit suite for lib/payment-notice.mjs (no server, no network, no DB): the Admin half of the
// "payment received" email Alex asked for on 2026-10-27. The Portal owns the Gmail send; this module decides WHAT is
// sent, WHEN (never before the payment succeeded - that is the call sites' job, pinned in payment-notice-routes.test.mjs),
// and guarantees it can never block, fail or double-send a payment.
import assert from 'node:assert/strict';
import {
  PAYMENT_NOTICE_SOURCES, MAX_ORDERS, createPaymentNotifier, orderNoticeFields, paymentNoticeKey,
} from '../lib/payment-notice.mjs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${err.stack?.split('\n').slice(0, 4).join('\n      ') || err.message}`); failed++; }
}

const SAM = 'sam@fuzzywumpets.com';
const o = (id, amount = 10, over = {}) => ({ orderId: String(id), orderName: `#${id}`, amount, currency: 'USD', ...over });

// A notifier wired to recorders. `reply` is what the (fake) Portal answers; a function for per-call control.
function rig({ reply = { ok: true, email: { sent: true, via: 'gmail', id: 'm1' } }, ...opts } = {}) {
  const portalCalls = [], audits = [], logs = [];
  let t = 1_000_000;
  const notifier = createPaymentNotifier({
    callPortal: async (body) => {
      portalCalls.push(body);
      const r = typeof reply === 'function' ? await reply(body, portalCalls.length) : reply;
      if (r instanceof Error) throw r;
      return r;
    },
    audit: (row) => audits.push(row),
    log: (...args) => logs.push(args.join(' ')),
    now: () => t,
    ...opts,
  });
  return { notifier, portalCalls, audits, logs, tick: (ms) => { t += ms; } };
}

console.log('\n  lib/payment-notice.mjs');

await test('the three staff sources are exactly the ones the Portal accepts', () => {
  assert.deepEqual([...PAYMENT_NOTICE_SOURCES], ['mark_paid_bulk', 'mark_paid', 'record_payment']);
  assert.equal(MAX_ORDERS, 250);
});

await test('payload: exactly { source, actorEmail, orders[, paymentMethod] } - never a recipient, subject or link', async () => {
  const r = rig();
  const out = await r.notifier.notify({ source: 'record_payment', actorEmail: ` ${SAM} `, paymentMethod: 'Cheque #7', orders: [o(40001, 12.5)] });
  assert.equal(out.status, 'sent');
  assert.equal(r.portalCalls.length, 1);
  assert.deepEqual(r.portalCalls[0], {
    source: 'record_payment', actorEmail: SAM, paymentMethod: 'Cheque #7',
    orders: [{ orderId: '40001', orderName: '#40001', amount: 12.5, currency: 'USD' }],
  });
  const keys = Object.keys(r.portalCalls[0]).concat(Object.keys(r.portalCalls[0].orders[0]));
  assert.ok(!keys.some(k => /^(to|recipient|cc|bcc|subject|from)$|url|token|link/i.test(k)), keys.join(','));
  assert.equal(r.audits.length, 0, 'a delivered notice writes no failure row');
});

await test('payload: paymentMethod is omitted unless given; a bulk call is ONE request with every order (digest)', async () => {
  const r = rig();
  await r.notifier.notify({ source: 'mark_paid_bulk', actorEmail: SAM, orders: [o(1), o(2), o(3)] });
  assert.equal(r.portalCalls.length, 1, 'one digest, not N mails');
  assert.equal(r.portalCalls[0].orders.length, 3);
  assert.ok(!('paymentMethod' in r.portalCalls[0]));
});

await test('more than 250 orders are split into several requests rather than lost or rejected', async () => {
  const r = rig();
  const orders = Array.from({ length: 251 }, (_, i) => o(50000 + i));
  const out = await r.notifier.notify({ source: 'mark_paid_bulk', actorEmail: SAM, orders });
  assert.equal(out.status, 'sent');
  assert.deepEqual(r.portalCalls.map(c => c.orders.length), [250, 1]);
});

await test('Portal says "skipped" (the staff member is the recipient): status skipped, NOT a failure, no audit row', async () => {
  const r = rig({ reply: { ok: true, email: { sent: false, skipped: 'actor_is_recipient' } } });
  const out = await r.notifier.notify({ source: 'mark_paid', actorEmail: 'alex@fuzzywumpets.com', orders: [o(1)] });
  assert.deepEqual(out, { status: 'skipped', reason: 'actor_is_recipient' });
  assert.equal(r.audits.length, 0);
  assert.equal(r.logs.length, 0);
});

await test('FAIL-OPEN: every kind of Portal failure resolves (never throws), logs, and audits payment_notice_failed', async () => {
  const replies = [
    { ok: false, error: 'no_internal_token' },
    { ok: false, email: { sent: false, error: 'Gmail send failed (HTTP 500)' } },
    { ok: true, email: { sent: false, error: 'Gmail send failed (HTTP 500)' } },
    { ok: true },                                    // a reply that does not say the mail went out is NOT success
    { ok: true, email: { sent: false } },
    new Error('connect ECONNREFUSED 127.0.0.1:8793'),
    new Error('The operation was aborted due to timeout'),
  ];
  for (const reply of replies) {
    const r = rig({ reply });
    const out = await r.notifier.notify({ source: 'mark_paid', actorEmail: SAM, orders: [o(40001, 5)] });
    assert.equal(out.status, 'failed', JSON.stringify(reply));
    assert.ok(out.error && typeof out.error === 'string');
    assert.equal(r.audits.length, 1, 'one failure row per failed request');
    assert.deepEqual(r.audits[0], {
      email: SAM, action: 'payment_notice_failed', target: 'gid://shopify/Order/40001',
      after: { source: 'mark_paid', orderIds: ['40001'], error: out.error },
    });
    assert.ok(r.logs.some(l => l.includes('40001')), 'also logged');
  }
});

await test('FAIL-OPEN: an audit or log that itself throws still cannot make notify() throw', async () => {
  const r = rig({ reply: new Error('down'), audit: () => { throw new Error('db locked'); }, log: () => { throw new Error('stderr closed'); } });
  const out = await r.notifier.notify({ source: 'mark_paid', actorEmail: SAM, orders: [o(1)] });
  assert.equal(out.status, 'failed');
});

await test('IDEMPOTENT: the same order + source + amount twice (double click / retry) sends ONE mail', async () => {
  const r = rig();
  const a = await r.notifier.notify({ source: 'mark_paid', actorEmail: SAM, orders: [o(1, 10)] });
  const b = await r.notifier.notify({ source: 'mark_paid', actorEmail: SAM, orders: [o(1, 10)] });
  assert.equal(a.status, 'sent');
  assert.equal(b.status, 'duplicate');
  assert.equal(r.portalCalls.length, 1);
});

await test('IDEMPOTENT: two overlapping requests (a real double click) send once - the key is taken BEFORE the Portal call', async () => {
  let release;
  const gate = new Promise(res => { release = res; });
  const r = rig({ reply: async () => { await gate; return { ok: true, email: { sent: true } }; } });
  const first = r.notifier.notify({ source: 'mark_paid', actorEmail: SAM, orders: [o(1, 10)] });
  const second = r.notifier.notify({ source: 'mark_paid', actorEmail: SAM, orders: [o(1, 10)] });
  release();
  const out = await Promise.all([first, second]);
  assert.deepEqual(out.map(x => x.status).sort(), ['duplicate', 'sent']);
  assert.equal(r.portalCalls.length, 1);
});

await test('IDEMPOTENT: a different amount, a different source or a different order is a different payment', async () => {
  const r = rig();
  await r.notifier.notify({ source: 'record_payment', actorEmail: SAM, orders: [o(1, 10)] });
  assert.equal((await r.notifier.notify({ source: 'record_payment', actorEmail: SAM, orders: [o(1, 10.01)] })).status, 'sent');
  assert.equal((await r.notifier.notify({ source: 'mark_paid', actorEmail: SAM, orders: [o(1, 10)] })).status, 'sent');
  assert.equal((await r.notifier.notify({ source: 'record_payment', actorEmail: SAM, orders: [o(2, 10)] })).status, 'sent');
  assert.equal(r.portalCalls.length, 4);
});

await test('IDEMPOTENT: a digest that overlaps an earlier one only mails the orders not yet announced', async () => {
  const r = rig();
  await r.notifier.notify({ source: 'mark_paid_bulk', actorEmail: SAM, orders: [o(1), o(2)] });
  const out = await r.notifier.notify({ source: 'mark_paid_bulk', actorEmail: SAM, orders: [o(2), o(3)] });
  assert.equal(out.status, 'sent');
  assert.deepEqual(r.portalCalls[1].orders.map(x => x.orderId), ['3']);
  assert.equal((await r.notifier.notify({ source: 'mark_paid_bulk', actorEmail: SAM, orders: [o(1), o(3)] })).status, 'duplicate');
});

await test('IDEMPOTENT: the key expires (default 15 min) so a genuine second payment of the same amount later is announced', async () => {
  const r = rig();
  await r.notifier.notify({ source: 'record_payment', actorEmail: SAM, orders: [o(1, 500)] });
  r.tick(14 * 60_000);
  assert.equal((await r.notifier.notify({ source: 'record_payment', actorEmail: SAM, orders: [o(1, 500)] })).status, 'duplicate');
  r.tick(2 * 60_000);
  assert.equal((await r.notifier.notify({ source: 'record_payment', actorEmail: SAM, orders: [o(1, 500)] })).status, 'sent');
});

await test('IDEMPOTENT: a FAILED send is not re-sent by a double click either (at most once; the audit row is the record)', async () => {
  const r = rig({ reply: { ok: false, error: 'boom' } });
  assert.equal((await r.notifier.notify({ source: 'mark_paid', actorEmail: SAM, orders: [o(1)] })).status, 'failed');
  assert.equal((await r.notifier.notify({ source: 'mark_paid', actorEmail: SAM, orders: [o(1)] })).status, 'duplicate');
  assert.equal(r.portalCalls.length, 1);
});

await test('the seen-key memory is bounded (oldest keys are forgotten past maxKeys)', async () => {
  const r = rig({ maxKeys: 3 });
  for (let i = 1; i <= 5; i++) await r.notifier.notify({ source: 'mark_paid', actorEmail: SAM, orders: [o(i)] });
  assert.equal((await r.notifier.notify({ source: 'mark_paid', actorEmail: SAM, orders: [o(5)] })).status, 'duplicate', 'newest is remembered');
  assert.equal((await r.notifier.notify({ source: 'mark_paid', actorEmail: SAM, orders: [o(1)] })).status, 'sent', 'oldest was dropped');
});

await test('disabled (kill switch / MOCK): no Portal call, no audit, status disabled', async () => {
  const r = rig({ enabled: false });
  assert.deepEqual(await r.notifier.notify({ source: 'mark_paid', actorEmail: SAM, orders: [o(1)] }), { status: 'disabled' });
  assert.equal(r.portalCalls.length, 0);
  assert.equal(r.audits.length, 0);
});

await test('bad input never reaches the Portal: unknown source / no actor / no orders are refused; bad orders are dropped and audited', async () => {
  const r = rig();
  for (const bad of [
    { source: 'paid_sync', actorEmail: SAM, orders: [o(1)] },
    { source: 'mark_paid', actorEmail: '', orders: [o(1)] },
    { source: 'mark_paid', actorEmail: SAM, orders: [] },
    { source: 'mark_paid', actorEmail: SAM },
    null,
  ]) {
    const out = await r.notifier.notify(bad);
    assert.ok(['failed', 'nothing'].includes(out.status), JSON.stringify(bad) + ' -> ' + out.status);
  }
  assert.equal(r.portalCalls.length, 0);
  const mixed = await r.notifier.notify({
    source: 'mark_paid_bulk', actorEmail: SAM,
    orders: [o(1), o('abc'), o(2, -5), o(3, Number.NaN), o(4, 5, { currency: 'usd' }), o(5, null)],
  });
  assert.equal(mixed.status, 'sent');
  assert.deepEqual(r.portalCalls[0].orders.map(x => x.orderId), ['1'], 'only the one fully valid order is announced');
  const dropped = r.audits.filter(a => a.action === 'payment_notice_failed');
  assert.equal(dropped.length, 1, 'the dropped orders are recorded together, not silently lost');
  assert.deepEqual(dropped[0].after.orderIds.sort(), ['2', '3', '4', '5']);
  assert.match(dropped[0].after.error, /invalid/i);
});

console.log('\n  orderNoticeFields (Shopify payload -> notice order)');

await test('reads name + the CURRENT total (post-edit truth, presentment money) from the orderMarkAsPaid payload', () => {
  const f = orderNoticeFields('40001', {
    id: 'gid://shopify/Order/40001', name: '#40001', displayFinancialStatus: 'PAID',
    totalPriceSet: { presentmentMoney: { amount: '921.72', currencyCode: 'USD' } },
    currentTotalPriceSet: { presentmentMoney: { amount: '601.24', currencyCode: 'USD' } },
  });
  assert.deepEqual(f, { orderId: '40001', orderName: '#40001', amount: 601.24, currency: 'USD' });
});

await test('missing / malformed money yields amount NaN-free null so the notifier can drop-and-audit instead of announcing $0', () => {
  for (const order of [null, {}, { name: '#1' }, { name: '#1', currentTotalPriceSet: { presentmentMoney: { amount: 'x', currencyCode: 'USD' } } },
    { name: '#1', currentTotalPriceSet: { presentmentMoney: { amount: '5', currencyCode: 'usd' } } }]) {
    const f = orderNoticeFields('1', order);
    assert.equal(f.orderId, '1');
    assert.equal(f.amount, null, JSON.stringify(order));
  }
  assert.equal(orderNoticeFields('1', { currentTotalPriceSet: { presentmentMoney: { amount: '5', currencyCode: 'USD' } } }).orderName, '#1', 'name falls back to #id');
});

await test('paymentNoticeKey: order + source + amount in cents', () => {
  assert.equal(paymentNoticeKey({ source: 'mark_paid', orderId: '7', amount: 10.005 }), paymentNoticeKey({ source: 'mark_paid', orderId: '7', amount: 10.005 }));
  assert.notEqual(paymentNoticeKey({ source: 'mark_paid', orderId: '7', amount: 10 }), paymentNoticeKey({ source: 'record_payment', orderId: '7', amount: 10 }));
  assert.notEqual(paymentNoticeKey({ source: 'mark_paid', orderId: '7', amount: 10 }), paymentNoticeKey({ source: 'mark_paid', orderId: '7', amount: 10.01 }));
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
