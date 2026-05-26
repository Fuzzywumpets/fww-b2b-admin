/**
 * labels.mjs — UPC barcode label sheet PDF engine (Phase 5)
 * Generates Avery-format label sheets using pdfkit + bwip-js.
 */
import PDFDocument from 'pdfkit';
import bwipjs from 'bwip-js';

// Points per inch = 72. All dimensions in pt.
export const TEMPLATES = {
  'avery-5160': {
    name: 'Avery 5160 (1×2⅝, 30/sheet)',
    pageW: 612, pageH: 792,
    cols: 3, rows: 10,
    labelW: 189, labelH: 72,
    marginX: 13.5, marginY: 36,
    gutterX: 9, gutterY: 0,
  },
  'avery-5163': {
    name: 'Avery 5163 (2×4, 10/sheet)',
    pageW: 612, pageH: 792,
    cols: 2, rows: 5,
    labelW: 288, labelH: 144,
    marginX: 13.5, marginY: 36,
    gutterX: 9, gutterY: 0,
  },
  'avery-5167': {
    name: 'Avery 5167 (½×1¾, 80/sheet)',
    pageW: 612, pageH: 792,
    cols: 4, rows: 20,
    labelW: 126, labelH: 36,
    marginX: 30, marginY: 36,
    gutterX: 16, gutterY: 0,
  },
  'avery-8195': {
    name: 'Avery 8195 (⅔×1¾, 60/sheet)',
    pageW: 612, pageH: 792,
    cols: 4, rows: 15,
    labelW: 126, labelH: 48,
    marginX: 30, marginY: 36,
    gutterX: 16, gutterY: 0,
  },
};

// Render a UPC-A or EAN-13 barcode as PNG Buffer.
export async function barcodePng(code) {
  const isEan13 = String(code).length === 13;
  return bwipjs.toBuffer({
    bcid: isEan13 ? 'ean13' : 'upca',
    text: String(code),
    scale: 2,
    height: 8,
    includetext: true,
    textxalign: 'center',
    paddingleft: 5,
    paddingright: 5,
  });
}

// Expand items by quantity and filter out items with no barcode.
// Returns { labels: [...], skipped: [...] }
export function expandItems(items) {
  const labels = [];
  const skipped = [];
  for (const item of items) {
    const code = String(item.barcode || '').trim();
    if (!code || !/^\d{12,13}$/.test(code)) {
      skipped.push(item);
      continue;
    }
    const qty = Math.max(1, parseInt(item.qty) || 1);
    for (let i = 0; i < qty; i++) labels.push({ ...item, barcode: code });
  }
  return { labels, skipped };
}

// Render a label sheet and return a PDF Buffer.
export async function renderLabelSheet({ template = 'avery-5160', items, options = {} }) {
  const tmpl = TEMPLATES[template] || TEMPLATES['avery-5160'];
  const { showPrice = true, mode = 'product+variant' } = options;
  const { labels, skipped } = expandItems(items);

  // Pre-generate barcodes
  const barcodeCache = new Map();
  for (const lbl of labels) {
    if (!barcodeCache.has(lbl.barcode)) {
      try {
        barcodeCache.set(lbl.barcode, await barcodePng(lbl.barcode));
      } catch {
        barcodeCache.set(lbl.barcode, null);
      }
    }
  }

  const labelsPerSheet = tmpl.cols * tmpl.rows;
  const pageCount = Math.max(1, Math.ceil(labels.length / labelsPerSheet));

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [tmpl.pageW, tmpl.pageH], margin: 0, autoFirstPage: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve({ pdf: Buffer.concat(chunks), skipped }));
    doc.on('error', reject);

    let idx = 0;
    for (let p = 0; p < pageCount; p++) {
      if (p > 0) doc.addPage({ size: [tmpl.pageW, tmpl.pageH], margin: 0 });
      for (let row = 0; row < tmpl.rows; row++) {
        for (let col = 0; col < tmpl.cols; col++) {
          if (idx >= labels.length) break;
          const lbl = labels[idx++];
          const lx = tmpl.marginX + col * (tmpl.labelW + tmpl.gutterX);
          const ly = tmpl.marginY + row * (tmpl.labelH + tmpl.gutterY);
          drawLabel(doc, lx, ly, tmpl.labelW, tmpl.labelH, lbl, barcodeCache.get(lbl.barcode), { showPrice, mode });
        }
      }
    }
    doc.end();
  });
}

function drawLabel(doc, x, y, w, h, label, barcodeBuf, { showPrice, mode }) {
  const PAD = Math.max(2, Math.round(h * 0.04));
  const contentW = w - 2 * PAD;
  const TITLE_SIZE = Math.max(5, Math.min(8, Math.round(h * 0.115)));
  const VAR_SIZE   = Math.max(4, Math.min(6, Math.round(h * 0.09)));
  const PRICE_SIZE = Math.max(5, Math.min(7, Math.round(h * 0.1)));

  let topY = y + PAD;
  const bottomY = y + h - PAD;

  // Title (bold, up to 2 lines, auto-ellipsis)
  doc.font('Helvetica-Bold').fontSize(TITLE_SIZE).fillColor('#000000');
  const titleMaxH = TITLE_SIZE * 2.4;
  const titleH = Math.min(titleMaxH, doc.heightOfString(label.title || '', { width: contentW }));
  if (label.title) {
    doc.text(label.title, x + PAD, topY, { width: contentW, height: titleH, lineBreak: true, ellipsis: true });
    topY += titleH + 1;
  }

  // Variant subtitle
  if (mode === 'product+variant' && label.variantTitle && label.variantTitle !== 'Default Title') {
    doc.font('Helvetica').fontSize(VAR_SIZE).fillColor('#555555');
    doc.text(label.variantTitle, x + PAD, topY, { width: contentW, lineBreak: false, ellipsis: true });
    topY += VAR_SIZE + 1;
    doc.fillColor('#000000');
  }

  // Price (bottom right)
  if (showPrice && label.price) {
    doc.font('Helvetica-Bold').fontSize(PRICE_SIZE).fillColor('#000000');
    const priceText = `$${parseFloat(label.price).toFixed(2)}`;
    doc.text(priceText, x + PAD, bottomY - PRICE_SIZE - 1, { width: contentW, align: 'right', lineBreak: false });
  }

  // Barcode image (centered in remaining space)
  const barcodeBottom = showPrice && label.price ? bottomY - PRICE_SIZE - 3 : bottomY;
  const barcodeAreaH = barcodeBottom - topY - 1;
  if (barcodeBuf && barcodeAreaH > 8) {
    try {
      doc.image(barcodeBuf, x + PAD, topY, {
        fit: [contentW, barcodeAreaH],
        align: 'center',
        valign: 'center',
      });
    } catch {
      // Skip barcode rendering on error
    }
  }
}
