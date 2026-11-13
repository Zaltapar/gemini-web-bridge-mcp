#!/usr/bin/env bash
# Foreground variant used by the systemd user service.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

build_chrome_flags
start_xvfb
export DISPLAY="$DISPLAY_NUM"

"$CHROME" "${CHROME_FLAGS[@]}" \
  --start-minimized \
  --window-position=-32000,-32000 \
  "https://gemini.google.com/app" \
  >"$STATE_DIR/chrome.log" 2>&1 &
CHROME_PID=$!

cleanup() {
  kill "$CHROME_PID" 2>/dev/null || true
  stop_xvfb_if_ours
}
trap cleanup EXIT INT TERM

wait "$CHROME_PID"
