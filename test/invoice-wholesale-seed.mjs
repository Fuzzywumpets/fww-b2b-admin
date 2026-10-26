// Test helper (not a suite): preloaded into the mock server by test/invoice-wholesale-lines.test.mjs
// (`node --import ./test/invoice-wholesale-seed.mjs server.mjs`).
//
// WHAT: writes two LEGACY partial-invoice snapshots for mock order #1011 straight into the server's own
//   in-memory SQLite (a --import module and server.mjs share one module graph, so ./db.mjs is the same
//   instance). Legacy = written BEFORE the wholesale exclusion existed: the snapshot's discountAmount for the
//   added line (SKU 04622, li1011b) is the INCLUSIVE 9.00 and there is no wholesaleDiscountAmount key —
//   exactly the shape of the already-issued partial invoice #39875-A.
// WHY: the only HTTP route that creates snapshots writes the NEW format, so without seeding there is no way to
//   drive the re-download correction through the real route.
// DEPENDS: mock fixture #1011 in server.mjs (line ids li1011a/b/c, their prices); letters Y and Z are chosen so
//   POST /orders/1011/partial-invoice (which takes the first unused letter, A) never collides with them.
// SAFETY: runs only under B2B_ADMIN_MOCK=1 (in-memory DB); refuses otherwise so it can never write to data/admin.db.
if (process.env.B2B_ADMIN_MOCK !== '1') throw new Error('invoice-wholesale-seed: refusing to run outside B2B_ADMIN_MOCK=1');
const { createPartialInvoice } = await import('../db.mjs');

const ORDER = 'gid://shopify/Order/1011';
const collar = { id: 'li1011a', title: 'Wholesale Collar', variantTitle: null, sku: 'WC-001', quantity: 3, unitPrice: 12, discountAmount: 0 };
const leash  = { id: 'li1011b', title: 'Added Pinpoint Leash', variantTitle: null, sku: '04622', quantity: 1, unitPrice: 8.99, discountAmount: 9 };
const lead   = { id: 'li1011c', title: 'Trade Show Lead', variantTitle: null, sku: 'TSL-003', quantity: 2, unitPrice: 18, discountAmount: 4 };

// Y: all three lines — a genuine 4.00 discount AND the legacy-inclusive 9.00 on the wholesale line.
createPartialInvoice({ orderId: ORDER, invoiceLetter: 'Y', invoiceType: 'full', total: 80.99, shipping: 0, tax: 0,
  lineItemsJson: JSON.stringify([collar, leash, lead]), createdBy: 'legacy@test' });
// Z: wholesale-priced lines only — after the correction there is no Discount row at all.
createPartialInvoice({ orderId: ORDER, invoiceLetter: 'Z', invoiceType: 'full', total: 44.99, shipping: 0, tax: 0,
  lineItemsJson: JSON.stringify([collar, leash]), createdBy: 'legacy@test' });
