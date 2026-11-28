# Which release is running, and the one before it. Sourced by deploy.sh and
# rollback.sh, never run.
#
# Before a deploy builds, the images now running are tagged :previous, so
# rollback.sh can put them back in seconds without rebuilding old code. Every
# deploy and rollback is appended to releases.log with the git commit and the
# image IDs: the release being assessed is always identifiable.

RELEASE_IMAGES="${RELEASE_IMAGES:-ace-api ace-web ace-bridge}"
RELEASE_LOG="${RELEASE_LOG:-releases.log}"

release_commit() {
  local c
  c="$(git -C "${REPO_ROOT:-../..}" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
  if [ -n "$(git -C "${REPO_ROOT:-../..}" status --porcelain --untracked-files=no 2>/dev/null)" ]; then c="$c+uncommitted"; fi
  echo "$c"
}

image_id() { docker image inspect -f '{{.Id}}' "$1" 2>/dev/null | cut -c8-19 || true; }

# Tag what is running now as :previous. Prints the images it tagged.
save_previous_images() {
  local img
  for img in $RELEASE_IMAGES; do
    if docker image inspect "$img:latest" > /dev/null 2>&1; then
      docker tag "$img:latest" "$img:previous"
      echo "$img"
    fi
  done
}

# Put :previous back as :latest. Fails, changing nothing, if any image has no :previous.
restore_previous_images() {
  local img
  for img in $RELEASE_IMAGES; do
    docker image inspect "$img:latest" > /dev/null 2>&1 || continue
    docker image inspect "$img:previous" > /dev/null 2>&1 || { echo "ERROR: $img has no :previous image to roll back to" >&2; return 1; }
  done
  for img in $RELEASE_IMAGES; do
    docker image inspect "$img:previous" > /dev/null 2>&1 && docker tag "$img:previous" "$img:latest"
  done
  return 0
}

# Append one line: when, what happened, the commit, and each image's ID.
record_release() {
  local what="$1" line img
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) $what commit=$(release_commit)"
  for img in $RELEASE_IMAGES; do line="$line $img=$(image_id "$img:latest")"; done
  echo "$line" >> "$RELEASE_LOG"
  echo "$line"
}
