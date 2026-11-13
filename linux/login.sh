#!/usr/bin/env bash
# One-time Gemini login using a virtual X display and x11vnc.
#
# Usage:
#   ./linux/login.sh
#
# Then from your laptop:
#   ssh -L 5900:127.0.0.1:5900 user@your-server
# and open vnc://127.0.0.1:5900 (macOS) or any VNC viewer at localhost:5900.
#
# Log in to Gemini with the Google account that has Gemini Pro, then close the
# Chrome window (or press Ctrl+C here). The profile is saved for the background
# browser.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

if ! command -v Xvfb >/dev/null 2>&1; then
  echo "Xvfb is required. Install it with: sudo apt install xvfb" >&2
  exit 1
fi

if ! command -v x11vnc >/dev/null 2>&1; then
  echo "x11vnc is required for remote login. Install it with: sudo apt install x11vnc" >&2
  echo "Alternatively, run this script from a desktop session with DISPLAY set." >&2
  exit 1
fi

build_chrome_flags
start_xvfb
export DISPLAY="$DISPLAY_NUM"

x11vnc -display "$DISPLAY_NUM" -localhost -nopw -forever -shared \
  -rfbport "$VNC_PORT" >"$STATE_DIR/x11vnc.log" 2>&1 &
X11VNC_PID=$!

"$CHROME" "${CHROME_FLAGS[@]}" "https://gemini.google.com/app" \
  >"$STATE_DIR/login-chrome.log" 2>&1 &
CHROME_PID=$!

cleanup() {
  kill "$CHROME_PID" 2>/dev/null || true
  kill "$X11VNC_PID" 2>/dev/null || true
  stop_xvfb_if_ours
}
trap cleanup EXIT INT TERM

echo
echo "============================================================"
echo " Gemini login window is ready"
echo "============================================================"
echo " From your laptop, create the tunnel:"
echo
echo "   ssh -L ${VNC_PORT}:127.0.0.1:${VNC_PORT} $(whoami)@$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo " Then open a VNC viewer at: 127.0.0.1:${VNC_PORT}"
echo " Log in with the Google account that has Gemini Pro."
echo
echo " When finished, close the Chrome window and press Enter here."
echo "============================================================"
echo

read -r -p "Press Enter after login is complete... " _

echo "Stopping login session..."
cleanup
trap - EXIT INT TERM
echo "Profile saved to: $PROFILE_DIR"
echo "Next: ./linux/start-browser.sh"
