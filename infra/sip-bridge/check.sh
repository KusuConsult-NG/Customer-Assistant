#!/usr/bin/env bash
# What the bridge is doing right now. Run on the server: sudo ./check.sh
set -uo pipefail
echo "--- Registration with Alphatech (must say Registered) ---"
asterisk -rx "pjsip show registrations"
echo "--- Endpoints ---"
asterisk -rx "pjsip show endpoints" | grep -E "Endpoint:|Contact:" || true
echo "--- Calls in progress ---"
asterisk -rx "core show channels concise"
echo "--- Last 30 log lines ---"
tail -n 30 /var/log/asterisk/messages 2>/dev/null || journalctl -u asterisk -n 30 --no-pager
