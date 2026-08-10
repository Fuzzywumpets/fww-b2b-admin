/**
 * Regression suite for the /__test__/session backdoor guard (server.mjs :5481).
 *
 * WHY THIS IS STANDALONE: every other suite runs against the shared B2B_ADMIN_MOCK=1 server, but the
 * behaviour under test only exists on the NON-MOCK branch — under MOCK the route is intentionally
 * wide open so the API/UI suites can seed sessions. So this file boots its own real (MOCK=false)
 * server processes.
 *
 * SAFETY: each server is given B2B_ADMIN_DATA_DIR pointing at a throwaway directory under the OS temp
 * dir, so it never opens (or writes sessions/audit rows into) the real data/admin.db. Never remove
 * that env var from these spawns.
 *
 * Failure scenario being guarded: B2B_ADMIN_ALLOW_TEST_SESSION=1 left set on a real deployment (a
 * leftover staging/debug var) turned this route into "GET a cookie and you are any admin you like",
 * silently and unaudited.
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'server.mjs');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

const spawned = [];
const tmpDirs = [];

// Boots a real MOCK=false server on `port` with `env` merged in, waits for /healthz, returns a handle.
async function startServer(port, env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2badmin-test-'));
  tmpDirs.push(dataDir);
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      B2B_ADMIN_MOCK: '',            // explicitly NOT mock — that is the whole point of this suite
      B2B_ADMIN_DATA_DIR: dataDir,   // throwaway sqlite; never the live admin.db
      B2B_ADMIN_ALLOW_TEST_SESSION: '',
      B2B_ADMIN_ALLOWED_EMAILS: '',
      PORT: String(port),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawned.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return { base, child, dataDir };
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`server on ${port} did not start`);
}

function stopAll() {
  for (const c of spawned) { try { c.kill(); } catch { /* already gone */ } }
}

console.log('\n/__test__/session guard tests (non-MOCK):');

// ── 1. Flag unset (the production posture): the route must not exist at all. ──────────────────
{
  const { base } = await startServer(8896, {});

  await test('flag unset → 404, no session cookie', async () => {
    const res = await fetch(`${base}/__test__/session?email=alex@fuzzywumpets.com`);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('set-cookie'), null);
  });
}

// ── 2. Flag SET (the leaked-env-var scenario). The flag alone must no longer be enough. ───────
{
  const ALLOWED = 'allowed@example.com';
  const { base, dataDir } = await startServer(8895, {
    B2B_ADMIN_ALLOW_TEST_SESSION: '1',
    B2B_ADMIN_ALLOWED_EMAILS: ALLOWED,
  });

  await test('flag set + NON-allowlisted email → 403, no session minted', async () => {
    const res = await fetch(`${base}/__test__/session?email=attacker@evil.example`);
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('set-cookie'), null);
  });

  await test('flag set + allowlisted email (different case) → 200 + cookie', async () => {
    const res = await fetch(`${base}/__test__/session?email=${encodeURIComponent(ALLOWED.toUpperCase())}`);
    assert.equal(res.status, 200);
    assert.ok(/b2b_admin_sid=/.test(res.headers.get('set-cookie') || ''));
  });

  await test('flag set → sid is NOT echoed in the JSON body', async () => {
    const res = await fetch(`${base}/__test__/session?email=${encodeURIComponent(ALLOWED)}`);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.email, ALLOWED);
    assert.equal(json.sid, undefined, 'session id must not appear in the response body');
  });

  await test('minted cookie is a genuinely usable admin session', async () => {
    const res = await fetch(`${base}/__test__/session?email=${encodeURIComponent(ALLOWED)}`);
    const sid = (res.headers.get('set-cookie') || '').match(/b2b_admin_sid=([^;]+)/)?.[1];
    assert.ok(sid, 'expected a session id in Set-Cookie');
    const dash = await fetch(`${base}/`, { headers: { Cookie: `b2b_admin_sid=${sid}` }, redirect: 'manual' });
    assert.notEqual(dash.status, 302, 'session should not bounce to /login');
  });

  await test('every issuance writes an audit row (a leaked flag must be visible)', async () => {
    const db = new Database(path.join(dataDir, 'admin.db'), { readonly: true });
    const rows = db.prepare("SELECT email FROM admin_audit_log WHERE action = 'login:test_session'").all();
    db.close();
    // 3 successful issuances above (case-insensitive one, sid-body one, usable-session one).
    assert.equal(rows.length, 3, `expected 3 audit rows, got ${rows.length}`);
    assert.ok(rows.every(r => r.email.toLowerCase() === ALLOWED), 'audit rows must name the minted email');
  });
}

stopAll();
for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* windows file lock */ } }

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
