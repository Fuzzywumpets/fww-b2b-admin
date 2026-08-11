// Standalone unit test (no server): the batch order-edit path must ABORT on an
// orderEditSetQuantity userError instead of committing the rest of the batch.
//
// Why not an HTTP test: POST /orders/:id/edit returns from its MOCK branch before any Shopify
// mutation runs, so the mock server cannot exercise the real orderEditSetQuantity loops at all.
// This suite therefore tests (a) the shared assert helper's semantics and (b) a faithful replay of
// the two loops with a stubbed shopifyFetch, driving the exact money bug that was reported:
// a REJECTED remove leaves the line on the order, yet the post-commit guard only fires when the
// live line count is LOWER than expected, so the batch committed and the customer was billed for
// the line staff deleted.

import { collectUserErrors, assertNoUserErrors } from '../lib/shopify-user-errors.mjs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
async function assertThrows(fn, re, msg) {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  if (!threw) throw new Error(msg || 'expected a throw, got none');
  if (re && !re.test(threw.message)) throw new Error(`${msg || 'wrong error'} — got: ${threw.message}`);
  return threw;
}

console.log('\n  order-edit userErrors');

// ── the helper ───────────────────────────────────────────────────────────────
await test('collectUserErrors tolerates a null / partial response shape', () => {
  assertEqual(collectUserErrors(null, 'orderEditSetQuantity').length, 0);
  assertEqual(collectUserErrors({}, 'orderEditSetQuantity').length, 0);
  assertEqual(collectUserErrors({ data: {} }, 'orderEditSetQuantity').length, 0);
  assertEqual(collectUserErrors({ data: { orderEditSetQuantity: { userErrors: [] } } }, 'orderEditSetQuantity').length, 0);
});

await test('assertNoUserErrors is a no-op on a clean mutation', () => {
  assertNoUserErrors({ data: { orderEditSetQuantity: { calculatedOrder: { id: 'c1' }, userErrors: [] } } }, 'orderEditSetQuantity', 'li/1');
});

await test('assertNoUserErrors throws with the mutation, the context and the Shopify message', async () => {
  const err = await assertThrows(
    () => assertNoUserErrors(
      { data: { orderEditSetQuantity: { userErrors: [{ field: ['quantity'], message: 'Line item is fulfilled' }] } } },
      'orderEditSetQuantity', 'remove gid://shopify/LineItem/55'),
    /Line item is fulfilled/, 'must surface the real Shopify reason');
  assert(/orderEditSetQuantity/.test(err.message), 'names the mutation');
  assert(/LineItem\/55/.test(err.message), 'names the failing line');
});

// ── replay of the two batch loops ────────────────────────────────────────────
// Mirrors server.mjs POST /orders/:id/edit: qty loop, then remove loop, then commit.
// SYNC: order-edit-batch-loops — if the qty/remove loops in server.mjs stop calling
// assertNoUserErrors, this replay still passes but the source guard at the bottom fails.
function okSetQty()   { return { data: { orderEditSetQuantity: { calculatedOrder: { id: 'calc/1' }, userErrors: [] } } }; }
function failSetQty(m){ return { data: { orderEditSetQuantity: { userErrors: [{ field: ['lineItemId'], message: m }] } } }; }

async function runBatch({ qtys = {}, removes = [], setQtyResponse }) {
  const calls = [];
  let committed = false;
  const shopifyFetch = async (_q, vars) => { calls.push(vars); return setQtyResponse(vars); };

  const removeSet = new Set(removes);
  for (const [liId, newQty] of Object.entries(qtys)) {
    if (removeSet.has(liId)) continue;
    const r = await shopifyFetch('setQty', { li: liId, qty: newQty, r: false });
    assertNoUserErrors(r, 'orderEditSetQuantity', liId);
  }
  for (const liId of removeSet) {
    const r = await shopifyFetch('setQty', { li: liId, qty: 0, r: true });
    assertNoUserErrors(r, 'orderEditSetQuantity', `remove ${liId}`);
  }
  committed = true;               // orderEditCommit would run here
  return { calls, committed };
}

await test('a clean batch still commits (no false positive)', async () => {
  const { calls, committed } = await runBatch({ qtys: { 'li/1': 4 }, removes: ['li/2'], setQtyResponse: okSetQty });
  assertEqual(calls.length, 2, 'one mutation per changed line');
  assertEqual(committed, true, 'clean batch must reach commit');
});

await test('MONEY: a rejected REMOVE aborts before commit — the customer is not billed for the line', async () => {
  // The exact reported scenario: staff remove li/2, Shopify rejects it, the other edits are fine.
  // Pre-fix this committed with success=order_edited and li/2 stayed on the invoice + Xero payment.
  let committed = false;
  await assertThrows(async () => {
    const out = await runBatch({
      qtys: { 'li/1': 4 },
      removes: ['li/2'],
      setQtyResponse: (v) => (v.qty === 0 ? failSetQty('Line item cannot be removed') : okSetQty()),
    });
    committed = out.committed;
  }, /remove li\/2.*cannot be removed/, 'must throw naming the failed remove');
  assertEqual(committed, false, 'orderEditCommit must NOT run after a failed remove');
});

await test('MONEY: a rejected QTY CHANGE aborts before commit', async () => {
  let committed = false;
  await assertThrows(async () => {
    const out = await runBatch({
      qtys: { 'li/1': 4 },
      setQtyResponse: () => failSetQty('Quantity must be greater than or equal to 0'),
    });
    committed = out.committed;
  }, /orderEditSetQuantity li\/1/, 'must throw naming the failed qty line');
  assertEqual(committed, false, 'orderEditCommit must NOT run after a failed qty change');
});

await test('the abort happens on the FAILING line, not after the whole batch', async () => {
  const seen = [];
  await assertThrows(() => runBatch({
    qtys: { 'li/1': 4, 'li/2': 7 },
    setQtyResponse: (v) => { seen.push(v.li); return v.li === 'li/1' ? failSetQty('nope') : okSetQty(); },
  }), /nope/);
  assertEqual(seen.join(','), 'li/1', 'must stop at the first rejected mutation');
});

// ── source guard ─────────────────────────────────────────────────────────────
// The replay above cannot catch a regression in server.mjs itself (fire-and-forget `await
// shopifyFetch(...)` with the response discarded), which is exactly how the bug shipped. Assert the
// batch handler's two orderEditSetQuantity calls keep their responses and assert on them.
await test('server.mjs batch /edit: no orderEditSetQuantity call discards its response', async () => {
  const src = await (await import('node:fs/promises')).readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  const fireAndForget = src.split('\n')
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(({ l }) => /^\s*await shopifyFetch\(`mutation setQty/.test(l));
  assertEqual(fireAndForget.length, 0,
    `orderEditSetQuantity response discarded at line(s) ${fireAndForget.map(x => x.n).join(', ')} — capture it and call assertNoUserErrors`);
  assert(/assertNoUserErrors\(qRes, 'orderEditSetQuantity'/.test(src), 'qty loop must assert userErrors');
  assert(/assertNoUserErrors\(rmRes, 'orderEditSetQuantity'/.test(src), 'remove loop must assert userErrors');
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
