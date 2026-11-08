import { HELCIM_BILLING_KEYS, cleanBillingText } from './lib/helcim-billing.mjs';

const HELCIM_API_BASE_URL = 'https://api.helcim.com/v2/';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_429_DELAYS_MS = [1_000, 2_000];
const HELCIM_CONCURRENT_LIMIT = 5;
let helcimCallsInFlight = 0;
const helcimCallWaiters = [];

async function acquireHelcimCallSlot() {
  if (helcimCallsInFlight >= HELCIM_CONCURRENT_LIMIT) {
    await new Promise(resolve => helcimCallWaiters.push(resolve));
  }
  helcimCallsInFlight++;
  return () => {
    helcimCallsInFlight--;
    helcimCallWaiters.shift()?.();
  };
}

export class HelcimConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HelcimConfigurationError';
  }
}

export class HelcimApiError extends Error {
  constructor(message, { status = null, outcomeUnknown = false } = {}) {
    super(message);
    this.name = 'HelcimApiError';
    this.status = status;
    this.outcomeUnknown = outcomeUnknown;
  }
}

function readConfig(env) {
  // DEPENDS: docs/B2B-ARCHITECTURE.md documents these exact Doppler keys.
  const token = env.HELCIM_API_TOKEN?.trim();
  const subdomainUrl = env.HELCIM_SUBDOMAIN_URL?.trim();
  if (!token) throw new HelcimConfigurationError('HELCIM_API_TOKEN is not configured');
  if (!subdomainUrl) throw new HelcimConfigurationError('HELCIM_SUBDOMAIN_URL is not configured');

  let parsed;
  try { parsed = new URL(subdomainUrl); } catch { throw new HelcimConfigurationError('HELCIM_SUBDOMAIN_URL is invalid'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname.endsWith('.myhelcim.com')) {
    throw new HelcimConfigurationError('HELCIM_SUBDOMAIN_URL must be an https://*.myhelcim.com URL');
  }
  return { token, subdomainUrl: `${parsed.origin}/` };
}

function createTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
}

// WHAT: fixed-host, server-side Helcim v2 request primitive; the API token is read per request so a Doppler rotation needs no module reload.
// CHANGE-GUARD: paths must stay code-owned and root-relative; errors intentionally omit Helcim response bodies because they can contain customer/payment data.
// INVARIANT(S): the api-token header can never be overridden by a caller and the token is never returned.
export async function helcimRequest(path, {
  method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS,
  retry429DelaysMs = [], delayImpl = ms => new Promise(resolve => setTimeout(resolve, ms)),
  env = process.env, fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw new TypeError('Helcim API path must be root-relative');
  }
  const { token } = readConfig(env);
  const requestUrl = new URL(path.slice(1), HELCIM_API_BASE_URL);
  if (!requestUrl.pathname.startsWith('/v2/')) throw new TypeError('Helcim API path must remain under /v2');
  const mutating = !['GET', 'HEAD'].includes(String(method).toUpperCase());
  for (let attempt = 0; ; attempt++) {
    const timeout = createTimeoutSignal(timeoutMs);
    const releaseSlot = await acquireHelcimCallSlot();
    try {
      const response = await fetchImpl(requestUrl, {
        method,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'api-token': token },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: timeout.signal,
      });
      if (!response.ok) {
        if (response.status === 429 && attempt < retry429DelaysMs.length) {
          await delayImpl(retry429DelaysMs[attempt]);
          continue;
        }
        throw new HelcimApiError(`Helcim API request failed with HTTP ${response.status}`, {
          status: response.status,
          outcomeUnknown: mutating && response.status >= 500,
        });
      }
      const contentType = response.headers.get('content-type') || '';
      const data = contentType.includes('application/json') ? await response.json() : await response.text();
      return {
        status: response.status,
        data,
        rateLimit: {
          minuteRemaining: response.headers.get('minute-limit-remaining'),
          hourRemaining: response.headers.get('hour-limit-remaining'),
        },
      };
    } catch (error) {
      if (error instanceof HelcimApiError) throw error;
      if (timeout.signal.aborted) throw new HelcimApiError('Helcim API request timed out', { outcomeUnknown: mutating });
      throw new HelcimApiError('Helcim API request failed', { outcomeUnknown: mutating });
    } finally {
      timeout.cleanup();
      releaseSlot();
    }
  }
}

// WHAT: read-only lookup of ONE Helcim invoice's payment status, reduced to the fields the paid-sync needs.
// CHANGE-GUARD: returns ONLY { invoiceId, invoiceNumber, status, amount, amountPaid, amountDue, currency, datePaid } — never the
// online-view token, billing address, notes or customer id, so a caller can log/audit the result without leaking payment data.
// A response it cannot fully trust throws (fails closed): this feeds a decision to mark a Shopify order PAID, so a missing or
// non-numeric field must never be read as "paid". datePaid is Helcim's naive account-local timestamp, informational only.
// INVARIANT(S): invoiceId must be a plain non-negative integer (checked before any request, so it can never alter the URL path);
// the id Helcim echoes back must equal the id requested; status/currency are upper-cased; '0000-00-00 00:00:00' => null.
// DEPENDS: lib/helcim-reconcile.mjs assessInvoice() consumes exactly this shape.
export async function getInvoice(invoiceId, options = {}) {
  const id = typeof invoiceId === 'number' ? (Number.isSafeInteger(invoiceId) && invoiceId >= 0 ? String(invoiceId) : '') : String(invoiceId ?? '');
  if (!/^[0-9]{1,20}$/.test(id)) throw new TypeError('Helcim invoice id must be a plain numeric id');

  const response = await helcimRequest(`/invoices/${id}`, { ...options, method: 'GET', body: undefined });
  const invoice = response.data?.invoice || response.data;
  if (!invoice || typeof invoice !== 'object') throw new HelcimApiError('Helcim invoice response was not an invoice');
  if (invoice.invoiceId !== undefined && String(invoice.invoiceId) !== id) throw new HelcimApiError('Helcim invoice response was for a different invoice');

  const status = typeof invoice.status === 'string' ? invoice.status.trim().toUpperCase() : '';
  const currency = typeof invoice.currency === 'string' ? invoice.currency.trim().toUpperCase() : '';
  const money = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : NaN);
  const amount = money(invoice.amount), amountPaid = money(invoice.amountPaid), amountDue = money(invoice.amountDue);
  if (!status) throw new HelcimApiError('Helcim invoice response was missing a status');
  if (![amount, amountPaid, amountDue].every(Number.isFinite)) throw new HelcimApiError('Helcim invoice response had a missing or non-numeric amount');
  if (!['USD', 'CAD'].includes(currency)) throw new HelcimApiError('Helcim invoice response had an unsupported currency');

  const paidOn = typeof invoice.datePaid === 'string' ? invoice.datePaid.trim() : '';
  return {
    invoiceId: id,
    invoiceNumber: invoice.invoiceNumber ? String(invoice.invoiceNumber) : null,
    status, amount, amountPaid, amountDue, currency,
    datePaid: paidOn && !paidOn.startsWith('0000-00-00') ? paidOn : null,
  };
}


// WHAT: creates one DUE Helcim invoice and returns its customer-payable online view. Reconciled 2026-11-08 from two lineages,
//   so it accepts two body shapes:
//   - BALANCE DUE (production since 2026-10-26, the default): `{ orderName, amount, currency }` -> one "Balance due" line for the
//     exact outstanding amount, so partially paid and edited orders bill only what is still owed.
//   - ITEMIZED (main PR #38, opt-in): `{ payload, amountCents, currency }` where `payload` is the pre-validated, exactly reconciled
//     body from lib/helcim-invoice-payload.mjs buildHelcimInvoicePayload. The route only takes this path when
//     HELCIM_ITEMIZED_INVOICES=1 AND the order reconciles; it is the shape main shipped and has never run against live Helcim.
// CHANGE-GUARD: Invoice API POSTs have no documented idempotency-key support. Only explicit 429 responses are retried (both shapes);
//   timeouts, network errors, malformed successes, and 5xx responses are outcome-unknown and must stay blocked by the caller's
//   durable creation claim (db.mjs helcim_invoice_claims).
// BILLING: an optional `billingAddress` (lib/helcim-billing.mjs buildHelcimBillingAddress) puts the customer's name, address and
//   email on the invoice; on the itemized shape it REPLACES the payload's own billingAddress (production's builder normalises
//   province/country the way Helcim accepts). It is whitelisted to HELCIM_BILLING_KEYS and omitted unless name+street1+postalCode
//   are present. If Helcim answers 400/422 while an address is attached, the invoice is retried ONCE without any address
//   (billingAddress and shipping.address), because the address is cosmetic and must never stop a card invoice going out; those two
//   statuses mean Helcim validated and refused the request, so no invoice exists to duplicate. Every other failure (401, 429 after
//   its retries, 5xx, timeout, network) may have created the invoice and is NOT retried. Resolves with `billingIncluded`.
// COMPANY: an optional `companyName` is also appended to the invoice notes ("Fuzzywumpets wholesale order #1234 - Acme Pet Supply"),
//   so the company is on the invoice even when the billing address is incomplete or Helcim refuses it (Alex, 2026-10-27: "make sure
//   that is company name, somewhere"). Nothing parses these notes (the paid-sync matches by invoice id/number), but keep the leading
//   "Fuzzywumpets wholesale order <name>" text stable.
// INVARIANT(S): amount is positive, currency is USD/CAD (and equals payload.currency on the itemized shape); a response without
//   invoiceId+token, or with an amount other than the one requested, fails closed (outcomeUnknown) before any email is sent and
//   never leaks the response body.
// DEPENDS: server.mjs POST /orders/:id/send-credit-card-invoice picks the shape (helcimInvoiceMode) and passes `billingAddress` +
//   `companyName` (order.customer.company, resolved by getOrderDetail); it surfaces `billingIncluded`.
export async function createCreditCardInvoice({ payload, amountCents: itemizedCents, orderName, amount, currency, billingAddress, companyName } = {}, options = {}) {
  const normalizedCurrency = String(currency || '').toUpperCase();
  const { warn = console.error, ...requestOptions } = options;
  const company = cleanBillingText(companyName).slice(0, 120).trim();
  let body;
  let amountCents;
  if (payload !== undefined) {
    if (!payload || typeof payload !== 'object') throw new TypeError('Validated invoice payload is required');
    if (!Number.isSafeInteger(itemizedCents) || itemizedCents <= 0) throw new TypeError('Invoice amount must be greater than zero');
    if (!['USD', 'CAD'].includes(normalizedCurrency) || payload.currency !== normalizedCurrency) {
      throw new TypeError('Invoice currency must be USD or CAD and match the validated payload');
    }
    amountCents = itemizedCents;
    body = { ...payload };
    if (company && typeof body.notes === 'string') body.notes = `${body.notes} - ${company}`;
  } else {
    const normalizedAmount = Math.round(Number(amount) * 100) / 100;
    if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) throw new TypeError('Invoice amount must be greater than zero');
    if (!['USD', 'CAD'].includes(normalizedCurrency)) throw new TypeError('Invoice currency must be USD or CAD');
    amountCents = Math.round(normalizedAmount * 100);
    const orderNote = `Fuzzywumpets wholesale order ${String(orderName || '').trim()}`.trim();
    body = {
      currency: normalizedCurrency,
      type: 'INVOICE',
      status: 'DUE',
      lineItems: [{
        description: `Balance due for Fuzzywumpets wholesale order ${String(orderName || '').trim()}`.trim(),
        quantity: 1,
        price: normalizedAmount,
      }],
      notes: company ? `${orderNote} - ${company}` : orderNote,
    };
  }
  const billing = pickBillingAddress(billingAddress);
  if (billing) body.billingAddress = billing;
  const hasAddress = !!body.billingAddress || !!body.shipping?.address;
  const post = (requestBody) => helcimRequest('/invoices', {
    ...requestOptions,
    method: 'POST',
    retry429DelaysMs: requestOptions.retry429DelaysMs || DEFAULT_429_DELAYS_MS,
    body: requestBody,
  });

  let response;
  let billingIncluded = false;
  if (hasAddress) {
    try {
      response = await post(body);
      billingIncluded = !!body.billingAddress;
    } catch (error) {
      if (!(error instanceof HelcimApiError) || ![400, 422].includes(error.status)) throw error;
      warn(`Helcim refused the invoice billing address (HTTP ${error.status}); creating the invoice without it`);
      delete body.billingAddress;
      if (body.shipping?.address) {
        const { address: _dropped, ...shipping } = body.shipping;
        body.shipping = shipping;
      }
    }
  }
  if (!response) response = await post(body);
  const invoice = response.data?.invoice || response.data;
  if (!invoice?.invoiceId || !invoice?.token) {
    throw new HelcimApiError('Helcim invoice response was missing invoiceId or token', { outcomeUnknown: true });
  }
  if (invoice.amount != null && Math.round(Number(invoice.amount) * 100) !== amountCents) {
    throw new HelcimApiError('Helcim created an invoice with an unexpected amount', { outcomeUnknown: true });
  }
  const { subdomainUrl } = readConfig(options.env || process.env);
  const url = new URL('/order/', subdomainUrl);
  url.searchParams.set('token', String(invoice.token));
  return {
    invoiceId: invoice.invoiceId,
    // DEPENDS: Portal's public HelcimPay session links the payment to this exact invoice number.
    // Helcim may omit it from a create response, so retain the validated request value.
    invoiceNumber: invoice.invoiceNumber || body.invoiceNumber || null,
    token: String(invoice.token),
    url: url.toString(),
    amount: amountCents / 100,
    currency: normalizedCurrency,
    billingIncluded,
  };
}

// Keeps only documented Address keys with non-empty string values and requires Helcim's three mandatory fields; anything
// else (null, a string, a partial object) is "no address" so the request is never one Helcim would reject outright.
function pickBillingAddress(address) {
  if (!address || typeof address !== 'object') return null;
  const out = {};
  for (const key of HELCIM_BILLING_KEYS) {
    if (typeof address[key] === 'string' && address[key].trim()) out[key] = address[key].trim();
  }
  return out.name && out.street1 && out.postalCode ? out : null;
}
