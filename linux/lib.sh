#!/usr/bin/env bash
# Shared helpers for the Linux launcher scripts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$ROOT/chrome-extension"
PROFILE_DIR="${GEMINI_PROFILE_DIR:-$HOME/.local/share/gemini-web-bridge/chrome-profile}"
STATE_DIR="${GEMINI_STATE_DIR:-$HOME/.local/state/gemini-web-bridge}"
DISPLAY_NUM="${GEMINI_DISPLAY:-:99}"
VNC_PORT="${GEMINI_VNC_PORT:-5900}"

mkdir -p "$PROFILE_DIR" "$STATE_DIR"

find_chrome() {
  local candidate
  if [ -n "${CHROME_BIN:-}" ] && [ -x "${CHROME_BIN}" ]; then
    printf '%s\n' "$CHROME_BIN"
    return 0
  fi
  for candidate in google-chrome google-chrome-stable chromium chromium-browser brave-browser; do
    if command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

CHROME="$(find_chrome || true)"
if [ -z "$CHROME" ]; then
  echo "Chrome/Chromium not found. Set CHROME_BIN=/path/to/chrome or install Google Chrome." >&2
  exit 1
fi

is_root() {
  [ "$(id -u)" -eq 0 ]
}

build_chrome_flags() {
  CHROME_FLAGS=(
    "--user-data-dir=$PROFILE_DIR"
    "--disable-extensions-except=$EXT_DIR"
    "--load-extension=$EXT_DIR"
    "--no-first-run"
    "--no-default-browser-check"
    "--disable-dev-shm-usage"
    "--disable-gpu"
    "--password-store=basic"
    "--disable-features=Translate,MediaRouter"
    "--noerrdialogs"
  )
  if is_root; then
    CHROME_FLAGS+=("--no-sandbox")
  fi
}

xvfb_running() {
  [ -S "/tmp/.X11-unix/X${DISPLAY_NUM#:}" ]
}

start_xvfb() {
  if xvfb_running; then
    return 0
  fi
  Xvfb "$DISPLAY_NUM" -screen 0 1280x900x24 -nolisten tcp \
    >"$STATE_DIR/xvfb.log" 2>&1 &
  XVFB_PID=$!
  echo "$XVFB_PID" >"$STATE_DIR/xvfb.pid"
  sleep 1
}

stop_xvfb_if_ours() {
  if [ -f "$STATE_DIR/xvfb.pid" ]; then
    local pid
    pid="$(cat "$STATE_DIR/xvfb.pid")"
    kill "$pid" 2>/dev/null || true
    rm -f "$STATE_DIR/xvfb.pid"
  fi
}

start_chrome_background() {
  if pgrep -f -- "--user-data-dir=$PROFILE_DIR" >/dev/null 2>&1; then
    echo "Chrome is already running for $PROFILE_DIR"
    return 0
  fi
  build_chrome_flags
  start_xvfb
  export DISPLAY="$DISPLAY_NUM"
  nohup "$CHROME" "${CHROME_FLAGS[@]}" \
    --start-minimized \
    --window-position=-32000,-32000 \
    "https://gemini.google.com/app" \
    >"$STATE_DIR/chrome.log" 2>&1 &
  echo "$!" >"$STATE_DIR/chrome.pid"
}
