# Helcim itemized B2B invoice contract

Verified 2026-09-03 against Helcim's current API reference and guides. This document describes the
Admin service's production contract; it is not a promise that a particular card will qualify for a
particular interchange rate.

## Ownership and flow

`fww-b2b-admin` is the sole owner of B2B Helcim invoice creation. It already owns the staff action,
Shopify order read, durable invoice map, and write-before-email ordering. Portal remains the
customer communication boundary through `POST /__internal__/visible-note`; Portal PR #42 accepts
`subject` plus `creditCardInvoice: { amount, currency, paymentUrl }`, renders fixed escaped branded
HTML, and sends through its existing Gmail token broker as `wholesale@fuzzywumpets.com`. Admin does
not receive Gmail credentials or render customer HTML. No separate Helcim bridge is needed.

1. Read the current Shopify order, including current quantities/totals, discounts, shipping, tax,
   tax-exempt status, and addresses.
2. Build and validate one Invoice API payload entirely in integer cents.
3. Acquire `helcim_invoice_claims.order_id` before the Invoice API POST.
4. Create the invoice, atomically persist `helcim_invoice_map`, then email the private online-view
   link. Delivery retries reuse the mapped invoice.

## Confirmed API behavior

- `POST /v2/invoices` requires `currency` and 1–100 line items; USD and CAD are supported. It accepts
  invoice-level `tax`, `shipping`, `discount`, billing/shipping addresses, and a custom
  `invoiceNumber`. Helcim computes the invoice amount. [Create invoice reference](https://devdocs.helcim.com/reference/createinvoice)
- Invoice line items are independent of Helcim's product catalog. Helcim's guide says a SKU is
  needed for an item to appear, while the current endpoint schema marks SKU optional. Admin includes
  a conservative Shopify SKU when it is safe and otherwise omits it; there is no catalog sync.
  [Invoice guide](https://devdocs.helcim.com/docs/invoices)
- Invoice creation does **not** document an `idempotency-key` header. That header is required for
  Payment API transaction endpoints and expires after five minutes; Admin never sends it to the
  Invoice API. [Idempotency](https://devdocs.helcim.com/docs/idempotency)
- Limits are per merchant account across API configurations: 5 concurrent, 100/minute, 3000/hour;
  successful responses expose remaining minute/hour budget and over-limit calls return 429. Admin
  caps local concurrency at five and retries only explicit 429 rejections with a bounded delay.
  It never retries an ambiguous invoice timeout, network failure, malformed success, or 5xx.
  [API rate limits](https://devdocs.helcim.com/docs/api-rate-limits)
- The Invoice API accepts `customerId`, not `customerCode`. This integration does not own a Helcim
  customer mapping, so `FWW-<Shopify order number>` is the reconciliation identifier.
- Helcim supports enhanced tax/line data through Invoice API, Payment API, and HelcimPay.js. Savings
  depend on the card and network; Helcim's optimization fee is reported on merchant statements.
  [Optimized payments](https://devdocs.helcim.com/docs/level-2-and-3-optimized-payments)

## Arithmetic and failure invariants

- Line quantity is Shopify `currentQuantity` (falling back only when absent); removed lines are
  omitted. Unit price is the current discounted unit price, with original price only as an
  absence fallback. Zero-dollar comped lines remain zero.
- `discount = sum(quantity × unit price) - Shopify current subtotal`. Tax and shipping remain
  discrete. The payload is refused unless `items - discount + shipping + tax` equals the outstanding
  balance exactly in cents. A partial balance is refused because there is no line-level payment
  allocation from which to construct a truthful itemized remainder.
- Tax-exempt orders must have zero tax and are audited as `exempt`; non-exempt zero-tax orders are
  audited separately as `zero_tax`. Tax-band percentages from third-party processor material are
  not enforced because no current primary Helcim/Visa/Mastercard contract was found for them.
- A creation claim is released only after a definitive rejection. It is retained when the remote
  outcome could have created an invoice, blocking retries until staff reconcile the deterministic
  invoice number in Helcim.
- API tokens and response bodies are never logged or returned. Audit events exclude invoice tokens
  and payment URLs. Card data never enters either B2B service.

## Visa CEDP note

Visa's April 2026 public interchange table contains Business Product 1/2/3 rates, and Helcim
publishes CEDP/Verified rates, but neither source provides this invoice-before-payment flow with a
pre-authorization card-class signal. Admin therefore has no speculative Visa-small-business branch:
it sends only validation-grade, reconciled invoice data. Actual qualification must be reviewed on
the monthly merchant statement; no bps or qualification guarantee is hardcoded.

## Operations and rollback

Configuration remains `HELCIM_API_TOKEN` and the allow-listed `HELCIM_SUBDOMAIN_URL` in Doppler
`fww-shared/prd`. Deploy Portal PR #42 before this Admin change so the structured Gmail-delivery
contract is accepted.
Rollback is an Admin code rollback; the additive claims table can remain. A retained claim means
"reconcile in Helcim before retry," not "delete the row and try again."

No live invoice, charge, customer email, refund, cancellation, or customer mutation was performed
while implementing or testing this contract.
