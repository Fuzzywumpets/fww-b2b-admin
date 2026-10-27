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
  });
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
