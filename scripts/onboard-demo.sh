#!/usr/bin/env bash
# Onboard the demo coffee store. Run once per server boot (or whenever you
# want to re-index). Mock mode is fine — uses the canned coffee KB.
set -euo pipefail

SERVER_URL="${SERVER_URL:-http://localhost:3001}"

echo "→ POST $SERVER_URL/api/onboard"
curl -sS -X POST "$SERVER_URL/api/onboard" \
  -H "Content-Type: application/json" \
  -d '{
    "merchant_id":"demo",
    "name":"Acme Coffee Co",
    "url":"http://localhost:5500",
    "private_context":{
      "coupon_code":"LASSO10",
      "coupon_percent":10,
      "free_shipping_over_cents":3500,
      "notes":"Friendly small-shop voice. Offer 10% LASSO10 only if they hesitate on price."
    }
  }'
echo

# Wait a beat for the async pipeline
sleep 1

echo "→ GET $SERVER_URL/api/onboard/demo/status"
curl -sS "$SERVER_URL/api/onboard/demo/status"
echo
