#!/usr/bin/env bash
# Build and (re)start the whole platform on this server, and bring the
# database schema up to date. Safe to re-run; this is also how an update is
# deployed (git pull, then ./deploy.sh).
source "$(dirname "$0")/lib.sh"

DOMAIN="$(env_get DOMAIN)"
[ -n "$DOMAIN" ] || die "DOMAIN is empty in server.env."
for v in POSTGRES_PASSWORD QDRANT_API_KEY JWT_SECRET JWT_REFRESH_SECRET ENCRYPTION_KEY; do
  [ -n "$(env_get "$v")" ] || die "$v is empty in server.env."
done

# Behind a named Cloudflare Tunnel no inbound port is open, so Caddy must not
# try to fetch a certificate for the domain: it would fail, retry for hours,
# and this script's last check would fail with it.
TUNNEL="$(env_get CLOUDFLARE_TUNNEL_TOKEN)"
if [ -n "$TUNNEL" ]; then
  [[ "$(env_get CADDY_PUBLIC_SITE)" == http://* ]] \
    || die "CLOUDFLARE_TUNNEL_TOKEN is set, so set CADDY_PUBLIC_SITE=http://:8081 in server.env as well."
  case "$DOMAIN" in *.trycloudflare.com) die "DOMAIN is still the temporary tunnel address. Set it to the hostname you gave the named tunnel in Cloudflare." ;; esac
fi

say "Building images (the dashboard is built for https://$DOMAIN)"
dc build

say "Starting the database, Redis and Qdrant"
dc up -d postgres redis qdrant
wait_healthy postgres
wait_healthy redis

# Additive changes only. `db push` refuses anything that would lose data,
# and that refusal stops the deploy here, before new code meets an old schema.
say "Updating the database schema"
dc run --rm --no-deps -T api npx prisma db push --skip-generate --schema=packages/database/prisma/schema.prisma

# db push cannot express the booking EXCLUDE constraint; without it eight
# callers can each be told they hold the same slot. Applied when absent OR when
# it is the first version (`"staffName" IS NOT NULL`), which left every booking
# without a staff name unguarded — every one the phone agent and WhatsApp make.
# Production carried that version until 23 Nov 2026, so a database copied from
# it before then still does; checking only that the name exists missed it.
# Both migrations drop and re-create, so applying them again is safe.
def="$(dc exec -T postgres psql -U ace -d ace -tAc "select pg_get_constraintdef(oid) from pg_constraint where conname = 'bookings_no_staff_overlap'")"
if [[ "$def" != *'COALESCE("staffName"'* ]]; then
  if [ -n "$def" ]; then say "Replacing the old booking overlap constraint"; else say "Adding the booking overlap constraint"; fi
  for m in $(grep -l 'SQL-ONLY-MIGRATION' ../../packages/database/prisma/migrations/*/migration.sql | sort); do
    dc exec -T postgres psql -U ace -d ace -v ON_ERROR_STOP=1 -q < "$m"
  done
fi

# Replacing the api or bridge container ends every call in progress: the
# caller is cut off mid-sentence (26 Nov 2026, a test call dropped the moment
# the new api started). Wait for the line to be quiet first. DEPLOY_NOW=1
# skips the wait; DEPLOY_CALL_WAIT sets how long to wait (seconds, default 600).
active_calls() {
  dc exec -T bridge asterisk -rx "core show channels count" 2>/dev/null \
    | sed -n 's/^\([0-9][0-9]*\) active calls\{0,1\}$/\1/p'
}
if [ "${DEPLOY_NOW:-}" != "1" ] && [ -n "$(dc ps -q bridge 2>/dev/null)" ]; then
  limit="${DEPLOY_CALL_WAIT:-600}"; waited=0
  while :; do
    n="$(active_calls)"
    if [ -z "$n" ]; then
      echo "Could not read the call count from the bridge, so cannot tell whether a call is in progress."
      die "Re-run with DEPLOY_NOW=1 to restart anyway (any call in progress will be cut off)."
    fi
    [ "$n" = "0" ] && break
    if [ "$waited" -ge "$limit" ]; then
      die "$n call(s) still in progress after ${limit}s. Re-run when the line is quiet, or with DEPLOY_NOW=1 to cut them off."
    fi
    [ $((waited % 30)) -eq 0 ] && say "Waiting for $n call(s) in progress to finish before restarting"
    sleep 5; waited=$((waited + 5))
  done
fi

say "Starting everything"
dc up -d --remove-orphans
wait_healthy api 80

ok=""
if [ -n "$TUNNEL" ]; then
  # The real path, end to end: out to Cloudflare, back down the tunnel.
  say "Checking https://$DOMAIN through Cloudflare and the tunnel"
  for _ in $(seq 40); do
    if curl -fsS --max-time 10 "https://$DOMAIN/api/health" >/dev/null 2>&1; then ok=1; break; fi
    sleep 3
  done
  if [ -z "$ok" ]; then
    echo "The API is up but https://$DOMAIN does not answer through the tunnel. Check:"
    echo "  - the tunnel is connected:  docker compose --env-file server.env logs --tail 30 tunnel"
    echo "  - in Cloudflare, the tunnel's public hostname is $DOMAIN, with service http://caddy:8080"
    echo "The temporary tunnel (ace-tunnel), if it was running, has been left as it was."
    exit 1
  fi
  # Only now that the named tunnel is proven: the temporary one it replaces.
  if docker ps -a --format '{{.Names}}' | grep -qx ace-tunnel; then
    say "Removing the temporary tunnel (ace-tunnel): the named tunnel replaces it"
    docker rm -f ace-tunnel >/dev/null
  fi
  dc ps
  say "Deployed: https://$DOMAIN (through the Cloudflare Tunnel)"
  exit 0
fi

say "Checking https://$DOMAIN through Caddy"
# Only a trial run on "localhost" or "NAME.localhost" gets Caddy's own
# certificate; anything else must present a real one, which is the point.
insecure=""; case "$DOMAIN" in localhost|*.localhost) insecure="-k" ;; esac
for _ in $(seq 40); do
  if curl -fsS $insecure --max-time 5 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 3
done
if [ -z "$ok" ]; then
  echo "The API is up but https://$DOMAIN does not answer yet. Usually the certificate:"
  echo "DNS for $DOMAIN must point at this server and ports 80/443 must be open."
  echo "See: docker compose --env-file server.env logs caddy"
  exit 1
fi
dc ps
say "Deployed: https://$DOMAIN"
