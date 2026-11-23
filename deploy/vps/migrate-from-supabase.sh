#!/usr/bin/env bash
# Move production's data from Supabase onto this server.
#
#   sudo ./migrate-from-supabase.sh           REPORT: what is there, what is here. Changes nothing.
#   sudo ./migrate-from-supabase.sh --apply   copy the database and the files
#
# Reads SOURCE_DATABASE_URL (Supabase DIRECT connection, port 5432),
# SOURCE_SUPABASE_URL and SOURCE_SUPABASE_SERVICE_ROLE_KEY from deploy.env.
# Supabase is only READ. Run it once for a rehearsal, and again at cutover with
# Render stopped so nothing is written there in between (README, "Moving production").
set -euo pipefail
cd "$(dirname "$0")"
. ./lib.sh
[ "$(id -u)" = 0 ] || die "Run as root."
read_env_file deploy.env
APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1
for v in SOURCE_DATABASE_URL SOURCE_SUPABASE_URL SOURCE_SUPABASE_SERVICE_ROLE_KEY; do
  [ -n "${!v:-}" ] || die "deploy.env: $v is empty"
done
PG_VERSION="${PG_VERSION:-17}"
PGBIN="/usr/lib/postgresql/${PG_VERSION}/bin"
[[ "$SOURCE_DATABASE_URL" == *":6543"* ]] && die "SOURCE_DATABASE_URL is the pooler (6543). pg_dump needs the DIRECT connection (5432)."

# The files are copied by the repository's own scripts/copy-supabase-storage.js,
# which writes through the API's storage module, so copied files are laid out
# (and typed, for serving) exactly as the API lays out its own uploads. It
# runs with the app's settings (/etc/ace/ace.env: STORAGE_DIR, DATABASE_URL)
# and reads only the two SOURCE_SUPABASE_* values from deploy.env.
copy_files() {
  ( read_env_file "$ACE_ENV"
    export SOURCE_SUPABASE_URL SOURCE_SUPABASE_SERVICE_ROLE_KEY
    cd ../.. && node scripts/copy-supabase-storage.js "$@" )
}

counts_sql="SELECT string_agg(format('%s=%s', relname, n_live_tup), ' ' ORDER BY relname) FROM pg_stat_user_tables WHERE schemaname='public'"
exact_sql="SELECT string_agg(t || '=' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', t), false, true, '')))[1]::text, ' ' ORDER BY t) FROM (SELECT tablename AS t FROM pg_tables WHERE schemaname='public') s"

say "Source (Supabase)"
"$PGBIN/psql" "$SOURCE_DATABASE_URL" -tAc "SELECT version()" | head -1
src_counts="$("$PGBIN/psql" "$SOURCE_DATABASE_URL" -tAc "$exact_sql")"
echo "  rows: $src_counts" | fold -w 160
say "This server"
dst_counts="$(runuser -u postgres -- psql -d ace -tAc "$exact_sql" || true)"
echo "  rows: ${dst_counts:-(empty database)}" | fold -w 160
say "Files"
copy_files || true

if [ "$APPLY" = 0 ]; then
  echo; echo "Nothing was changed. Re-run with --apply to copy."
  exit 0
fi

if echo "$dst_counts" | grep -qE '=[1-9]'; then
  read -r -p "This server's database already holds data, which will be REPLACED by Supabase's. Type REPLACE: " ans
  [ "$ans" = REPLACE ] || die "Not changed."
  ./backup.sh
fi

say "Stopping the app while the data is replaced"
systemctl stop ace-api ace-web || true

dumpdir="$(mktemp -d)"
# pg_restore runs as postgres, which must be able to enter the folder.
chmod 711 "$dumpdir"
dump="$dumpdir/supabase.dump"
say "Dumping Supabase (public schema only — the app's tables)"
"$PGBIN/pg_dump" "$SOURCE_DATABASE_URL" -n public -Fc --no-owner --no-privileges -f "$dump"

say "Restoring"
restore_public_dump "$dump" "$PGBIN"
rm -rf -- "$dumpdir"

say "Schema to the current code (and the full booking constraint)"
./schema.sh

say "Verifying every table's row count against Supabase"
new_counts="$(runuser -u postgres -- psql -d ace -tAc "$exact_sql")"
if [ "$new_counts" = "$src_counts" ]; then
  echo "  every table matches"
else
  echo "  MISMATCH — do not cut over until this is explained:"
  diff <(tr ' ' '\n' <<<"$src_counts") <(tr ' ' '\n' <<<"$new_counts") || true
  mismatch=1
fi

say "Copying the files"
copy_files --apply
chown -R ace:ace "$ACE_HOME/storage"
chmod -R u=rwX,g=rX,o= "$ACE_HOME/storage"

systemctl start ace-api ace-web
sleep 5
./check.sh || true
cat <<NEXT

Data copied. Knowledge search on this server has no vectors yet (Qdrant here
is new): sign in as each agency's administrator and press Knowledge → Reindex,
or answers fall back to keyword search until you do.
NEXT
exit "${mismatch:-0}"
