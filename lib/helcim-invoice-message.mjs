// WHAT: builds the customer-facing Portal/Gmail contract for a Helcim invoice link.
// DEPENDS: fww-b2b-portal PR #42 accepts `subject` plus the exact optional
// `creditCardInvoice: { invoiceNumber, amount, taxAmount, currency, paymentUrl }` shape on
// POST /__internal__/visible-note.
// Portal owns escaped branded HTML and Gmail delivery; Admin owns only validated source values.
// INVARIANT(S): the fallback body carries the URL only as a Markdown link target; paymentUrl is
// restricted to the merchant's Helcim host before it crosses the service boundary.
export function buildHelcimInvoiceMessage({ orderName, invoiceNumber, amount, taxAmount = 0, amountText, currency, paymentUrl }) {
  const name = String(orderName || '').trim();
  const amountLabel = String(amountText || '').trim();
  const normalizedInvoiceNumber = String(invoiceNumber || '').trim();
  const numericAmount = Number(amount);
  const numericTaxAmount = Number(taxAmount);
  const normalizedCurrency = String(currency || '').trim().toUpperCase();
  if (!normalizedInvoiceNumber || !Number.isFinite(numericAmount) || numericAmount <= 0 ||
      !Number.isFinite(numericTaxAmount) || numericTaxAmount < 0 || numericTaxAmount > numericAmount) {
    throw new TypeError('Invoice number and valid positive amount are required');
  }
  const url = new URL(String(paymentUrl || ''));
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.myhelcim.com')) {
    throw new TypeError('Payment URL must be an https://*.myhelcim.com URL');
  }
  return {
    subject: `Your Fuzzywumpets invoice for order ${name}`,
    body: [
      `Your Fuzzywumpets invoice for order ${name} is ready. Amount due: ${amountLabel} ${normalizedCurrency}.`,
      '',
      `[Pay your invoice securely](${url.toString()})`,
      '',
      'Questions about your invoice? Reply to this email and our wholesale team will help.',
    ].join('\n'),
    creditCardInvoice: {
      invoiceNumber: normalizedInvoiceNumber,
      amount: numericAmount,
      taxAmount: numericTaxAmount,
      currency: normalizedCurrency,
      paymentUrl: url.toString(),
    },
  };
}
