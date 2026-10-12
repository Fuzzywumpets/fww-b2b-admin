'use strict';

// WHAT: shell half of the "sign in through the SYSTEM browser" handoff — the pure helpers main.js uses so
//   the logic can be unit-tested without launching Electron. The server half (and the full flow
//   description) is lib/desktop-handoff.mjs.
//
// WHY: Electron's own window has a private cookie jar, so Google never recognised the user there and the
//   password was re-asked on every login. The system browser is already signed in to Google.
//
// CHANGE-GUARD: parseAuthCallbackUrl() is the ONLY gate on a URL that arrives from the OS and so from
//   anything on this machine that can open a fww-b2b-admin:// link (any web page, any program). It must
//   stay strict: exact scheme, exact host `auth`, exact path, a single well-formed `code`, nothing else.
//   And a code is useless on its own — the exchange also needs the verifier, which only this process holds.
//
// SYNC: PROTOCOL — must equal DESKTOP_PROTOCOL in lib/desktop-handoff.mjs (server). The `desktop_challenge`
//   query name and the sha256/base64url challenge format must match /auth/login + isValidChallenge there.

const crypto = require('crypto');

const PROTOCOL = 'fww-b2b-admin';
const LOGIN_PATH = '/auth/login';
const CODE_RE = /^[a-f0-9]{64}$/;

// How long after clicking "Sign in" the app will still accept the code coming back from the browser.
// Covers picking an account / typing a password / a 2FA prompt; an abandoned attempt then can't be
// completed by a stale link later.
const LOGIN_ATTEMPT_TTL_MS = 10 * 60 * 1000;

// WHAT: a fresh login attempt: a random verifier (kept in memory only) and its sha256 challenge (sent to
//   the server via the browser URL).
function newLoginAttempt(now = Date.now) {
  const verifier = crypto.randomBytes(32).toString('base64url'); // 43 chars
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, expiresAt: now() + LOGIN_ATTEMPT_TTL_MS };
}

// WHAT: the URL to open in the system browser. `adminUrl` is the shell's ADMIN_URL (trailing slash ok).
function systemBrowserLoginUrl(adminUrl, challenge) {
  const u = new URL(LOGIN_PATH, adminUrl);
  u.searchParams.set('desktop_challenge', challenge);
  return u.toString();
}

// WHAT: true when `url` is the admin site's own "Sign in with Google" link, i.e. the navigation the shell
//   should divert to the system browser instead of loading in its window.
// INVARIANT(S): exact https origin match against `adminOrigins` (a Set) — never startsWith — and the
//   path must be exactly /auth/login. A URL that already carries desktop_challenge is NOT diverted again.
function isAdminLoginUrl(url, adminOrigins) {
  let u;
  try { u = new URL(url); } catch (_) { return false; }
  if (u.protocol !== 'https:' || !adminOrigins.has(u.origin)) return false;
  return u.pathname === LOGIN_PATH && !u.searchParams.has('desktop_challenge');
}

// WHAT: pulls the one-time code out of a fww-b2b-admin://auth?code=… URL, or null for anything else.
function parseAuthCallbackUrl(url) {
  let u;
  try { u = new URL(url); } catch (_) { return null; }
  if (u.protocol !== PROTOCOL + ':') return null;
  if (u.hostname !== 'auth') return null;
  if (u.pathname !== '' && u.pathname !== '/') return null;
  const codes = u.searchParams.getAll('code');
  if (codes.length !== 1 || !CODE_RE.test(codes[0])) return null;
  return codes[0];
}

// WHAT: finds our protocol URL in a process argv (Windows delivers the link to a second instance as an argument).
function findProtocolUrl(argv) {
  return (argv || []).find((a) => typeof a === 'string' && a.toLowerCase().startsWith(PROTOCOL + '://')) || null;
}

module.exports = {
  PROTOCOL, LOGIN_PATH, LOGIN_ATTEMPT_TTL_MS,
  newLoginAttempt, systemBrowserLoginUrl, isAdminLoginUrl, parseAuthCallbackUrl, findProtocolUrl,
};
