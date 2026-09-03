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

let failed = 0;
for (const { name, fn } of tests) {
  try { await fn(); console.log(`✓ ${name}`); }
  catch (error) { failed++; console.error(`✗ ${name}`); console.error(error); }
}
if (failed) process.exitCode = 1;
else console.log(`\n${tests.length} Helcim tests passed`);
