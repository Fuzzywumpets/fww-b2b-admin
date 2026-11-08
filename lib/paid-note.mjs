// The one-line "how did this order come to be paid" note.
//
// Alex (2026-10-27): an order marked paid by hand should say so ("marked paid manually"), and an order paid
// through Helcim should carry the Helcim transaction identifier. Mark Paid used to leave only an audit-log row.
// The line is appended to the Admin-only order note (db.mjs appendOrderInternalNote), never the Shopify note,
// which holds customer instructions and reaches packing slips and the CSV export.

const SOURCES = new Set(['manual', 'helcim']);

// WHAT: collapse anything a free-text field could carry (newlines, control characters, runs of spaces) to one
// plain run of text and cap it, so a stray value can neither split the line nor swamp the note.
function clean(value, max = 60) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, max);
}

// WHAT: `2026-10-27 17:13 UTC` from a Date or a ms timestamp.
function stamp(at) {
  const d = at instanceof Date ? at : new Date(at);
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

// WHAT: build ONE line (no newline) describing how an order came to be paid.
//   source 'manual' - a person pressed Mark Paid. Names who and when. If a Helcim card invoice is linked to the order
//                     its number is named, with the plain statement that THIS click did not check it with Helcim
//                     (a manual click proves nothing about whether Helcim was paid, and a customer could still pay it).
//   source 'helcim' - Helcim reported the invoice paid (the paid-sync path). Carries Helcim's transaction id, the invoice
//                     number and the amount; says "transaction ID not available" rather than inventing one.
// CHANGE-GUARD: this reads ONLY invoiceNumber / transactionId / amount / currency from `helcim`, picked by name, so
//   extra fields are ignored. A helcim_invoice_map row also holds the private online-view `token` and pay `url`; those
//   must never be copied into a note, and test/paid-note.test.mjs fails if they are. (The row's column is
//   `invoice_number`: the caller maps it to `invoiceNumber`.)
// DEPENDS: server.mjs (POST /orders/bulk and POST /orders/:id/mark-paid) builds 'manual' lines. The 'helcim' form is for
//   the Helcim paid-sync (hotfix/paidsync-admin lib/helcim-reconcile.mjs), which must obtain the transaction id from
//   Helcim before it can call this; nothing in this lineage calls it with source 'helcim' yet.
// INVARIANT(S): pure; never touches the network or the database; throws TypeError on an unknown source so a typo is loud
//   in tests (every production caller is fail-open and swallows it).
export function buildPaidNoteLine({ source = 'manual', actor = '', at = new Date(), helcim = null } = {}) {
  if (!SOURCES.has(source)) throw new TypeError(`buildPaidNoteLine: unknown source "${source}"`);
  const when = `[${stamp(at)}]`;
  const invoiceNumber = clean(helcim?.invoiceNumber);

  if (source === 'helcim') {
    const parts = [];
    const txn = clean(helcim?.transactionId);
    parts.push(txn ? `transaction ${txn}` : 'transaction ID not available');
    if (invoiceNumber) parts.push(`invoice ${invoiceNumber}`);
    const amount = Number(helcim?.amount);
    if (Number.isFinite(amount) && amount > 0) parts.push(`${amount.toFixed(2)}${helcim?.currency ? ' ' + clean(helcim.currency, 3).toUpperCase() : ''}`);
    return `${when} Paid by card via Helcim: ${parts.join(', ')}. Marked paid automatically by the Helcim payment sync.`;
  }

  const who = clean(actor, 120) || 'unknown staff';
  let line = `${when} Marked paid manually by ${who} (Admin "Mark Paid"; no payment method recorded).`;
  if (helcim) {
    line += invoiceNumber
      ? ` Helcim card invoice ${invoiceNumber} is linked to this order; this click did not check it with Helcim.`
      : ' A Helcim card invoice is linked to this order; this click did not check it with Helcim.';
  }
  return line;
}
