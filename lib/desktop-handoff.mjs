// WHAT: server half of the "sign in through the SYSTEM browser" handoff for the Electron desktop shell.
//
// WHY THIS EXISTS: the shell used to run the whole Google OAuth round trip inside its own Electron
//   window. That window has a private cookie jar, so it never sees the user's Google session, saved
//   password, passkey or password-manager extension — every login re-asked for the password. Every
//   other desktop app (Slack, VS Code, Notion…) instead opens the default browser, where the user is
//   already signed in to Google, and hands the result back to the app. This is that handoff.
//
// FLOW:
//   1. shell generates a random `verifier`, opens the system browser at
//        /auth/login?desktop_challenge=<base64url sha256(verifier)>
//   2. normal Google OAuth runs in the browser; the callback verifies state + allowlist as always,
//      but instead of setting the session cookie (it would land in the BROWSER's jar, useless to the
//      app) it calls issue() and redirects to  fww-b2b-admin://auth?code=<code>
//   3. the OS routes that URL to the shell, which POSTs {code, verifier} to /auth/desktop/exchange
//      from inside its own session; redeem() checks the verifier against the stored challenge and the
//      route then sets the session cookie in the SHELL's jar.
//
// WHY A VERIFIER (PKCE-style): custom URL schemes are not exclusive — another program on the machine
//   can register the same scheme and read the code off the redirect. Without the verifier that code
//   would be a ready-made login. The verifier never leaves the shell until the exchange POST.
//
// CHANGE-GUARD: do not weaken any of: single use (a code is deleted on the FIRST redeem attempt, right
//   or wrong — so guessing the verifier costs the attacker the code), the short TTL, the challenge
//   comparison, or the fact that the user record is stored server-side (nothing identity-bearing is
//   ever placed in the redirect URL — it carries only the opaque random code).
// INVARIANT(S): in-memory by design. A restart drops pending handoffs, which just means the user
//   clicks "Sign in" again; it also means this only works while ONE node process serves the callback
//   AND the exchange. If the service is ever scaled to multiple processes, move this to the DB.
//
// SYNC: DESKTOP_PROTOCOL — must equal PROTOCOL in desktop/lib/desktop-auth.js (the shell registers
//   this scheme with the OS; a mismatch means the browser redirect opens nothing).

import crypto from 'node:crypto';

export const DESKTOP_PROTOCOL = 'fww-b2b-admin';

// A sha256 digest base64url-encoded without padding is always exactly 43 chars.
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
// The verifier is 32+ random bytes base64url'd by the shell; bound it so redeem() never hashes junk.
const VERIFIER_RE = /^[A-Za-z0-9_-]{43,128}$/;
const CODE_RE = /^[a-f0-9]{64}$/;

export const HANDOFF_TTL_MS = 60 * 1000;
const MAX_PENDING = 200;

export function isValidChallenge(s) {
  return typeof s === 'string' && CHALLENGE_RE.test(s);
}

// WHAT: the challenge the shell must have sent for a given verifier.
export function challengeFor(verifier) {
  return crypto.createHash('sha256').update(String(verifier)).digest('base64url');
}

// WHAT: the redirect target that hands `code` to the desktop shell.
export function desktopRedirectUrl(code) {
  return `${DESKTOP_PROTOCOL}://auth?code=${encodeURIComponent(code)}`;
}

// WHAT: an isolated pending-handoff store. A factory (not a module singleton) so tests get a fresh
//   store and an injected clock.
export function createHandoffStore({ ttlMs = HANDOFF_TTL_MS, now = Date.now } = {}) {
  const pending = new Map();

  function prune() {
    const t = now();
    for (const [code, h] of pending) if (h.expiresAt <= t) pending.delete(code);
  }

  return {
    // WHAT: stash a verified user + the shell's challenge, return the opaque one-time code.
    // INVARIANT(S): throws on a malformed challenge rather than storing something redeem() can never
    //   match; callers validate first (isValidChallenge) so a throw here is a programming error.
    issue({ email, name, picture, challenge }) {
      if (!isValidChallenge(challenge)) throw new Error('invalid desktop challenge');
      if (!email) throw new Error('handoff requires an email');
      prune();
      // Hard cap: this is an unauthenticated-reachable path only AFTER a successful Google login +
      // allowlist check, so abuse needs a real admin — the cap is just a memory backstop.
      if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
      const code = crypto.randomBytes(32).toString('hex');
      pending.set(code, { email, name: name || email, picture: picture || '', challenge, expiresAt: now() + ttlMs });
      return code;
    },

    // WHAT: exchange a code + verifier for the stored user, or null.
    // INVARIANT(S): the code is consumed on the first attempt whatever the outcome.
    redeem(code, verifier) {
      if (typeof code !== 'string' || !CODE_RE.test(code)) return null;
      const h = pending.get(code);
      if (!h) return null;
      pending.delete(code);
      if (h.expiresAt <= now()) return null;
      if (typeof verifier !== 'string' || !VERIFIER_RE.test(verifier)) return null;
      const want = Buffer.from(h.challenge);
      const got = Buffer.from(challengeFor(verifier));
      if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
      return { email: h.email, name: h.name, picture: h.picture };
    },

    get size() { prune(); return pending.size; },
  };
}
