/**
 * helcim-note.test.mjs — Unit tests for lib/helcim-note.mjs
 *
 * Covers:
 *   normalizeStaffNote: empty/whitespace, 500-char cap, CRLF/LF normalisation,
 *     control-character stripping, trim.
 *   quoteForMarkdown: Markdown/HTML special-character escaping, blockquote prefix,
 *     multi-line, empty input.
 *   buildLegacyInvoiceEmail: subject contains #NNNNN token, body shape with and without
 *     note, subject contains order name, note is quoted literally.
 *
 * Runs standalone (no server, no MOCK env required).
 */
import assert from 'node:assert/strict';
import { normalizeStaffNote, quoteForMarkdown, buildLegacyInvoiceEmail } from '../lib/helcim-note.mjs';

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

test('body with note: note is blockquoted', () => {
  const note = 'Please review this carefully.';
  const { body } = buildLegacyInvoiceEmail({ orderName: ORDER_NAME, amountText: AMOUNT, currency: CURRENCY, url: URL, note });
  // The line is prefixed with "> "; the period may be escaped as "\." per Markdown escaping rules.
  assert.ok(body.includes('> Please review this carefully'), `note not blockquoted: ${body}`);
});

test('body with note: *bold* is rendered literally (escaped)', () => {
  const note = '*bold*';
  const { body } = buildLegacyInvoiceEmail({ orderName: ORDER_NAME, amountText: AMOUNT, currency: CURRENCY, url: URL, note });
  assert.ok(!body.includes('> *bold*'), `*bold* not escaped in body: ${body}`);
  assert.ok(body.includes('\\*bold\\*'), `escaped bold not found: ${body}`);
});

test('body with note: [x](http://example.com) is rendered literally (escaped)', () => {
  const note = '[x](http://example.com)';
  const { body } = buildLegacyInvoiceEmail({ orderName: ORDER_NAME, amountText: AMOUNT, currency: CURRENCY, url: URL, note });
  // brackets and parens are escaped; period in domain also escaped
  assert.ok(body.includes('\\[x\\]'), `[ ] not escaped: ${body}`);
  assert.ok(body.includes('\\(http'), `( not escaped: ${body}`);
  assert.ok(body.includes('\\)'), `) not escaped: ${body}`);
});

test('body with note: <b> HTML is escaped', () => {
  const note = '<b>bold</b>';
  const { body } = buildLegacyInvoiceEmail({ orderName: ORDER_NAME, amountText: AMOUNT, currency: CURRENCY, url: URL, note });
  assert.ok(body.includes('\\<b\\>'), `< not escaped in body: ${body}`);
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
  // "Some note" (period may be escaped as "\." by quoteForMarkdown) appears before the pay URL
  const noteIdx = body.indexOf('> Some note');
  const urlIdx = body.indexOf(URL);
  assert.ok(noteIdx > -1, `note blockquote not found in: ${body}`);
  assert.ok(urlIdx > noteIdx, `pay link should come after note (noteIdx=${noteIdx}, urlIdx=${urlIdx})`);
});

// ─── summary ──────────────────────────────────────────────────────────────────
console.log('');
if (failed === 0) { console.log(`  HELCIM-NOTE: ${passed} passed, 0 failed ✓`); process.exit(0); }
else { console.log(`  HELCIM-NOTE: ${passed} passed, ${failed} FAILED ✗`); process.exit(1); }
