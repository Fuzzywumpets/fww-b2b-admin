import assert from 'node:assert/strict';
import { HelcimApiError, HelcimConfigurationError, createCreditCardInvoice, helcimRequest } from '../helcim.mjs';

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
  const payload = {
    currency: 'USD', type: 'INVOICE', status: 'DUE', invoiceNumber: 'FWW-1001',
    lineItems: [{ description: 'Collar', quantity: 2, price: 50 }],
    shipping: { amount: 10, details: 'Shipping' }, tax: { amount: 5, details: 'Sales tax' },
  };
  const result = await createCreditCardInvoice({ payload, amountCents: 11500, currency: 'USD' }, {
    env: ENV,
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return jsonResponse({ invoiceId: 42, token: 'abc123', amount: 115 });
    },
  });
  assert.equal(captured.url, 'https://api.helcim.com/v2/invoices');
  assert.equal(captured.options.headers['api-token'], 'test-token');
  assert.equal('idempotency-key' in captured.options.headers, false, 'Invoice API must not receive undocumented payment idempotency headers');
  assert.deepEqual(JSON.parse(captured.options.body), payload);
  assert.deepEqual(result, {
    invoiceId: 42, invoiceNumber: 'FWW-1001', token: 'abc123',
    url: 'https://fuzzywumpets.myhelcim.com/order/?token=abc123', amount: 115, currency: 'USD',
  });
});

test('fails closed when Helcim omits the invoice token', async () => {
  await assert.rejects(
    createCreditCardInvoice({ payload: { currency: 'USD' }, amountCents: 1000, currency: 'USD' }, { env: ENV, fetchImpl: async () => jsonResponse({ invoiceId: 42 }) }),
    error => error instanceof HelcimApiError && error.outcomeUnknown,
  );
});

test('retries only explicit 429 rejections with a bounded delay budget', async () => {
  let calls = 0;
  const delays = [];
  const response = await helcimRequest('/invoices', {
    method: 'POST', body: { currency: 'USD' }, env: ENV,
    retry429DelaysMs: [10, 20], delayImpl: async ms => delays.push(ms),
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return new Response('not-json', { status: 429, headers: { 'content-type': 'application/json' } });
      if (calls < 3) return jsonResponse({}, { status: 429 });
      return jsonResponse({ ok: true }, { headers: { 'content-type': 'application/json', 'minute-limit-remaining': '7', 'hour-limit-remaining': '99' } });
    },
  });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.deepEqual(response.rateLimit, { minuteRemaining: '7', hourRemaining: '99' });
});

test('does not retry ambiguous mutating failures', async () => {
  let calls = 0;
  await assert.rejects(
    helcimRequest('/invoices', {
      method: 'POST', body: {}, env: ENV, retry429DelaysMs: [0, 0],
      fetchImpl: async () => { calls++; return jsonResponse({}, { status: 503 }); },
    }),
    error => error instanceof HelcimApiError && error.status === 503 && error.outcomeUnknown,
  );
  assert.equal(calls, 1);
});

test('caps this service at Helcim documented five concurrent calls', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let releaseFirstWave;
  const firstWave = new Promise(resolve => { releaseFirstWave = resolve; });
  const requests = Array.from({ length: 6 }, () => helcimRequest('/connection', {
    env: ENV,
    fetchImpl: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (inFlight === 5) releaseFirstWave();
      await firstWave;
      await new Promise(resolve => setImmediate(resolve));
      inFlight--;
      return jsonResponse({ ok: true });
    },
  }));
  await Promise.all(requests);
  assert.equal(maxInFlight, 5);
});

test('does not expose Helcim response data in errors', async () => {
  await assert.rejects(
    helcimRequest('/invoices', { env: ENV, fetchImpl: async () => jsonResponse({ cardNumber: '4111111111111111' }, { status: 401 }) }),
    error => error.message === 'Helcim API request failed with HTTP 401' && !error.message.includes('4111111111111111'),
  );
});

let failed = 0;
for (const { name, fn } of tests) {
  try { await fn(); console.log(`✓ ${name}`); }
  catch (error) { failed++; console.error(`✗ ${name}`); console.error(error); }
}
if (failed) process.exitCode = 1;
else console.log(`\n${tests.length} Helcim tests passed`);
