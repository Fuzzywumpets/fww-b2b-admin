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

// WHAT: creates one pre-validated, itemized DUE invoice and returns its customer-payable online view.
// CHANGE-GUARD: Invoice API POSTs have no documented idempotency-key support. Only explicit 429
// responses are retried; timeouts, network errors, malformed successes, and 5xx responses are
// outcome-unknown and must stay blocked by the caller's durable creation claim.
// INVARIANT(S): payload reconciliation happens before this function; a response without
// invoiceId+token fails closed before any email is sent and never leaks the response body.
export async function createCreditCardInvoice({ payload, amountCents, currency }, options = {}) {
  if (!payload || typeof payload !== 'object') throw new TypeError('Validated invoice payload is required');
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new TypeError('Invoice amount must be greater than zero');
  const normalizedCurrency = String(currency || '').toUpperCase();
  if (!['USD', 'CAD'].includes(normalizedCurrency) || payload.currency !== normalizedCurrency) {
    throw new TypeError('Invoice currency must be USD or CAD and match the validated payload');
  }
  const response = await helcimRequest('/invoices', {
    ...options,
    method: 'POST',
    retry429DelaysMs: options.retry429DelaysMs || DEFAULT_429_DELAYS_MS,
    body: payload,
  });
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
    invoiceNumber: invoice.invoiceNumber || payload.invoiceNumber || null,
    token: String(invoice.token),
    url: url.toString(),
    amount: amountCents / 100,
    currency: normalizedCurrency,
  };
}
