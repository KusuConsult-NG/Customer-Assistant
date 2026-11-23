#!/usr/bin/env bash
# Nightly: the database (pg_dump custom format) and the stored files
# (uploads, selfies, call recordings). The speech cache is NOT backed up: it is
# rebuilt by use. Old backups beyond BACKUP_KEEP_DAYS are removed.
#
# A backup on the same disk survives a bad deploy, not a dead disk. Copy
# $ACE_HOME/backups off this server (PICTDA's backup storage, another VPS) —
# set BACKUP_RSYNC_TARGET in deploy.env to have this do it each night.
set -euo pipefail
cd "$(dirname "$0")"
. ./lib.sh
read_env_file deploy.env
KEEP="${BACKUP_KEEP_DAYS:-14}"
stamp="$(date +%Y%m%d-%H%M%S)"
dir="$ACE_HOME/backups/$stamp"
install -d -m 700 "$dir"
# The public schema: everything the app owns, in the shape restore.sh (and
# the original migration) restores. Extensions are recreated on restore.
runuser -u postgres -- pg_dump -d ace -n public -Fc -Z 6 --no-owner --no-privileges > "$dir/ace.dump"
tar -C "$ACE_HOME" -czf "$dir/storage.tgz" storage
( cd "$dir" && sha256sum ace.dump storage.tgz > SHA256SUMS )
echo "$(date -Is) backup $dir $(du -sh "$dir" | cut -f1)"
find "$ACE_HOME/backups" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP" -exec rm -r -- {} +
if [ -n "${BACKUP_RSYNC_TARGET:-}" ]; then
  rsync -a --delete "$ACE_HOME/backups/" "$BACKUP_RSYNC_TARGET/"
  echo "$(date -Is) copied off-server to $BACKUP_RSYNC_TARGET"
fi
