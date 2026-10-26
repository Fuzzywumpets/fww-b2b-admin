// WHAT: keeps staff IN EDIT MODE across the full-page POST -> 302 -> GET round trips that the order page
//   makes while they are editing (2026-10-26 owner feedback: "takes the screen out of edit mode after every
//   change"). A page reload always lands in VIEW mode, so every Mark backordered / Undo backorder / Apply
//   discount / Fulfill ... bounced the operator out and made them click "Edit order" again.
//
// HOW (three cooperating halves, all keyed on one request field `editMode=1`):
//   1. CLIENT (server.mjs editModeScript, rememberEditMode): a capture-phase submit listener — and the Undo
//      button, which calls form.submit() and therefore fires no submit event — adds a hidden `editMode=1` to
//      the form being posted, ONLY while edit mode is actually on and ONLY for the actions in KEEP_EDIT_ACTIONS.
//      It also stashes where the Line Items card sits in the viewport so the scroll position can be restored.
//   2. SERVER (keepEditModeRedirects below): for such a POST, any redirect back to the SAME order page gets
//      `edit=1` appended, plus the #line-items anchor when the redirect has none. Success AND failure
//      redirects both go through res.redirect, so a refused action keeps edit mode AND shows its error.
//   3. PAGE (server.mjs GET /orders/:id -> renderOrderDetail): `?edit=1` makes the page call
//      toggleEditMode(true) on load, restore the scroll position, and strip `edit` from the address bar.
//      A plain load never has `edit=1`, so edit mode is never forced on.
//
// CHANGE-GUARD:
//   * KEEP_EDIT_ACTIONS is an ALLOW-LIST. "POST /orders/:id/edit" (the "Save changes" button) is deliberately
//     NOT in it: Save is the operator's "I am done" gesture and ends edit mode. /cancel is out too (a cancelled
//     order has nothing left to edit), and so are the invoice routes (they answer with a PDF, not a redirect,
//     and belong to the invoice work). Adding an action here needs no other change: the client list is built
//     from this same array.
//   * The server never TRUSTS the field for anything but the redirect suffix: it is not stored, not echoed
//     into HTML, and only the exact string '1' counts. The rewrite is limited to a redirect whose target is
//     this same order's page (/orders/<same id>), so it cannot be turned into an open redirect.
//   * The query string is extended textually, never re-parsed: ?msg= values keep the exact encoding the
//     route gave them.
//
// INVARIANT(S): pure functions + one Express middleware; no I/O, no Shopify, no DB. Idempotency tokens,
//   withOrderLock and fail-closed behaviour all live in the routes and are untouched: this module only
//   rewrites the Location header AFTER a route has decided where to redirect.
//
// DEPENDS: server.mjs mounts keepEditModeRedirects with app.use('/orders', ...) AFTER the body parsers (it reads
//   req.body.editMode) and BEFORE the routes; renderOrderDetail reads `resumeEdit`; the order page's Line
//   Items card carries id="line-items" (EDIT_ANCHOR). test/edit-mode-resume.test.mjs pins all of it.
// SYNC: KEEP_EDIT_ACTIONS <-> the `KEEP_EDIT_RE` literal the order page embeds (built from this array by
//   keepEditClientPattern(), so there is nothing to hand-edit).

export const EDIT_FIELD = 'editMode';
export const EDIT_PARAM = 'edit';
export const EDIT_ANCHOR = 'line-items';

// The /orders/:id/<action> POSTs that make sense WHILE editing and answer with a redirect to the order page.
export const KEEP_EDIT_ACTIONS = Object.freeze([
  'backorder', 'backorder/undo',
  'discount', 'fulfill', 'mark-paid', 'record-payment',
  'note', 'internal-note', 'shipping-charge', 'shipping-address',
  'xero/sync',
]);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const ACTION_ALT = KEEP_EDIT_ACTIONS.map(escapeRe).join('|');
// Matches a request path such as /orders/18948052451563/backorder/undo and captures the numeric order id.
export const KEEP_EDIT_PATH_RE = new RegExp(`^/orders/(\\d+)/(?:${ACTION_ALT})/?$`);

// The same pattern as JS source for the inline script (browser side tests form.action's pathname with it).
export function keepEditClientPattern() {
  return `^/orders/\\d+/(?:${ACTION_ALT})/?$`;
}

// True only for the exact opt-in value the page sends.
export function wantsEditMode(body) {
  return !!body && typeof body === 'object' && body[EDIT_FIELD] === '1';
}

// WHAT: `/orders/<numId>[?query][#hash]` -> the same URL with edit=1 and an anchor; anything else is
//   returned untouched (another order, another path, an absolute URL, a non-string).
export function withEditMode(location, numId) {
  if (typeof location !== 'string') return location;
  const m = /^\/orders\/(\d+)(\?[^#]*)?(#.*)?$/.exec(location);
  if (!m || m[1] !== String(numId)) return location;
  let query = m[2] || '';
  if (!new RegExp(`[?&]${EDIT_PARAM}=`).test(query)) query += (query ? '&' : '?') + `${EDIT_PARAM}=1`;
  return `/orders/${m[1]}${query}${m[3] || `#${EDIT_ANCHOR}`}`;
}

// WHAT: Express middleware. For an opted-in POST to a KEEP_EDIT_ACTIONS route, wraps res.redirect so a
//   redirect back to the same order page keeps edit mode. Everything else passes through unchanged.
export function keepEditModeRedirects(req, res, next) {
  if (req.method !== 'POST' || !wantsEditMode(req.body)) return next();
  const m = KEEP_EDIT_PATH_RE.exec(req.baseUrl + req.path);
  if (!m) return next();
  const numId = m[1];
  const redirect = res.redirect.bind(res);
  // express: res.redirect(url) or res.redirect(status, url)
  res.redirect = (a, b) => (typeof a === 'number' ? redirect(a, withEditMode(b, numId)) : redirect(withEditMode(a, numId)));
  return next();
}
