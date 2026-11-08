// lib/invoice-backorder.mjs — the ORDER invoice's backordered-lines model, wording and HTML block.
//
// WHAT: turns the rows db.mjs getBackorderedLinesForOrder() returns (units REMOVED from the Shopify
//   order and parked in the `backorders` table) into one display model — struck-through invoice rows
//   plus an itemised footnote — and renders the on-screen (HTML) version of it. The PDF renderer
//   (pdf.mjs) draws the SAME model with pdfkit; it contains no wording of its own.
// CHANGE-GUARD: this file is the ONLY place the customer-facing words live (BACKORDER_TAG,
//   BACKORDER_HEADING, BACKORDER_INTRO, the per-item detail line). Reword here and both documents
//   change; never inline a copy in pdf.mjs or server.mjs. Keep it factual: the items are backordered,
//   they are NOT in this invoice's total. Do not add language that promises separate billing, a shipment
//   or a date. The expected ship date was removed from the whole backorder feature (owner decision): it is not shown on
//   the modal, order page, /backorders queue or invoice (the backorders.eta_date column is kept but unused). Do not reintroduce it here.
// INVARIANT(S): PURE — no db, no fs, no Date.now(), no env (so it unit-tests without a server and can
//   never change between two renders of the same rows). Nothing here feeds subtotal/shipping/tax/total:
//   the invoice totals come from the Shopify order (or the caller), which no longer contains these
//   units. A null model means "render nothing" and the invoice stays byte-identical to the
//   pre-backorder layout (test/invoice-backorder.test.mjs pins that).
// DEPENDS: db.mjs getBackorderedLinesForOrder row shape — { title, variantTitle, sku, quantity,
//   unitPrice, currency, lineTotal } (the row carries no ship date: the feature was removed). Callers: pdf.mjs
//   (buildOrderInvoiceBackorderModel -> generateInvoicePdf) and server.mjs GET /orders/:id/invoice. The same
//   rows are frozen into partial_invoices.backordered_json by lib/partial-invoice-backorder.mjs, so a LETTERED
//   invoice renders through this very module (same wording, same footnote).

// WHY an asterisk and not a dagger: the embedded invoice fonts (Inter, Playfair Display) have NO glyph
//   for U+2020 — a rendered PDF shows a "NO GLYPH" box. '*' exists in every embedded font.
// SYNC: the mark appears in BACKORDER_TAG and BACKORDER_HEADING only through this constant; the PDF
//   and HTML renderers print those strings verbatim, so they cannot drift from the mark.
export const BACKORDER_MARK = '*';
export const BACKORDER_TAG = `Backordered ${BACKORDER_MARK}`;
export const BACKORDER_HEADING = `${BACKORDER_MARK} Backordered items`;
export const BACKORDER_HEADING_CONTINUED = `${BACKORDER_HEADING} (continued)`;
export const BACKORDER_INTRO = "These items are currently backordered and are not included in this invoice's total.";

// Collapses whitespace/control characters so a stray newline in a Shopify title can never break a PDF
// row or an HTML line; null/undefined -> ''.
function clean(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// WHAT: money string for a currency code; falls back to USD for a missing/invalid code.
// DEPENDS: pdf.mjs prints every other amount as USD; backorder rows carry the order's own currency.
export function formatBackorderMoney(amount, currency = 'USD') {
  const n = Number(amount);
  const value = Number.isFinite(n) ? n : 0;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: clean(currency) || 'USD' }).format(value);
  } catch {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
  }
}

// WHAT: builds the display model, or null when there is nothing to show.
// rows: db.mjs getBackorderedLinesForOrder() output (oldest first — that order is kept).
// opts.displayTitle(row) -> string: lets the caller reuse the invoice's own title cleaner
//   (pdf.mjs invoiceItemTitle strips a variant Shopify baked into the title) without this module
//   importing pdf.mjs (which imports this one).
// Returns { mark, tag, lines: [{ title, variantTitle, sku, quantity, unitPrice, lineTotal, unitPriceLabel,
//   lineTotalLabel }], footnote: { heading, intro, items: [{ primary, detail }] } }.
// INVARIANT(S): rows whose quantity is not a positive number are dropped (they cannot be invoiced);
//   every footnote item corresponds 1:1, in order, to a lines[] entry.
export function buildInvoiceBackorderModel(rows, { displayTitle } = {}) {
  if (!Array.isArray(rows)) return null;
  const lines = [];
  for (const row of rows) {
    if (!row) continue;
    const quantity = Math.trunc(Number(row.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    const variantTitle = clean(row.variantTitle) === 'Default Title' ? '' : clean(row.variantTitle);
    const shownTitle = typeof displayTitle === 'function'
      ? displayTitle({ title: row.title, variantTitle })
      : row.title;
    const title = clean(shownTitle) || '—';
    const unitRaw = Number(row.unitPrice);
    const unitPrice = Number.isFinite(unitRaw) ? unitRaw : 0;
    const totalRaw = Number(row.lineTotal);
    const lineTotal = Number.isFinite(totalRaw) ? totalRaw : Math.round(unitPrice * quantity * 100) / 100;
    lines.push({
      title,
      variantTitle,
      sku: clean(row.sku),
      quantity,
      unitPrice,
      lineTotal,
      unitPriceLabel: formatBackorderMoney(unitPrice, row.currency),
      lineTotalLabel: formatBackorderMoney(lineTotal, row.currency),
    });
  }
  if (!lines.length) return null;
  return {
    mark: BACKORDER_MARK,
    tag: BACKORDER_TAG,
    lines,
    footnote: {
      heading: BACKORDER_HEADING,
      headingContinued: BACKORDER_HEADING_CONTINUED,
      intro: BACKORDER_INTRO,
      items: lines.map(footnoteItem),
    },
  };
}

// One footnote entry: `primary` names the product (and variant); `detail` is the SKU / quantity (no ship date — see CHANGE-GUARD).
// "SKU" matches the column label the invoice table already uses.
function footnoteItem(line) {
  const detail = [];
  if (line.sku) detail.push(`SKU ${line.sku}`);
  detail.push(`Qty ${line.quantity}`);
  return {
    primary: line.variantTitle ? `${line.title} — ${line.variantTitle}` : line.title,
    detail: detail.join(' · '),
  };
}

// ── On-screen (HTML) rendering ───────────────────────────────────────────────

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

// WHAT: scoped styles for renderInvoiceBackorderHtml — passed to layout({ extraHead }) by the route.
// CHANGE-GUARD: legibility on a 390px phone is the bar — rows are flex-wrap so the numbers drop UNDER the
//   description instead of squeezing it, `overflow-wrap:anywhere` lets a long unbroken title/SKU wrap,
//   and min-width:0 on flex children stops them stretching the page sideways. Re-check at 390/768/1280
//   after any edit. Strike colour #757575 on white is 4.6:1 (WCAG AA) so struck text stays readable.
export const INVOICE_BACKORDER_CSS = `
.inv-bo{margin-top:16px;padding:14px 16px;background:#fff;border:1px solid var(--gray-200,#e5e7eb);border-radius:8px;max-width:100%;overflow-wrap:anywhere}
.inv-bo-h{margin:0 0 6px;font-size:14px;font-weight:700;color:#111827}
.inv-bo-lines{list-style:none;margin:0;padding:0}
.inv-bo-line{display:flex;flex-wrap:wrap;gap:6px 16px;justify-content:space-between;padding:10px 0;border-top:1px solid var(--gray-200,#e5e7eb)}
.inv-bo-line:first-child{border-top:0;padding-top:0}
.inv-bo-desc{flex:1 1 220px;min-width:0}
.inv-bo-nums{display:flex;flex-wrap:wrap;gap:4px 16px;flex:0 1 auto;min-width:0}
.inv-bo-n{display:flex;flex-direction:column;min-width:0}
.inv-bo-l{font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.4px}
.inv-bo s{color:#757575;text-decoration:line-through;text-decoration-thickness:1.5px}
.inv-bo-title{font-size:14px}
.inv-bo-var{display:block;font-size:13px}
.inv-bo-meta{margin-top:2px;font-size:12px;color:#757575}
.inv-bo-tag{display:inline-block;margin-left:6px;font-weight:700;color:#374151}
.inv-bo-note{margin-top:12px;padding-top:12px;border-top:1px solid var(--gray-200,#e5e7eb);font-size:13px;line-height:1.5;color:#111827}
.inv-bo-note p{margin:0 0 6px}
.inv-bo-items{margin:0;padding-left:18px}
.inv-bo-items li{margin:0 0 6px}
.inv-bo-detail{display:block;color:#374151}
`;

// WHAT: the on-screen backordered block for the invoice viewer page — struck lines, then the footnote.
// Returns '' for a null model. Every dynamic value goes through esc().
export function renderInvoiceBackorderHtml(model) {
  if (!model) return '';
  const rows = model.lines.map(l => `
      <li class="inv-bo-line">
        <div class="inv-bo-desc">
          <s class="inv-bo-title">${esc(l.title)}</s>${l.variantTitle ? `<s class="inv-bo-var">${esc(l.variantTitle)}</s>` : ''}
          <div class="inv-bo-meta">${l.sku ? `SKU ${esc(l.sku)}` : ''}<span class="inv-bo-tag">${esc(model.tag)}</span></div>
        </div>
        <div class="inv-bo-nums">
          <span class="inv-bo-n"><span class="inv-bo-l">Qty</span><s>${esc(l.quantity)}</s></span>
          <span class="inv-bo-n"><span class="inv-bo-l">Unit price</span><s>${esc(l.unitPriceLabel)}</s></span>
          <span class="inv-bo-n"><span class="inv-bo-l">Total</span><s>${esc(l.lineTotalLabel)}</s></span>
        </div>
      </li>`).join('');
  const items = model.footnote.items.map(i =>
    `<li>${esc(i.primary)}<span class="inv-bo-detail">${esc(i.detail)}</span></li>`).join('');
  return `
    <section class="inv-bo" id="invoice-backorders" aria-label="Backordered items on this invoice">
      <ul class="inv-bo-lines">${rows}
      </ul>
      <div class="inv-bo-note">
        <h2 class="inv-bo-h">${esc(model.footnote.heading)}</h2>
        <p>${esc(model.footnote.intro)}</p>
        <ul class="inv-bo-items">${items}</ul>
      </div>
    </section>`;
}
