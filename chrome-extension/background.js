const BRIDGE_URL = 'ws://127.0.0.1:8085';

let ws = null;
let reconnectTimer = null;
let pendingResponseObj = null;
let keepaliveTimer = null;

// Tab tracking — which Gemini tabs are open and which one is "focused"
let geminiTabIds = new Set();
let focusedTabId = null;
let currentMode = null;  // { model, extendedThinking } from last response

// ── Tab management ──────────────────────────────────────────────

function trackTab(tabId, url) {
  const isGemini = url && url.startsWith('https://gemini.google.com');
  const had = geminiTabIds.has(tabId);

  if (isGemini && !had) {
    geminiTabIds.add(tabId);
    // Auto-focus the first available tab
    if (focusedTabId === null) {
      focusedTabId = tabId;
    }
  } else if (!isGemini && had) {
    geminiTabIds.delete(tabId);
    if (focusedTabId === tabId) {
      focusedTabId = geminiTabIds.values().next().value || null;
    }
  }
}

// Listen for tab changes
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.url) trackTab(tab.id, tab.url);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url;
  if (url) trackTab(tabId, url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const had = geminiTabIds.has(tabId);
  geminiTabIds.delete(tabId);
  if (focusedTabId === tabId) {
    focusedTabId = geminiTabIds.values().next().value || null;
  }
});

// Initial scan of already-open Gemini tabs
chrome.tabs.query({ url: 'https://gemini.google.com/*' }).then((tabs) => {
  for (const tab of tabs) {
    geminiTabIds.add(tab.id);
    if (focusedTabId === null) focusedTabId = tab.id;
  }
});

// ── WebSocket connection to local server ────────────────────────

function connect() {
  if (ws?.readyState === WebSocket.OPEN) return;

  ws = new WebSocket(BRIDGE_URL);

  ws.onopen = () => {
    console.log('[Bridge BG] WebSocket connected');
    ws.send(JSON.stringify({ action: 'identify', role: 'extension' }));
    if (pendingResponseObj) {
      console.log('[Bridge BG] Sending pending response for req', pendingResponseObj.requestId);
      ws.send(JSON.stringify(pendingResponseObj));
      pendingResponseObj = null;
    }
    startKeepalive();
  };

  ws.onmessage = async (event) => {
    const data = JSON.parse(event.data);

    if (data.action === 'getCookies') {
      try {
        const cookies = await chrome.cookies.getAll({ domain: '.google.com' });
        const psid = cookies.find((c) => c.name === '__Secure-1PSID')?.value || '';
        const psidts = cookies.find((c) => c.name === '__Secure-1PSIDTS')?.value || '';
        ws.send(JSON.stringify({
          text: JSON.stringify({ psid, psidts }),
          requestId: data.requestId
        }));
      } catch (e) {
        ws.send(JSON.stringify({
          text: JSON.stringify({ error: e.message }),
          requestId: data.requestId
        }));
      }
      return;
    }

    if (data.action === 'ask') {
      pendingResponseObj = null;
      try {
        // Use the focused tab, or fall back to any available Gemini tab
        let tabId = focusedTabId;
        if (tabId === null || !geminiTabIds.has(tabId)) {
          tabId = geminiTabIds.values().next().value;
          if (tabId) focusedTabId = tabId;
        }

        if (!tabId) {
          ws.send(JSON.stringify({
            text: 'Error: No Gemini tab open. Open https://gemini.google.com first.',
            requestId: data.requestId
          }));
          return;
        }

        sendToGeminiTab(tabId, {
          action: 'inject', prompt: data.prompt, requestId: data.requestId, files: data.files || []
        }).catch((err) => {
          console.error('[Bridge BG] Message send error:', err);
          ws.send(JSON.stringify({
            text: `Error sending to content script: ${err.message}. Please refresh the Gemini tab.`,
            requestId: data.requestId
          }));
        });
      } catch (e) {
        console.error('[Bridge BG] Error:', e);
        ws.send(JSON.stringify({
          text: `Error: ${e.message}`,
          requestId: data.requestId
        }));
      }
    }
  };

  ws.onclose = () => {
    console.log('[Bridge BG] WebSocket disconnected, reconnecting in 3s...');
    stopKeepalive();
    ws = null;
    reconnectTimer = setTimeout(connect, 3000);
  };

  ws.onerror = () => ws?.close();
}

async function sendToGeminiTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    const text = String(e?.message || e);
    if (!text.includes('Receiving end does not exist')) throw e;
    // The tab was open before the extension was reloaded. Inject the content
    // script programmatically, then retry once.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await new Promise((r) => setTimeout(r, 250));
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

function startKeepalive() {
  stopKeepalive();
  keepaliveTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ action: 'ping' })); } catch {}
    }
  }, 10_000);
}

function stopKeepalive() {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

// ── Message handlers ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Keepalive ping from content script
  if (message.action === 'ping') {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connect();
    }
    return;
  }

  // Response from content script (Gemini result)
  if (message.action === 'response') {
    if (message.mode) {
      currentMode = message.mode;
      console.log(`[Bridge BG] Response from ${message.mode.model}${message.mode.extendedThinking ? ' + Extended' : ''}, req ${message.requestId}`);
    }
    const respMsg = {
      text: message.text,
      requestId: message.requestId,
      attachments: message.attachments || []
    };
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(respMsg));
    } else {
      console.log('[Bridge BG] WebSocket not open, queueing response for req', message.requestId);
      pendingResponseObj = respMsg;
      connect();
    }
    return;
  }

  // Export Gemini auth cookies for the no-browser HTTP transport.
  if (message.action === 'getCookies') {
    chrome.cookies.getAll({ domain: '.google.com' })
      .then((cookies) => {
        const psid = cookies.find((c) => c.name === '__Secure-1PSID')?.value || '';
        const psidts = cookies.find((c) => c.name === '__Secure-1PSIDTS')?.value || '';
        const text = JSON.stringify({ psid, psidts });
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ text, requestId: message.requestId }));
        }
        sendResponse({ ok: !!psid });
      })
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // Fetch a generated attachment cross-origin on behalf of the content script.
  if (message.action === 'fetchAttachment') {
    fetch(message.url, { credentials: 'include' })
      .then(async (resp) => {
        if (!resp.ok) {
          sendResponse({ ok: false, status: resp.status });
          return;
        }
        const buf = await resp.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        sendResponse({
          ok: true,
          status: resp.status,
          mimeType: resp.headers.get('content-type') || 'application/octet-stream',
          data: btoa(binary)
        });
      })
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // Status request from popup
  if (message.action === 'getStatus') {
    const tabIds = [...geminiTabIds];
    const tabs = [];
    let completed = 0;

    const sendFinalResponse = () => {
      // Query the focused tab for its current Gemini mode
      const maybeQueryMode = focusedTabId
        ? chrome.tabs.sendMessage(focusedTabId, { action: 'getMode' })
            .then((mode) => { if (mode) currentMode = mode; })
            .catch(() => {})
        : Promise.resolve();

      maybeQueryMode.then(() => {
        sendResponse({ connected: !!(ws && ws.readyState === WebSocket.OPEN), tabs, focusedTabId, mode: currentMode });
      });
    };

    if (tabIds.length === 0) {
      sendFinalResponse();
      return true;
    }

    for (const tabId of tabIds) {
      chrome.tabs.get(tabId).then((tab) => {
        tabs.push({ tabId, title: tab.title, focused: tabId === focusedTabId });
        completed++;
        if (completed === tabIds.length) sendFinalResponse();
      }).catch(() => {
        geminiTabIds.delete(tabId);
        if (focusedTabId === tabId) focusedTabId = [...geminiTabIds][0] || null;
        completed++;
        if (completed === tabIds.length) sendFinalResponse();
      });
    }
    return true; // Keep channel open for async sendResponse
  }

  // Focus a specific tab from popup
  if (message.action === 'focusTab') {
    const tabId = message.tabId;
    if (geminiTabIds.has(tabId)) {
      focusedTabId = tabId;
      // Also bring the tab to the foreground
      chrome.tabs.update(tabId, { active: true }).catch(() => {});
    }
    sendResponse({ success: true });
    return;
  }
});

// ── Startup ──────────────────────────────────────────────────────

connect();
