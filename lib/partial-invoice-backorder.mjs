// lib/partial-invoice-backorder.mjs — which backordered lines a LETTERED partial invoice shows.
//
// WHAT: a lettered invoice (partial_invoices row, re-rendered by GET /orders/:id/partial-invoice/:letter.pdf and
//   the GET /orders/:id/invoice?letter= viewer) is a frozen snapshot of the order's lines and totals. Units that
//   were backordered (REMOVED from the Shopify order, parked in the `backorders` table) are not on those lines,
//   so the snapshot freezes them too, in partial_invoices.backordered_json. This module is the ONE place that
//   (a) turns the live rows into that stored JSON and (b) decides, at render time, which rows a given snapshot
//   shows. What is drawn from them (struck rows, tag, footnote, wording) is lib/invoice-backorder.mjs, reused
//   verbatim through pdf.mjs buildOrderInvoiceBackorderModel — nothing here holds a word of invoice wording.
// CHANGE-GUARD: an ISSUED invoice must not change after the fact. A new snapshot therefore always renders its
//   STORED copy and never consults the live table (restoring a unit later, or backordering another, cannot alter
//   it). Only a LEGACY snapshot (column NULL) is reconstructed from live rows, because that is all that exists
//   for it. Do not "simplify" this into always reading the live rows.
// INVARIANT(S): PURE — no db, no fs, no Date.now(), no env. The live rows are handed in (as a thunk, so a new
//   snapshot never even queries). Nothing here feeds subtotal/shipping/tax/total: those stay the snapshot's own
//   (partial_invoices.total/shipping/tax), and struck rows never enter them.
// DEPENDS: db.mjs getBackorderedLinesForOrder row shape ({ lineItemId, sku, title, variantTitle, quantity,
//   unitPrice, currency, lineTotal, createdAt (ms) }) and partial_invoices.created_at (ms, same clock — both are
//   Date.now()); db.mjs migratePartialInvoicesSchema / createPartialInvoice own the column. Callers: server.mjs
//   POST /orders/:id/partial-invoice (writes), GET /orders/:id/partial-invoice/:letter.pdf and GET
//   /orders/:id/invoice?letter= (read).

// The fields a snapshot keeps: exactly what lib/invoice-backorder.mjs buildInvoiceBackorderModel reads, plus the
// line id and the flag time for forensics. No customer data, no createdBy.
// SYNC: buildInvoiceBackorderModel's row contract (title, variantTitle, sku, quantity, unitPrice, currency,
//   lineTotal) — a field it starts reading must be added here or new snapshots silently lose it.
const STORED_FIELDS = ['lineItemId', 'sku', 'title', 'variantTitle', 'quantity', 'unitPrice', 'currency', 'lineTotal', 'createdAt'];

// WHAT: the JSON text stored in partial_invoices.backordered_json for a NEW snapshot. Always a JSON array
//   string — '[]' when there is nothing to freeze (NOT null: null means "legacy, reconstruct me").
// rows: db.mjs getBackorderedLinesForOrder() output.
export function serializeBackorderedLines(rows) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const kept = {};
    for (const f of STORED_FIELDS) if (row[f] !== undefined) kept[f] = row[f];
    out.push(kept);
  }
  return JSON.stringify(out);
}

// WHAT: the stored lines of a snapshot, or null when the column holds no usable copy (NULL, empty, not JSON, not
//   an array) — the caller then treats the snapshot as legacy.
export function parseStoredBackorderedLines(json) {
  if (typeof json !== 'string' || !json.trim()) return null;
  let parsed;
  try { parsed = JSON.parse(json); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  return parsed.filter(r => r && typeof r === 'object' && !Array.isArray(r));
}

// WHAT: the backordered rows lettered invoice `inv` must show, in the shape buildOrderInvoiceBackorderModel takes.
// inv: a partial_invoices row ({ backordered_json, created_at }). getLiveRows: () => getBackorderedLinesForOrder(gid)
//   — called ONLY for a legacy snapshot.
//   1. backordered_json holds a JSON array (including '[]') -> that, as stored. Never the live table.
//   2. otherwise (LEGACY): the live pending removed rows whose createdAt <= inv.created_at, i.e. the units already
//      backordered when the invoice was issued. A row that cannot be placed in time (no/invalid createdAt, or an
//      invoice with no/invalid created_at) is OMITTED rather than guessed — an invoice must not gain a struck row
//      it may never have had. A unit restored since is no longer a pending row, so it is omitted too.
// Order is the order of the source (stored order, or the live query's oldest-first); pdf.mjs sorts for display.
export function backorderedLinesForPartialInvoice(inv, getLiveRows) {
  const stored = parseStoredBackorderedLines(inv?.backordered_json);
  if (stored) return stored;
  const issuedAt = inv?.created_at;
  if (!Number.isFinite(issuedAt)) return [];
  const live = typeof getLiveRows === 'function' ? getLiveRows() : [];
  // Number.isFinite (no coercion): a null/''/'abc' createdAt must not become 0 and slip into every old invoice.
  return (Array.isArray(live) ? live : []).filter(r => Number.isFinite(r?.createdAt) && r.createdAt <= issuedAt);
}
