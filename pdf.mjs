import PDFDocument from 'pdfkit';

const LIME = '#9BBC0E';
const DARK = '#1a1f2e';

export async function generateInvoicePdf(order) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'LETTER', autoFirstPage: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Top accent bar
    doc.rect(0, 0, 612, 6).fill(LIME);

    // Company
    doc.fontSize(20).font('Helvetica-Bold').fillColor(DARK).text('FUZZYWUMPETS', 50, 28);
    doc.fontSize(9).font('Helvetica').fillColor('#6B7280').text('Part Two Enterprises, Inc. · fuzzywumpets.com', 50, 52);

    // Invoice meta (right)
    doc.fontSize(17).font('Helvetica-Bold').fillColor(DARK).text('INVOICE', 400, 28, { align: 'right', width: 162 });
    doc.fontSize(10).font('Helvetica').fillColor('#374151');
    doc.text(`Order: ${order.name || '—'}`, 400, 52, { align: 'right', width: 162 });
    doc.text(`Date: ${fmtDate(order.processedAt)}`, 400, 67, { align: 'right', width: 162 });

    // PAYMENT PENDING watermark
    const isPaid = order.displayFinancialStatus === 'PAID';
    if (!isPaid) {
      doc.save();
      doc.rotate(-20, { origin: [306, 200] });
      doc.fontSize(42).font('Helvetica-Bold').fillColor('#DC2626').opacity(0.12)
        .text('PAYMENT PENDING', 56, 165, { width: 500, align: 'center' });
      doc.restore();
      doc.opacity(1);
    }

    // Divider
    doc.moveTo(50, 78).lineTo(562, 78).lineWidth(1).strokeColor(LIME).stroke();

    // Bill To / Ship To
    const cust = order.customer || {};
    const addr = order.shippingAddress || {};
    const billAddr = order.billingAddress || addr;

    doc.fontSize(8).font('Helvetica-Bold').fillColor('#6B7280').text('BILL TO', 50, 92);
    doc.fontSize(10).font('Helvetica-Bold').fillColor(DARK).text(cust.displayName || '—', 50, 104);
    doc.fontSize(9).font('Helvetica').fillColor('#374151');
    if (cust.email) doc.text(cust.email, 50, 118);
    if (billAddr.address1) {
      doc.text(`${billAddr.address1}${billAddr.address2 ? ', ' + billAddr.address2 : ''}`, 50, 132);
      doc.text(`${billAddr.city || ''}, ${billAddr.province || ''} ${billAddr.zip || ''}`.trim(), 50, 146);
    }

    doc.fontSize(8).font('Helvetica-Bold').fillColor('#6B7280').text('SHIP TO', 350, 92);
    doc.fontSize(10).font('Helvetica-Bold').fillColor(DARK).text(cust.displayName || '—', 350, 104);
    doc.fontSize(9).font('Helvetica').fillColor('#374151');
    if (addr.address1) {
      doc.text(`${addr.address1}${addr.address2 ? ', ' + addr.address2 : ''}`, 350, 118);
      doc.text(`${addr.city || ''}, ${addr.province || ''} ${addr.zip || ''}`.trim(), 350, 132);
    }

    // Line items table header
    const tableTop = 185;
    doc.rect(50, tableTop, 512, 17).fill('#F3F4F6');
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#374151');
    doc.text('ITEM', 56, tableTop + 5);
    doc.text('SKU', 310, tableTop + 5);
    doc.text('QTY', 385, tableTop + 5, { width: 40, align: 'right' });
    doc.text('UNIT PRICE', 430, tableTop + 5, { width: 65, align: 'right' });
    doc.text('TOTAL', 500, tableTop + 5, { width: 62, align: 'right' });

    let y = tableTop + 24;
    const lineItems = order.lineItems?.edges?.map(e => e.node) || [];
    doc.font('Helvetica').fillColor('#374151');

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
      doc.fontSize(9.5).text(item.title || '—', 56, y, { width: 248, lineBreak: false });
      doc.text(item.variant?.sku || '—', 310, y, { width: 70, lineBreak: false });
      doc.text(String(item.quantity), 385, y, { width: 40, align: 'right', lineBreak: false });
      doc.text(fmt(unitPrice), 430, y, { width: 65, align: 'right', lineBreak: false });
      doc.text(fmt(rowTotal), 500, y, { width: 62, align: 'right', lineBreak: false });
      doc.moveTo(50, y + 14).lineTo(562, y + 14).lineWidth(0.5).strokeColor('#E5E7EB').stroke();
      y += 18;
    }

    // Totals
    y += 8;
    const sub   = parseFloat(order.subtotalPriceSet?.presentmentMoney?.amount || 0);
    const ship  = parseFloat(order.totalShippingPriceSet?.presentmentMoney?.amount || 0);
    const total = parseFloat(order.totalPriceSet?.presentmentMoney?.amount || 0);

    doc.fontSize(9.5).font('Helvetica').fillColor('#374151');
    doc.text('Subtotal:', 400, y, { width: 100, align: 'right' });
    doc.text(fmt(sub), 500, y, { width: 62, align: 'right' });
    y += 16;
    doc.text('Shipping:', 400, y, { width: 100, align: 'right' });
    doc.text(fmt(ship), 500, y, { width: 62, align: 'right' });
    y += 16;
    doc.moveTo(400, y).lineTo(562, y).lineWidth(1).strokeColor('#E5E7EB').stroke();
    y += 6;
    doc.fontSize(11).font('Helvetica-Bold').fillColor(DARK);
    doc.text('TOTAL:', 400, y, { width: 100, align: 'right' });
    doc.text(fmt(total), 500, y, { width: 62, align: 'right' });

    if (order.note) {
      y += 32;
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#6B7280').text('ORDER NOTES', 50, y);
      y += 12;
      doc.fontSize(9.5).font('Helvetica').fillColor('#374151').text(order.note, 50, y, { width: 512 });
    }

    // Footer
    const total_pages = doc.bufferedPageRange().count;
    for (let i = 0; i < total_pages; i++) {
      doc.switchToPage(i);
      doc.fontSize(8).font('Helvetica').fillColor('#9CA3AF').text(
        'Thank you for your business! Questions? Contact alex@fuzzywumpets.com',
        50, 742, { align: 'center', width: 512 }
      );
    }

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
