#!/usr/bin/env bash
# Restore a backup made by backup.sh. REPLACES the database and the uploaded
# files with the backup's.
#   ./restore.sh backups/20261121T013000Z --replace-everything
source "$(dirname "$0")/lib.sh"
source "$(dirname "$0")/qdrant-snapshots.sh"

dir="${1:-}"
# An off-site copy holds only the encrypted archive (backup.sh): unpack it here first.
if [ -n "$dir" ] && [ -f "$dir/backup.tar.gz.enc" ] && [ ! -f "$dir/database.dump" ]; then
  ENC_KEY="$(env_get BACKUP_ENCRYPTION_KEY)"
  [ -n "$ENC_KEY" ] || die "$dir holds an encrypted archive, and BACKUP_ENCRYPTION_KEY is empty in server.env."
  say "Decrypting $dir/backup.tar.gz.enc"
  openssl enc -d -aes-256-cbc -pbkdf2 -pass "pass:$ENC_KEY" -in "$dir/backup.tar.gz.enc" | tar xzf - -C "$dir" \
    || die "the archive could not be decrypted: wrong BACKUP_ENCRYPTION_KEY, or a damaged copy"
fi
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

say "Replacing the knowledge base vectors (Qdrant)"
if ls "$dir"/qdrant/*.snapshot > /dev/null 2>&1; then
  dc up -d qdrant
  wait_healthy qdrant
  QKEY="$(env_get QDRANT_API_KEY)"
  qcurl() { dc run --rm --no-deps -T --entrypoint curl api -fsS -H "api-key: $QKEY" "$@"; }
  n="$(qdrant_restore "$dir")" || die "Qdrant refused a snapshot: the database and files are restored, the knowledge base is NOT"
  echo "$n collection(s) restored"
elif [ -f "$dir/qdrant.snapshot" ]; then
  echo "WARNING: this backup holds only the old whole-storage Qdrant snapshot, which Qdrant's API cannot restore."
  echo "         The database and files are restored; the knowledge base vectors are NOT. Re-index the knowledge base."
else
  echo "WARNING: this backup has no Qdrant snapshot: the knowledge base vectors are NOT restored."
fi

say "Starting everything"
dc up -d
wait_healthy api 80
say "Restored from $dir"
