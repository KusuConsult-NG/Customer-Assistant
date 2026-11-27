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

say "Qdrant vector snapshot"
QKEY="$(env_get QDRANT_API_KEY)"
if [ -n "$QKEY" ]; then
  snap="$(dc exec -T api curl -fsS -X POST -H "api-key: $QKEY" http://qdrant:6333/snapshots | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')"
  if [ -n "$snap" ]; then
    dc exec -T api curl -fsS -H "api-key: $QKEY" "http://qdrant:6333/snapshots/$snap" > "$dir/qdrant.snapshot" || rm -f "$dir/qdrant.snapshot"
  fi
fi

(cd "$dir" && sha256sum database.dump files.tar.gz $([ -f qdrant.snapshot ] && echo qdrant.snapshot) > SHA256SUMS)
echo "$(du -sh "$dir" | cut -f1) in $HERE/$dir"

ENC_KEY="$(env_get BACKUP_ENCRYPTION_KEY)"
if [ -n "$ENC_KEY" ]; then
  say "Encrypting backup archive (AES-256-CBC + PBKDF2)"
  tar czf - -C "$dir" . | openssl enc -aes-256-cbc -pbkdf2 -salt -pass "pass:$ENC_KEY" -out "$dir/backup.tar.gz.enc"
  chmod 600 "$dir/backup.tar.gz.enc"
fi

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
