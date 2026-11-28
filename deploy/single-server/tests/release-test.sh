#!/usr/bin/env bash
# release.sh against a real Docker engine, with throwaway image names: a deploy
# tags what was running as :previous, a rollback puts it back, a rollback with
# nothing to go back to changes nothing, and every step is logged with its
# commit and image IDs. CI runs it on every change.
set -euo pipefail
cd "$(dirname "$0")/.."
T="$(mktemp -d)"
export RELEASE_IMAGES="drilltest-api drilltest-web" RELEASE_LOG="$T/releases.log" REPO_ROOT="$(cd ../.. && pwd)"
source ./release.sh
fail() { echo "FAIL: $*"; exit 1; }
id() { docker image inspect -f '{{.Id}}' "$1" 2>/dev/null || echo none; }
images_away() { for i in drilltest-api drilltest-web; do docker rmi -f "$i:latest" "$i:previous" > /dev/null 2>&1 || true; done; }
trap 'images_away; rm -rf "$T"' EXIT
images_away
docker pull -q busybox:1.36 > /dev/null; docker pull -q alpine:3.20 > /dev/null
OLD="$(id busybox:1.36)"; NEW="$(id alpine:3.20)"

# 1. Nothing deployed yet: a rollback refuses and changes nothing.
docker tag busybox:1.36 drilltest-api:latest
if restore_previous_images 2>/dev/null; then fail "rolled back with no :previous image"; fi
[ "$(id drilltest-api:latest)" = "$OLD" ] || fail "a refused rollback changed :latest"

# 2. A deploy: what runs is kept as :previous, the build replaces :latest.
docker tag busybox:1.36 drilltest-web:latest
[ "$(save_previous_images | tr '\n' ' ')" = "drilltest-api drilltest-web " ] || fail "did not tag both images"
docker tag alpine:3.20 drilltest-api:latest; docker tag alpine:3.20 drilltest-web:latest
record_release deployed > /dev/null
grep -q "deployed commit=[0-9a-f]\{12\}" "$RELEASE_LOG" || fail "release not logged with its commit: $(cat "$RELEASE_LOG")"
grep -q "drilltest-api=$(echo "$NEW" | cut -c8-19)" "$RELEASE_LOG" || fail "image ID not logged"

# 3. A rollback: the previous images are running again, and it is logged.
restore_previous_images || fail "rollback refused"
[ "$(id drilltest-api:latest)" = "$OLD" ] && [ "$(id drilltest-web:latest)" = "$OLD" ] || fail "rollback did not restore the previous images"
record_release rolled-back > /dev/null
[ "$(wc -l < "$RELEASE_LOG")" = 2 ] || fail "expected two log lines"
echo "PASS: deploy keeps :previous, rollback restores it, refuses with nothing to restore, every step logged"
