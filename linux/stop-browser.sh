#!/usr/bin/env bash
# Stop the background Gemini browser and its virtual display.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

if [ -f "$STATE_DIR/chrome.pid" ]; then
  kill "$(cat "$STATE_DIR/chrome.pid")" 2>/dev/null || true
  rm -f "$STATE_DIR/chrome.pid"
fi

pkill -f -- "--user-data-dir=$PROFILE_DIR" 2>/dev/null || true
stop_xvfb_if_ours

echo "Gemini background browser stopped."
