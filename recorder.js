/**
 * Flowpilot — full capture
 * -----------------------------------
 * Lancia Microsoft Edge tramite Playwright e cattura praticamente tutto:
 *  - mouse: click, dblclick, contextmenu, mousedown/up, wheel
 *  - tastiera: keydown/keyup, composizione IME, shortcut
 *  - form: input, change, focus/blur, copy/cut/paste, file upload
 *  - drag & drop: dragstart, dragover, drop
 *  - navigazione: nuove tab, chiusure, switch tab, popstate, hashchange, reload
 *  - download (con file salvato), upload (path)
 *  - rete: request, response, websocket frames
 *  - dialog: alert/confirm/prompt
 *  - console & errori JS
 *  - resize finestra
 *  - screenshot per evento "rilevante" + trace Playwright + video + HAR
 *
 * Output in recordings/<sessionId>/
 *   - original flow/               artefatti del flusso originale
 *       - events.json              elenco strutturato
 *       - session.spec.js          script Playwright riproducibile
 *       - trace.zip                trace Playwright (npx playwright show-trace)
 *       - network.har              HAR completo
 *       - video/                   video del browser (Playwright) + screen.mp4 (schermo intero)
 *       - frames/                  frame a 1 fps della registrazione a schermo intero
 *       - screenshots/             screenshot per-evento
 *
 * Uso:
 *   npm install
 *   npm run record -- https://example.com
 */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
// Avvio browser centralizzato: supporta Microsoft Edge E Google Chrome con
// fallback automatico tra i canali (vedi lib/browser.js).
const browserLauncher = require('./lib/browser');
// Registrazione a schermo intero (video unico + frame a 1 fps): vedi
// lib/screen-capture.js. Cattura tutto il desktop, non solo il browser.
const screenCapture = require('./lib/screen-capture');

// Preferenza browser: 'auto' | 'msedge' | 'chrome' (impostazione VS Code
// edgeRecorder.browser, propagata via env dal processo padre).
const BROWSER_PREF = process.env.BROWSER_PREF || 'auto';

// ---------------------------------------------------------------------------
// Avvio del browser con fallback sui canali Edge/Chrome (stable/beta/dev).
// Serve anche a sopravvivere al "hand-off" che Edge stabile fa quando esiste
// gia' un'altra istanza aperta nella sessione utente (msedge.exe esce subito):
// in quel caso si prova il canale successivo, fino a Chrome se disponibile.
// ---------------------------------------------------------------------------
async function launchEdgeWithFallback(profileDir, baseOpts) {
  return browserLauncher.launchWithFallback({
    chromium,
    profileDir,
    baseOpts,
    preference: BROWSER_PREF,
    log: (line) => console.log(line)
  });
}

const START_URL = process.argv[2] || 'https://en.wikipedia.org/wiki/Microsoft';
const REC_ROOT = process.env.RECORDINGS_DIR || path.join(__dirname, 'recordings');

// Nome sessione = nome del sito inserito (hostname senza "www."), reso sicuro
// per il filesystem. Se esiste gia' una sessione con lo stesso nome si aggiunge
// un suffisso progressivo " (2)", " (3)", ...
function siteBaseName(u) {
  try {
    let h = new URL(u).hostname.replace(/^www\./i, '');
    h = h.replace(/[\\/:*?"<>|]+/g, '_').replace(/[.\s]+$/g, '');
    return h || 'sessione';
  } catch (_) { return 'sessione'; }
}
function uniqueSessionName(root, base) {
  let name = base, i = 2;
  try { while (fs.existsSync(path.join(root, name))) name = `${base} (${i++})`; } catch (_) {}
  return name;
}
const SESSION_NAME = uniqueSessionName(REC_ROOT, siteBaseName(START_URL));
const SESSION_DIR  = path.join(REC_ROOT, SESSION_NAME);
// Comunica all'host (extension.js) la cartella della sessione creata.
console.log('[recorder][DIR] ' + SESSION_DIR);
const ORIGINAL_DIR = path.join(SESSION_DIR, 'original flow');
const SHOTS_DIR    = path.join(ORIGINAL_DIR, 'screenshots');
const VIDEO_DIR    = path.join(ORIGINAL_DIR, 'video');
const FRAMES_DIR   = path.join(ORIGINAL_DIR, 'frames');
const JSON_FILE    = path.join(ORIGINAL_DIR, 'events.json');
const SPEC_FILE    = path.join(ORIGINAL_DIR, 'session.spec.js');
const HAR_FILE     = path.join(ORIGINAL_DIR, 'network.har');
const TRACE_FILE   = path.join(ORIGINAL_DIR, 'trace.zip');

for (const d of [SESSION_DIR, ORIGINAL_DIR, SHOTS_DIR, VIDEO_DIR, FRAMES_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

/** @type {Array<object>} */
const events = [];
let recording = false;
let startedAt = null;
// Handle della registrazione a schermo intero (avviata allo Start, chiusa allo Stop).
let screenCap = null;
let finished = false;
let evCounter = 0;

// Eventi che meritano uno screenshot automatico (per non saturare il disco).
const SHOT_TYPES = new Set([
  'click', 'dblclick', 'contextmenu', 'submit', 'change',
  'navigation', 'dialog', 'drop', 'download', 'pageerror'
]);

// ---------------------------------------------------------------------------
// Script iniettato in ogni pagina/iframe.
// ---------------------------------------------------------------------------
const INIT_SCRIPT = `
(() => {
  if (window.__recorderInstalled) return;
  window.__recorderInstalled = true;

  let recording = false;
  let evCount = 0;

  // ---------- Selettori ----------
  // Heuristic: una classe e' "sospetta" (CSS-in-JS hashata) se ricade in uno
  // dei pattern noti dei principali runtime: Griffel (Fluent UI/SharePoint),
  // emotion, jss, styled-components, Stylex, oppure se ha forma chiaramente
  // pseudo-random (mix maiuscole/minuscole/cifre lunghe).
  function isHashedClass(c) {
    if (!c) return true;
    if (c.length > 24) return true;
    if (/[=+/]/.test(c)) return true;                 // base64 nel nome
    if (/^_{2,}/.test(c)) return true;                // Griffel: ___xxxxx / __xxx
    if (/^css-[a-z0-9]{4,}$/.test(c)) return true;    // emotion
    if (/^jss[0-9]+$/.test(c)) return true;           // jss
    if (/^sc-[a-zA-Z0-9]{4,}$/.test(c)) return true;  // styled-components
    if (/^x[a-z0-9]{6,}$/.test(c)) return true;       // Stylex / Meta
    // Atomic Griffel/Fluent: lettera (r/f/d/...) + alfanumerico minuscolo,
    // tipicamente con 1+ cifre e nessun trattino, lunghezza >=6.
    if (/^[a-z][a-z0-9]{5,}$/.test(c) && /[0-9]/.test(c) && !/-/.test(c)) return true;
    // pseudo-random misto (vecchia regola)
    if (/^[a-zA-Z0-9_-]{8,}$/.test(c) && /[A-Z]/.test(c) && /[a-z]/.test(c) && /[0-9_-]/.test(c)) return true;
    return false;
  }
  function stableClasses(el) {
    if (!el.classList) return [];
    return Array.from(el.classList).filter(c => !isHashedClass(c));
  }
  function cssPath(el) {
    if (!(el instanceof Element)) return null;
    if (el.id && !/^[0-9]/.test(el.id) && el.id.length < 64) return '#' + CSS.escape(el.id);
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 6) {
      let sel = el.nodeName.toLowerCase();
      const cls = stableClasses(el).slice(0, 2);
      if (cls.length) sel += '.' + cls.map(c => CSS.escape(c)).join('.');
      const parent = el.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter(c => c.nodeName === el.nodeName);
        if (sameTag.length > 1) sel += ':nth-of-type(' + (sameTag.indexOf(el) + 1) + ')';
      }
      parts.unshift(sel);
      el = el.parentElement;
    }
    return parts.join(' > ');
  }
  function xpathOf(el) {
    if (!(el instanceof Element)) return null;
    const parts = [];
    while (el && el.nodeType === 1) {
      let i = 1, sib = el.previousElementSibling;
      while (sib) { if (sib.nodeName === el.nodeName) i++; sib = sib.previousElementSibling; }
      parts.unshift(el.nodeName.toLowerCase() + '[' + i + ']');
      el = el.parentElement;
    }
    return '/' + parts.join('/');
  }
  // ---------- Mascheramento dati sensibili ----------
  // Riconosce i campi che contengono segreti (password, OTP, CVV, PIN, token):
  // il loro valore NON deve mai essere salvato in events.json, negli screenshot
  // o nel prompt inviato a Copilot. Direzione sicura: in caso di dubbio, mascher.
  function isSensitive(el) {
    if (!el || !el.getAttribute) return false;
    try {
      var type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'password') return true;
      var ac = (el.getAttribute('autocomplete') || '').toLowerCase();
      if (ac === 'current-password' || ac === 'new-password' || ac === 'one-time-code') return true;
      var hint = ((el.getAttribute('name') || '') + ' ' + (el.id || '') + ' '
        + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('placeholder') || '')).toLowerCase();
      if (/pass(word|wd)?|\bpwd\b|\botp\b|\bcvv\b|secret|\bpin\b|security[-\s]?code|one[-\s]?time/.test(hint)) return true;
    } catch (_) {}
    return false;
  }
  function maskValue(el, val) {
    if (val == null) return val;
    return isSensitive(el) ? '[REDACTED]' : val;
  }
  function describe(el) {
    if (!el || !el.getAttribute) return null;
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    // Risolvi aria-labelledby in testo concreto (utile per pulsanti senza testo).
    let labelledText = null;
    const llb = el.getAttribute('aria-labelledby');
    if (llb) {
      try {
        const refs = llb.split(/\s+/).map(id => document.getElementById(id)).filter(Boolean);
        labelledText = refs.map(r => (r.innerText || '').trim()).filter(Boolean).join(' ').slice(0, 120) || null;
      } catch (_) {}
    }
    // Multi-select: cattura tutti i valori selezionati.
    let multiValues = null;
    if (el.tagName === 'SELECT' && el.multiple) {
      multiValues = Array.from(el.selectedOptions || []).map(o => o.value);
    }
    // Frame info: utile al replay per scegliere il frame giusto.
    let frameUrl = null;
    let frameName = null;
    try { frameUrl = window.location.href; } catch (_) {}
    try { frameName = window.name || null; } catch (_) {}

    // ---- Attributi extra stabili (utili su SharePoint/Fluent UI) ----
    const automationId = el.getAttribute('data-automationid')
      || el.getAttribute('data-automation-id')
      || el.getAttribute('data-automation')
      || null;
    const dataIcon = el.getAttribute('data-icon-name') || null;
    const dataId = el.getAttribute('data-id') || null;
    const title = el.getAttribute('title') || null;

    // Sali fino a 6 livelli per recuperare il primo aria-label/role/automationid
    // di un antenato significativo: utile come "scope" per i locator nel replay.
    let ancestorLabel = null, ancestorRole = null, ancestorAutomationId = null;
    try {
      let p = el.parentElement; let hops = 0;
      while (p && hops < 6) {
        if (!ancestorLabel) ancestorLabel = p.getAttribute('aria-label') || null;
        if (!ancestorRole) ancestorRole = p.getAttribute('role') || null;
        if (!ancestorAutomationId) ancestorAutomationId =
          p.getAttribute('data-automationid')
          || p.getAttribute('data-automation-id')
          || null;
        if (ancestorLabel && ancestorRole && ancestorAutomationId) break;
        p = p.parentElement; hops++;
      }
    } catch (_) {}

    // Testo "ricco": innerText pulito, fallback su title/alt/value placeholder
    let richText = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!richText && el.tagName === 'IMG') richText = el.getAttribute('alt') || '';
    if (richText.length > 200) richText = richText.slice(0, 200);

    return {
      selector: cssPath(el),
      xpath: xpathOf(el),
      tag: el.tagName ? el.tagName.toLowerCase() : null,
      id: el.id || null,
      name: el.getAttribute('name'),
      type: el.getAttribute('type'),
      value: 'value' in el ? (el.value != null ? maskValue(el, String(el.value).slice(0, 200)) : null) : null,
      multiValues,
      checked: 'checked' in el ? !!el.checked : null,
      contentEditable: !!(el.isContentEditable || el.getAttribute('contenteditable') === 'true'),
      text: (el.innerText || '').trim().slice(0, 120) || null,
      richText: richText || null,
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label') || labelledText,
      title,
      testId: el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-test'),
      automationId,
      dataIcon,
      dataId,
      ancestorLabel,
      ancestorRole,
      ancestorAutomationId,
      href: el.getAttribute('href'),
      placeholder: el.getAttribute('placeholder'),
      frameUrl,
      frameName,
      bbox: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } : null
    };
  }
  function isOurUi(el) { return !!(el && el.closest && el.closest('[data-recorder-ui]')); }

  function send(payload) {
    if (!recording) return;
    try {
      payload.url = location.href;
      payload.title = document.title;
      payload.viewport = { w: innerWidth, h: innerHeight };
      payload.scroll = { x: scrollX, y: scrollY };
      payload.ts = Date.now();
      window.__recordAction(JSON.stringify(payload));
      evCount++; updateBadge();
    } catch (e) { /* ignore */ }
  }

  // ---------- Mouse ----------
  document.addEventListener('click', (e) => {
    if (isOurUi(e.target)) return;
    send({ type: 'click', target: describe(e.target), button: e.button, x: e.clientX, y: e.clientY });
  }, true);
  document.addEventListener('dblclick', (e) => {
    if (isOurUi(e.target)) return;
    send({ type: 'dblclick', target: describe(e.target), x: e.clientX, y: e.clientY });
  }, true);
  document.addEventListener('contextmenu', (e) => {
    if (isOurUi(e.target)) return;
    send({ type: 'contextmenu', target: describe(e.target), x: e.clientX, y: e.clientY });
  }, true);
  document.addEventListener('mousedown', (e) => {
    if (isOurUi(e.target)) return;
    send({ type: 'mousedown', target: describe(e.target), button: e.button, x: e.clientX, y: e.clientY });
  }, true);
  document.addEventListener('mouseup', (e) => {
    if (isOurUi(e.target)) return;
    send({ type: 'mouseup', target: describe(e.target), button: e.button, x: e.clientX, y: e.clientY });
  }, true);
  let wheelTimer = null, wheelAcc = { dx:0, dy:0 };
  document.addEventListener('wheel', (e) => {
    wheelAcc.dx += e.deltaX; wheelAcc.dy += e.deltaY;
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      send({ type: 'wheel', dx: wheelAcc.dx, dy: wheelAcc.dy, ctrl: e.ctrlKey });
      wheelAcc = { dx:0, dy:0 };
    }, 250);
  }, true);

  // ---------- Hover ----------
  let lastHover = 0;
  document.addEventListener('mouseover', (e) => {
    if (isOurUi(e.target)) return;
    const now = Date.now();
    if (now - lastHover < 500) return;
    lastHover = now;
    send({ type: 'hover', target: describe(e.target) });
  }, true);

  // ---------- Mouse trail ----------
  // Campiona il cursore: max ~12 eventi/sec e solo se si e' mosso > 6px.
  // Necessario per riprodurre fedelmente l'apertura di menu a cascata che
  // dipendono dal percorso reale del mouse (CSS :hover, mouseenter su antenati).
  let lastMouseTs = 0, lastMx = 0, lastMy = 0;
  document.addEventListener('mousemove', (e) => {
    if (isOurUi(e.target)) return;
    const now = Date.now();
    if (now - lastMouseTs < 80) return;
    const dx = e.clientX - lastMx, dy = e.clientY - lastMy;
    if (dx * dx + dy * dy < 36) return; // < 6px
    lastMouseTs = now; lastMx = e.clientX; lastMy = e.clientY;
    send({ type: 'mousemove', x: e.clientX, y: e.clientY });
  }, true);

  // ---------- Tastiera ----------
  document.addEventListener('keydown', (e) => {
    if (isOurUi(e.target)) return;
    send({
      type: 'keydown', key: e.key, code: e.code,
      ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey,
      repeat: e.repeat, target: describe(e.target)
    });
  }, true);
  document.addEventListener('keyup', (e) => {
    if (isOurUi(e.target)) return;
    send({
      type: 'keyup', key: e.key, code: e.code,
      ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey,
      target: describe(e.target)
    });
  }, true);
  document.addEventListener('compositionstart', (e) => {
    send({ type: 'compositionstart', target: describe(e.target), data: e.data });
  }, true);
  document.addEventListener('compositionend', (e) => {
    send({ type: 'compositionend', target: describe(e.target), data: e.data });
  }, true);

  // ---------- Form ----------
  let inputTimer = null, lastInputTarget = null;
  document.addEventListener('input', (e) => {
    if (isOurUi(e.target)) return;
    lastInputTarget = e.target;
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => {
      const t = lastInputTarget;
      if (!t) return;
      send({ type: 'input', target: describe(t), value: t.value != null ? maskValue(t, String(t.value)) : null });
    }, 400);
  }, true);
  document.addEventListener('change', (e) => {
    if (isOurUi(e.target)) return;
    const t = e.target;
    let extra = {};
    if (t.tagName === 'SELECT') {
      extra.selectedValue = t.value;
      extra.selectedText = t.options[t.selectedIndex] ? t.options[t.selectedIndex].text : null;
    } else if (t.type === 'checkbox' || t.type === 'radio') {
      extra.checked = !!t.checked;
    } else if (t.type === 'file') {
      extra.files = Array.from(t.files || []).map(f => ({ name: f.name, size: f.size, type: f.type }));
    }
    send({ type: 'change', target: describe(t), value: maskValue(t, t.value), ...extra });
  }, true);
  document.addEventListener('submit', (e) => {
    if (isOurUi(e.target)) return;
    send({ type: 'submit', target: describe(e.target) });
  }, true);
  document.addEventListener('focusin', (e) => {
    if (isOurUi(e.target)) return;
    send({ type: 'focus', target: describe(e.target) });
  }, true);
  document.addEventListener('focusout', (e) => {
    if (isOurUi(e.target)) return;
    send({ type: 'blur', target: describe(e.target) });
  }, true);
  for (const evt of ['copy','cut','paste']) {
    document.addEventListener(evt, (e) => {
      if (isOurUi(e.target)) return;
      let data = null;
      try { data = e.clipboardData ? e.clipboardData.getData('text/plain') : null; } catch (_) {}
      if (data && isSensitive(e.target)) data = '[REDACTED]';
      send({ type: evt, target: describe(e.target), data: data ? data.slice(0, 500) : null });
    }, true);
  }

  // ---------- Drag & drop ----------
  for (const evt of ['dragstart','dragend','drop']) {
    document.addEventListener(evt, (e) => {
      if (isOurUi(e.target)) return;
      let files = null;
      if (e.dataTransfer && e.dataTransfer.files) {
        files = Array.from(e.dataTransfer.files).map(f => ({ name: f.name, size: f.size, type: f.type }));
      }
      send({ type: evt, target: describe(e.target), x: e.clientX, y: e.clientY, files });
    }, true);
  }

  // ---------- SPA / history ----------
  window.addEventListener('popstate', () => send({ type: 'popstate' }), true);
  window.addEventListener('hashchange', () => send({ type: 'hashchange' }), true);

  // ---------- Resize ----------
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => send({ type: 'resize', w: innerWidth, h: innerHeight }), 250);
  }, true);

  // ---------- Scroll ----------
  let scrollTimer = null;
  window.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => send({ type: 'scroll', x: scrollX, y: scrollY }), 300);
  }, true);

  // ---------- Theme ----------
  try {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener && mq.addEventListener('change', () => send({ type: 'colorscheme', dark: mq.matches }));
  } catch (_) {}

  // ====================== OVERLAY UI ======================
  // L'init script viene iniettato in OGNI frame (main + iframes). L'overlay
  // pero' deve esistere una sola volta: lo costruiamo solo nel top frame.
  let isTopFrame = false;
  try { isTopFrame = (window.top === window); } catch (_) { isTopFrame = false; }
  function buildOverlay() {
    if (!isTopFrame) return;
    if (document.getElementById('__recorder_overlay__')) return;
    if (!document.documentElement) return setTimeout(buildOverlay, 50);
    const host = document.createElement('div');
    host.id = '__recorder_overlay__';
    host.setAttribute('data-recorder-ui', '1');
    host.style.cssText = 'position:fixed!important;top:12px!important;right:12px!important;left:auto!important;z-index:2147483647!important;width:auto!important;height:auto!important;margin:0!important;padding:0!important;display:block!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = \`
      <style>
        :host { all: initial; }
        :host, * { box-sizing: border-box; }
        .panel {
          font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          background: rgba(20,20,28,0.92); color: #fff;
          padding: 8px 10px; border-radius: 10px;
          box-shadow: 0 6px 18px rgba(0,0,0,0.35);
          display: flex; align-items: center; gap: 8px;
          font-size: 12px; user-select: none; backdrop-filter: blur(6px);
        }
        button { font: inherit; color:#fff; background:#2d2d3a; border:1px solid #444;
                 padding:4px 10px; border-radius:6px; cursor:pointer; }
        button:hover { background:#3a3a4a; }
        button.primary { background:#c0392b; border-color:#e74c3c; }
        button.primary:hover { background:#e74c3c; }
        button:disabled { opacity:0.4; cursor:not-allowed; }
        .dot { width:10px; height:10px; border-radius:50%; background:#888; }
        .dot.rec { background:#e74c3c; animation: pulse 1.2s infinite; }
        .dot.pause { background:#f1c40f; }
        @keyframes pulse {
          0% { box-shadow:0 0 0 0 rgba(231,76,60,.7); }
          70% { box-shadow:0 0 0 8px rgba(231,76,60,0); }
          100% { box-shadow:0 0 0 0 rgba(231,76,60,0); }
        }
        .badge { font-variant-numeric: tabular-nums; opacity:0.85; min-width:60px; }
        .label { font-weight:600; letter-spacing:0.3px; }
      </style>
      <div class="panel" id="panel">
        <span class="dot" id="dot"></span>
        <span class="label" id="label">Recorder</span>
        <button id="start" class="primary">● Start</button>
        <button id="pause" disabled>❚❚ Pausa</button>
        <button id="stop"  disabled>■ Stop &amp; Salva</button>
        <span class="badge" id="badge">0 eventi</span>
      </div>
    \`;
    document.documentElement.appendChild(host);

    const $ = (id) => shadow.getElementById(id);
    const dot=$('dot'), label=$('label'), badge=$('badge');
    const btnStart=$('start'), btnPause=$('pause'), btnStop=$('stop'), panel=$('panel');

    let drag = null;
    panel.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const r = host.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      host.style.left = (e.clientX - drag.dx) + 'px';
      host.style.top  = (e.clientY - drag.dy) + 'px';
      host.style.right = 'auto';
    }, true);
    window.addEventListener('mouseup', () => { drag = null; }, true);

    window.__recorderUi = {
      setState(state) {
        if (state === 'recording') {
          recording = true;
          dot.className='dot rec'; label.textContent='REC';
          btnStart.disabled=true; btnPause.disabled=false;
          btnPause.textContent='❚❚ Pausa'; btnStop.disabled=false;
        } else if (state === 'paused') {
          recording = false;
          dot.className='dot pause'; label.textContent='PAUSA';
          btnStart.disabled=true; btnPause.disabled=false;
          btnPause.textContent='▶ Riprendi'; btnStop.disabled=false;
        } else if (state === 'stopped') {
          recording = false;
          dot.className='dot'; label.textContent='STOP';
          btnStart.disabled=true; btnPause.disabled=true; btnStop.disabled=true;
        } else {
          recording = false;
          dot.className='dot'; label.textContent='Recorder';
          btnStart.disabled=false; btnPause.disabled=true;
          btnPause.textContent='❚❚ Pausa'; btnStop.disabled=true;
        }
      },
      setCount(n) { evCount = n; updateBadge(); }
    };

    const ctrl = (a) => { try { window.__recordControl(a); } catch (_) {} };
    btnStart.addEventListener('click', () => ctrl('start'));
    btnPause.addEventListener('click', () => ctrl(recording ? 'pause' : 'resume'));
    btnStop.addEventListener('click',  () => ctrl('stop'));
    ctrl('sync');
  }
  function updateBadge() {
    const root = document.getElementById('__recorder_overlay__');
    if (!root || !root.shadowRoot) return;
    const b = root.shadowRoot.getElementById('badge');
    if (b) b.textContent = evCount + ' eventi';
  }
  if (isTopFrame) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', buildOverlay);
      setTimeout(buildOverlay, 500);
    } else {
      buildOverlay();
    }
    setInterval(() => {
      if (!document.getElementById('__recorder_overlay__')) buildOverlay();
    }, 2000);
  }
  console.log('[recorder] overlay script installed');
})();
`;

(async () => {
  console.log('[recorder] Avvio del browser (Microsoft Edge o Google Chrome)...');

  // Profilo persistente: i login restano salvati tra una registrazione e l'altra.
  // E' una cartella DEDICATA (NON il profilo del tuo browser personale): cosi'
  // possiamo lavorare anche con il browser gia' aperto, senza conflitti di lock.
  // Per Chrome viene usata automaticamente la cartella sorella "<dir>-chrome".
  const PROFILE_DIR = process.env.EDGE_PROFILE_DIR || path.join(__dirname, 'edge-profile');
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  console.log(`[recorder] Profilo browser (base): ${PROFILE_DIR}`);

  let context;
  try {
    context = await launchEdgeWithFallback(PROFILE_DIR, {
      headless: false,
      viewport: null,
      acceptDownloads: true,
      recordVideo: { dir: VIDEO_DIR },
      recordHar:   { path: HAR_FILE, content: 'embed' }
    });
  } catch (e) {
    console.error('[recorder] Impossibile avviare il browser:', e.message);
    if (/Apertura nella sessione|existing browser session|browser has been closed/i.test(String(e.message))) {
      console.error('[recorder] Il browser ha passato il controllo a un\'istanza gia\' aperta ed e\' uscito subito.');
      console.error('[recorder] Soluzioni:');
      console.error('  1) Chiudi TUTTE le finestre del browser (anche quelle in background) e riprova.');
      console.error('  2) Installa un canale Beta/Dev (Edge o Chrome) che convive con il canale stabile aperto.');
      console.error('  3) Imposta edgeRecorder.browser sull\'altro browser disponibile.');
    }
    throw e;
  }
  const browser = context.browser();

  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });

  // -------------------- helpers --------------------
  async function broadcastState(state) {
    // Marker letto dall'estensione VS Code per aggiornare la UI del pannello
    console.log(`[recorder][STATE] ${state}`);
    await Promise.all(context.pages().map(async (p) => {
      try {
        await p.evaluate(({ state, count }) => {
          if (window.__recorderUi) { window.__recorderUi.setState(state); window.__recorderUi.setCount(count); }
        }, { state, count: events.length });
      } catch (_) {}
    }));
  }

  async function maybeShot(page, ev) {
    if (!page || !SHOT_TYPES.has(ev.type)) return;
    const id = String(++evCounter).padStart(5, '0');
    const file = `shot-${id}-${ev.type}.png`;
    const full = path.join(SHOTS_DIR, file);
    try {
      await page.screenshot({ path: full, fullPage: false });
      ev.screenshot = path.relative(SESSION_DIR, full).replace(/\\/g, '/');
    } catch (_) { /* page may be closing */ }
  }

  function pushEvent(ev, page) {
    if (!recording) return;
    ev.elapsedMs = (ev.ts || Date.now()) - (startedAt || ev.ts || Date.now());
    events.push(ev);
    const desc = ev.target && ev.target.selector ? ev.target.selector : (ev.url || '');
    console.log(`[+${ev.elapsedMs}ms] ${ev.type} ${desc}`.trim());
    // screenshot async, non blocca
    maybeShot(page, ev).catch(() => {});
  }

  // -------------------- bindings --------------------
  await context.exposeBinding('__recordAction', ({ page }, payloadJson) => {
    if (!recording) return;
    try {
      const ev = JSON.parse(payloadJson);
      pushEvent(ev, page);
    } catch (e) { console.error('[recorder] payload non valido', e); }
  });

  await context.exposeBinding('__recordControl', async (source, action) => {
    switch (action) {
      case 'start':
        if (!recording) {
          // Prima di iniziare, chiudi TUTTE le altre schede del browser
          // (incluse quelle che Playwright non ha aperto direttamente):
          // resta aperta solo quella in cui l'utente ha premuto Start.
          const startPage = source && source.page ? source.page : (context.pages()[0] || null);
          let startTargetId = null;
          try {
            // Risali al targetId della pagina Start via CDP, cosi' possiamo
            // distinguerla quando enumeriamo tutti i target del browser.
            try {
              const s = await context.newCDPSession(startPage);
              const info = await s.send('Target.getTargetInfo').catch(() => null);
              startTargetId = info?.targetInfo?.targetId || null;
              await s.detach().catch(() => {});
            } catch (_) {}

            // Apri una sessione CDP "browser-wide" per vedere ogni target,
            // anche quelli aperti dall'utente o ereditati dal profilo persistente.
            let bs = null;
            try { bs = await (browser?.newBrowserCDPSession?.()); } catch (_) {}

            for (let i = 0; i < 5; i++) {
              let toClose = [];
              if (bs) {
                try {
                  const { targetInfos } = await bs.send('Target.getTargets');
                  toClose = (targetInfos || [])
                    .filter(t => t.type === 'page' && t.targetId !== startTargetId)
                    .map(t => t.targetId);
                } catch (_) {}
              }
              // Fallback: anche le pagine "viste" da Playwright
              const playwrightOthers = context.pages().filter(p => p !== startPage && !p.isClosed());

              if (!toClose.length && !playwrightOthers.length) break;
              console.log(`[recorder] Chiudo ${toClose.length || playwrightOthers.length} scheda/e altra/e (giro ${i + 1})...`);

              // 1) chiusura via Target.closeTarget (browser-wide, copre anche
              //    schede aperte fuori da Playwright)
              if (bs && toClose.length) {
                await Promise.all(toClose.map(tid =>
                  bs.send('Target.closeTarget', { targetId: tid }).catch(() => {})
                ));
              }
              // 2) chiusura via page.close() per quelle che Playwright vede
              await Promise.all(playwrightOthers.map(async (p) => {
                try { await p.close({ runBeforeUnload: false }); } catch (_) {}
              }));
              await new Promise(r => setTimeout(r, 250));
            }

            try { await bs?.detach?.(); } catch (_) {}

            const stillOpen = context.pages().filter(p => p !== startPage && !p.isClosed()).length;
            if (stillOpen) console.log(`[recorder] Attenzione: ${stillOpen} scheda/e non chiudibili (resteranno aperte).`);
          } catch (e) { console.error('[recorder] errore chiusura schede:', e.message); }

          recording = true;
          if (!startedAt) startedAt = Date.now();
          console.log('\n[recorder] ▶ Registrazione AVVIATA');
          // Avvia la registrazione UNICA a schermo intero (tutti i monitor): un
          // solo flusso continuo dallo Start allo Stop -> video + frame a 1 fps.
          if (process.env.SCREEN_CAPTURE !== '0' && !screenCap) {
            try {
              screenCap = screenCapture.start({
                videoDir: VIDEO_DIR,
                framesDir: FRAMES_DIR,
                captureFps: Number(process.env.SCREEN_CAP_FPS) || 4,
                frameFps: 1,
                ffmpegPath: process.env.FFMPEG_PATH || '',
                log: (l) => console.log('[recorder]' + l)
              });
              console.log(`[recorder] Cattura schermo avviata (backend: ${screenCap.backend}).`);
            } catch (e) {
              console.error('[recorder] Cattura schermo non avviata:', e.message);
              screenCap = null;
            }
          }
          // Salva URL di partenza REALE (la pagina dove l'utente ha premuto Start),
          // non il primo click che cambia pagina.
          try {
            const startPageUrl = startPage ? startPage.url() : null;
            events.push({
              type: 'session_start',
              ts: Date.now(),
              elapsedMs: 0,
              url: startPageUrl || START_URL
            });
            console.log('[recorder] URL di partenza: ' + (startPageUrl || START_URL));
          } catch (e) { console.error('[recorder] errore session_start:', e.message); }
          await broadcastState('recording');
        }
        break;
      case 'pause':
        if (recording) { recording = false; console.log('[recorder] ❚❚ Pausa'); await broadcastState('paused'); }
        break;
      case 'resume':
        if (!recording) { recording = true; console.log('[recorder] ▶ Ripresa'); await broadcastState('recording'); }
        break;
      case 'stop':
        console.log("[recorder] ■ Stop richiesto dall'overlay");
        await broadcastState('stopped');
        await finalize();
        break;
      case 'sync':
        await broadcastState(recording ? 'recording' : (events.length ? 'paused' : 'idle'));
        break;
    }
  });

  await context.addInitScript({ content: INIT_SCRIPT });

  // -------------------- per-page hooks --------------------
  function attachPage(page, isNew) {
    if (isNew) pushEvent({ type: 'tab_open', ts: Date.now(), url: page.url() }, page);

    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      pushEvent({ type: 'navigation', ts: Date.now(), url: frame.url() }, page);
    });
    page.on('close', () => {
      pushEvent({ type: 'tab_close', ts: Date.now(), url: page.url() }, null);
      setTimeout(() => { if (context.pages().length === 0) finalize(); }, 200);
    });
    page.on('console', (msg) => {
      if (!recording) return;
      pushEvent({ type: 'console', ts: Date.now(), level: msg.type(), text: msg.text().slice(0, 1000) }, null);
    });
    page.on('pageerror', (err) => {
      pushEvent({ type: 'pageerror', ts: Date.now(), message: err.message, stack: (err.stack||'').slice(0, 2000) }, page);
    });
    page.on('dialog', async (dialog) => {
      pushEvent({ type: 'dialog', ts: Date.now(), kind: dialog.type(), message: dialog.message(), defaultValue: dialog.defaultValue() }, page);
      try { await dialog.dismiss(); } catch (_) {}
    });
    page.on('download', async (dl) => {
      pushEvent({ type: 'download', ts: Date.now(), filename: dl.suggestedFilename(), url: dl.url() }, page);
      try { await dl.cancel(); } catch (_) {}
    });
    page.on('request', (req) => {
      if (!recording) return;
      const t = req.resourceType();
      if (!['xhr','fetch','document','websocket'].includes(t)) return;
      pushEvent({ type:'request', ts:Date.now(), method:req.method(), reqUrl:req.url(), resourceType:t }, null);
    });
    page.on('response', async (res) => {
      if (!recording) return;
      const t = res.request().resourceType();
      if (!['xhr','fetch','document'].includes(t)) return;
      pushEvent({ type:'response', ts:Date.now(), status:res.status(), reqUrl:res.url(), resourceType:t }, null);
    });
    page.on('websocket', (ws) => {
      pushEvent({ type:'websocket_open', ts:Date.now(), wsUrl: ws.url() }, null);
      ws.on('framesent',     (f) => pushEvent({ type:'ws_send', ts:Date.now(), wsUrl:ws.url(), payload: String(f.payload).slice(0, 500) }, null));
      ws.on('framereceived', (f) => pushEvent({ type:'ws_recv', ts:Date.now(), wsUrl:ws.url(), payload: String(f.payload).slice(0, 500) }, null));
      ws.on('close', () => pushEvent({ type:'websocket_close', ts:Date.now(), wsUrl: ws.url() }, null));
    });
  }

  context.on('page', (p) => attachPage(p, true));

  const page = await context.newPage();
  attachPage(page, false);
  await page.goto(START_URL);

  console.log('\n=== Recorder pronto ===');
  console.log("Premi ● Start nell'overlay del browser per iniziare a registrare.");
  console.log("Chiudi Edge, premi ■ Stop nell'overlay, oppure Ctrl+C qui per terminare.\n");

  async function finalize() {
    if (finished) return;
    finished = true;
    recording = false; // stop nuovi eventi subito
    // 1) Salvataggio SINCRONO immediato (non aspetta nulla che possa bloccarsi)
    try {
      fs.writeFileSync(JSON_FILE, JSON.stringify(events, null, 2), 'utf8');
      fs.writeFileSync(SPEC_FILE, generateSpec(events, START_URL), 'utf8');
      console.log(`\n[recorder] Salvati ${events.length} eventi in: ${SESSION_DIR}`);
      console.log(`  - original flow/events.json`);
      console.log(`  - original flow/session.spec.js`);
    } catch (e) {
      console.error('[recorder] Errore nel salvataggio events.json/spec:', e);
    }
    // 1-bis) Ferma la registrazione a schermo intero e finalizza video + frame.
    //        I frame sono gia' su disco (scritti live), quindi qui si chiude solo
    //        il video: operazione veloce anche per sessioni lunghe.
    if (screenCap) {
      const sc = screenCap; screenCap = null;
      const sum = await Promise.race([
        Promise.resolve().then(() => sc.stop()).catch((e) => ({ error: e && e.message })),
        new Promise((res) => setTimeout(() => res({ timeout: true }), 8000))
      ]);
      if (sum && !sum.timeout && !sum.error) {
        try {
          fs.writeFileSync(path.join(FRAMES_DIR, 'screen-capture.json'), JSON.stringify({
            backend: sum.backend,
            startedAt: new Date(startedAt || Date.now()).toISOString(),
            durationMs: sum.durationMs,
            frameFps: 1,
            frames: sum.frames,
            video: sum.video ? path.relative(SESSION_DIR, sum.video).replace(/\\/g, '/') : null
          }, null, 2), 'utf8');
        } catch (_) {}
        console.log(`[recorder] Cattura schermo: ${sum.frames} frame` + (sum.video ? ' + video' : '') + ' in original flow/frames.');
      } else {
        console.log('[recorder] Cattura schermo: stop non confermato, i frame gia\u0027 scritti restano su disco.');
      }
    }
    // 2) Hard-exit garantito dopo 6s, qualunque cosa stia bloccando il browser.
    const hardExit = setTimeout(() => {
      console.log('[recorder] Hard-exit (close del browser troppo lento).');
      process.exit(0);
    }, 6000);
    hardExit.unref?.();
    // 3) Tentativo di chiusura pulita (trace/video/HAR) in parallelo, con timeout corti.
    const withTimeout = (p, ms, label) => Promise.race([
      Promise.resolve(p).catch((e) => console.log(`[recorder] ${label}: ${e.message || e}`)),
      new Promise((res) => setTimeout(() => { console.log(`[recorder] ${label}: timeout ${ms}ms, salto`); res(); }, ms))
    ]);
    await withTimeout(context.tracing.stop({ path: TRACE_FILE }), 3000, 'tracing.stop');
    await withTimeout(context.close(), 3000, 'context.close');
    if (browser) await withTimeout(browser.close(), 1500, 'browser.close');
    console.log('[recorder] Chiusura completata. Artefatti in: ' + SESSION_DIR);
    clearTimeout(hardExit);
    process.exit(0);
  }

  process.on('SIGINT',  finalize);
  process.on('SIGTERM', finalize);
  context.on('close', finalize);
  if (browser) browser.on('disconnected', finalize);

  // Stop pulito da extension VS Code (sentinella su stdin)
  try {
    process.stdin.setEncoding('utf8');
    let buf = '';
    process.stdin.on('data', (d) => {
      buf += d;
      if (buf.includes('__STOP__')) {
        console.log('[recorder] Stop richiesto dall\u0027host. Salvo e chiudo...');
        finalize();
      }
    });
    process.stdin.on('end', () => { /* host ha chiuso stdin: termina anche noi */ if (!finished) finalize(); });
  } catch (_) {}
})().catch((err) => {
  console.error('[recorder] Errore fatale:', err);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Generazione di uno script Playwright dagli eventi raccolti.
// ---------------------------------------------------------------------------
function jsString(s) { return JSON.stringify(s == null ? '' : String(s)); }

function generateSpec(events, startUrl) {
  const lines = [
    `// Generato automaticamente da edge-action-recorder il ${new Date().toISOString()}`,
    `const { test, expect } = require('@playwright/test');`,
    ``,
    `test('sessione registrata', async ({ page }) => {`,
    `  await page.goto(${jsString(startUrl)});`,
  ];
  let lastNavUrl = startUrl;
  for (const ev of events) {
    const sel = ev.target && ev.target.selector ? ev.target.selector : null;
    switch (ev.type) {
      case 'navigation':
        if (ev.url && ev.url !== lastNavUrl) {
          lines.push(`  await page.waitForURL(${jsString(ev.url)});`);
          lastNavUrl = ev.url;
        }
        break;
      case 'click':
        if (sel) lines.push(`  await page.locator(${jsString(sel)}).first().click();`); break;
      case 'dblclick':
        if (sel) lines.push(`  await page.locator(${jsString(sel)}).first().dblclick();`); break;
      case 'contextmenu':
        if (sel) lines.push(`  await page.locator(${jsString(sel)}).first().click({ button: 'right' });`); break;
      case 'input':
        if (sel) lines.push(`  await page.locator(${jsString(sel)}).first().fill(${jsString(ev.value)});`); break;
      case 'change':
        if (sel && ev.selectedValue !== undefined) {
          lines.push(`  await page.locator(${jsString(sel)}).first().selectOption(${jsString(ev.selectedValue)});`);
        } else if (sel && ev.checked !== undefined) {
          lines.push(`  await page.locator(${jsString(sel)}).first().${ev.checked ? 'check' : 'uncheck'}();`);
        }
        break;
      case 'submit':
        if (sel) lines.push(`  await page.locator(${jsString(sel)}).first().evaluate(f => f.submit());`); break;
      case 'keydown':
        if (ev.key && ev.key.length > 1 || ev.ctrl || ev.alt || ev.meta) {
          const mods = [];
          if (ev.ctrl) mods.push('Control');
          if (ev.shift) mods.push('Shift');
          if (ev.alt) mods.push('Alt');
          if (ev.meta) mods.push('Meta');
          lines.push(`  await page.keyboard.press(${jsString([...mods, ev.key].join('+'))});`);
        }
        break;
      case 'scroll':
        lines.push(`  await page.evaluate(() => window.scrollTo(${ev.x || 0}, ${ev.y || 0}));`); break;
      case 'resize':
        lines.push(`  await page.setViewportSize({ width: ${ev.w}, height: ${ev.h} });`); break;
      case 'dialog':
        lines.push(`  // dialog ${ev.kind}: ${(ev.message||'').replace(/\r?\n/g,' ')}`); break;
      default:
        // gli altri eventi sono solo informativi nel JSON
        break;
    }
  }
  lines.push(`});`, ``);
  return lines.join('\n');
}
