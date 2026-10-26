// Test fixture (not a suite): the facts of the real production incident on order #39875, 2026-10-26, as read
// from prod (read-only) — shared by test/invoice-partial-backorder-seed.mjs (writes them into a mock server's
// in-memory DB) and test/invoice-partial-backorder.test.mjs (asserts on them).
//
// THE FACTS (all UTC):
//   20:46:58.685  lettered invoice A issued   118 lines / 178 units / $4,481.67
//   21:45:44.461  3 units backordered, one at a time (each one REMOVED from the Shopify order and parked in
//   21:46:04.476  `backorders`):  $55 LSC04946LG, $45 LSC04946SM, $50 LSC04857MED, qty 1 each
//   21:46:29.651
//   21:47:21.315  lettered invoice B issued   115 lines / 175 units / $4,331.67  (the 3 units are no longer on the order)
// Both A and B are LEGACY snapshots (issued before partial_invoices.backordered_json existed). A is a frozen
// record that DID bill the 3 units as ordinary rows and must stay exactly as it is; B is the one that must show
// them struck through with the footnote.
//
// The 115 "filler" lines are synthetic (generic titles) — only the counts, units, totals, timestamps and the
// three backordered units are the real facts. Unit prices are chosen so the lines sum to the stored totals to the cent.

export const ORDER_NUM = '1003';                       // the mock order the snapshots hang off
export const ORDER_GID = `gid://shopify/Order/${ORDER_NUM}`;

export const T = {
  A: Date.parse('2026-10-26T20:46:58.685Z'),
  BO1: Date.parse('2026-10-26T21:45:44.461Z'),
  BO2: Date.parse('2026-10-26T21:46:04.476Z'),
  BO3: Date.parse('2026-10-26T21:46:29.651Z'),
  B: Date.parse('2026-10-26T21:47:21.315Z'),
};

// The three removed units, as the `backorders` table holds them (prod ids / SKUs / prices).
export const BACKORDERED = [
  { lineItemId: 'gid://shopify/LineItem/50809488343275', variantId: 'gid://shopify/ProductVariant/46413859487979', sku: 'LSC04946LG',
    title: '1.5" Jade Valhalla Luxe Limited Slip Collar', variantTitle: 'LG', unitPrice: '55.00', createdAt: T.BO1 },
  { lineItemId: 'gid://shopify/LineItem/50809486344427', variantId: 'gid://shopify/ProductVariant/46413859422443', sku: 'LSC04946SM',
    title: '1.5" Jade Valhalla Luxe Limited Slip Collar', variantTitle: 'SM', unitPrice: '45.00', createdAt: T.BO2 },
  { lineItemId: 'gid://shopify/LineItem/50809486475499', variantId: 'gid://shopify/ProductVariant/46198841737451', sku: 'LSC04857MED',
    title: '1.5" Luck o\' the Irish Luxe Limited Slip Collar', variantTitle: 'MED', unitPrice: '50.00', createdAt: T.BO3 },
];

export const TOTAL_A = 4481.67;
export const TOTAL_B = 4331.67;
export const LINES_A = 118, LINES_B = 115, UNITS_A = 178, UNITS_B = 175;

// 115 filler lines, 175 units, Σ qty x unit == $4,331.67 exactly: 55 lines of 1 unit + 60 lines of 2 units, every
// unit $24.75 except the first line's single unit, which carries the extra 42 cents.
export function fillerLines() {
  return Array.from({ length: LINES_B }, (_, i) => {
    const n = String(i + 1).padStart(3, '0');
    return {
      id: `gid://shopify/LineItem/9000${n}`, title: `1" Test Pattern ${n} Everyday Limited Slip Collar`, variantTitle: 'MED',
      sku: `FILL-${n}-MED`, quantity: i < 55 ? 1 : 2, unitPrice: i === 0 ? 25.17 : 24.75, discountAmount: 0, wholesaleDiscountAmount: 0, discountReason: null,
    };
  });
}

// Snapshot B's lines: the fillers only. Snapshot A's: the fillers PLUS the 3 units as ordinary rows (that is what
// "A bills them" means) — A is the frozen record from before the units were backordered.
export const snapshotLinesB = () => fillerLines();
export const snapshotLinesA = () => [
  ...fillerLines(),
  ...BACKORDERED.map(b => ({ id: b.lineItemId, title: b.title, variantTitle: b.variantTitle, sku: b.sku, quantity: 1,
    unitPrice: Number(b.unitPrice), discountAmount: 0, discountReason: null })),
];

// Sanity (also asserted by the suite): the fixtures really are the facts above.
export const sum = (lines) => Math.round(lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0) * 100) / 100;
