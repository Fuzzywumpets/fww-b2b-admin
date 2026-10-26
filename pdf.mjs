import { currentShippingAmount } from './lib/order-shipping.mjs';
import { buildInvoiceBackorderModel } from './lib/invoice-backorder.mjs';
import PDFDocument from 'pdfkit';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(__dirname, 'assets');
const FONTS = join(ASSETS, 'fonts');

// Brand palette — but text stays BLACK per alexa's spec
const LIME = '#9BBC0E';          // accent only (top bar, divider)
const BLACK = '#000000';          // all text
const MUTED = '#000000';          // labels still black per spec — using opacity for hierarchy

// Pre-load font + logo paths
const FONT_PATHS = {
  'Inter':         join(FONTS, 'Inter-Regular.ttf'),
  'Inter-SemiBold':join(FONTS, 'Inter-SemiBold.ttf'),
  'Inter-Bold':    join(FONTS, 'Inter-Bold.ttf'),
  'Playfair':      join(FONTS, 'PlayfairDisplay-Regular.ttf'),
  'Playfair-Bold': join(FONTS, 'PlayfairDisplay-Bold.ttf'),
};
const LOGO_PATH = join(ASSETS, 'logo.png');

// ── Shared invoice line math (ORDER-LEVEL + LINE-LEVEL discount aware) ─────────
// WHAT: returns a line item's post-ALL-discounts total for its CURRENT (post-edit) quantity.
// WHY: discountedUnitPriceSet/discountedTotalSet bake in LINE-level (targetSelection EXPLICIT)
//   discounts only. ORDER/CART-level discounts (a discountAllocation whose
//   discountApplication.targetSelection === 'ALL', e.g. SparkLayer 50% ACROSS on #37637) are NOT
//   reflected in those price sets — so we must subtract them here, or the invoice doubles
//   (1825.82 vs the real 912.91). Per-line-discounted orders (#37639) carry NO 'ALL' allocation,
//   so they are unchanged (cartAlloc 0) and stay correct.
// HOW: start from discountedTotalSet (line total after LINE discounts, computed on the ORIGINAL
//   quantity q), subtract the sum of cart-level ('ALL') allocations (also computed on q), then
//   prorate to the current quantity (cq/q). Falls back to discountedUnitPrice*q when
//   discountedTotalSet is absent (mock fixtures / partial-invoice snapshots that predate this field).
// INVARIANT(S): a line with currentQuantity 0 (removed in an edit) contributes 0; quantity is the
//   ORIGINAL Shopify quantity the discountedTotalSet/allocations were computed against; presentment
//   money only. Keep this the single source of truth shared by buildInvoiceCsv (CSV) and the PDF row
//   loop so the two documents never disagree.
function liNum(s) { return parseFloat(s?.presentmentMoney?.amount ?? 0) || 0; }
// WHAT: true when a money field is actually PRESENT, regardless of its value.
// WHY: liNum ends in `|| 0`, so a legitimate "0.00" parses to 0 — falsy. Using `liNum(x) || liNum(y)`
//   to mean "x, falling back to y when x is absent" therefore treats a genuine ZERO as "absent" and
//   substitutes the undiscounted price. A 100%-comped line (Shopify returns discountedUnitPriceSet
//   "0.00" and charges the customer nothing) was invoiced at full list on the PDF, the CSV, and the
//   persisted partial-invoice snapshot. Presence must be tested on the amount STRING, not on the
//   parsed number.
// DEPENDS: lineItemTrueTotal below — the only reason this exists; do not "simplify" those guards
//   back to `||`.
function liHas(s) { return s?.presentmentMoney?.amount != null; }
export function lineItemCurrentQty(item) {
  return item.currentQuantity != null ? item.currentQuantity : (item.quantity || 0);
}
export function lineItemCartDiscount(item) {
  return (item.discountAllocations || [])
    .filter(a => a?.discountApplication?.targetSelection === 'ALL')
    .reduce((s, a) => s + liNum(a.allocatedAmountSet), 0);
}
export function lineItemTrueTotal(item) {
  const cq = lineItemCurrentQty(item);
  if (cq <= 0) return 0;
  const q  = item.quantity || cq || 1;
  // Presence-checked, NOT truthiness-checked — a comped line legitimately reports 0.00 and must
  // stay 0.00 rather than falling back to the list price. See liHas above.
  const du = liHas(item.discountedUnitPriceSet) ? liNum(item.discountedUnitPriceSet) : liNum(item.originalUnitPriceSet);
  const dt = liHas(item.discountedTotalSet) ? liNum(item.discountedTotalSet) : (du * q);   // fallback when discountedTotalSet absent
  const cartAlloc = lineItemCartDiscount(item);
  return (dt - cartAlloc) * (cq / q);
}
// Per-unit price to DISPLAY (post-all-discounts). For order-level discounts this is below the
// list/discountedUnitPrice; for line-level it equals discountedUnitPrice.
export function lineItemTrueUnit(item) {
  const cq = lineItemCurrentQty(item);
  if (cq <= 0) return 0;
  return lineItemTrueTotal(item) / cq;
}

// WHAT: the explicit discount allocated to the CURRENT quantity of one line.
// WHY: invoices must show the customer's discount, not hide it by printing only net unit prices.
// Shopify bakes EXPLICIT discounts into discountedTotalSet but leaves ALL/cart discounts outside it,
// so summing every allocation and adding it back to lineItemTrueTotal reconstructs the honest
// pre-discount merchandise amount across both representations.
// DEPENDS: partial-invoice snapshots persist this as invoiceDiscountAmount because their archived
// quantity/pricing must not depend on whatever the live Shopify order looks like when re-downloaded.
export function lineItemInvoiceDiscount(item) {
  const cq = lineItemCurrentQty(item);
  if (cq <= 0) return 0;
  if (item.invoiceDiscountAmount != null) return parseFloat(item.invoiceDiscountAmount) || 0;
  const q = item.quantity || cq || 1;
  const allocated = (item.discountAllocations || [])
    .reduce((sum, allocation) => sum + liNum(allocation?.allocatedAmountSet), 0);
  return allocated * (cq / q);
}

export function lineItemInvoiceGrossTotal(item) {
  return lineItemTrueTotal(item) + lineItemInvoiceDiscount(item);
}

export function lineItemInvoiceGrossUnit(item) {
  const cq = lineItemCurrentQty(item);
  return cq > 0 ? lineItemInvoiceGrossTotal(item) / cq : 0;
}

// Shopify order edits can bake the variant into lineItem.title (for example,
// "Luxe Limited Slip Collar - Booth — XXS / 1/2\"") while also returning the
// same value in variant.title. Invoices render those as separate fields, so
// remove only an exact trailing copy; ordinary product-name punctuation stays.
export function invoiceItemTitle(item) {
  const title = String(item?.title || '—').trim();
  const variant = String(item?.variant?.title || item?.variantTitle || '').trim();
  if (!variant || variant === 'Default Title') return title;
  for (const separator of [' — ', ' - ']) {
    const suffix = separator + variant;
    if (title.endsWith(suffix)) return title.slice(0, -suffix.length).trim();
  }
  return title;
}

// WHAT: the backordered-lines display model for the ORDER invoice (struck rows + footnote), or null.
// WHY: backordered units are REMOVED from the Shopify order (db.mjs `backorders` table), so the order's own
//   lines no longer mention them. This builds the one model both the PDF (generateInvoicePdf) and the HTML
//   viewer (server.mjs GET /orders/:id/invoice) render; the wording lives in lib/invoice-backorder.mjs.
// DEPENDS: invoiceItemTitle above — the same title cleaner the active rows use, so a variant Shopify baked
//   into the title is not printed twice on the struck rows either.
export function buildOrderInvoiceBackorderModel(rows) {
  return buildInvoiceBackorderModel(rows, { displayTitle: invoiceItemTitle });
}

// ── Backordered section geometry (struck rows + footnote) ──────────────────────────────────────────────
// SYNC: the column x/width literals in generateInvoicePdf's backordered-rows block (title 56/210, SKU 276/100,
//   QTY 385/40, UNIT 430/65, TOTAL 500/62) mirror drawTableHeader and the active-row loop — struck rows must
//   sit in the same columns; move one, move all three. BO_ROW_LIMIT mirrors the active rows' `y + rowH > 694`.
const BO_GREY = '#757575';        // struck text — muted, but still AA-contrast on white (4.6:1)
const BO_STRIKE = '#444444';      // the line itself is darker than the text so it reads at 0.5pt
const BO_ROW_LIMIT = 694;         // same page-break threshold as the active item rows
const BO_FOOT_LIMIT = 700;        // lowest y the footnote may reach: the page footer is drawn at y=720
const BO_TITLE_LINES = 4, BO_VARIANT_LINES = 3;   // wrapped, then clipped with an ellipsis beyond this

// WHAT: wraps `text` into `width` at the CURRENT font/size, clipped to `maxLines` with an ellipsis.
// WHY: pdfkit does not clip table cells — a long title/variant would run into the next column or off the
//   page. Returns the pdfkit text options that enforce the clip plus the height it will occupy.
// INVARIANT(S): callers must set doc.font()/fontSize() BEFORE calling; the height is in the same units
//   (incl. lineGap) pdfkit advances doc.y by, so rows can be stacked from it exactly.
function clampedText(doc, text, width, maxLines, lineGap = 1) {
  const lineH = doc.currentLineHeight(true) + lineGap;
  const full = doc.heightOfString(text, { width, lineGap });
  return {
    height: Math.min(Math.ceil(full), Math.ceil(lineH * maxLines)),
    opts: { width, lineGap, height: lineH * maxLines, ellipsis: true },
  };
}

// WHAT: the largest font size <= `size` (floor `min`) at which `text` fits `width` on one line, at the CURRENT
//   font. Leaves the doc's font size set to the returned value.
function fontSizeToFit(doc, text, width, size, min = 6.5) {
  let s = size;
  doc.fontSize(s);
  while (s > min && doc.widthOfString(text) > width) { s -= 0.5; doc.fontSize(s); }
  return s;
}

// WHAT: single-line text trimmed with an ellipsis so it fits `width` at the CURRENT font/size.
function fitOneLine(doc, text, width) {
  if (doc.widthOfString(text) <= width) return text;
  let t = text;
  while (t.length > 1 && doc.widthOfString(t + '…') > width) t = t.slice(0, -1);
  return t + '…';
}

function registerBrandFonts(doc) {
  for (const [name, path] of Object.entries(FONT_PATHS)) {
    if (existsSync(path)) {
      try { doc.registerFont(name, path); }
      catch (e) { console.error(`Font ${name} register failed:`, e.message); }
    }
  }
}

// WHAT: renders a branded B2B invoice PDF (pdfkit) from a Shopify order, with optional opts overrides for partial invoices (lineItems/subtotal/shipping/total/invoiceSuffix/paymentTerms).
// CHANGE-GUARD: line rows use fixed heights + lineBreak:false + ellipsis and an explicit y>680 page-break; long titles/skus or added columns can overlap or push the footer off-page — re-render a multi-page order and an unpaid order (PAYMENT PENDING watermark) after layout edits.
// INVARIANT(S): undiscounted invoices show post-discount unit prices directly; invoices with allocated
// discounts show reconstructed pre-discount rows plus one negative Discount total. When opts.subtotal
// is supplied, partial-invoice totals come from opts and must already be reconciled by the caller;
// all text is black per brand spec (lime is accent-only; the struck BACKORDERED rows are the one
// deliberate exception — muted grey).
// opts.backorderedLines (ORDER invoice only): db.mjs getBackorderedLinesForOrder() rows — units removed from
//   the Shopify order. They are drawn AFTER the active rows, struck through and tagged, and itemised in a
//   footnote below the totals. With none (absent/empty) every byte of the page content is exactly what it was
//   before this option existed (test/invoice-backorder.test.mjs pins that with goldens).
//   They are NEVER summed: subtotal/shipping/tax/total come from the Shopify order (which no longer holds the
//   removed units) or from opts.subtotal/total, and `lineItems`/discount math never sees these rows.
// DEPENDS: callers pass opts.backorderedLines ONLY from the full-order invoice routes (server.mjs
//   GET /orders/:id/invoice.pdf). Partial-invoice snapshots (POST/GET /orders/:id/partial-invoice*) must not.
export async function generateInvoicePdf(order, opts = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'LETTER', autoFirstPage: true });
    registerBrandFonts(doc);
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const invoiceName = opts.invoiceSuffix
      ? `${order.name || '—'}-${opts.invoiceSuffix}`
      : (order.name || '—');

    // ─── Top lime accent bar ────────────────────────────────────────
    doc.rect(0, 0, 612, 6).fill(LIME);

    // ─── Logo (left) ────────────────────────────────────────────────
    if (existsSync(LOGO_PATH)) {
      try { doc.image(LOGO_PATH, 50, 22, { width: 110 }); }
      catch (e) {
        // Fallback to wordmark
        doc.fontSize(20).font('Inter-Bold').fillColor(BLACK).text('FUZZYWUMPETS', 50, 30);
      }
    } else {
      doc.fontSize(20).font('Inter-Bold').fillColor(BLACK).text('FUZZYWUMPETS', 50, 30);
    }

    // Tagline under logo
    doc.fontSize(8).font('Inter').fillColor(BLACK).text(
      'Part Two Enterprises, Inc.  ·  fuzzywumpets.com',
      50, 138
    );

    // ─── Invoice headline (right) ───────────────────────────────────
    doc.fontSize(24).font('Playfair-Bold').fillColor(BLACK).text('INVOICE', 400, 28, {
      align: 'right',
      width: 162,
      characterSpacing: 1,
    });
    doc.fontSize(10).font('Inter').fillColor(BLACK);
    doc.text(`Order: ${invoiceName}`, 400, 64, { align: 'right', width: 162 });
    doc.text(`Date: ${fmtDate(order.processedAt)}`, 400, 79, { align: 'right', width: 162 });
    if (order.customer?.email) {
      doc.text(order.customer.email, 400, 94, { align: 'right', width: 162 });
    }

    // ─── PAYMENT PENDING status (only when unpaid) ─────────────────
    // Keep status in the header. A diagonal watermark crossed the item table
    // and made dense wholesale invoices materially harder to read.
    const isPaid = order.displayFinancialStatus === 'PAID';
    if (!isPaid) {
      doc.roundedRect(428, 112, 134, 24, 4).lineWidth(1).strokeColor(LIME).stroke();
      doc.fontSize(8).font('Inter-Bold').fillColor(BLACK)
        .text('PAYMENT PENDING', 436, 120, { width: 118, align: 'center', lineBreak: false });
    }

    // ─── Lime divider ──────────────────────────────────────────────
    doc.moveTo(50, 160).lineTo(562, 160).lineWidth(1.5).strokeColor(LIME).stroke();

    // ─── BILL TO / SHIP TO ─────────────────────────────────────────
    const cust = order.customer || {};
    const addr = order.shippingAddress || {};
    const billAddr = order.billingAddress || addr;
    const billY = 178;

    doc.fontSize(8).font('Inter-Bold').fillColor(BLACK).opacity(0.6).text('BILL TO', 50, billY);
    doc.opacity(1);
    doc.fontSize(11).font('Inter-Bold').fillColor(BLACK).text(
      cust.company || cust.displayName || '—', 50, billY + 12
    );
    doc.fontSize(9).font('Inter').fillColor(BLACK);
    let by = billY + 28;
    if (cust.company && cust.displayName && cust.displayName !== cust.company) {
      doc.text(`c/o ${cust.displayName}`, 50, by); by += 12;
    }
    if (cust.email) { doc.text(cust.email, 50, by); by += 12; }
    if (billAddr.address1) {
      doc.text(`${billAddr.address1}${billAddr.address2 ? ', ' + billAddr.address2 : ''}`, 50, by); by += 12;
      doc.text(`${billAddr.city || ''}, ${billAddr.province || ''} ${billAddr.zip || ''}`.trim(), 50, by); by += 12;
      if (billAddr.country && billAddr.country !== 'United States') {
        doc.text(billAddr.country, 50, by);
      }
    }

    doc.fontSize(8).font('Inter-Bold').fillColor(BLACK).opacity(0.6).text('SHIP TO', 320, billY);
    doc.opacity(1);
    doc.fontSize(11).font('Inter-Bold').fillColor(BLACK).text(
      addr.company || cust.displayName || '—', 320, billY + 12
    );
    doc.fontSize(9).font('Inter').fillColor(BLACK);
    let sy = billY + 28;
    if (addr.address1) {
      doc.text(`${addr.address1}${addr.address2 ? ', ' + addr.address2 : ''}`, 320, sy); sy += 12;
      doc.text(`${addr.city || ''}, ${addr.province || ''} ${addr.zip || ''}`.trim(), 320, sy); sy += 12;
      if (addr.country && addr.country !== 'United States') {
        doc.text(addr.country, 320, sy);
      }
    }

    // ─── Line items table ──────────────────────────────────────────
    function drawTableHeader(top) {
      doc.rect(50, top, 512, 22).fill('#F8F8F8');
      doc.fontSize(8).font('Inter-Bold').fillColor(BLACK);
      doc.text('ITEM', 56, top + 7);
      doc.text('SKU', 276, top + 7);
      doc.text('QTY', 385, top + 7, { width: 40, align: 'right' });
      doc.text('UNIT PRICE', 430, top + 7, { width: 65, align: 'right' });
      doc.text('TOTAL', 500, top + 7, { width: 62, align: 'right' });
    }
    function addContinuationPage(withTable = true) {
      doc.addPage();
      doc.rect(0, 0, 612, 6).fill(LIME);
      doc.fontSize(9).font('Inter-Bold').fillColor(BLACK)
        .text(`INVOICE ${invoiceName} - CONTINUED`, 50, 30, { width: 512, align: 'right', lineBreak: false });
      if (withTable) {
        drawTableHeader(56);
        return 86;
      }
      return 70;
    }

    const tableTop = 285;
    drawTableHeader(tableTop);

    let y = tableTop + 30;
    const lineItems = opts.lineItems ?? (order.lineItems?.edges?.map(e => e.node) || []);
    const inferredDiscount = lineItems.reduce((sum, item) => sum + lineItemInvoiceDiscount(item), 0);
    const discountAmount = opts.discount !== undefined
      ? (parseFloat(opts.discount) || 0)
      : inferredDiscount;
    const showDiscount = discountAmount > 0.004;
    const backorder = buildOrderInvoiceBackorderModel(opts.backorderedLines);   // null => nothing below runs
    doc.font('Inter').fillColor(BLACK);

    for (const item of lineItems) {
      // ORDER-LEVEL discount + post-edit qty: skip lines removed in an edit (currentQuantity 0) and
      // key qty/unit/total off the post-ALL-discounts current line math (shared with buildInvoiceCsv).
      const qty = lineItemCurrentQty(item);
      if (qty <= 0) continue;
      // When a real allocated discount exists, show the pre-discount merchandise values here and
      // itemize the discount once in the totals block. Otherwise the final amount is correct but the
      // discount is invisible, which is not an acceptable customer invoice.
      const unitPrice = showDiscount ? lineItemInvoiceGrossUnit(item) : lineItemTrueUnit(item);
      const rowTotal = showDiscount ? lineItemInvoiceGrossTotal(item) : lineItemTrueTotal(item);
      const variantTitle = (item.variant?.title && item.variant.title !== 'Default Title') ? item.variant.title : null;
      const productTitle = invoiceItemTitle(item);
      doc.fontSize(9.5).font('Inter');
      const titleH = doc.heightOfString(productTitle, { width: 210, lineGap: 1 });
      const rowH = Math.max(20, Math.ceil(titleH) + (variantTitle ? 13 : 0) + 7);
      if (y + rowH > 694) y = addContinuationPage(true);
      doc.fontSize(9.5).font('Inter').fillColor(BLACK);
      doc.text(productTitle, 56, y, { width: 210, lineGap: 1 });
      if (variantTitle) {
        doc.fontSize(8).fillColor('#555555').text(variantTitle, 56, y + titleH + 2, { width: 210, lineBreak: false });
        doc.fontSize(9.5).fillColor(BLACK);
      }
      // SKU: full SKUs run up to 16 chars (e.g. CRSWLK0533258XS8).
      doc.fontSize(8.5);
      doc.text(String(item.variant?.sku || item.sku || '—'), 276, y, { width: 100, height: 14, lineBreak: false, ellipsis: true });
      doc.fontSize(9.5);
      doc.text(String(qty), 385, y, { width: 40, height: 14, align: 'right', lineBreak: false });
      doc.text(fmt(unitPrice), 430, y, { width: 65, height: 14, align: 'right', lineBreak: false });
      doc.text(fmt(rowTotal), 500, y, { width: 62, height: 14, align: 'right', lineBreak: false });
      doc.moveTo(50, y + rowH - 4).lineTo(562, y + rowH - 4).lineWidth(0.5).strokeColor('#E5E5E5').stroke();
      y += rowH;
    }

    // ─── Backordered rows: struck through, AFTER the active rows ────────────────────────────────────
    // WHAT: units backordered off this order (removed from Shopify) stay visible but visibly not billed:
    //   muted grey, line-through on description / qty / unit price / line total, plus a "Backordered *" tag.
    // WHY: they vanished from the invoice once removed from the order; the customer should still see them.
    // INVARIANT(S): these rows only DRAW. Nothing below (subtotal, discount, shipping, TOTAL) reads them.
    //   Long titles/variants wrap then clip (clampedText) and the SKU is trimmed to its column, so a row can
    //   never spill into a neighbour; the page-break test is the same as the active rows'.
    if (backorder) {
      const TAG_H = 11;
      for (const bl of backorder.lines) {
        doc.fontSize(9.5).font('Inter');
        const title = clampedText(doc, bl.title, 210, BO_TITLE_LINES);
        let variant = null;
        if (bl.variantTitle) {
          doc.fontSize(8).font('Inter');
          variant = clampedText(doc, bl.variantTitle, 210, BO_VARIANT_LINES);
        }
        const variantBlock = variant ? variant.height + 2 : 0;
        const rowH = Math.max(20, title.height + variantBlock + 2 + TAG_H + 5);
        if (y + rowH > BO_ROW_LIMIT) y = addContinuationPage(true);

        doc.fillColor(BO_GREY).strokeColor(BO_STRIKE);
        doc.fontSize(9.5).font('Inter');
        doc.text(bl.title, 56, y, { ...title.opts, strike: true });
        if (variant) {
          doc.fontSize(8).font('Inter');
          doc.text(bl.variantTitle, 56, y + title.height + 2, { ...variant.opts, strike: true });
        }
        // The tag is NOT struck and darker than the row: it is the part that must stay legible.
        doc.fontSize(8).font('Inter-Bold').fillColor('#444444');
        doc.text(backorder.tag, 56, y + title.height + variantBlock + 2, { width: 210, lineBreak: false });

        doc.fillColor(BO_GREY).font('Inter').fontSize(8.5);
        doc.text(fitOneLine(doc, bl.sku || '—', 100), 276, y, { width: 100, lineBreak: false });
        doc.strokeColor(BO_STRIKE);
        // Each figure is shrunk (never wrapped) until it fits its column — pdfkit would otherwise split an
        // over-wide amount across two lines inside a fixed-height row.
        for (const [label, x, w] of [[String(bl.quantity), 385, 40], [bl.unitPriceLabel, 430, 65], [bl.lineTotalLabel, 500, 62]]) {
          doc.fontSize(fontSizeToFit(doc, label, w, 9.5));
          doc.text(label, x, y, { width: w, align: 'right', lineBreak: false, strike: true });
        }
        doc.moveTo(50, y + rowH - 4).lineTo(562, y + rowH - 4).lineWidth(0.5).strokeColor('#E5E5E5').stroke();
        y += rowH;
      }
      doc.fillColor(BLACK).font('Inter');
    }

    // ─── Totals ────────────────────────────────────────────────────
    y += 12;
    if (y > 650) y = addContinuationPage(false);
    let sub, ship, total;
    if (opts.subtotal !== undefined) {
      sub   = parseFloat(opts.subtotal) || 0;
      ship  = parseFloat(opts.shipping) || 0;
      total = parseFloat(opts.total) || 0;
    } else {
      // HARD REQUIREMENT: invoice subtotal MUST equal Shopify's currentSubtotalPriceSet (the post-edit,
      // post-ALL-discounts truth — 912.91 for #37637, NOT the frozen 1825.82). Prefer current* and fall
      // back to the frozen subtotal/total only when current* is absent (older orders / mock fixtures
      // that don't carry the current sets). Using Shopify's authoritative aggregate also guarantees
      // EXACT equality even where summing rounded per-line totals would drift by a cent.
      const curSub = order.currentSubtotalPriceSet?.presentmentMoney?.amount;
      const curTot = order.currentTotalPriceSet?.presentmentMoney?.amount;
      sub   = parseFloat(curSub ?? order.subtotalPriceSet?.presentmentMoney?.amount ?? 0) || 0;
      ship  = currentShippingAmount(order);
      total = parseFloat(curTot ?? order.totalPriceSet?.presentmentMoney?.amount ?? 0) || 0;
    }

    // WHAT: geometry for the totals block — every cell right-aligns to the same edge as the lime rule.
    // WHY: the amount cells were a hardcoded 62pt wide. "$3,205.95" at 13pt Inter-Bold is wider than
    //   that, so pdfkit WRAPPED the TOTAL mid-number and the invoice read "TOTAL $3,205.9 / 5"
    //   (alexa 2026-08-17). 62pt only ever fit 4-figure-and-under amounts at the smaller subtotal size.
    // CHANGE-GUARD: AMT_W must stay wide enough for the largest realistic total at the TOTAL font size
    //   (13pt bold) — 100pt clears $999,999.99. `lineBreak: false` is the belt-and-braces half: it
    //   makes an over-wide amount overflow leftward on ONE line instead of splitting the digits, which
    //   is the failure that shipped. Keep both; widening alone is not a guarantee.
    // SYNC: the lime rule below and all three rows share TOTALS_RIGHT — move one, move them all.
    const TOTALS_RIGHT = 562;
    const AMT_W   = 100;
    const AMT_X   = TOTALS_RIGHT - AMT_W;
    const LABEL_W = 100;
    const LABEL_X = AMT_X - LABEL_W;

    const displayedSubtotal = opts.grossSubtotal !== undefined
      ? (parseFloat(opts.grossSubtotal) || 0)
      : sub + discountAmount;

    doc.fontSize(10).font('Inter').fillColor(BLACK);
    doc.text('Subtotal', LABEL_X, y, { width: LABEL_W, align: 'right', lineBreak: false });
    doc.text(fmt(displayedSubtotal), AMT_X, y, { width: AMT_W, align: 'right', lineBreak: false });
    y += 16;
    if (showDiscount) {
      doc.text('Discount', LABEL_X, y, { width: LABEL_W, align: 'right', lineBreak: false });
      doc.text(fmt(-discountAmount), AMT_X, y, { width: AMT_W, align: 'right', lineBreak: false });
      y += 16;
    }
    if (ship > 0) {
      doc.text('Shipping', LABEL_X, y, { width: LABEL_W, align: 'right', lineBreak: false });
      doc.text(fmt(ship), AMT_X, y, { width: AMT_W, align: 'right', lineBreak: false });
      y += 16;
    }
    doc.moveTo(400, y + 2).lineTo(TOTALS_RIGHT, y + 2).lineWidth(1.5).strokeColor(LIME).stroke();
    y += 10;
    doc.fontSize(13).font('Inter-Bold').fillColor(BLACK);
    doc.text('TOTAL', LABEL_X, y, { width: LABEL_W, align: 'right', lineBreak: false });
    doc.text(fmt(total), AMT_X, y, { width: AMT_W, align: 'right', lineBreak: false });
    let contentBottom = y + 18;   // lowest drawn point so far on the current page (13pt TOTAL row)

    // ─── Payment terms (B2B-specific) ──────────────────────────────
    if (opts.paymentTerms) {
      y += 40;
      doc.fontSize(8).font('Inter-Bold').fillColor(BLACK).opacity(0.6).text('PAYMENT TERMS', 50, y);
      doc.opacity(1);
      y += 12;
      doc.fontSize(10).font('Inter').fillColor(BLACK).text(opts.paymentTerms, 50, y, { width: 512 });
      contentBottom = doc.y;
    }

    // ─── Customer notes (order.note) — prints on the customer invoice (alexa 2026-07-01) ──
    // This is the "Customer notes" field from the order page. The staff-only "Internal note"
    // (order_internal_notes table) is separate and is NOT passed to the PDF.
    if (order.note) {
      y += 32;
      doc.fontSize(8).font('Inter-Bold').fillColor(BLACK).opacity(0.6).text('NOTES', 50, y);
      doc.opacity(1);
      y += 12;
      doc.fontSize(10).font('Inter').fillColor(BLACK).text(order.note, 50, y, { width: 512 });
      contentBottom = doc.y;
    }

    // ─── Backorder footnote — bottom of the invoice, below totals / terms / notes ───────────────────
    // WHAT: heading + one plain sentence + one entry per backordered variant (wording: lib/invoice-backorder.mjs).
    // CHANGE-GUARD: it must never overlap the totals block or the page footer (drawn at y=720) and never clip:
    //   it starts below `contentBottom`; if the heading + intro + first entry do not fit above BO_FOOT_LIMIT it
    //   starts on a fresh continuation page, and each further entry that does not fit moves to a new
    //   continuation page under a "(continued)" heading. Entries are measured before they are drawn.
    if (backorder) {
      const fn = backorder.footnote;
      const BULLET_W = 12, ITEM_W = 512 - BULLET_W;
      doc.fontSize(9).font('Inter-Bold');
      const headH = Math.ceil(doc.heightOfString(fn.heading, { width: 512 }));
      doc.font('Inter');
      const introH = Math.ceil(doc.heightOfString(fn.intro, { width: 512, lineGap: 1 }));
      const blocks = fn.items.map(item => {
        doc.fontSize(9).font('Inter-SemiBold');
        const primary = clampedText(doc, item.primary, ITEM_W, 3);
        doc.fontSize(8.5).font('Inter');
        const detail = clampedText(doc, item.detail, ITEM_W, 2);
        return { item, primary, detail, h: primary.height + detail.height + 6 };
      });
      const drawHeading = (text, top) => {
        doc.fontSize(9).font('Inter-Bold').fillColor(BLACK).text(text, 50, top, { width: 512, lineBreak: false });
        return top + headH + 3;
      };

      let fy = contentBottom + 24;
      if (fy + headH + 3 + introH + 6 + blocks[0].h > BO_FOOT_LIMIT) fy = addContinuationPage(false);
      else doc.moveTo(50, fy - 10).lineTo(562, fy - 10).lineWidth(0.5).strokeColor('#E5E5E5').stroke();
      fy = drawHeading(fn.heading, fy);
      doc.fontSize(9).font('Inter').fillColor(BLACK).text(fn.intro, 50, fy, { width: 512, lineGap: 1 });
      fy += introH + 6;
      for (const b of blocks) {
        if (fy + b.h > BO_FOOT_LIMIT) {
          fy = addContinuationPage(false);
          fy = drawHeading(fn.headingContinued, fy);
        }
        doc.fontSize(9).font('Inter').fillColor(BLACK).text('•', 50, fy, { width: BULLET_W, lineBreak: false });
        doc.fontSize(9).font('Inter-SemiBold').text(b.item.primary, 50 + BULLET_W, fy, { ...b.primary.opts });
        doc.fontSize(8.5).font('Inter').fillColor('#333333').text(b.item.detail, 50 + BULLET_W, fy + b.primary.height, { ...b.detail.opts });
        fy += b.h;
      }
      doc.fillColor(BLACK).font('Inter');
    }

    // ─── Footer — y=720 sits inside the default bottom margin (742) so no auto-page-break ──
    doc.fontSize(8).font('Inter').fillColor(BLACK).opacity(0.6).text(
      'Thank you for your business!  ·  Questions? alex@fuzzywumpets.com  ·  fuzzywumpets.com',
      50, 720, { align: 'center', width: 512, lineBreak: false }
    );
    doc.opacity(1);

    doc.end();
  });
}

function fmt(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(n) || 0);
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
