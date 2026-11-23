#!/usr/bin/env bash
# Deploy a new version:
#   sudo ./update.sh [git-ref]   fetch from git (default: the current branch's latest)
#   sudo ./update.sh --local     build what is already in /srv/ace/app — for a
#                                server that cannot reach GitHub, after the code
#                                was copied in (rsync/scp of a release)
# Backs up first, builds, updates the schema, restarts. A failed build leaves
# the running version untouched.
set -euo pipefail
cd "$(dirname "$0")"
. ./lib.sh
[ "$(id -u)" = 0 ] || die "Run as root."
APP_DIR="$ACE_HOME/app"
./backup.sh
ref="${1:-}"
LOCAL=0; [ "$ref" = "--local" ] && { LOCAL=1; ref=""; }
chown -R ace:ace "$APP_DIR"
runuser -u ace -- env HOME="$ACE_HOME" bash -c "
  set -euo pipefail
  cd '$APP_DIR'
  if [ '$LOCAL' = 0 ]; then
    git fetch --quiet origin
    if [ -n '$ref' ]; then git checkout --quiet '$ref'; fi
    # A tag or commit checked out above has no branch to pull.
    if git symbolic-ref -q HEAD >/dev/null; then git pull --quiet --ff-only; fi
  fi
  git log -1 --format='Deploying %h %s' 2>/dev/null || echo 'Deploying the copied code'
  # A stale tsc build cache with no dist/ beside it builds nothing and reports success.
  find packages apps -maxdepth 2 -name '*.tsbuildinfo' -delete
  npm ci --include=dev --no-audit --no-fund
  DATABASE_URL=postgresql://x@localhost/x DIRECT_URL=postgresql://x@localhost/x npx prisma generate --schema=packages/database/prisma/schema.prisma
  npx turbo run build --force --filter=@ace/api...
  NEXT_PUBLIC_API_URL=same-origin npx turbo run build --force --filter=@ace/web...
"
./schema.sh
# The dashboard serves the build that existed when it started: restart BOTH,
# or browsers get chunk URLs that 404 and pages never load.
systemctl restart ace-api ace-web
sleep 5
./check.sh
