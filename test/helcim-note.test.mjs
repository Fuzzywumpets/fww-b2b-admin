/**
 * helcim-note.test.mjs — Unit tests for lib/helcim-note.mjs
 *
 * Covers:
 *   normalizeStaffNote: empty/whitespace, 500-char cap, CRLF/LF normalisation,
 *     control-character stripping, trim.
 *   quoteForMarkdown: Markdown/HTML special-character escaping, blockquote prefix,
 *     multi-line, empty input (kept exported; no longer used by production code).
 *   quoteForPlainText: "> " prefix with NO escaping (what Portal stores as the order note).
 *   buildLegacyInvoiceEmail: subject contains #NNNNN token, body shape with and without
 *     note, subject contains order name, note is quoted as readable plain text.
 *   buildCreditCardInvoicePayload: the full Portal visible-note request, including the
 *     structured `creditCardInvoice` object and the old-Portal / old-Admin compatibility shape.
 *   Handler source guards: the send-credit-card-invoice route uses the builder, keeps the pay URL
 *     out of audit rows/logs, and records the note on the delivery-failed audit row (MOCK mode can
 *     never reach that branch over HTTP).
 *
 * Runs standalone (no server, no MOCK env required).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  normalizeStaffNote, quoteForMarkdown, quoteForPlainText, buildLegacyInvoiceEmail, buildCreditCardInvoicePayload,
} from '../lib/helcim-note.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    → ${e.message}`); failed++; }
}

// ── normalizeStaffNote ────────────────────────────────────────────────────────
console.log('');
console.log('── normalizeStaffNote ──');

test('null → empty string', () => {
  assert.equal(normalizeStaffNote(null), '');
});

test('whitespace-only → empty string', () => {
  assert.equal(normalizeStaffNote('   \n  '), '');
});

test('basic string passes through trimmed', () => {
  assert.equal(normalizeStaffNote('  hello  '), 'hello');
});

test('CRLF is normalised to LF', () => {
  const result = normalizeStaffNote('line1\r\nline2');
  assert.ok(!result.includes('\r'), `CR still present: ${JSON.stringify(result)}`);
  assert.ok(result.includes('\n'), 'LF missing after CRLF normalisation');
  assert.equal(result, 'line1\nline2');
});

test('bare CR is normalised to LF', () => {
  const result = normalizeStaffNote('line1\rline2');
  assert.ok(!result.includes('\r'), `CR still present: ${JSON.stringify(result)}`);
  assert.equal(result, 'line1\nline2');
});

test('control characters (non-LF) are stripped', () => {
  // \x01 SOH, \x07 BEL, \x0b VT, \x1b ESC
  const result = normalizeStaffNote('ok\x01ok\x07ok\x0bok\x1bok');
  assert.equal(result, 'okokokokok');
});

test('3+ blank lines collapsed to 2', () => {
  const input = 'para1\n\n\n\n\npara2';
  const result = normalizeStaffNote(input);
  assert.ok(!result.includes('\n\n\n'), `triple blank line not collapsed: ${JSON.stringify(result)}`);
  assert.ok(result.includes('\n\n'), 'double blank line should remain');
});

test('capped at 500 characters', () => {
  const long = 'x'.repeat(600);
  const result = normalizeStaffNote(long);
  assert.equal(result.length, 500);
});

test('499-char input not truncated', () => {
  const near = 'x'.repeat(499);
  assert.equal(normalizeStaffNote(near).length, 499);
});

// ── quoteForMarkdown ──────────────────────────────────────────────────────────
console.log('');
console.log('── quoteForMarkdown ──');

test('empty string → empty string', () => {
  assert.equal(quoteForMarkdown(''), '');
  assert.equal(quoteForMarkdown(null), '');
});

test('single line gets "> " prefix', () => {
  const result = quoteForMarkdown('hello');
  assert.equal(result, '> hello');
});

test('*bold* is escaped as \\*bold\\*', () => {
  const result = quoteForMarkdown('*bold*');
  assert.ok(result.includes('\\*bold\\*'), `escaped incorrectly: ${result}`);
});

test('[x](http://example.com) — brackets and parens are escaped', () => {
  const result = quoteForMarkdown('[x](http://example.com)');
  // brackets and parens must be escaped; the period in the domain is also escaped per spec
  assert.ok(result.includes('\\[x\\]'), `[ and ] not escaped: ${result}`);
  assert.ok(result.includes('\\(http'), `( not escaped: ${result}`);
  assert.ok(result.includes('\\)'), `) not escaped: ${result}`);
});

test('<b> HTML tag is escaped', () => {
  const result = quoteForMarkdown('<b>bold</b>');
  assert.ok(result.includes('\\<b\\>'), `< not escaped: ${result}`);
  assert.ok(result.includes('\\</b\\>'), `> not escaped: ${result}`);
});

test('backtick is escaped', () => {
  const result = quoteForMarkdown('`code`');
  assert.ok(result.includes('\\`code\\`'), `backtick not escaped: ${result}`);
});

test('multi-line: each line gets "> " prefix', () => {
  const result = quoteForMarkdown('line1\nline2');
  const lines = result.split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith('> '), `line1 prefix wrong: ${lines[0]}`);
  assert.ok(lines[1].startsWith('> '), `line2 prefix wrong: ${lines[1]}`);
});

test('CRLF line breaks produce "> "-prefixed lines (after normaliseStaffNote feeds in LF only)', () => {
  // quoteForMarkdown splits on \n; pre-normalised input only has \n
  const result = quoteForMarkdown('a\nb\nc');
  assert.equal(result.split('\n').length, 3);
});

// ── buildLegacyInvoiceEmail ───────────────────────────────────────────────────
console.log('');
console.log('── buildLegacyInvoiceEmail ──');

const ORDER_NAME = '#40089';
const AMOUNT = '$1.00';
const CURRENCY = 'USD';
const URL = 'https://fuzzywumpets.myhelcim.com/order/?token=abc123';

test('subject contains the #NNNNN order token', () => {
  const { subject } = buildLegacyInvoiceEmail({ orderName: ORDER_NAME, amountText: AMOUNT, currency: CURRENCY, url: URL, note: '' });
  assert.ok(subject.includes('#40089'), `#40089 missing from subject: ${subject}`);
});

test('subject contains the brand name', () => {
  const { subject } = buildLegacyInvoiceEmail({ orderName: ORDER_NAME, amountText: AMOUNT, currency: CURRENCY, url: URL, note: '' });
  assert.ok(subject.toLowerCase().includes('fuzzywumpets'), `brand missing from subject: ${subject}`);
});

test('body without note: no blockquote block', () => {
  const { body } = buildLegacyInvoiceEmail({ orderName: ORDER_NAME, amountText: AMOUNT, currency: CURRENCY, url: URL, note: '' });
  assert.ok(!body.includes('> '), `unexpected blockquote in no-note body: ${body}`);
});

test('body without note: contains order name and amount', () => {
  const { body } = buildLegacyInvoiceEmail({ orderName: ORDER_NAME, amountText: AMOUNT, currency: CURRENCY, url: URL, note: '' });
  assert.ok(body.includes('#40089'), `order name missing: ${body}`);
  assert.ok(body.includes('$1.00'), `amount missing: ${body}`);
  assert.ok(body.includes('USD'), `currency missing: ${body}`);
  assert.ok(body.includes(URL), `URL missing: ${body}`);
});

test('body with note: note is blockquoted and reads as plain text (period not escaped)', () => {
  const note = 'Please review this carefully.';
  const { body } = buildLegacyInvoiceEmail({ orderName: ORDER_NAME, amountText: AMOUNT, currency: CURRENCY, url: URL, note });
  assert.ok(body.includes('\n\n> Please review this carefully.\n\n'), `note not plainly blockquoted: ${JSON.stringify(body)}`);
});

// The Portal stores `body` as the customer-visible order note and renders it as HTML-escaped text, and the Gmail
// template escapes the note itself, so Markdown escaping would only put literal backslashes on the order page.
test('body with note: *bold* / [x](http://example.com) / <b> are kept verbatim, with NO backslash escapes', () => {
  for (const note of ['*bold*', '[x](http://example.com)', '<b>bold</b>', 'a_b_c # 1. - x | y ~z! `code`']) {
    const { body } = buildLegacyInvoiceEmail({ orderName: ORDER_NAME, amountText: AMOUNT, currency: CURRENCY, url: URL, note });
    assert.ok(body.includes(`> ${note}`), `note not verbatim: ${JSON.stringify(body)}`);
    assert.ok(!body.includes('\\'), `unexpected backslash in body: ${JSON.stringify(body)}`);
  }
});

test('body with note: CRLF note lines each prefixed with "> "', () => {
  // normalizeStaffNote is expected to convert CRLF → LF before buildLegacyInvoiceEmail is called;
  // test with LF (post-normalisation input) here.
  const note = 'line1\nline2';
  const { body } = buildLegacyInvoiceEmail({ orderName: ORDER_NAME, amountText: AMOUNT, currency: CURRENCY, url: URL, note });
  assert.ok(body.includes('> line1'), `line1 not blockquoted: ${body}`);
  assert.ok(body.includes('> line2'), `line2 not blockquoted: ${body}`);
});

test('body with null note falls back to no-note shape', () => {
  const { body } = buildLegacyInvoiceEmail({ orderName: ORDER_NAME, amountText: AMOUNT, currency: CURRENCY, url: URL, note: null });
  assert.ok(!body.includes('> '), `unexpected blockquote for null note: ${body}`);
});

test('pay link always present after the note block', () => {
  const note = 'Some note.';
  const { body } = buildLegacyInvoiceEmail({ orderName: ORDER_NAME, amountText: AMOUNT, currency: CURRENCY, url: URL, note });
  // "Some note." appears before the pay URL
  const noteIdx = body.indexOf('> Some note');
  const urlIdx = body.indexOf(URL);
  assert.ok(noteIdx > -1, `note blockquote not found in: ${body}`);
  assert.ok(urlIdx > noteIdx, `pay link should come after note (noteIdx=${noteIdx}, urlIdx=${urlIdx})`);
});

// ── quoteForPlainText ─────────────────────────────────────────────────────────
console.log('');
console.log('── quoteForPlainText ──');

test('empty / null → empty string', () => {
  assert.equal(quoteForPlainText(''), '');
  assert.equal(quoteForPlainText(null), '');
  assert.equal(quoteForPlainText(undefined), '');
});

test('single line gets "> " prefix and nothing is escaped', () => {
  assert.equal(quoteForPlainText('Hello *there* [x](http://example.com) <b> & "q".'), '> Hello *there* [x](http://example.com) <b> & "q".');
});

test('multi-line: each line prefixed; a blank line becomes a bare ">" (no trailing space)', () => {
  assert.equal(quoteForPlainText('line1\n\nline3'), '> line1\n>\n> line3');
});

// ── buildCreditCardInvoicePayload ─────────────────────────────────────────────
console.log('');
console.log('── buildCreditCardInvoicePayload ──');

const GID = 'gid://shopify/Order/40089';
const payloadArgs = (over = {}) => ({
  orderGid: GID, orderName: ORDER_NAME, amountText: '$48.00', amount: 48, currency: CURRENCY, url: URL,
  note: 'Thanks for the order.', addedBy: 'staff@fuzzywumpets.com', ...over,
});

test('payload carries every legacy field unchanged plus the structured creditCardInvoice object', () => {
  const p = buildCreditCardInvoicePayload(payloadArgs());
  const legacy = buildLegacyInvoiceEmail({ orderName: ORDER_NAME, amountText: '$48.00', currency: CURRENCY, url: URL, note: 'Thanks for the order.' });
  assert.equal(p.orderId, GID);
  assert.equal(p.body, legacy.body);
  assert.equal(p.subject, legacy.subject);
  assert.equal(p.addedBy, 'staff@fuzzywumpets.com');
  assert.equal(p.emailCustomer, true);
  assert.equal(p.sendAs, 'wholesale');
  assert.deepEqual(p.creditCardInvoice, { orderName: ORDER_NAME, amount: 48, currency: 'USD', payUrl: URL, staffNote: 'Thanks for the order.' });
  assert.deepEqual(Object.keys(p).sort(), ['addedBy', 'body', 'creditCardInvoice', 'emailCustomer', 'orderId', 'sendAs', 'subject']);
});

test('COMPAT new Admin + OLD Portal: stripping creditCardInvoice leaves exactly the pre-change request (old Portal ignores unknown keys)', () => {
  const p = buildCreditCardInvoicePayload(payloadArgs());
  const { creditCardInvoice, ...rest } = p;
  assert.ok(creditCardInvoice);
  // The pre-change handler sent precisely these six keys; an old Portal destructures only these.
  assert.deepEqual(Object.keys(rest).sort(), ['addedBy', 'body', 'emailCustomer', 'orderId', 'sendAs', 'subject']);
  assert.ok(rest.subject.startsWith('Your invoice from Fuzzywumpets is ready - order #40089'));
  assert.ok(!/^re:/i.test(rest.subject), 'the subject itself must not carry a Re: prefix');
  assert.ok(rest.body.includes(URL), 'stored note / legacy email still carries the pay link');
});

test('subject keeps the #NNNNN token (Portal scopes Re:amaze reply threads by it)', () => {
  assert.ok(buildCreditCardInvoicePayload(payloadArgs()).subject.includes('#40089'));
});

test('no note → staffNote is "" and body has no blockquote', () => {
  for (const note of ['', '   ', null, undefined]) {
    const p = buildCreditCardInvoicePayload(payloadArgs({ note }));
    assert.equal(p.creditCardInvoice.staffNote, '');
    assert.ok(!p.body.includes('> '));
  }
});

test('multi-line note: staffNote keeps raw text (no "> ", no escaping); body quotes it as plain text', () => {
  const p = buildCreditCardInvoicePayload(payloadArgs({ note: 'Line *one*\nLine [two](http://example.com)' }));
  assert.equal(p.creditCardInvoice.staffNote, 'Line *one*\nLine [two](http://example.com)');
  assert.ok(p.body.includes('> Line *one*\n> Line [two](http://example.com)'));
});

test('note is re-normalised defensively (CRLF, control chars, 500 cap) so body and staffNote agree', () => {
  const p = buildCreditCardInvoicePayload(payloadArgs({ note: 'a\r\nb\x01' + 'x'.repeat(600) }));
  assert.ok(!p.creditCardInvoice.staffNote.includes('\r') && !p.creditCardInvoice.staffNote.includes('\x01'));
  assert.equal(p.creditCardInvoice.staffNote.length, 500);
  assert.ok(p.body.includes('> a\n> b'));
});

test('amount stays a NUMBER and currency/payUrl are passed through for Portal to validate', () => {
  const p = buildCreditCardInvoicePayload(payloadArgs({ amount: 1234.5, currency: 'CAD' }));
  assert.equal(typeof p.creditCardInvoice.amount, 'number');
  assert.equal(p.creditCardInvoice.amount, 1234.5);
  assert.equal(p.creditCardInvoice.currency, 'CAD');
  assert.equal(p.creditCardInvoice.payUrl, URL);
});

test('payload survives JSON transport unchanged (it is sent with JSON.stringify)', () => {
  const p = buildCreditCardInvoicePayload(payloadArgs());
  assert.deepEqual(JSON.parse(JSON.stringify(p)), p);
});

// ── send-credit-card-invoice handler: source guards ───────────────────────────
// MOCK mode short-circuits before callPortalInternal and always "delivers", so neither the payload wiring nor the
// delivery-failed audit row is reachable over HTTP. These guard the call site itself.
console.log('');
console.log('── send-credit-card-invoice handler (source guards) ──');

// (`URL` is shadowed by the pay-link fixture above, so reach the global constructor explicitly.)
const serverSrc = readFileSync(fileURLToPath(new globalThis.URL('../server.mjs', import.meta.url)), 'utf8');
const handlerStart = serverSrc.indexOf("app.post('/orders/:id/send-credit-card-invoice'");
const handlerEnd = serverSrc.indexOf('// ── Invoice CSV export', handlerStart);
const handlerSrc = handlerStart >= 0 && handlerEnd > handlerStart ? serverSrc.slice(handlerStart, handlerEnd) : '';

test('handler source was located', () => {
  assert.ok(handlerSrc.length > 500, 'could not isolate the send-credit-card-invoice handler');
});

test('handler builds the Portal request with buildCreditCardInvoicePayload and posts it to /__internal__/visible-note', () => {
  assert.match(handlerSrc, /buildCreditCardInvoicePayload\(\{[\s\S]*?amount: outstanding[\s\S]*?url: invoice\.url[\s\S]*?note: staffNote[\s\S]*?\}\)/);
  assert.match(handlerSrc, /callPortalInternal\('POST', '\/__internal__\/visible-note', portalPayload\)/);
});

test('helcim_invoice_email_failed audit row records hasNote AND the (already-capped) note', () => {
  const failedRow = /auditLog\([^;]*?'helcim_invoice_email_failed'[\s\S]*?\}\);/.exec(handlerSrc);
  assert.ok(failedRow, 'delivery-failed audit call not found');
  assert.match(failedRow[0], /hasNote: !!staffNote/);
  assert.match(failedRow[0], /\.\.\.\(staffNote \? \{ note: staffNote \} : \{\}\)/);
});

test('no audit row or console log in the handler references the pay URL, token, or Portal payload', () => {
  const leak = /invoice\.url|\.token|payUrl|portalPayload|creditCardInvoice/;
  const audits = handlerSrc.match(/auditLog\([\s\S]*?\}\);/g) || [];
  assert.equal(audits.length, 2, 'expected the sent + failed audit rows');
  for (const row of audits) assert.ok(!leak.test(row), `audit row leaks the pay link: ${row}`);
  for (const log of handlerSrc.match(/console\.(log|warn|error|info)\([^\n]*/g) || []) {
    assert.ok(!leak.test(log), `console call leaks the pay link: ${log}`);
  }
});

// ─── summary ──────────────────────────────────────────────────────────────────
console.log('');
if (failed === 0) { console.log(`  HELCIM-NOTE: ${passed} passed, 0 failed ✓`); process.exit(0); }
else { console.log(`  HELCIM-NOTE: ${passed} passed, ${failed} FAILED ✗`); process.exit(1); }
