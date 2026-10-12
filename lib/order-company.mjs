/**
 * Wholesale company-name resolution for orders + invoices, and the address payload the manual
 * order form sends to orderCreate. Extracted from server.mjs so it can be unit-tested without a
 * live Shopify bridge (shopifyFetch / cache lookups are injected, same pattern as order-money.mjs).
 *
 * Why this exists: Shopify's B2B *Companies* feature is NOT in use. A wholesale account's business
 * name lives only on MailingAddress.company — on the order's billing/shipping address and on the
 * customer's default address. Invoices kept printing the PERSON ("Lorraine Rainwater") instead of
 * the business ("Mountain Valley Country Store") because (1) getOrderDetail never selected any
 * company, and (2) the manual order form sent a shipping address without company/phone, so Shopify
 * saved it as a NEW company-less address and made it the customer's default (order #39848,
 * 2026-10-12) — which then also blanked defaultAddress.company for every later order.
 *
 * Never pick an arbitrary address-book company: "first address with a company" is how Mia Wagner's
 * collar business became "Touchstone Crystal" (memory convention_order_party_naming.md).
 */

const clean = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * The trading name recorded on an order/draft-like node: its billing company, else its shipping one.
 * @param {{billingAddress?:{company?:string}|null, shippingAddress?:{company?:string}|null}|null} node
 */
export function addressCompanyOf(node) {
  return clean(node?.billingAddress?.company) || clean(node?.shippingAddress?.company) || '';
}

/**
 * Pick an order's wholesale company with a fixed precedence, synchronously, from data in hand.
 *   (a) this order's billingAddress.company
 *   (b) this order's shippingAddress.company
 *   (c) customer.defaultAddress.company
 *   (d) the customer's most recent PRIOR order/draft that recorded a company (`priorCompanies`,
 *       newest first — caller excludes this order)
 *   (e) customers_cache.company (`cacheCompany`)
 * Returns { company, source } with company=null and source=null when nothing is known.
 *
 * INVARIANT: never consults customer.addresses — see the Touchstone drift note above.
 * SYNC: precedence documented in memory convention_order_party_naming.md (b2badmin section).
 */
export function pickOrderCompany(order, { priorCompanies = [], cacheCompany = null } = {}) {
  const candidates = [
    ['billingAddress', order?.billingAddress?.company],
    ['shippingAddress', order?.shippingAddress?.company],
    ['defaultAddress', order?.customer?.defaultAddress?.company],
    ['priorOrder', (priorCompanies || []).map(clean).find(Boolean)],
    ['customersCache', cacheCompany],
  ];
  for (const [source, value] of candidates) {
    const c = clean(value);
    if (c) return { company: c, source };
  }
  return { company: null, source: null };
}

/**
 * Async wrapper: only fetches the customer's order/draft history when (a)–(c) came up empty, so the
 * common case costs no extra Shopify round-trip.
 *
 * @param {object} order getOrderDetail-shaped order (needs id, billing/shippingAddress, customer)
 * @param {{ shopifyFetch?: Function, getCacheCompany?: (numericCustomerId:string)=>string|null }} deps
 */
export async function resolveOrderCompany(order, { shopifyFetch, getCacheCompany } = {}) {
  const quick = pickOrderCompany(order);
  if (quick.company || !order?.customer?.id) return quick;

  let priorCompanies = [];
  if (shopifyFetch) {
    try {
      const numericCustomerId = String(order.customer.id).split('/').pop();
      const r = await shopifyFetch(`query($id:ID!,$q:String!){
        customer(id:$id){ orders(first:20, sortKey:CREATED_AT, reverse:true){ nodes{ id
          billingAddress{company} shippingAddress{company} } } }
        draftOrders(first:10, query:$q, sortKey:UPDATED_AT, reverse:true){ nodes{
          billingAddress{company} shippingAddress{company} } }
      }`, { id: order.customer.id, q: `customer_id:${numericCustomerId}` });
      const orders = (r?.data?.customer?.orders?.nodes || []).filter(o => o?.id !== order.id);
      const drafts = r?.data?.draftOrders?.nodes || [];
      // Orders first (they are what was actually invoiced), then open drafts.
      priorCompanies = [...orders, ...drafts].map(addressCompanyOf).filter(Boolean);
    } catch (err) {
      console.error('[order-company] prior-order lookup failed:', err.message);
    }
  }
  let cacheCompany = null;
  if (getCacheCompany) {
    try { cacheCompany = getCacheCompany(String(order.customer.id).split('/').pop()); } catch { /* cache optional */ }
  }
  return pickOrderCompany(order, { priorCompanies, cacheCompany });
}

const norm = (v) => clean(v).toLowerCase().replace(/\s+/g, ' ');

/**
 * True when the address the operator submitted is the customer's default address (the form
 * auto-fills from it). Compares only the fields the form carries.
 */
export function sameStreetAddress(submitted, saved) {
  if (!submitted || !saved) return false;
  const same = ['firstName', 'lastName', 'address1', 'address2', 'city', 'zip']
    .every(k => norm(submitted[k]) === norm(saved[k]));
  // Province/country arrive as a code OR a name on either side; an operator's edit to either must
  // make this a DIFFERENT address, or the saved values would silently overwrite the edit.
  const oneOf = (v, ...opts) => { const n = norm(v); return opts.some(o => norm(o) === n); };
  const sameProvince = !clean(submitted.province) && !clean(saved.provinceCode) && !clean(saved.province)
    || oneOf(submitted.province, saved.provinceCode, saved.province);
  const sameCountry = !clean(submitted.country)
    || oneOf(submitted.country, saved.countryCodeV2, saved.country);
  return same && sameProvince && sameCountry;
}

/** Customer MailingAddress (query shape) → MailingAddressInput. */
function savedToInput(saved, company) {
  const out = {
    firstName: saved.firstName || '', lastName: saved.lastName || '',
    address1: saved.address1 || '', address2: saved.address2 || '',
    city: saved.city || '', zip: saved.zip || '',
  };
  if (saved.provinceCode) out.provinceCode = saved.provinceCode; else if (saved.province) out.province = saved.province;
  if (saved.countryCodeV2) out.countryCode = saved.countryCodeV2; else if (saved.country) out.country = saved.country;
  if (saved.phone) out.phone = saved.phone;
  if (company) out.company = company;
  return out;
}

/**
 * Build orderCreate's shippingAddress + billingAddress for a manual B2B order.
 *
 * - Shipping = the submitted form address. When it IS the customer's default address, the saved
 *   default is sent verbatim (incl. company + phone) so Shopify matches the existing address-book
 *   entry instead of saving a company-less duplicate and promoting it to default (#39848).
 * - Shipping company: the form's Company field when the form sent one (`submittedCompany` !==
 *   undefined — staff may clear it for a dropship to a consumer); otherwise the resolved company.
 * - Billing = the customer's default address with the wholesale company; when there is no default,
 *   the shipping street address with the wholesale company. Billing is ALWAYS set, so the invoice's
 *   BILL TO has an address and the order records who is billed.
 *
 * @param {{ submitted: object, submittedCompany?: string, defaultAddress?: object|null, company?: string|null }} p
 * @returns {{ shippingAddress: object, billingAddress: object }}
 */
export function buildOrderAddresses({ submitted, submittedCompany, defaultAddress = null, company = null }) {
  const wholesale = clean(company) || clean(defaultAddress?.company) || '';
  const shipCompany = submittedCompany !== undefined ? clean(submittedCompany) : wholesale;

  let shippingAddress;
  if (defaultAddress && sameStreetAddress(submitted, defaultAddress)) {
    // Keep the saved company when the form left it as-is; honour an explicit edit.
    shippingAddress = savedToInput(defaultAddress, shipCompany);
  } else {
    shippingAddress = { ...submitted };
    if (shipCompany) shippingAddress.company = shipCompany; else delete shippingAddress.company;
  }

  const billingAddress = defaultAddress
    ? savedToInput(defaultAddress, wholesale)
    : (() => { const b = { ...submitted }; if (wholesale) b.company = wholesale; else delete b.company; return b; })();

  return { shippingAddress, billingAddress };
}
