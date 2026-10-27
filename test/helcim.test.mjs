import assert from 'node:assert/strict';
import { HelcimApiError, HelcimConfigurationError, createCreditCardInvoice, getInvoice, helcimRequest } from '../helcim.mjs';

const ENV = { HELCIM_API_TOKEN: 'test-token', HELCIM_SUBDOMAIN_URL: 'https://fuzzywumpets.myhelcim.com' };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const jsonResponse = (data, init = {}) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

test('requires both Doppler settings', async () => {
  await assert.rejects(helcimRequest('/invoices', { env: {}, fetchImpl: assert.fail }), HelcimConfigurationError);
  await assert.rejects(helcimRequest('/invoices', { env: { HELCIM_API_TOKEN: 'x' }, fetchImpl: assert.fail }), HelcimConfigurationError);
});

test('rejects a non-Helcim invoice host', async () => {
  await assert.rejects(
    helcimRequest('/invoices', { env: { ...ENV, HELCIM_SUBDOMAIN_URL: 'https://attacker.example' }, fetchImpl: assert.fail }),
    HelcimConfigurationError,
  );
});

test('creates a DUE invoice for the exact balance and returns its online view', async () => {
  let captured;
  const result = await createCreditCardInvoice({ orderName: '#1001', amount: 123.456, currency: 'usd' }, {
    env: ENV,
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return jsonResponse({ invoiceId: 42, invoiceNumber: 'INV42', token: 'abc123' });
    },
  });
  assert.equal(captured.url, 'https://api.helcim.com/v2/invoices');
  assert.equal(captured.options.headers['api-token'], 'test-token');
  assert.deepEqual(JSON.parse(captured.options.body), {
    currency: 'USD', type: 'INVOICE', status: 'DUE',
    lineItems: [{ description: 'Balance due for Fuzzywumpets wholesale order #1001', quantity: 1, price: 123.46 }],
    notes: 'Fuzzywumpets wholesale order #1001',
  });
  assert.deepEqual(result, {
    invoiceId: 42, invoiceNumber: 'INV42', token: 'abc123',
    url: 'https://fuzzywumpets.myhelcim.com/order/?token=abc123', amount: 123.46, currency: 'USD',
    billingIncluded: false,
  });
});

// ── billingAddress on the invoice (Alex, 2026-10-27: the Helcim invoice shows no customer, only the order # in notes) ──
const BILLING = {
  name: 'Happy Paws Boutique LLC', street1: '456 Park Ave', city: 'Philadelphia', province: 'PA',
  country: 'USA', postalCode: '19103', email: 'orders@happypaws.com',
};
const OK_INVOICE = () => jsonResponse({ invoiceId: 42, invoiceNumber: 'INV42', token: 'abc123' });
const recorder = (replies) => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(JSON.parse(options.body));
    const next = replies[Math.min(calls.length - 1, replies.length - 1)];
    return typeof next === 'function' ? next() : next;
  };
  return { calls, fetchImpl };
};
const warnings = [];
const create = (extra, fetchImpl) => createCreditCardInvoice({ orderName: '#1001', amount: 10, currency: 'USD', ...extra }, { env: ENV, fetchImpl, warn: (m) => warnings.push(m) });

test('sends the billing address to Helcim and reports billingIncluded', async () => {
  const { calls, fetchImpl } = recorder([OK_INVOICE()]);
  const result = await create({ billingAddress: BILLING }, fetchImpl);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].billingAddress, BILLING);
  assert.equal(calls[0].notes, 'Fuzzywumpets wholesale order #1001', 'the order # note is unchanged');
  assert.equal(calls[0].lineItems.length, 1, 'still one balance-due line');
  assert.equal(result.billingIncluded, true);
});

test('omits an address that does not meet Helcim\'s required fields instead of sending a doomed request', async () => {
  for (const bad of [null, undefined, {}, { name: 'X', street1: '1 Main' }, { name: 'X', postalCode: '1' }, { street1: '1 Main', postalCode: '1' }, 'string', 5]) {
    const { calls, fetchImpl } = recorder([OK_INVOICE()]);
    const result = await create({ billingAddress: bad }, fetchImpl);
    assert.equal(calls.length, 1);
    assert.equal('billingAddress' in calls[0], false, `sent ${JSON.stringify(bad)}`);
    assert.equal(result.billingIncluded, false);
  }
});

test('Helcim rejecting the address (400 or 422) retries ONCE without it, so the invoice flow never regresses', async () => {
  for (const status of [400, 422]) {
    const { calls, fetchImpl } = recorder([jsonResponse({ errors: 'bad address' }, { status }), OK_INVOICE()]);
    const result = await create({ billingAddress: BILLING }, fetchImpl);
    assert.equal(calls.length, 2, `status ${status}`);
    assert.deepEqual(calls[0].billingAddress, BILLING);
    assert.equal('billingAddress' in calls[1], false);
    const { billingAddress: _drop, ...rest } = calls[0];
    assert.deepEqual(calls[1], rest, 'the retry is identical apart from the address');
    assert.equal(result.invoiceId, 42);
    assert.equal(result.billingIncluded, false);
  }
  assert.equal(warnings.length, 2, 'each fallback is announced');
  assert.ok(warnings.every(w => !w.includes('Park Ave') && !w.includes('happypaws')), 'the warning never carries the address');
});

test('never retries a failure that may have created the invoice (401, 429, 500, timeout, network)', async () => {
  for (const reply of [jsonResponse({}, { status: 401 }), jsonResponse({}, { status: 429 }), jsonResponse({}, { status: 500 }), () => { throw new Error('socket hang up'); }]) {
    const { calls, fetchImpl } = recorder([reply, OK_INVOICE()]);
    await assert.rejects(create({ billingAddress: BILLING }, fetchImpl), HelcimApiError);
    assert.equal(calls.length, 1, 'a non-validation failure must not trigger a second invoice');
  }
});

test('the company name is appended to the invoice notes (order # text stays first and unchanged)', async () => {
  const { calls, fetchImpl } = recorder([OK_INVOICE()]);
  await create({ companyName: 'Happy Paws Boutique LLC' }, fetchImpl);
  assert.equal(calls[0].notes, 'Fuzzywumpets wholesale order #1001 - Happy Paws Boutique LLC');
  assert.equal(calls[0].lineItems[0].description, 'Balance due for Fuzzywumpets wholesale order #1001', 'line item untouched');
  assert.equal('billingAddress' in calls[0], false, 'works with no address at all');
});

test('the company is still on the invoice when Helcim refuses the address and the retry drops it', async () => {
  const { calls, fetchImpl } = recorder([jsonResponse({}, { status: 422 }), OK_INVOICE()]);
  await create({ billingAddress: BILLING, companyName: 'Happy Paws Boutique LLC' }, fetchImpl);
  assert.equal(calls.length, 2);
  assert.equal('billingAddress' in calls[1], false);
  assert.equal(calls[1].notes, 'Fuzzywumpets wholesale order #1001 - Happy Paws Boutique LLC');
});

test('a missing, blank or non-string company leaves the notes exactly as before', async () => {
  for (const companyName of [undefined, null, '', '   ', 42, { a: 1 }, ['x']]) {
    const { calls, fetchImpl } = recorder([OK_INVOICE()]);
    await create({ companyName }, fetchImpl);
    assert.equal(calls[0].notes, 'Fuzzywumpets wholesale order #1001', `companyName=${JSON.stringify(companyName)}`);
  }
});

test('the company name is flattened to one line and capped at 120 characters', async () => {
  const { calls, fetchImpl } = recorder([OK_INVOICE(), OK_INVOICE()]);
  await create({ companyName: '  Happy\nPaws\t\tBoutique ' }, fetchImpl);
  assert.equal(calls[0].notes, 'Fuzzywumpets wholesale order #1001 - Happy Paws Boutique');
  await create({ companyName: 'x'.repeat(500) }, fetchImpl);
  assert.equal(calls[1].notes, `Fuzzywumpets wholesale order #1001 - ${'x'.repeat(120)}`);
});

test('a 400 with no address to drop is not retried', async () => {
  const { calls, fetchImpl } = recorder([jsonResponse({}, { status: 400 }), OK_INVOICE()]);
  await assert.rejects(create({}, fetchImpl), error => error instanceof HelcimApiError && error.status === 400);
  assert.equal(calls.length, 1);
});

test('if the retry without the address also fails, that failure is what the caller sees (two attempts, no more)', async () => {
  const { calls, fetchImpl } = recorder([jsonResponse({}, { status: 400 }), jsonResponse({}, { status: 500 })]);
  await assert.rejects(create({ billingAddress: BILLING }, fetchImpl), error => error instanceof HelcimApiError && error.status === 500);
  assert.equal(calls.length, 2);
});

test('fails closed when Helcim omits the invoice token', async () => {
  await assert.rejects(
    createCreditCardInvoice({ orderName: '#1001', amount: 10, currency: 'USD' }, { env: ENV, fetchImpl: async () => jsonResponse({ invoiceId: 42 }) }),
    HelcimApiError,
  );
});

test('does not expose Helcim response data in errors', async () => {
  await assert.rejects(
    helcimRequest('/invoices', { env: ENV, fetchImpl: async () => jsonResponse({ cardNumber: '4111111111111111' }, { status: 401 }) }),
    error => error.message === 'Helcim API request failed with HTTP 401' && !error.message.includes('4111111111111111'),
  );
});

// ── getInvoice: read-only status lookup used by the paid-sync (lib/helcim-reconcile.mjs) ──────────────────
const PAID_BODY = {
  invoiceId: 73759349, invoiceNumber: 'INV001002', status: 'PAID', type: 'INVOICE', currency: 'USD',
  amount: 1, amountPaid: 1, amountDue: 0, datePaid: '2026-10-26 16:07:40',
  billingAddress: ['SECRET STREET'], customerId: 99, token: 'secret-online-token', notes: 'customer note',
};

test('getInvoice GETs the numeric invoice id and returns ONLY the status/money fields', async () => {
  let captured;
  const inv = await getInvoice(73759349, {
    env: ENV,
    fetchImpl: async (url, options) => { captured = { url: String(url), options }; return jsonResponse(PAID_BODY); },
  });
  assert.equal(captured.url, 'https://api.helcim.com/v2/invoices/73759349');
  assert.equal(captured.options.method, 'GET');
  assert.equal(captured.options.headers['api-token'], 'test-token');
  assert.equal(captured.options.body, undefined);
  assert.deepEqual(inv, {
    invoiceId: '73759349', invoiceNumber: 'INV001002', status: 'PAID', amount: 1, amountPaid: 1, amountDue: 0,
    currency: 'USD', datePaid: '2026-10-26 16:07:40',
  });
});

test('getInvoice unwraps an { invoice } envelope, upper-cases status/currency and nulls the zero datePaid', async () => {
  const inv = await getInvoice('73767296', {
    env: ENV,
    fetchImpl: async () => jsonResponse({ invoice: { ...PAID_BODY, invoiceId: 73767296, status: 'due', currency: 'usd', amountPaid: 0, amountDue: 1, datePaid: '0000-00-00 00:00:00' } }),
  });
  assert.equal(inv.status, 'DUE');
  assert.equal(inv.currency, 'USD');
  assert.equal(inv.datePaid, null);
  assert.equal(inv.amountDue, 1);
});

test('getInvoice rejects anything but a plain numeric invoice id BEFORE any network call', async () => {
  for (const bad of ['', 'abc', '../customers', '1/../2', '12 3', '1?x=1', null, undefined, {}, -5, 1.5]) {
    await assert.rejects(getInvoice(bad, { env: ENV, fetchImpl: assert.fail }), TypeError, `accepted ${JSON.stringify(bad)}`);
  }
});

test('getInvoice fails closed on a response it cannot trust (never invents "paid")', async () => {
  const cases = {
    'missing status': { ...PAID_BODY, status: undefined },
    'string amount': { ...PAID_BODY, amount: 'one' },
    'missing amountPaid': { ...PAID_BODY, amountPaid: undefined },
    'NaN amountDue': { ...PAID_BODY, amountDue: null },
    'unknown currency': { ...PAID_BODY, currency: 'EUR' },
    'different invoice id': { ...PAID_BODY, invoiceId: 5 },
  };
  for (const [label, body] of Object.entries(cases)) {
    await assert.rejects(
      getInvoice(73759349, { env: ENV, fetchImpl: async () => jsonResponse(body) }),
      error => error instanceof HelcimApiError && !String(error.message).includes('SECRET'),
      label,
    );
  }
});

test('getInvoice surfaces an HTTP failure as HelcimApiError without the body', async () => {
  await assert.rejects(
    getInvoice(1, { env: ENV, fetchImpl: async () => jsonResponse({ cardNumber: '4111111111111111' }, { status: 404 }) }),
    error => error instanceof HelcimApiError && error.status === 404 && !error.message.includes('4111'),
  );
});

let failed = 0;
for (const { name, fn } of tests) {
  try { await fn(); console.log(`✓ ${name}`); }
  catch (error) { failed++; console.error(`✗ ${name}`); console.error(error); }
}
if (failed) process.exitCode = 1;
else console.log(`\n${tests.length} Helcim tests passed`);
