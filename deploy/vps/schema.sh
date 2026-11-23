#!/usr/bin/env bash
# Bring the database schema up to the code: prisma db push, then the SQL-only
# migrations (the booking EXCLUDE constraint, which Prisma cannot express),
# then any enum values the code uses. Run by install.sh, update.sh and
# migrate-from-supabase.sh; safe to run any number of times.
set -euo pipefail
cd "$(dirname "$0")"
. ./lib.sh
[ "$(id -u)" = 0 ] || die "Run as root."
APP_DIR="$ACE_HOME/app"
DB_URL="$(grep -E '^DATABASE_URL=' "$ACE_ENV" | cut -d= -f2-)"
[ -n "$DB_URL" ] || die "No DATABASE_URL in $ACE_ENV — run install.sh first."
# Only the database settings: both commands need nothing else, and passing the
# whole file through a shell would execute any value containing $( ) or quotes.
as_ace() { runuser -u ace -- env HOME="$ACE_HOME" DATABASE_URL="$DB_URL" DIRECT_URL="$DB_URL" bash -c "cd '$APP_DIR' && $1"; }

# db push refuses (rather than silently dropping data) when a change would
# lose data; that refusal is the point, so it is never given --accept-data-loss
# here. Resolve such a change by hand, deliberately.
as_ace "npx prisma db push --schema=packages/database/prisma/schema.prisma --skip-generate"

def="$(runuser -u postgres -- psql -d ace -tAc "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='bookings_no_staff_overlap'")"
if [[ "$def" == *'COALESCE("staffName"'* ]]; then
  echo "booking overlap constraint: current"
else
  if [ -n "$def" ]; then state="outdated (does not cover unstaffed bookings)"; else state=missing; fi
  echo "booking overlap constraint: $state — applying the SQL-only migrations"
  for m in $(grep -l 'SQL-ONLY-MIGRATION' "$APP_DIR"/packages/database/prisma/migrations/*/migration.sql | sort); do
    echo "  $m"
    runuser -u postgres -- psql -d ace -v ON_ERROR_STOP=1 -q -f "$m"
  done
  # Created by postgres: hand the constraint's table back to its owner.
  runuser -u postgres -- psql -d ace -q -c 'ALTER TABLE bookings OWNER TO ace;'
fi

as_ace "node scripts/sync-enum-values.js --apply"
