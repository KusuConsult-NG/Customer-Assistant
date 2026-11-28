#!/usr/bin/env bash
# Turn a check-production.sh result into a GitHub issue: one open
# "Production alert" issue while anything fails (GitHub notifies everyone
# watching the repository), updated when the problem changes, and closed with
# a note when everything passes again. Uses the gh CLI with GH_TOKEN.
#   scripts/monitor/alert-issue.sh result.json
set -euo pipefail
file="${1:?usage: alert-issue.sh result.json}"
LABEL="${MONITOR_LABEL:-production-alert}"
status="$(sed -n 's/.*"status":"\([a-z]*\)".*/\1/p' "$file")"
summary="$(sed -n 's/.*"summary":"\([^"]*\)".*/\1/p' "$file")"
run="$(sed -n 's/.*"run":"\([^"]*\)".*/\1/p' "$file")"
now="$(date -u +%Y-%m-%dT%H:%MZ)"

gh label create "$LABEL" --color B60205 --description "Opened and closed by the production monitor" --force > /dev/null 2>&1 || true
open="$(gh issue list --label "$LABEL" --state open --json number,title --jq '.[0] | select(. != null) | "\(.number)\t\(.title)"' 2>/dev/null || true)"
number="${open%%$'\t'*}"; title="${open#*$'\t'}"
want="Production alert: $summary"

if [ "$status" = ok ]; then
  if [ -n "$open" ]; then
    gh issue comment "$number" --body "Recovered at $now: every check passes again. ${run:+[Run]($run)}"
    gh issue close "$number"
    echo "closed #$number"
  else
    echo "all ok, no open alert"
  fi
  exit 0
fi

body="$(printf '**%s** (checked %s)\n\n%s\n\nChecks: `%s`\n\nThis issue is opened by the production monitor (.github/workflows/production-monitor.yml) and closed by it when everything passes again. %s' \
  "$summary" "$now" "Look at the System Health page in the dashboard, then the server: \`docker compose --env-file server.env ps\` and \`logs api\`." \
  "$(sed -n 's/.*"checks":\({[^}]*}\).*/\1/p' "$file")" "${run:+[Run]($run)}")"
if [ -z "$open" ]; then
  gh issue create --title "${want:0:240}" --label "$LABEL" --body "$body"
  echo "opened"
elif [ "$title" != "${want:0:240}" ]; then
  gh issue edit "$number" --title "${want:0:240}"
  gh issue comment "$number" --body "The problem changed at $now: $summary"
  echo "updated #$number"
else
  echo "still failing, #$number already open"
fi
