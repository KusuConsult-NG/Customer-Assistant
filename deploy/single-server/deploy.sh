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
# callers can each be told they hold the same slot. Applied only when absent
# (a restored or migrated database already carries it).
if [ "$(dc exec -T postgres psql -U ace -d ace -tAc "select count(*) from pg_constraint where conname = 'bookings_no_staff_overlap'")" != "1" ]; then
  say "Adding the booking overlap constraint"
  for m in $(grep -l 'SQL-ONLY-MIGRATION' ../../packages/database/prisma/migrations/*/migration.sql | sort); do
    dc exec -T postgres psql -U ace -d ace -v ON_ERROR_STOP=1 -q < "$m"
  done
fi

say "Starting everything"
dc up -d --remove-orphans
wait_healthy api 80

say "Checking https://$DOMAIN through Caddy"
ok=""
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
