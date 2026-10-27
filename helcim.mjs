import { HELCIM_BILLING_KEYS, cleanBillingText } from './lib/helcim-billing.mjs';

const HELCIM_API_BASE_URL = 'https://api.helcim.com/v2/';
const DEFAULT_TIMEOUT_MS = 10_000;

export class HelcimConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HelcimConfigurationError';
  }
}

export class HelcimApiError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'HelcimApiError';
    this.status = status;
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
  env = process.env, fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw new TypeError('Helcim API path must be root-relative');
  }
  const { token } = readConfig(env);
  const requestUrl = new URL(path.slice(1), HELCIM_API_BASE_URL);
  if (!requestUrl.pathname.startsWith('/v2/')) throw new TypeError('Helcim API path must remain under /v2');
  const timeout = createTimeoutSignal(timeoutMs);

  try {
    const response = await fetchImpl(requestUrl, {
      method,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'api-token': token },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timeout.signal,
    });
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) throw new HelcimApiError(`Helcim API request failed with HTTP ${response.status}`, { status: response.status });
    return { status: response.status, data };
  } catch (error) {
    if (error instanceof HelcimApiError) throw error;
    if (timeout.signal.aborted) throw new HelcimApiError('Helcim API request timed out');
    throw new HelcimApiError('Helcim API request failed');
  } finally {
    timeout.cleanup();
  }
}

// WHAT: creates one DUE invoice for the exact outstanding Shopify balance and returns its customer-payable Helcim online-view URL.
// CHANGE-GUARD: this intentionally uses one balance-due line, not the original item breakdown; partial payments and edited orders must bill only the current outstanding amount.
// INVARIANT(S): amount is positive, currency is USD/CAD, and a response without invoiceId+token fails closed before any email is sent.
// BILLING: an optional `billingAddress` (lib/helcim-billing.mjs buildHelcimBillingAddress) puts the customer's name, address and
// email on the invoice. It is whitelisted to HELCIM_BILLING_KEYS and omitted unless name+street1+postalCode are present. If Helcim
// answers 400/422 the invoice is retried ONCE without it, because the address is cosmetic and must never stop a card invoice
// going out; those two statuses mean Helcim validated and refused the request, so no invoice exists to duplicate. Every other
// failure (401, 429, 5xx, timeout, network) may have created the invoice and is NOT retried. Resolves with `billingIncluded`.
// COMPANY: an optional `companyName` is also appended to the invoice notes ("Fuzzywumpets wholesale order #1234 - Acme Pet Supply"),
// so the company is on the invoice even when the billing address is incomplete or Helcim refuses it (Alex, 2026-10-27: "make sure
// that is company name, somewhere"). Nothing parses these notes (the paid-sync matches by invoice id/number), but keep the leading
// "Fuzzywumpets wholesale order <name>" text stable.
// DEPENDS: server.mjs POST /orders/:id/send-credit-card-invoice passes `billingAddress` + `companyName` (order.customer.company,
//   resolved by getOrderDetail) and surfaces `billingIncluded`.
export async function createCreditCardInvoice({ orderName, amount, currency, billingAddress, companyName }, options = {}) {
  const normalizedAmount = Math.round(Number(amount) * 100) / 100;
  const normalizedCurrency = String(currency || '').toUpperCase();
  if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) throw new TypeError('Invoice amount must be greater than zero');
  if (!['USD', 'CAD'].includes(normalizedCurrency)) throw new TypeError('Invoice currency must be USD or CAD');

  const { warn = console.error, ...requestOptions } = options;
  const orderNote = `Fuzzywumpets wholesale order ${String(orderName || '').trim()}`.trim();
  const company = cleanBillingText(companyName).slice(0, 120).trim();
  const body = {
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
  const billing = pickBillingAddress(billingAddress);

  let response;
  let billingIncluded = false;
  if (billing) {
    try {
      response = await helcimRequest('/invoices', { ...requestOptions, method: 'POST', body: { ...body, billingAddress: billing } });
      billingIncluded = true;
    } catch (error) {
      if (!(error instanceof HelcimApiError) || ![400, 422].includes(error.status)) throw error;
      warn(`Helcim refused the invoice billing address (HTTP ${error.status}); creating the invoice without it`);
    }
  }
  if (!response) response = await helcimRequest('/invoices', { ...requestOptions, method: 'POST', body });
  const invoice = response.data?.invoice || response.data;
  if (!invoice?.invoiceId || !invoice?.token) throw new HelcimApiError('Helcim invoice response was missing invoiceId or token');
  const { subdomainUrl } = readConfig(options.env || process.env);
  const url = new URL('/order/', subdomainUrl);
  url.searchParams.set('token', String(invoice.token));
  return {
    invoiceId: invoice.invoiceId,
    invoiceNumber: invoice.invoiceNumber || null,
    token: String(invoice.token),
    url: url.toString(),
    amount: normalizedAmount,
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
