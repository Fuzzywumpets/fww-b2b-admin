#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo ""
echo "======================================================"
echo "         fww-b2b-admin test suite"
echo "======================================================"

PORT=8894
echo ""
echo "Starting mock server (B2B_ADMIN_MOCK=1, port $PORT)..."
PORT=$PORT B2B_ADMIN_MOCK=1 B2B_IMPERSONATION_SECRET=test-impersonation-secret-mock SHOPIFY_WEBHOOK_SECRET=test-shopify-webhook-secret node server.mjs &
MOCK_PID=$!

cleanup() { kill "$MOCK_PID" 2>/dev/null || true; }
trap cleanup EXIT

for i in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    echo "Mock server ready (pid $MOCK_PID)"
    break
  fi
  sleep 0.5
done
if ! curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  echo "ERROR: mock server did not start" >&2
  exit 1
fi

API_FAIL=0
UI_FAIL=0
UNIT_FAIL=0
AUTH_FAIL=0

if [ -f test/api.test.mjs ]; then
  echo ""
  TEST_BASE="http://127.0.0.1:$PORT" node test/api.test.mjs || API_FAIL=$?
fi

if [ -f test/ui.test.mjs ]; then
  echo ""
  TEST_BASE="http://127.0.0.1:$PORT" node test/ui.test.mjs || UI_FAIL=$?
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
