// WHAT: unit tests for isAllowedAdminEmail — the gate on the entire b2badmin dashboard.
// WHY a dedicated suite: the allowlist grew from "exact addresses only" to "exact addresses OR a
//   whole domain" (owner decision 2026-08-11). A domain rule is the kind of check that looks right
//   and is trivially bypassable if written as endsWith/includes against the raw address, so the
//   lookalike cases below matter more than the happy path.
// CHANGE-GUARD: server.mjs calls app.listen at import time and cannot be imported by a test, so the
//   function is duplicated here VERBATIM. If you change it in server.mjs, change it here — a silent
//   divergence means these tests pass while production does something else.
// SYNC: server.mjs isAllowedAdminEmail()

import assert from 'node:assert/strict';

let ALLOWLIST = [];
function currentAllowedEmails() { return ALLOWLIST; }

// --- verbatim copy of server.mjs isAllowedAdminEmail ---
function isAllowedAdminEmail(email) {
  const lower = String(email || '').trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at < 1 || at === lower.length - 1) return false;
  const domain = lower.slice(at + 1);
  return currentAllowedEmails().some((entry) => {
    const e = entry.toLowerCase();
    if (e.startsWith('@')) {
      const allowedDomain = e.slice(1);
      return allowedDomain.length > 0 && domain === allowedDomain;
    }
    return e === lower;
  });
}
// --- end copy ---

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}

console.log('\n── Unit: b2badmin allowlist (exact + domain) ──\n');

// The live production value as of 2026-08-11.
ALLOWLIST = ['@fuzzywumpets.com', 'erin.m.karson@gmail.com'];

test('anyone on the allowed domain gets in', () => {
  for (const e of ['alex@fuzzywumpets.com', 'mason@fuzzywumpets.com', 'chrissy@fuzzywumpets.com',
                   'beth@fuzzywumpets.com', 'claude-qa@fuzzywumpets.com', 'brand.new.hire@fuzzywumpets.com']) {
    assert.equal(isAllowedAdminEmail(e), true, `${e} should be allowed`);
  }
});

test('an exact-address entry still works alongside a domain entry', () => {
  assert.equal(isAllowedAdminEmail('erin.m.karson@gmail.com'), true);
});

test('case is irrelevant on both sides', () => {
  assert.equal(isAllowedAdminEmail('Alex@FuzzyWumpets.COM'), true);
  assert.equal(isAllowedAdminEmail('ERIN.M.KARSON@GMAIL.COM'), true);
});

test('a different gmail is NOT admitted by Erin\'s entry', () => {
  assert.equal(isAllowedAdminEmail('someone.else@gmail.com'), false);
});

// The bypasses. Each of these defeats a naive endsWith/includes implementation.
test('BYPASS: suffixed lookalike domain is refused', () => {
  assert.equal(isAllowedAdminEmail('attacker@fuzzywumpets.com.evil.tld'), false,
    'a domain that merely STARTS with the allowed one must not match');
});

test('BYPASS: prefixed lookalike domain is refused', () => {
  assert.equal(isAllowedAdminEmail('attacker@notfuzzywumpets.com'), false,
    'a domain that merely ENDS with the allowed one must not match');
  assert.equal(isAllowedAdminEmail('attacker@evil-fuzzywumpets.com'), false);
});

test('BYPASS: the domain in the LOCAL part does not count', () => {
  assert.equal(isAllowedAdminEmail('fuzzywumpets.com@evil.tld'), false);
  assert.equal(isAllowedAdminEmail('x@fuzzywumpets.com@evil.tld'), false,
    'the domain is whatever follows the LAST @, not the first');
});

test('BYPASS: subdomain is not the domain', () => {
  assert.equal(isAllowedAdminEmail('attacker@mail.fuzzywumpets.com'), false,
    'a subdomain must be listed explicitly if it is meant to be allowed');
});

test('malformed input never matches', () => {
  for (const e of ['', null, undefined, 'no-at-sign', '@fuzzywumpets.com', 'trailing@', '   ']) {
    assert.equal(isAllowedAdminEmail(e), false, `${JSON.stringify(e)} must not be admitted`);
  }
});

test('a junk "@" entry in the allowlist does not admit everyone', () => {
  ALLOWLIST = ['@'];
  assert.equal(isAllowedAdminEmail('anyone@anywhere.tld'), false,
    'a bare @ entry must be ignored, not treated as a wildcard');
  ALLOWLIST = ['@fuzzywumpets.com', 'erin.m.karson@gmail.com'];
});

test('an empty allowlist admits nobody (fails closed)', () => {
  ALLOWLIST = [];
  assert.equal(isAllowedAdminEmail('alex@fuzzywumpets.com'), false);
  ALLOWLIST = ['@fuzzywumpets.com', 'erin.m.karson@gmail.com'];
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
