# Running Gemini Web Bridge MCP on Linux

This guide covers running the MCP server on a Linux machine, including a headless server, and how to log in to Gemini once.

Chrome runs natively on Linux. If your Linux machine has a desktop/GUI, use the [Linux desktop](#linux-desktop-with-a-gui) setup and skip Xvfb and VNC entirely.

There are two supported deployment models for **headless** servers.

| Model | Chrome runs on | Best for | Browser window on server |
|---|---|---|---|
| **A. SSH tunnel** | Your laptop/desktop | Headless servers, cloud VMs, containers | None |
| **B. Xvfb + VNC** | The Linux server | Self-contained servers, no laptop in the loop | Virtual, no monitor |

Both models use the same MCP server. Only the location of Chrome differs.

---

## Linux desktop with a GUI

This is the simplest Linux setup:

```bash
git clone https://github.com/Zaltapar/gemini-web-bridge-mcp.git
cd gemini-web-bridge-mcp
npm install
```

1. Install Google Chrome or Chromium.
2. Open `chrome://extensions` → Developer mode → **Load unpacked** → `chrome-extension/`.
3. Open `https://gemini.google.com/app`, log in, select **Pro**.
4. Configure OpenCode:

```bash
opencode mcp add gemini --global -- node "$(pwd)/server.js"
opencode mcp list
```

That is all. Chrome stays open with the Gemini tab; you can minimize it. Xvfb is only for servers with no display.

---

## Prerequisites

- Node.js 20+
- Git
- Chrome/Chromium with the extension
- OpenCode on the Linux server

### Debian/Ubuntu packages

```bash
sudo apt update
sudo apt install -y git curl xvfb x11vnc
```

Install Node.js 20+ (NodeSource example):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # should be v20 or newer
```

Install the repo:

```bash
sudo mkdir -p /opt/gemini-web-bridge-mcp
sudo chown -R "$USER":"$USER" /opt/gemini-web-bridge-mcp
git clone https://github.com/Zaltapar/gemini-web-bridge-mcp.git /opt/gemini-web-bridge-mcp
cd /opt/gemini-web-bridge-mcp
npm install
chmod +x linux/*.sh
```

---

## Model A: Chrome on your laptop + SSH tunnel

This is the recommended setup for a headless server.

### 1. On your laptop

```bash
git clone https://github.com/Zaltapar/gemini-web-bridge-mcp.git
```

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select `gemini-web-bridge-mcp/chrome-extension`
4. Open `https://gemini.google.com/app`
5. Log in and choose **Pro** in the model selector
6. Keep the Gemini tab open

### 2. On the Linux server

```bash
cd /opt/gemini-web-bridge-mcp
npm install

opencode mcp add gemini --global -- node /opt/gemini-web-bridge-mcp/server.js
opencode mcp list
```

Expected:

```
✓ gemini  connected
```

### 3. On your laptop, open the tunnel

```bash
ssh -N -L 8085:127.0.0.1:8085 user@your-server
```

Keep this terminal open. The extension connects to `ws://127.0.0.1:8085` on your laptop, which is forwarded to the MCP bridge on the server.

### 4. Test

In OpenCode on the server:

> Use `ask_gemini_web` to reply with exactly: TUNNEL_OK

If Chrome is open with the Gemini tab, this returns `TUNNEL_OK`.

### Notes

- No inbound firewall port is needed.
- The tunnel must be re-established after a reboot or network drop.
- If you use Windows, the same `ssh -L 8085:127.0.0.1:8085 user@server` works in PowerShell.
- If you use a non-default port, change `BRIDGE_URL` in `chrome-extension/background.js` and `GEMINI_BRIDGE_PORT` in the OpenCode MCP environment.

---

## Model B: Chrome on the Linux server with Xvfb + VNC

Use this when the server should be self-contained.

### 1. One-time login

```bash
cd /opt/gemini-web-bridge-mcp
./linux/login.sh
```

The script starts:

- Xvfb on display `:99`
- x11vnc on `127.0.0.1:5900` (localhost only)
- Chrome with the extension and Gemini

From your laptop:

```bash
ssh -L 5900:127.0.0.1:5900 user@your-server
```

Open a VNC viewer at `127.0.0.1:5900`.

- macOS: Finder → Go → Connect to Server → `vnc://127.0.0.1:5900`
- Windows: use TigerVNC, RealVNC, or any VNC client
- Linux: `vncviewer 127.0.0.1:5900`

Log in with the Google account that has Gemini Pro. Close the Chrome window and press Enter in the terminal. The profile is saved at:

```
~/.local/share/gemini-web-bridge/chrome-profile
```

Protect it:

```bash
chmod 700 ~/.local/share/gemini-web-bridge
```

### 2. Start the background browser

```bash
./linux/start-browser.sh
```

Chrome runs under Xvfb with the extension and a Gemini tab, minimized/offscreen. You do not need a monitor or VNC for normal operation.

Check:

```bash
pgrep -af "user-data-dir=$HOME/.local/share/gemini-web-bridge/chrome-profile"
tail -n 50 ~/.local/state/gemini-web-bridge/chrome.log
```

### 3. Configure OpenCode

```bash
opencode mcp add gemini --global -- node /opt/gemini-web-bridge-mcp/server.js
opencode mcp list
```

Or copy `linux/opencode.json.example` into `~/.config/opencode/opencode.jsonc` and edit the path.

### 4. Test

> Use `ask_gemini_web` to reply with exactly: SERVER_OK

### 5. Stop the browser

```bash
./linux/stop-browser.sh
```

### 6. Start automatically at boot (systemd user service)

```bash
mkdir -p ~/.config/systemd/user
cp linux/gemini-browser.service ~/.config/systemd/user/
```

Edit `~/.config/systemd/user/gemini-browser.service` if your clone is not at `~/gemini-web-bridge-mcp`:

```ini
[Service]
ExecStart=%h/gemini-web-bridge-mcp/linux/run-browser-foreground.sh
```

Enable it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now gemini-browser.service
systemctl --user status gemini-browser.service
journalctl --user -u gemini-browser.service -f
```

For a service account that should start at boot without an interactive login:

```bash
sudo loginctl enable-linger your-user
```

### 7. Firewall and security

- The bridge binds `127.0.0.1` by default.
- The extension connects to `127.0.0.1:8085`.
- x11vnc binds localhost only in `login.sh`.
- Do not expose `8085` or `5900` to the internet.
- If you must expose the bridge on a non-loopback interface, set `GEMINI_BRIDGE_HOST=0.0.0.0` and `GEMINI_BRIDGE_ALLOW_REMOTE=1`, then protect it with a firewall/VPN. This is not recommended.

---

## Dedicated service account

On a shared server, run the bridge under a dedicated user:

```bash
sudo useradd -m -s /bin/bash gemini-bridge
sudo -u gemini-bridge -i
```

Then repeat the install and login steps as `gemini-bridge`. Enable lingering so the background browser starts at boot:

```bash
sudo loginctl enable-linger gemini-bridge
```

The MCP server is started by OpenCode as the user running OpenCode. That user must be able to reach the same loopback port as the browser. If OpenCode runs as a different user, run the bridge and OpenCode in the same user session, or use the SSH tunnel model.

---

## OpenCode configuration example

`~/.config/opencode/opencode.jsonc`:

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

Verify:

```bash
opencode mcp list
opencode mcp add gemini --global -- node /opt/gemini-web-bridge-mcp/server.js
```

OpenCode watches config files and reloads MCP servers after a save. If a server looks stuck, use `/reload` in the TUI or restart the OpenCode background service.

---

## Verification checklist

- [ ] `node --version` is 20+
- [ ] `opencode mcp list` shows `✓ gemini connected`
- [ ] Chrome has a `gemini.google.com` tab open
- [ ] The extension popup says **Connected to local server (port 8085)**
- [ ] `ask_gemini_web` returns text
- [ ] Upload a small text file with `files` and ask Gemini to read it
- [ ] Ask Gemini to generate an image and confirm the saved path appears

---

## Troubleshooting Linux

### Chrome exits immediately under Xvfb

```bash
tail -n 80 ~/.local/state/gemini-web-bridge/chrome.log
```

Common causes:

- Missing Chrome libraries: install Chrome from Google's official `.deb`, which pulls its dependencies.
- Running as root: the scripts add `--no-sandbox` automatically, but running Chrome as root is still discouraged.
- No `DISPLAY`: the scripts export `DISPLAY=:99`; make sure Xvfb is running.
- `Xvfb` not installed: `sudo apt install xvfb`.

### VNC shows a black screen

- Verify Xvfb: `xdpyinfo -display :99`
- Check `~/.local/state/gemini-web-bridge/x11vnc.log`
- Make sure the SSH tunnel is `-L 5900:127.0.0.1:5900`, not a public port.

### Extension says disconnected

- Is `server.js` running? `opencode mcp list`
- Is Chrome running? `pgrep -af gemini-web-bridge/chrome-profile`
- Is the extension loaded in that Chrome profile? Load `chrome-extension/` from the repo.
- Reload the extension and refresh the Gemini tab.
- Check `server.log` next to `server.js`.

### Port 8085 already in use

Multiple OpenCode workspaces are expected to share one owner; later processes become proxies. If there is a stale owner, stop the MCP processes and reload:

```bash
pkill -f "gemini-web-bridge-mcp/server.js"
opencode mcp list
```

Then trigger a reload in OpenCode.

### `TemporarilyBlocked` from an HTTP transport

This project's reliable path is the browser extension. If you are experimenting with the optional cookie export and Google returns `TemporarilyBlocked`, the unofficial HTTP API is being rate-limited or anti-bot flagged. Wait, use a different network, or return to the browser bridge. The browser path is not affected by that block.

---

## Why not headless Chrome directly?

Chrome's `--headless=new` mode does not reliably load unpacked extensions and keep their background service worker alive in the same way a full browser does. Xvfb gives you a full Chrome instance with extensions and a virtual display, without a physical monitor. That is why the Linux server setup uses Xvfb rather than `--headless`.
