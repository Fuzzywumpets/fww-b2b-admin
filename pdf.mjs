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

function registerBrandFonts(doc) {
  for (const [name, path] of Object.entries(FONT_PATHS)) {
    if (existsSync(path)) {
      try { doc.registerFont(name, path); }
      catch (e) { console.error(`Font ${name} register failed:`, e.message); }
    }
  }
}

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
    doc.text('SKU', 310, tableTop + 7);
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
      if (y > 680) {
        doc.addPage();
        y = 50;
      }
      const unitPrice = parseFloat(
        item.discountedUnitPriceSet?.presentmentMoney?.amount
        ?? item.originalUnitPriceSet?.presentmentMoney?.amount
        ?? 0
      );
      const rowTotal = unitPrice * (item.quantity || 0);
      // Use fixed height: 1 line per row, truncate overflow. height:14 + ellipsis prevents wrap.
      const variantTitle = (item.variant?.title && item.variant.title !== 'Default Title') ? item.variant.title : null;
      const rowH = variantTitle ? 32 : 20;
      doc.fontSize(9.5).fillColor(BLACK);
      doc.text(fitText(item.title, 42), 56, y, { width: 248, height: 14, lineBreak: false, ellipsis: true });
      if (variantTitle) {
        doc.fontSize(8).fillColor('#555555').text(fitText(variantTitle, 50), 56, y + 13, { width: 248, height: 12, lineBreak: false, ellipsis: true });
        doc.fontSize(9.5).fillColor(BLACK);
      }
      doc.text(fitText(item.variant?.sku, 14), 310, y, { width: 70, height: 14, lineBreak: false, ellipsis: true });
      doc.text(String(item.quantity || 0), 385, y, { width: 40, height: 14, align: 'right', lineBreak: false });
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
      sub   = parseFloat(order.subtotalPriceSet?.presentmentMoney?.amount || 0);
      ship  = parseFloat(order.totalShippingPriceSet?.presentmentMoney?.amount || 0);
      total = parseFloat(order.totalPriceSet?.presentmentMoney?.amount || 0);
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

    // ─── Order notes ───────────────────────────────────────────────
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
