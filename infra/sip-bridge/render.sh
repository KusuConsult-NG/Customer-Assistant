#!/usr/bin/env bash
# Renders the bridge's Asterisk configuration into a directory, from variables
# ALREADY in the environment (setup.sh reads them from bridge.env; the
# single-server container gets them from docker compose).
#   ./render.sh /etc/asterisk
# One implementation for both, so the native bridge and the container cannot
# drift apart in what they accept or how they fill the templates.
set -euo pipefail
cd "$(dirname "$0")"
out="${1:?usage: render.sh OUTPUT_DIR}"

if [ -z "${ALPHATECH_IP:-}" ] && [ -n "${ALPHATECH_HOST:-}" ]; then
  ALPHATECH_IP="$(getent ahostsv4 "$ALPHATECH_HOST" | awk 'NR==1{print $1}')"
fi
export ALPHATECH_IP
for v in ALPHATECH_HOST ALPHATECH_IP ALPHATECH_EXTENSION ALPHATECH_PASSWORD ELEVENLABS_SIP_HOST \
         ELEVENLABS_SIP_USERNAME ELEVENLABS_SIP_PASSWORD TOLLFREE_E164; do
  [ -n "${!v:-}" ] || { echo "bridge.env: $v is empty"; exit 1; }
done
[[ "$TOLLFREE_E164" =~ ^\+[0-9]{8,15}$ ]] || { echo "TOLLFREE_E164 must be E.164, e.g. +2348000000456"; exit 1; }
FALLBACK_SOUND="${FALLBACK_SOUND:-all-circuits-busy-now}"
INTRO_SOUND="${INTRO_SOUND:-}"
if [ -z "${PUBLIC_IP:-}" ]; then
  PUBLIC_IP="$(curl -fsS -4 --max-time 10 https://api.ipify.org || true)"
  [ -n "$PUBLIC_IP" ] || { echo "Could not detect the public IP; set PUBLIC_IP in bridge.env"; exit 1; }
fi
export PUBLIC_IP FALLBACK_SOUND INTRO_SOUND

echo "==> Rendering configuration (public IP ${PUBLIC_IP})"
VARS='${PUBLIC_IP} ${ALPHATECH_HOST} ${ALPHATECH_IP} ${ALPHATECH_EXTENSION} ${ALPHATECH_PASSWORD} ${ELEVENLABS_SIP_HOST} ${ELEVENLABS_SIP_USERNAME} ${ELEVENLABS_SIP_PASSWORD} ${TOLLFREE_E164} ${FALLBACK_SOUND} ${INTRO_SOUND}'
mkdir -p "$out"
for f in pjsip extensions rtp modules; do
  envsubst "$VARS" < "templates/${f}.conf.template" > "${out}/${f}.conf"
done
chmod 640 "${out}/pjsip.conf"
