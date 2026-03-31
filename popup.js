/**
 * AI Reader Lens — Popup Script (v2.0)
 * Handles API key save/load and lens toggle from the toolbar popup.
 */

document.addEventListener('DOMContentLoaded', () => {

  const apiInput  = document.getElementById('api-key');
  const saveBtn   = document.getElementById('save-btn');
  const statusEl  = document.getElementById('save-status');
  const toggleBtn = document.getElementById('toggle-btn');
  const apiDot    = document.getElementById('api-dot');
  const apiLabel  = document.getElementById('api-label');

  // ── Load saved API key ─────────────────────────────────────
  chrome.storage.local.get(['geminiApiKey'], result => {
    if (result.geminiApiKey) {
      apiInput.value = result.geminiApiKey;
      setDot(true);
    }
  });

  // ── Save API key ───────────────────────────────────────────
  saveBtn.addEventListener('click', () => {
    const key = apiInput.value.trim();

    if (!key) {
      showStatus('Please enter a valid API key.', 'err');
      return;
    }
    if (!key.startsWith('AIza') || key.length < 20) {
      showStatus("Doesn't look like a valid Gemini key (should start with AIza…)", 'err');
      return;
    }

    chrome.storage.local.set({ geminiApiKey: key }, () => {
      showStatus('✓ Key saved!', 'ok');
      setDot(true);

      // Notify any open content scripts
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'API_KEY_UPDATED', key }).catch(() => {});
        }
      });
    });
  });

  // ── Toggle Lens ────────────────────────────────────────────
  toggleBtn.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (!tabs[0]) return;
      chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: () => {
          // Toggle the lens via the FAB button in the content script
          const fab = document.getElementById('ai-rl-fab');
          if (fab) fab.click();
        }
      }).catch(err => console.warn('[AI Reader Popup] Script injection failed:', err.message));
    });
  });

  // ── Helpers ────────────────────────────────────────────────
  function showStatus(msg, type) {
    statusEl.textContent = msg;
    statusEl.className = type;
    setTimeout(() => {
      statusEl.textContent = '';
      statusEl.className = '';
    }, 3500);
  }

  function setDot(hasKey) {
    if (hasKey) {
      apiDot.classList.add('ok');
      apiLabel.textContent = 'API key saved ✓';
    } else {
      apiDot.classList.remove('ok');
      apiLabel.textContent = 'No key saved';
    }
  }

});
