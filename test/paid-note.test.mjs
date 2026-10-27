// Standalone unit test (no server): the "how did this order come to be paid" note.
//
// WHY (Alex, 2026-10-27): Mark Paid used to leave only an audit-log row. He wants every order that is marked paid
// by hand to say so ("marked paid manually"), and an order paid through Helcim to carry the Helcim transaction
// identifier instead. This covers the two pure pieces: the line builder (lib/paid-note.mjs) and the db append
// (appendOrderInternalNote - append, never replace, and never lose the newest line to the 4000-char cap).
// The HTTP/real-browser side lives in test/orders-bulk-markpaid.test.mjs and test/api.test.mjs.
//
// Runs against the in-memory MOCK database, like test/order-cache-integrity.test.mjs.

process.env.B2B_ADMIN_MOCK = '1';

const { buildPaidNoteLine } = await import('../lib/paid-note.mjs');
const { appendOrderInternalNote, getOrderInternalNote, setOrderInternalNote } = await import('../db.mjs');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const AT = new Date('2026-10-27T17:13:58Z');

console.log('\n  buildPaidNoteLine');

await test('manual: says "marked paid manually", who, and when (UTC, to the minute)', () => {
  const line = buildPaidNoteLine({ source: 'manual', actor: 'alex@fuzzywumpets.com', at: AT });
  assert(line.startsWith('[2026-10-27 17:13 UTC] '), line);
  assert(line.includes('Marked paid manually by alex@fuzzywumpets.com'), line);
  assert(!line.includes('\n'), 'one line only');
});

await test('manual: no Helcim invoice -> no Helcim wording at all', () => {
  const line = buildPaidNoteLine({ source: 'manual', actor: 'a@b.co', at: AT });
  assert(!/helcim/i.test(line), line);
});

await test('manual + a Helcim invoice on file: names the invoice and says it was NOT checked with Helcim', () => {
  const line = buildPaidNoteLine({ source: 'manual', actor: 'a@b.co', at: AT, helcim: { invoiceNumber: 'INV001003' } });
  assert(line.includes('INV001003'), line);
  assert(/not check/i.test(line), 'must not imply Helcim confirmed the payment: ' + line);
  assert(!/paid (by card )?via helcim/i.test(line), 'a manual click is not a Helcim-confirmed payment: ' + line);
});

await test('helcim: carries the transaction id, invoice number and amount', () => {
  const line = buildPaidNoteLine({
    source: 'helcim', at: AT,
    helcim: { transactionId: '39482011', invoiceNumber: 'INV001003', amount: 12.5, currency: 'USD' },
  });
  assert(line.includes('Helcim'), line);
  assert(line.includes('39482011'), 'transaction id missing: ' + line);
  assert(line.includes('INV001003'), line);
  assert(line.includes('12.50') && line.includes('USD'), line);
  assert(!/manually/i.test(line), 'a Helcim payment is not "manual": ' + line);
});

await test('helcim without a transaction id says so instead of inventing one', () => {
  const line = buildPaidNoteLine({ source: 'helcim', at: AT, helcim: { invoiceNumber: 'INV7' } });
  assert(/transaction id (is )?not available/i.test(line), line);
  assert(line.includes('INV7'), line);
});

await test('NEVER leaks the Helcim token or pay URL even if the caller hands the whole ledger row over', () => {
  const row = { invoiceNumber: 'INV9', transactionId: 'T1', token: 'SECRET-TOKEN-xyz', url: 'https://secure.myhelcim.com/pay/SECRET', invoice_id: 55 };
  for (const source of ['manual', 'helcim']) {
    const line = buildPaidNoteLine({ source, actor: 'a@b.co', at: AT, helcim: row });
    assert(!line.includes('SECRET'), `${source}: token/url leaked: ${line}`);
    assert(!line.includes('http'), `${source}: url leaked: ${line}`);
  }
});

await test('free-text fields cannot break the line or run on (newlines/control chars collapsed, length capped)', () => {
  const line = buildPaidNoteLine({
    source: 'helcim', at: AT,
    helcim: { transactionId: '1\n2\r\n3\u0000', invoiceNumber: 'X'.repeat(500) },
  });
  assert(!/[\n\r\u0000]/.test(line), JSON.stringify(line));
  assert(line.length < 500, 'line length ' + line.length);
});

await test('an unknown source throws (callers are fail-open, so a typo is loud in tests, harmless in prod)', () => {
  let threw = false;
  try { buildPaidNoteLine({ source: 'wire', actor: 'a@b.co', at: AT }); } catch { threw = true; }
  assert(threw, 'unknown source must throw');
});

console.log('\n  appendOrderInternalNote');

await test('first line creates the note and records who wrote it', () => {
  appendOrderInternalNote('7001', 'LINE ONE', 'alex@fuzzywumpets.com');
  const row = getOrderInternalNote('7001');
  assertEqual(row.body, 'LINE ONE');
  assertEqual(row.updated_by, 'alex@fuzzywumpets.com');
});

await test('APPENDS under an existing staff note - never replaces it', () => {
  setOrderInternalNote('7002', 'Customer asked for net-30', 'sam@fuzzywumpets.com');
  appendOrderInternalNote('7002', 'LINE TWO', 'alex@fuzzywumpets.com');
  assertEqual(getOrderInternalNote('7002').body, 'Customer asked for net-30\nLINE TWO');
});

await test('a second append stacks, one line each', () => {
  appendOrderInternalNote('7001', 'LINE TWO', 'a@b.co');
  assertEqual(getOrderInternalNote('7001').body, 'LINE ONE\nLINE TWO');
});

await test('blank line is a no-op (no empty note row, no stray newline)', () => {
  assertEqual(appendOrderInternalNote('7003', '   ', 'a@b.co'), 0);
  assertEqual(getOrderInternalNote('7003'), null);
});

await test('past the 4000-char cap the NEWEST line is kept and the oldest whole lines are dropped', () => {
  const old = Array.from({ length: 60 }, (_, i) => `old-${String(i).padStart(2, '0')} ${'x'.repeat(70)}`).join('\n'); // ~4380 chars
  setOrderInternalNote('7004', old.slice(0, 4000), 'a@b.co');
  appendOrderInternalNote('7004', 'NEWEST LINE', 'a@b.co');
  const body = getOrderInternalNote('7004').body;
  assert(body.length <= 4000, 'over the cap: ' + body.length);
  assert(body.endsWith('NEWEST LINE'), 'newest line must survive: ...' + body.slice(-40));
  assert(!body.startsWith('x'), 'must not start mid-line: ' + body.slice(0, 20));
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
