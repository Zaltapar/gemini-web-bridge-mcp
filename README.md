# Gemini Web Bridge MCP

An MCP server that lets coding agents use **Gemini Pro through the Gemini web app** — no Gemini API key, no per-token billing, and no separate "API" account.

It drives a real Chrome/Chromium session through a small extension. The agent calls one MCP tool, the extension types the prompt into Gemini, waits for the answer, and returns it. It also supports **file upload** and **downloading generated images/files**.

> This is an unofficial browser bridge. It is not affiliated with Google. Use it only with an account you are allowed to use this way, and review the security and terms-of-service notes below.

Based on [Walkoud/gemini-browser-mcp](https://github.com/Walkoud/gemini-browser-mcp) (MIT), with substantial changes: file transfer, multi-workspace proxy support, loopback-only binding, automatic content-script injection, longer response stabilization, and Linux server tooling.

---

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start: Windows / macOS desktop](#quick-start-windows--macos-desktop)
- [OpenCode configuration](#opencode-configuration)
- [Linux server guide](#linux-server-guide)
  - [Option A: Chrome on your laptop + SSH tunnel](#option-a-chrome-on-your-laptop--ssh-tunnel-recommended-for-headless-servers)
  - [Option B: Chrome on the server with Xvfb + VNC](#option-b-chrome-on-the-server-with-xvfb--vnc)
  - [Run the background browser as a systemd user service](#run-the-background-browser-as-a-systemd-user-service)
- [Tool reference](#tool-reference)
- [File transfer](#file-transfer)
- [Architecture details](#architecture-details)
- [Security and privacy](#security-and-privacy)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Attribution and license](#attribution-and-license)

---

## Features

- **No Gemini API key** — uses the same web session you use manually.
- **Gemini Pro / Flash / Thinking** — choose the model in the Gemini tab; the extension detects the active model and adjusts timeouts.
- **File upload** — pass local file paths to the tool; text, code, PDF, images, documents, etc. are attached to the prompt.
- **Download generated files** — images and downloadable links from Gemini's response are saved to a local directory and returned as file paths.
- **Multi-workspace safe** — one bridge owns port `8085`; other OpenCode workspaces automatically become proxies instead of fighting for the port.
- **Loopback-only by default** — the WebSocket bridge binds `127.0.0.1` and rejects non-loopback clients unless explicitly allowed.
- **Self-healing content script** — if the Gemini tab was open before the extension was reloaded, the background worker injects the content script and retries.
- **Linux server support** — run Chrome under Xvfb, or keep Chrome on your laptop and tunnel port `8085` to the server.
- **OpenCode, Claude Code, and any MCP client** — the server is a standard stdio MCP server.

---

## How it works

```
┌────────────────────┐        stdio MCP         ┌──────────────────────────┐
│ OpenCode / agent   │ ◄──────────────────────► │  server.js (MCP server)  │
└────────────────────┘                          │  owner on 127.0.0.1:8085 │
                                                └────────────┬─────────────┘
                                                             │ WebSocket
                                                             │ (loopback)
                                                ┌────────────▼─────────────┐
                                                │ Chrome extension          │
                                                │ background + content.js   │
                                                └────────────┬─────────────┘
                                                             │ DOM automation
                                                ┌────────────▼─────────────┐
                                                │ Gemini web app            │
                                                │ gemini.google.com/app     │
                                                └──────────────────────────┘
```

1. OpenCode starts `server.js` over stdio.
2. `server.js` opens a WebSocket server on `127.0.0.1:8085`.
3. The Chrome extension connects to that WebSocket and identifies itself.
4. When the agent calls `ask_gemini_web`, the server sends the prompt (and optional file payloads) to the extension.
5. The content script finds the Gemini composer, attaches files, types the prompt, clicks Send, and waits for the response to stabilize.
6. The response text and any generated attachments are sent back over the WebSocket. The MCP server returns the text and writes attachments to disk.

### Multi-workspace proxy mode

OpenCode can load the same MCP server for several workspaces. Only one process can bind port `8085`. The first process becomes the **owner**; later processes detect `EADDRINUSE`, switch to **proxy mode**, connect to the owner, and relay their tool calls through it. If the owner disappears, proxies attempt to take over after repeated failures.

### Response timing

- Normal model: 5-minute cap, 10-second text-stability window.
- Extended-thinking model: up to 15-minute cap.
- Bridge-level request timeout: 10 minutes.

Long answers can still be truncated if Gemini pauses for more than 10 seconds in the middle of a response. The stability window and timeouts are in `chrome-extension/content.js`.

---

## Requirements

- **Node.js 20 or newer**
- **Chrome, Chromium, Brave, or another Chromium-based browser**
- The Gemini Bridge extension loaded in that browser
- A Google account with access to Gemini (Pro recommended)
- For Linux servers: Xvfb and x11vnc for the one-time login (or use the SSH tunnel option)

---

## Quick start: Windows / macOS desktop

### 1. Clone and install

```bash
git clone https://github.com/Zaltapar/gemini-web-bridge-mcp.git
cd gemini-web-bridge-mcp
npm install
```

### 2. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `chrome-extension/` folder from this repository

### 3. Log in to Gemini

1. Open `https://gemini.google.com/app`
2. Log in with the account that has Gemini Pro
3. Switch the model selector to **Pro** (or Flash / Thinking, as you prefer)
4. Keep the tab open

### 4. Configure OpenCode

Add this to `~/.config/opencode/opencode.jsonc` (Linux/macOS) or `C:\Users\<you>\.config\opencode\opencode.jsonc` (Windows):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "gemini": {
        "type": "local",
        "command": [
          "node",
          "C:\\path\\to\\gemini-web-bridge-mcp\\server.js"
        ]
      }
    }
  }
}
```

Alternatively, with the OpenCode CLI:

```bash
opencode mcp add gemini --global -- node /absolute/path/to/gemini-web-bridge-mcp/server.js
opencode mcp list
```

### 5. Test

Ask OpenCode:

> Use `ask_gemini_web` to reply with exactly: BRIDGE_OK

You should get `BRIDGE_OK`.

### 6. Keep Chrome running

The extension needs a Gemini tab. You can minimize Chrome; you do not need to interact with it while the MCP is working. If you close the tab or Chrome, open Gemini again.

---

## OpenCode configuration

Minimal global config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "gemini": {
        "type": "local",
        "command": ["node", "/opt/gemini-web-bridge-mcp/server.js"],
        "environment": {
          "GEMINI_BRIDGE_HOST": "127.0.0.1",
          "GEMINI_BRIDGE_PORT": "8085"
        }
      }
    }
  }
}
```

Environment variables:

| Variable | Default | Description |
|---|---|---|
| `GEMINI_BRIDGE_HOST` | `127.0.0.1` | Bind address for the WebSocket bridge. Keep loopback unless you have a specific reason. |
| `GEMINI_BRIDGE_PORT` | `8085` | Port. If changed, also change `BRIDGE_URL` in `chrome-extension/background.js`. |
| `GEMINI_BRIDGE_ALLOW_REMOTE` | unset | Set to `1` to allow non-loopback WebSocket clients. Dangerous; prefer an SSH tunnel. |

Project-local config works the same way in any `opencode.json(c)` or `.opencode/opencode.json(c)` discovered by OpenCode.

---

## Linux server guide

See **[docs/LINUX.md](docs/LINUX.md)** for a longer copy-paste guide, including systemd, VNC, dedicated users, and firewall notes.

There are two reliable ways to run this on a Linux server:

1. **Recommended for headless servers:** Chrome runs on your laptop/desktop; the server runs OpenCode and the MCP bridge; an SSH tunnel connects the extension to the server.
2. **Chrome on the server:** Chrome runs under Xvfb on the server. Log in once with VNC, then keep it running headlessly.

### Option A: Chrome on your laptop + SSH tunnel (recommended for headless servers)

This is the easiest and most reliable setup if your server has no desktop environment. Chrome stays on your machine, where you can see and log in normally. Only the WebSocket is tunneled.

#### On the server

```bash
sudo apt update
sudo apt install -y nodejs npm
# Node 20+ is recommended. If your distro ships an older Node, use nvm or NodeSource.

git clone https://github.com/Zaltapar/gemini-web-bridge-mcp.git /opt/gemini-web-bridge-mcp
cd /opt/gemini-web-bridge-mcp
npm install

opencode mcp add gemini --global -- node /opt/gemini-web-bridge-mcp/server.js
opencode mcp list
```

#### On your laptop

1. Load `chrome-extension/` as an unpacked extension in Chrome.
2. Open `https://gemini.google.com/app`, log in, select Pro.
3. Create an SSH tunnel from your laptop to the server:

```bash
ssh -N -L 8085:127.0.0.1:8085 user@your-server.example.com
```

Keep that SSH session open. The extension connects to `ws://127.0.0.1:8085` on your laptop, which is forwarded to the MCP bridge on the server.

4. Start OpenCode on the server and test:

> Use `ask_gemini_web` to reply with exactly: TUNNEL_OK

If the tunnel is up and Chrome has a Gemini tab open, this works exactly like the desktop setup.

> Windows laptop: use the same `ssh -L 8085:127.0.0.1:8085 user@server` command in PowerShell, or configure an equivalent tunnel in PuTTY.

### Option B: Chrome on the server with Xvfb + VNC

Use this when you want the server to be fully self-contained.

#### 1. Install system packages

Debian/Ubuntu:

```bash
sudo apt update
sudo apt install -y nodejs npm xvfb x11vnc
```

For a newer Node.js, install Node 20+ via nvm or NodeSource. Then:

```bash
git clone https://github.com/Zaltapar/gemini-web-bridge-mcp.git /opt/gemini-web-bridge-mcp
cd /opt/gemini-web-bridge-mcp
npm install
chmod +x linux/*.sh
```

#### 2. One-time login through VNC

Run:

```bash
./linux/login.sh
```

The script starts:

- Xvfb on virtual display `:99`
- x11vnc on `127.0.0.1:5900` (localhost only)
- Chrome with the extension and `gemini.google.com/app`

From your laptop, tunnel the VNC port:

```bash
ssh -L 5900:127.0.0.1:5900 user@your-server.example.com
```

Then open a VNC viewer at `127.0.0.1:5900` (macOS: Finder → Go → Connect to Server → `vnc://127.0.0.1:5900`). Log in with the Google account that has Gemini Pro. Close the Chrome window and press Enter in the terminal.

The Chrome profile is stored at:

```
~/.local/share/gemini-web-bridge/chrome-profile
```

It contains the login session. Treat it as a secret.

#### 3. Start the background browser

```bash
./linux/start-browser.sh
```

This starts Chrome under Xvfb with the extension and a Gemini tab, minimized/offscreen. You do not need a monitor.

#### 4. Configure OpenCode

```bash
opencode mcp add gemini --global -- node /opt/gemini-web-bridge-mcp/server.js
opencode mcp list
```

Or use `linux/opencode.json.example` as a starting point.

#### 5. Test

> Use `ask_gemini_web` to reply with exactly: SERVER_OK

#### Stop the browser

```bash
./linux/stop-browser.sh
```

### Run the background browser as a systemd user service

Copy the unit file and adjust the path if needed:

```bash
mkdir -p ~/.config/systemd/user
cp linux/gemini-browser.service ~/.config/systemd/user/
# Edit ExecStart if you cloned somewhere other than ~/gemini-web-bridge-mcp
systemctl --user daemon-reload
systemctl --user enable --now gemini-browser.service
systemctl --user status gemini-browser.service
```

Logs:

```bash
journalctl --user -u gemini-browser.service -f
```

The service runs Chrome under Xvfb. It does not start the MCP server; OpenCode starts that over stdio when needed.

### Remote server with Chrome on a different machine

If you run Chrome on machine A and OpenCode on machine B, tunnel B's port to A:

On machine A (Chrome side), run:

```bash
ssh -N -L 8085:127.0.0.1:8085 user@machine-b
```

Then the extension on machine A connects to `127.0.0.1:8085` and reaches the MCP bridge on machine B. No inbound firewall port is required; the SSH connection does the forwarding.

---

## Tool reference

### `ask_gemini_web`

```json
{
  "prompt": "string",
  "files": ["/absolute/path/to/file1", "/absolute/path/to/file2"],
  "download_dir": "/absolute/path/to/downloads"
}
```

- `prompt` — required. The text sent to Gemini.
- `files` — optional. Local files to attach to the prompt.
- `download_dir` — optional. Where returned attachments are saved. Defaults to the OS temp directory under `gemini-mcp-downloads`.

Returns a text block. If Gemini returned attachments, the response includes a `[Saved attachments]` section with absolute local paths.

Examples:

```text
Use ask_gemini_web to review src/main.py for bugs.
```

```text
Use ask_gemini_web with files ["logs/error.log", "src/server.ts"] to find the root cause of this crash.
```

```text
Use ask_gemini_web with files ["requirements.md", "schema.sql"] to create an implementation plan.
```

### Model selection

The extension uses whichever model is selected in the Gemini web UI. To use Pro, select **Pro** in the Gemini tab. The extension reports the active model in its popup and adjusts its timeout for extended thinking.

There is no separate `select_model` tool, because Gemini's web UI model selector is the source of truth.

### File transfer details

- Uploads are read by the MCP server, base64-encoded, sent over the local WebSocket, and attached via the page's file input.
- Each uploaded file is limited to **20 MiB**.
- The total upload per request is limited to **60 MiB** before base64 encoding.
- For large videos, prefer a URL-based prompt or split the request.
- Generated images and downloadable links are extracted from the response container, fetched with the browser session, and written to `download_dir`.
- Gemini's inline document editor is returned as text; it is not automatically converted into a separate file.

---

## Architecture details

### Owner / proxy mode

Only one MCP server process can own port `8085`. Later processes:

1. Detect `EADDRINUSE`.
2. Connect to the owner as an MCP proxy client.
3. Send `ask` requests through the owner.
4. Receive text and attachments back.

If the owner exits, proxies attempt to take over. This avoids the "port busy" failure mode when OpenCode has several workspaces open.

### Extension roles

The background worker identifies itself as `role: extension`. MCP proxies identify as `role: mcp`. The owner only routes prompts to the extension client; it does not confuse a proxy with the browser.

### Content script

`chrome-extension/content.js` is injected into `https://gemini.google.com/*`. It:

- Finds the composer.
- Clicks the attachment button if Gemini has not created the hidden file input yet.
- Attaches files with a `DataTransfer`.
- Waits for uploads to settle.
- Types the prompt and clicks Send.
- Counts `.response-container` elements before sending.
- Waits for the new response's markdown text to stop changing for 10 seconds.
- Extracts text, images, and downloadable links.
- Sends the result back through the background worker.

If the tab was open before the extension was reloaded, the background worker injects `content.js` with `chrome.scripting.executeScript` and retries once.

### Security defaults

- The WebSocket server binds `127.0.0.1` by default.
- Non-loopback clients are rejected unless `GEMINI_BRIDGE_ALLOW_REMOTE=1`.
- The extension only requests host permissions for Gemini and Google content domains.
- The bridge never logs cookie values or prompt contents to its log file.

---

## Security and privacy

This tool automates a logged-in browser session. That has real security implications:

- **Your Gemini session is powerful.** Anyone who can connect to the bridge can send prompts as you. Keep the bridge on loopback and do not expose port `8085` to the internet.
- **Do not run it on a shared server without isolation.** Use a dedicated Unix user, a dedicated Chrome profile, and OS-level access controls.
- **Prompt and file contents pass through the Gemini web app.** Treat them as data sent to Google, exactly as if you typed them in the browser.
- **The Chrome profile contains cookies.** On Linux it lives under `~/.local/share/gemini-web-bridge/chrome-profile`. Protect it like an SSH private key.
- **Chrome sandbox.** The scripts add `--no-sandbox` only when running as root. Running Chrome as root is discouraged; use a normal user account.
- **Terms of service.** Automating the Gemini web UI may conflict with Google's terms or usage policies. You are responsible for how you use it. This project is not affiliated with or endorsed by Google.
- **No warranty.** DOM selectors and Google's UI change. Expect occasional breakage.

### Optional: cookie export utility

`scripts/export-cookies.mjs` can ask the extension for the `__Secure-1PSID` / `__Secure-1PSIDTS` cookies and write them to a local file. It exists for experimental HTTP transports. It is **not required** for the browser bridge.

Run it while Chrome and the extension are connected:

```bash
node scripts/export-cookies.mjs
```

It writes `~/.config/opencode/gemini-cookies.json` by default. Do not commit that file. `.gitignore` already excludes `gemini-cookies.json`.

The unofficial HTTP route can trigger Google anti-bot blocks (`TemporarilyBlocked`). The browser path is the reliable one.

---

## Limitations

- **Chrome must be running** somewhere and must have a Gemini tab open. The "no browser process at all" route is not reliable; Google blocks the unofficial HTTP API.
- **The server needs access to Chrome.** Either Chrome runs on the server under Xvfb, or you tunnel `8085` from your laptop.
- **The DOM can change.** Selectors for the composer, send button, upload input, and response container may need updates after Gemini UI changes.
- **Long responses can truncate** if Gemini pauses for more than the 10-second stability window.
- **File upload is UI-level.** Very large files or unusual MIME types may be rejected by Gemini.
- **Model choice is manual.** Select Pro/Flash/Thinking in the Gemini tab.
- **One Gemini session at a time.** The extension uses the focused Gemini tab. Multiple accounts require switching the browser account.

---

## Troubleshooting

### `Chrome extension not connected`

- Make sure Chrome is running.
- Make sure the extension is loaded and enabled.
- Reload the extension from `chrome://extensions`.
- Open `https://gemini.google.com/app`.
- Check that the bridge is running: `opencode mcp list` should show `connected`.
- On Linux, check the browser log: `~/.local/state/gemini-web-bridge/chrome.log`.

### `Could not establish connection. Receiving end does not exist`

The Gemini tab is older than the extension reload. Refresh the Gemini tab. The current background worker also tries to inject the content script automatically, but a manual refresh is the simplest fix.

### `No Gemini tab open`

Open `https://gemini.google.com/app` in the Chrome instance that has the extension.

### `Port 8085 busy` / multiple workspaces

This is expected; the later MCP processes become proxies. If the owner died and nothing owns the port, restart the MCP server by reloading the OpenCode config or restarting the OpenCode service. Check `server.log` in the repository directory.

### `Gemini file input not found`

Gemini changed its upload UI. Update `findFileInput`, `uploadCandidates`, and `attachFiles` in `chrome-extension/content.js`. The error message lists visible candidate buttons to help.

### Upload works but the answer is cut off

Increase the `10000` ms stability timer in `chrome-extension/content.js` (and reload the extension). Very long code reviews may need 15–20 seconds.

### Linux: Chrome exits immediately

Run `./linux/start-browser.sh` and inspect:

```bash
tail -n 50 ~/.local/state/gemini-web-bridge/chrome.log
```

Common causes:

- Chrome not installed or `CHROME_BIN` wrong.
- Running as root without `--no-sandbox` (the script adds it automatically when root).
- Missing shared libraries; install Chrome's dependencies.
- Xvfb not installed.

### Linux: no VNC connection

- Make sure you ran `ssh -L 5900:127.0.0.1:5900 user@server`.
- x11vnc binds localhost only. Do not expose it publicly.
- Check `~/.local/state/gemini-web-bridge/x11vnc.log`.

### OpenCode does not see the MCP server

- Validate config JSON.
- Run `opencode mcp list`.
- Check OpenCode logs: `~/.local/share/opencode/log/opencode.log`.
- Use an absolute path to `server.js` in the config.

---

## Development

```bash
npm install
node server.js        # stdio MCP server, normally started by OpenCode
```

Extension development:

1. Edit files in `chrome-extension/`.
2. Reload the extension at `chrome://extensions`.
3. Refresh the Gemini tab.
4. Check the service worker console for `[Bridge BG]` and `[Bridge]` messages.

Logs:

- MCP server log: `server.log` next to `server.js`.
- Browser launcher logs: `~/.local/state/gemini-web-bridge/`.

To test the MCP handshake without OpenCode, send JSON-RPC lines to `node server.js`:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
```

---

## Attribution and license

- Original extension and bridge concept: [Walkoud/gemini-browser-mcp](https://github.com/Walkoud/gemini-browser-mcp), MIT.
- This fork adds file transfer, owner/proxy multi-workspace support, loopback security, auto-injection, Linux tooling, and documentation.
- License: MIT. See [LICENSE](LICENSE).
