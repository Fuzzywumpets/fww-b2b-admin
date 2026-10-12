// Unit tests for the Electron shell's system-browser sign-in handoff:
//   lib/desktop-handoff.mjs     (server: one-time code store, challenge check)
//   desktop/lib/desktop-auth.js (shell: verifier/challenge, URL gates)
//
// Standalone because the code under test is out of the mock HTTP server's reach (the real OAuth
// callback is behind `if (!MOCK)`, the shell is Electron). The HTTP half of the flow is covered in
// api.test.mjs against the MOCK server.
import assert from 'node:assert';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  createHandoffStore, isValidChallenge, challengeFor, desktopRedirectUrl, DESKTOP_PROTOCOL,
} from '../lib/desktop-handoff.mjs';

const require = createRequire(import.meta.url);
const desk = require('../desktop/lib/desktop-auth.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}

const USER = { email: 'a@fuzzywumpets.com', name: 'A', picture: 'http://x/p.png' };
function fresh(opts) {
  const attempt = desk.newLoginAttempt();
  const store = createHandoffStore(opts);
  const code = store.issue({ ...USER, challenge: attempt.challenge });
  return { attempt, store, code };
}

console.log('\n── Unit: desktop system-browser sign-in ──\n');

// ── the two halves must agree ────────────────────────────────────────────────
test('shell and server use the same URL scheme', () => {
  assert.equal(desk.PROTOCOL, DESKTOP_PROTOCOL);
});

test("the shell's challenge is exactly what the server derives from the verifier", () => {
  const a = desk.newLoginAttempt();
  assert.equal(a.challenge, challengeFor(a.verifier));
  assert.ok(isValidChallenge(a.challenge), 'server must accept the shell-built challenge');
});

test('each attempt gets a fresh verifier', () => {
  assert.notEqual(desk.newLoginAttempt().verifier, desk.newLoginAttempt().verifier);
});

// ── happy path ───────────────────────────────────────────────────────────────
test('code + the matching verifier redeems to the stored user', () => {
  const { attempt, store, code } = fresh();
  assert.deepEqual(store.redeem(code, attempt.verifier), USER);
});

test('the redirect URL the server builds is accepted by the shell parser and round-trips the code', () => {
  const { code } = fresh();
  assert.equal(desk.parseAuthCallbackUrl(desktopRedirectUrl(code)), code);
});

// ── the security properties ──────────────────────────────────────────────────
test('a code is single-use', () => {
  const { attempt, store, code } = fresh();
  assert.ok(store.redeem(code, attempt.verifier));
  assert.equal(store.redeem(code, attempt.verifier), null);
});

test('the WRONG verifier is rejected (a hijacked code alone is worthless)', () => {
  const { store, code } = fresh();
  assert.equal(store.redeem(code, desk.newLoginAttempt().verifier), null);
});

test('a wrong verifier BURNS the code, so guessing costs the attacker the login', () => {
  const { attempt, store, code } = fresh();
  assert.equal(store.redeem(code, desk.newLoginAttempt().verifier), null);
  assert.equal(store.redeem(code, attempt.verifier), null, 'the real verifier must not work after a failed guess');
});

test('an expired code is rejected', () => {
  let t = 1_000_000;
  const store = createHandoffStore({ ttlMs: 60_000, now: () => t });
  const attempt = desk.newLoginAttempt();
  const code = store.issue({ ...USER, challenge: attempt.challenge });
  t += 60_001;
  assert.equal(store.redeem(code, attempt.verifier), null);
});

test('a code redeemed just inside the TTL still works', () => {
  let t = 1_000_000;
  const store = createHandoffStore({ ttlMs: 60_000, now: () => t });
  const attempt = desk.newLoginAttempt();
  const code = store.issue({ ...USER, challenge: attempt.challenge });
  t += 59_999;
  assert.ok(store.redeem(code, attempt.verifier));
});

test('junk codes are rejected without throwing', () => {
  const { attempt, store, code } = fresh();
  for (const bad of [undefined, null, 0, {}, [], '', 'x', code.toUpperCase(), code + 'a', '../etc']) {
    assert.equal(store.redeem(bad, attempt.verifier), null);
  }
});

test('junk verifiers are rejected without throwing', () => {
  const attempt = desk.newLoginAttempt();
  for (const bad of [undefined, null, '', 'short', {}, 'a'.repeat(500)]) {
    const store = createHandoffStore();
    const code = store.issue({ ...USER, challenge: attempt.challenge });
    assert.equal(store.redeem(code, bad), null);
  }
});

test('issue() refuses a malformed challenge instead of storing something unredeemable', () => {
  const store = createHandoffStore();
  assert.throws(() => store.issue({ ...USER, challenge: 'nope' }));
  assert.throws(() => store.issue({ ...USER, challenge: undefined }));
});

test('issue() refuses a missing email', () => {
  const store = createHandoffStore();
  assert.throws(() => store.issue({ name: 'x', challenge: desk.newLoginAttempt().challenge }));
});

test('expired handoffs are pruned and the store stays bounded', () => {
  let t = 0;
  const store = createHandoffStore({ ttlMs: 10, now: () => t });
  const c = desk.newLoginAttempt().challenge;
  for (let i = 0; i < 500; i++) store.issue({ ...USER, challenge: c });
  assert.ok(store.size <= 200, `store must stay bounded, got ${store.size}`);
  t = 1000;
  assert.equal(store.size, 0);
});

test('codes are 256 bits of hex and never repeat', () => {
  const store = createHandoffStore();
  const c = desk.newLoginAttempt().challenge;
  const codes = new Set(Array.from({ length: 50 }, () => store.issue({ ...USER, challenge: c })));
  assert.equal(codes.size, 50);
  for (const code of codes) assert.match(code, /^[a-f0-9]{64}$/);
});

// ── challenge validation (what /auth/login accepts) ──────────────────────────
test('isValidChallenge accepts only a 43-char base64url digest', () => {
  assert.ok(isValidChallenge(crypto.createHash('sha256').update('x').digest('base64url')));
  const bad = [undefined, null, '', 'abc', 'a'.repeat(42), 'a'.repeat(44), 'a'.repeat(42) + '=', 'a'.repeat(42) + '+', ['a'.repeat(43)], { x: 1 }];
  for (const b of bad) assert.equal(isValidChallenge(b), false, JSON.stringify(b));
});

// ── shell: which URLs it will act on ─────────────────────────────────────────
const ORIGINS = new Set(['https://b2badmin.fuzzywumpets.com', 'https://b2badmin.fuzzyreporting.com']);

test("the site's own sign-in link is diverted to the system browser", () => {
  assert.ok(desk.isAdminLoginUrl('https://b2badmin.fuzzywumpets.com/auth/login', ORIGINS));
  assert.ok(desk.isAdminLoginUrl('https://b2badmin.fuzzyreporting.com/auth/login', ORIGINS));
});

test('look-alike hosts, other paths, other schemes and non-URLs are NOT diverted', () => {
  for (const u of [
    'https://b2badmin.fuzzywumpets.com.evil.com/auth/login',
    'https://evil.com/auth/login',
    'http://b2badmin.fuzzywumpets.com/auth/login',
    'https://b2badmin.fuzzywumpets.com/auth/login/extra',
    'https://b2badmin.fuzzywumpets.com/login',
    'https://b2badmin.fuzzywumpets.com/orders',
    'https://accounts.google.com/o/oauth2/v2/auth',
    'not a url', '', undefined,
  ]) assert.equal(desk.isAdminLoginUrl(u, ORIGINS), false, String(u));
});

test('a login URL that already carries a challenge is not diverted a second time', () => {
  assert.equal(desk.isAdminLoginUrl('https://b2badmin.fuzzywumpets.com/auth/login?desktop_challenge=x', ORIGINS), false);
});

test('the system-browser URL targets /auth/login on the admin origin and carries the challenge', () => {
  const a = desk.newLoginAttempt();
  const u = new URL(desk.systemBrowserLoginUrl('https://b2badmin.fuzzywumpets.com/', a.challenge));
  assert.equal(u.origin, 'https://b2badmin.fuzzywumpets.com');
  assert.equal(u.pathname, '/auth/login');
  assert.equal(u.searchParams.get('desktop_challenge'), a.challenge);
});

// The OS hands this function a URL that ANY web page or program can have crafted.
test('parseAuthCallbackUrl accepts only the exact expected shape', () => {
  const code = 'a'.repeat(64);
  assert.equal(desk.parseAuthCallbackUrl(`fww-b2b-admin://auth?code=${code}`), code);
  assert.equal(desk.parseAuthCallbackUrl(`fww-b2b-admin://auth/?code=${code}`), code);
  const bad = [
    `other-app://auth?code=${code}`,
    `https://auth/?code=${code}`,
    `fww-b2b-admin://evil?code=${code}`,
    `fww-b2b-admin://auth/extra?code=${code}`,
    `fww-b2b-admin://auth?code=${code}&code=${code}`,
    `fww-b2b-admin://auth?code=${'a'.repeat(63)}`,
    `fww-b2b-admin://auth?code=${'A'.repeat(64)}`,
    `fww-b2b-admin://auth?code=${code}x`,
    'fww-b2b-admin://auth',
    'fww-b2b-admin://auth?code=',
    'fww-b2b-admin://auth?code=<script>',
    'not a url', '', undefined, null,
  ];
  for (const u of bad) assert.equal(desk.parseAuthCallbackUrl(u), null, String(u));
});

test('findProtocolUrl picks our link out of a Windows argv and ignores everything else', () => {
  const link = `fww-b2b-admin://auth?code=${'b'.repeat(64)}`;
  assert.equal(desk.findProtocolUrl(['C:\\app.exe', '--flag', link]), link);
  assert.equal(desk.findProtocolUrl(['C:\\app.exe', '--flag']), null);
  assert.equal(desk.findProtocolUrl(undefined), null);
});

// ── packaging: the shell module must ship in the installer ─────────────────────
test('main.js requires the new shell module, which build.files covers via lib/**/*', () => {
  const main = readFileSync(new URL('../desktop/main.js', import.meta.url), 'utf8');
  assert.match(main, /require\('\.\/lib\/desktop-auth'\)/);
  const pkg = JSON.parse(readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.build.files.includes('lib/**/*'));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
