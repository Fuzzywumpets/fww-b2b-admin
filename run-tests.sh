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

if [ -f test/api.test.mjs ]; then
  echo ""
  TEST_BASE="http://127.0.0.1:$PORT" node test/api.test.mjs || API_FAIL=$?
fi

if [ -f test/ui.test.mjs ]; then
  echo ""
  TEST_BASE="http://127.0.0.1:$PORT" node test/ui.test.mjs || UI_FAIL=$?
fi

echo ""
echo "======================================================"
if [ $API_FAIL -eq 0 ] && [ $UI_FAIL -eq 0 ]; then
  echo "  ALL TESTS PASSED"
  echo "======================================================"
  exit 0
else
  [ $API_FAIL -ne 0 ] && echo "  API tests: FAILED"
  [ $UI_FAIL  -ne 0 ] && echo "  UI tests:  FAILED"
  echo "======================================================"
  exit 1
fi
