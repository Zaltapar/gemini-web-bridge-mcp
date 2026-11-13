chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "inject") {
    executeGeminiPrompt(message.prompt, message.requestId, message.files || []);
  }
  if (message.action === "getMode") {
    sendResponse(detectGeminiMode());
    return true;
  }
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function detectGeminiMode() {
  try {
    const pill = document.querySelector('[data-test-id="logo-pill-label-container"]');
    if (!pill) return { model: 'unknown', extendedThinking: false };

    const primary = pill.querySelector('.picker-primary-text');
    const secondary = pill.querySelector('.picker-secondary-text');

    const model = primary?.textContent?.trim() || 'unknown';
    const thinking = secondary?.textContent?.trim() || '';

    return {
      model,
      extendedThinking: thinking.toLowerCase().includes('extended')
    };
  } catch {
    return { model: 'unknown', extendedThinking: false };
  }
}

async function executeGeminiPrompt(prompt, requestId, files) {
  try {
    await doInject(prompt, requestId, files);
  } catch (e) {
    console.error("[Gemini Bridge] Error:", e);
    chrome.runtime.sendMessage({ action: "response", text: `Error: ${e.message}`, requestId });
  }
}

async function doInject(prompt, requestId, files) {
  const mode = detectGeminiMode();
  const timeoutMs = mode.extendedThinking ? 900_000 : 300_000;
  console.log(`[Gemini Bridge] Mode: ${mode.model}${mode.extendedThinking ? ' + Extended' : ''}, timeout: ${timeoutMs / 1000}s`);

  // 1. Find input field
  const inputEl = findInput();
  if (!inputEl) throw new Error("Input field not found");

  // 2. Attach files first (if any), then wait for Gemini to finish ingesting them.
  if (Array.isArray(files) && files.length > 0) {
    await attachFiles(files);
    await waitForUploads(120_000);
  }

  // 3. Count existing response containers before sending
  const initialCount = document.querySelectorAll(".response-container").length;

  // 4. Paste prompt
  inputEl.focus();
  document.execCommand("insertText", false, prompt);
  inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(800);

  // 5. Click send button
  const sendBtn = findSendButton();
  if (!sendBtn) throw new Error("Send button not found");
  sendBtn.click();

  // 6. Wait for new response container to appear and stabilize
  const result = await waitForNewResponse(initialCount, timeoutMs);
  if (!result || !result.text) throw new Error("No response text extracted");

  // Give lazy-loaded images/attachments a moment to settle.
  await sleep(1200);
  const attachments = result.container
    ? await extractAttachments(result.container)
    : [];

  chrome.runtime.sendMessage({
    action: "response",
    text: result.text,
    requestId,
    mode,
    attachments
  });
}

function findInput() {
  const selectors = [
    "rich-textarea [contenteditable]",
    "[contenteditable='true']",
    "textarea",
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) return el;
  }
  return null;
}

function deepQueryAll(selector, root = document) {
  const results = [...root.querySelectorAll(selector)];
  for (const el of root.querySelectorAll("*")) {
    if (el.shadowRoot) results.push(...deepQueryAll(selector, el.shadowRoot));
  }
  return results;
}

function isVisible(el) {
  return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
}

function describeElement(el) {
  return {
    tag: el.tagName,
    role: el.getAttribute("role"),
    aria: el.getAttribute("aria-label"),
    title: el.getAttribute("title"),
    testid: el.getAttribute("data-test-id"),
    text: (el.innerText || "").trim().slice(0, 100),
    cls: String(el.className || "").slice(0, 160),
  };
}

function findFileInput() {
  const inputs = deepQueryAll("input[type='file']");
  if (inputs.length === 0) return null;
  // The upload input is usually the multi-file one, or one that accepts docs/images.
  return inputs.find((i) => i.multiple)
    || inputs.find((i) => /image|pdf|text|application|video|audio/i.test(i.accept || ""))
    || inputs[0];
}

function uploadCandidates() {
  const els = [
    ...deepQueryAll("button"),
    ...deepQueryAll("[role='button']"),
    ...deepQueryAll("[role='menuitem']"),
  ];
  const seen = new Set();
  return els.filter((el) => {
    if (seen.has(el) || !isVisible(el)) return false;
    seen.add(el);
    const hay = [
      el.getAttribute("aria-label"),
      el.getAttribute("title"),
      el.getAttribute("data-test-id"),
      el.innerText,
      el.className,
    ].join(" ").toLowerCase();
    return /add|upload|attach|file|plus|image|drive/.test(hay)
      && !/send|microphone|mic|stop|settings|menu|more/.test(hay);
  });
}

function findSendButton() {
  const selectors = [
    "button[aria-label*='Envoyer']",
    "button[aria-label*='envoyer']",
    "button[aria-label*='Send']",
    "button[aria-label*='send']",
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) return el;
  }
  // Fallback: last visible non-stop button near the input area
  const area = document.querySelector("rich-textarea")?.closest("div[class*='container']");
  if (area) {
    const btns = [...area.querySelectorAll("button:not([disabled])")];
    for (let i = btns.length - 1; i >= 0; i--) {
      if (btns[i].offsetParent !== null &&
          !btns[i].ariaLabel?.toLowerCase().includes("stop")) return btns[i];
    }
  }
  return null;
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function extFromMime(mime) {
  const map = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "application/pdf": "pdf",
    "text/plain": "txt",
    "text/csv": "csv",
    "application/json": "json",
    "application/zip": "zip",
  };
  return map[mime] || "bin";
}

async function attachFiles(files) {
  let input = findFileInput();

  // Gemini often creates the upload input lazily. Clicking the "+" button opens
  // the attachment menu without opening a native file dialog.
  if (!input) {
    const addBtn = uploadCandidates().find((el) => {
      const hay = [
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.getAttribute("data-test-id"),
        el.innerText,
      ].join(" ").toLowerCase();
      return /add files|add file|upload|attach|plus|add/i.test(hay);
    });
    if (addBtn) {
      addBtn.click();
      await sleep(900);
      input = findFileInput();
    }
  }

  if (!input) {
    const candidates = uploadCandidates().map(describeElement);
    throw new Error(
      "Gemini file input not found. Visible candidates: "
      + JSON.stringify(candidates).slice(0, 1800)
    );
  }

  const dt = new DataTransfer();
  for (const f of files) {
    if (!f || typeof f.data !== "string") continue;
    const bytes = base64ToBytes(f.data);
    const file = new File([bytes], f.name || "file", {
      type: f.mimeType || "application/octet-stream",
    });
    dt.items.add(file);
  }
  if (dt.files.length === 0) throw new Error("No valid files to upload");

  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new Event("input", { bubbles: true }));
  console.log(`[Gemini Bridge] Attached ${dt.files.length} file(s)`);
}

async function waitForUploads(timeoutMs) {
  const started = Date.now();
  let readyTicks = 0;
  while (Date.now() - started < timeoutMs) {
    await sleep(500);
    const input = findFileInput();
    const count = input?.files?.length || 0;
    const composer = input?.closest("form")
      || input?.closest("[class*='input']")
      || document.body;
    const text = composer?.innerText || "";
    const busy = /uploading|processing|preparing|analyzing|reading|loading/i.test(text)
      || !!document.querySelector("[role='progressbar']");
    const send = findSendButton();
    const enabled = !send || !send.disabled;

    if (count > 0 && !busy && enabled) {
      readyTicks++;
      if (readyTicks >= 2) {
        console.log("[Gemini Bridge] Uploads look ready");
        return;
      }
    } else {
      readyTicks = 0;
    }
  }
  console.warn("[Gemini Bridge] Upload wait timed out; sending anyway");
}

function latestResponseContainer() {
  const containers = document.querySelectorAll(".response-container");
  return containers.length > 0 ? containers[containers.length - 1] : null;
}

function extractTextFromContainer(container) {
  if (!container) return "";
  const markdown = container.querySelector("message-content .markdown, .model-response-text .markdown");
  if (markdown) {
    const text = markdown.innerText?.trim();
    if (text) return text;
  }
  const content = container.querySelector(".response-container-content");
  if (content) {
    const text = content.innerText?.trim();
    if (text) return text;
  }
  return container.innerText?.trim() || "";
}

async function waitForNewResponse(initialCount, timeoutMs) {
  return new Promise((resolve) => {
    let stableTimer = null;
    let lastText = "";
    let lastChange = Date.now();

    const finish = (container, text) => {
      resolve({ container, text });
    };

    const obs = new MutationObserver(() => {
      const containers = document.querySelectorAll(".response-container");
      if (containers.length <= initialCount) return;

      const latest = containers[containers.length - 1];
      const markdown = latest.querySelector("message-content .markdown, .model-response-text .markdown");
      if (!markdown) return;

      const text = markdown.innerText?.trim() || "";
      if (!text) return;

      if (text !== lastText) {
        lastText = text;
        lastChange = Date.now();
        if (stableTimer) clearTimeout(stableTimer);
        stableTimer = setTimeout(() => {
          obs.disconnect();
          finish(latest, text);
        }, 10000);
      }
    });

    obs.observe(document.body, { childList: true, subtree: true, characterData: true });

    setTimeout(() => {
      obs.disconnect();
      if (stableTimer) clearTimeout(stableTimer);
      const container = latestResponseContainer();
      finish(container, extractTextFromContainer(container));
    }, timeoutMs);
  });
}

async function fetchAsBase64(url) {
  if (!url) return null;

  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    if (comma < 0) return null;
    const meta = url.slice(5, comma);
    const mimeType = meta.split(";")[0] || "application/octet-stream";
    return { base64: url.slice(comma + 1), mimeType };
  }

  if (url.startsWith("blob:")) {
    try {
      const resp = await fetch(url);
      const blob = await resp.blob();
      return { base64: await blobToBase64(blob), mimeType: blob.type || "application/octet-stream" };
    } catch {
      return null;
    }
  }

  // Prefer the extension background page: it can fetch cross-origin assets.
  try {
    const res = await chrome.runtime.sendMessage({ action: "fetchAttachment", url });
    if (res?.ok && res.data) {
      return { base64: res.data, mimeType: res.mimeType || "application/octet-stream" };
    }
  } catch {}

  try {
    const resp = await fetch(url, { credentials: "include" });
    if (!resp.ok) return null;
    const blob = await resp.blob();
    return { base64: await blobToBase64(blob), mimeType: blob.type || "application/octet-stream" };
  } catch {
    return null;
  }
}

async function extractAttachments(container) {
  const out = [];
  const seen = new Set();

  for (const img of container.querySelectorAll("img")) {
    const src = img.currentSrc || img.src;
    if (!src || seen.has(src)) continue;
    if ((img.naturalWidth || 0) < 64 || (img.naturalHeight || 0) < 64) continue;
    seen.add(src);
    const data = await fetchAsBase64(src);
    if (!data || !data.base64) continue;
    if (data.base64.length > 28_000_000) continue; // ~20 MiB encoded
    out.push({
      name: `gemini-image-${out.length + 1}.${extFromMime(data.mimeType)}`,
      mimeType: data.mimeType,
      data: data.base64,
    });
  }

  for (const a of container.querySelectorAll("a[href]")) {
    const href = a.href;
    if (!href || seen.has(href)) continue;
    const download = a.getAttribute("download");
    const looksLikeFile = !!download
      || /\.(pdf|zip|txt|csv|docx?|xlsx?|pptx?|json|md|py|js|ts|html?|png|jpe?g|webp|gif)(\?|$)/i.test(href);
    if (!looksLikeFile) continue;
    seen.add(href);
    const data = await fetchAsBase64(href);
    if (!data || !data.base64) continue;
    if (data.base64.length > 28_000_000) continue;
    let name = download;
    if (!name) {
      try {
        name = decodeURIComponent(new URL(href).pathname.split("/").pop() || "");
      } catch {}
    }
    out.push({
      name: name || `gemini-file-${out.length + 1}.${extFromMime(data.mimeType)}`,
      mimeType: data.mimeType || "application/octet-stream",
      data: data.base64,
    });
  }

  return out;
}
