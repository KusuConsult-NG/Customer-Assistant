# Shared by the single-server scripts. Sourced, never run.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

die() { echo "ERROR: $*" >&2; exit 1; }
say() { echo "==> $*"; }

[ -f server.env ] || die "server.env is missing. cp server.env.example server.env, fill it in, chmod 600."
chmod 600 server.env

# Read one KEY from server.env as TEXT. Never `source` it: a password with
# ( ) ! $ or a space is legal there and a syntax error (or worse) when run.
env_get() {
  local line
  line="$(grep -E "^$1=" "${2:-server.env}" | tail -n1 || true)"
  printf '%s' "${line#*=}"
}

# The bridge runs only once its settings exist.
if [ -f ../../infra/sip-bridge/bridge.env ]; then export COMPOSE_PROFILES=bridge; fi

# The optional build CA (EXTRA_CA_CERT), where the build is allowed to read it.
extra_ca="$(grep -E '^EXTRA_CA_CERT=' server.env | tail -n1 | cut -d= -f2- || true)"
if [ -n "$extra_ca" ]; then
  [ -f "$extra_ca" ] || die "EXTRA_CA_CERT names $extra_ca, which does not exist."
  cp "$extra_ca" .extra-ca.pem
else
  : > .extra-ca.pem
fi

dc() { docker compose --env-file server.env -f docker-compose.yml "$@"; }

# Wait for a service's container to report healthy.
wait_healthy() {
  local svc="$1" tries="${2:-60}" id state
  for _ in $(seq "$tries"); do
    id="$(dc ps -q "$svc")"
    state="$( [ -n "$id" ] && docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" || echo missing)"
    [ "$state" = healthy ] && return 0
    sleep 3
  done
  die "$svc did not become healthy (last state: $state). See: docker compose --env-file server.env logs $svc"
}
