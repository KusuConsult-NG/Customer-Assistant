# Shared helpers for the single-server kit. Sourced, never run.

# Read KEY=VALUE as TEXT, never `source` it: a password with ( ) ! $ or a space
# is legal in the file and a syntax error (or worse) when executed.
read_env_file() {
  local file="$1" line val
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]] || { echo "$file: cannot read line: $line" >&2; exit 1; }
    val="${BASH_REMATCH[2]}"
    val="${val%\"}"; val="${val#\"}"
    export "${BASH_REMATCH[1]}=$val"
  done < "$file"
}

# KEY=VALUE pairs of a file, for copying into another, minus the kit's own keys.
env_pairs() {
  grep -E '^[A-Z_][A-Z0-9_]*=' "$1" | grep -vE "^(${KIT_ONLY_KEYS})="
}

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# A secret kept across re-runs: generated once into /etc/ace/generated.env.
keep_secret() {
  local name="$1" bytes="${2:-24}" gen=/etc/ace/generated.env
  if ! grep -qE "^${name}=" "$gen" 2>/dev/null; then
    echo "${name}=$(openssl rand -hex "$bytes")" >> "$gen"
  fi
  export "$name=$(grep -E "^${name}=" "$gen" | tail -1 | cut -d= -f2-)"
}

# Keys deploy.env holds for the kit itself; everything else is passed to the app.
KIT_ONLY_KEYS='DOMAIN|ACME_EMAIL|PG_VERSION|QDRANT_VERSION|BACKUP_KEEP_DAYS|SSH_PORT|SOURCE_DATABASE_URL|SOURCE_SUPABASE_URL|SOURCE_SUPABASE_SERVICE_ROLE_KEY|BACKUP_RSYNC_TARGET'

ACE_HOME=/srv/ace
ACE_ENV=/etc/ace/ace.env

# Restore a custom-format dump of the PUBLIC schema into database `ace`,
# replacing what is there. Used by migrate-from-supabase.sh and restore.sh, so
# a backup comes back exactly the way production's data first arrived.
#
# In sections, because a public-schema dump (a) creates the schema itself, so
# it must not exist beforehand, and (b) does not carry btree_gist — it lived IN
# public on Supabase — which the booking constraint needs. --role=ace: all of it
# owned by the app's role. --exit-on-error: a half-done restore stops loudly.
# The file is opened by root and passed on stdin, so dumps can stay root-only.
restore_public_dump() {
  local file="$1" pgbin="$2" section
  runuser -u postgres -- env PGOPTIONS='-c client_min_messages=warning' \
    psql -d ace -v ON_ERROR_STOP=1 -q -c 'DROP SCHEMA IF EXISTS public CASCADE;'
  for section in pre-data extensions data post-data; do
    if [ "$section" = extensions ]; then
      runuser -u postgres -- psql -d ace -v ON_ERROR_STOP=1 -q \
        -c 'CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA public; CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA public; CREATE EXTENSION IF NOT EXISTS "uuid-ossp" SCHEMA public;'
      continue
    fi
    runuser -u postgres -- "$pgbin/pg_restore" -d ace --no-owner --no-privileges --role=ace --exit-on-error \
      --section="$section" < "$file" \
      || die "The restore failed in its $section section (above). The app is stopped; fix and re-run."
  done
}
