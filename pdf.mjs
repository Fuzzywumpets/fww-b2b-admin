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
// INVARIANT(S): unit price falls back discountedUnitPrice -> originalUnitPrice -> 0; when opts.subtotal is supplied the totals come entirely from opts (partial-invoice path) and must already be reconciled by the caller; all text is black per brand spec (lime is accent-only).
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

    // ─── PAYMENT PENDING watermark (only when unpaid) ──────────────
    // lineBreak:false prevents pdfkit auto-pagination from rotated text
    const isPaid = order.displayFinancialStatus === 'PAID';
    if (!isPaid) {
      doc.save();
      doc.rotate(-20, { origin: [306, 280] });
      doc.fontSize(48).font('Playfair-Bold').fillColor(BLACK).opacity(0.08)
        .text('PAYMENT PENDING', 56, 245, { width: 500, align: 'center', lineBreak: false });
      doc.restore();
      doc.opacity(1);
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
    const tableTop = 285;
    doc.rect(50, tableTop, 512, 22).fill('#F8F8F8');
    doc.fontSize(8).font('Inter-Bold').fillColor(BLACK);
    doc.text('ITEM', 56, tableTop + 7);
    doc.text('SKU', 285, tableTop + 7);
    doc.text('QTY', 385, tableTop + 7, { width: 40, align: 'right' });
    doc.text('UNIT PRICE', 430, tableTop + 7, { width: 65, align: 'right' });
    doc.text('TOTAL', 500, tableTop + 7, { width: 62, align: 'right' });

    let y = tableTop + 30;
    const lineItems = opts.lineItems ?? (order.lineItems?.edges?.map(e => e.node) || []);
    doc.font('Inter').fillColor(BLACK);

    // Truncate-with-ellipsis helper that respects column width
    function fitText(s, maxChars) {
      s = String(s || '—');
      return s.length > maxChars ? s.slice(0, maxChars - 1) + '…' : s;
    }

    for (const item of lineItems) {
      // ORDER-LEVEL discount + post-edit qty: skip lines removed in an edit (currentQuantity 0) and
      // key qty/unit/total off the post-ALL-discounts current line math (shared with buildInvoiceCsv).
      const qty = lineItemCurrentQty(item);
      if (qty <= 0) continue;
      if (y > 680) {
        doc.addPage();
        y = 50;
      }
      const unitPrice = lineItemTrueUnit(item);
      const rowTotal = lineItemTrueTotal(item);
      // Use fixed height: 1 line per row, truncate overflow. height:14 + ellipsis prevents wrap.
      const variantTitle = (item.variant?.title && item.variant.title !== 'Default Title') ? item.variant.title : null;
      const rowH = variantTitle ? 32 : 20;
      doc.fontSize(9.5).fillColor(BLACK);
      doc.text(fitText(item.title, 37), 56, y, { width: 224, height: 14, lineBreak: false, ellipsis: true });
      if (variantTitle) {
        doc.fontSize(8).fillColor('#555555').text(fitText(variantTitle, 50), 56, y + 13, { width: 224, height: 12, lineBreak: false, ellipsis: true });
        doc.fontSize(9.5).fillColor(BLACK);
      }
      // SKU: full SKUs run up to 16 chars (e.g. CRSWLK0533258XS8); 8.5pt + 90px column fits them without truncation.
      doc.fontSize(8.5);
      doc.text(fitText(item.variant?.sku, 20), 285, y, { width: 90, height: 14, lineBreak: false, ellipsis: true });
      doc.fontSize(9.5);
      doc.text(String(qty), 385, y, { width: 40, height: 14, align: 'right', lineBreak: false });
      doc.text(fmt(unitPrice), 430, y, { width: 65, height: 14, align: 'right', lineBreak: false });
      doc.text(fmt(rowTotal), 500, y, { width: 62, height: 14, align: 'right', lineBreak: false });
      doc.moveTo(50, y + rowH - 4).lineTo(562, y + rowH - 4).lineWidth(0.5).strokeColor('#E5E5E5').stroke();
      y += rowH;
    }

    // ─── Totals ────────────────────────────────────────────────────
    y += 12;
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
      ship  = parseFloat(order.totalShippingPriceSet?.presentmentMoney?.amount || 0);
      total = parseFloat(curTot ?? order.totalPriceSet?.presentmentMoney?.amount ?? 0) || 0;
    }

    doc.fontSize(10).font('Inter').fillColor(BLACK);
    doc.text('Subtotal', 400, y, { width: 100, align: 'right' });
    doc.text(fmt(sub), 500, y, { width: 62, align: 'right' });
    y += 16;
    if (ship > 0) {
      doc.text('Shipping', 400, y, { width: 100, align: 'right' });
      doc.text(fmt(ship), 500, y, { width: 62, align: 'right' });
      y += 16;
    }
    doc.moveTo(400, y + 2).lineTo(562, y + 2).lineWidth(1.5).strokeColor(LIME).stroke();
    y += 10;
    doc.fontSize(13).font('Inter-Bold').fillColor(BLACK);
    doc.text('TOTAL', 400, y, { width: 100, align: 'right' });
    doc.text(fmt(total), 500, y, { width: 62, align: 'right' });

    // ─── Payment terms (B2B-specific) ──────────────────────────────
    if (opts.paymentTerms) {
      y += 40;
      doc.fontSize(8).font('Inter-Bold').fillColor(BLACK).opacity(0.6).text('PAYMENT TERMS', 50, y);
      doc.opacity(1);
      y += 12;
      doc.fontSize(10).font('Inter').fillColor(BLACK).text(opts.paymentTerms, 50, y, { width: 512 });
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
