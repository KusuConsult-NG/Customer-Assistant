#!/usr/bin/env bash
# The production monitor's two scripts, end to end on this machine:
# - check-production.sh against a local HTTPS server with real certificates
#   (one valid 30 days, one expiring in 5) answering as a healthy, a broken
#   and an unreachable production would;
# - alert-issue.sh against a stand-in gh that records every command (the real
#   one would post to the real repository), through open → still failing →
#   problem changes → recovered.
# CI runs it on every change.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'kill $(jobs -p) 2>/dev/null || true; rm -rf "$T"' EXIT
fail() { echo "FAIL: $*"; exit 1; }
export MONITOR_TRIES=1 MONITOR_RETRY_SECS=0 MONITOR_CURL_EXTRA=-k

for d in 30 5; do openssl req -x509 -newkey rsa:2048 -nodes -keyout "$T/k$d.pem" -out "$T/c$d.pem" -days $d -subj /CN=127.0.0.1 > /dev/null 2>&1; done
cat > "$T/server.py" <<'PY'
import http.server, json, ssl, sys
port, cert, key, ready, voice = int(sys.argv[1]), sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        code, body = 404, {}
        if self.path == '/api/health': code, body = 200, {'status': 'ok'}
        elif self.path == '/api/health/ready': code, body = ready, {'status': 'ready' if ready == 200 else 'not ready'}
        elif self.path == '/api/health/voice': code, body = 200, {'voice': voice}
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(json.dumps(body).encode())
s = http.server.HTTPServer(('127.0.0.1', port), H)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(cert, key)
s.socket = ctx.wrap_socket(s.socket, server_side=True)
s.serve_forever()
PY
run() { # cert-days ready-code voice-state -> result json
  local port=$((20000 + RANDOM % 20000))
  python3 "$T/server.py" "$port" "$T/c$1.pem" "$T/k$1.pem" "$2" "$3" & local pid=$!
  for _ in $(seq 50); do curl -sk "https://127.0.0.1:$port/api/health" > /dev/null 2>&1 && break; sleep 0.1; done
  bash "$HERE/check-production.sh" "https://127.0.0.1:$port"
  kill "$pid"; wait "$pid" 2>/dev/null || true
}

ok="$(run 30 200 ok)"; echo "healthy:      $ok"
echo "$ok" | grep -q '"status":"ok"' || fail "a healthy site was not ok"
echo "$ok" | grep -qE '"tls_days_left":"(29|30)"' || fail "certificate days not read"
r="$(run 30 503 ok)"; echo "database down: $r"
echo "$r" | grep -q '"status":"failed"' && echo "$r" | grep -q 'database is not reachable' || fail "a failed ready check was not reported"
r="$(run 30 200 down)"; echo "voice down:   $r"
echo "$r" | grep -q 'the phone line is down: calls go to the backup line' || fail "a down phone line was not reported"
r="$(run 30 200 disabled)"; echo "$r" | grep -q '"status":"ok"' || fail "a disabled local line (backup answers) is not a fault"
r="$(run 5 200 ok)"; echo "cert 5 days:  $r"
echo "$r" | grep -q 'certificate expires in [45] day' || fail "an expiring certificate was not reported"
r="$(bash "$HERE/check-production.sh" "https://127.0.0.1:1")"; echo "unreachable:  $r"
echo "$r" | grep -q '"status":"failed"' && echo "$r" | grep -q 'the site does not answer' || fail "an unreachable site was not reported"

# ── alert-issue.sh, with a stand-in gh ──
mkdir -p "$T/bin"; : > "$T/gh.log"; : > "$T/gh.state"
cat > "$T/bin/gh" <<'GH'
#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
case "$1 $2" in
  "issue list") cat "$GH_STATE" ;;
  "issue create") t=""; while [ $# -gt 0 ]; do [ "$1" = --title ] && t="$2"; shift; done; printf '7\t%s' "$t" > "$GH_STATE" ;;
  "issue edit") t=""; while [ $# -gt 0 ]; do [ "$1" = --title ] && t="$2"; shift; done; printf '7\t%s' "$t" > "$GH_STATE" ;;
  "issue close") : > "$GH_STATE" ;;
esac
GH
chmod +x "$T/bin/gh"
export PATH="$T/bin:$PATH" GH_LOG="$T/gh.log" GH_STATE="$T/gh.state"
alert() { echo "$1" > "$T/r.json"; bash "$HERE/alert-issue.sh" "$T/r.json"; }
down='{"status":"failed","summary":"the database is not reachable (ready check HTTP 503).","checks":{"site":"ok"},"run":"https://x/run/1"}'
other='{"status":"failed","summary":"the site does not answer (HTTP 000).","checks":{"site":"HTTP 000"},"run":"https://x/run/2"}'
fine='{"status":"ok","summary":"All checks passed.","checks":{"site":"ok"},"run":"https://x/run/3"}'
[ "$(alert "$fine")" = "all ok, no open alert" ] || fail "ok with no issue did something"
[ "$(alert "$down")" = "opened" ] || fail "a failure did not open an issue"
grep -q '^issue create --title Production alert: the database is not reachable' "$T/gh.log" || fail "issue title wrong: $(cat "$T/gh.log")"
[ "$(alert "$down")" = "still failing, #7 already open" ] || fail "the same failure opened a second issue"
[ "$(alert "$other")" = "updated #7" ] || fail "a changed failure did not update the issue"
[ "$(alert "$fine")" = "closed #7" ] || fail "recovery did not close the issue"
grep -q '^issue comment 7 --body Recovered at' "$T/gh.log" || fail "no recovery note"
[ "$(grep -c '^issue create' "$T/gh.log")" = 1 ] || fail "more than one issue was opened"
echo "PASS: healthy, database down, voice down, voice disabled, expiring certificate and unreachable are judged right; one issue is opened, kept, updated and closed"
