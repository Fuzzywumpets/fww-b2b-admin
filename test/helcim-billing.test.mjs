// Standalone unit suite for lib/helcim-billing.mjs (no server, no network, no DB): maps a Shopify order's billing address
// + customer onto the `billingAddress` object Helcim's POST /invoices accepts, so the Helcim invoice shows WHO it is for
// instead of only "Fuzzywumpets wholesale order #1234" in the notes. Requested by Alex on 2026-10-27.
//
// Helcim's Address contract (devdocs.helcim.com/reference/createinvoice):
//   name, street1, postalCode REQUIRED; street2, city, province (2-letter, required when country is CAN or USA),
//   country (ISO alpha-3), phone (10-15 digits), email optional.
// The mapper must therefore return null (send NO billingAddress, i.e. today's behaviour) rather than a partial object that
// Helcim would reject, and must never emit a province/country combination Helcim would reject.
//
// Source guards at the bottom pin the two couplings that unit tests cannot see: the live Shopify query selecting the extra
// fields the mapper reads, and the send-credit-card-invoice handler actually using the mapper without leaking the address.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildHelcimBillingAddress, HELCIM_BILLING_KEYS } from '../lib/helcim-billing.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${err.stack?.split('\n').slice(0, 4).join('\n      ') || err.message}`); failed++; }
}

// Live Shopify shape (MailingAddress with provinceCode / countryCodeV2 / phone).
const liveBilling = (over = {}) => ({
  company: 'Happy Paws Boutique LLC', firstName: 'Jane', lastName: 'Smith',
  address1: '456 Park Ave', address2: 'Suite 4', city: 'Philadelphia',
  province: 'Pennsylvania', provinceCode: 'PA', zip: '19103',
  country: 'United States', countryCodeV2: 'US', phone: '+1 (215) 555-0100', ...over,
});
const customer = (over = {}) => ({ displayName: 'Happy Paws Boutique', email: 'Orders@HappyPaws.com', ...over });

console.log('── buildHelcimBillingAddress ──');

test('maps a complete live US billing address', () => {
  assert.deepEqual(buildHelcimBillingAddress({ billingAddress: liveBilling(), customer: customer() }), {
    name: 'Happy Paws Boutique LLC', street1: '456 Park Ave', street2: 'Suite 4', city: 'Philadelphia',
    province: 'PA', country: 'USA', postalCode: '19103', phone: '12155550100', email: 'orders@happypaws.com',
  });
});

test('business name preference: billing company, then customer company, then person, then displayName', () => {
  const b = (over, cust) => buildHelcimBillingAddress({ billingAddress: liveBilling(over), customer: customer(cust) }).name;
  assert.equal(b({}, {}), 'Happy Paws Boutique LLC');
  assert.equal(b({ company: '' }, { company: 'Customer Co' }), 'Customer Co');
  assert.equal(b({ company: '  ' }, {}), 'Jane Smith');
  assert.equal(b({ company: null, firstName: '', lastName: '' }, {}), 'Happy Paws Boutique');
  assert.equal(b({ company: null, firstName: 'Jane', lastName: '' }, {}), 'Jane');
});

test('mock-shaped address (province/country already codes, no provinceCode/countryCodeV2) still maps', () => {
  const r = buildHelcimBillingAddress({
    billingAddress: { firstName: 'John', lastName: 'Doe', address1: '123 Main St', address2: '', city: 'Chicago', province: 'IL', zip: '60601', country: 'US' },
    customer: { displayName: 'Acme Pet Supply', email: 'buyer@acme.com' },
  });
  assert.deepEqual(r, { name: 'John Doe', street1: '123 Main St', city: 'Chicago', province: 'IL', country: 'USA', postalCode: '60601', email: 'buyer@acme.com' });
});

test('Canada maps to CAN with a 2-letter province', () => {
  const r = buildHelcimBillingAddress({ billingAddress: liveBilling({ province: 'Ontario', provinceCode: 'ON', country: 'Canada', countryCodeV2: 'CA', zip: 'M5V 2T6' }), customer: customer() });
  assert.equal(r.country, 'CAN');
  assert.equal(r.province, 'ON');
  assert.equal(r.postalCode, 'M5V 2T6');
});

test('a non-US/CA country maps to alpha-3 and omits the province (Helcim wants 2-letter codes for CAN/USA only)', () => {
  const r = buildHelcimBillingAddress({ billingAddress: liveBilling({ province: 'Manawatu-Wanganui', provinceCode: 'MWT', country: 'New Zealand', countryCodeV2: 'NZ', zip: '4410' }), customer: customer() });
  assert.equal(r.country, 'NZL');
  assert.equal('province' in r, false);
});

test('US/CA address whose province cannot be made a 2-letter code drops province AND country so Helcim cannot 400 on it', () => {
  const r = buildHelcimBillingAddress({ billingAddress: liveBilling({ provinceCode: null, province: 'Pennsylvania' }), customer: customer() });
  assert.ok(r, 'address is still sent');
  assert.equal('province' in r, false);
  assert.equal('country' in r, false);
  assert.equal(r.street1, '456 Park Ave');
});

test('an unmapped country is omitted rather than guessed', () => {
  const r = buildHelcimBillingAddress({ billingAddress: liveBilling({ country: 'Atlantis', countryCodeV2: 'ZZ', provinceCode: 'XX' }), customer: customer() });
  assert.equal('country' in r, false);
  assert.equal('province' in r, false);
});

test('country given as a name or alpha-3 with no code still resolves for US and CA', () => {
  assert.equal(buildHelcimBillingAddress({ billingAddress: liveBilling({ countryCodeV2: undefined, country: 'United States' }), customer: customer() }).country, 'USA');
  assert.equal(buildHelcimBillingAddress({ billingAddress: liveBilling({ countryCodeV2: undefined, country: 'CAN', provinceCode: 'BC' }), customer: customer() }).country, 'CAN');
});

test('returns null (no billingAddress at all) when Helcim\'s required fields cannot be filled', () => {
  const call = (b, c = customer()) => buildHelcimBillingAddress({ billingAddress: b, customer: c });
  assert.equal(call(null), null);
  assert.equal(call(undefined), null);
  assert.equal(call({}), null);
  assert.equal(call(liveBilling({ address1: '' })), null, 'no street1');
  assert.equal(call(liveBilling({ address1: '   ' })), null, 'blank street1');
  assert.equal(call(liveBilling({ zip: null })), null, 'no postalCode');
  assert.equal(call(liveBilling({ company: '', firstName: '', lastName: '' }), {}), null, 'no name anywhere');
  assert.equal(buildHelcimBillingAddress({}), null);
  assert.equal(buildHelcimBillingAddress(), null);
});

test('phone: digits only, 10-15 of them, else omitted', () => {
  const ph = (phone) => buildHelcimBillingAddress({ billingAddress: liveBilling({ phone }), customer: customer() }).phone;
  assert.equal(ph('(215) 555-0100'), '2155550100');
  assert.equal(ph('+44 20 7946 0958'), '442079460958');
  assert.equal(ph('555-0100'), undefined, '7 digits');
  assert.equal(ph('1234567890123456'), undefined, '16 digits');
  assert.equal(ph(''), undefined);
  assert.equal(ph(null), undefined);
});

test('email: lower-cased, trimmed, and omitted when it is not an address', () => {
  const em = (email) => buildHelcimBillingAddress({ billingAddress: liveBilling(), customer: customer({ email }) }).email;
  assert.equal(em('  Buyer@Acme.COM '), 'buyer@acme.com');
  assert.equal(em('not-an-email'), undefined);
  assert.equal(em(''), undefined);
  assert.equal(em(undefined), undefined);
});

test('strings are trimmed, control characters flattened, blanks dropped, and no key is ever undefined', () => {
  const r = buildHelcimBillingAddress({
    billingAddress: liveBilling({ company: '  Happy\nPaws\t\tBoutique ', address2: '   ', city: '', phone: null }),
    customer: customer({ email: null }),
  });
  assert.equal(r.name, 'Happy Paws Boutique');
  for (const k of ['street2', 'city', 'phone', 'email']) assert.equal(k in r, false, `${k} should be absent`);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r, 'JSON round-trip is lossless (no undefined values)');
});

test('output only ever contains the keys Helcim documents', () => {
  const r = buildHelcimBillingAddress({ billingAddress: { ...liveBilling(), surprise: 'x', id: 'gid://shopify/MailingAddress/1' }, customer: customer() });
  for (const k of Object.keys(r)) assert.ok(HELCIM_BILLING_KEYS.includes(k), `unexpected key ${k}`);
});

test('non-string values from a malformed Shopify payload never throw and are treated as missing', () => {
  assert.equal(buildHelcimBillingAddress({ billingAddress: liveBilling({ address1: 42 }), customer: customer() }), null);
  assert.equal(buildHelcimBillingAddress({ billingAddress: liveBilling({ zip: { a: 1 } }), customer: customer() }), null);
  const r = buildHelcimBillingAddress({ billingAddress: liveBilling({ city: ['x'], phone: 12155550100 }), customer: customer({ email: 7 }) });
  assert.equal('city' in r, false);
  assert.equal('email' in r, false);
  assert.equal('phone' in r, false);
});

console.log('\n── source guards ──');

const serverSrc = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');

test('getOrderDetail selects every billingAddress field the mapper reads (provinceCode, countryCodeV2, phone)', () => {
  const m = serverSrc.match(/billingAddress\{([^}]*)\}\s*\n\s*lineItems\(first:250\)/);
  assert.ok(m, 'could not find the billingAddress selection in getOrderDetail');
  for (const f of ['company', 'firstName', 'lastName', 'address1', 'address2', 'city', 'province', 'provinceCode', 'zip', 'country', 'countryCodeV2', 'phone']) {
    assert.ok(m[1].split(/\s+/).includes(f), `getOrderDetail billingAddress selection is missing ${f}`);
  }
});

const start = serverSrc.indexOf("app.post('/orders/:id/send-credit-card-invoice'");
const end = serverSrc.indexOf("// ── Invoice CSV export", start);
const handler = start > -1 && end > start ? serverSrc.slice(start, end) : '';

test('the send-credit-card-invoice handler builds the address from the order and hands it to Helcim', () => {
  assert.ok(handler.length > 500, 'could not isolate the send-credit-card-invoice handler');
  assert.ok(handler.includes('buildHelcimBillingAddress({'), 'handler does not call buildHelcimBillingAddress');
  const call = handler.slice(handler.indexOf('createCreditCardInvoice({'));
  assert.ok(call.slice(0, call.indexOf('})')).includes('billingAddress'), 'createCreditCardInvoice is not given billingAddress');
  assert.ok(call.slice(0, call.indexOf('})')).includes('companyName: order.customer?.company'), 'createCreditCardInvoice is not given the resolved company name');
});

test('audit rows and logs never carry the customer address', () => {
  const audits = handler.split('auditLog(').slice(1).map(s => s.slice(0, s.indexOf('});')));
  assert.ok(audits.length >= 2, 'expected the handler audit calls');
  for (const a of audits) {
    assert.ok(!/billingAddress|street1|address1|postalCode|phone/.test(a), `audit row leaks address data: ${a.slice(0, 120)}`);
  }
  assert.ok(!handler.includes('console.error(billing'), 'handler logs the billing address');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
