#!/usr/bin/env bash
#
# Block until the SessionStart hook has finished provisioning.
#
# session-start.sh runs async: the session starts immediately and the stack is
# built behind it. That is faster, and it means the agent loop races the hook —
# `npx jest` fired while `prisma db push` is still in flight, or a package suite
# run before `turbo run build` has written dist/, fails in ways that read
# exactly like a real regression. Put this in front of anything that touches the
# database, Redis or dist/:
#
#   ./.claude/hooks/wait-for-ready.sh && npm run verify
#
# Exit codes:
#   0  provisioning finished — ready, or degraded with the gaps printed
#   1  provisioning failed
#   2  still provisioning after the timeout (default 900s, override with $1)
#
# Degraded exits 0 on purpose. The layers that came up are usable, and a session
# blocked outright because Redis did not start could still have debugged
# everything that does not need Redis.

set -uo pipefail

# The hook does not run off the web container, so there is nothing to wait for
# and blocking would hang a local shell forever.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

LOG_DIR="${TMPDIR:-/tmp}/cca-session-start"
STATUS_FILE="$LOG_DIR/STATUS"
PID_FILE="$LOG_DIR/PID"
TIMEOUT="${1:-900}"

state() { [ -f "$STATUS_FILE" ] && head -1 "$STATUS_FILE" 2>/dev/null || printf 'provisioning\n'; }

# A hook that was killed cannot report its own death: bash blocked in a
# foreground child does not run its EXIT/TERM trap, and SIGKILL runs nothing at
# all, so the marker is left reading "provisioning" and looks identical to work
# still in progress. Ask the operating system instead. Only meaningful once the
# hook has recorded a pid — before that there is nothing yet to have died.
hook_alive() {
  [ -f "$PID_FILE" ] || return 0
  kill -0 "$(head -1 "$PID_FILE")" 2>/dev/null
}

waited=0
while [ "$(state)" = "provisioning" ]; do
  if ! hook_alive; then
    # It may have finished in the gap between the two checks — writing the
    # outcome is the last thing it does before exiting, so the process is gone a
    # moment after the marker is good. Re-read before calling it a failure.
    [ "$(state)" != "provisioning" ] && break
    printf 'session-start: the hook exited without finishing — logs in %s\n' "$LOG_DIR" >&2
    exit 1
  fi
  if [ "$waited" -ge "$TIMEOUT" ]; then
    printf 'session-start: still provisioning after %ss — logs in %s\n' "$TIMEOUT" "$LOG_DIR" >&2
    exit 2
  fi
  sleep 2
  waited=$((waited + 2))
done

case "$(state)" in
  ready)
    printf 'session-start: ready\n'
    ;;
  degraded)
    printf 'session-start: ready, with gaps —\n'
    tail -n +2 "$STATUS_FILE"
    ;;
  *)
    printf 'session-start: provisioning failed — logs in %s\n' "$LOG_DIR" >&2
    exit 1
    ;;
esac
exit 0
