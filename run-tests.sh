#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo ""
echo "======================================================"
echo "         fww-b2b-admin test suite"
echo "======================================================"

API_PORT=8894
UI_PORT=8898
ALL_MOCK_PIDS=""

# `kill` on a background job's $! can be a silent no-op under Git-Bash/MSYS on Windows (the bash PID
# and the real Windows PID diverge), so a plain `kill "$MOCK_PID" || true` can appear to succeed while
# the node process keeps running and keeps LISTENING on its port. taskkill is the real kill there.
kill_pid() {
  if command -v taskkill >/dev/null 2>&1; then
    taskkill //F //PID "$1" >/dev/null 2>&1 || true
  else
    kill "$1" 2>/dev/null || true
  fi
  wait "$1" 2>/dev/null || true
}
cleanup() { for pid in $ALL_MOCK_PIDS; do kill_pid "$pid"; done; }
trap cleanup EXIT

# MOCK_ORDERS lives in module-scope memory for the life of one `node server.mjs` process, so any
# suite that mutates order state (custom lines, discounts, payments) leaves that state for whatever
# suite runs against the SAME process next. api.test.mjs and ui.test.mjs both write to shared
# fixture orders (1001/1007/1008/etc), so they need separate processes — otherwise ui.test.mjs sees
# api.test.mjs's leftover custom lines/discounts and fails on counts that drift with however much the
# prior suite happened to commit that run. They ALSO need separate PORTS, not just separate PIDs: if
# kill_pid's kill silently no-ops (see above) and a stale process is still listening on the old port,
# reusing that port would mean the "fresh" server for the next suite never actually binds — the still
# stale process just keeps answering, and pollution carries on undetected. A distinct port per suite
# means a fresh process only ever measures against a fresh process, regardless of whether the previous
# one actually died.
start_mock_server() {
  local port="$1"
  echo ""
  echo "Starting mock server (B2B_ADMIN_MOCK=1, port $port)..."
  PORT=$port B2B_ADMIN_MOCK=1 B2B_IMPERSONATION_SECRET=test-impersonation-secret-mock SHOPIFY_WEBHOOK_SECRET=test-shopify-webhook-secret node server.mjs &
  MOCK_PID=$!
  ALL_MOCK_PIDS="$ALL_MOCK_PIDS $MOCK_PID"
  for i in $(seq 1 20); do
    if curl -sf "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
      echo "Mock server ready (pid $MOCK_PID)"
      return 0
    fi
    sleep 0.5
  done
  echo "ERROR: mock server did not start" >&2
  exit 1
}

API_FAIL=0
UI_FAIL=0
UNIT_FAIL=0
AUTH_FAIL=0

if [ -f test/api.test.mjs ]; then
  start_mock_server "$API_PORT"
  echo ""
  TEST_BASE="http://127.0.0.1:$API_PORT" node test/api.test.mjs || API_FAIL=$?
  kill_pid "$MOCK_PID"
fi

if [ -f test/ui.test.mjs ]; then
  start_mock_server "$UI_PORT"
  echo ""
  TEST_BASE="http://127.0.0.1:$UI_PORT" node test/ui.test.mjs || UI_FAIL=$?
  kill_pid "$MOCK_PID"
fi

# Standalone unit suites — run WITHOUT the mock HTTP server on purpose, because the code they cover
# is short-circuited under MOCK (getPortalDb returns null) and the API suite would otherwise report
# a false green over an untested ingest.
if [ -f test/leads-ingest.test.mjs ]; then
  echo ""
  B2B_ADMIN_MOCK=1 node test/leads-ingest.test.mjs || UNIT_FAIL=$?
fi

# Order/line-item cache integrity (H14 line-item duplication, H15 status casing). Standalone for the
# same reason as above: getOrdersData() short-circuits to the MOCK fixture array and never reads
# orders_cache, so these writes are invisible to the API suite.
if [ -f test/order-cache-integrity.test.mjs ]; then
  echo ""
  B2B_ADMIN_MOCK=1 node test/order-cache-integrity.test.mjs || UNIT_FAIL=$?
fi

# Boots its OWN non-MOCK servers (against throwaway sqlite dirs via B2B_ADMIN_DATA_DIR) because the
# /__test__/session allowlist+audit guard only exists on the non-MOCK branch. Deliberately NOT given
# B2B_ADMIN_MOCK.
if [ -f test/test-session-guard.test.mjs ]; then
  echo ""
  node test/test-session-guard.test.mjs || AUTH_FAIL=$?
fi

# Money-correctness helpers (lib/order-money.mjs). Standalone because the branches under test are
# Shopify userError branches — MOCK never calls shopifyFetch, so only an injected fake reaches them.
if [ -f test/order-money.test.mjs ]; then
  echo ""
  node test/order-money.test.mjs || UNIT_FAIL=$?
fi

# Order-edit userErrors: the batch /edit handler returns from its MOCK branch before any Shopify
# mutation, so this path can ONLY be covered standalone.
if [ -f test/order-edit-user-errors.test.mjs ]; then
  echo ""
  node test/order-edit-user-errors.test.mjs || UNIT_FAIL=$?
fi

# List truncation lives here for the same reason: the cache path is gated on `if (!MOCK)`, so the
# HTTP suite can never reach the capped query that truncates /orders and /customers.
if [ -f test/list-truncation.test.mjs ]; then
  echo ""
  B2B_ADMIN_MOCK=1 node test/list-truncation.test.mjs || UNIT_FAIL=$?
fi

# The leads list cap + phone search are DB-level (a REPLACE() chain in SQL, and one shared WHERE
# builder feeding both getLeads and countLeads). Same reasoning as the block above — the HTTP suite
# cannot reach either, so they get their own in-memory unit run.
if [ -f test/leads-list.test.mjs ]; then
  echo ""
  B2B_ADMIN_MOCK=1 node test/leads-list.test.mjs || UNIT_FAIL=$?
fi

# Edited orders must be shown and summed at their CURRENT total. total_price/subtotal_price FREEZE at
# the pre-edit amount, so reading them overstates every edited order. DB-layer + template strings —
# the mock HTTP server reaches neither (the cache paths are gated on `if (!MOCK)`).
if [ -f test/order-display-totals.test.mjs ]; then
  echo ""
  node test/order-display-totals.test.mjs || UNIT_FAIL=$?
fi

# The #38953 lock-up: a permanently-failing line edit armed a beforeunload guard, and the Electron
# shell cancels a prevented unload SILENTLY — every link, the back button, "Generate PDF" and Quit
# died at once. Standalone: it spans desktop shell code (never loaded by the server) and source-level
# guards on call sites, neither of which the HTTP suites can reach.
if [ -f test/order-edit-nav-deadlock.test.mjs ]; then
  echo ""
  node test/order-edit-nav-deadlock.test.mjs || UNIT_FAIL=$?
fi

# Electron shell code — never runs inside the Express server, so the HTTP suites cannot reach it.
# Guards the PDF-in-the-main-window trap (no back button; its X quits the whole app).
if [ -f test/desktop-pdf-headers.test.mjs ]; then
  echo ""
  node test/desktop-pdf-headers.test.mjs || UNIT_FAIL=$?
fi

# Packaging allowlist. v1.0.3 shipped unlaunchable because main.js required a module that
# build.files never packaged — the build, the tests and the publish all succeeded. This is the
# source-level half of that guard; tools/verify-package.js checks the built artifact in CI.
if [ -f test/desktop-packaging.test.mjs ]; then
  echo ""
  node test/desktop-packaging.test.mjs || UNIT_FAIL=$?
fi

# The allowlist gate is pure logic over env, and it guards the WHOLE dashboard. It gets its own run
# because the HTTP suite short-circuits Google OAuth entirely in MOCK and never exercises it.
if [ -f test/admin-allowlist.test.mjs ]; then
  echo ""
  node test/admin-allowlist.test.mjs || UNIT_FAIL=$?
fi

echo ""
echo "======================================================"
if [ $API_FAIL -eq 0 ] && [ $UI_FAIL -eq 0 ] && [ $UNIT_FAIL -eq 0 ] && [ $AUTH_FAIL -eq 0 ]; then
  echo "  ALL TESTS PASSED"
  echo "======================================================"
  exit 0
else
  [ $API_FAIL  -ne 0 ] && echo "  API tests:  FAILED"
  [ $UI_FAIL   -ne 0 ] && echo "  UI tests:   FAILED"
  [ $UNIT_FAIL -ne 0 ] && echo "  Unit tests: FAILED"
  [ $AUTH_FAIL -ne 0 ] && echo "  Auth-guard tests: FAILED"
  echo "======================================================"
  exit 1
fi
