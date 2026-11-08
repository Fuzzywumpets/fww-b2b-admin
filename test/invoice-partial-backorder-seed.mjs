// Test helper (not a suite): preloaded into the mock server by test/invoice-partial-backorder.test.mjs
// (`node --import ./test/invoice-partial-backorder-seed.mjs server.mjs`).
//
// WHAT: writes the #39875 incident (test/fixtures/invoice-39875-facts.mjs) straight into the server's own in-memory
//   SQLite (a --import module and server.mjs share one module graph, so ./db.mjs is the same instance):
//     - the 3 backordered units, through the REAL claim -> finalize path (so the rows are exactly what the Mark
//       backordered route leaves behind), with their prod created_at values;
//     - lettered invoices A and B as LEGACY snapshots: inserted with the previous release's column list, so
//       backordered_json is NULL, and with the prod created_at values (createPartialInvoice always stamps Date.now()).
// DEPENDS: mock fixture #1003 in server.mjs (its own line ids do not matter: a re-download renders the SNAPSHOT's
//   lines). The next POST /orders/1003/partial-invoice therefore takes letter C.
// SAFETY: runs only under B2B_ADMIN_MOCK=1 (in-memory DB); refuses otherwise so it can never write to data/admin.db.
if (process.env.B2B_ADMIN_MOCK !== '1') throw new Error('invoice-partial-backorder-seed: refusing to run outside B2B_ADMIN_MOCK=1');
const dbm = await import('../db.mjs');
const facts = await import('./fixtures/invoice-39875-facts.mjs');
const db = dbm.default;

for (const b of facts.BACKORDERED) {
  const claim = dbm.claimBackorderRemoval({
    orderId: facts.ORDER_GID, lineItemId: b.lineItemId, title: b.title, variantId: b.variantId, sku: b.sku, variantTitle: b.variantTitle,
    unitPrice: b.unitPrice, currency: 'USD', quantity: 1, priorQty: 1, createdBy: 'alex@fuzzywumpets.com', now: b.createdAt,
  });
  if (!claim.ok || !dbm.finalizeBackorderRemoval(facts.ORDER_GID, b.lineItemId)) throw new Error(`seed: could not backorder ${b.sku}`);
}

// The previous release's INSERT, verbatim: no backordered_json -> NULL -> a LEGACY snapshot.
const OLD_INSERT = db.prepare(`
  INSERT INTO partial_invoices (order_id, invoice_letter, invoice_type, total, shipping, tax, line_items_json, created_at, created_by)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
OLD_INSERT.run(facts.ORDER_GID, 'A', 'full', facts.TOTAL_A, 0, 0, JSON.stringify(facts.snapshotLinesA()), facts.T.A, 'staff@test');
OLD_INSERT.run(facts.ORDER_GID, 'B', 'full', facts.TOTAL_B, 0, 0, JSON.stringify(facts.snapshotLinesB()), facts.T.B, 'staff@test');
