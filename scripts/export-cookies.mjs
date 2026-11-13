import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const output = process.env.GEMINI_COOKIE_FILE
  || path.join(os.homedir(), ".config", "opencode", "gemini-cookies.json");

const ws = new WebSocket("ws://127.0.0.1:8085");
const requestId = `cookies_${Date.now()}`;
let finished = false;

const timeout = setTimeout(() => {
  console.error("Timed out waiting for the Chrome extension. Is the Gemini Bridge extension loaded and connected?");
  try { ws.close(); } catch {}
  process.exit(1);
}, 20_000);

let attempts = 0;
let retryTimer = null;

ws.on("open", () => {
  ws.send(JSON.stringify({ action: "identify", role: "mcp" }));
  const request = () => {
    attempts++;
    ws.send(JSON.stringify({ action: "getCookies", requestId: `${requestId}_${attempts}` }));
  };
  request();
  retryTimer = setInterval(request, 2500);
});

ws.on("message", (data) => {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    return;
  }
  if (!msg.requestId || !msg.requestId.startsWith(requestId) || typeof msg.text !== "string") return;

  let cookies;
  try {
    cookies = JSON.parse(msg.text);
  } catch {
    console.error("Cookie response was not valid JSON.");
    process.exit(1);
  }
  if (cookies.error) {
    // The extension may still be connecting; keep retrying until the timeout.
    console.error("Waiting for extension:", cookies.error);
    return;
  }
  if (!cookies.psid) {
    console.error("No __Secure-1PSID cookie returned. Make sure Gemini is logged in in the active Chrome profile.");
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({
    psid: cookies.psid,
    psidts: cookies.psidts || "",
    exportedAt: new Date().toISOString(),
  }, null, 2));
  console.log(`Saved Gemini cookies to ${output}`);
  finished = true;
  clearTimeout(timeout);
  if (retryTimer) clearInterval(retryTimer);
  ws.close();
  process.exit(0);
});

ws.on("error", (err) => {
  console.error("Could not connect to the bridge:", err.message);
  process.exit(1);
});

ws.on("close", () => {
  if (!finished) {
    console.error("Bridge connection closed before cookies were received.");
    process.exit(1);
  }
});
