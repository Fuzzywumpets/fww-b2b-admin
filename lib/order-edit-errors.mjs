// WHAT: classifies an order-edit failure as TERMINAL (resending the identical request can never
//   succeed) or retryable.
//
// WHY: the order-detail page treats an outstanding retryable failure as unsaved work and arms a
//   `beforeunload` guard on it. A rejection that can never succeed therefore armed that guard
//   forever — and Electron cancels a prevented unload with NO dialog, so on 2026-08-28 order #38953
//   one un-retryable line edit took out every nav link, the back button, "Generate PDF" (a form
//   POST is a navigation) and Quit itself, and the shell had to be ended from Task Manager. The
//   flag this module produces is what lets the client show the rejection without holding the page.
//
// CHANGE-GUARD: add a pattern ONLY when retrying the identical request cannot succeed. Anything
//   transient — throttling, a 5xx, a lost lock, a concurrent edit, a paging hiccup — must stay
//   retryable, or the operator loses the retry button on work that would have gone through on the
//   second attempt. When in doubt, leave it out: a wrongly-retryable error costs one wasted click,
//   a wrongly-terminal one costs a silently abandoned edit.
//
// SYNC: the client half lives in the order-detail script in server.mjs — run() and flushLine() read
//   `terminal` off the response and stamp data-terminal onto the row chip, which recomputeFailed()
//   then excludes from the unload guard. Both halves must move together: the flag is inert without
//   the chip, and the chip lies without the flag.

export const TERMINAL_EDIT_ERRORS = [
  // Shopify, after a prior edit set the line's quantity to 0. The line is gone from the order and
  // no later orderEditSetQuantity against it will ever be accepted. THE #38953 case.
  /cannot be edited because it is removed/i,
  // Our own mapping failure: the original line id is not on the order at all, so there is nothing
  // to map it onto. (Note this used to fire spuriously for lines past the 100th — that was a
  // pagination defect, now fixed; a genuine one here is permanent.)
  /line not found on order/i,
  // Our own floor in POST /orders/:id/line/qty — quantity 0 is a removal, which has its own route.
  /quantity must be at least 1/i,
];

export function isTerminalEditError(messages) {
  const list = Array.isArray(messages) ? messages : [messages];
  return list.some(m => {
    const s = m == null ? '' : String(m);
    return TERMINAL_EDIT_ERRORS.some(re => re.test(s));
  });
}
