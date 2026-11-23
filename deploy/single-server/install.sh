#!/usr/bin/env bash
# One-time preparation of a fresh Ubuntu 22.04/24.04 server. Run as root:
#   sudo ./install.sh
# Installs Docker (from Docker's own repository: the compose features used
# here need a newer Compose than some Ubuntu releases ship), rclone for the
# off-server backup copy, the firewall, and the nightly backup timer.
# Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"
HERE="$(pwd)"
[ "$(id -u)" = 0 ] || { echo "Run as root: sudo ./install.sh"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "==> Packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git ufw rclone >/dev/null

if ! docker compose version >/dev/null 2>&1; then
  echo "==> Docker"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  systemctl enable --now docker
fi
docker compose version

# Docker publishes 80/443 itself (Caddy). The call bridge uses the host
# network, so its ports are governed by this firewall: SIP on 5060 and the
# media range. Nothing else is opened — the database, Redis, Qdrant, the API
# and the dashboard are reachable only inside Docker.
echo "==> Firewall"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw allow 5060/udp >/dev/null
ufw allow 5060/tcp >/dev/null
ufw allow 10000:20000/udp >/dev/null
ufw --force enable >/dev/null
ufw status | sed -n '1,20p'

if systemctl is-active --quiet asterisk 2>/dev/null; then
  echo "NOTE: a native Asterisk (infra/sip-bridge/setup.sh) is running and holds port 5060."
  echo "      The containerised bridge cannot start beside it. Once the container is"
  echo "      tested, stop the native one: systemctl disable --now asterisk"
fi

echo "==> Nightly backup timer"
sed "s#^ExecStart=.*#ExecStart=${HERE}/backup.sh#" systemd/ace-backup.service > /etc/systemd/system/ace-backup.service
cp systemd/ace-backup.timer /etc/systemd/system/ace-backup.timer
systemctl daemon-reload
systemctl enable --now ace-backup.timer
systemctl list-timers ace-backup.timer --no-pager | head -3

echo
echo "Server prepared. Next: fill in server.env, then ./deploy.sh (see README.md)."
