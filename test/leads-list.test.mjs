// WHAT: unit tests for the leads list cap + phone search (B2B-16 / B2B-17).
// CHANGE-GUARD: runs against the in-memory MOCK database (B2B_ADMIN_MOCK=1), the same bootstrap
//   test/leads-ingest.test.mjs uses — db.mjs picks ':memory:' vs data/admin.db at IMPORT time, so
//   the env var MUST be set before the dynamic import below or the test would write to the real DB.
// WHY a DB test and not a fake: the two things that can actually break here are the REPLACE()-chain
//   that strips phone punctuation, and buildLeadsWhere drifting between getLeads and countLeads.
//   Both are SQL-level; a pure-JS fake would report a false green on either.
// INVARIANT(S): every lead gets a unique email (leads.email is UNIQUE) and assertions are on
//   counts/ids, never on row order beyond the documented `updated_at DESC`.

import assert from 'node:assert/strict';

process.env.B2B_ADMIN_MOCK = '1';

const { createLead, getLeads, countLeads } = await import('../db.mjs');
const { LEADS_LIST_LIMIT } = await import('../lib/list-truncation.mjs');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}

console.log('\n── Unit: leads list cap + phone search (B2B-16/B2B-17) ──\n');

// ── the cap ───────────────────────────────────────────────────────────────────

test('getLeads defaults to the SHARED LEADS_LIST_LIMIT, not a local literal', () => {
  for (let i = 0; i < LEADS_LIST_LIMIT + 15; i++) {
    createLead({ email: `cap${i}@example.test`, business_name: `Cap ${i}` });
  }
  assert.equal(getLeads({}).length, LEADS_LIST_LIMIT, 'page size must equal the shared constant');
});

test('countLeads reports the TRUE total, so the page can tell 100 from "first 100 of 115"', () => {
  const rows = getLeads({});
  const total = countLeads({});
  assert.equal(rows.length, LEADS_LIST_LIMIT);
  assert.equal(total, LEADS_LIST_LIMIT + 15);
  // This is the whole point of the change: before it, the page rendered these two identically.
  assert.ok(total > rows.length, 'truncation must be detectable');
});

test('countLeads and getLeads answer the SAME question under a filter (shared-WHERE drift guard)', () => {
  createLead({ email: 'drift-a@example.test', business_name: 'Drift Co', status: 'new' });
  const filtered = getLeads({ search: 'Drift Co', limit: 500 });
  const counted  = countLeads({ search: 'Drift Co' });
  assert.equal(counted, filtered.length,
    'count and rows diverged — buildLeadsWhere is no longer shared, and the banner will lie');
});

test('a non-truncated filtered view reports total === rows (no false banner)', () => {
  const rows  = getLeads({ search: 'Drift Co', limit: 500 });
  const total = countLeads({ search: 'Drift Co' });
  assert.equal(total, rows.length, 'a complete list must not be reported as truncated');
});

// ── phone search ──────────────────────────────────────────────────────────────
// Phones are stored in three different shapes in the wild — see PHONE_DIGITS_SQL in db.mjs.

test('finds a phone stored E.164 (written by normalizePhone on /leads/new + /edit)', () => {
  createLead({ email: 'e164@example.test', business_name: 'E164 Co', phone: '+18282160282' });
  const hits = getLeads({ search: '8282160282', limit: 500 });
  assert.ok(hits.some(l => l.email === 'e164@example.test'), 'E.164-stored phone must be findable');
});

test('finds a phone stored as bare digits (legacy rows, e.g. lead #3 Hydref K-9)', () => {
  createLead({ email: 'bare@example.test', business_name: 'Bare Co', phone: '8285551234' });
  const hits = getLeads({ search: '8285551234', limit: 500 });
  assert.ok(hits.some(l => l.email === 'bare@example.test'), 'legacy digit string must be findable');
});

test('finds a phone stored with punctuation (portal-ingested, never normalized)', () => {
  createLead({ email: 'punct@example.test', business_name: 'Punct Co', phone: '(828) 555-9876' });
  const hits = getLeads({ search: '8285559876', limit: 500 });
  assert.ok(hits.some(l => l.email === 'punct@example.test'), 'punctuated phone must be findable');
});

test('the SEARCH TERM may be punctuated too — all three spellings find the same lead', () => {
  for (const term of ['(828) 555-9876', '828-555-9876', '828.555.9876']) {
    const hits = getLeads({ search: term, limit: 500 });
    assert.ok(hits.some(l => l.email === 'punct@example.test'), `"${term}" must find the lead`);
  }
});

test('a digit-light term does NOT trigger the phone clause (guards LIKE %% matching everything)', () => {
  // 'Co' has zero digits. If the phone clause were added unguarded it would become LIKE '%%' and
  // match every row that has a phone at all, silently widening every text search.
  const hits = getLeads({ search: 'Co', limit: 500 });
  assert.ok(hits.every(l => /co/i.test(`${l.business_name} ${l.contact_name} ${l.email}`)),
    'a no-digit search must not start matching rows purely because they have a phone number');
});

test('phone search does not make unrelated leads collide', () => {
  const hits = getLeads({ search: '8285559876', limit: 500 });
  assert.equal(hits.length, 1, 'digit stripping must never merge two distinct numbers');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
