// Standalone unit + source guards for the 2026-08-28 order #38953 lock-up.
//
// THE BUG, end to end: an operator typed 0 into a line's quantity box. Quantity 0 is a REMOVAL in
// Shopify's order-edit model, so the line was destroyed with no confirmation; typing a number back
// then failed with "The line item cannot be edited because it is removed" — and would fail that way
// forever. The order page's autosave controller counted that permanent failure as unsaved work and
// armed a `beforeunload` guard on it. Electron shows NO dialog for beforeunload unless the app
// answers `will-prevent-unload`, and this shell did not, so the prevented unload was cancelled
// silently: every nav link, the back button, "Generate PDF" (a form POST is a navigation) and Quit
// itself stopped working with no message at all. "I can't even quit the electron shell app.
// impossible to quit without End Task."
//
// Standalone because none of it is reachable from the HTTP suites: desktop/* never runs inside the
// Express server, and the source guards assert on call sites that no unit test of the extracted
// module can see. (A stranded capability is invisible to a test of the module it lives in — the
// missing CALL SITE is the defect.)

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isTerminalEditError, TERMINAL_EDIT_ERRORS } from '../lib/order-edit-errors.mjs';
import { drainLineItems, LINE_PAGE_MAX, LINE_PAGE_LIMIT } from '../lib/line-item-paging.mjs';

const require = createRequire(import.meta.url);
const { unloadPromptOptions, shouldAllowUnload, LEAVE_INDEX, STAY_INDEX } = require('../desktop/lib/unload-prompt.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}

console.log('\n── Unit: order-edit navigation deadlock (#38953) ──\n');

const serverSrc = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
const mainSrc   = await readFile(new URL('../desktop/main.js', import.meta.url), 'utf8');

// ── the Electron escape hatch ────────────────────────────────────────────────

await test('the unload prompt offers Leave and Stay, and Stay is the safe default', () => {
  const o = unloadPromptOptions();
  assert.deepEqual(o.buttons, ['Leave', 'Stay on this page']);
  assert.equal(o.defaultId, STAY_INDEX, 'Enter must not discard work');
  assert.equal(o.cancelId, STAY_INDEX, 'Esc / closing the dialog must not discard work');
  assert.ok(o.message && o.detail, 'the dialog has to say what is at stake');
});

await test('ONLY an explicit Leave permits the unload', () => {
  assert.equal(shouldAllowUnload(LEAVE_INDEX), true);
  assert.equal(shouldAllowUnload(STAY_INDEX), false);
  // A failed dialog call, a cancelled dialog, or anything unexpected keeps the page.
  for (const junk of [undefined, null, -1, 2, '0', NaN, {}]) {
    assert.equal(shouldAllowUnload(junk), false, `unexpected dialog result ${String(junk)} must NOT discard work`);
  }
});

// THE regression that mattered: the handler was ABSENT. A unit test of unload-prompt.js passes
// happily whether or not anything calls it, so assert the call site itself.
await test('desktop/main.js actually REGISTERS will-prevent-unload (the missing call site)', () => {
  assert.match(mainSrc, /webContents\.on\(\s*'will-prevent-unload'/,
    'without this listener Electron cancels a prevented unload silently — that IS the lock-up');
  assert.match(mainSrc, /shouldAllowUnload\(/, 'the decision must come from the tested helper');
  assert.match(mainSrc, /showMessageBoxSync/, 'the operator has to be ASKED, not silently obeyed');
});

// preventDefault() is INVERTED on this event: it ALLOWS the unload. A `!` slipped in at the call
// site would turn the dialog into "Leave = stay, Stay = leave", which is worse than no dialog.
await test('the will-prevent-unload call site does not negate shouldAllowUnload', () => {
  const handler = mainSrc.slice(mainSrc.indexOf("'will-prevent-unload'"));
  const body = handler.slice(0, handler.indexOf('\n  });'));
  assert.ok(/if \(shouldAllowUnload\(choice\)\) event\.preventDefault\(\);/.test(body),
    `preventDefault must be gated on the UNNEGATED helper; got:\n${body}`);
});

// ── terminal-vs-retryable classification ─────────────────────────────────────

await test('the exact Shopify message from #38953 is terminal', () => {
  assert.equal(isTerminalEditError(['The line item cannot be edited because it is removed']), true);
});

await test('our own quantity floor is terminal', () => {
  assert.equal(isTerminalEditError(['Quantity must be at least 1 — use Remove to take a line off the order.']), true);
});

await test('transient failures stay RETRYABLE (losing the retry button is its own bug)', () => {
  for (const msg of [
    'Throttled',
    'Internal Server Error',
    'network error',
    'timed out — not saved',
    'quantity did not persist — expected 3, order still shows 1 (please retry)',
    'order line state: line items unavailable while paging',
    'calculated order: line items did not paginate to completion after 40 pages',
  ]) {
    assert.equal(isTerminalEditError([msg]), false, `"${msg}" must stay retryable`);
  }
});

await test('classification tolerates junk shapes and a bare string', () => {
  assert.equal(isTerminalEditError([]), false);
  assert.equal(isTerminalEditError([null, undefined]), false);
  assert.equal(isTerminalEditError('The line item cannot be edited because it is removed'), true);
  assert.ok(TERMINAL_EDIT_ERRORS.every(re => re instanceof RegExp), 'patterns must be regexes');
});

// ── line-item pagination ─────────────────────────────────────────────────────

const page = (ids, hasNextPage, endCursor = null) => ({
  pageInfo: { hasNextPage, endCursor },
  edges: ids.map(id => ({ node: { id } })),
});

await test('a single page is returned as-is, with no extra round-trip', async () => {
  let calls = 0;
  const out = await drainLineItems(page(['a', 'b'], false), 'order', async () => { calls++; return null; });
  assert.deepEqual(out.map(n => n.id), ['a', 'b']);
  assert.equal(calls, 0, 'an order under the page size must cost exactly one request');
});

// THE #38953 shape: 131 lines is two pages. Under the old first:100 the second page did not exist.
await test('every page is walked — a 131-line order yields 131 lines, not 100', async () => {
  const all = Array.from({ length: 131 }, (_, i) => `li${i + 1}`);
  const first = page(all.slice(0, 100), true, 'cur100');
  const out = await drainLineItems(first, 'order', async (after) => {
    assert.equal(after, 'cur100', 'the cursor from pageInfo must be passed through');
    return page(all.slice(100), false);
  });
  assert.equal(out.length, 131, `truncated to ${out.length} — this is the exact defect`);
  assert.deepEqual(out.map(n => n.id), all);
});

await test('a missing next page THROWS rather than returning a silent prefix', async () => {
  await assert.rejects(
    () => drainLineItems(page(['a'], true, 'c1'), 'order', async () => null),
    /line items unavailable while paging/);
});

await test('a looping cursor is bounded, and the bound throws instead of truncating', async () => {
  let calls = 0;
  await assert.rejects(
    () => drainLineItems(page(['a'], true, 'c'), 'order', async () => { calls++; return page(['b'], true, 'c'); }),
    /did not paginate to completion/);
  assert.equal(calls, LINE_PAGE_LIMIT, `should stop after exactly ${LINE_PAGE_LIMIT} pages, made ${calls}`);
});

await test('an absent or empty connection degrades to an empty list, not a crash', async () => {
  assert.deepEqual(await drainLineItems(null, 'order', async () => null), []);
  assert.deepEqual(await drainLineItems({}, 'order', async () => null), []);
});

// ── source guards: the fixes have to be WIRED, not merely written ────────────

await test('no lineItems query in the order-edit path is capped at first:100 any more', () => {
  const offenders = serverSrc.split('\n')
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(({ l }) => /lineItems\(first:100\)/.test(l) && !/^\s*\/\//.test(l));
  assert.equal(offenders.length, 0,
    `truncated lineItems query at line(s) ${offenders.map(o => o.n).join(', ')} — page it with drainLineItems`);
});

await test('every paged lineItems query actually selects pageInfo', () => {
  // A `first:${LINE_PAGE_MAX}` with no pageInfo is worse than first:100 — it truncates at a higher
  // number while LOOKING paginated, so nobody re-checks it.
  // Flattened, because these queries are template literals that wrap: the selection set routinely
  // sits on the line AFTER the connection call.
  const flat = serverSrc.replace(/\s+/g, ' ');
  const marker = 'lineItems(first:${LINE_PAGE_MAX}';
  let at = flat.indexOf(marker), bad = 0, checked = 0;
  while (at !== -1) {
    checked++;
    if (!flat.slice(at, at + 120).includes('pageInfo')) bad++;
    at = flat.indexOf(marker, at + marker.length);
  }
  assert.ok(checked >= 5, `expected to find the paged queries, saw ${checked}`);
  assert.equal(bad, 0, `${bad} of ${checked} paged lineItems queries do not select pageInfo`);
});

await test('POST /orders/:id/line/qty enforces the quantity floor server-side', () => {
  assert.match(serverSrc, /if \(!\(q >= 1\)\) \{/,
    'qty 0 must be refused at the route — it is an irreversible removal, not an edit');
  assert.ok(!/if \(!liId \|\| !\(q >= 0\)\)/.test(serverSrc), 'the old qty>=0 gate must be gone');
});

await test('the unload guard is escapable from inside the page', () => {
  assert.match(serverSrc, /if \(allowLeave\) return;/,
    'a guard with no in-page override strands operators on older desktop builds');
  assert.match(serverSrc, /id="autosave-leave-anyway"/, 'the override needs a control the operator can see');
});

await test('terminal failures are excluded from the unload guard', () => {
  assert.match(serverSrc, /\.row-save-chip\[data-state="failed"\]:not\(\[data-terminal="1"\]\)/,
    'recomputeFailed must ignore rejections that can never be saved');
});

await test('the client sends no quantity below 1, and reverts the box instead', () => {
  assert.match(serverSrc, /min="1" data-last=/, 'the qty input must floor at 1 and remember its last good value');
  assert.match(serverSrc, /qtyEl\.value = qtyEl\.dataset\.last \|\| '1';/, 'an out-of-range entry must revert');
});

await test('a committed removal locks its row', () => {
  assert.match(serverSrc, /tr\.dataset\.lineRemoved = '1';/, 'the removal must be recorded on the row');
  assert.match(serverSrc, /if \(row\.dataset\.lineRemoved === '1'\) return;/,
    'markRemove must stop being a toggle once Shopify has accepted the removal');
  assert.match(serverSrc, /tr\[data-line-removed="1"\]/,
    'toggleEditMode must not re-enable the inputs of a removed line');
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
