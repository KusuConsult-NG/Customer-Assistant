#!/usr/bin/env bash
#
# Runs every verification layer the platform has, in dependency order, and
# prints one summary at the end. Layers that cannot run in the current
# environment are reported as SKIPPED with the reason — never silently passed.
#
#   ./scripts/verify-all.sh
#
# Prerequisites, by layer:
#   1. build            — none
#   2. package suites   — build (orchestrator suite also wants DATABASE_URL)
#   3. API integration  — a live PostgreSQL at DATABASE_URL
#   4. HTTP harness     — a live API at E2E_API_URL (default localhost:4000)
#   5. browser e2e      — a live API *and* web app (localhost:3000)
#
# Every layer is honest about third-party services: with no LLM key the AI
# paths degrade to curated FAQ answers and handoffs, and the suites assert
# that degradation rather than requiring paid credit.

set -uo pipefail
cd "$(dirname "$0")/.."

# Load .env so DATABASE_URL etc. are available, without overriding real env.
if [ -f .env ]; then
  while IFS= read -r line; do
    case "$line" in ''|\#*) continue ;; esac
    key="${line%%=*}"
    [ -z "${!key:-}" ] && export "$line"
  done < .env
fi

API_URL="${E2E_API_URL:-http://localhost:4000}"
WEB_URL="${PLAYWRIGHT_TEST_BASE_URL:-http://localhost:3000}"

PASS=(); FAIL=(); SKIP=()
pass() { PASS+=("$1"); printf '\033[32m  PASS\033[0m  %s\n' "$1"; }
fail() { FAIL+=("$1"); printf '\033[31m  FAIL\033[0m  %s\n' "$1"; }
skip() { SKIP+=("$1 — $2"); printf '\033[33m  SKIP\033[0m  %s \033[2m(%s)\033[0m\n' "$1" "$2"; }

echo
echo "── 1. Monorepo build ─────────────────────────────────────────────"
if npx turbo run build > /tmp/ace-verify-build.log 2>&1; then
  pass "build (11 workspaces)"
else
  fail "build — see /tmp/ace-verify-build.log"
  echo; echo "Build failed; later layers run against stale output. Stopping."
  exit 1
fi

echo
echo "── 2. Package unit suites ────────────────────────────────────────"
for suite in packages/*/test/run-test.js; do
  [ -e "$suite" ] || continue
  pkg=$(dirname "$(dirname "$suite")")
  if (cd "$pkg" && node test/run-test.js) > /tmp/ace-verify-pkg.log 2>&1; then
    pass "$(basename "$pkg")"
  else
    fail "$(basename "$pkg") — $(tail -3 /tmp/ace-verify-pkg.log | head -1)"
  fi
done

echo
echo "── 3. API integration suite (Jest) ───────────────────────────────"
if [ -z "${DATABASE_URL:-}" ]; then
  skip "jest integration" "DATABASE_URL not set"
elif ! node -e "
  const {PrismaClient}=require('./node_modules/@prisma/client');
  new PrismaClient().\$queryRaw\`SELECT 1\`.then(()=>process.exit(0)).catch(()=>process.exit(1));
" 2>/dev/null; then
  skip "jest integration" "database at DATABASE_URL unreachable"
else
  if (cd apps/api && npx jest --forceExit) > /tmp/ace-verify-jest.log 2>&1; then
    pass "jest — $(grep -oE 'Tests: +[0-9]+ passed' /tmp/ace-verify-jest.log | head -1)"
  else
    fail "jest — see /tmp/ace-verify-jest.log"
  fi
fi

echo
echo "── 4. HTTP validation harness ────────────────────────────────────"
if ! curl -sf -o /dev/null "$API_URL/api/health" 2>/dev/null; then
  skip "harness (274 checks)" "no API at $API_URL"
else
  if node e2e-validation/harness.js > /tmp/ace-verify-harness.log 2>&1; then
    pass "harness — $(grep -oE 'TOTAL [0-9]+ +PASS [0-9]+ +FAIL [0-9]+.*' /tmp/ace-verify-harness.log | head -1)"
  else
    fail "harness — $(grep -oE 'TOTAL.*' /tmp/ace-verify-harness.log | head -1)"
  fi
fi

echo
echo "── 5. Browser end-to-end (Playwright) ────────────────────────────"
if ! curl -sf -o /dev/null "$WEB_URL" 2>/dev/null; then
  skip "playwright" "no web app at $WEB_URL"
elif ! curl -sf -o /dev/null "$API_URL/api/health" 2>/dev/null; then
  skip "playwright" "no API at $API_URL"
elif
  # `next start` serves the build that existed when it booted. Step 1 rebuilt
  # the app, so a server started earlier now hands out chunk URLs that 404 —
  # the page shell loads, React never hydrates, and every test fails with
  # "element(s) not found" that looks exactly like a real regression.
  # Catch it here instead of paying for that debugging twice.
  chunk=$(curl -s "$WEB_URL/login" | grep -oE '/_next/static/chunks/[a-zA-Z0-9._-]+\.js' | head -1)
  [ -n "$chunk" ] && ! curl -sf -o /dev/null "$WEB_URL$chunk"
then
  skip "playwright" "web server is serving a stale build — restart 'next start' after the rebuild"
else
  PW_CONFIG=""
  [ -f apps/web/playwright.sandbox.config.ts ] && PW_CONFIG="--config=playwright.sandbox.config.ts"
  if (cd apps/web && npx playwright test $PW_CONFIG) > /tmp/ace-verify-pw.log 2>&1; then
    pass "playwright — $(grep -oE '[0-9]+ passed' /tmp/ace-verify-pw.log | tail -1)"
  else
    fail "playwright — see /tmp/ace-verify-pw.log"
  fi
fi

echo
echo "══════════════════════════════════════════════════════════════════"
printf '\033[1m%d passed · %d failed · %d skipped\033[0m\n' "${#PASS[@]}" "${#FAIL[@]}" "${#SKIP[@]}"
if [ "${#SKIP[@]}" -gt 0 ]; then
  echo
  echo "Skipped (NOT passed):"
  for s in "${SKIP[@]}"; do echo "  · $s"; done
fi
if [ "${#FAIL[@]}" -gt 0 ]; then
  echo
  echo "Failed:"
  for f in "${FAIL[@]}"; do echo "  · $f"; done
  exit 1
fi
