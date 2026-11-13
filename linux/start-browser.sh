#!/usr/bin/env bash
# Start the background Chrome instance used by the MCP bridge.
#
# The browser runs on a virtual X display (Xvfb), so it does not need a
# physical monitor. It loads the extension and keeps a Gemini tab open.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

start_chrome_background
sleep 3

if pgrep -f -- "--user-data-dir=$PROFILE_DIR" >/dev/null 2>&1; then
  echo "Gemini background browser is running."
  echo "  Profile:  $PROFILE_DIR"
  echo "  Display:  $DISPLAY_NUM (virtual, no monitor required)"
  echo "  Log:      $STATE_DIR/chrome.log"
  echo
  echo "The extension will connect to the MCP bridge when OpenCode starts."
else
  echo "Chrome did not stay running. Last lines of the log:" >&2
  tail -n 20 "$STATE_DIR/chrome.log" >&2 || true
  exit 1
fi
