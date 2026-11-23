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

# The server's own voice line. Off unless LOCAL_VOICE=1, and then only when the
# API answers "ok" for a call — see templates/extensions.conf.template.
LOCAL_VOICE="${LOCAL_VOICE:-0}"
LOCAL_VOICE_SECRET="${LOCAL_VOICE_SECRET:-}"
API_PORT="${API_PORT:-4000}"
AUDIOSOCKET_PORT="${AUDIOSOCKET_PORT:-9092}"
if [ "$LOCAL_VOICE" = "1" ]; then
  [ ${#LOCAL_VOICE_SECRET} -ge 24 ] || { echo "LOCAL_VOICE=1 needs LOCAL_VOICE_SECRET (24+ chars, the same value as the API's)"; exit 1; }
  [[ "$LOCAL_VOICE_SECRET" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "LOCAL_VOICE_SECRET: letters, digits, - and _ only (it is sent in a dialplan URL)"; exit 1; }
fi
# Recognising returning callers: the platform the bridge asks "who is calling?"
# before the agent answers. Empty SIP_BRIDGE_SECRET = no lookup (as before).
SIP_BRIDGE_SECRET="${SIP_BRIDGE_SECRET:-}"
BRIDGE_API_URL="${BRIDGE_API_URL:-http://127.0.0.1:${API_PORT}}"
BRIDGE_API_URL="${BRIDGE_API_URL%/}"
if [ -n "$SIP_BRIDGE_SECRET" ]; then
  [ ${#SIP_BRIDGE_SECRET} -ge 24 ] || { echo "SIP_BRIDGE_SECRET: 24+ characters, the same value as the API's"; exit 1; }
  [[ "$SIP_BRIDGE_SECRET" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "SIP_BRIDGE_SECRET: letters, digits, - and _ only (it is sent in a dialplan URL)"; exit 1; }
  [[ "$BRIDGE_API_URL" =~ ^https?://[^[:space:]]+$ ]] || { echo "BRIDGE_API_URL must be http(s)://host[:port]"; exit 1; }
fi
export LOCAL_VOICE LOCAL_VOICE_SECRET API_PORT AUDIOSOCKET_PORT SIP_BRIDGE_SECRET BRIDGE_API_URL

echo "==> Rendering configuration (public IP ${PUBLIC_IP})"
# EVERY ${...} a template uses must be listed: one left out is not filled in,
# and Asterisk reads the literal text (an empty secret check, an unknown URL).
VARS='${PUBLIC_IP} ${ALPHATECH_HOST} ${ALPHATECH_IP} ${ALPHATECH_EXTENSION} ${ALPHATECH_PASSWORD} ${ELEVENLABS_SIP_HOST} ${ELEVENLABS_SIP_USERNAME} ${ELEVENLABS_SIP_PASSWORD} ${TOLLFREE_E164} ${FALLBACK_SOUND} ${INTRO_SOUND} ${LOCAL_VOICE} ${LOCAL_VOICE_SECRET} ${API_PORT} ${AUDIOSOCKET_PORT} ${SIP_BRIDGE_SECRET} ${BRIDGE_API_URL}'
mkdir -p "$out"
for f in pjsip extensions rtp modules; do
  envsubst "$VARS" < "templates/${f}.conf.template" > "${out}/${f}.conf"
done
# Both hold secrets now (the SIP password; the bridge secrets in the dialplan).
chmod 640 "${out}/pjsip.conf" "${out}/extensions.conf"
