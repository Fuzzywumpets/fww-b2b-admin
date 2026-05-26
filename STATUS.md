# fww-b2b-admin — overnight status

STATE: IN_PROGRESS
PHASE: 1 — auth + dashboard MVP (starting)
LAST_UPDATED: 2026-05-26T18:55:00Z

## Where things stand
- Phase 0 scaffold LIVE: server.mjs (Express on 8794), placeholder /, /healthz, systemd unit `fww-b2b-admin.service` enabled+running.
- DNS: `b2badmin.fuzzywumpets.com` A record → 5.161.212.16, set in GoDaddy (TTL 600s).
- Caddy: reverse-proxies to 127.0.0.1:8794 with auto Let's Encrypt (cert will fetch on first request once DNS resolves).
- Doppler ready: `B2B_ADMIN_GOOGLE_CLIENT_ID`, `B2B_ADMIN_GOOGLE_CLIENT_SECRET`, `B2B_ADMIN_ALLOWED_EMAILS` (alex@fuzzywumpets.com).
- Google OAuth client `fww-b2b-admin` created in GCP project `fww-bill-scanner`. Consent screen is in Testing mode with alex@fuzzywumpets.com as test user (inherited from bill scanner setup).

## Phase 1 — your current focus
Per HANDOFF.md §"Phase 1 — auth + dashboard MVP":
1. db.mjs (SQLite schema + migrations)
2. Google OAuth /auth/login → /auth/google/callback (email allowlist gate)
3. Branded login page (replace placeholder)
4. Dashboard / with widgets (open orders, week count, top customers, low-stock)
5. Header nav

## Test status
- (no tests yet — write them as you build per HANDOFF testing protocol)

## Blockers / decisions alexa needs to make
- None yet. Start building.
