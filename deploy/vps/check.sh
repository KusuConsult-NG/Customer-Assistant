#!/usr/bin/env bash
# What is running, and whether the platform answers — from this server and
# from the outside. Changes nothing.
cd "$(dirname "$0")"
. ./lib.sh
DOMAIN="$(grep -E '^API_BASE_URL=' "$ACE_ENV" 2>/dev/null | sed 's#.*https://##')"
ok=0
for s in postgresql redis-server qdrant ace-api ace-web caddy asterisk; do
  if systemctl is-active --quiet "$s"; then printf '  %-14s running\n' "$s"
  elif systemctl list-unit-files "$s.service" >/dev/null 2>&1 && systemctl list-unit-files "$s.service" | grep -q "$s"; then
    printf '  %-14s NOT RUNNING  (journalctl -u %s -n 50)\n' "$s" "$s"; ok=1
  else printf '  %-14s not installed\n' "$s"; fi
done
echo
probe() {
  printf '  %-44s ' "$1"
  local out code
  out="$(curl -s -o /dev/null -w '%{http_code} %{errormsg}' --max-time 10 "$2")"
  code="${out%% *}"
  # 000 alone says nothing: show why (DNS, certificate, refused, timeout).
  if [ "$code" = 000 ]; then echo "no answer — ${out#* }"; else echo "$code"; fi
  [ "$code" = "$3" ] || ok=1
}
# Just restarted? Give the API up to a minute to finish booting first.
for _ in $(seq 1 30); do curl -sf -o /dev/null --max-time 2 http://127.0.0.1:4000/api/health && break; sleep 2; done
probe "API liveness (local)" http://127.0.0.1:4000/api/health 200
probe "API readiness: database + Redis (local)" http://127.0.0.1:4000/api/health/ready 200
probe "Dashboard (local)" http://127.0.0.1:3000/login 200
if [ -n "$DOMAIN" ]; then
  probe "https://$DOMAIN/api/health" "https://$DOMAIN/api/health" 200
  probe "https://$DOMAIN/login" "https://$DOMAIN/login" 200
  probe "voice-line registration hidden from outside" "https://$DOMAIN/api/voice-local/outcome/x" 404
fi
echo
df -h "$ACE_HOME" | tail -1 | awk '{print "  disk: "$4" free of "$2" ("$5" used)"}'
exit $ok
