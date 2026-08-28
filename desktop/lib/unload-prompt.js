'use strict';

// WHAT: the "you have unsaved changes" prompt the shell shows when a page's `beforeunload` handler
//   tries to cancel a navigation, plus the rule for reading the answer.
//
// WHY THIS EXISTS AT ALL: Electron does NOT show a dialog for `beforeunload` on its own. When a page
//   calls preventDefault() there, Chromium asks the embedder via `will-prevent-unload`, and with no
//   listener attached the default is to CANCEL the unload — silently, with no UI. So on 2026-08-28
//   one unsaveable line-item edit on order #38953 left the admin page permanently "dirty" and the
//   whole app became unusable: every nav link, the back button, "Generate PDF" (a form POST is a
//   navigation) and even Quit did nothing at all, and it had to be killed from Task Manager. The web
//   build was fine the whole time — a browser shows its own Leave/Stay dialog. This module is the
//   missing dialog.
//
// CHANGE-GUARD: the caller's preventDefault() is INVERTED relative to every other Electron event.
//   On `will-prevent-unload`, event.preventDefault() means "ignore the page's beforeunload and LET
//   the unload proceed". Doing nothing means "stay". Read shouldAllowUnload()'s name literally and
//   let it decide; do not add a `!` at the call site.
//
// INVARIANT(S): "Stay" is both defaultId and cancelId, so Esc / the window's X / any dialog error
//   resolves to STAYING — the safe answer, since leaving is what discards work. LEAVE_INDEX is 0
//   only because that is where the button sits in `buttons`; the two must move together.

const LEAVE_INDEX = 0;
const STAY_INDEX = 1;

// Built as a function (not a frozen constant) so each call gets its own object — Electron mutates
// nothing here today, but sharing one options object across dialogs is a trap worth not setting.
function unloadPromptOptions() {
  return {
    type: 'warning',
    buttons: ['Leave', 'Stay on this page'],
    defaultId: STAY_INDEX,
    cancelId: STAY_INDEX,
    noLink: true,
    title: 'Unsaved changes',
    message: 'This page has changes that have not been saved.',
    detail: 'Leaving will discard them. Choose "Stay on this page" to go back and finish saving.',
  };
}

// The ONLY thing that permits an unload is an explicit click on Leave. Anything else — Stay, Esc,
// closing the dialog, or a non-numeric return from a failed dialog call — keeps the page.
function shouldAllowUnload(choice) {
  return choice === LEAVE_INDEX;
}

module.exports = { unloadPromptOptions, shouldAllowUnload, LEAVE_INDEX, STAY_INDEX };
