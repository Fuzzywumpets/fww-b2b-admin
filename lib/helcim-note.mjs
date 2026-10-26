// WHAT: Pure helpers for the Helcim CC invoice staff note — normalisation, Markdown quoting, and
//   the full email body builder. Kept in a separate module so unit tests cover the text logic
//   without starting a server, and so main can reuse the same functions when the full CC-invoice
//   flow ships there.
// CHANGE-GUARD: quoteForMarkdown escapes the same set of chars that renderNoteBody (Portal
//   reamaze.mjs) renders — if the Portal ever switches to HTML the escaping rules change too.
// INVARIANT(S): all exports are pure (no side-effects, no I/O); normalizeStaffNote caps at 500
//   chars AFTER stripping control chars so callers can rely on the cap without a separate trim.
// DEPENDS: Portal reamaze.mjs renderNoteBody receives the output of quoteForMarkdown as part of
//   the noteBody; it renders the content as Markdown. Any Markdown-special characters that are NOT
//   escaped here will render as formatting in the customer-facing email.

/**
 * normalizeStaffNote(raw) → string
 *
 * Cleans a raw staff-supplied note for safe inclusion in an email body:
 *   - converts CRLF to LF
 *   - strips control characters (except \n)
 *   - collapses runs of 3+ blank lines to 2
 *   - trims leading/trailing whitespace
 *   - caps at 500 characters
 *
 * Returns '' for null / whitespace-only input.
 */
export function normalizeStaffNote(raw) {
  if (raw == null) return '';
  return String(raw)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')  // strip control chars except \n (0x0a)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 500);
}

/**
 * quoteForMarkdown(note) → string
 *
 * Escapes Markdown / HTML specials in each line and prefixes every non-empty line with '> '
 * so the note is rendered as a Markdown blockquote.
 *
 * Escaped characters: \ ` * _ [ ] ( ) < > # + - . ! | ~
 * (the full set that Re:amaze / CommonMark treats as significant).
 *
 * Empty lines within the note are preserved as blank blockquote lines (> ) so the paragraph
 * break is visible in the rendered email.
 */
export function quoteForMarkdown(note) {
  if (!note) return '';
  return String(note)
    .split('\n')
    .map(line => {
      const escaped = line.replace(/[\\`*_[\]()<!>#.+\-|~]/g, '\\$&');
      return `> ${escaped}`;
    })
    .join('\n');
}

/**
 * buildLegacyInvoiceEmail({ orderName, amountText, currency, url, note }) → { subject, body }
 *
 * Builds the subject line and Markdown body for the Helcim CC invoice email.
 * `note` must already be normalised (via normalizeStaffNote); pass '' or null when absent.
 *
 * Subject always contains the #NNNNN order token so that Portal's
 * getCustomerWholesaleThreads can scope the Re:amaze thread to this order.
 *
 * Body shape with note:
 *   Your invoice for order #NNNNN is ready for $N.NN USD.
 *
 *   > <note line 1>
 *   > <note line 2>
 *
 *   Pay securely with Helcim:
 *   https://fuzzywumpets.myhelcim.com/order/?token=...
 *
 * Body shape without note uses the same wording minus the blockquote block.
 */
export function buildLegacyInvoiceEmail({ orderName, amountText, currency, url, note } = {}) {
  const subject = `Your invoice from Fuzzywumpets is ready - order ${orderName}`;
  const noteBlock = note ? `\n\n${quoteForMarkdown(note)}` : '';
  const body = `Your invoice for order ${orderName} is ready for ${amountText} ${currency}.${noteBlock}\n\nPay securely with Helcim:\n${url}`;
  return { subject, body };
}
