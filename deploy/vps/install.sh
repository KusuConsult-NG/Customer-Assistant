#!/usr/bin/env bash
# The whole platform on ONE Ubuntu 22.04/24.04 server:
#   PostgreSQL, Redis, Qdrant, Node 20 (API + dashboard), Caddy (HTTPS).
# Asterisk (the phone bridge) is installed by infra/sip-bridge/setup.sh — run it
# after this; this script gives it CPU priority if it is already there.
#
#   git clone <repo> /srv/ace/app && cd /srv/ace/app/deploy/vps
#   cp deploy.env.example deploy.env && nano deploy.env && sudo ./install.sh
#
# Safe to re-run: secrets it generated are kept (/etc/ace/generated.env), the
# database is never dropped, and every config file is re-rendered.
#
# Options:  --skip-build  (config and services only; for re-runs)
set -euo pipefail
cd "$(dirname "$0")"
KIT_DIR="$(pwd)"
APP_DIR="$(cd ../.. && pwd)"
# shellcheck source=lib.sh
. ./lib.sh

SKIP_BUILD=0
for a in "$@"; do [ "$a" = "--skip-build" ] && SKIP_BUILD=1; done

[ "$(id -u)" = 0 ] || die "Run as root: sudo ./install.sh"
[ -f deploy.env ] || die "Missing deploy.env — copy deploy.env.example and fill it in."
chmod 600 deploy.env
read_env_file deploy.env
. /etc/os-release
[[ "${VERSION_ID:-}" =~ ^(22\.04|24\.04)$ ]] || die "Ubuntu 22.04 or 24.04 required (found ${PRETTY_NAME:-unknown})."
[ "$APP_DIR" = "$ACE_HOME/app" ] || die "Clone the repository to $ACE_HOME/app (this copy is at $APP_DIR)."

for v in DOMAIN ACME_EMAIL ENCRYPTION_KEY JWT_SECRET JWT_REFRESH_SECRET OPENAI_API_KEY WHATSAPP_APP_SECRET WHATSAPP_VERIFY_TOKEN; do
  [ -n "${!v:-}" ] || die "deploy.env: $v is empty"
done
[[ "$DOMAIN" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || die "DOMAIN must be a bare host name, e.g. contact.example.gov.ng"
[ "$(printf %s "$ENCRYPTION_KEY" | base64 -d 2>/dev/null | wc -c)" = 32 ] \
  || die "ENCRYPTION_KEY must be the production key (base64 of 32 bytes). A new one makes every stored credential unreadable."
PG_VERSION="${PG_VERSION:-17}"
QDRANT_VERSION="${QDRANT_VERSION:-v1.13.6}"
SSH_PORT="${SSH_PORT:-22}"

export DEBIAN_FRONTEND=noninteractive
mkdir -p /etc/ace && chmod 700 /etc/ace
touch /etc/ace/generated.env && chmod 600 /etc/ace/generated.env

say "Base packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg lsb-release gettext-base ufw openssl rsync tar jq >/dev/null

say "Firewall: SSH, HTTP(S), SIP and RTP only — the database, Redis, Qdrant and the app ports stay private"
ufw allow "${SSH_PORT}/tcp" >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw allow 5060/udp >/dev/null
ufw allow 5060/tcp >/dev/null
ufw allow 10000:20000/udp >/dev/null
ufw --force enable >/dev/null

say "PostgreSQL ${PG_VERSION}"
install -d /usr/share/postgresql-common/pgdg
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list

say "Node.js 20"
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/nodesource.gpg
echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list

say "Caddy"
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list

apt-get update -qq
apt-get install -y -qq "postgresql-${PG_VERSION}" "postgresql-client-${PG_VERSION}" redis-server nodejs caddy >/dev/null
node -v | grep -q '^v20\.' || die "Node 20 was not installed (found $(node -v))."

say "Qdrant ${QDRANT_VERSION}"
if ! /usr/local/bin/qdrant --version 2>/dev/null | grep -q "${QDRANT_VERSION#v}"; then
  tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/qdrant/qdrant/releases/download/${QDRANT_VERSION}/qdrant-x86_64-unknown-linux-gnu.tar.gz" -o "$tmp/q.tgz"
  tar -xzf "$tmp/q.tgz" -C "$tmp"
  install -m 755 "$tmp/qdrant" /usr/local/bin/qdrant
  rm -rf -- "$tmp"
fi
id qdrant >/dev/null 2>&1 || useradd --system --home /var/lib/qdrant --shell /usr/sbin/nologin qdrant
install -d -o qdrant -g qdrant -m 750 /var/lib/qdrant /var/lib/qdrant/storage /var/lib/qdrant/snapshots
install -d -m 755 /etc/qdrant

say "Secrets this server generates for itself (kept in /etc/ace/generated.env)"
keep_secret POSTGRES_PASSWORD 24
keep_secret REDIS_PASSWORD 24
keep_secret QDRANT_API_KEY 24
keep_secret LOCAL_VOICE_SECRET 24
keep_secret STORAGE_LINK_SECRET 32

export QDRANT_API_KEY REDIS_PASSWORD
envsubst '${QDRANT_API_KEY}' < templates/qdrant.yaml > /etc/qdrant/config.yaml
chown root:qdrant /etc/qdrant/config.yaml && chmod 640 /etc/qdrant/config.yaml
install -m 644 templates/qdrant.service /etc/systemd/system/qdrant.service

say "Redis: local only, password, no eviction (BullMQ)"
REDIS_CONF=/etc/redis/redis.conf
sed -i '/^# >>> ace$/,/^# <<< ace$/d' "$REDIS_CONF"
{ echo '# >>> ace'; envsubst '${REDIS_PASSWORD}' < templates/redis.conf; echo '# <<< ace'; } >> "$REDIS_CONF"
chmod 640 "$REDIS_CONF"

say "PostgreSQL: role and database 'ace' (never dropped on a re-run)"
systemctl enable --now postgresql >/dev/null 2>&1
runuser -u postgres -- psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ace') THEN
    CREATE ROLE ace LOGIN PASSWORD '${POSTGRES_PASSWORD}';
  ELSE
    ALTER ROLE ace PASSWORD '${POSTGRES_PASSWORD}';
  END IF;
END \$\$;
SQL
runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='ace'" | grep -q 1 \
  || runuser -u postgres -- createdb -O ace ace
# Extensions the schema needs; created by the superuser so `ace` need not be one.
runuser -u postgres -- psql -d ace -q -c 'CREATE EXTENSION IF NOT EXISTS btree_gist; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS "uuid-ossp";'

say "The app user and its directories"
id ace >/dev/null 2>&1 || useradd --system --home "$ACE_HOME" --shell /usr/sbin/nologin ace
install -d -o ace -g ace -m 750 "$ACE_HOME/storage" "$ACE_HOME/tts-cache"
install -d -o root -g root -m 700 "$ACE_HOME/backups"
chown -R ace:ace "$APP_DIR"

say "Application settings (/etc/ace/ace.env)"
DB_URL="postgresql://ace:${POSTGRES_PASSWORD}@127.0.0.1:5432/ace?connection_limit=20"
{
  echo "# Generated by deploy/vps/install.sh from deploy.env — edit deploy.env and re-run."
  echo "NODE_ENV=production"
  echo "PORT=4000"
  echo "DATABASE_URL=${DB_URL}"
  echo "DIRECT_URL=${DB_URL}"
  echo "REDIS_URL=redis://:${REDIS_PASSWORD}@127.0.0.1:6379"
  echo "QDRANT_URL=http://127.0.0.1:6333"
  echo "QDRANT_API_KEY=${QDRANT_API_KEY}"
  echo "API_BASE_URL=https://${DOMAIN}"
  echo "WEB_BASE_URL=https://${DOMAIN}"
  echo "CORS_ORIGIN=https://${DOMAIN}"
  echo "WEB_INTERNAL_URL=http://127.0.0.1:3000"
  echo "TRUST_PROXY=1"
  echo "STORAGE_DIR=${ACE_HOME}/storage"
  echo "STORAGE_LINK_SECRET=${STORAGE_LINK_SECRET}"
  echo "VOICE_CACHE_DIR=${ACE_HOME}/tts-cache"
  echo "LOCAL_VOICE_SECRET=${LOCAL_VOICE_SECRET}"
  echo "AUDIOSOCKET_PORT=9092"
  # Everything else from deploy.env, as given (empty values dropped, so an
  # unset optional stays unset rather than becoming "").
  env_pairs deploy.env | grep -vE '^[A-Z_0-9]+=$' \
    | grep -vE '^(NODE_ENV|PORT|DATABASE_URL|DIRECT_URL|REDIS_URL|QDRANT_URL|QDRANT_API_KEY|API_BASE_URL|WEB_BASE_URL|CORS_ORIGIN|STORAGE_DIR|STORAGE_LINK_SECRET|VOICE_CACHE_DIR|LOCAL_VOICE_SECRET)='
} > "$ACE_ENV.new"
chown root:ace "$ACE_ENV.new" && chmod 640 "$ACE_ENV.new" && mv "$ACE_ENV.new" "$ACE_ENV"
grep -q '^SUPABASE_URL=' "$ACE_ENV" && die "deploy.env sets SUPABASE_URL: files would go to Supabase, not this server. Remove it (the migration script reads SOURCE_SUPABASE_URL)."

systemctl daemon-reload
systemctl enable --now redis-server qdrant >/dev/null 2>&1
systemctl restart redis-server qdrant

if [ "$SKIP_BUILD" = 0 ]; then
  say "Build (npm ci, prisma generate, API and dashboard) — several minutes"
  runuser -u ace -- env HOME="$ACE_HOME" bash -c "
    set -euo pipefail
    cd '$APP_DIR'
    # A stale tsc build cache with no dist/ beside it builds NOTHING and
    # reports success; the API then fails to compile against empty packages.
    find packages apps -maxdepth 2 -name '*.tsbuildinfo' -delete
    npm ci --include=dev --no-audit --no-fund
    DATABASE_URL='$DB_URL' DIRECT_URL='$DB_URL' npx prisma generate --schema=packages/database/prisma/schema.prisma
    npx turbo run build --force --filter=@ace/api...
    NEXT_PUBLIC_API_URL=same-origin npx turbo run build --force --filter=@ace/web...
  "
fi

say "Database schema (prisma db push) and the SQL-only constraints"
"$KIT_DIR/schema.sh"

say "Services"
export ACE_HOME
for unit in ace-api ace-web; do
  envsubst '${ACE_HOME}' < "templates/${unit}.service" > "/etc/systemd/system/${unit}.service"
done
install -d /etc/systemd/system/asterisk.service.d
install -m 644 templates/asterisk-priority.conf /etc/systemd/system/asterisk.service.d/priority.conf
export DOMAIN ACME_EMAIL
envsubst '${DOMAIN} ${ACME_EMAIL}' < templates/Caddyfile.template > /etc/caddy/Caddyfile
install -d -o caddy -g caddy /var/log/caddy
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
# validate runs as root and creates the log file as root; the service runs as
# caddy and then cannot open it, so Caddy refuses to start. Hand it back.
chown -R caddy:caddy /var/log/caddy
systemctl daemon-reload
systemctl enable ace-api ace-web caddy >/dev/null 2>&1
systemctl restart ace-api ace-web
systemctl reload caddy 2>/dev/null || systemctl restart caddy
systemctl is-active --quiet asterisk 2>/dev/null && systemctl restart asterisk || true

say "Nightly backup (02:30): database + uploaded files + recordings, kept ${BACKUP_KEEP_DAYS:-14} days"
cat > /etc/cron.d/ace-backup <<CRON
30 2 * * * root ${KIT_DIR}/backup.sh >> /var/log/ace-backup.log 2>&1
CRON
chmod 644 /etc/cron.d/ace-backup

say "Checking"
"$KIT_DIR/check.sh" || true
cat <<NEXT

Next:
  1. Data:   sudo ./migrate-from-supabase.sh          (reports first; --apply copies)
  2. Phone:  cd ../../infra/sip-bridge && set LOCAL_VOICE_SECRET in bridge.env to
             the value from: sudo grep LOCAL_VOICE_SECRET /etc/ace/generated.env
             then sudo ./setup.sh
  3. Cutover steps: README.md, "Moving production".
NEXT
