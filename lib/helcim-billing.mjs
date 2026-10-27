// WHAT: maps a Shopify order's billing address + customer onto the `billingAddress` object Helcim's POST /invoices accepts,
// so the card invoice Alex sees in the Helcim dashboard (and the customer sees on the pay page) names WHO it is for instead
// of carrying only "Fuzzywumpets wholesale order #1234" in the notes. Pure: no I/O, never throws.
// CHANGE-GUARD: Helcim's Address contract (devdocs.helcim.com/reference/createinvoice) makes `name`, `street1` and
// `postalCode` required, `province` a 2-letter code that is required when `country` is CAN or USA, `country` an ISO
// alpha-3 code and `phone` 10-15 digits. This mapper therefore returns null (the caller sends NO billingAddress, i.e. the
// pre-existing invoice) rather than a partial object Helcim would reject, and it drops province AND country together when
// a US/CA province cannot be expressed as 2 letters, because country without province is the combination Helcim refuses.
// INVARIANT(S): output keys are a subset of HELCIM_BILLING_KEYS; every value is a non-empty trimmed string with control
// characters flattened; no key is ever undefined; the address is never logged or audited by callers (it is customer PII).
// DEPENDS: server.mjs getOrderDetail selects billingAddress{company firstName lastName address1 address2 city province
//   provinceCode zip country countryCodeV2 phone} — this mapper reads exactly those (pinned by test/helcim-billing.test.mjs);
//   helcim.mjs createCreditCardInvoice re-validates the result and uses HELCIM_BILLING_KEYS to whitelist what it sends.

export const HELCIM_BILLING_KEYS = ['name', 'street1', 'street2', 'city', 'province', 'country', 'postalCode', 'phone', 'email'];

// ISO 3166-1 alpha-2 -> alpha-3 for the countries wholesale customers actually order from. An unmapped country is
// omitted (it is optional in Helcim) rather than guessed.
const ALPHA2_TO_ALPHA3 = {
  US: 'USA', CA: 'CAN', GB: 'GBR', AU: 'AUS', NZ: 'NZL', IE: 'IRL', MX: 'MEX',
  DE: 'DEU', FR: 'FRA', NL: 'NLD', ES: 'ESP', IT: 'ITA', JP: 'JPN',
};
const ALPHA3 = new Set(Object.values(ALPHA2_TO_ALPHA3));
const COUNTRY_NAMES = { 'UNITED STATES': 'USA', 'UNITED STATES OF AMERICA': 'USA', CANADA: 'CAN' };

// Non-strings are "missing" (a malformed payload must not throw); control characters become spaces so a stray newline
// cannot break the Helcim invoice layout; runs of spaces collapse.
function clean(value) {
  if (typeof value !== 'string') return '';
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0);
    out += (code < 32 || code === 127) ? ' ' : ch;
  }
  return out.replace(/ +/g, ' ').trim();
}

function twoLetters(value) {
  return /^[A-Za-z]{2}$/.test(value) ? value.toUpperCase() : '';
}

function countryAlpha3(address) {
  const code = clean(address.countryCodeV2).toUpperCase();
  if (code) return ALPHA2_TO_ALPHA3[code] || '';
  const country = clean(address.country).toUpperCase();
  if (ALPHA2_TO_ALPHA3[country]) return ALPHA2_TO_ALPHA3[country];
  if (ALPHA3.has(country)) return country;
  return COUNTRY_NAMES[country] || '';
}

function digitsOnly(value) {
  return clean(value).replace(/[^0-9]/g, '');
}

export function buildHelcimBillingAddress({ billingAddress, customer } = {}) {
  const address = billingAddress && typeof billingAddress === 'object' ? billingAddress : null;
  if (!address) return null;
  const cust = customer && typeof customer === 'object' ? customer : {};

  const person = [clean(address.firstName), clean(address.lastName)].filter(Boolean).join(' ');
  const name = clean(address.company) || clean(cust.company) || person || clean(cust.displayName);
  const street1 = clean(address.address1);
  const postalCode = clean(address.zip);
  if (!name || !street1 || !postalCode) return null;

  let country = countryAlpha3(address);
  let province = '';
  if (country === 'USA' || country === 'CAN') {
    province = twoLetters(clean(address.provinceCode)) || twoLetters(clean(address.province));
    // Helcim requires a 2-letter province whenever country is CAN or USA; without one, send neither.
    if (!province) country = '';
  }

  const phoneDigits = digitsOnly(address.phone);
  const email = clean(cust.email).toLowerCase();

  const out = {
    name, street1,
    street2: clean(address.address2),
    city: clean(address.city),
    province, country, postalCode,
    phone: phoneDigits.length >= 10 && phoneDigits.length <= 15 ? phoneDigits : '',
    email: /^[^@ ]+@[^@ ]+[.][^@ ]+$/.test(email) ? email : '',
  };
  for (const key of Object.keys(out)) if (!out[key]) delete out[key];
  return out;
}
