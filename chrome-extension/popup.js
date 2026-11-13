let currentFocusedTabId = null;

function getStatus() {
  document.getElementById('error-text').textContent = '';
  chrome.runtime.sendMessage({ action: 'getStatus' }, (status) => {
    if (chrome.runtime.lastError) {
      document.getElementById('error-text').textContent =
        'Error: ' + chrome.runtime.lastError.message;
      return;
    }
    render(status);
  });
}

function render(status) {
  renderServerStatus(status);
  renderMode(status);
  renderTabList(status);
  renderGlobalStatus(status);
}

function renderMode(status) {
  const el = document.getElementById('mode-display');
  const mode = status.mode;

  if (!status.focusedTabId || !mode || mode.model === 'unknown') {
    el.innerHTML = '<span class="mode-unknown">Waiting for first prompt...</span>';
    return;
  }

  const thinkingLabel = mode.extendedThinking ? 'Extended' : 'Standard';
  const thinkingClass = mode.extendedThinking ? 'extended' : 'off';

  el.innerHTML = `
    <div class="mode-display">
      <span class="mode-model">${mode.model}</span>
      <span class="mode-thinking ${thinkingClass}">${thinkingLabel}</span>
    </div>
  `;
}

function renderServerStatus(status) {
  const dot = document.getElementById('server-dot');
  const text = document.getElementById('server-text');

  if (status.connected) {
    dot.className = 'dot green';
    text.textContent = 'Connected to local server (port 8085)';
  } else {
    dot.className = 'dot red';
    text.textContent = 'Disconnected — Make sure server.js is running';
  }
}

function renderTabList(status) {
  const container = document.getElementById('tab-list');
  container.innerHTML = '';

  if (!status.tabs || status.tabs.length === 0) {
    container.innerHTML =
      '<div class="empty-state">No Gemini tabs open.<br>Open https://gemini.google.com</div>';
    return;
  }

  for (const tab of status.tabs) {
    const div = document.createElement('div');
    div.className = 'tab-item' + (tab.focused ? ' focused' : '');

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'gemini-tab';
    radio.checked = !!tab.focused;
    radio.addEventListener('change', () => {
      if (radio.checked) {
        focusTab(tab.tabId);
      }
    });

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title || 'Gemini tab';
    title.title = tab.title || '';

    div.appendChild(radio);
    div.appendChild(title);

    if (tab.focused) {
      const badge = document.createElement('span');
      badge.className = 'focus-badge';
      badge.textContent = 'FOCUS';
      div.appendChild(badge);
      currentFocusedTabId = tab.tabId;
    }

    // Click on the whole row toggles the radio
    div.addEventListener('click', (e) => {
      if (e.target !== radio) {
        radio.checked = true;
        focusTab(tab.tabId);
      }
    });

    container.appendChild(div);
  }
}

function renderGlobalStatus(status) {
  const el = document.getElementById('global-status');
  const connected = status.connected;
  const hasTabs = status.tabs && status.tabs.length > 0;
  const hasFocus = status.focusedTabId != null;

  if (connected && hasTabs && hasFocus) {
    el.className = 'global-status ok';
    el.textContent = '✓ All good — Ready to relay prompts';
  } else if (!connected) {
    el.className = 'global-status err';
    el.textContent = '✗ Server disconnected — Start server.js';
  } else if (!hasTabs) {
    el.className = 'global-status warn';
    el.textContent = '⚠ No Gemini tab — Open gemini.google.com';
  } else if (!hasFocus) {
    el.className = 'global-status warn';
    el.textContent = '⚠ No tab selected — Click a tab above';
  }
}

function focusTab(tabId) {
  chrome.runtime.sendMessage(
    { action: 'focusTab', tabId },
    (response) => {
      if (chrome.runtime.lastError) {
        document.getElementById('error-text').textContent =
          'Error: ' + chrome.runtime.lastError.message;
        return;
      }
      // Refresh status to show updated focus
      getStatus();
    }
  );
}

document.getElementById('refresh-btn').addEventListener('click', getStatus);

// Initial load
getStatus();
