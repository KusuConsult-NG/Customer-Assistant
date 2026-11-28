#!/usr/bin/env bash
# Put back the release that ran before the last deploy: its images, which
# deploy.sh kept as :previous. Takes seconds; nothing is rebuilt.
#   ./rollback.sh --yes
# The database is NOT rolled back: deploy.sh only ever makes additive schema
# changes (prisma db push refuses anything that would lose data), so the
# previous code runs on the current database. Restarting the api and bridge
# ends any call in progress, which is why --yes is required.
source "$(dirname "$0")/lib.sh"
source "$(dirname "$0")/release.sh"

[ "${1:-}" = "--yes" ] || die "usage: ./rollback.sh --yes   (restarts the api, dashboard and bridge: any call in progress is cut off)"
DOMAIN="$(env_get DOMAIN)"

restore_previous_images || die "nothing to roll back to: no :previous images (they exist after the first deploy made by this deploy.sh)"
say "Restarting on the previous images"
dc up -d --remove-orphans
wait_healthy api 80
insecure=""; case "$DOMAIN" in localhost|*.localhost) insecure="-k" ;; esac
ok=""
for _ in $(seq 20); do
  if curl -fsS $insecure --max-time 5 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" > /dev/null 2>&1; then ok=1; break; fi
  sleep 3
done
record_release rolled-back
[ -n "$ok" ] || die "rolled back, but https://$DOMAIN/api/health does not answer yet. See: docker compose --env-file server.env logs api"
say "Rolled back. The release now running is the last line of releases.log."
