#!/usr/bin/env bash
# Nightly backup: the database and every uploaded file, checked, kept for
# BACKUP_KEEP_DAYS, and copied OFF this server to BACKUP_REMOTE.
# Run by the ace-backup.timer (install.sh); safe to run by hand any time.
# Exits non-zero on any failure, so `systemctl status ace-backup` shows it.
source "$(dirname "$0")/lib.sh"
source "$(dirname "$0")/qdrant-snapshots.sh"

KEEP="$(env_get BACKUP_KEEP_DAYS)"; KEEP="${KEEP:-14}"
REMOTE="$(env_get BACKUP_REMOTE)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dir="backups/$stamp"

# Reported to the system health page however this ends: success, or the exit
# code of a failure. The report itself can never fail the backup.
offsite=false
report_backup() {
  local st=$? result=ok
  [ "$st" = 0 ] || result=failed
  dc exec -T api node apps/api/dist/monitoring/record-event.js backup "$result" \
    "{\"stamp\":\"$stamp\",\"offsite\":$offsite,\"exit\":$st,\"error\":\"$([ "$st" = 0 ] || echo "backup.sh exited $st: see journalctl -u ace-backup")\"}" \
    > /dev/null 2>&1 || true
  exit "$st"
}
trap report_backup EXIT

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

say "Knowledge base vectors (Qdrant, one snapshot per collection)"
QKEY="$(env_get QDRANT_API_KEY)"
qcurl() { dc exec -T api curl -fsS -H "api-key: $QKEY" "$@"; }
collections="$(qdrant_backup "$dir")" || die "the Qdrant snapshot failed — this backup has no knowledge base"
echo "$collections collection(s)"

(cd "$dir" && sha256sum database.dump files.tar.gz $(ls qdrant/*.snapshot 2>/dev/null) > SHA256SUMS)
echo "$(du -sh "$dir" | cut -f1) in $HERE/$dir"

ENC_KEY="$(env_get BACKUP_ENCRYPTION_KEY)"
upload="$dir"
if [ -n "$ENC_KEY" ]; then
  say "Encrypting backup archive (AES-256-CBC + PBKDF2)"
  # Written OUTSIDE the folder it packs: written inside, tar saw the folder
  # change as it read it and exited 1, which stopped every encrypted backup
  # here, before the copy off the server (found 28 Nov 2026).
  enc="backups/.$stamp.tar.gz.enc"
  tar czf - -C "$dir" . | openssl enc -aes-256-cbc -pbkdf2 -salt -pass "pass:$ENC_KEY" -out "$enc"
  chmod 600 "$enc"
  # Only the encrypted archive leaves this server; the readable copy stays here.
  upload="backups/.$stamp-offsite"
  mkdir -p "$upload" && chmod 700 "$upload"
  mv "$enc" "$upload/backup.tar.gz.enc"
  (cd "$upload" && sha256sum backup.tar.gz.enc > SHA256SUMS)
  # Proven readable now, not on the night it is needed.
  openssl enc -d -aes-256-cbc -pbkdf2 -pass "pass:$ENC_KEY" -in "$upload/backup.tar.gz.enc" | tar tzf - > /dev/null \
    || die "the encrypted archive could not be decrypted and read back"
fi

say "Keeping $KEEP days on this server"
find backups -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP" -exec rm -rf {} +

finish_offsite() { [ "$upload" = "$dir" ] || { mv "$upload/backup.tar.gz.enc" "$dir/" && rm -rf "$upload"; }; }

if [ -z "$REMOTE" ]; then
  finish_offsite
  echo "WARNING: BACKUP_REMOTE is empty — this backup is on THIS server only and is lost with its disk."
  exit 0
fi
say "Copying off this server to $REMOTE/$stamp$([ "$upload" = "$dir" ] || echo ' (encrypted archive only)')"
rclone copy "$upload" "$REMOTE/$stamp" --retries 5 || die "copy to $REMOTE failed — tonight's backup is on this server only"
rclone check "$upload" "$REMOTE/$stamp" --one-way || die "the copy at $REMOTE/$stamp does not match"
offsite=true
finish_offsite
say "Backup $stamp done and copied off the server"
