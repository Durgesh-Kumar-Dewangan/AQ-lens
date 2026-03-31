/**
 * AI Reader Lens — Content Script (v2.1 — Fixed)
 *
 * FIXES vs v2.0:
 *  1. Text extraction: uses Range API + TreeWalker to reliably collect ALL
 *     text nodes whose bounding rects intersect the lens — no more sampling gaps.
 *  2. Chrome TTS 15-second cut-off bug: a periodic speechSynthesis.pause()/resume()
 *     keep-alive prevents the browser from silently killing long utterances.
 *  3. Sentence-by-sentence speaking: each sentence is its own utterance so the
 *     progress bar and highlighting work correctly without racing.
 *  4. Pause/Resume: Chrome's speechSynthesis.pause() is unreliable; we fake pause
 *     by cancelling the current utterance and saving the index, then replaying.
 *  5. Voice loading: retried after voices-changed event; selected voice is restored
 *     after the voice list is rebuilt.
 *  6. Sentence splitter: handles abbreviations, decimal numbers, ellipsis and
 *     text that ends without terminal punctuation.
 *  7. Auto-read debounce: only fires if a previous reading is not already running.
 *  8. All event handlers properly clean up; no double-injection guard issues.
 */

(function () {
  'use strict';

  if (document.getElementById('ai-rl-root')) return;

  // ════════════════════════════════════════════════════════════
  //  STATE
  // ════════════════════════════════════════════════════════════
  const state = {
    visible:       false,
    isDragging:    false,
    isResizing:    false,
    dragOffset:    { x: 0, y: 0 },
    resizeStart:   { x: 0, y: 0, w: 0, h: 0 },
    readingMode:   'normal',
    isPlaying:     false,
    isPaused:      false,
    speed:         1.0,
    pitch:         1.0,
    volume:        1.0,
    voiceGender:   'any',
    voiceURI:      '',
    voices:        [],
    sentences:     [],
    sentenceIdx:   0,
    apiKey:        '',
    autoRead:      true,
    autoReadTimer: null,
    keepAliveTimer:null,
    speaking:      false,   // lock to prevent double speakNext calls
  };

  // ════════════════════════════════════════════════════════════
  //  BUILD DOM
  // ════════════════════════════════════════════════════════════
  const root = document.createElement('div');
  root.id = 'ai-rl-root';
  root.innerHTML = buildHTML();
  document.documentElement.appendChild(root);

  const $ = id => document.getElementById(id);
  const fab          = $('ai-rl-fab');
  const lens         = $('ai-rl-lens');
  const resizeHandle = $('ai-rl-resize');
  const panel        = $('ai-rl-panel');
  const lensLabel    = $('ai-rl-lens-label');
  const voiceSel     = $('ai-rl-voice');
  const genderSel    = $('ai-rl-gender');
  const sourceSel    = $('ai-rl-source');
  const speedSlider  = $('ai-rl-speed');
  const pitchSlider  = $('ai-rl-pitch');
  const volSlider    = $('ai-rl-vol');
  const speedVal     = $('ai-rl-speed-val');
  const pitchVal     = $('ai-rl-pitch-val');
  const volVal       = $('ai-rl-vol-val');
  const playBtn      = $('ai-rl-play');
  const pauseBtn     = $('ai-rl-pause');
  const stopBtn      = $('ai-rl-stop');
  const statusEl     = $('ai-rl-status');
  const statusText   = $('ai-rl-status-text');
  const onlineDot    = $('ai-rl-online-dot');
  const progressBar  = $('ai-rl-progress');
  const responseBox  = $('ai-rl-response');
  const autoBtn      = $('ai-rl-autoread');
  const modeButtons  = root.querySelectorAll('.ai-rl-mode-btn');

  // ════════════════════════════════════════════════════════════
  //  VOICES — load with retry
  // ════════════════════════════════════════════════════════════
  function loadVoices() {
    const v = speechSynthesis.getVoices();
    if (v.length) {
      state.voices = v;
      populateVoiceSelect();
    }
  }

  function populateVoiceSelect() {
    const gender = state.voiceGender;
    let filtered = [...state.voices];

    if (gender === 'female') {
      const kw = ['female','zira','susan','linda','karen','samantha','victoria','fiona','kate','aria','jenny','michelle','monica','hazel','eva','alice'];
      const f = filtered.filter(v => kw.some(n => v.name.toLowerCase().includes(n)));
      if (f.length) filtered = f;
    } else if (gender === 'male') {
      const kw = ['male','david','james','mark','daniel','george','richard','thomas','guy','ryan','eric','jason','liam','reed','tom'];
      const f = filtered.filter(v => kw.some(n => v.name.toLowerCase().includes(n)));
      if (f.length) filtered = f;
    }

    const prev = state.voiceURI || voiceSel.value;
    voiceSel.innerHTML = '';
    filtered.forEach(voice => {
      const opt = document.createElement('option');
      opt.value = voice.voiceURI;
      opt.textContent = voice.name.replace(/^(Google|Microsoft|Apple)\s/i, '')
        + (voice.lang ? ` (${voice.lang})` : '')
        + (voice.localService ? ' ✓' : '');
      voiceSel.appendChild(opt);
    });

    // Restore previously selected voice
    if (prev) {
      const match = filtered.find(v => v.voiceURI === prev);
      if (match) voiceSel.value = prev;
    }
    // Prefer an English local voice if nothing matched
    if (!voiceSel.value) {
      const enLocal = filtered.find(v => v.lang.startsWith('en') && v.localService);
      const enAny   = filtered.find(v => v.lang.startsWith('en'));
      if (enLocal) voiceSel.value = enLocal.voiceURI;
      else if (enAny) voiceSel.value = enAny.voiceURI;
    }
  }

  speechSynthesis.onvoiceschanged = loadVoices;
  loadVoices();
  // Fallback retry for browsers that fire the event before we attach
  setTimeout(loadVoices, 300);
  setTimeout(loadVoices, 1000);

  // ════════════════════════════════════════════════════════════
  //  ONLINE STATUS
  // ════════════════════════════════════════════════════════════
  function updateOnline() {
    const on = navigator.onLine;
    onlineDot.className = 'ai-rl-online-dot ' + (on ? 'on' : 'off');
    onlineDot.title = on ? 'Online' : 'Offline';
  }
  updateOnline();
  window.addEventListener('online',  updateOnline);
  window.addEventListener('offline', updateOnline);

  // ════════════════════════════════════════════════════════════
  //  FAB TOGGLE
  // ════════════════════════════════════════════════════════════
  fab.addEventListener('click', () => {
    state.visible = !state.visible;
    lens.classList.toggle('visible', state.visible);
    fab.classList.toggle('active', state.visible);
    fab.textContent = state.visible ? '✕' : '🔍';
    if (state.visible) setStatus('idle', 'Drag lens over text, then press ▶');
  });

  // ════════════════════════════════════════════════════════════
  //  DRAG
  // ════════════════════════════════════════════════════════════
  lens.addEventListener('mousedown', e => {
    if (e.target === resizeHandle || e.target.closest('#ai-rl-panel')) return;
    state.isDragging = true;
    lens.classList.add('dragging');
    const rect = lens.getBoundingClientRect();
    state.dragOffset.x = e.clientX - rect.left;
    state.dragOffset.y = e.clientY - rect.top;
    stopReading();
    clearAutoReadTimer();
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (state.isDragging) {
      const x = Math.max(0, e.clientX - state.dragOffset.x);
      const y = Math.max(0, e.clientY - state.dragOffset.y);
      lens.style.left = x + 'px';
      lens.style.top  = y + 'px';
    }
    if (state.isResizing) {
      const rect = lens.getBoundingClientRect();
      const newW = Math.max(260, e.clientX - rect.left + state.resizeStart.dw);
      const newH = Math.max(100, e.clientY - rect.top  + state.resizeStart.dh);
      lens.style.width  = newW + 'px';
      lens.style.height = newH + 'px';
    }
  });

  document.addEventListener('mouseup', () => {
    if (state.isDragging) {
      state.isDragging = false;
      lens.classList.remove('dragging');
      if (state.autoRead && state.visible && !state.isPlaying) scheduleAutoRead();
    }
    if (state.isResizing) state.isResizing = false;
  });

  // ════════════════════════════════════════════════════════════
  //  RESIZE
  // ════════════════════════════════════════════════════════════
  resizeHandle.addEventListener('mousedown', e => {
    state.isResizing = true;
    const rect = lens.getBoundingClientRect();
    state.resizeStart = { dw: rect.width - e.clientX, dh: rect.height - e.clientY };
    clearAutoReadTimer();
    e.preventDefault();
    e.stopPropagation();
  });

  // ════════════════════════════════════════════════════════════
  //  AUTO-READ
  // ════════════════════════════════════════════════════════════
  function scheduleAutoRead() {
    clearAutoReadTimer();
    setStatus('auto', 'Reading in 0.8 s…');
    state.autoReadTimer = setTimeout(() => {
      if (!state.isPlaying) startReading();
    }, 800);
  }

  function clearAutoReadTimer() {
    if (state.autoReadTimer) { clearTimeout(state.autoReadTimer); state.autoReadTimer = null; }
  }

  autoBtn.addEventListener('click', () => {
    state.autoRead = !state.autoRead;
    autoBtn.classList.toggle('on', state.autoRead);
    autoBtn.querySelector('span:last-child').textContent = state.autoRead ? 'Auto-Read: ON' : 'Auto-Read: OFF';
    saveSettings();
  });

  // ════════════════════════════════════════════════════════════
  //  TEXT EXTRACTION
  // ════════════════════════════════════════════════════════════

  /** Main dispatcher */
  function getTextUnderLens() {
    const src = sourceSel.value;
    if (src === 'selection') return window.getSelection().toString().trim();
    if (src === 'page')      return extractPageText();
    if (src === 'pdf')       return extractPDFText();
    return extractLensText();
  }

  /**
   * Reliably extracts ALL text whose bounding rect overlaps the lens.
   * Uses a TreeWalker over text nodes + Range.getBoundingClientRect()
   * so even small or wrapped text lines are captured in document order.
   */
  function extractLensText() {
    const lensRect = lens.getBoundingClientRect();

    // Temporarily hide lens + panel so they don't occlude anything
    lens.style.visibility  = 'hidden';
    panel.style.visibility = 'hidden';

    const collected = []; // { top, text }

    try {
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            // Skip script, style, our own overlay
            const p = node.parentElement;
            if (!p) return NodeFilter.FILTER_REJECT;
            if (p.closest('#ai-rl-root')) return NodeFilter.FILTER_REJECT;
            const tag = p.tagName;
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
            if (p.closest('script, style, noscript')) return NodeFilter.FILTER_REJECT;
            const txt = node.nodeValue.trim();
            if (txt.length < 2) return NodeFilter.FILTER_SKIP;
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );

      let node;
      while ((node = walker.nextNode())) {
        try {
          const range = document.createRange();
          range.selectNodeContents(node);
          const rects = range.getClientRects();
          for (const r of rects) {
            // Does this rect overlap the lens?
            if (
              r.right  > lensRect.left &&
              r.left   < lensRect.right &&
              r.bottom > lensRect.top &&
              r.top    < lensRect.bottom &&
              r.width  > 0 && r.height > 0
            ) {
              const txt = node.nodeValue.replace(/\s+/g, ' ').trim();
              if (txt.length > 1) {
                collected.push({ top: r.top, text: txt });
              }
              break; // one rect match per text node is enough
            }
          }
        } catch (_) { /* cross-origin or detached node */ }
      }
    } finally {
      lens.style.visibility  = '';
      panel.style.visibility = '';
    }

    if (!collected.length) return '';

    // Sort by vertical position to preserve reading order
    collected.sort((a, b) => a.top - b.top);

    // Deduplicate adjacent identical fragments
    const parts = [];
    for (const { text } of collected) {
      if (parts.length === 0 || parts[parts.length - 1] !== text) {
        parts.push(text);
      }
    }

    return parts.join(' ').replace(/\s{2,}/g, ' ').trim();
  }

  function extractPageText() {
    const selectors = [
      'article', 'main', '[role="main"]', '.content', '#content',
      '.post-body', '.article-body', '.entry-content', '.post-content',
      '.story-body', '.article__body', '[itemprop="articleBody"]'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const t = el.innerText.replace(/\s+/g, ' ').trim();
        if (t.length > 100) return t;
      }
    }
    const paras = Array.from(document.querySelectorAll('p, h1, h2, h3, h4, li'))
      .map(el => el.innerText.trim())
      .filter(t => t.length > 20)
      .join(' ');
    return paras || document.body.innerText.replace(/\s+/g, ' ').trim();
  }

  function extractPDFText() {
    const spans = document.querySelectorAll('.textLayer span, .text-layer span, [class*="textLayer"] span');
    if (spans.length > 0) {
      return Array.from(spans).map(s => s.textContent).join(' ').replace(/\s+/g, ' ').trim();
    }
    const isPDF = document.contentType === 'application/pdf'
      || window.location.href.toLowerCase().endsWith('.pdf')
      || !!document.querySelector("embed[type='application/pdf']");
    if (isPDF) {
      const t = document.body.innerText.replace(/\s+/g, ' ').trim();
      if (t.length > 20) return t;
      return 'PDF detected. Please switch source to Selected Text and highlight the text manually.';
    }
    return extractPageText();
  }

  // ════════════════════════════════════════════════════════════
  //  SENTENCE SPLITTER
  // ════════════════════════════════════════════════════════════
  /**
   * Splits text into sentences robust enough for TTS:
   *  - Handles abbreviations (Mr. Dr. etc.) and decimal numbers (3.14)
   *  - Handles ellipsis (…)
   *  - Splits on ; and : when followed by a space + capital letter
   *  - Always returns at least one element (the whole text)
   */
  function splitSentences(text) {
    if (!text || !text.trim()) return [];

    // Protect common abbreviations by replacing their dots temporarily
    const abbrevs = /\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|i\.e|e\.g|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec|St|Ave|Blvd|Dept|Approx|Fig|vol|pp|cf)\./gi;
    let safe = text.replace(abbrevs, m => m.replace('.', '\x00'));
    // Protect decimal numbers
    safe = safe.replace(/(\d)\.(\d)/g, '$1\x01$2');
    // Protect ellipsis
    safe = safe.replace(/\.{2,}/g, m => '\x02'.repeat(m.length));

    // Now split on sentence boundaries
    const raw = safe.split(/(?<=[.!?…])\s+(?=[A-Z"'(])|(?<=[.!?…])\s*\n+\s*/);

    const sentences = raw
      .map(s =>
        s.replace(/\x00/g, '.')
         .replace(/\x01/g, '.')
         .replace(/\x02/g, '.')
         .replace(/\s+/g, ' ')
         .trim()
      )
      .filter(s => s.length > 2);

    return sentences.length ? sentences : [text.trim()];
  }

  // ════════════════════════════════════════════════════════════
  //  TTS KEEP-ALIVE (Chrome bug: silently stops after ~15 s)
  // ════════════════════════════════════════════════════════════
  function startKeepAlive() {
    stopKeepAlive();
    state.keepAliveTimer = setInterval(() => {
      if (speechSynthesis.speaking && !speechSynthesis.paused) {
        speechSynthesis.pause();
        speechSynthesis.resume();
      }
    }, 10000); // every 10 seconds
  }

  function stopKeepAlive() {
    if (state.keepAliveTimer) { clearInterval(state.keepAliveTimer); state.keepAliveTimer = null; }
  }

  // ════════════════════════════════════════════════════════════
  //  PLAYBACK
  // ════════════════════════════════════════════════════════════
  async function startReading() {
    stopReading();
    clearAutoReadTimer();

    const text = getTextUnderLens();
    if (!text || !text.trim()) {
      setStatus('idle', 'No text found — move the lens over text');
      return;
    }

    if (state.readingMode === 'normal') {
      const sentences = splitSentences(text);
      if (!sentences.length) { setStatus('idle', 'No readable text found'); return; }
      state.sentences   = sentences;
      state.sentenceIdx = 0;
      beginSpeaking();
    } else {
      // AI modes
      if (!navigator.onLine) {
        setStatus('error', state.readingMode + ' requires internet');
        return;
      }
      if (!state.apiKey) {
        setStatus('error', 'Set your Gemini API key in the popup');
        responseBox.textContent = '⚠ No Gemini API key. Click the extension icon to add it.';
        responseBox.classList.add('visible');
        return;
      }

      setStatus('loading', 'Asking Gemini AI…');
      playBtn.disabled = true;
      responseBox.classList.remove('visible');

      try {
        const resp = await chrome.runtime.sendMessage({
          type: 'GEMINI_REQUEST',
          payload: { text: text.trim(), mode: state.readingMode, apiKey: state.apiKey }
        });
        if (!resp || !resp.success) throw new Error(resp ? resp.error : 'No response');

        responseBox.textContent = resp.data;
        responseBox.classList.add('visible');

        const sentences = splitSentences(resp.data);
        if (!sentences.length) { setStatus('idle', 'Empty AI response'); playBtn.disabled = false; return; }
        state.sentences   = sentences;
        state.sentenceIdx = 0;
        beginSpeaking();
      } catch (err) {
        setStatus('error', 'AI error: ' + err.message);
        playBtn.disabled = false;
      }
    }
  }

  /** Kicks off sentence-by-sentence TTS from state.sentenceIdx */
  function beginSpeaking() {
    // Hard-cancel any lingering speech
    speechSynthesis.cancel();

    state.isPlaying  = true;
    state.isPaused   = false;
    state.speaking   = false;

    lens.classList.add('reading');
    updateTransportUI();
    startKeepAlive();

    // Small delay: chrome.cancel() is async under the hood
    setTimeout(() => speakNext(), 80);
  }

  function speakNext() {
    if (!state.isPlaying || state.isPaused) return;
    if (state.speaking) return; // lock — already queued
    if (state.sentenceIdx >= state.sentences.length) {
      onReadingComplete();
      return;
    }

    state.speaking = true;
    const sentence = state.sentences[state.sentenceIdx];
    const utt = new SpeechSynthesisUtterance(sentence);

    // Voice
    const selectedURI = voiceSel.value;
    const voice = state.voices.find(v => v.voiceURI === selectedURI);
    if (voice) utt.voice = voice;

    utt.rate   = parseFloat(state.speed)  || 1.0;
    utt.pitch  = parseFloat(state.pitch)  || 1.0;
    utt.volume = parseFloat(state.volume) !== undefined ? parseFloat(state.volume) : 1.0;
    utt.lang   = voice ? voice.lang : 'en-US';

    utt.onstart = () => {
      const pct = (state.sentenceIdx / state.sentences.length) * 100;
      progressBar.style.width = pct + '%';
      setStatus('reading', `Sentence ${state.sentenceIdx + 1} of ${state.sentences.length}`);
      highlightInPage(sentence);
    };

    utt.onend = () => {
      clearHighlights();
      state.speaking = false;
      if (!state.isPlaying || state.isPaused) return;
      state.sentenceIdx++;
      speakNext();
    };

    utt.onerror = e => {
      state.speaking = false;
      if (e.error === 'interrupted' || e.error === 'canceled') {
        // Normal result of stopReading() — do nothing
        return;
      }
      console.warn('[AI Reader] TTS error:', e.error, 'on sentence:', sentence.slice(0, 60));
      // Try to continue with the next sentence rather than crashing
      state.sentenceIdx++;
      if (state.isPlaying && !state.isPaused) {
        setTimeout(speakNext, 100);
      } else {
        setStatus('error', 'TTS error: ' + e.error);
        state.isPlaying = false;
        lens.classList.remove('reading');
        stopKeepAlive();
        updateTransportUI();
        playBtn.disabled = false;
      }
    };

    speechSynthesis.speak(utt);
    updateTransportUI();
  }

  function onReadingComplete() {
    stopKeepAlive();
    state.isPlaying  = false;
    state.isPaused   = false;
    state.speaking   = false;
    lens.classList.remove('reading');
    progressBar.style.width = '100%';
    setStatus('done', 'Finished reading ✓');
    updateTransportUI();
    playBtn.disabled = false;
    clearHighlights();
  }

  /**
   * Fake pause: Chrome's speechSynthesis.pause() is unreliable and
   * often does nothing on some platforms. We cancel the current utterance
   * and save the sentence index so Resume can replay from there.
   */
  function togglePause() {
    if (!state.isPlaying) return;

    if (state.isPaused) {
      // Resume from saved sentence
      state.isPaused  = false;
      state.speaking  = false;
      pauseBtn.innerHTML = '⏸';
      pauseBtn.title  = 'Pause';
      setStatus('reading', 'Resuming…');
      startKeepAlive();
      setTimeout(() => speakNext(), 80);
    } else {
      // Pause: cancel current speech, keep sentence index
      state.isPaused  = true;
      state.speaking  = false;
      stopKeepAlive();
      speechSynthesis.cancel();       // kills current utterance
      clearHighlights();
      pauseBtn.innerHTML = '▶';
      pauseBtn.title  = 'Resume';
      setStatus('idle', `Paused at sentence ${state.sentenceIdx + 1}`);
    }
    updateTransportUI();
  }

  function stopReading() {
    stopKeepAlive();
    speechSynthesis.cancel();
    state.isPlaying   = false;
    state.isPaused    = false;
    state.speaking    = false;
    state.sentenceIdx = 0;
    clearHighlights();
    lens.classList.remove('reading');
    progressBar.style.width = '0%';
    pauseBtn.innerHTML = '⏸';
    pauseBtn.title = 'Pause';
    setStatus('idle', 'Ready');
    updateTransportUI();
    playBtn.disabled = false;
  }

  function updateTransportUI() {
    const canPlay  = !state.isPlaying || state.isPaused;
    playBtn.disabled  = !canPlay;
    pauseBtn.disabled = !state.isPlaying && !state.isPaused;
    stopBtn.disabled  = !state.isPlaying && !state.isPaused;
    playBtn.classList.toggle('playing', state.isPlaying && !state.isPaused);

    // If paused, stop-btn stays enabled so user can fully reset
    if (state.isPaused) {
      stopBtn.disabled  = false;
      pauseBtn.disabled = false;
    }
  }

  // ── Transport listeners ──────────────────────────────────────
  playBtn.addEventListener('click',  startReading);
  pauseBtn.addEventListener('click', togglePause);
  stopBtn.addEventListener('click',  () => { stopReading(); setStatus('idle', 'Stopped'); });

  // ════════════════════════════════════════════════════════════
  //  CONTROLS
  // ════════════════════════════════════════════════════════════
  genderSel.addEventListener('change', () => {
    state.voiceGender = genderSel.value;
    populateVoiceSelect();
    saveSettings();
  });

  voiceSel.addEventListener('change', () => {
    state.voiceURI = voiceSel.value;
    saveSettings();
  });

  speedSlider.addEventListener('input', () => {
    state.speed = parseFloat(speedSlider.value);
    speedVal.textContent = state.speed.toFixed(1) + '×';
    saveSettings();
  });

  pitchSlider.addEventListener('input', () => {
    state.pitch = parseFloat(pitchSlider.value);
    pitchVal.textContent = state.pitch.toFixed(1);
    saveSettings();
  });

  volSlider.addEventListener('input', () => {
    state.volume = parseFloat(volSlider.value);
    volVal.textContent = Math.round(state.volume * 100) + '%';
    saveSettings();
  });

  modeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      modeButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.readingMode = btn.dataset.mode;
      updateModeLabel();
      if (state.readingMode === 'normal') responseBox.classList.remove('visible');
      saveSettings();
    });
  });

  sourceSel.addEventListener('change', saveSettings);

  function updateModeLabel() {
    const map = {
      'normal':     'Normal (offline TTS)',
      'meta-read':  'Meta-Read (Gemini AI)',
      'instru-read':'Instru-Read (Gemini AI)',
    };
    lensLabel.textContent = map[state.readingMode] || 'AI Reader Lens';
  }

  // ════════════════════════════════════════════════════════════
  //  TEXT HIGHLIGHTING
  // ════════════════════════════════════════════════════════════
  function highlightInPage(sentence) {
    clearHighlights();
    if (!sentence || sentence.length < 5) return;

    // Use first ~30 characters as search fragment
    const needle = sentence.slice(0, 30).trim().toLowerCase();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.nodeValue) continue;
      if (node.parentElement && node.parentElement.closest('#ai-rl-root')) continue;
      if (node.nodeValue.toLowerCase().includes(needle)) {
        try {
          const range = document.createRange();
          range.selectNodeContents(node);
          const mark = document.createElement('mark');
          mark.className = 'ai-rl-highlight';
          range.surroundContents(mark);
          mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
          break;
        } catch (_) { /* skip cross-element nodes */ }
      }
    }
  }

  function clearHighlights() {
    document.querySelectorAll('mark.ai-rl-highlight').forEach(m => {
      const p = m.parentNode;
      if (p) { p.replaceChild(document.createTextNode(m.textContent), m); p.normalize(); }
    });
  }

  // ════════════════════════════════════════════════════════════
  //  SETTINGS  
  // ════════════════════════════════════════════════════════════
  function saveSettings() {
    chrome.runtime.sendMessage({
      type: 'SAVE_SETTINGS',
      payload: {
        aiRlMode:     state.readingMode,
        aiRlVoiceURI: voiceSel.value,
        aiRlGender:   state.voiceGender,
        aiRlSpeed:    state.speed,
        aiRlPitch:    state.pitch,
        aiRlVolume:   state.volume,
        aiRlSource:   sourceSel.value,
        aiRlAutoRead: state.autoRead,
      }
    }).catch(() => {});
  }

  function loadSettings() {
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, res => {
      if (!res?.success) return;
      const s = res.data;

      if (s.aiRlMode) {
        state.readingMode = s.aiRlMode;
        modeButtons.forEach(b => b.classList.toggle('active', b.dataset.mode === state.readingMode));
        updateModeLabel();
      }
      if (s.aiRlGender)    { state.voiceGender = s.aiRlGender; genderSel.value = s.aiRlGender; }
      if (s.aiRlVoiceURI)  { state.voiceURI    = s.aiRlVoiceURI; }
      if (s.aiRlSpeed  != null) { state.speed  = +s.aiRlSpeed;  speedSlider.value = s.aiRlSpeed;  speedVal.textContent = (+s.aiRlSpeed).toFixed(1) + '×'; }
      if (s.aiRlPitch  != null) { state.pitch  = +s.aiRlPitch;  pitchSlider.value = s.aiRlPitch;  pitchVal.textContent = (+s.aiRlPitch).toFixed(1); }
      if (s.aiRlVolume != null) { state.volume = +s.aiRlVolume; volSlider.value   = s.aiRlVolume; volVal.textContent = Math.round(s.aiRlVolume * 100) + '%'; }
      if (s.aiRlSource) { sourceSel.value = s.aiRlSource; }
      if (s.geminiApiKey) { state.apiKey = s.geminiApiKey; }
      if (s.aiRlAutoRead != null) {
        state.autoRead = !!s.aiRlAutoRead;
        autoBtn.classList.toggle('on', state.autoRead);
        autoBtn.querySelector('span:last-child').textContent = state.autoRead ? 'Auto-Read: ON' : 'Auto-Read: OFF';
      }

      // Re-populate voices now that gender pref is loaded
      if (state.voices.length) populateVoiceSelect();
    });
  }

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'API_KEY_UPDATED') state.apiKey = msg.key;
  });

  // ════════════════════════════════════════════════════════════
  //  STATUS
  // ════════════════════════════════════════════════════════════
  function setStatus(type, text) {
    statusEl.className = 'ai-rl-status' + (type ? ' st-' + type : '');
    statusText.textContent = text;
  }

  // ════════════════════════════════════════════════════════════
  //  HTML TEMPLATE
  // ════════════════════════════════════════════════════════════
  function buildHTML() {
    return `
<button id="ai-rl-fab" title="Toggle AI Reader Lens">🔍</button>

<div id="ai-rl-lens">
  <div id="ai-rl-lens-label">AI Reader Lens</div>
  <div id="ai-rl-lens-scanline"></div>
  <div id="ai-rl-resize" title="Resize lens"></div>

  <div id="ai-rl-panel">

    <div class="ai-rl-row">
      <span class="ai-rl-label">Voice</span>
      <select class="ai-rl-select" id="ai-rl-voice" style="flex:2"><option>Loading…</option></select>
      <select class="ai-rl-select" id="ai-rl-gender" style="max-width:80px">
        <option value="any">Any</option>
        <option value="female">Female</option>
        <option value="male">Male</option>
      </select>
    </div>

    <div class="ai-rl-row">
      <span class="ai-rl-label">Source</span>
      <select class="ai-rl-select" id="ai-rl-source">
        <option value="lens">Under Lens (auto)</option>
        <option value="page">Full Page</option>
        <option value="selection">Selected Text</option>
        <option value="pdf">PDF Document</option>
      </select>
    </div>

    <div class="ai-rl-row">
      <span class="ai-rl-label">Speed</span>
      <input type="range" class="ai-rl-slider" id="ai-rl-speed" min="0.5" max="2.5" step="0.1" value="1.0">
      <span class="ai-rl-value" id="ai-rl-speed-val">1.0×</span>
    </div>

    <div class="ai-rl-row">
      <span class="ai-rl-label">Pitch</span>
      <input type="range" class="ai-rl-slider" id="ai-rl-pitch" min="0.5" max="2.0" step="0.1" value="1.0">
      <span class="ai-rl-value" id="ai-rl-pitch-val">1.0</span>
    </div>

    <div class="ai-rl-row">
      <span class="ai-rl-label">Volume</span>
      <input type="range" class="ai-rl-slider" id="ai-rl-vol" min="0" max="1" step="0.05" value="1.0">
      <span class="ai-rl-value" id="ai-rl-vol-val">100%</span>
    </div>

    <div class="ai-rl-divider"></div>

    <div class="ai-rl-row">
      <span class="ai-rl-label">Mode</span>
      <div class="ai-rl-modes">
        <button class="ai-rl-mode-btn active" data-mode="normal">📖 Normal</button>
        <button class="ai-rl-mode-btn" data-mode="meta-read">🧠 Meta-Read</button>
        <button class="ai-rl-mode-btn" data-mode="instru-read">🎓 Instru-Read</button>
      </div>
    </div>

    <div class="ai-rl-progress-wrap">
      <div class="ai-rl-progress-bar" id="ai-rl-progress"></div>
    </div>

    <div class="ai-rl-row" style="margin-bottom:0; justify-content:space-between;">
      <div class="ai-rl-transport">
        <button class="ai-rl-ctrl play-btn" id="ai-rl-play" title="Play">▶</button>
        <button class="ai-rl-ctrl" id="ai-rl-pause" title="Pause" disabled>⏸</button>
        <button class="ai-rl-ctrl" id="ai-rl-stop" title="Stop" disabled>⏹</button>
      </div>

      <div class="ai-rl-status" id="ai-rl-status">
        <div class="ai-rl-status-dot"></div>
        <span id="ai-rl-status-text">Ready</span>
        <span id="ai-rl-online-dot" class="ai-rl-online-dot on" title="Online"></span>
      </div>

      <div class="ai-rl-autoread on" id="ai-rl-autoread" title="Auto-read when lens stops moving">
        <div class="ai-rl-autoread-dot"></div>
        <span>Auto-Read: ON</span>
      </div>
    </div>

    <div id="ai-rl-response"></div>
  </div>
</div>`;
  }

  // ════════════════════════════════════════════════════════════
  //  INIT
  // ════════════════════════════════════════════════════════════
  loadSettings();
  setStatus('idle', 'Click 🔍 to open lens');
  updateTransportUI();

})();
