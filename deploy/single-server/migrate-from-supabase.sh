#!/usr/bin/env bash
# Move the data from Supabase onto this server: every table's rows, then every
# uploaded file. Read-only on Supabase — nothing there is changed.
#
#   ./migrate-from-supabase.sh           # REPORT: what is there, what would move
#   ./migrate-from-supabase.sh --apply   # do it (replaces this server's database)
#
# How: this server's schema is created from schema.prisma (exactly what the
# code expects), then the ROWS are copied in (a data-only dump of the tables
# that schema has), then row counts are compared table by table. Copying the
# schema itself from Supabase would bring Supabase's own roles, policies and
# extension schemas with it, which do not exist here.
source "$(dirname "$0")/lib.sh"
[ -f migrate.env ] || die "migrate.env is missing. cp migrate.env.example migrate.env, fill it in, chmod 600."
chmod 600 migrate.env
apply=""; [ "${1:-}" = "--apply" ] && apply=1

export SOURCE_DATABASE_URL SOURCE_SUPABASE_URL SOURCE_SUPABASE_SERVICE_ROLE_KEY
SOURCE_DATABASE_URL="$(env_get SOURCE_DATABASE_URL migrate.env)"
SOURCE_SUPABASE_URL="$(env_get SOURCE_SUPABASE_URL migrate.env)"
SOURCE_SUPABASE_SERVICE_ROLE_KEY="$(env_get SOURCE_SUPABASE_SERVICE_ROLE_KEY migrate.env)"
[ -n "$SOURCE_DATABASE_URL" ] || die "SOURCE_DATABASE_URL is empty in migrate.env."

# pg_dump 17 reads a PostgreSQL 15 or 17 server. The URL travels in the
# environment, never on a command line where `ps` would show the password.
PG="postgres:17"
src() { docker run --rm -i --network host -e SOURCE_DATABASE_URL "$PG" "$@"; }
src_sql() { src psql "$SOURCE_DATABASE_URL" -v ON_ERROR_STOP=1 -tAc "$1"; }
local_sql() { dc exec -T postgres psql -U ace -d ace -v ON_ERROR_STOP=1 -tAc "$1"; }

say "Reading the source database"
src_sql "select 'connected: PostgreSQL ' || current_setting('server_version')" \
  || die "could not connect with SOURCE_DATABASE_URL (use the Session pooler string, port 5432)."
for t in organizations users contacts conversations messages tickets call_logs knowledge_documents; do
  printf '  %-22s %s rows\n' "$t" "$(src_sql "select count(*) from public.\"$t\"" 2>/dev/null || echo '?')"
done

dc up -d postgres
wait_healthy postgres

say "Does the source match the schema this code expects?"
diffsql="$(dc run --rm --no-deps -T -e SOURCE_DATABASE_URL api sh -c \
  'npx prisma migrate diff --from-url "$SOURCE_DATABASE_URL" --to-schema-datamodel packages/database/prisma/schema.prisma --script' 2>&1)" \
  || die "could not compare schemas: $diffsql"
if echo "$diffsql" | grep -qE '^(CREATE|ALTER|DROP)'; then
  echo "  The source differs from schema.prisma; these statements would align it:"
  echo "$diffsql" | grep -E '^(CREATE|ALTER|DROP)' | sed 's/^/    /' | head -40
  echo "  Columns only the SOURCE has are not copied; columns only this schema has get their defaults."
else
  echo "  Identical."
fi

existing="$(local_sql "select count(*) from information_schema.tables where table_schema='public' and table_name='organizations'")"
if [ "$existing" = 1 ] && [ "$(local_sql 'select count(*) from organizations')" != 0 ]; then
  echo "  NOTE: this server's database already holds $(local_sql 'select count(*) from organizations') organization(s); --apply REPLACES it."
fi

say "Uploaded files (report)"
if [ -n "$SOURCE_SUPABASE_URL" ]; then
  dc run --rm --no-deps -T -e SOURCE_SUPABASE_URL -e SOURCE_SUPABASE_SERVICE_ROLE_KEY api node scripts/copy-supabase-storage.js \
    | sed -n '/^knowledge-documents\|^onboarding-selfies/p'
else
  echo "  SOURCE_SUPABASE_URL is empty: no files will be copied."
fi

if [ -z "$apply" ]; then
  echo
  echo "Nothing was changed. Run ./migrate-from-supabase.sh --apply to move the data."
  exit 0
fi

say "Stopping the API and dashboard while the data moves"
dc stop api web >/dev/null 2>&1 || true

say "Creating an empty database with the current schema"
dc exec -T postgres psql -U ace -d postgres -v ON_ERROR_STOP=1 -q \
  -c "DROP DATABASE IF EXISTS ace WITH (FORCE)" -c "CREATE DATABASE ace OWNER ace"
dc run --rm --no-deps -T api npx prisma db push --skip-generate --schema=packages/database/prisma/schema.prisma

say "Copying the rows"
# Table by table, only the columns BOTH sides have: a column the live database
# still carries but schema.prisma has dropped is left behind instead of
# failing the load, and one the schema added gets its default. Foreign-key
# triggers are off for the load (session_replication_role), so the order of
# tables does not matter.
mapfile -t tables < <(local_sql "select tablename from pg_tables where schemaname='public' order by 1")
cols_of() { "$1" "select string_agg(quote_ident(column_name), ',' order by column_name) from information_schema.columns where table_schema='public' and table_name='$2'"; }
for t in "${tables[@]}"; do
  if [ "$(src_sql "select count(*) from information_schema.tables where table_schema='public' and table_name='$t'")" != 1 ]; then
    echo "  (source has no table $t — left empty)"; continue
  fi
  common="$(comm -12 <(cols_of src_sql "$t" | tr ',' '\n' | sort) <(cols_of local_sql "$t" | tr ',' '\n' | sort) | paste -sd, -)"
  only_src="$(comm -23 <(cols_of src_sql "$t" | tr ',' '\n' | sort) <(cols_of local_sql "$t" | tr ',' '\n' | sort) | paste -sd, -)"
  [ -z "$only_src" ] || echo "  $t: not copied (no longer in the schema): $only_src"
  src psql "$SOURCE_DATABASE_URL" -v ON_ERROR_STOP=1 -qc "\\copy (select $common from public.\"$t\") to pstdout" \
    | dc exec -T postgres psql -U ace -d ace -v ON_ERROR_STOP=1 -q \
        -c "set session_replication_role = replica" -c "\\copy public.\"$t\" ($common) from pstdin" \
    || die "copying $t failed — the source is untouched; re-run --apply to start again from an empty database."
done

say "Comparing row counts, table by table"
bad=0
for t in "${tables[@]}"; do
  a="$(src_sql "select count(*) from public.\"$t\"" 2>/dev/null || echo 0)"
  b="$(local_sql "select count(*) from public.\"$t\"")"
  if [ "$a" != "$b" ]; then echo "  MISMATCH $t: source $a, here $b"; bad=1; fi
done
[ "$bad" = 0 ] || die "row counts differ — see above. The source is untouched; fix and re-run."
echo "  All ${#tables[@]} tables match."

if [ -n "$SOURCE_SUPABASE_URL" ]; then
  say "Copying the uploaded files"
  dc run --rm --no-deps -T -e SOURCE_SUPABASE_URL -e SOURCE_SUPABASE_SERVICE_ROLE_KEY api node scripts/copy-supabase-storage.js --apply \
    || die "some files could not be copied — see above. Re-running copies only what is missing."
fi

say "Starting everything (adds the booking constraint)"
./deploy.sh
say "Data moved. Once the new server has been checked, delete migrate.env."
