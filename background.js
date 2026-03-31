/**
 * AI Reader Lens — Background Service Worker (v2.0)
 * Handles Gemini API requests and settings persistence.
 * Runs as a Manifest V3 module service worker.
 */

// ─── Message Router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {

    case 'GEMINI_REQUEST':
      handleGeminiRequest(message.payload)
        .then(result => sendResponse({ success: true,  data: result }))
        .catch(err   => sendResponse({ success: false, error: err.message }));
      return true; // Keep channel open for async response

    case 'SAVE_SETTINGS':
      chrome.storage.local.set(message.payload, () => {
        sendResponse({ success: true });
      });
      return true;

    case 'GET_SETTINGS':
      chrome.storage.local.get(null, items => {
        sendResponse({ success: true, data: items });
      });
      return true;

    case 'AI_REQUEST': {
      // Compatibility with ext2 message format
      const { text, mode } = message.payload;
      chrome.storage.local.get(['geminiApiKey'], result => {
        const apiKey = result.geminiApiKey || '';
        handleGeminiRequest({ text, mode, apiKey })
          .then(data    => sendResponse({ success: true,  content: data }))
          .catch(err    => sendResponse({ success: false, error: err.message }));
      });
      return true;
    }

    default:
      sendResponse({ success: false, error: 'Unknown message type' });
  }
});

// ─── Gemini API Integration ───────────────────────────────────────────────────

/**
 * Sends a request to the Gemini API.
 * @param {{ text: string, mode: string, apiKey: string }} payload
 * @returns {Promise<string>} AI-generated response text
 */
async function handleGeminiRequest({ text, mode, apiKey }) {
  if (!apiKey) {
    throw new Error('No Gemini API key configured. Click the extension icon to add it.');
  }

  const prompt = buildPrompt(text, mode);
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature:    0.7,
      topK:           40,
      topP:           0.95,
      maxOutputTokens: 1024
    }
  };

  const response = await fetch(endpoint, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body)
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Gemini API error: ${response.status}`);
  }

  const data = await response.json();
  const generated = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!generated) throw new Error('Empty response from Gemini API.');
  return generated;
}

/**
 * Builds a reading-mode-specific prompt for the AI.
 * @param {string} text  - The text to analyze
 * @param {string} mode  - 'meta-read' | 'instru-read'
 * @returns {string}
 */
function buildPrompt(text, mode) {
  const base = `TEXT:\n"""\n${text}\n"""`;

  if (mode === 'meta-read' || mode === 'meta') {
    return `You are an intelligent reading assistant. Analyze the following text and provide:
1. A plain-English summary (2-3 sentences)
2. Key concepts or terms explained simply
3. The main takeaway

Keep your response conversational, clear, and suitable for text-to-speech. Use flowing sentences, not bullet points.

${base}`;
  }

  if (mode === 'instru-read' || mode === 'instru') {
    return `You are an expert educational guide. Analyze the following text and provide:
1. A guided walkthrough of the main ideas
2. Real-world analogies or examples for complex concepts
3. Step-by-step breakdown if there's a process involved
4. A memorable insight or visualization tip

Keep your response engaging, clear, and suitable for text-to-speech. Use flowing prose, not bullet points.

${base}`;
  }

  return text; // Normal mode fallback
}
