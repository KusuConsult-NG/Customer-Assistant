#!/usr/bin/env bash
# Restore a backup made by backup.sh. REPLACES the database and the uploaded
# files with the backup's.
#   ./restore.sh backups/20261121T013000Z --replace-everything
source "$(dirname "$0")/lib.sh"

dir="${1:-}"
[ -n "$dir" ] && [ -f "$dir/database.dump" ] && [ -f "$dir/files.tar.gz" ] \
  || die "usage: ./restore.sh backups/STAMP --replace-everything   (a folder holding database.dump and files.tar.gz)"
[ "${2:-}" = "--replace-everything" ] \
  || die "this replaces the live database and files with the backup's. Add --replace-everything to go ahead."

if [ -f "$dir/SHA256SUMS" ]; then
  (cd "$dir" && sha256sum -c --quiet SHA256SUMS) || die "$dir does not match its checksums"
fi

say "Stopping the API and dashboard"
dc stop api web
dc up -d postgres
wait_healthy postgres

say "Replacing the database"
dc exec -T postgres psql -U ace -d postgres -v ON_ERROR_STOP=1 -q \
  -c "DROP DATABASE IF EXISTS ace WITH (FORCE)" -c "CREATE DATABASE ace OWNER ace"
dc exec -T postgres pg_restore -U ace -d ace --no-owner --exit-on-error < "$dir/database.dump"

say "Replacing the uploaded files"
dc run --rm --no-deps -T --entrypoint sh api -c 'find /data/files -mindepth 1 -delete && tar xzf - -C /data' < "$dir/files.tar.gz"

say "Starting everything"
dc up -d
wait_healthy api 80
say "Restored from $dir"
