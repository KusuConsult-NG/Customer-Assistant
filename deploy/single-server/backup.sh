#!/usr/bin/env bash
# Nightly backup: the database and every uploaded file, checked, kept for
# BACKUP_KEEP_DAYS, and copied OFF this server to BACKUP_REMOTE.
# Run by the ace-backup.timer (install.sh); safe to run by hand any time.
# Exits non-zero on any failure, so `systemctl status ace-backup` shows it.
source "$(dirname "$0")/lib.sh"

KEEP="$(env_get BACKUP_KEEP_DAYS)"; KEEP="${KEEP:-14}"
REMOTE="$(env_get BACKUP_REMOTE)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dir="backups/$stamp"
mkdir -p "$dir"
chmod 700 backups "$dir"

say "Database"
dc exec -T postgres pg_dump -U ace -d ace --format=custom --no-owner > "$dir/database.dump"
# A dump that cannot be read back is not a backup.
dc exec -T postgres pg_restore --list < "$dir/database.dump" > /dev/null \
  || die "the database dump in $dir could not be read back"

say "Uploaded files"
dc exec -T api tar czf - -C /data files > "$dir/files.tar.gz"
tar tzf "$dir/files.tar.gz" > /dev/null || die "the files archive in $dir could not be read back"

(cd "$dir" && sha256sum database.dump files.tar.gz > SHA256SUMS)
echo "$(du -sh "$dir" | cut -f1) in $HERE/$dir"

say "Keeping $KEEP days on this server"
find backups -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP" -exec rm -rf {} +

if [ -z "$REMOTE" ]; then
  echo "WARNING: BACKUP_REMOTE is empty — this backup is on THIS server only and is lost with its disk."
  exit 0
fi
say "Copying off this server to $REMOTE/$stamp"
rclone copy "$dir" "$REMOTE/$stamp" --retries 5 || die "copy to $REMOTE failed — tonight's backup is on this server only"
rclone check "$dir" "$REMOTE/$stamp" --one-way || die "the copy at $REMOTE/$stamp does not match"
say "Backup $stamp done and copied off the server"
