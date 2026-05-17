#!/usr/bin/env bash
# Simulate the snippet firing an abandonment event. Useful for poking the
# call pipeline without actually closing a browser tab.
set -euo pipefail

SERVER_URL="${SERVER_URL:-http://localhost:3001}"
PHONE="${PHONE:-+971585510762}"
NAME="${NAME:-Sohazur}"
EMAIL="${EMAIL:-sohazur@reachllm.com}"

NOW_MS=$(node -e 'process.stdout.write(String(Date.now()))')

echo "→ POST $SERVER_URL/checkout-event (phone=$PHONE)"
curl -sS -X POST "$SERVER_URL/checkout-event" \
  -H "Content-Type: application/json" \
  -d "{
    \"merchant_id\":\"demo\",
    \"trigger\":\"tab_hidden\",
    \"snapshot\":{
      \"phone\":\"$PHONE\",
      \"email\":\"$EMAIL\",
      \"name\":\"$NAME\",
      \"cart_lines\":[{\"title\":\"Ethiopia Yirgacheffe 12oz\",\"qty\":1,\"price_cents\":2200}],
      \"cart_total_cents\":2200,
      \"store_url\":\"http://localhost:5500\",
      \"page_entered_at\":$NOW_MS
    },
    \"page_url\":\"http://localhost:5500/checkout\",
    \"fired_at\":$NOW_MS
  }"
echo
echo "(check your server terminal for the system-prompt log)"
