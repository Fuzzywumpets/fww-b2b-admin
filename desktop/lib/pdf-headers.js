'use strict';

// WHAT: decides whether a response about to render in the MAIN window is an inline PDF, and if so
//   rewrites its headers so the browser downloads it instead of navigating the window to it.
//
// WHY THIS EXISTS: the shell used to decide "is this a PDF?" from the URL alone
//   (`isAdminPdfUrl` -> /\.pdf($|[?#])/). Anything that serves a PDF from a URL without `.pdf` in it
//   slipped straight past that test and took over the MAIN window — which renders the PDF with no
//   back button, and whose X quits the entire app (mainWindow's close handler destroys every window
//   and calls app.quit()). Reported twice by alexa; the second time from
//   POST /orders/:id/partial-invoice, whose URL has no `.pdf` at all.
//
//   A URL heuristic cannot be made complete — /labels/preview and the lead tax-exemption PDF have
//   the same shape, and the next such route will too. Content-Type is the actual fact, so this
//   checks that instead and lets the URL rule stay as the fast path for previews.
//
// CHANGE-GUARD: this module is pure so it can be unit-tested without launching Electron; keep it
//   free of electron imports. The CALLER is responsible for scoping it to main-frame requests in the
//   main window — an iframe (the invoice viewer) and the dedicated PDF windows MUST keep rendering
//   inline, so applying this to them would break preview entirely.
// SYNC: desktop/main.js is the only caller; test/desktop-pdf-headers.test.mjs is the only test.

// Response header names arrive with inconsistent casing depending on the server, so every lookup
// here is case-insensitive. Returns the ACTUAL key so the caller can delete the original entry.
function findHeader(headers, name) {
  const wanted = String(name).toLowerCase();
  const key = Object.keys(headers || {}).find((k) => k.toLowerCase() === wanted);
  if (!key) return null;
  const raw = headers[key];
  return { key, value: Array.isArray(raw) ? raw[0] : raw };
}

// Pulls the filename out of a Content-Disposition value, quoted or bare.
function dispositionFilename(value) {
  const m = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(value || '');
  return ((m && (m[1] || m[2])) || '').trim();
}

// WHAT: given a response's headers, returns replacement headers that force a download, or null to
//   leave the response untouched.
// INVARIANT(S): returns null (not a copy) whenever nothing should change, so the caller can pass a
//   bare `callback({})` and avoid rewriting headers on every request in the app. Any filename the
//   server already chose is PRESERVED — that name is what the file is saved as, and the server picks
//   a better one (`#37637-B-invoice.pdf`) than anything derivable here.
function pdfAttachmentHeaders(responseHeaders) {
  const headers = responseHeaders || {};

  const contentType = findHeader(headers, 'content-type');
  if (!/^\s*application\/pdf\b/i.test(contentType?.value || '')) return null;

  const disposition = findHeader(headers, 'content-disposition');
  // Already a download — the server got it right, don't touch it.
  if (/^\s*attachment/i.test(disposition?.value || '')) return null;

  const filename = dispositionFilename(disposition?.value);
  const next = { ...headers };
  if (disposition) delete next[disposition.key];
  next['Content-Disposition'] = [filename ? `attachment; filename="${filename}"` : 'attachment'];
  return next;
}

module.exports = { pdfAttachmentHeaders, findHeader, dispositionFilename };
