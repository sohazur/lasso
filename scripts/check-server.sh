#!/usr/bin/env bash
# Quick liveness check.
set -euo pipefail

SERVER_URL="${SERVER_URL:-http://localhost:3001}"

echo "→ $SERVER_URL/health"
curl -sS "$SERVER_URL/health" || echo "(server not reachable)"
echo
