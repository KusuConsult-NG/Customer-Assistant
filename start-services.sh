#!/usr/bin/env bash
# PLASCHEMA Customer Assistant — Unified Service Starter with ngrok watchdog
# Usage: bash start-services.sh
REPO="$(cd "$(dirname "$0")" && pwd)"
API_DIST="$REPO/apps/api/dist/main.js"
NGROK_BIN="/usr/local/bin/ngrok"
NGROK_DOMAIN="chemotropic-albertha-contritely.ngrok-free.dev"
API_PORT=4000

ok()   { echo "[OK]  $*"; }
warn() { echo "[WARN] $*"; }
err()  { echo "[ERR] $*"; }

pkill -f "dist/main.js" 2>/dev/null || true
pkill -f "ngrok"         2>/dev/null || true
sleep 1

if [[ ! -f "$API_DIST" ]]; then
  warn "No dist — building API..."
  cd "$REPO/apps/api" && npm run build
fi

cd "$REPO/apps/api"
node dist/main.js &
API_PID=$!
echo "API PID: $API_PID"

for i in {1..20}; do
  if curl -s "http://localhost:$API_PORT/api/health" 2>/dev/null | grep -q '"ok"'; then
    ok "API is up"; break
  fi
  sleep 1
done

echo "Starting ngrok watchdog for $NGROK_DOMAIN ..."

while true; do
  "$NGROK_BIN" http "$API_PORT" --domain="$NGROK_DOMAIN" --log=stdout &
  NGROK_PID=$!
  sleep 6

  STATUS=$(curl -s "http://127.0.0.1:4040/api/tunnels" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); t=[x for x in d.get('tunnels',[]) if 'https' in x.get('public_url','')]; print(t[0]['public_url'] if t else 'NONE')" 2>/dev/null || echo "NONE")

  if [[ "$STATUS" == *"chemotropic"* ]]; then
    ok "Tunnel LIVE -> $STATUS"
  else
    err "Tunnel failed — retrying in 5s..."
    kill $NGROK_PID 2>/dev/null || true
    sleep 5
    continue
  fi

  while true; do
    sleep 30
    if ! kill -0 $NGROK_PID 2>/dev/null; then
      warn "ngrok died — restarting..."; break
    fi
    HTTP=$(curl -s -o /dev/null -w "%{http_code}" "https://$NGROK_DOMAIN/api/health" 2>/dev/null || echo "000")
    if [[ "$HTTP" != "200" ]]; then
      warn "Tunnel unhealthy (HTTP $HTTP) — restarting..."
      kill $NGROK_PID 2>/dev/null || true
      break
    fi
  done
  sleep 3
done
