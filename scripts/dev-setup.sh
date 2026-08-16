#!/usr/bin/env bash
#
# One-command local setup.
#
#   ./scripts/dev-setup.sh
#
# Checks prerequisites, creates the database, applies the schema INCLUDING the
# constraint `prisma db push` cannot express, builds, and tells you what to run
# next. Safe to re-run — every step is idempotent.
#
# It deliberately does NOT start the servers. Those are two long-running
# processes that belong in your own terminals where you can see their logs.

set -uo pipefail
cd "$(dirname "$0")/.."

# Real escape characters, not the two-character sequence `\033` — printf would
# interpret those but the heredoc at the end of this script would print them
# literally.
BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'
DIM=$'\033[2m'; OFF=$'\033[0m'
ok()   { printf "${GREEN}  ✓${OFF} %s\n" "$1"; }
warn() { printf "${YELLOW}  !${OFF} %s\n" "$1"; }
die()  { printf "${RED}  ✗${OFF} %s\n" "$1"; exit 1; }

printf "\n${BOLD}Customer Care Agent — local setup${OFF}\n\n"

# ─── 1. Prerequisites ──────────────────────────────────────────────────────
command -v node >/dev/null || die "node is not installed. Node 20+ is required."
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge 20 ] || die "node $(node -v) is too old. Node 20+ is required."
ok "node $(node -v)"

command -v npm >/dev/null || die "npm is not installed."
ok "npm $(npm -v)"

if ! command -v psql >/dev/null; then
  die "psql is not installed. PostgreSQL 16 is required — the booking constraint needs the btree_gist extension that ships with it."
fi
ok "psql $(psql --version | awk '{print $3}')"

# ─── 2. Environment ────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  ok "created .env from .env.example"
  warn "if your PostgreSQL is not on localhost:5432 as user 'ace', edit DATABASE_URL and DIRECT_URL in .env now, then re-run this script"
else
  ok ".env already exists (left untouched)"
fi

# Read .env WITHOUT sourcing it. `. ./.env` executes the file as shell, so a
# password containing ( ) * ! $ or a space is a syntax error — and those are
# perfectly legal in a .env, which dotenv reads without complaint. Sourcing
# also runs anything in the file, which a credentials file has no business
# doing. Take each line as literal text instead.
read_env() {
  # usage: read_env KEY  → prints the value, or nothing
  sed -n "s/^[[:space:]]*\(export[[:space:]]\+\)\?$1=//p" .env \
    | tail -1 \
    | sed -e 's/\r$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

DATABASE_URL=$(read_env DATABASE_URL)
DIRECT_URL=$(read_env DIRECT_URL)
REDIS_URL=$(read_env REDIS_URL)
export DATABASE_URL DIRECT_URL REDIS_URL

[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is not set in .env"

# Loud, because this script runs `prisma db push`. The test harness and probes
# create real organizations through the real API — pointed at production once,
# they left 358 test organizations and ~13,900 contacts in the live CRM.
case "$DATABASE_URL" in
  *supabase.com*|*rds.amazonaws.com*|*neon.tech*|*render.com*)
    printf "${RED}  ✗${OFF} %s\n" "DATABASE_URL points at a hosted database:"
    printf "      %s\n" "$(printf '%s' "$DATABASE_URL" | sed 's|://[^@]*@|://***@|')"
    printf "      %s\n" "This script runs 'prisma db push'. Point .env at a LOCAL database first."
    printf "      %s\n" "Move the hosted one aside: mv .env .env.production.backup && cp .env.example .env"
    exit 1
    ;;
esac
# Prisma reads both: pooled for the app, direct for migrations. Locally they
# point at the same database, but neither may be missing.
[ -n "${DIRECT_URL:-}" ] || die "DIRECT_URL is not set in .env — Prisma needs it alongside DATABASE_URL (point both at the same database locally)"

# ─── 3. Database ───────────────────────────────────────────────────────────
# Parse the target database name out of the URL so we can create it if missing.
DB_NAME=$(node -p "try{new URL(process.env.DATABASE_URL).pathname.slice(1)}catch(e){''}")
ADMIN_URL=$(node -p "try{const u=new URL(process.env.DATABASE_URL);u.pathname='/postgres';u.toString()}catch(e){''}")
[ -n "$DB_NAME" ] || die "could not read a database name from DATABASE_URL"

if psql "$DATABASE_URL" -c 'SELECT 1' >/dev/null 2>&1; then
  ok "database '$DB_NAME' reachable"
elif psql "$ADMIN_URL" -c "CREATE DATABASE \"$DB_NAME\"" >/dev/null 2>&1; then
  ok "created database '$DB_NAME'"
else
  die "cannot reach PostgreSQL at DATABASE_URL, and could not create '$DB_NAME'. Check that the server is running and that the host, port and user in DATABASE_URL/DIRECT_URL in .env match it, then re-run this script."
fi

# ─── 4. Dependencies and build ─────────────────────────────────────────────
printf "\n${DIM}  installing dependencies (first run takes a few minutes)…${OFF}\n"
npm install --silent >/dev/null 2>&1 || die "npm install failed — run it directly to see why"
ok "dependencies installed"

# Generate the Prisma Client BEFORE building: apps/api imports the generated
# types, so a fresh clone cannot compile without it. Nothing else guarantees
# it runs — no package.json declares a `prisma` key, so @prisma/client's own
# postinstall cannot find this schema, and turbo may serve `build` from cache
# while node_modules holds no client at all. Cheap, so run it unconditionally.
printf "${DIM}  generating Prisma client…${OFF}\n"
npx prisma generate --schema=packages/database/prisma/schema.prisma >/dev/null 2>&1 \
  || die "prisma generate failed — run it directly to see why"
ok "Prisma client generated"

printf "${DIM}  building…${OFF}\n"
BUILD_LOG=$(mktemp -t cca-build.XXXXXX.log)
npx turbo run build >"$BUILD_LOG" 2>&1 || die "build failed — see $BUILD_LOG"
ok "build complete"

# ─── 5. Schema ─────────────────────────────────────────────────────────────
npx prisma db push --schema=packages/database/prisma/schema.prisma --skip-generate >/dev/null 2>&1 \
  || die "prisma db push failed — check DATABASE_URL and DIRECT_URL in .env"
ok "schema applied"

# `db push` cannot create an EXCLUDE constraint (Prisma has no syntax for it),
# so without this step two simultaneous bookings can still take one slot.
if psql "${DIRECT_URL:-$DATABASE_URL}" \
     -f packages/database/prisma/migrations/20260807020000_booking_overlap_constraint/migration.sql \
     >/dev/null 2>&1; then
  ok "double-booking constraint applied"
else
  warn "could not apply the booking constraint — concurrent double-booking is possible until it is"
fi

# ─── 6. Optional: Redis ────────────────────────────────────────────────────
# Three distinct states, and the middle one is the trap: REDIS_URL set with
# nothing listening means the BullMQ workers retry in a loop and flood the log.
if [ -z "${REDIS_URL:-}" ]; then
  ok "no REDIS_URL — single-pod mode: uploads index inline, workflows use the inline sweeper, rate limiting is in-memory"
elif command -v redis-cli >/dev/null && redis-cli -u "$REDIS_URL" ping >/dev/null 2>&1; then
  ok "Redis reachable — background jobs and cross-pod events enabled"
else
  warn "REDIS_URL is set in .env but nothing is listening there. Start Redis, or comment REDIS_URL out to run single-pod — otherwise the API logs a continuous stream of ECONNREFUSED from its queue workers."
fi

# ─── 7. What to do next ────────────────────────────────────────────────────
cat <<EOF

${BOLD}Setup complete. Start the two servers in separate terminals:${OFF}

  npm run dev

${DIM}That runs both: the API on :4000 and the dashboard on :3000, each
reloading on change. The API finds .env by itself — do not export it
into your shell first, a password containing ( ) * or ! will not
survive the round trip.

To run the production build instead of the dev servers:

  node apps/api/dist/main.js
  cd apps/web && npx next start -p 3000${OFF}

${BOLD}Then:${OFF}

  open http://localhost:3000          ${DIM}# register an account and sign in${OFF}
  npm run db:seed:gatekipa            ${DIM}# optional: demo tenant + widget key${OFF}
  npm run demo:readiness              ${DIM}# what works right now, per capability${OFF}
  npm run verify                      ${DIM}# every test layer${OFF}

${YELLOW}Remember:${OFF} do not run ${BOLD}npx turbo run build${OFF} while a web server is up.
${BOLD}next start${OFF} serves the build it booted with, and ${BOLD}next dev${OFF} shares the same
.next directory — either way the running server starts handing out chunk
URLs that 404, the page renders blank, and every test fails with
"element(s) not found" that reads exactly like a real regression.
Restart the web server after any build.

EOF
