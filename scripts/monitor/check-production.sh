#!/usr/bin/env bash
# The monitor OUTSIDE the production server (GitHub Actions,
# .github/workflows/production-monitor.yml). Checks the live site and prints
# one JSON result: {"status":"ok"|"failed","summary":"…","checks":{…}}.
#   scripts/monitor/check-production.sh https://contact.plateaustate.gov.ng
# Each check is retried (MONITOR_TRIES, default 3, MONITOR_RETRY_SECS apart) so
# one dropped packet is not an alert. Always exits 0: the result is the JSON.
set -uo pipefail
BASE="${1:?usage: check-production.sh BASE_URL}"; BASE="${BASE%/}"
TRIES="${MONITOR_TRIES:-3}"; WAIT="${MONITOR_RETRY_SECS:-15}"; MIN_TLS_DAYS="${MONITOR_MIN_TLS_DAYS:-14}"
CURL_EXTRA="${MONITOR_CURL_EXTRA:-}"   # tests only (e.g. -k for a self-signed certificate)

declare -A result
problems=()

# Fetch $1, retrying; sets code, body and ms.
fetch() {
  local url="$1" i out
  for i in $(seq "$TRIES"); do
    out="$(curl -s $CURL_EXTRA -o /tmp/monitor-body -w '%{http_code} %{time_total}' --max-time 20 "$url" 2>/dev/null || echo "000 0")"
    code="${out%% *}"; ms="$(awk -v t="${out##* }" 'BEGIN { printf "%d", t * 1000 }')"
    body="$(head -c 400 /tmp/monitor-body 2>/dev/null || true)"
    [ "$code" = 200 ] && return 0
    [ "$i" -lt "$TRIES" ] && sleep "$WAIT"
  done
  return 1
}

if fetch "$BASE/api/health"; then result[site]="ok (${ms} ms)"; else result[site]="HTTP $code"; problems+=("the site does not answer (HTTP $code)"); fi
if fetch "$BASE/api/health/ready"; then result[database]="ok"; else result[database]="HTTP $code"; problems+=("the database is not reachable (ready check HTTP $code)"); fi
if fetch "$BASE/api/health/voice"; then
  voice="$(printf '%s' "$body" | sed -n 's/.*"voice"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p')"
  result[voice]="${voice:-unknown}"
  case "$voice" in ok|disabled) ;; *) problems+=("the phone line is ${voice:-not reporting}: calls go to the backup line") ;; esac
else
  result[voice]="HTTP $code"; problems+=("the phone line status does not answer (HTTP $code)")
fi

host="$(printf '%s' "$BASE" | sed -E 's#^https?://([^/:]+).*#\1#')"
port="$(printf '%s' "$BASE" | sed -nE 's#^https?://[^/:]+:([0-9]+).*#\1#p')"; port="${port:-443}"
end="$(echo | timeout 20 openssl s_client -connect "$host:$port" -servername "$host" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
if [ -n "$end" ]; then
  days=$(( ($(date -d "$end" +%s) - $(date +%s)) / 86400 ))
  result[tls_days_left]="$days"
  [ "$days" -ge "$MIN_TLS_DAYS" ] || problems+=("the HTTPS certificate expires in $days day(s)")
else
  result[tls_days_left]="unreadable"; problems+=("the HTTPS certificate could not be read")
fi

status=ok; summary="All checks passed."
if [ "${#problems[@]}" -gt 0 ]; then status=failed; summary="$(IFS=';'; echo "${problems[*]}" | sed 's/;/; /g')."; fi
checks="$(for k in "${!result[@]}"; do printf '"%s":"%s",' "$k" "${result[$k]//\"/}"; done)"
printf '{"status":"%s","summary":"%s","checks":{%s},"run":"%s"}\n' "$status" "${summary//\"/}" "${checks%,}" "${MONITOR_RUN_URL:-}"
