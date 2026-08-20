#!/bin/bash
# PLASCHEMA Full Stack Startup Script
# Run this after system boot or terminal restart to bring everything back online
# Usage: bash /Users/mac/Customer\ Assistance/start-plaschema.sh

set -e
echo "🚀 Starting PLASCHEMA services..."

# 1. Redis
if ! redis-cli ping &>/dev/null; then
  echo "Starting Redis..."
  redis-server --daemonize yes
  sleep 2
else
  echo "Redis: already running ✅"
fi

# 2. ngrok (static reserved domain — only start if not already running)
if ! curl -s http://localhost:4040/api/tunnels &>/dev/null; then
  echo "Starting ngrok tunnel..."
  nohup ngrok http --domain=chemotropic-albertha-contritely.ngrok-free.dev 4000 > /tmp/ngrok.log 2>&1 &
  sleep 5
else
  echo "ngrok: already running ✅"
fi

# 3. API + Web via PM2
echo "Starting API and Web via PM2..."
pm2 resurrect 2>/dev/null || pm2 start /Users/mac/Customer\ Assistance/ecosystem.config.js
sleep 5

# 4. Status check
echo ""
echo "=== Service Status ==="
pm2 status
echo ""
redis-cli ping && echo "Redis: ✅"
curl -s http://localhost:4000/api/health && echo " API: ✅"
curl -s -o /dev/null -w "Web HTTP %{http_code}" http://localhost:3000 && echo " Web: ✅"
NGROK_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null | node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.tunnels?.[0]?.public_url||'no tunnel')}catch(e){console.log('ngrok not ready')}")
echo "ngrok: $NGROK_URL"
echo ""
echo "✅ PLASCHEMA is live!"
