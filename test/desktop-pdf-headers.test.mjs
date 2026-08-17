// Unit tests for desktop/lib/pdf-headers.js — the guard that stops a PDF from taking over the
// Electron shell's MAIN window (no back button; its X quits the whole app).
//
// Standalone because this is shell code: it never runs inside the Express server, so the API suite
// cannot reach it. It is pure precisely so it can be tested without launching Electron.
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pdfAttachmentHeaders, dispositionFilename } = require('../desktop/lib/pdf-headers.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}

console.log('\n── Unit: desktop PDF main-window guard ──\n');

// THE REPORTED BUG: POST /orders/:id/partial-invoice served `inline` from a URL with no `.pdf`,
// so the URL heuristic missed it and the PDF rendered in the main window.
test('an inline PDF is converted to a download', () => {
  const out = pdfAttachmentHeaders({
    'Content-Type': ['application/pdf'],
    'Content-Disposition': ['inline; filename="#37637-B-invoice.pdf"'],
  });
  assert.ok(out, 'must rewrite an inline PDF');
  assert.equal(out['Content-Disposition'][0], 'attachment; filename="#37637-B-invoice.pdf"');
});

test('the server-chosen filename is preserved, extension and all', () => {
  const out = pdfAttachmentHeaders({
    'content-type': ['application/pdf'],
    'content-disposition': ['inline; filename="lead-12-tax-exemption.pdf"'],
  });
  assert.match(out['Content-Disposition'][0], /^attachment; filename="lead-12-tax-exemption\.pdf"$/);
});

test('a PDF with NO disposition at all still becomes a download', () => {
  const out = pdfAttachmentHeaders({ 'Content-Type': ['application/pdf'] });
  assert.equal(out['Content-Disposition'][0], 'attachment');
});

test('header casing is irrelevant (servers vary)', () => {
  for (const key of ['Content-Type', 'content-type', 'CONTENT-TYPE']) {
    assert.ok(pdfAttachmentHeaders({ [key]: ['application/pdf'] }), `${key} must be recognised`);
  }
});

test('a charset/parameter suffix on the content type still counts', () => {
  assert.ok(pdfAttachmentHeaders({ 'Content-Type': ['application/pdf; charset=binary'] }));
});

// Left alone: rewriting these would either be pointless or actively break something.
test('an ALREADY-attachment PDF is left untouched', () => {
  assert.equal(pdfAttachmentHeaders({
    'Content-Type': ['application/pdf'],
    'Content-Disposition': ['attachment; filename="x.pdf"'],
  }), null, 'must return null so the caller skips the rewrite');
});

test('non-PDF responses are never rewritten', () => {
  for (const ct of ['text/html', 'application/json', 'image/png', 'application/pdfx-bogus']) {
    assert.equal(pdfAttachmentHeaders({ 'Content-Type': [ct] }), null, `${ct} must be left alone`);
  }
});

test('missing / empty headers do not throw', () => {
  assert.equal(pdfAttachmentHeaders(undefined), null);
  assert.equal(pdfAttachmentHeaders({}), null);
  assert.equal(pdfAttachmentHeaders({ 'Content-Type': [] }), null);
});

test('a bare (unarrayed) header value is handled', () => {
  const out = pdfAttachmentHeaders({ 'Content-Type': 'application/pdf' });
  assert.ok(out, 'Electron normally gives arrays, but a string must not crash the guard');
});

test('filename parsing handles quoted and bare forms', () => {
  assert.equal(dispositionFilename('inline; filename="a b.pdf"'), 'a b.pdf');
  assert.equal(dispositionFilename('inline; filename=plain.pdf'), 'plain.pdf');
  assert.equal(dispositionFilename('inline'), '');
  assert.equal(dispositionFilename(undefined), '');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
