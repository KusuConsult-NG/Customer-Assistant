#!/usr/bin/env bash
# Install and configure the Alphatech → ElevenLabs SIP bridge on Ubuntu 22.04/24.04.
#   cp bridge.env.example bridge.env && nano bridge.env && sudo ./setup.sh
# Safe to re-run: it re-renders the config from bridge.env and restarts Asterisk.
set -euo pipefail
cd "$(dirname "$0")"

[ "$(id -u)" = 0 ] || { echo "Run as root: sudo ./setup.sh"; exit 1; }
[ -f bridge.env ] || { echo "Missing bridge.env — copy bridge.env.example and fill it in."; exit 1; }
chmod 600 bridge.env
# Read KEY=VALUE as TEXT, never `source` it: a password with ( ) ! $ or a
# space is legal in the file and a syntax error (or worse) when executed.
while IFS= read -r line || [ -n "$line" ]; do
  [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
  [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]] || { echo "bridge.env: cannot read line: $line"; exit 1; }
  val="${BASH_REMATCH[2]}"
  val="${val%\"}"; val="${val#\"}"
  export "${BASH_REMATCH[1]}=$val"
done < bridge.env

echo "==> Installing Asterisk"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq asterisk gettext-base ufw curl >/dev/null

# Validated and rendered by render.sh, which the single-server container uses too.
./render.sh /etc/asterisk
PUBLIC_IP="$(grep -m1 '^external_media_address' /etc/asterisk/pjsip.conf | awk '{print $3}')"
chown asterisk:asterisk /etc/asterisk/{pjsip,extensions,rtp,modules}.conf
chmod 640 /etc/asterisk/pjsip.conf

echo "==> Firewall: SSH, SIP 5060 (UDP+TCP), RTP 10000-20000/UDP"
ufw allow OpenSSH >/dev/null
ufw allow 5060/udp >/dev/null
ufw allow 5060/tcp >/dev/null
ufw allow 10000:20000/udp >/dev/null
ufw --force enable >/dev/null

echo "==> Restarting Asterisk"
systemctl enable asterisk >/dev/null 2>&1 || true
systemctl restart asterisk
sleep 8

echo "==> Status"
./check.sh || true
echo
echo "Next: in ElevenLabs, add ${PUBLIC_IP} to the phone number's inbound 'allowed addresses',"
echo "then call the toll-free number."
