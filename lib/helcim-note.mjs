// WHAT: Pure helpers for the Helcim CC invoice staff note — normalisation, plain-text quoting, the
//   stored-note/subject builder, and the full Portal request payload builder. Kept in a separate
//   module so unit tests cover the text logic without starting a server (MOCK mode never calls
//   Portal), and so main can reuse the same functions when the full CC-invoice flow ships there.
// CHANGE-GUARD: the Portal now emails the invoice through Gmail from a fixed HTML template that
//   escapes the note itself, so `body` here is PLAIN readable text (note lines prefixed "> ", no
//   backslash escaping). It is what Portal stores as the customer-visible order note, and Portal
//   renders stored notes as HTML-escaped text, so Markdown escapes would show as literal backslashes.
//   quoteForMarkdown is kept (exported, tested) but is no longer used by production code.
// INVARIANT(S): all exports are pure (no side-effects, no I/O); normalizeStaffNote caps at 500
//   chars AFTER stripping control chars so callers can rely on the cap without a separate trim.
// DEPENDS: Portal POST /__internal__/visible-note (fww-b2b-portal server.mjs) receives the output of
//   buildCreditCardInvoicePayload: `creditCardInvoice` selects the Gmail sender (Portal gmail-invoice.mjs
//   validateCreditCardInvoiceInput) while `body`/`subject` are stored/used as before. An OLD Portal
//   ignores `creditCardInvoice` and emails `body` through Re:amaze as Markdown, which is why Portal
//   deploys FIRST.
// SYNC: normalizeStaffNote below and Portal gmail-invoice.mjs normalizeInvoiceNote() apply the same
//   rules (Portal re-normalises defensively); change one, change the other.

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
 * quoteForPlainText(note) → string
 *
 * Prefixes every line of an already-normalised note with '> ' WITHOUT escaping anything, so the stored
 * order note reads naturally ("> Thanks for the order."). A blank line inside the note becomes a bare '>'
 * (no trailing space). Returns '' for empty input.
 */
export function quoteForPlainText(note) {
  if (!note) return '';
  return String(note)
    .split('\n')
    .map(line => (line ? `> ${line}` : '>'))
    .join('\n');
}

/**
 * buildLegacyInvoiceEmail({ orderName, amountText, currency, url, note }) → { subject, body }
 *
 * Builds the subject line and the PLAIN-TEXT body for the Helcim CC invoice: `subject` is the email
 * subject (Gmail path) and `body` is the text Portal stores as the customer-visible order note (and,
 * on an old Portal, emails through Re:amaze). `note` must already be normalised (via
 * normalizeStaffNote); pass '' or null when absent. The note is quoted with '> ' but NOT escaped.
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
  const noteBlock = note ? `\n\n${quoteForPlainText(note)}` : '';
  const body = `Your invoice for order ${orderName} is ready for ${amountText} ${currency}.${noteBlock}\n\nPay securely with Helcim:\n${url}`;
  return { subject, body };
}

/**
 * buildCreditCardInvoicePayload({ orderGid, orderName, amountText, amount, currency, url, note, addedBy }) → object
 *
 * The complete JSON body for Portal POST /__internal__/visible-note. Everything the pre-Gmail request
 * carried (orderId, body, subject, addedBy, emailCustomer, sendAs) is unchanged, so an OLD Portal behaves
 * exactly as before; the new `creditCardInvoice` object is what a NEW Portal uses to send the branded
 * Gmail email as wholesale@fuzzywumpets.com.
 *
 * WHAT: pure payload construction, unit-testable without a server (MOCK mode never calls Portal).
 * CHANGE-GUARD: `amount` is the exact numeric outstanding balance and `payUrl` is the Helcim hosted-page
 * link — neither may ever be logged or written to an audit row. `staffNote` is '' when there is no note.
 * INVARIANT(S): re-normalises `note` (idempotent), so `body` and `staffNote` always agree and stay <= 500 chars.
 * DEPENDS: Portal gmail-invoice.mjs validateCreditCardInvoiceInput — field names, amount as a number,
 * currency as 3 uppercase letters, payUrl on the allow-listed Helcim host, staffNote a string <= 500.
 */
export function buildCreditCardInvoicePayload({ orderGid, orderName, amountText, amount, currency, url, note, addedBy } = {}) {
  const staffNote = normalizeStaffNote(note);
  const { subject, body } = buildLegacyInvoiceEmail({ orderName, amountText, currency, url, note: staffNote });
  return {
    orderId: orderGid,
    body,
    subject,
    addedBy,
    emailCustomer: true,
    sendAs: 'wholesale',
    creditCardInvoice: { orderName, amount, currency, payUrl: url, staffNote },
  };
}
