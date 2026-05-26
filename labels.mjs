/**
 * labels.mjs — UPC barcode label PDF engine (Phase 5 + Phase 8)
 * Generates Avery sheet labels and thermal single-label PDFs via pdfkit + bwip-js.
 */
import PDFDocument from 'pdfkit';
import bwipjs from 'bwip-js';

// Default field selection (Phase 8)
export const DEFAULT_FIELDS = {
  productName: true,
  variantName: true,
  msrp: true,
  sku: false,
  upcBarcode: true,
  upcDigits: true,
};

// All 10 label templates (5 Avery sheet + 5 thermal single). Dimensions in pts (72pt = 1in).
export const TEMPLATES = {
  // ── Avery sheet templates ─────────────────────────────────────────────────
  'avery-5160': {
    name: 'Avery 5160 (1"×2⅝", 30/sheet)',
    type: 'sheet',
    pageW: 612, pageH: 792,
    cols: 3, rows: 10,
    labelW: 189, labelH: 72,
    marginX: 13.5, marginY: 36,
    gutterX: 9, gutterY: 0,
  },
  'avery-5161': {
    name: 'Avery 5161 (1"×4", 20/sheet)',
    type: 'sheet',
    pageW: 612, pageH: 792,
    cols: 2, rows: 10,
    labelW: 288, labelH: 72,
    marginX: 13.5, marginY: 36,
    gutterX: 9, gutterY: 0,
  },
  'avery-5163': {
    name: 'Avery 5163 (2"×4", 10/sheet)',
    type: 'sheet',
    pageW: 612, pageH: 792,
    cols: 2, rows: 5,
    labelW: 288, labelH: 144,
    marginX: 13.5, marginY: 36,
    gutterX: 9, gutterY: 0,
  },
  'avery-5167': {
    name: 'Avery 5167 (½"×1¾", 80/sheet)',
    type: 'sheet',
    pageW: 612, pageH: 792,
    cols: 4, rows: 20,
    labelW: 126, labelH: 36,
    marginX: 30, marginY: 36,
    gutterX: 16, gutterY: 0,
  },
  'avery-8195': {
    name: 'Avery 8195 (⅔"×1¾", 60/sheet)',
    type: 'sheet',
    pageW: 612, pageH: 792,
    cols: 4, rows: 15,
    labelW: 126, labelH: 48,
    marginX: 30, marginY: 36,
    gutterX: 16, gutterY: 0,
  },
  // ── Thermal single-label templates (one label per PDF page) ───────────────
  'thermal-4x6': {
    name: 'Thermal 4"×6" (Zebra/Rollo/Dymo 4XL)',
    type: 'thermal',
    labelW: 288, labelH: 432,
  },
  'thermal-2.25x1.25': {
    name: 'Thermal 2¼"×1¼" (Dymo 30334)',
    type: 'thermal',
    labelW: 162, labelH: 90,
  },
  'thermal-2x1': {
    name: 'Thermal 2"×1" (retail barcode)',
    type: 'thermal',
    labelW: 144, labelH: 72,
  },
  'thermal-3x2': {
    name: 'Thermal 3"×2" (warehouse)',
    type: 'thermal',
    labelW: 216, labelH: 144,
  },
  'thermal-2x2': {
    name: 'Thermal 2"×2" (square)',
    type: 'thermal',
    labelW: 144, labelH: 144,
  },
};

// Render a UPC-A or EAN-13 barcode as a PNG Buffer (no embedded text — upcDigits field handles that).
export async function barcodePng(code) {
  const isEan13 = String(code).length === 13;
  return bwipjs.toBuffer({
    bcid: isEan13 ? 'ean13' : 'upca',
    text: String(code),
    scale: 2,
    height: 8,
    includetext: false,
    paddingleft: 5,
    paddingright: 5,
  });
}

// Expand items by quantity and filter out items with no valid barcode.
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

// Main entry point. Returns { pdf: Buffer, skipped: [] }.
export async function renderLabelSheet({ template = 'avery-5160', items, fields = DEFAULT_FIELDS }) {
  const tmpl = TEMPLATES[template] || TEMPLATES['avery-5160'];
  const mergedFields = { ...DEFAULT_FIELDS, ...fields };
  const { labels, skipped } = expandItems(items);

  // Pre-generate barcode PNGs (only if upcBarcode is enabled)
  const barcodeCache = new Map();
  if (mergedFields.upcBarcode) {
    for (const lbl of labels) {
      if (!barcodeCache.has(lbl.barcode)) {
        try {
          barcodeCache.set(lbl.barcode, await barcodePng(lbl.barcode));
        } catch {
          barcodeCache.set(lbl.barcode, null);
        }
      }
    }
  }

  const pdf = tmpl.type === 'thermal'
    ? await renderThermalLayout(tmpl, labels, barcodeCache, mergedFields)
    : await renderSheetLayout(tmpl, labels, barcodeCache, mergedFields);

  return { pdf, skipped };
}

// ── Sheet layout: grid of labels across multiple pages ───────────────────────

function renderSheetLayout(tmpl, labels, barcodeCache, fields) {
  const labelsPerSheet = tmpl.cols * tmpl.rows;
  const pageCount = Math.max(1, Math.ceil(labels.length / labelsPerSheet));

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [tmpl.pageW, tmpl.pageH], margin: 0, autoFirstPage: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
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
          drawLabel(doc, lx, ly, tmpl.labelW, tmpl.labelH, lbl, barcodeCache.get(lbl.barcode), fields);
        }
      }
    }
    doc.end();
  });
}

// ── Thermal layout: one label per PDF page, page size = label size ───────────

function renderThermalLayout(tmpl, labels, barcodeCache, fields) {
  const { labelW, labelH } = tmpl;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [labelW, labelH], margin: 0, autoFirstPage: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    for (let i = 0; i < labels.length; i++) {
      if (i > 0) doc.addPage({ size: [labelW, labelH], margin: 0 });
      const lbl = labels[i];
      drawLabel(doc, 0, 0, labelW, labelH, lbl, barcodeCache.get(lbl.barcode), fields);
    }
    // Render at least one blank page if no labels (shouldn't happen after expandItems)
    if (labels.length === 0) {
      doc.text('', 0, 0);
    }
    doc.end();
  });
}

// ── Label drawing: stacks enabled fields vertically within the label rect ─────

function drawLabel(doc, x, y, w, h, label, barcodeBuf, fields) {
  const PAD = Math.max(2, Math.round(h * 0.04));
  const contentW = w - 2 * PAD;

  // Font sizes scale with label height; clamped to readable minimums
  const TITLE_SIZE = Math.max(5, Math.min(9,  Math.round(h * 0.12)));
  const VAR_SIZE   = Math.max(4, Math.min(7,  Math.round(h * 0.09)));
  const PRICE_SIZE = Math.max(5, Math.min(8,  Math.round(h * 0.10)));
  const SKU_SIZE   = Math.max(4, Math.min(7,  Math.round(h * 0.08)));
  const DIGIT_SIZE = Math.max(4, Math.min(7,  Math.round(h * 0.08)));

  let topY = y + PAD;
  const bottomY = y + h - PAD;
  let remaining = h - 2 * PAD;

  // Reserve space at bottom for MSRP price
  let priceReserve = 0;
  if (fields.msrp && label.price && remaining > PRICE_SIZE + 2) {
    priceReserve = PRICE_SIZE + 2;
  }

  // Product name (bold, up to 2 lines, auto-ellipsis)
  if (fields.productName && label.title && remaining - priceReserve > TITLE_SIZE) {
    doc.font('Helvetica-Bold').fontSize(TITLE_SIZE).fillColor('#000000');
    const maxH = Math.min(TITLE_SIZE * 2.4, remaining - priceReserve);
    if (maxH > 4) {
      const textH = Math.min(maxH, doc.heightOfString(label.title, { width: contentW }));
      doc.text(label.title, x + PAD, topY, { width: contentW, height: textH, lineBreak: true, ellipsis: true });
      topY    += textH + 1;
      remaining -= textH + 1;
    }
  }

  // Variant name (smaller, gray)
  if (fields.variantName && label.variantTitle && label.variantTitle !== 'Default Title'
      && remaining - priceReserve > VAR_SIZE) {
    doc.font('Helvetica').fontSize(VAR_SIZE).fillColor('#555555');
    doc.text(label.variantTitle, x + PAD, topY, { width: contentW, lineBreak: false, ellipsis: true });
    topY      += VAR_SIZE + 1;
    remaining -= VAR_SIZE + 1;
    doc.fillColor('#000000');
  }

  // UPC barcode image (centered)
  if (fields.upcBarcode && barcodeBuf && remaining - priceReserve > 10) {
    const digitReserve = fields.upcDigits ? DIGIT_SIZE + 2 : 0;
    const barcodeAreaH = Math.min(remaining - priceReserve - digitReserve - 1, h * 0.50);
    if (barcodeAreaH > 8) {
      try {
        doc.image(barcodeBuf, x + PAD, topY, {
          fit: [contentW, barcodeAreaH],
          align: 'center',
          valign: 'center',
        });
        topY      += barcodeAreaH + 1;
        remaining -= barcodeAreaH + 1;
      } catch { /* skip on render error */ }
    }
  }

  // UPC digits (monospace, centered below barcode)
  if (fields.upcDigits && label.barcode && remaining - priceReserve > DIGIT_SIZE) {
    doc.font('Courier').fontSize(DIGIT_SIZE).fillColor('#333333');
    doc.text(label.barcode, x + PAD, topY, { width: contentW, align: 'center', lineBreak: false });
    topY      += DIGIT_SIZE + 2;
    remaining -= DIGIT_SIZE + 2;
    doc.font('Helvetica').fillColor('#000000');
  }

  // SKU (small gray, "SKU: " prefix)
  if (fields.sku && label.sku && remaining - priceReserve > SKU_SIZE) {
    doc.font('Helvetica').fontSize(SKU_SIZE).fillColor('#666666');
    doc.text(`SKU: ${label.sku}`, x + PAD, topY, { width: contentW, lineBreak: false, ellipsis: true });
    topY      += SKU_SIZE + 1;
    remaining -= SKU_SIZE + 1;
    doc.fillColor('#000000');
  }

  // MSRP (right-aligned bold at bottom)
  if (priceReserve > 0 && label.price) {
    doc.font('Helvetica-Bold').fontSize(PRICE_SIZE).fillColor('#000000');
    const priceText = `$${parseFloat(label.price).toFixed(2)}`;
    doc.text(priceText, x + PAD, bottomY - PRICE_SIZE - 1, { width: contentW, align: 'right', lineBreak: false });
  }
}
