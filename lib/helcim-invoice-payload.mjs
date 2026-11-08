const ALLOWED_CURRENCIES = new Set(['USD', 'CAD']);
const MAX_LINE_ITEMS = 100;

export class HelcimInvoiceValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HelcimInvoiceValidationError';
  }
}

function moneyToCents(value, field) {
  const text = String(value ?? '').trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new HelcimInvoiceValidationError(`${field} must be a non-negative amount with at most two decimal places`);
  const cents = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new HelcimInvoiceValidationError(`${field} is outside the supported amount range`);
  return cents;
}

function centsToNumber(cents) {
  return cents / 100;
}

function presentmentAmount(moneySet) {
  return moneySet?.presentmentMoney?.amount;
}

function currentQuantity(line) {
  return line.currentQuantity != null ? line.currentQuantity : line.quantity;
}

// WHAT: converts customer-visible invoice text to the conservative character set accepted by the
// enhanced-data pipeline while retaining useful punctuation and readable word boundaries.
// CHANGE-GUARD: do not broaden this without re-checking Helcim/card-network statement rendering.
// INVARIANT(S): output contains only ASCII letters, digits, apostrophe, period, hyphen, and spaces.
export function sanitizeHelcimText(value, fallback = '') {
  const normalized = String(value ?? '')
    .replace(/&/g, ' and ')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/½/g, '.5')
    .replace(/¼/g, '.25')
    .replace(/¾/g, '.75')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9'.\- ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || fallback;
}

function safeSku(value) {
  const sku = String(value ?? '').trim();
  return sku && /^[A-Za-z0-9._-]+$/.test(sku) ? sku : null;
}

function lineDescription(line, index) {
  const optionText = (line.variant?.selectedOptions || [])
    .filter(option => option?.value && option.value !== 'Default Title')
    .map(option => option.value)
    .join(' ');
  const variantTitle = optionText || (line.variant?.title && line.variant.title !== 'Default Title' ? line.variant.title : '');
  return sanitizeHelcimText([line.title, variantTitle].filter(Boolean).join(' - '), `Item ${index + 1}`);
}

function buildAddress(address, email) {
  if (!address) return null;
  const name = sanitizeHelcimText([address.firstName, address.lastName].filter(Boolean).join(' '));
  const street1 = sanitizeHelcimText(address.address1);
  const postalCode = sanitizeHelcimText(address.zip);
  if (!name || !street1 || !postalCode) return null;
  return {
    name,
    street1,
    ...(address.address2 ? { street2: sanitizeHelcimText(address.address2) } : {}),
    ...(address.city ? { city: sanitizeHelcimText(address.city) } : {}),
    ...(address.province ? { province: sanitizeHelcimText(address.province) } : {}),
    ...(address.country ? { country: sanitizeHelcimText(address.country) } : {}),
    ...(address.phone ? { phone: String(address.phone).trim() } : {}),
    ...(email ? { email: String(email).trim() } : {}),
    postalCode,
  };
}

function invoiceNumberFor(order) {
  const raw = String(order.name || order.id || '').replace(/^gid:\/\/shopify\/Order\//, '');
  const identifier = sanitizeHelcimText(raw).replace(/^#/, '').replace(/ /g, '-');
  if (!identifier) throw new HelcimInvoiceValidationError('Order is missing a reconciliation identifier');
  return `FWW-${identifier}`;
}

// WHAT: assembles the one authoritative Helcim Invoice API payload from Shopify's current order
// state using integer minor units, then refuses any payload that cannot exactly equal the amount due.
// CHANGE-GUARD: Helcim computes invoice amount as line totals + shipping + tax - invoice discount;
// changing that contract requires updating this module, its tests, and the createCreditCardInvoice caller.
// INVARIANT(S): removed lines are omitted; current quantities and discounted unit prices are used;
// tax and shipping remain discrete; no floating-point arithmetic participates in reconciliation.
export function buildHelcimInvoicePayload({ order, expectedAmount }) {
  if (!order || typeof order !== 'object') throw new HelcimInvoiceValidationError('Order data is required');
  const totalMoney = order.currentTotalPriceSet?.presentmentMoney || order.totalPriceSet?.presentmentMoney || {};
  const currency = String(totalMoney.currencyCode || '').toUpperCase();
  if (!ALLOWED_CURRENCIES.has(currency)) throw new HelcimInvoiceValidationError('Invoice currency must be USD or CAD');
  if (order.taxesIncluded) throw new HelcimInvoiceValidationError('Tax-inclusive Shopify orders cannot be represented as discrete Helcim tax data');

  const sourceLines = (order.lineItems?.edges || []).map(edge => edge?.node).filter(Boolean);
  const activeLines = sourceLines.filter(line => Number(currentQuantity(line)) > 0);
  if (!activeLines.length) throw new HelcimInvoiceValidationError('Invoice requires at least one active line item');
  if (activeLines.length > MAX_LINE_ITEMS) throw new HelcimInvoiceValidationError(`Invoice exceeds Helcim's ${MAX_LINE_ITEMS}-line limit`);

  let grossLineCents = 0;
  const omittedSkuLines = [];
  const lineItems = activeLines.map((line, index) => {
    const quantity = Number(currentQuantity(line));
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new HelcimInvoiceValidationError(`Line ${index + 1} has an invalid Shopify quantity`);
    }
    const unitAmount = presentmentAmount(line.discountedUnitPriceSet) ?? presentmentAmount(line.originalUnitPriceSet);
    const priceCents = moneyToCents(unitAmount, `Line ${index + 1} unit price`);
    const lineCents = priceCents * quantity;
    if (!Number.isSafeInteger(lineCents)) throw new HelcimInvoiceValidationError(`Line ${index + 1} total is outside the supported range`);
    grossLineCents += lineCents;

    const sku = safeSku(line.variant?.sku || line.sku);
    if (!sku) omittedSkuLines.push(index + 1);
    return {
      description: lineDescription(line, index),
      quantity,
      price: centsToNumber(priceCents),
      ...(sku ? { sku } : {}),
    };
  });

  const subtotalAmount = presentmentAmount(order.currentSubtotalPriceSet) ?? presentmentAmount(order.subtotalPriceSet);
  const subtotalCents = moneyToCents(subtotalAmount, 'Shopify current subtotal');
  const discountCents = grossLineCents - subtotalCents;
  if (discountCents < 0) {
    throw new HelcimInvoiceValidationError('Shopify current subtotal exceeds the sum of current line quantities and prices');
  }

  const shippingAmount = presentmentAmount(order.currentShippingPriceSet) ?? presentmentAmount(order.totalShippingPriceSet) ?? '0';
  const taxAmount = presentmentAmount(order.currentTotalTaxSet) ?? presentmentAmount(order.totalTaxSet) ?? '0';
  const shippingCents = moneyToCents(shippingAmount, 'Shopify shipping');
  const taxCents = moneyToCents(taxAmount, 'Shopify tax');
  const expectedCents = moneyToCents(expectedAmount, 'Outstanding balance');
  const computedCents = grossLineCents - discountCents + shippingCents + taxCents;
  if (computedCents !== expectedCents) {
    throw new HelcimInvoiceValidationError(
      `Refusing unreconciled Helcim invoice: items ${centsToNumber(grossLineCents).toFixed(2)} - discounts ${centsToNumber(discountCents).toFixed(2)} + shipping ${centsToNumber(shippingCents).toFixed(2)} + tax ${centsToNumber(taxCents).toFixed(2)} = ${centsToNumber(computedCents).toFixed(2)}, outstanding ${centsToNumber(expectedCents).toFixed(2)}`,
    );
  }

  const taxExempt = order.taxExempt === true;
  if (taxExempt && taxCents !== 0) throw new HelcimInvoiceValidationError('Tax-exempt Shopify order has a non-zero tax amount');
  const taxLabels = (order.currentTaxLines || order.taxLines || [])
    .map(line => sanitizeHelcimText(line?.title))
    .filter(Boolean);
  const customerEmail = order.customer?.email;
  const billingAddress = buildAddress(order.billingAddress, customerEmail);
  const shippingAddress = buildAddress(order.shippingAddress, customerEmail);
  const invoiceNumber = invoiceNumberFor(order);
  const payload = {
    currency,
    type: 'INVOICE',
    status: 'DUE',
    invoiceNumber,
    lineItems,
    // Live Helcim (2026-11-08, order #40352) refuses tax.amount 0 with HTTP 400 "tax.amount must be a valid Positive Number",
    // so the tax object is sent only when there is tax; a zero-tax invoice reconciles without it (items - discount + shipping).
    ...(taxCents > 0 ? { tax: { amount: centsToNumber(taxCents), details: taxLabels.join(' and ') || 'Sales tax' } } : {}),
    ...(discountCents ? { discount: { amount: centsToNumber(discountCents), details: 'Shopify order discounts' } } : {}),
    ...(billingAddress ? { billingAddress } : {}),
    ...((shippingCents || shippingAddress) ? {
      shipping: {
        amount: centsToNumber(shippingCents),
        details: 'Shipping',
        ...(shippingAddress ? { address: shippingAddress } : {}),
      },
    } : {}),
    // DEPENDS: helcim.mjs appends " - <company>" to these notes; keep the leading "Fuzzywumpets wholesale order <name>" text.
    notes: `Fuzzywumpets wholesale order ${sanitizeHelcimText(order.name || invoiceNumber)}${taxExempt ? ' (tax exempt)' : ''}`,
  };

  return {
    payload,
    amountCents: computedCents,
    currency,
    invoiceNumber,
    taxExempt,
    taxCents,
    taxStatus: taxExempt ? 'exempt' : (taxCents === 0 ? 'zero_tax' : 'taxable'),
    itemCount: lineItems.length,
    omittedSkuLines,
  };
}

// WHAT: whether POST /orders/:id/send-credit-card-invoice asks planHelcimInvoice for the itemized body for this order: every order when
//   HELCIM_ITEMIZED_INVOICES=1 (the global switch, off in production), or only the numeric Shopify order ids listed in
//   HELCIM_ITEMIZED_ORDER_IDS (comma-separated). The list lets one real test invoice go out itemized without switching it on for all.
// CHANGE-GUARD: exact matches only (no prefixes, no gids); malformed entries are ignored. The itemized body still falls back to the
//   balance line when the order does not reconcile to the cent (planHelcimInvoice), so a listed order can never be left unbillable.
// DEPENDS: server.mjs send-credit-card-invoice route passes its numeric :id; test/helcim-payload.test.mjs pins that call site.
export function itemizedInvoicesEnabledFor(numericOrderId, env = process.env) {
  if (env.HELCIM_ITEMIZED_INVOICES === '1') return true;
  const id = String(numericOrderId ?? '').trim();
  if (!/^[0-9]{1,20}$/.test(id)) return false;
  return String(env.HELCIM_ITEMIZED_ORDER_IDS || '').split(',').map(entry => entry.trim()).includes(id);
}

// WHAT: decides which Helcim invoice body POST /orders/:id/send-credit-card-invoice creates (reconcile of main + production,
//   2026-11-08). Returns { mode: 'balance' | 'itemized', amountCents, currency, ... } in one shape for both.
// CHANGE-GUARD: 'balance' (one "Balance due" line for the exact outstanding amount) is what production has sent since 2026-10-26
//   and stays the default. 'itemized' (buildHelcimInvoicePayload above, main PR #38) is taken ONLY when `itemized` is true (server
//   env HELCIM_ITEMIZED_INVOICES=1) AND the order reconciles to the cent; a HelcimInvoiceValidationError (partial payment,
//   tax-inclusive order, >100 lines, unreconciled discount) falls back to the balance line and reports why in `fallbackReason`,
//   so turning the switch on can never stop a card invoice going out. Any other error is a bug and is rethrown.
// INVARIANT(S): amountCents is a non-negative integer (0 means "nothing owed" and the caller refuses); currency is upper-case and
//   defaults to USD like production; the balance plan carries no payload (helcim.mjs builds the single line itself).
// DEPENDS: server.mjs send-credit-card-invoice route (destructures amountCents, currency, taxExempt, taxStatus, itemCount,
//   omittedSkuLines, invoiceNumber, payload, mode, fallbackReason) and helcim.mjs createCreditCardInvoice (two input shapes).
export function planHelcimInvoice({ order, expectedAmount, itemized = false } = {}) {
  let fallbackReason = null;
  if (itemized) {
    try {
      return { mode: 'itemized', fallbackReason: null, ...buildHelcimInvoicePayload({ order, expectedAmount }) };
    } catch (error) {
      if (!(error instanceof HelcimInvoiceValidationError)) throw error;
      fallbackReason = error.message;
    }
  }
  const totalMoney = order?.currentTotalPriceSet?.presentmentMoney || order?.totalPriceSet?.presentmentMoney || {};
  const currency = String(totalMoney.currencyCode || 'USD').toUpperCase();
  const outstanding = Math.round(Math.max(0, Number(expectedAmount) || 0) * 100) / 100;
  return {
    mode: 'balance',
    fallbackReason,
    payload: null,
    amountCents: Math.round(outstanding * 100),
    currency,
    invoiceNumber: null,
    taxExempt: order?.taxExempt === true,
    taxCents: null,
    taxStatus: 'balance_due',
    itemCount: 1,
    omittedSkuLines: [],
  };
}
