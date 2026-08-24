#!/usr/bin/env bash
#
# SessionStart hook — Customer Care Agent
#
# A Claude Code on the web session starts from a fresh clone: no node_modules,
# no Prisma client, no build output, no .env, and no database server running.
# Every debugging task therefore began by rebuilding all of that by hand out of
# CLAUDE.md — which is where the session time was going, before any actual bug
# had been looked at. This does it once, the same way CI does it, and leaves the
# container in a state where `npm run verify` can run against a real PostgreSQL.
#
# Three properties, in the repo's own style:
#   - Idempotent. Every step is safe to re-run; the second run is nearly free.
#   - Non-interactive. Nothing prompts, nothing waits on a human.
#   - Honest. A layer that cannot come up is reported as degraded, never silently
#     passed over, because a session that believes it has a database and does not
#     produces test failures that read exactly like real regressions.
#
# It always exits 0. A hook that fails the session start leaves no session in
# which to fix the hook.

set -uo pipefail

# Local machines have their own PostgreSQL, their own .env and their own
# opinions about both. Only the disposable web container gets provisioned.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}" || exit 0

LOG_DIR="${TMPDIR:-/tmp}/cca-session-start"
mkdir -p "$LOG_DIR"
STATUS_FILE="$LOG_DIR/STATUS"

# ─── 0. Detach ──────────────────────────────────────────────────────────────
# This MUST be the first thing written to stdout: it is the control message
# that tells the harness to start the session now and let the rest of this
# script keep running behind it. Everything below therefore races the agent
# loop — `npx jest` fired while `prisma db push` is still in flight fails in
# ways that read exactly like a real regression, which is the whole reason
# wait-for-ready.sh next to this file exists. Put it in front of anything that
# touches the database or dist/.
printf '{"async": true, "asyncTimeout": 900000}\n'

# Written before any work, so a session that starts mid-provision cannot read a
# stale "ready" left by an earlier container and run its tests against half a
# database.
printf 'provisioning\n' > "$STATUS_FILE"
printf '%s\n' "$$" > "$LOG_DIR/PID"

# The PID above, not this trap, is what makes a dead hook detectable. Killing
# this script mid-run was tested: bash blocked in a foreground child (npm
# install) does NOT run the trap on SIGTERM, and SIGKILL cannot run one at all,
# so the marker was left reading "provisioning" and every wait sat out its full
# timeout reporting a hang where there had been a failure. wait-for-ready.sh
# therefore checks the process is still alive rather than trusting this to
# report its own death. The trap stays for the case it does cover — an
# unexpected exit, e.g. `set -u` on an unset variable — and the grep guard
# keeps it from overwriting an outcome already written.
trap 'grep -qx provisioning "$STATUS_FILE" 2>/dev/null && printf "failed\n" > "$STATUS_FILE"' EXIT INT TERM

READY=(); MISSING=()
ok()   { READY+=("$1");  printf '  \033[32m*\033[0m %s\n' "$1"; }
miss() { MISSING+=("$1"); printf '  \033[33m!\033[0m %s\n' "$1"; }

printf '\n\033[1mCustomer Care Agent — provisioning web session\033[0m\n\n'

# ─── 1. Environment file ────────────────────────────────────────────────────
# Startup validation (env.validation.ts) hard-fails the boot on a missing
# required var and rejects any value containing the word "placeholder", so the
# dummies below are deliberately real-looking. None of them authenticates
# anything: with no LLM credit the AI paths degrade to curated FAQ answers and
# handoffs, and the suites assert that degradation rather than requiring paid
# credit. ENCRYPTION_KEY is the same throwaway CI uses — storing a tenant
# credential is REFUSED rather than written in the clear when it is unset, so
# those paths cannot be exercised without one.
DB_URL='postgresql://ace:ace@127.0.0.1:5432/ace_dev'
REDIS_URL='redis://127.0.0.1:6379'

if [ ! -f .env ]; then
  DB_URL="$DB_URL" REDIS_URL="$REDIS_URL" node -e '
const fs = require("fs");
const overrides = {
  DATABASE_URL: process.env.DB_URL,
  DIRECT_URL: process.env.DB_URL,
  REDIS_URL: process.env.REDIS_URL,
  JWT_SECRET: "web_session_jwt_signing_secret_0123456789abcdef",
  JWT_REFRESH_SECRET: "web_session_refresh_signing_secret_0123456789ab",
  OPENAI_API_KEY: "sk-web-session-no-credit-0000000000000000",
  WHATSAPP_APP_SECRET: "web_session_meta_app_secret",
  WHATSAPP_VERIFY_TOKEN: "web_session_meta_verify_token",
  ENCRYPTION_KEY: "Y2lfb25seV9lbmNyeXB0aW9uX2tleV8zMmJ5dGVzISE=",
  API_BASE_URL: "http://localhost:4000",
  WEB_BASE_URL: "http://localhost:3000",
};
const seen = new Set();
const lines = fs.readFileSync(".env.example", "utf8").split("\n").map((line) => {
  const m = /^[ \t]*(?:export[ \t]+)?([A-Z0-9_]+)=/.exec(line);
  if (!m || !(m[1] in overrides)) return line;
  seen.add(m[1]);
  return m[1] + "=" + overrides[m[1]];
});
for (const k of Object.keys(overrides)) if (!seen.has(k)) lines.push(k + "=" + overrides[k]);
fs.writeFileSync(".env", lines.join("\n"));
'
  if [ -f .env ]; then
    ok "wrote .env (local dummies — no value here authenticates anything)"
  else
    miss ".env could not be written"
  fi
else
  ok ".env already present (left untouched)"
fi

# Read .env as TEXT. Sourcing it executes it, so a value containing ( ) * ! or a
# space — all legal, and all read fine by dotenv — becomes a syntax error.
read_env() {
  sed -n "s/^[[:space:]]*\(export[[:space:]]\+\)\?$1=//p" .env 2>/dev/null \
    | tail -1 | sed -e 's/\r$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}
DATABASE_URL=$(read_env DATABASE_URL)
DIRECT_URL=$(read_env DIRECT_URL)
REDIS_URL=$(read_env REDIS_URL)
export DATABASE_URL DIRECT_URL REDIS_URL

# This hook runs `prisma db push`, and the harness and probes create real
# organizations through the real API. Pointed at production once, they left 358
# test organizations and ~13,900 contacts in the live CRM. Refuse to touch a
# database that is not local, and say so rather than skipping quietly.
LOCAL_DB=1
case "$DATABASE_URL" in
  *localhost*|*127.0.0.1*) ;;
  *) LOCAL_DB=0 ;;
esac

# ─── 2. Dependencies ────────────────────────────────────────────────────────
if npm install --no-audit --no-fund > "$LOG_DIR/install.log" 2>&1; then
  ok "npm workspaces installed"
else
  miss "npm install failed — see $LOG_DIR/install.log"
fi

# Generate the Prisma Client BEFORE building: apps/api imports the generated
# types, so a fresh clone cannot compile without it. Nothing else guarantees it
# runs — no package.json declares a `prisma` key, so @prisma/client's own
# postinstall cannot find this schema, and turbo may serve `build` from cache
# while node_modules holds no client at all.
if npx prisma generate --schema=packages/database/prisma/schema.prisma > "$LOG_DIR/generate.log" 2>&1; then
  ok "Prisma client generated"
else
  miss "prisma generate failed — see $LOG_DIR/generate.log"
fi

# ─── 3. PostgreSQL ──────────────────────────────────────────────────────────
# PostgreSQL refuses to run as root and this container is root, so the cluster
# is driven through the postgres user. It ships with the image but starts down.
pg_ready() { pg_isready -h 127.0.0.1 -p 5432 -q 2>/dev/null; }

if [ "$LOCAL_DB" = "0" ]; then
  miss "DATABASE_URL is not local — PostgreSQL left alone and no schema pushed"
elif ! command -v psql >/dev/null 2>&1; then
  miss "psql not installed — the DB-backed layers will SKIP"
  LOCAL_DB=0
else
  if ! pg_ready; then
    pg_ctlcluster 16 main start > "$LOG_DIR/pg.log" 2>&1
    for _ in $(seq 1 20); do pg_ready && break; sleep 0.5; done
  fi

  if ! pg_ready; then
    miss "PostgreSQL would not start — see $LOG_DIR/pg.log"
    LOCAL_DB=0
  else
    # SUPERUSER because the booking constraint needs `CREATE EXTENSION
    # btree_gist`, which an unprivileged role cannot do. This database holds
    # nothing but throwaway test rows.
    su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='ace'\"" 2>/dev/null | grep -q 1 \
      || su postgres -c "psql -qc \"CREATE ROLE ace LOGIN SUPERUSER PASSWORD 'ace'\"" >/dev/null 2>&1
    su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='ace_dev'\"" 2>/dev/null | grep -q 1 \
      || su postgres -c "psql -qc 'CREATE DATABASE ace_dev OWNER ace'" >/dev/null 2>&1

    if psql "$DATABASE_URL" -c 'SELECT 1' >/dev/null 2>&1; then
      ok "PostgreSQL 16 up — ace_dev reachable"
    else
      miss "PostgreSQL is up but ace_dev is not reachable at DATABASE_URL"
      LOCAL_DB=0
    fi
  fi
fi

# ─── 4. Schema ──────────────────────────────────────────────────────────────
if [ "$LOCAL_DB" = "1" ]; then
  if npx prisma db push --schema=packages/database/prisma/schema.prisma --skip-generate \
       > "$LOG_DIR/dbpush.log" 2>&1; then
    ok "schema applied (prisma db push)"
  else
    miss "prisma db push failed — see $LOG_DIR/dbpush.log"
  fi

  # `db push` cannot create an EXCLUDE constraint — Prisma has no syntax for it —
  # so without this two simultaneous bookings still take one slot. Selected by
  # CONTENT rather than by name, exactly as CI does, so a future EXCLUDE
  # migration is picked up without anyone remembering to edit this file.
  #
  # NOT the whole migrations directory: the rest are hand-written schema changes
  # for databases that predate them, and on a fresh database `db push` has
  # already created all of it, so re-running them collides outright.
  applied=0; failed=0
  for m in $(grep -l 'EXCLUDE USING' packages/database/prisma/migrations/*/migration.sql 2>/dev/null | sort); do
    if psql "${DIRECT_URL:-$DATABASE_URL}" -q -v ON_ERROR_STOP=1 -f "$m" >> "$LOG_DIR/exclude.log" 2>&1; then
      applied=$((applied + 1))
    else
      failed=$((failed + 1))
    fi
  done
  if [ "$failed" != "0" ]; then
    miss "an EXCLUDE migration failed — concurrent double-booking is possible; see $LOG_DIR/exclude.log"
  elif [ "$applied" = "0" ]; then
    miss "no EXCLUDE migrations found — did they move?"
  else
    ok "double-booking constraint applied ($applied EXCLUDE migration(s))"
  fi
fi

# ─── 5. Redis ───────────────────────────────────────────────────────────────
# Three states, and the middle one is the trap: REDIS_URL set with nothing
# listening means the BullMQ workers retry in a loop and flood the log.
if [ -z "${REDIS_URL:-}" ]; then
  ok "no REDIS_URL — single-pod mode (inline indexing, inline sweeper, in-memory rate limiting)"
elif redis-cli -u "$REDIS_URL" ping >/dev/null 2>&1; then
  ok "Redis reachable"
elif command -v redis-server >/dev/null 2>&1; then
  redis-server --daemonize yes --save '' --appendonly no > "$LOG_DIR/redis.log" 2>&1
  for _ in $(seq 1 10); do redis-cli -u "$REDIS_URL" ping >/dev/null 2>&1 && break; sleep 0.5; done
  if redis-cli -u "$REDIS_URL" ping >/dev/null 2>&1; then
    ok "Redis started — BullMQ ingestion, cross-pod Socket.IO and Redis rate limiting enabled"
  else
    miss "REDIS_URL is set but Redis would not start — the API will log continuous ECONNREFUSED"
  fi
else
  miss "REDIS_URL is set but redis-server is not installed — comment it out to run single-pod"
fi

# ─── 6. Build ───────────────────────────────────────────────────────────────
# The package unit suites run against dist/, not src/, so the build is a
# prerequisite for the test layer rather than an optimisation. Turbo caches it,
# so re-runs cost seconds.
if npx turbo run build > "$LOG_DIR/build.log" 2>&1; then
  ok "monorepo built"
else
  miss "build failed — see $LOG_DIR/build.log"
fi

# ─── 7. Hand the session its environment ────────────────────────────────────
# The API and verify-all.sh read .env themselves, but the package suites and any
# ad-hoc `node -e` do not — they read the shell. Without this, `cd
# packages/orchestrator && node test/run-test.js` fails for want of DATABASE_URL
# and looks like a broken suite rather than a missing variable.
if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -f .env ]; then
  while IFS= read -r line; do
    case "$line" in ''|\#*) continue ;; esac
    case "$line" in *=*) printf 'export %s\n' "$line" ;; esac
  done < .env >> "$CLAUDE_ENV_FILE" 2>/dev/null && ok "session environment exported"
fi

# ─── Summary ────────────────────────────────────────────────────────────────
printf '\n\033[1m  %d ready\033[0m' "${#READY[@]}"
if [ "${#MISSING[@]}" -gt 0 ]; then
  printf ', \033[33m%d degraded\033[0m\n' "${#MISSING[@]}"
  for m in "${MISSING[@]}"; do printf '    - %s\n' "$m"; done
else
  printf '\n'
fi

cat <<'NEXT'

  Ready to run without further setup:
    npm run verify              every test layer (missing prerequisites SKIP)
    npm run test:packages       jest package suites
    cd apps/api && npx jest --forceExit
    npm run demo:readiness      what works right now, per capability

  Restart `next start` after any rebuild — it serves the build it booted with,
  and stale chunk URLs 404 into test failures that read like real regressions.

NEXT

# Released last, and only now: this is what wait-for-ready.sh is blocking on,
# so writing it any earlier would hand the session a database that is still
# being built. Degraded is not failed — the layers that came up are usable, and
# naming the ones that did not is what stops the next hour being spent on a
# missing service that looks like a bug in the code.
if [ "${#MISSING[@]}" -gt 0 ]; then
  {
    printf 'degraded\n'
    for m in "${MISSING[@]}"; do printf -- '  - %s\n' "$m"; done
  } > "$STATUS_FILE"
else
  printf 'ready\n' > "$STATUS_FILE"
fi

exit 0
