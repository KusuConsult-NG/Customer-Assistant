#!/usr/bin/env bash
# Restore a backup made by backup.sh:  sudo ./restore.sh /srv/ace/backups/<stamp>
# REPLACES the current database and stored files. Asks first.
set -euo pipefail
cd "$(dirname "$0")"
. ./lib.sh
[ "$(id -u)" = 0 ] || die "Run as root."
dir="${1:-}"; [ -f "$dir/ace.dump" ] || die "Usage: sudo ./restore.sh $ACE_HOME/backups/<stamp>"
( cd "$dir" && sha256sum -c SHA256SUMS ) || die "Backup files do not match their checksums."
read -r -p "This REPLACES the live database and files with $dir. Type RESTORE: " ans
[ "$ans" = RESTORE ] || die "Not restored."
systemctl stop ace-api ace-web
read_env_file deploy.env
restore_public_dump "$dir/ace.dump" "/usr/lib/postgresql/${PG_VERSION:-17}/bin"
mv "$ACE_HOME/storage" "$ACE_HOME/storage.before-restore-$(date +%s)"
tar -C "$ACE_HOME" -xzf "$dir/storage.tgz"
chown -R ace:ace "$ACE_HOME/storage"
chmod -R u=rwX,g=rX,o= "$ACE_HOME/storage"
./schema.sh
systemctl start ace-api ace-web
./check.sh
