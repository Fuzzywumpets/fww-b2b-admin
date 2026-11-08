// Test helper (not a suite): preloaded into the mock server by test/invoice-pick-order.test.mjs
// (`node --import ./test/invoice-pick-order-seed.mjs server.mjs`).
//
// WHAT: writes ONE LEGACY lettered-invoice snapshot (letter Y, mock order #1001) whose saved lines are deliberately NOT
//   in pick-list order and include a line with no SKU — so the re-download route can be shown to print an OLD letter in
//   pick order (display only: the saved lines, prices and total are untouched). Same in-memory-DB mechanism as
//   test/invoice-wholesale-seed.mjs (a --import module and server.mjs share one module graph, so ./db.mjs is one instance).
// DEPENDS: mock fixture #1001 in server.mjs (li1 Elite Collar, li2 Luxe Leash); letter Y is chosen so
//   POST /orders/1001/partial-invoice (first unused letter, A) never collides with it.
// SAFETY: runs only under B2B_ADMIN_MOCK=1 (in-memory DB); refuses otherwise so it can never write to data/admin.db.
if (process.env.B2B_ADMIN_MOCK !== '1') throw new Error('invoice-pick-order-seed: refusing to run outside B2B_ADMIN_MOCK=1');
const { createPartialInvoice } = await import('../db.mjs');

const line = (id, title, variantTitle, sku, quantity, unitPrice) => ({ id, title, variantTitle, sku, quantity, unitPrice, discountAmount: 0 });
// Saved order: Luxe Leash, Elite Collar, Zebra, Aardvark, an SKU-less alteration. Pick order: Aardvark, Elite, Luxe Leash, Zebra, alteration.
const lines = [
  line('li2', 'Luxe Leash', null, 'LL-005', 2, 37.5),
  line('li1', 'Elite Collar', 'Small / Navy', 'EC-001-S-NV', 5, 18),
  line('legacy-z', '1" Zebra Everyday Limited Slip Collar', 'MED', 'ZB-1-MED', 1, 20),
  line('legacy-a', '1.5" Aardvark Luxe Limited Slip Collar', 'LG', 'AA-1-LG', 1, 30),
  line('legacy-svc', 'Alteration', null, null, 1, 10),
];
createPartialInvoice({ orderId: 'gid://shopify/Order/1001', invoiceLetter: 'Y', invoiceType: 'full', total: 225, shipping: 0, tax: 0,
  lineItemsJson: JSON.stringify(lines), createdBy: 'legacy@test' });
