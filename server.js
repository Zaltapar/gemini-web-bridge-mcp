#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer, WebSocket } from "ws";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

// File logger, kept in the module dir and rotated to avoid unbounded growth
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logPath = path.join(__dirname, "server.log");
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB
function logToFile(msg) {
  try {
    try {
      if (fs.existsSync(logPath) && fs.statSync(logPath).size > MAX_LOG_BYTES) {
        fs.writeFileSync(logPath, `[${new Date().toISOString()}] [log rotated] previous log truncated\n`);
      }
    } catch {}
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) {}
}

const BRIDGE_PORT = Number.parseInt(process.env.GEMINI_BRIDGE_PORT || "8085", 10);
const BRIDGE_HOST = process.env.GEMINI_BRIDGE_HOST || "127.0.0.1";
const PROXY_URL = `ws://127.0.0.1:${BRIDGE_PORT}`;

const MIME_BY_EXT = {
  ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
  ".js": "text/javascript", ".mjs": "text/javascript", ".ts": "text/typescript",
  ".tsx": "text/typescript", ".jsx": "text/javascript", ".py": "text/x-python",
  ".html": "text/html", ".css": "text/css", ".csv": "text/csv", ".xml": "text/xml",
  ".yaml": "text/yaml", ".yml": "text/yaml", ".pdf": "application/pdf",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".zip": "application/zip", ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function mimeFromPath(p) {
  return MIME_BY_EXT[path.extname(p).toLowerCase()] || "application/octet-stream";
}

function safeFilename(name) {
  const base = path.basename(String(name || "gemini-file"));
  const cleaned = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^\.+$/, "_");
  return cleaned || "gemini-file";
}

function saveAttachments(attachments, downloadDir) {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  const dir = downloadDir
    ? path.resolve(downloadDir)
    : path.join(os.tmpdir(), "gemini-mcp-downloads");
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  for (const att of attachments) {
    if (!att || typeof att.data !== "string" || !att.data) continue;
    let bytes;
    try {
      bytes = Buffer.from(att.data, "base64");
    } catch {
      continue;
    }
    if (!bytes.length) continue;
    const name = safeFilename(att.name || `gemini-file-${Date.now()}`);
    const parsed = path.parse(name);
    let target = path.join(dir, name);
    let counter = 1;
    while (fs.existsSync(target)) {
      target = path.join(dir, `${parsed.name}-${counter++}${parsed.ext}`);
    }
    try {
      fs.writeFileSync(target, bytes);
      saved.push(target);
    } catch (e) {
      logToFile(`Failed to save attachment ${name}: ${e?.message}`);
    }
  }
  return saved;
}

function formatResponse(text, attachments, downloadDir) {
  const body = typeof text === "string" ? text : "";
  const saved = saveAttachments(attachments, downloadDir);
  if (saved.length === 0) {
    return { content: [{ type: "text", text: body }] };
  }
  const listing = saved.map((p) => `- ${p}`).join("\n");
  return {
    content: [{
      type: "text",
      text: `${body}\n\n[Saved attachments]\n${listing}`,
    }],
  };
}

logToFile("Server process starting...");

// Keep process alive on errors, but never let error reporting itself recurse.
// When the MCP client disconnects, stdio breaks and console.error throws EPIPE;
// an unguarded handler would re-trigger uncaughtException forever (this filled
// server.log with ~118GB once). On EPIPE the parent is gone, so we shut down.
let crashing = false;
process.on("uncaughtException", (err) => {
  if (crashing) return;
  crashing = true;
  logToFile(`Uncaught exception: ${err?.stack || err}`);
  try {
    console.error("[Bridge] Uncaught exception:", err);
  } catch {}
  if (err?.code === "EPIPE" || /EPIPE/i.test(err?.message || "")) {
    process.exit(0);
  }
});
process.on("unhandledRejection", (err) => {
  logToFile(`Unhandled rejection: ${err?.stack || err}`);
});

// When the MCP client (parent Claude Code session) closes its stdin, the session
// is over. Exit promptly so we don't linger as an orphan holding port 8085 and
// blocking future sessions from reaching the extension.
const exitOnStdinClose = () => {
  logToFile("stdin closed — parent MCP client disconnected, exiting");
  process.exit(0);
};
process.stdin.on("end", exitOnStdinClose);
process.stdin.on("close", exitOnStdinClose);

let wss = null;
let bindAttempts = 0;

// Multiple OpenCode workspaces each spawn their own MCP server. Only one can
// bind port 8085; the others become MCP proxies that relay asks through the
// owner. This keeps every workspace's tool call working.
let proxyMode = false;
let proxySocket = null;
let proxyReconnectTimer = null;
let proxyFailures = 0;
const proxyPending = new Map();

function connectToExistingBridge() {
  if (proxyMode && proxySocket && proxySocket.readyState <= WebSocket.OPEN) return;
  proxyMode = true;
  try {
    const ws = new WebSocket(PROXY_URL, { maxPayload: 128 * 1024 * 1024 });
    proxySocket = ws;
    ws.on("open", () => {
      proxyFailures = 0;
      logToFile("Connected to existing bridge as MCP proxy");
      ws.send(JSON.stringify({ action: "identify", role: "mcp" }));
    });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.action === "identify") return;
        if (msg.requestId && proxyPending.has(msg.requestId)) {
          const pending = proxyPending.get(msg.requestId);
          clearTimeout(pending.timeout);
          proxyPending.delete(msg.requestId);
          pending.resolve(formatResponse(msg.text || "", msg.attachments, pending.downloadDir));
        }
      } catch (e) {
        logToFile(`Proxy parse error: ${e?.message}`);
      }
    });
    ws.on("close", () => {
      proxySocket = null;
      proxyFailures++;
      if (proxyFailures >= 5) {
        proxyFailures = 0;
        proxyMode = false;
        logToFile("Proxy lost the owner bridge; attempting to become the owner");
        startWebSocketServer();
        return;
      }
      logToFile("MCP proxy connection closed, retrying in 2s...");
      if (!proxyReconnectTimer) {
        proxyReconnectTimer = setTimeout(() => {
          proxyReconnectTimer = null;
          connectToExistingBridge();
        }, 2000);
      }
    });
    ws.on("error", (err) => {
      logToFile(`MCP proxy socket error: ${err?.message}`);
    });
  } catch (e) {
    logToFile(`MCP proxy connect failed: ${e?.message}`);
    if (!proxyReconnectTimer) {
      proxyReconnectTimer = setTimeout(() => {
        proxyReconnectTimer = null;
        connectToExistingBridge();
      }, 2000);
    }
  }
}

function startWebSocketServer() {
  bindAttempts++;
  wss = new WebSocketServer({
    host: BRIDGE_HOST,
    port: BRIDGE_PORT,
    maxPayload: 128 * 1024 * 1024,
  });
  wss.on("listening", () => {
    logToFile(`WebSocket server listening on ${BRIDGE_HOST}:${BRIDGE_PORT} (owner mode)`);
  });
  wss.on("error", (err) => {
    if (err?.code === "EADDRINUSE") {
      logToFile(`Port ${BRIDGE_PORT} busy - switching to MCP proxy mode`);
      try { wss.close(); } catch {}
      wss = null;
      connectToExistingBridge();
    } else {
      logToFile(`WebSocket server error: ${err?.stack || err}`);
      console.error("[Bridge] WebSocket server error:", err);
    }
  });
  wss.on("connection", (ws, req) => {
    const remote = req.socket.remoteAddress || "";
    const loopback = remote === "127.0.0.1"
      || remote === "::1"
      || remote === "::ffff:127.0.0.1"
      || remote === "localhost";
    if (!loopback && process.env.GEMINI_BRIDGE_ALLOW_REMOTE !== "1") {
      logToFile(`Rejected non-loopback WebSocket client: ${remote}`);
      ws.close(1008, "loopback only");
      return;
    }
    attachConnectionHandlers(ws);
  });
}

let chromeClient = null;
const pendingRequests = new Map();   // MCP requests: reqId -> {resolve, timeout}
const directRequests = new Map();    // Direct WS requests: reqId -> ws (from ask.mjs etc)
let requestIdCounter = 0;

// Ping all connected clients every 15s to keep connections alive
const keepaliveInterval = setInterval(() => {
  if (chromeClient && chromeClient.readyState === 1) { // OPEN
    chromeClient.ping();
  }
}, 15_000);

function attachConnectionHandlers(ws) {
  logToFile("New WebSocket client connected");
  let role = null;

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Identify handshake: extension or MCP proxy client.
      if (msg.action === "identify") {
        role = msg.role || "unknown";
        if (role === "extension") {
          chromeClient = ws;
          logToFile("Registered extension client");
          console.error("[Bridge] Extension connected");
        } else {
          logToFile(`Registered ${role} client`);
        }
        return;
      }

      // Ignore keepalive pings
      if (msg.action === "ping") return;

      // Forward a cookie-export request to the extension.
      if (msg.action === "getCookies") {
        if (chromeClient && chromeClient.readyState === 1) {
          if (ws !== chromeClient) directRequests.set(msg.requestId, ws);
          chromeClient.send(JSON.stringify(msg), (err) => {
            if (err) logToFile(`Error forwarding getCookies: ${err.message}`);
          });
        } else {
          if (ws !== chromeClient) {
            ws.send(JSON.stringify({
              text: JSON.stringify({ error: "Chrome extension not connected" }),
              requestId: msg.requestId,
            }));
          }
        }
        return;
      }

      // If it's an "ask" request (from a proxy MCP server or ask.mjs), forward
      // to the extension and remember which socket should receive the reply.
      if (msg.action === "ask") {
        if (chromeClient && chromeClient.readyState === 1) {
          if (ws !== chromeClient) {
            directRequests.set(msg.requestId, ws);
          }
          logToFile(`Forwarding ask to extension (req: ${msg.requestId})`);
          chromeClient.send(JSON.stringify(msg), (err) => {
            if (err) logToFile(`Error forwarding: ${err.message}`);
          });
        } else {
          logToFile("Cannot forward ask: extension not connected");
          if (ws !== chromeClient) {
            ws.send(JSON.stringify({
              text: "Error: Chrome extension not connected. Open a Gemini page with the extension loaded.",
              requestId: msg.requestId,
            }));
          }
        }
        return;
      }

      // Treat as a response to a pending request
      let reqId = msg.requestId;

      // First check: direct WS requests (proxy MCP servers / ask.mjs)
      if (reqId && directRequests.has(reqId)) {
        logToFile(`Direct response (${msg.text?.length ?? 0} chars) for req ${reqId}`);
        const wsTarget = directRequests.get(reqId);
        directRequests.delete(reqId);
        if (wsTarget && wsTarget.readyState === 1) {
          wsTarget.send(JSON.stringify({ text: msg.text, requestId: reqId, attachments: msg.attachments }));
        }
        return;
      }

      // Second check: MCP pending requests (owner-mode tool call)
      let req = null;
      if (reqId) {
        req = pendingRequests.get(reqId);
      } else if (pendingRequests.size > 0) {
        reqId = pendingRequests.keys().next().value;
        req = pendingRequests.get(reqId);
        logToFile(`Warning: No requestId, fallback to req ${reqId}`);
      }

      if (req) {
        logToFile(`MCP response (${msg.text?.length ?? 0} chars) for req ${reqId}`);
        clearTimeout(req.timeout);
        pendingRequests.delete(reqId);
        req.resolve(formatResponse(msg.text, msg.attachments, req.downloadDir));
      } else {
        logToFile(`No matching pending request (reqId: ${reqId})`);
      }
    } catch (e) {
      logToFile(`Parse error: ${e?.message}`);
    }
  });

  ws.on("close", () => {
    logToFile("WebSocket client disconnected");
    if (chromeClient === ws) {
      chromeClient = null;
      logToFile("chromeClient set to null");
    }
  });

  ws.on("error", (err) => {
    logToFile(`WebSocket error: ${err?.message}`);
    if (chromeClient === ws) {
      chromeClient = null;
    }
  });
}

startWebSocketServer();

const server = new Server(
  { name: "gemini-web-bridge", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  logToFile("ListToolsRequest called by MCP client");
  return {
    tools: [
      {
        name: "ask_gemini_web",
        description:
          "Send a prompt to Gemini Pro via the browser extension. Optionally upload local files and save files Gemini returns.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "The prompt to send to Gemini",
            },
            files: {
              type: "array",
              items: { type: "string" },
              description: "Optional local file paths to upload with the prompt.",
            },
            download_dir: {
              type: "string",
              description: "Optional local directory where returned attachments should be saved. Defaults to the OS temp folder.",
            },
          },
          required: ["prompt"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  logToFile(`CallToolRequest: ${request.params.name}`);
  if (request.params.name !== "ask_gemini_web") {
    logToFile(`Error: Unknown tool ${request.params.name}`);
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const prompt = String(request.params.arguments?.prompt ?? "");
  const downloadDir = typeof request.params.arguments?.download_dir === "string"
    ? request.params.arguments.download_dir
    : undefined;
  const requestedFiles = Array.isArray(request.params.arguments?.files)
    ? request.params.arguments.files
    : [];
  const files = [];
  const fileErrors = [];
  let totalFileBytes = 0;
  for (const filePath of requestedFiles) {
    try {
      const abs = path.resolve(String(filePath));
      const stat = fs.statSync(abs);
      if (!stat.isFile()) {
        fileErrors.push(`${filePath}: not a file`);
        continue;
      }
      if (stat.size > 20 * 1024 * 1024) {
        fileErrors.push(`${filePath}: larger than 20 MiB`);
        continue;
      }
      if (totalFileBytes + stat.size > 60 * 1024 * 1024) {
        fileErrors.push(`${filePath}: total upload would exceed 60 MiB`);
        continue;
      }
      totalFileBytes += stat.size;
      files.push({
        name: path.basename(abs),
        mimeType: mimeFromPath(abs),
        data: fs.readFileSync(abs).toString("base64"),
      });
    } catch (e) {
      fileErrors.push(`${filePath}: ${e?.message || "unreadable"}`);
    }
  }
  if (fileErrors.length > 0) {
    return {
      content: [{
        type: "text",
        text: `Error reading files:\n${fileErrors.map((e) => `- ${e}`).join("\n")}`,
      }],
    };
  }

  // Proxy mode: another MCP server owns port 8085 and talks to the extension.
  // Relay this workspace's ask through it.
  if (proxyMode) {
    const requestId = `req_${Date.now()}_${++requestIdCounter}`;
    if (!proxySocket || proxySocket.readyState !== WebSocket.OPEN) {
      logToFile("Warning: MCP proxy socket not connected yet, waiting up to 10s...");
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (proxySocket && proxySocket.readyState === WebSocket.OPEN) break;
      }
    }
    if (!proxySocket || proxySocket.readyState !== WebSocket.OPEN) {
      logToFile("Error: MCP proxy socket not connected");
      return {
        content: [{
          type: "text",
          text: "Error: Gemini bridge proxy is not connected. Make sure the Chrome extension is loaded and a Gemini tab is open.",
        }],
      };
    }
    logToFile(`Proxy sending prompt (${prompt.length} chars) req: ${requestId}...`);
    return await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        logToFile(`Error: Proxy request ${requestId} timed out after 600s`);
        proxyPending.delete(requestId);
        resolve({
          content: [{
            type: "text",
            text: `Error: Request timed out after 600s. Gemini may still be generating (req: ${requestId}).`,
          }],
        });
      }, 600_000);
      proxyPending.set(requestId, { resolve, timeout, downloadDir });
      proxySocket.send(JSON.stringify({ action: "ask", prompt, requestId, files }), (err) => {
        if (err) {
          clearTimeout(timeout);
          proxyPending.delete(requestId);
          resolve({ content: [{ type: "text", text: `Error sending to bridge: ${err.message}` }] });
        }
      });
    });
  }

  // Attendre la connexion si l'extension se reconnecte
  if (!chromeClient) {
    logToFile("Warning: Chrome extension not connected, waiting up to 20s...");
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (chromeClient) {
        logToFile("Extension reconnected during wait time");
        break;
      }
    }
  }

  if (!chromeClient) {
    logToFile("Error: Chrome extension not connected (no client)");
    return {
      content: [
        {
          type: "text",
          text: "Error: Chrome extension not connected. Open a Gemini page with the extension loaded.",
        },
      ],
    };
  }

  const requestId = `req_${Date.now()}_${++requestIdCounter}`;
  logToFile(`Sending prompt (${prompt.length} chars) to extension (req: ${requestId})...`);
  console.error(`[Bridge] Sending prompt (${prompt.length} chars, req: ${requestId})...`);

  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        logToFile(`Error: Request ${requestId} timed out after 600s`);
        pendingRequests.delete(requestId);
        resolve({
          content: [
            {
              type: "text",
              text: `Error: Request timed out after 600s. Gemini may still be generating (req: ${requestId}).`,
            },
          ],
        });
      }, 600_000);

      pendingRequests.set(requestId, { resolve, timeout, downloadDir });

      chromeClient.send(JSON.stringify({ action: "ask", prompt, requestId, files }), (err) => {
        if (err) {
          logToFile(`Error sending to extension via WS for req ${requestId}: ${err.message}`);
          clearTimeout(timeout);
          pendingRequests.delete(requestId);
          resolve({
            content: [{ type: "text", text: `Error sending to extension: ${err.message}` }],
          });
        }
      });
    });
  } catch (err) {
    logToFile(`Request error wrapper: ${err?.message}`);
    console.error("[Bridge] Request error:", err);
    return {
      content: [{ type: "text", text: `Internal error: ${err.message}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
logToFile("MCP server ready on stdio");
console.error("[Bridge] MCP server ready on stdio");
