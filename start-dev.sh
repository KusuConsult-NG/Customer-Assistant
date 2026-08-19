#!/usr/bin/env bash
# ==============================================================================
# PLASCHEMA Customer Assistant Platform — Unified Dev Starter
# ==============================================================================

set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo ""
echo "🏥  ==============================================================="
echo "🏥   PLASCHEMA Customer Assistant — Platform Initializer"
echo "🏥  ==============================================================="
echo ""

# 1. Check ngrok tunnel status
NGROK_URL=$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | grep -o 'https://[^"\'']*\.ngrok[^"\'']*' | head -n 1 || true)

if [ -n "$NGROK_URL" ]; then
  echo "🌐  Detected Active ngrok Tunnel: $NGROK_URL"
  # Update API_BASE_URL in apps/api/.env
  if [ -f "apps/api/.env" ]; then
    sed -i.bak "s|API_BASE_URL=.*|API_BASE_URL=$NGROK_URL|" apps/api/.env
    echo "✅  Updated apps/api/.env with live API_BASE_URL=$NGROK_URL"
  fi
else
  echo "⚠️   No active ngrok tunnel detected on http://127.0.0.1:4040."
  echo "    Local testing on http://localhost:3000 will work normally."
  echo "    For live cellular phone calls / ElevenLabs webhook testing, run 'ngrok http 4000' in another window."
fi

echo ""
echo "📦  Building packages & apps..."
npm run build --workspace=@ace/database
npm run build --workspace=@ace/pdf-generator
npm run build --workspace=@ace/api
npm run build --workspace=@ace/web

echo ""
echo "🤖  Syncing PLASCHEMA Knowledge Base & ElevenLabs Agent..."
node scripts/setup-plaschema.js

echo ""
echo "🚀  Starting background daemons..."
# Start API
(cd apps/api && node dist/main.js) &
API_PID=$!

# Start Web
(cd apps/web && npx next start -p 3000) &
WEB_PID=$!

echo ""
echo "================================================================="
echo "  🎉  PLASCHEMA System is LIVE!"
echo ""
echo "  📱 Staff Dashboard & CRM  : http://localhost:3000/crm"
echo "  💳 Online Payment Portal   : http://localhost:3000/pay/informal"
echo "  ⚙️  API Server              : http://localhost:4000"
echo "  📞 Helpline Number         : 0700-700-1111"
echo "  👤 Admin Login             : admin@acedemo.com / Admin@2030!"
echo "================================================================="
echo ""

wait $API_PID $WEB_PID
