/**
 * Flowpilot — VS Code Extension
 *
 * Sostituisce la web UI con un pannello dentro VS Code.
 * Spawna recorder.js / replay.js (bundle nell'estensione) come child process.
 * Salva tutto in globalStorageUri/recordings (persistente per utente).
 */
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
// Avvio/rilevamento browser (Microsoft Edge e Google Chrome) — vedi lib/browser.js.
const browserLauncher = require('./lib/browser');

let panel = null;
let child = null;
let childKind = null;
let childInfo = {};
let recordingsDir = null;
let edgeProfileDir = null;
let libraryFile = null;
let logBuf = [];
const MAX_LOG = 800;
let extensionDir = null;
// Eseguibile Node da usare per gli script figli (recorder/replay). VS Code gira
// su Electron: con ELECTRON_RUN_AS_NODE=1 questo eseguibile si comporta come un
// Node puro, quindi NON serve che l'utente abbia "node" nel PATH di sistema.
const nodeExec = process.execPath;

function resolveEdgeProfileDir(context) {
  const cfg = (vscode.workspace.getConfiguration('edgeRecorder').get('edgeProfileDir') || '').trim();
  const dir = cfg || path.join(context.globalStorageUri.fsPath, 'edge-profile');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function ensureRecordingsDir(context) {
  const cfg = vscode.workspace.getConfiguration('edgeRecorder').get('recordingsPath') || '';
  // Default: globalStorage dell'estensione (invisibile all'utente, persistente
  // tra aggiornamenti perche' fuori dalla cartella dell'estensione).
  const def = path.join(context.globalStorageUri.fsPath, 'recordings');
  const dir = cfg && cfg.trim() ? cfg.trim() : def;
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { vscode.window.showErrorMessage(`Flowpilot: impossibile creare "${dir}" (${e.message}). Uso il fallback in globalStorage.`); const fb = path.join(context.globalStorageUri.fsPath, 'recordings'); fs.mkdirSync(fb, { recursive: true }); return fb; }
  return dir;
}

// File JSON (in globalStorage) con la libreria di link/task salvati dall'utente.
// Persistente tra aggiornamenti perche' fuori dalla cartella dell'estensione.
function ensureLibraryFile(context) {
  const dir = context.globalStorageUri.fsPath;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return path.join(dir, 'library.json');
}

// Cartella in cui finiscono le istruzioni e i report delle navigazioni AI
// "da prompt" (non legate a una registrazione). Separata dalle recordings.
function ensureAiNavDir(context) {
  const dir = path.join(context.globalStorageUri.fsPath, 'ai-navigations');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

// Cartella in cui finiscono i fotogrammi estratti dai video importati e le
// relative istruzioni/report. Separata dalle recordings e dalle navigazioni.
function ensureVideoImportDir(context) {
  const dir = path.join(context.globalStorageUri.fsPath, 'video-imports');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

// Registra il server MCP "playwright" tramite l'API ufficiale di VS Code
// (>= 1.102), puntando alla copia di @playwright/mcp inclusa nel pacchetto ed
// eseguita con il Node di VS Code (ELECTRON_RUN_AS_NODE). Cosi' l'AI replay
// funziona senza npx e senza Node installato sul sistema dell'utente.
//
// Il canale del browser (Edge o Chrome) viene rilevato automaticamente in base
// all'impostazione edgeRecorder.browser e a quale browser e' davvero installato.
function getBrowserPreference() {
  return (vscode.workspace.getConfiguration('edgeRecorder').get('browser') || 'auto');
}

function writeMcpConfig(context) {
  // Config dedicata: browser di sistema, finestra massimizzata, niente viewport ridotto.
  const mcpConfigPath = path.join(context.globalStorageUri.fsPath, 'playwright-mcp-maximized.json');
  const channel = browserLauncher.detectInstalledChannel(getBrowserPreference());
  try {
    fs.mkdirSync(path.dirname(mcpConfigPath), { recursive: true });
    fs.writeFileSync(mcpConfigPath, JSON.stringify({
      browser: {
        browserName: 'chromium',
        launchOptions: { channel, args: ['--start-maximized'] },
        contextOptions: { viewport: null }
      }
    }, null, 2), 'utf8');
  } catch (_) {}
  return mcpConfigPath;
}

function registerMcpProvider(context) {
  if (!vscode.lm || typeof vscode.lm.registerMcpServerDefinitionProvider !== 'function'
      || typeof vscode.McpStdioServerDefinition !== 'function') {
    return; // VS Code privo dell'API MCP: configurare il server manualmente.
  }

  // Permette di rigenerare la definizione del server (e quindi il canale del
  // browser) quando l'utente cambia l'impostazione edgeRecorder.browser.
  const didChangeEmitter = new vscode.EventEmitter();

  const mcpCli = path.join(context.extensionPath, 'node_modules', '@playwright', 'mcp', 'cli.js');
  const provider = {
    onDidChangeMcpServerDefinitions: didChangeEmitter.event,
    provideMcpServerDefinitions() {
      const mcpConfigPath = writeMcpConfig(context);
      return [
        new vscode.McpStdioServerDefinition(
          'Playwright (Flowpilot)',
          process.execPath,
          [mcpCli, '--config', mcpConfigPath],
          { ELECTRON_RUN_AS_NODE: '1' }
        )
      ];
    }
  };
  try {
    context.subscriptions.push(
      vscode.lm.registerMcpServerDefinitionProvider('edgeRecorder.playwright', provider),
      didChangeEmitter,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('edgeRecorder.browser')) {
          try { didChangeEmitter.fire(); } catch (_) {}
        }
      })
    );
  } catch (_) { /* non bloccare l'attivazione dell'estensione */ }
}

function activate(context) {
  extensionDir = context.extensionPath;
  recordingsDir = ensureRecordingsDir(context);
  edgeProfileDir = resolveEdgeProfileDir(context);
  libraryFile = ensureLibraryFile(context);
  registerMcpProvider(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('edgeRecorder.open', () => openPanel(context)),
    vscode.commands.registerCommand('edgeRecorder.openRecordingsFolder', () => {
      vscode.env.openExternal(vscode.Uri.file(recordingsDir));
    }),
    // L'icona nella activity bar non mostra piu' un pannello laterale: appena la
    // view diventa visibile apre l'app massimizzata nell'editor e richiude la
    // sidebar, cosi' resta visibile solo l'applicazione vera e propria.
    vscode.window.registerWebviewViewProvider('edgeRecorder.home', {
      resolveWebviewView(view) {
        view.webview.options = { enableScripts: true };
        view.webview.html = renderLauncherHtml();
        view.webview.onDidReceiveMessage(() => openAppMaximized(context));
        openAppMaximized(context);
        view.onDidChangeVisibility(() => { if (view.visible) openAppMaximized(context); });
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('edgeRecorder.recordingsPath')) {
        recordingsDir = ensureRecordingsDir(context);
        if (panel) {
          panel.webview.options = {
            ...panel.webview.options,
            localResourceRoots: [vscode.Uri.file(context.extensionPath), vscode.Uri.file(recordingsDir)]
          };
          postState(); postSessions(); postSettings();
        }
      }
      if (e.affectsConfiguration('edgeRecorder.edgeProfileDir')) {
        edgeProfileDir = resolveEdgeProfileDir(context);
      }
      if ((e.affectsConfiguration('edgeRecorder.language') || e.affectsConfiguration('edgeRecorder.startupView') || e.affectsConfiguration('edgeRecorder.showOnboarding')) && panel) {
        postSettings();
      }
    })
  );

  // Apri automaticamente al primo avvio se l'utente lo vuole
  // (commentato: per non essere invasivo, lo apre solo via comando)
}

// Apre l'app nell'editor (massimizzata) e chiude la sidebar, in modo che dopo il
// click sull'icona resti visibile solo l'applicazione e non il pannello laterale.
function openAppMaximized(context) {
  openPanel(context);
  // Chiude la barra laterale: la view-launcher ha gia' assolto al suo scopo.
  setTimeout(() => { try { vscode.commands.executeCommand('workbench.action.closeSidebar'); } catch (_) {} }, 0);
}

// HTML minimale per la view nella activity bar: di norma non viene mostrato
// (la sidebar viene chiusa subito), ma fa da fallback con un pulsante per
// riaprire l'app se la chiusura automatica non andasse a buon fine.
function renderLauncherHtml() {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body{ font-family:"Segoe UI",system-ui,sans-serif; color:var(--vscode-foreground); padding:14px; }
  p{ color:var(--vscode-descriptionForeground); font-size:12px; line-height:1.5; margin:0 0 12px; }
  button{ width:100%; font:inherit; font-weight:600; padding:8px 12px; border:0; border-radius:4px; cursor:pointer; background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
  button:hover{ background:var(--vscode-button-hoverBackground); }
</style></head><body>
  <p>L'app si apre massimizzata nell'editor.</p>
  <button id="open" type="button">Apri Flowpilot</button>
  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('open').addEventListener('click', () => vscode.postMessage({ cmd: 'open' }));
  </script>
</body></html>`;
}

function openPanel(context) {
  if (panel) { panel.reveal(vscode.ViewColumn.Active); return; }

  panel = vscode.window.createWebviewPanel(
    'edgeRecorder',
    'Flowpilot',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(context.extensionPath),
        vscode.Uri.file(recordingsDir)
      ]
    }
  );

  panel.webview.html = renderHtml(panel.webview, context);
  panel.onDidDispose(() => { panel = null; });
  panel.webview.onDidReceiveMessage(async (msg) => {
    try { await handleMessage(msg, context); }
    catch (e) {
      panel?.webview.postMessage({ type: 'error', error: String(e.message || e) });
    }
  });

  // stato iniziale
  postState();
  postSessions();
}

function post(type, data) { panel?.webview.postMessage({ type, ...data }); }
function postLog(line) {
  const e = { t: Date.now(), line };
  logBuf.push(e); if (logBuf.length > MAX_LOG) logBuf.shift();
  post('log', { entry: e });
}
function postState() { post('state', { running: !!child, kind: childKind, info: childInfo }); }
function postSessions() { post('sessions', { sessions: listSessions() }); }

// ---------------- Library (link/task salvati) ----------------
function genLibId() {
  return 'lib-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}
function loadLibrary() {
  try {
    if (libraryFile && fs.existsSync(libraryFile)) {
      const data = JSON.parse(fs.readFileSync(libraryFile, 'utf8'));
      if (data && Array.isArray(data.items)) return data.items;
    }
  } catch (_) { /* file mancante o corrotto: libreria vuota */ }
  return [];
}
function saveLibrary(items) {
  try {
    fs.mkdirSync(path.dirname(libraryFile), { recursive: true });
    fs.writeFileSync(libraryFile, JSON.stringify({ items }, null, 2), 'utf8');
  } catch (e) {
    vscode.window.showErrorMessage(`Flowpilot: impossibile salvare le Skills (${e.message}).`);
  }
}
function postLibrary() { post('library', { items: loadLibrary(), builtinPrompt: defaultReplayPromptText() }); }

// ---------------- i18n (dialoghi nativi VS Code) ----------------
function currentLang() {
  const l = vscode.workspace.getConfiguration('edgeRecorder').get('language');
  return l === 'en' ? 'en' : 'it';
}
const NATIVE_STRINGS = {
  it: {
    enterUrlSave: 'Inserisci un URL prima di salvare.',
    saveSkillName: 'Nome della Skill',
    skillSaved: 'Skill salvata',
    btnDelete: 'Elimina',
    confirmDeleteSkill: (n) => `Eliminare "${n}" dalle Skills?`,
    skillNotFound: 'Skill non trovata.',
    noSelection: 'Nessuna voce selezionata.',
    browseUseFolder: 'Usa questa cartella',
    browseTitle: 'Cartella di output di Flowpilot',
    renameSession: 'Nuovo nome sessione',
    confirmDeleteSession: (n) => `Eliminare la sessione "${n}"?`,
    clearAllPrompt: 'Per eliminare TUTTE le sessioni digita ELIMINA',
    clearKeyword: 'ELIMINA',
    renameReplay: 'Nuovo nome replay',
    confirmDeleteReplay: (n) => `Eliminare il replay "${n}"?`,
    enterUrlNav: 'Inserisci un URL per la navigazione AI.',
    videoNoFrames: 'Nessun fotogramma da analizzare. Estrai prima i fotogrammi dal video.',
    videoFramesSaved: (n) => `Video: ${n} fotogrammi pronti, invio a Copilot per l'analisi…`
  },
  en: {
    enterUrlSave: 'Enter a URL before saving.',
    saveSkillName: 'Skill name',
    skillSaved: 'Skill saved',
    btnDelete: 'Delete',
    confirmDeleteSkill: (n) => `Delete "${n}" from Skills?`,
    skillNotFound: 'Skill not found.',
    noSelection: 'No item selected.',
    browseUseFolder: 'Use this folder',
    browseTitle: 'Flowpilot output folder',
    renameSession: 'New session name',
    confirmDeleteSession: (n) => `Delete session "${n}"?`,
    clearAllPrompt: 'To delete ALL sessions type DELETE',
    clearKeyword: 'DELETE',
    renameReplay: 'New replay name',
    confirmDeleteReplay: (n) => `Delete replay "${n}"?`,
    enterUrlNav: 'Enter a URL for the AI navigation.',
    videoNoFrames: 'No frames to analyze. Extract the frames from the video first.',
    videoFramesSaved: (n) => `Video: ${n} frames ready, sending to Copilot for analysis…`
  }
};
function L(key, arg) {
  const dict = NATIVE_STRINGS[currentLang()] || NATIVE_STRINGS.it;
  const v = dict[key] != null ? dict[key] : NATIVE_STRINGS.it[key];
  return typeof v === 'function' ? v(arg) : v;
}

// ---------------- Settings ----------------
function currentSettingsPayload() {
  const cfg = vscode.workspace.getConfiguration('edgeRecorder');
  return {
    language: currentLang(),
    showOnboarding: cfg.get('showOnboarding') !== false,
    startupView: cfg.get('startupView') || 'home',
    outputDir: (cfg.get('recordingsPath') || '').trim(),
    effectiveDir: recordingsDir
  };
}
function postSettings() { post('settings', currentSettingsPayload()); }

// ---------------- Sessions ----------------
function eventsFileFor(sessionPath) {
  const a = path.join(sessionPath, 'original flow', 'events.json');
  if (fs.existsSync(a)) return a;
  return path.join(sessionPath, 'events.json');
}

// Raccoglie i report generati (Markdown e Word) di una sessione, cosi' che
// possano essere elencati e aperti direttamente dalla sezione "Sessioni".
// Esclude i file di istruzioni (prompt) e i dati grezzi di "original flow".
function collectSessionReports(sessionPath) {
  const out = [];
  const seen = new Set();
  const add = (file, opts) => {
    try {
      const ext = path.extname(file).toLowerCase();
      if (ext !== '.md' && ext !== '.docx') return;
      const base = path.basename(file);
      if (/-instructions\.md$/i.test(base)) return; // e' il prompt, non un report
      const real = path.resolve(file);
      if (seen.has(real)) return;
      const st = fs.statSync(real);
      if (!st.isFile()) return;
      seen.add(real);
      out.push({
        name: base,
        rel: (opts && opts.external) ? base : (path.relative(sessionPath, real) || base),
        path: real,
        kind: ext === '.docx' ? 'docx' : 'md',
        mtime: st.mtimeMs,
        external: !!(opts && opts.external)
      });
    } catch (_) {}
  };
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'original flow') continue; // dati grezzi, niente report
        walk(full, depth + 1);
      } else if (ent.isFile()) {
        add(full);
      }
    }
  };
  walk(sessionPath, 0);
  // Se l'utente ha configurato una cartella Word esterna, includi anche i .docx
  // il cui nome contiene il nome della sessione (restano apribili da qui).
  try {
    const cfgWord = (vscode.workspace.getConfiguration('edgeRecorder').get('wordOutputPath') || '').trim();
    if (cfgWord && fs.existsSync(cfgWord)) {
      const sessName = path.basename(sessionPath);
      for (const n of fs.readdirSync(cfgWord)) {
        if (n.toLowerCase().endsWith('.docx') && n.includes(sessName)) {
          add(path.join(cfgWord, n), { external: true });
        }
      }
    }
  } catch (_) {}
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function listSessions() {
  if (!fs.existsSync(recordingsDir)) return [];
  return fs.readdirSync(recordingsDir)
    .map(name => path.join(recordingsDir, name))
    .filter(p => { try { return fs.statSync(p).isDirectory() && fs.existsSync(eventsFileFor(p)); } catch(_) { return false; } })
    .map(p => {
      let nEvents = 0, firstUrl = '';
      try {
        const ev = JSON.parse(fs.readFileSync(eventsFileFor(p),'utf8'));
        nEvents = ev.length;
        const nav = ev.find(e => e.url);
        firstUrl = nav ? nav.url : '';
      } catch (_) {}
      const replays = fs.readdirSync(p).filter(n => n.startsWith('replay-')).map(n => {
        let summary = null;
        try { summary = JSON.parse(fs.readFileSync(path.join(p, n, 'replay-report.json'), 'utf8')); } catch (_) {}
        return {
          name: n,
          mtime: fs.statSync(path.join(p, n)).mtimeMs,
          ok: summary?.ok, fail: summary?.fail, total: summary?.total,
          reportHtml: vscode.Uri.file(path.join(p, n, 'replay-report.html')).fsPath
        };
      }).sort((a,b)=>b.mtime-a.mtime);
      return {
        name: path.basename(p),
        path: p,
        mtime: fs.statSync(p).mtimeMs,
        nEvents, firstUrl, replays,
        reports: collectSessionReports(p)
      };
    })
    .sort((a,b)=>b.mtime-a.mtime);
}

function safeName(s) {
  return String(s).trim().replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+$/, '_');
}
function resolveSession(name) {
  const safe = safeName(name);
  const full = path.join(recordingsDir, safe);
  if (!full.startsWith(recordingsDir + path.sep)) throw new Error('path non valido');
  if (!fs.existsSync(full)) throw new Error('sessione non trovata');
  return full;
}
function safeReplayName(name) {
  let s = safeName(name);
  if (!s.startsWith('replay-')) s = 'replay-' + s;
  return s;
}
function resolveReplay(sessionName, replayName) {
  const sDir = resolveSession(sessionName);
  const safe = safeReplayName(replayName);
  const full = path.join(sDir, safe);
  if (!full.startsWith(sDir + path.sep)) throw new Error('path non valido');
  if (!fs.existsSync(full)) throw new Error('replay non trovato');
  return full;
}

// ---------------- Child process ----------------
function startChild(kind, scriptName, args, info) {
  if (child) throw new Error('Un altro processo è già in esecuzione');
  childKind = kind;
  // Stato iniziale: per il recorder il processo è solo "in attesa" finché
  // l'utente non preme ● Start nell'overlay del browser.
  childInfo = { ...(info || {}), state: kind === 'record' ? 'waiting' : 'running' };
  logBuf = [];
  postLog(`▶ ${kind}: ${scriptName} ${args.join(' ')}`);
  const scriptPath = path.join(extensionDir, scriptName);
  const cfg = vscode.workspace.getConfiguration('edgeRecorder');
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    RECORDINGS_DIR: recordingsDir,
    EDGE_PROFILE_DIR: edgeProfileDir,
    // Preferenza browser (auto | msedge | chrome) propagata a recorder/replay.
    BROWSER_PREF: (cfg.get('browser') || 'auto'),
    // Registrazione a schermo intero (video unico + frame a 1 fps) del recorder.
    SCREEN_CAPTURE: (cfg.get('screenCapture') === false ? '0' : '1'),
    SCREEN_CAP_FPS: String(cfg.get('screenCaptureFps') || 4),
    FFMPEG_PATH: (cfg.get('ffmpegPath') || '')
  };
  // Usiamo l'eseguibile di VS Code in modalita' "run as node": niente dipendenza
  // da un "node" nel PATH dell'utente. Niente shell: il PID e' direttamente il
  // processo Node, cosi' stop/kill funzionano davvero anche su Windows.
  child = cp.spawn(nodeExec, [scriptPath, ...args], {
    cwd: extensionDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  const handleLine = (line) => {
    postLog(line);
    // Marker emesso da recorder.js a ogni cambio di stato
    const m = /^\[recorder\]\[STATE\]\s+(\w+)/.exec(line);
    if (m) {
      childInfo = { ...childInfo, state: m[1] };
      postState();
    }
    // Cattura la cartella replay creata da replay.js (logga "[replay] Output: <path>")
    if (kind === 'replay') {
      const r = /^\[replay\]\s+Output:\s+(.+?)\s*$/.exec(line);
      if (r) {
        const full = r[1].trim();
        childInfo = { ...childInfo, replayDir: full, replayName: path.basename(full) };
      }
    }
    // Cattura la cartella sessione creata da recorder.js (logga "[recorder][DIR] <path>")
    if (kind === 'record') {
      const d = /^\[recorder\]\[DIR\]\s+(.+?)\s*$/.exec(line);
      if (d) {
        const full = d[1].trim();
        childInfo = { ...childInfo, sessionDir: full, sessionName: path.basename(full) };
      }
    }
  };
  child.stdout.on('data', (d) => String(d).split(/\r?\n/).filter(Boolean).forEach(handleLine));
  child.stderr.on('data', (d) => String(d).split(/\r?\n/).filter(Boolean).forEach(l => postLog('[err] ' + l)));
  child.on('error', (e) => postLog('[err] spawn: ' + e.message));
  child.on('exit', (code, sig) => {
    postLog(`■ Terminato (exit ${code}${sig ? ', signal ' + sig : ''})`);
    const wasReplay = childKind === 'replay';
    const wasRecord = childKind === 'record';
    const finishedInfo = childInfo || {};
    child = null; childKind = null; childInfo = {};
    postState(); postSessions();
    // Dopo una registrazione andata a buon fine (events.json presente), segnala
    // alla UI la sessione creata cosi' da mostrare un pulsante di replay rapido.
    if (wasRecord && finishedInfo.sessionDir) {
      try {
        if (fs.existsSync(eventsFileFor(finishedInfo.sessionDir))) {
          post('recordFinished', { sessionName: path.basename(finishedInfo.sessionDir) });
        }
      } catch (_) {}
    }
    // Auto-flow: dopo un replay, lancia automaticamente compare + askCopilot
    // senza richiedere selezione manuale dell'utente.
    if (wasReplay && finishedInfo.name) {
      let replayName = finishedInfo.replayName;
      if (!replayName) {
        // fallback: prende il replay piu' recente nella sessione
        try {
          const sDir = path.join(recordingsDir, safeName(finishedInfo.name));
          const replays = fs.readdirSync(sDir)
            .filter(n => n.startsWith('replay-'))
            .map(n => ({ n, m: fs.statSync(path.join(sDir, n)).mtimeMs }))
            .sort((a, b) => b.m - a.m);
          if (replays[0]) replayName = replays[0].n;
        } catch (_) {}
      }
      if (replayName) {
        post('replayFinished', { sessionName: finishedInfo.name, replayName });
      }
    }
  });
  postState();
}
function stopChild() {
  if (!child) return;
  postLog('■ Stop richiesto: salvo e chiudo Edge…');
  // 1) sentinella su stdin: lo script chiama finalize() in modo pulito
  try { child.stdin.write('__STOP__\n'); } catch (_) {}
  try { child.stdin.end(); } catch (_) {}
  // 2) fallback dopo 16s: SIGTERM (tempo extra per finalizzare video + frame a schermo intero)
  const c1 = child;
  setTimeout(() => {
    if (child && child === c1) { try { child.kill(); } catch (_) {} }
  }, 16000);
  // 3) ultima spiaggia dopo 24s: kill dell'albero di processi (cross-platform).
  setTimeout(() => {
    if (child && child === c1 && child.pid) {
      postLog('[err] Stop forzato: kill albero processi');
      try {
        if (process.platform === 'win32') {
          cp.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill('SIGKILL');
        }
      } catch (_) {}
    }
  }, 24000);
}

// ---------------- Message handler ----------------
async function handleMessage(msg, context) {
  switch (msg.cmd) {
    case 'init':
      postState(); postSessions(); postLibrary(); postSettings();
      // re-invia il log buffer
      for (const e of logBuf) post('log', { entry: e });
      return;

    case 'record':
      startChild('record', 'recorder.js', [msg.url || 'https://en.wikipedia.org/wiki/Microsoft'], { url: msg.url });
      return;

    case 'aiReplay': {
      // Modalita' B: invece di pilotare Playwright direttamente con replay.js,
      // genera un .md con le azioni registrate + istruzioni esplicite e lo
      // passa a Copilot Chat. Sara' Copilot a riprodurre il flusso usando i
      // tool Playwright MCP (browser_navigate, browser_click, ecc.) e a
      // scrivere un report finale nella cartella ai-replay-<ts>.
      const sDir = resolveSession(msg.name);
      const events = JSON.parse(fs.readFileSync(eventsFileFor(sDir), 'utf8'));
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const aiDir = path.join(sDir, `ai-replay-${ts}`);
      fs.mkdirSync(aiDir, { recursive: true });
      // Cartella di output per il .docx: "wordOutputPath" se configurato,
      // altrimenti la STESSA cartella del report .md di questo AI replay, cosi'
      // .md e .docx restano insieme nella sessione e apribili dalla sezione Sessioni.
      let wordOut = (vscode.workspace.getConfiguration('edgeRecorder').get('wordOutputPath') || '').trim();
      if (!wordOut) wordOut = aiDir;
      try { fs.mkdirSync(wordOut, { recursive: true }); } catch (_) {}
      const docxLib = path.join(extensionDir, 'node_modules', 'docx');
      // Diff visivo: baseline = screenshot del flusso ORIGINALE (uno per azione
      // chiave, salvati dal recorder), actual = screenshot che l'agente cattura
      // ad ogni passo del replay. La CLI lib/visual-diff.js li confronta.
      const originalShotsDir = path.join(sDir, 'original flow', 'screenshots');
      const originalFramesDir = path.join(sDir, 'original flow', 'frames');
      const replayShotsDir = path.join(aiDir, 'replay-shots');
      const visualDiffDir = path.join(aiDir, 'visual-diff');
      try { fs.mkdirSync(replayShotsDir, { recursive: true }); } catch (_) {}
      try { fs.mkdirSync(visualDiffDir, { recursive: true }); } catch (_) {}
      const visualDiffCli = path.join(extensionDir, 'lib', 'visual-diff.js');
      const md = buildAIReplayPrompt({
        sessionName: msg.name,
        events,
        sessionDir: sDir,
        aiReplayDir: aiDir,
        wordOutDir: wordOut,
        docxLib,
        originalShotsDir,
        originalFramesDir,
        replayShotsDir,
        visualDiffDir,
        visualDiffCli
      });
      const promptFile = path.join(aiDir, 'ai-replay-instructions.md');
      fs.writeFileSync(promptFile, md, 'utf8');
      postLog(`🤖 AI Replay: prompt scritto in ${promptFile}`);
      // Riusa lo stesso pattern di askCopilot: apre il file in editor + apre
      // Copilot Chat con il prompt + copia negli appunti come fallback.
      await handleMessage({ cmd: 'askCopilot', file: promptFile, markdown: md }, context);
      postSessions();
      return;
    }

    case 'aiNavigate': {
      // Navigazione "da prompt": l'utente fornisce un URL e un obiettivo in
      // linguaggio naturale; generiamo le istruzioni per Copilot (Playwright MCP)
      // senza bisogno di una registrazione.
      const url = (msg.url || '').trim();
      const prompt = (msg.prompt || '').trim();
      if (!url) { vscode.window.showWarningMessage(L('enterUrlNav')); return; }
      await runAiNavigation(context, [{ url, prompt, name: msg.name }]);
      return;
    }

    case 'videoAnalyze': {
      // BETA — Video → automazione: la webview ha gia' estratto i fotogrammi
      // (localmente, via <video>+canvas) e ce li manda come data URL. Qui li
      // salviamo come immagini, costruiamo un prompt che istruisce Copilot ad
      // analizzarli con la sua capacita' visiva, ricostruire le azioni e
      // riprodurle con i tool Playwright MCP.
      const frames = Array.isArray(msg.frames) ? msg.frames : [];
      if (!frames.length) { vscode.window.showWarningMessage(L('videoNoFrames')); return; }
      // Le immagini arrivano gia' pronte dalla webview (<= 20): o fotogrammi
      // singoli, oppure "contact sheet" (griglie) che ne contengono piu' di uno
      // ciascuna, cosi' TUTTI i fotogrammi rientrano nel limite del modello.
      const composite = !!msg.composite;
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const root = ensureVideoImportDir(context);
      const videoDir = path.join(root, `video-${ts}`);
      const framesDir = path.join(videoDir, 'frames');
      fs.mkdirSync(framesDir, { recursive: true });
      const saved = [];
      frames.forEach((f, i) => {
        const m = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/.exec((f && f.dataUrl) || '');
        if (!m) return;
        const ext = (m[1].toLowerCase() === 'jpeg') ? 'jpg' : m[1].toLowerCase();
        const base = composite ? 'sheet' : 'frame';
        const name = `${base}-${String(i + 1).padStart(3, '0')}.${ext}`;
        const items = (Array.isArray(f.items) && f.items.length) ? f.items : [{ index: i + 1, t: f.t }];
        try { fs.writeFileSync(path.join(framesDir, name), Buffer.from(m[2], 'base64')); saved.push({ name, items }); }
        catch (_) {}
      });
      if (!saved.length) { vscode.window.showWarningMessage(L('videoNoFrames')); return; }
      let wordOut = (vscode.workspace.getConfiguration('edgeRecorder').get('wordOutputPath') || '').trim();
      if (!wordOut) wordOut = videoDir;
      try { fs.mkdirSync(wordOut, { recursive: true }); } catch (_) {}
      const docxLib = path.join(extensionDir, 'node_modules', 'docx');
      const md = buildVideoReplayPrompt({
        url: (msg.url || '').trim(),
        hint: (msg.hint || '').trim(),
        fileName: (msg.fileName || '').trim(),
        durationSec: msg.durationSec,
        frames: saved,
        composite,
        framesDir,
        videoDir,
        wordOutDir: wordOut,
        docxLib
      });
      const promptFile = path.join(videoDir, 'video-instructions.md');
      fs.writeFileSync(promptFile, md, 'utf8');
      const totalFrames = saved.reduce((n, s) => n + ((s.items && s.items.length) || 1), 0);
      postLog(L('videoFramesSaved', totalFrames));
      postLog(`🎬 Video import: ${totalFrames} fotogrammi in ${saved.length} immagini → ${framesDir}`);
      await handleMessage({ cmd: 'askCopilot', file: promptFile, markdown: md }, context);
      return;
    }

    case 'librarySaveAsk': {
      const url = (msg.url || '').trim();
      const prompt = (msg.prompt || '').trim();
      if (!url) { vscode.window.showWarningMessage(L('enterUrlSave')); return; }
      const name = await vscode.window.showInputBox({ prompt: L('saveSkillName'), value: (msg.name || url).slice(0, 80) });
      if (!name) return;
      const items = loadLibrary();
      items.push({ id: genLibId(), name: name.trim(), url, prompt, createdAt: Date.now() });
      saveLibrary(items);
      postLibrary();
      vscode.window.setStatusBarMessage(L('skillSaved'), 2500);
      return;
    }

    case 'libraryUpdateAsk': {
      const items = loadLibrary();
      const it = items.find(i => i.id === msg.id);
      if (!it) return;
      const name = await vscode.window.showInputBox({ prompt: 'Nome', value: it.name });
      if (name == null) return;
      const url = await vscode.window.showInputBox({ prompt: 'URL', value: it.url || '' });
      if (url == null) return;
      const prompt = await vscode.window.showInputBox({ prompt: 'Obiettivo per l\u2019AI (vuoto = solo link da usare per registrare/navigare)', value: it.prompt || '' });
      if (prompt == null) return;
      it.name = name.trim(); it.url = url.trim(); it.prompt = prompt.trim();
      saveLibrary(items);
      postLibrary();
      return;
    }

    case 'libraryDelete': {
      const items = loadLibrary().filter(i => i.id !== msg.id);
      saveLibrary(items);
      postLibrary();
      return;
    }

    case 'libraryDeleteAsk': {
      const it = loadLibrary().find(i => i.id === msg.id);
      const yes = L('btnDelete');
      const ans = await vscode.window.showWarningMessage(L('confirmDeleteSkill', it ? it.name : msg.id), { modal: true }, yes);
      if (ans === yes) await handleMessage({ cmd: 'libraryDelete', id: msg.id }, context);
      return;
    }

    case 'libraryRun': {
      const it = loadLibrary().find(i => i.id === msg.id);
      if (!it) { vscode.window.showWarningMessage(L('skillNotFound')); return; }
      await runAiNavigation(context, [it]);
      return;
    }

    case 'libraryUpdate': {
      const items = loadLibrary();
      const it = items.find(i => i.id === msg.id);
      if (!it) return;
      const name = (msg.name || '').trim();
      it.name = name || it.name;
      it.url = (msg.url || '').trim();
      it.prompt = (msg.prompt || '').trim();
      saveLibrary(items);
      postLibrary();
      return;
    }

    case 'libraryRunSelected': {
      const ids = Array.isArray(msg.ids) ? msg.ids : [];
      const all = loadLibrary();
      const sel = ids.map(id => all.find(i => i.id === id)).filter(Boolean);
      if (!sel.length) { vscode.window.showWarningMessage(L('noSelection')); return; }
      await runAiNavigation(context, sel);
      return;
    }

    case 'settingsSetStartup': {
      const allowed = ['home', 'record', 'ai', 'library', 'sessions'];
      const view = allowed.includes(msg.view) ? msg.view : 'home';
      try {
        await vscode.workspace.getConfiguration('edgeRecorder')
          .update('startupView', view, vscode.ConfigurationTarget.Global);
      } catch (e) { vscode.window.showErrorMessage(`Flowpilot: impossibile salvare l'impostazione (${e.message}).`); }
      postSettings();
      return;
    }

    case 'settingsSetLanguage': {
      const lang = msg.lang === 'en' ? 'en' : 'it';
      try {
        await vscode.workspace.getConfiguration('edgeRecorder')
          .update('language', lang, vscode.ConfigurationTarget.Global);
      } catch (e) { vscode.window.showErrorMessage(`Flowpilot: ${e.message}`); }
      postSettings();
      return;
    }

    case 'settingsSetOnboarding': {
      const show = !!msg.show;
      try {
        await vscode.workspace.getConfiguration('edgeRecorder')
          .update('showOnboarding', show, vscode.ConfigurationTarget.Global);
      } catch (e) { vscode.window.showErrorMessage(`Flowpilot: ${e.message}`); }
      postSettings();
      return;
    }

    case 'settingsBrowseOutput': {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
        openLabel: L('browseUseFolder'), title: L('browseTitle')
      });
      if (!picked || !picked.length) return;
      await handleMessage({ cmd: 'settingsSetOutput', path: picked[0].fsPath }, context);
      return;
    }

    case 'settingsSetOutput': {
      const p = (msg.path || '').trim();
      try {
        await vscode.workspace.getConfiguration('edgeRecorder')
          .update('recordingsPath', p, vscode.ConfigurationTarget.Global);
        // L'onDidChangeConfiguration ricalcola recordingsDir e ripubblica lo
        // stato; in caso il listener non scatti (stesso valore) aggiorniamo qui.
        recordingsDir = ensureRecordingsDir(context);
        if (panel) {
          panel.webview.options = {
            ...panel.webview.options,
            localResourceRoots: [vscode.Uri.file(context.extensionPath), vscode.Uri.file(recordingsDir)]
          };
        }
        postSessions(); postSettings();
      } catch (e) { vscode.window.showErrorMessage(`Flowpilot: impossibile impostare la cartella (${e.message}).`); }
      return;
    }

    case 'stop':
      stopChild();
      return;
    case 'rename': {
      const src = resolveSession(msg.name);
      const dest = path.join(recordingsDir, safeName(msg.newName));
      if (fs.existsSync(dest)) throw new Error('esiste già una cartella con quel nome');
      fs.renameSync(src, dest);
      postSessions();
      return;
    }

    case 'renameAsk': {
      const nv = await vscode.window.showInputBox({ prompt: L('renameSession'), value: msg.name });
      if (nv && nv !== msg.name) await handleMessage({ cmd: 'rename', name: msg.name, newName: nv }, context);
      return;
    }

    case 'delete': {
      const dir = resolveSession(msg.name);
      fs.rmSync(dir, { recursive: true, force: true });
      logBuf = [];
      post('clearLog');
      postSessions();
      return;
    }

    case 'deleteAsk': {
      const yes = L('btnDelete');
      const ans = await vscode.window.showWarningMessage(L('confirmDeleteSession', msg.name), { modal: true }, yes);
      if (ans === yes) await handleMessage({ cmd: 'delete', name: msg.name }, context);
      return;
    }

    case 'clearAll': {
      if (msg.confirm !== 'ELIMINA') throw new Error('serve confirm: "ELIMINA"');
      for (const s of listSessions()) {
        try { fs.rmSync(s.path, { recursive: true, force: true }); } catch (_) {}
      }
      logBuf = [];
      post('clearLog');
      postSessions();
      return;
    }

    case 'clearAllAsk': {
      const kw = L('clearKeyword');
      const v = await vscode.window.showInputBox({ prompt: L('clearAllPrompt'), placeHolder: kw });
      if (v === kw) await handleMessage({ cmd: 'clearAll', confirm: 'ELIMINA' }, context);
      return;
    }

    case 'replayRename': {
      const src = resolveReplay(msg.sessionName, msg.replayName);
      const dest = path.join(path.dirname(src), safeReplayName(msg.newName));
      if (fs.existsSync(dest)) throw new Error('esiste già un replay con quel nome');
      fs.renameSync(src, dest);
      postSessions();
      return;
    }

    case 'replayRenameAsk': {
      const nv = await vscode.window.showInputBox({ prompt: L('renameReplay'), value: msg.replayName });
      if (nv && nv !== msg.replayName) await handleMessage({ cmd: 'replayRename', sessionName: msg.sessionName, replayName: msg.replayName, newName: nv }, context);
      return;
    }

    case 'replayDelete': {
      const dir = resolveReplay(msg.sessionName, msg.replayName);
      fs.rmSync(dir, { recursive: true, force: true });
      logBuf = [];
      post('clearLog');
      postSessions();
      return;
    }

    case 'replayDeleteAsk': {
      const yes = L('btnDelete');
      const ans = await vscode.window.showWarningMessage(L('confirmDeleteReplay', msg.replayName), { modal: true }, yes);
      if (ans === yes) await handleMessage({ cmd: 'replayDelete', sessionName: msg.sessionName, replayName: msg.replayName }, context);
      return;
    }

    case 'openReport': {
      const file = resolveReplay(msg.sessionName, msg.replayName);
      const html = path.join(file, 'replay-report.html');
      if (fs.existsSync(html)) vscode.env.openExternal(vscode.Uri.file(html));
      return;
    }

    case 'openReportFile': {
      // Apre un report generato (Markdown o Word) elencato nella sessione.
      const file = path.resolve(String(msg.path || ''));
      // Sicurezza: consenti solo file dentro la cartella registrazioni o nella
      // cartella Word configurata dall'utente (no path traversal arbitrario).
      const allowed = [path.resolve(recordingsDir)];
      const cfgWord = (vscode.workspace.getConfiguration('edgeRecorder').get('wordOutputPath') || '').trim();
      if (cfgWord) allowed.push(path.resolve(cfgWord));
      const ok = allowed.some(base => file === base || file.startsWith(base + path.sep));
      if (!ok) { vscode.window.showWarningMessage('Flowpilot: percorso del report non consentito.'); return; }
      if (!fs.existsSync(file)) { vscode.window.showWarningMessage('Flowpilot: report non trovato (forse non ancora generato dall\'AI).'); return; }
      const ext = path.extname(file).toLowerCase();
      if (ext === '.md') {
        // Markdown: apri nell'editor di VS Code (comodo da leggere/copiare).
        try {
          const doc = await vscode.workspace.openTextDocument(file);
          await vscode.window.showTextDocument(doc, { preview: false });
        } catch (_) { try { await vscode.env.openExternal(vscode.Uri.file(file)); } catch (__) {} }
      } else {
        // .docx: apri con l'app predefinita di sistema (Word).
        try { await vscode.env.openExternal(vscode.Uri.file(file)); } catch (_) {}
      }
      return;
    }

    case 'openSessionFolder': {
      const dir = resolveSession(msg.name);
      vscode.env.openExternal(vscode.Uri.file(dir));
      return;
    }

    case 'compare': {
      const sDir = resolveSession(msg.sessionName);
      const rDir = resolveReplay(msg.sessionName, msg.replayName);
      const reportPath = path.join(rDir, 'replay-report.json');
      const events = JSON.parse(fs.readFileSync(eventsFileFor(sDir), 'utf8'));
      let report;
      let partial = false;
      if (fs.existsSync(reportPath)) {
        try {
          report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        } catch (e) {
          partial = true;
        }
      } else {
        partial = true;
      }
      if (partial) {
        // Report stub: il replay non e' arrivato a scrivere il file (interrotto/crash).
        // Generiamo comunque un .md "parziale" basato sui soli eventi registrati.
        report = {
          session: sDir,
          replayedAt: new Date().toISOString(),
          durationMs: 0,
          total: 0, ok: 0, fail: 0, skip: 0,
          options: {},
          steps: [],
          partial: true,
          partialReason: 'replay-report.json mancante o non leggibile (replay interrotto prima di completarsi)'
        };
      }
      let wordOut = (vscode.workspace.getConfiguration('edgeRecorder').get('wordOutputPath') || '').trim();
      const finalReportDir = path.join(sDir, 'final report');
      // Il .md viene SEMPRE salvato in "final report" della sessione,
      // a prescindere dalla configurazione wordOutputPath (che riguarda altri output).
      try { fs.mkdirSync(finalReportDir, { recursive: true }); } catch (_) {}
      if (wordOut) { try { fs.mkdirSync(wordOut, { recursive: true }); } catch (_) {} }
      const docxLib = path.join(extensionDir, 'node_modules', 'docx');
      const md = buildComparisonMarkdown({ sessionName: msg.sessionName, replayName: msg.replayName, events, report, sessionDir: sDir, replayDir: rDir, wordOutDir: wordOut || finalReportDir, extensionDir, docxLib });
      const fname = `compare-${msg.sessionName}__${msg.replayName}.md`.replace(/[\\/:*?"<>|]/g, '_');
      const outFile = path.join(finalReportDir, fname);
      fs.writeFileSync(outFile, md, 'utf8');
      post('compareDone', { file: outFile, markdown: md });
      return;
    }

    case 'askCopilot': {
      const md = msg.markdown || '';
      const file = msg.file;
      // 1) apri il file in editor
      if (file && fs.existsSync(file)) {
        try {
          const doc = await vscode.workspace.openTextDocument(file);
          await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
        } catch (_) {}
      }
      // 2) copia il prompt negli appunti come fallback
      try { await vscode.env.clipboard.writeText(md); } catch (_) {}
      // 3) prova ad aprire Copilot Chat con il prompt
      const tries = [
        ['workbench.action.chat.open', { query: md }],
        ['workbench.action.chat.open', md],
        ['workbench.action.chat.openInSidebar', { query: md }],
        ['github.copilot.chat.open', { query: md }],
        ['github.copilot.openChat', md],
        ['workbench.panel.chat.view.copilot.focus', undefined]
      ];
      let opened = false;
      for (const [c, a] of tries) {
        try { await vscode.commands.executeCommand(c, a); opened = true; break; } catch (_) {}
      }
      if (!opened) {
        vscode.window.showWarningMessage('Non ho potuto aprire Copilot Chat automaticamente. Premi Ctrl+Alt+I e Ctrl+V (il prompt è negli appunti).');
      } else {
        vscode.window.setStatusBarMessage('Copilot Chat aperto · prompt copiato negli appunti', 3000);
      }
      return;
    }
  }
}

// ---------------- AI Replay prompt (modalita' B) ----------------
// Costruisce un .md che descrive in modo compatto e umano le azioni
// registrate, e istruisce Copilot Chat a riprodurle usando i tool
// Playwright MCP (mcp_playwright_browser_*). Copilot dovra' poi scrivere
// un report in <aiReplayDir>/ai-replay-report.md.
// Testo rappresentativo del prompt "AI Replay" inviato automaticamente a
// GitHub Copilot dopo ogni registrazione. È una skill PREDEFINITA di sola
// lettura mostrata nella sezione Skills: i segnaposto tra parentesi graffe
// ({sessione}, {URL}, {N}, ...) vengono sostituiti coi dati reali della
// registrazione al momento dell'invio (vedi buildAIReplayPrompt).
function defaultReplayPromptText() {
  const L = [];
  L.push(`# AI Replay — istruzioni per Copilot`, '');
  L.push(`Sei un agente che deve **riprodurre un flusso utente registrato** usando i tool Playwright MCP disponibili (\`mcp_playwright_browser_navigate\`, \`mcp_playwright_browser_click\`, \`mcp_playwright_browser_type\`, \`mcp_playwright_browser_snapshot\`, \`mcp_playwright_browser_press_key\`, \`mcp_playwright_browser_select_option\`, ecc.). Non scrivere codice Playwright: **chiama direttamente i tool MCP**.`, '');
  L.push(`## Contesto`, '');
  L.push(`- **Sessione registrata**: \`{sessione}\``);
  L.push(`- **Cartella sessione**: \`{cartella_sessione}\``);
  L.push(`- **Cartella di output di questo AI replay**: \`{cartella_replay}\``);
  L.push(`- **URL di partenza**: {URL}`);
  L.push(`- **Numero azioni intenzionali**: {N}`, '');
  L.push(`## Regola fondamentale`, '');
  L.push(`**Devi eseguire TUTTE le {N} azioni della tabella, in ordine, senza saltarne NESSUNA.** Ogni click su ogni bottone, ogni digitazione, ogni pressione di tasto registrata deve essere riprodotta. Non è ammesso "ottimizzare" il flusso saltando passaggi che ti sembrano ridondanti (doppi click, click su elementi già attivi, conferme, ecc.): l'utente li ha eseguiti, tu li devi eseguire. Se un'azione fallisce dopo i tentativi alternativi, **registrala come fallita ma prosegui con quelle successive** — non interrompere mai la sequenza.`, '');
  L.push(`## Procedura`, '');
  L.push(`1. **Apri il browser** su \`{URL}\` con \`mcp_playwright_browser_navigate\`.`);
  L.push(`2. Per ogni riga della tabella "Azioni da riprodurre" qui sotto, in ordine dalla 1 alla {N}:`);
  L.push(`   - prima del click usa \`mcp_playwright_browser_snapshot\` per individuare il selettore corretto (la UI può essere cambiata: usa testo / ruolo / aria-label come riferimento principale, non i selettori CSS che potrebbero essere fragili);`);
  L.push(`   - scegli il tool MCP più appropriato (\`browser_click\`, \`browser_type\`, \`browser_press_key\`, \`browser_select_option\`, \`browser_hover\`, \`browser_file_upload\`, \`browser_handle_dialog\`, ecc.) ed **eseguilo davvero**;`);
  L.push(`   - se l'elemento non viene trovato al primo tentativo, prova fino a 3 strategie alternative (testo parziale, role+name, scroll-into-view, attesa di 1-2 s per animazioni) prima di dichiarare il fallimento dello step.`);
  L.push(`3. Per gli step di tipo \`input\`/\`change\` usa il **valore finale** indicato nella colonna "Valore" (è il risultato della digitazione completa, già de-duplicato).`);
  L.push(`4. Per la navigazione conseguente a un click, **non navigare manualmente**: aspetta il caricamento e prosegui con l'azione successiva.`);
  L.push(`5. **Conta gli step eseguiti**: alla fine devi aver tentato esattamente {N} azioni. Se ne hai tentate meno, sei in errore: torna indietro e completa quelle mancanti.`);
  L.push(`6. Al termine, **scrivi un report markdown** in \`{cartella_replay}/ai-replay-report.md\` contenente: esito complessivo (\`FUNZIONANTE\` / \`DEGRADATO\` / \`ROTTO\`), tabella \`# | Azione attesa | Esito | Note\`, elenco dei fallimenti con motivazione, sezione "Cambiamenti rilevati sul sito" (bottoni rinominati/spostati, label cambiate, layout diverso, popup nuovi, redirect inattesi, elementi spariti), una **sezione "Differenze visive"** (confronto pixel tra gli screenshot del replay e quelli originali: colori, valori, grafiche diverse) e URL finale + timestamp.`);
  L.push(`7. **Genera il report Word executive** \`.docx\` (vedi sezione dedicata sotto) e salvalo nella cartella di output indicata.`);
  L.push(`8. Quando hai finito, **chiudi il browser** con \`mcp_playwright_browser_close\`.`, '');
  L.push(`## Azioni da riprodurre`, '');
  L.push(`> Una riga per azione. \`coord\` (x,y) sono le coordinate originali nel viewport — usale solo come fallback se il selettore non funziona.`, '');
  L.push(`| # | Tipo | Bersaglio | Valore / Tasto | Suggerimenti selettore | URL pagina | coord |`);
  L.push(`|---:|:---|:---|:---|:---|:---|:---|`);
  L.push(`| 1 | … | … | … | … | … | … |`);
  L.push(`| … (tutte le {N} azioni registrate) | | | | | | |`, '');
  L.push(`---`, '');
  L.push(`## Istruzioni per il report Word (.docx)`, '');
  L.push(`Dopo aver scritto il \`.md\`, **genera anche un documento Word executive** e salvalo nel path indicato al punto 7.`);
  L.push(`Libreria \`docx\` (npm) già installata con l'estensione — usala da Node, oppure usa la skill \`docx\` (python-docx).`, '');
  L.push(`**Destinatario**: manager non tecnico. **Scopo**: capire in 30 secondi se il sito è cambiato e se il flusso funziona ancora. Niente CSS, xpath, selettori, codice, comandi shell.`, '');
  L.push(`### Struttura del documento (5 sezioni, max 1 pagina)`, '');
  L.push(`1. **Intestazione** — titolo leggibile del flusso, data e durata, esito a colpo d'occhio (**FUNZIONANTE / DEGRADATO / ROTTO**).`);
  L.push(`2. **Risultato in una frase** — una sola frase in italiano (se OK: "Il flusso è stato rieseguito con successo: {N} azioni completate. Nessuna differenza significativa rilevata.").`);
  L.push(`3. **Cosa è cambiato sul sito** — tabella **Cambiamento osservato** | **Impatto sul flusso** (una riga per differenza; se nulla: "Nessun cambiamento rilevato").`);
  L.push(`4. **Differenze visive** — tabella **Momento / azione** | **Cosa è cambiato visivamente** | **Impatto** (dal diff pixel: colori, valori, testo, grafiche/icone diverse o mancanti); incorpora le immagini side-by-side più significative. Se nulla: "Nessuna differenza visiva rilevata".`);
  L.push(`5. **Tabella delle differenze nelle azioni** — **Cosa doveva succedere** | **Cosa è successo** | **Impatto**.`);
  L.push(`6. **Riferimento al dettaglio tecnico** — rimando al file \`.md\` completo.`, '');
  L.push(`**Stile**: Word con heading nativi (Title, Heading 1), tabelle vere, italiano, niente emoji.`, '');
  L.push(`---`, '');
  L.push(`**Diff visivo**: durante il replay cattura uno screenshot dopo ogni azione (cartella \`replay-shots\`) e confrontalo con lo screenshot originale corrispondente in \`original flow/screenshots\` tramite \`lib/visual-diff.js\` dell'estensione (\`node lib/visual-diff.js --baseline <original> --actual <replay> --out <visual-diff>\`): evidenzia in rosso cosa è cambiato (colori, valori, grafiche) rispetto al video originale.`, '');
  L.push(`**Nota**: i dati grezzi completi (mousemove, network, console, screenshot, video) sono nella cartella \`original flow\` della sessione se serve ulteriore contesto.`);
  return L.join('\n');
}

function buildAIReplayPrompt({ sessionName, events, sessionDir, aiReplayDir, wordOutDir, docxLib, originalShotsDir, originalFramesDir, replayShotsDir, visualDiffDir, visualDiffCli }) {
  // Tipi rumorosi che NON sono "azioni intenzionali" dell'utente: sono effetti
  // collaterali del browser o del mouse. Vengono filtrati per non gonfiare il
  // prompt, ma TUTTI gli eventi originali restano in events.json se servono.
  // Click, dblclick, contextmenu, input, change, submit, drop, dialog,
  // session_start e keydown su tasti speciali NON vengono mai filtrati: sono
  // tutte azioni che l'agente DEVE riprodurre.
  const NOISE = new Set([
    'mousemove','wheel','scroll','resize','hover','focus','blur','keyup',
    'mousedown','mouseup','compositionstart','compositionend',
    'popstate','hashchange','navigation','request','response','console'
  ]);
  // keydown solo per tasti "speciali" che modificano lo stato (Enter, Tab,
  // Escape, frecce). Le digitazioni normali sono coperte da 'input'/'change'.
  const SPECIAL_KEYS = new Set(['Enter','Tab','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Backspace','Delete','PageUp','PageDown','Home','End']);
  function humanTarget(e) {
    const t = (e && e.target) || {};
    if (t.text)      return `"${String(t.text).slice(0, 80)}"`;
    if (t.ariaLabel) return `aria-label="${t.ariaLabel}"`;
    if (t.title)     return `title="${t.title}"`;
    if (t.role)      return `${t.role}${t.tag ? ` <${t.tag}>` : ''}`;
    if (t.testId)    return `data-testid="${t.testId}"`;
    if (t.id)        return `#${t.id}`;
    if (t.tag)       return `<${t.tag}>`;
    return '';
  }
  function selectorHints(e) {
    const t = (e && e.target) || {};
    const hints = [];
    if (t.role && (t.text || t.ariaLabel)) hints.push(`role=${t.role}[name="${t.text || t.ariaLabel}"]`);
    if (t.testId)   hints.push(`[data-testid="${t.testId}"]`);
    if (t.id)       hints.push(`#${t.id}`);
    if (t.selector) hints.push(t.selector);
    return hints.slice(0, 3);
  }

  // Estrai URL di partenza
  const sessionStart = events.find(e => e.type === 'session_start');
  const startUrl = (sessionStart && sessionStart.url)
    || (events.find(e => e.type === 'navigation') || {}).url
    || (events[0] || {}).url
    || 'about:blank';

  // Filtra rumore + de-duplica 'input' consecutivi sullo stesso target
  const filtered = [];
  let lastInputKey = null;
  for (const e of events) {
    if (NOISE.has(e.type)) continue;
    if (e.type === 'keydown' && !SPECIAL_KEYS.has(e.key)) continue;
    if (e.type === 'input') {
      const key = JSON.stringify(e.target || {});
      if (key === lastInputKey) {
        // sostituisci l'ultimo input con il nuovo (valore finale)
        filtered[filtered.length - 1] = e;
        continue;
      }
      lastInputKey = key;
    } else {
      lastInputKey = null;
    }
    filtered.push(e);
  }

  const reportFile = path.join(aiReplayDir, 'ai-replay-report.md');
  const docxName = `report-AI-${sessionName}__${path.basename(aiReplayDir)}.docx`.replace(/[\\/:*?"<>|]/g, '_');
  const docxPath = path.join(wordOutDir || aiReplayDir, docxName);

  const lines = [];
  lines.push(`# AI Replay — istruzioni per Copilot`, '');
  lines.push(`Sei un agente che deve **riprodurre un flusso utente registrato** usando i tool Playwright MCP disponibili (\`mcp_playwright_browser_navigate\`, \`mcp_playwright_browser_click\`, \`mcp_playwright_browser_type\`, \`mcp_playwright_browser_snapshot\`, \`mcp_playwright_browser_press_key\`, \`mcp_playwright_browser_select_option\`, ecc.). Non scrivere codice Playwright: **chiama direttamente i tool MCP**.`, '');
  lines.push(`## Contesto`, '');
  lines.push(`- **Sessione registrata**: \`${sessionName}\``);
  lines.push(`- **Cartella sessione**: \`${sessionDir}\``);
  lines.push(`- **Cartella di output di questo AI replay**: \`${aiReplayDir}\``);
  lines.push(`- **URL di partenza**: ${startUrl}`);
  lines.push(`- **Numero azioni intenzionali**: ${filtered.length}`, '');
  lines.push(`## Regola fondamentale`, '');
  lines.push(`**Devi eseguire TUTTE le ${filtered.length} azioni della tabella, in ordine, senza saltarne NESSUNA.** Ogni click su ogni bottone, ogni digitazione, ogni pressione di tasto registrata deve essere riprodotta. Non è ammesso "ottimizzare" il flusso saltando passaggi che ti sembrano ridondanti (doppi click, click su elementi già attivi, conferme, ecc.): l'utente li ha eseguiti, tu li devi eseguire. Se un'azione fallisce dopo i tentativi alternativi, **registrala come fallita ma prosegui con quelle successive** — non interrompere mai la sequenza.`, '');
  lines.push(`## Procedura`, '');
  lines.push(`1. **Apri il browser** su \`${startUrl}\` con \`mcp_playwright_browser_navigate\`.`);
  lines.push(`2. Per ogni riga della tabella "Azioni da riprodurre" qui sotto, in ordine dalla 1 alla ${filtered.length}:`);
  lines.push(`   - prima del click usa \`mcp_playwright_browser_snapshot\` per individuare il selettore corretto (la UI può essere cambiata: usa testo / ruolo / aria-label come riferimento principale, non i selettori CSS che potrebbero essere fragili);`);
  lines.push(`   - scegli il tool MCP più appropriato (\`browser_click\`, \`browser_type\`, \`browser_press_key\`, \`browser_select_option\`, \`browser_hover\`, \`browser_file_upload\`, \`browser_handle_dialog\`, ecc.) ed **eseguilo davvero**;`);
  lines.push(`   - se l'elemento non viene trovato al primo tentativo, prova fino a 3 strategie alternative (testo parziale, role+name, scroll-into-view, attesa di 1-2 s per animazioni) prima di dichiarare il fallimento dello step.`);
  lines.push(`   - **subito dopo aver eseguito l'azione e atteso il caricamento, cattura uno screenshot del replay** con \`mcp_playwright_browser_take_screenshot\` salvandolo nella cartella \`replay-shots\` con lo **stesso nome** del file indicato nella colonna "Salva come" della sezione "Diff visivo rispetto all'originale" (serve per il confronto visivo con l'originale).`);
  lines.push(`3. Per gli step di tipo \`input\`/\`change\` usa il **valore finale** indicato nella colonna "Valore" (è il risultato della digitazione completa, già de-duplicato).`);
  lines.push(`4. Per la navigazione conseguente a un click, **non navigare manualmente**: aspetta il caricamento e prosegui con l'azione successiva.`);
  lines.push(`5. **Conta gli step eseguiti**: alla fine devi aver tentato esattamente ${filtered.length} azioni. Se ne hai tentate meno, sei in errore: torna indietro e completa quelle mancanti.`);
  lines.push(`6. Al termine, **scrivi un report markdown** in:`, '', '```', reportFile, '```', '');
  lines.push(`   Il report deve contenere:`);
  lines.push(`   - intestazione con esito complessivo (\`FUNZIONANTE\` / \`DEGRADATO\` / \`ROTTO\`),`);
  lines.push(`   - tabella con una riga per azione: \`# | Azione attesa | Esito | Note\`,`);
  lines.push(`   - elenco dettagliato dei fallimenti con la motivazione e l'eventuale strategia alternativa adottata,`);
  lines.push(`   - **sezione "Cambiamenti rilevati sul sito"**: confronta cosa ti aspettavi (dati registrati) con quello che hai trovato davvero (snapshot live). Annota: bottoni rinominati o spostati, label cambiate, layout diverso, popup nuovi (cookie banner, GDPR, login obbligatorio), redirect inattesi, elementi spariti. Se non hai notato nessuna differenza, scrivilo esplicitamente.`);
  lines.push(`   - **sezione "Differenze visive"**: prima di scrivere il report esegui il **Diff visivo** (sezione dedicata più sotto), poi riporta qui, per ogni checkpoint con differenze, cosa è cambiato rispetto all'originale (colori, valori/numeri, testo, grafiche/immagini/icone, layout) con la percentuale di pixel cambiati e la zona.`);
  lines.push(`   - URL finale raggiunto e timestamp di inizio/fine.`, '');
  lines.push(`7. **Genera il report Word executive** \`.docx\` (vedi sezione dedicata sotto) e salvalo in:`, '', '```', docxPath, '```', '');
  lines.push(`8. Quando hai finito, **chiudi il browser** con \`mcp_playwright_browser_close\`.`, '');
  lines.push(`## Azioni da riprodurre`, '');
  lines.push(`> Una riga per azione. \`coord\` (x,y) sono le coordinate originali nel viewport — usale solo come fallback se il selettore non funziona.`, '');
  lines.push(`| # | Tipo | Bersaglio | Valore / Tasto | Suggerimenti selettore | URL pagina | coord |`);
  lines.push(`|---:|:---|:---|:---|:---|:---|:---|`);
  filtered.forEach((e, i) => {
    const tgt = humanTarget(e).replace(/\|/g, '\\|').slice(0, 80);
    let val = '';
    if (e.value !== undefined && e.value !== null) val = String(e.value).slice(0, 120);
    else if (e.key) val = `key:${e.key}`;
    val = val.replace(/\|/g, '\\|');
    const sel = selectorHints(e).join(' · ').replace(/\|/g, '\\|').slice(0, 100);
    const url = (e.url || '').replace(/\|/g, '\\|').slice(0, 80);
    const coord = (Number.isFinite(e.x) && Number.isFinite(e.y)) ? `${e.x},${e.y}` : '';
    lines.push(`| ${i+1} | ${e.type} | ${tgt} | ${val} | ${sel} | ${url} | ${coord} |`);
  });
  lines.push('');
  // ---- Diff visivo rispetto all'originale ----
  const shotActions = filtered
    .map((e, i) => ({ n: i + 1, e, shot: e.screenshot }))
    .filter(x => x.shot);
  const frameOf = (e) => {
    const ms = Number.isFinite(e.elapsedMs) ? e.elapsedMs : null;
    if (ms == null) return null;
    return 'frame-' + String(Math.max(1, Math.floor(ms / 1000) + 1)).padStart(6, '0');
  };
  lines.push(`---`, '');
  lines.push(`## Diff visivo rispetto all'originale (obbligatorio)`, '');
  lines.push(`Durante la registrazione è stata salvata una **registrazione unica a schermo intero** dell'intera sessione (tutto il desktop), spezzata in **frame a 1 al secondo** nella cartella:`, '', '```', originalFramesDir, '```', '');
  lines.push(`Questi **frame originali sono il riferimento visivo principale**. Usali in due modi:`, '');
  lines.push(`- **per riprodurre il flusso**: prima e durante l'esecuzione con Playwright, **apri e guarda i frame in ordine** per capire cosa succedeva davvero passo-passo, anche fuori dal browser (dialoghi di sistema, selettori file, popup, altre finestre). La tabella azioni ti dà selettori e valori, i frame ti danno il contesto visivo reale.`);
  lines.push(`- **per scrivere le differenze visive**: confronta ogni frame originale con ciò che vedi nello stesso momento durante il replay e descrivi cosa è cambiato (colori, valori/numeri, testo, immagini/grafici/icone diversi o mancanti, layout).`, '');
  lines.push(`Sono disponibili anche gli screenshot per-azione del solo browser (\`original flow/screenshots\`) e il video completo (\`original flow/video/screen.mp4\`).`, '');
  lines.push(`**Passi:**`, '');
  lines.push(`1. Durante la riproduzione, **dopo ogni azione** della tabella qui sotto, salva lo screenshot del replay con \`mcp_playwright_browser_take_screenshot\` usando **esattamente** il nome indicato nella colonna "Salva come", dentro la cartella:`, '', '```', replayShotsDir, '```', '');
  if (shotActions.length) {
    lines.push(`> La colonna "Frame originale" indica il fotogramma a schermo intero corrispondente a quel momento (cadenza 1/sec; se il file \`.jpg\` non c'è prova \`.png\`). Aprilo per vedere l'intero schermo in quell'istante.`, '');
    lines.push(`| # | Azione | Screenshot ORIGINALE (browser) | Frame ORIGINALE (schermo intero) | Salva come |`);
    lines.push(`|---:|:---|:---|:---|:---|`);
    for (const s of shotActions) {
      const base = path.basename(s.shot);
      const desc = humanTarget(s.e).replace(/\|/g, '\\|').slice(0, 60);
      const fr = frameOf(s.e);
      const frCell = fr ? '`' + fr + '.jpg`' : '—';
      lines.push(`| ${s.n} | ${s.e.type} ${desc} | \`${path.join(sessionDir, s.shot)}\` | ${frCell} | \`${base}\` |`);
    }
    lines.push('');
  } else {
    lines.push(`> Questa sessione non ha screenshot per-azione del browser: usa direttamente i **frame a schermo intero** in \`${originalFramesDir}\` (uno al secondo) come riferimento. Cattura uno screenshot del replay dopo ogni azione significativa (nomi \`shot-0001.png\`, \`shot-0002.png\`, …).`, '');
  }
  lines.push(`2. Finite tutte le azioni, **genera il diff visivo per-azione** eseguendo in un terminale (richiede \`node\`; in alternativa l'eseguibile Node di VS Code):`, '', '```', `node "${visualDiffCli}" --baseline "${originalShotsDir}" --actual "${replayShotsDir}" --out "${visualDiffDir}"`, '```', '');
  lines.push(`   Crea, in \`visual-diff\`: per ogni checkpoint un'immagine \`diff-*.png\` (pixel cambiati in rosso) e \`sidebyside-*.png\` (**originale | replay | diff**), più \`visual-diff.md\`, \`visual-diff.html\` e \`visual-diff-report.json\` (percentuali di variazione, bounding box, zone). Questo dà i **numeri**; i **frame a schermo intero** danno il **contesto** e il "perché".`, '');
  lines.push(`3. **Leggi** \`visual-diff-report.json\` / \`visual-diff.md\` per i numeri, **apri le \`sidebyside-*.png\`** e **i frame originali** corrispondenti per capire ogni differenza: colore diverso, valore/numero diverso, testo diverso, immagine/grafico/icona diversa o mancante, layout spostato. Ignora le micro-differenze da antialiasing (< ~0.5%).`, '');
  lines.push(`4. Riporta tutto nella **sezione "Differenze visive"** del report \`.md\` e del Word: una riga per momento cambiato, con l'eventuale percentuale (dal diff per-azione) e una descrizione in linguaggio naturale basata sui frame originali; incorpora nel \`.docx\` le \`sidebyside-*.png\` più significative.`, '');
  lines.push(`> Gli screenshot possono avere risoluzione diversa: il tool riscala automaticamente prima di confrontare. Se puoi, imposta una finestra coerente a inizio replay con \`mcp_playwright_browser_resize\` (es. 1280×720).`, '');
  lines.push('');
  lines.push(`---`, '');
  lines.push(`## Istruzioni per il report Word (.docx)`, '');
  lines.push(`Dopo aver scritto il \`.md\`, **genera anche un documento Word executive** e salvalo nel path esatto indicato al punto 7 della procedura:`);
  lines.push('');
  lines.push('```');
  lines.push(docxPath);
  lines.push('```');
  lines.push('');
  lines.push(`Libreria \`docx\` (npm) già installata in: \`${docxLib || '<extensionDir>/node_modules/docx'}\` — usala da Node, oppure usa la skill \`docx\` (python-docx). Salva nel path esatto sopra.`);
  lines.push('');
  lines.push(`**Destinatario**: manager non tecnico. **Scopo**: capire in 30 secondi se il sito è cambiato e se il flusso funziona ancora. Niente CSS, xpath, selettori, codice, comandi shell: il dettaglio tecnico è già nel \`.md\`.`);
  lines.push('');
  lines.push(`### Struttura del documento (5 sezioni, max 1 pagina, 2 solo se molte regressioni o molte differenze visive)`);
  lines.push('');
  lines.push(`1. **Intestazione**`);
  lines.push(`   - Titolo: nome leggibile del flusso testato (deducilo dagli URL e dalle azioni — es. "Login portale fornitori").`);
  lines.push(`   - Data di esecuzione e durata totale.`);
  lines.push(`   - Esito a colpo d'occhio: **FUNZIONANTE / DEGRADATO / ROTTO**.`);
  lines.push('');
  lines.push(`2. **Risultato in una frase**`);
  lines.push(`   - Una sola frase in italiano. Esempio se OK: "Il flusso è stato rieseguito con successo: ${filtered.length} azioni completate. Nessuna differenza significativa rilevata rispetto alla registrazione originale."`);
  lines.push(`   - Se ci sono fallimenti, indica quanti e cosa è rotto in linguaggio naturale (es. "Il pulsante 'Conferma' non risponde più", "La pagina di login richiede ora un secondo fattore").`);
  lines.push('');
  lines.push(`3. **Cosa è cambiato sul sito** (sezione cardine — è il motivo per cui esiste questo report)`);
  lines.push(`   - Tabella a 2 colonne: **Cambiamento osservato** | **Impatto sul flusso**.`);
  lines.push(`   - Una riga per ogni differenza notata durante l'esecuzione: bottoni rinominati ("Accedi" → "Entra"), nuovi popup (cookie banner, consenso GDPR, modal di benvenuto), redirect inattesi, layout diverso, campi aggiuntivi nel form, elementi spariti, attese più lunghe del normale, ecc.`);
  lines.push(`   - Se nessun cambiamento è stato rilevato, scrivi una sola riga: "Nessun cambiamento rilevato. Il sito si comporta come al momento della registrazione."`);
  lines.push('');
  lines.push(`4. **Differenze visive rispetto all'originale** (dal diff per-azione e dai frame originali a schermo intero)`);
  lines.push(`   - Tabella a 3 colonne: **Momento / azione** | **Cosa è cambiato visivamente** | **Impatto**.`);
  lines.push(`   - Una riga per ogni checkpoint con differenze: colori diversi, valori/numeri diversi, testo diverso, immagini/grafici/icone diversi o mancanti, elementi spostati. Indica la percentuale di pixel cambiati e la zona.`);
  lines.push(`   - **Incorpora nel documento le immagini side-by-side** (originale | replay | diff) più significative dalla cartella \`visual-diff\`.`);
  lines.push(`   - Se il diff non ha rilevato differenze, scrivi: "Nessuna differenza visiva rilevata rispetto alla registrazione originale."`);
  lines.push('');
  lines.push(`5. **Tabella delle differenze nelle azioni**`);
  lines.push(`   - 3 colonne: **Cosa doveva succedere** | **Cosa è successo** | **Impatto**.`);
  lines.push(`   - Una riga per azione tentata. Per gli OK basta scrivere "OK" o "Nessun problema" nella colonna Impatto.`);
  lines.push(`   - Se 0 fallimenti, scrivi una sola riga: "Nessuna differenza rilevata."`);
  lines.push('');
  lines.push(`6. **Riferimento al dettaglio tecnico**`);
  lines.push(`   - Frase finale: "Il dettaglio tecnico completo è disponibile nel file \`${path.basename(reportFile)}\` nella cartella \`${path.basename(aiReplayDir)}\`."`);
  lines.push('');
  lines.push(`**Stile**: Word con heading nativi (Title, Heading 1), tabelle vere, italiano, niente emoji.`);
  lines.push('');
  lines.push(`---`, '');
  lines.push(`**Nota**: i dati grezzi completi (inclusi mousemove, network, console, screenshot, video) sono in \`${path.join(sessionDir, 'original flow')}\` se ti serve ulteriore contesto per ricostruire un'azione ambigua.`);
  return lines.join('\n');
}

// ---------------- AI Navigation (da prompt, senza replay) ----------------
// Prepara la cartella e il prompt per una o piu' navigazioni "da prompt" e li
// invia a Copilot Chat (riusa askCopilot + Playwright MCP, come l'AI replay).
async function runAiNavigation(context, tasks) {
  const valid = (tasks || []).filter(t => t && (t.url || '').trim());
  if (!valid.length) { vscode.window.showWarningMessage('URL mancante per la navigazione AI.'); return; }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const navRoot = ensureAiNavDir(context);
  const navDir = path.join(navRoot, `nav-${ts}`);
  fs.mkdirSync(navDir, { recursive: true });
  // Output .docx: "wordOutputPath" se configurato, altrimenti la stessa cartella
  // del report .md di questa navigazione (cosi' restano insieme).
  let wordOut = (vscode.workspace.getConfiguration('edgeRecorder').get('wordOutputPath') || '').trim();
  if (!wordOut) wordOut = navDir;
  try { fs.mkdirSync(wordOut, { recursive: true }); } catch (_) {}
  const docxLib = path.join(extensionDir, 'node_modules', 'docx');
  const md = buildAINavigatePrompt({ tasks: valid, navDir, wordOutDir: wordOut, docxLib });
  const promptFile = path.join(navDir, 'ai-navigation-instructions.md');
  fs.writeFileSync(promptFile, md, 'utf8');
  postLog(`🤖 Navigazione AI: prompt scritto in ${promptFile}`);
  await handleMessage({ cmd: 'askCopilot', file: promptFile, markdown: md }, context);
}

// Costruisce il prompt Markdown per una navigazione "da prompt". Supporta uno
// o piu' task (esecuzione in sequenza), ognuno con URL + obiettivo testuale.
function buildAINavigatePrompt({ tasks, navDir, wordOutDir, docxLib }) {
  const reportFile = path.join(navDir, 'ai-navigation-report.md');
  const docxName = `report-AI-navigation-${path.basename(navDir)}.docx`.replace(/[\\/:*?"<>|]/g, '_');
  const docxPath = path.join(wordOutDir || navDir, docxName);
  const multi = tasks.length > 1;

  const lines = [];
  lines.push(`# Navigazione AI — istruzioni per Copilot`, '');
  lines.push(`Sei un agente che deve **eseguire ${multi ? `${tasks.length} obiettivi` : 'un obiettivo'} di navigazione web** descritti in linguaggio naturale, usando i tool Playwright MCP disponibili (\`mcp_playwright_browser_navigate\`, \`mcp_playwright_browser_click\`, \`mcp_playwright_browser_type\`, \`mcp_playwright_browser_snapshot\`, \`mcp_playwright_browser_press_key\`, \`mcp_playwright_browser_select_option\`, \`mcp_playwright_browser_file_upload\`, \`mcp_playwright_browser_handle_dialog\`, ecc.). Non scrivere codice Playwright: **chiama direttamente i tool MCP**.`, '');
  lines.push(`## Regole fondamentali`, '');
  lines.push(`- Esegui i task **nell'ordine indicato**, uno alla volta.`);
  lines.push(`- Per ogni task: naviga all'URL indicato, poi raggiungi l'obiettivo interpretando la pagina con \`mcp_playwright_browser_snapshot\` per individuare gli elementi reali (usa **testo / ruolo / aria-label** come riferimento principale).`);
  lines.push(`- Se un passaggio fallisce, prova fino a 3 strategie alternative (testo parziale, role+name, scroll-into-view, attesa di 1-2 s per animazioni) prima di dichiararlo fallito, poi **prosegui** con i task successivi.`);
  lines.push(`- **Non inventare dati**: se un task richiede credenziali o input non forniti, fermati su quel punto, chiedi se possibile oppure annotalo come bloccante nel report.`);
  lines.push(`- **Non eseguire azioni distruttive o irreversibili** (eliminazioni, pagamenti, invii definitivi) a meno che il task non lo richieda esplicitamente.`, '');
  lines.push(`## ${multi ? 'Task da eseguire' : 'Task'}`, '');
  tasks.forEach((t, i) => {
    const goal = (t.prompt || '').trim();
    lines.push(`### Task ${i + 1}${t.name ? ` — ${t.name}` : ''}`, '');
    lines.push(`- **URL di partenza**: ${(t.url || '').trim() || 'about:blank'}`);
    lines.push(`- **Obiettivo**:`);
    lines.push('');
    lines.push('```');
    lines.push(goal || '(nessuna istruzione specifica: apri la pagina, descrivi cosa vedi e verifica che carichi correttamente)');
    lines.push('```');
    lines.push('');
  });
  lines.push(`## Procedura`, '');
  lines.push(`1. Per ogni task apri il browser sull'URL con \`mcp_playwright_browser_navigate\` e raggiungi l'obiettivo descritto.`);
  lines.push(`2. Tieni traccia dei passi eseguiti e dell'esito di ciascun task.`);
  lines.push(`3. Al termine, **scrivi un report markdown** in:`, '', '```', reportFile, '```', '');
  lines.push(`   Per ogni task il report deve contenere: obiettivo, passi principali eseguiti, **esito** (\`COMPLETATO\` / \`PARZIALE\` / \`FALLITO\`), dati o risultati rilevanti trovati, URL finale raggiunto ed eventuali ostacoli (login richiesto, popup, captcha, redirect).`);
  lines.push(`4. **Genera anche un report Word executive** \`.docx\` e salvalo nel path esatto:`, '', '```', docxPath, '```', '');
  lines.push(`   Libreria \`docx\` (npm) già installata in: \`${docxLib || '<extensionDir>/node_modules/docx'}\` — usala da Node, oppure usa la skill \`docx\` (python-docx). Destinatario: **manager non tecnico**; stile con heading nativi (Title, Heading 1), tabelle vere, italiano, niente emoji, niente dettagli tecnici (selettori, codice).`);
  lines.push(`5. Quando hai finito tutti i task, **chiudi il browser** con \`mcp_playwright_browser_close\`.`, '');
  return lines.join('\n');
}

// ---------------- Video → automazione (BETA) ----------------
// Costruisce il prompt che istruisce Copilot ad ANALIZZARE i fotogrammi estratti
// da un video (gia' salvati come immagini), ricostruire la sequenza di azioni
// dell'utente e RIPRODURLA sul sito con i tool Playwright MCP.
function buildVideoReplayPrompt({ url, hint, fileName, durationSec, frames, composite, framesDir, videoDir, wordOutDir, docxLib }) {
  const reportFile = path.join(videoDir, 'video-replay-report.md');
  const docxName = `report-video-${path.basename(videoDir)}.docx`.replace(/[\\/:*?"<>|]/g, '_');
  const docxPath = path.join(wordOutDir || videoDir, docxName);
  const startUrl = (url || '').trim();
  const totalFrames = frames.reduce((n, f) => n + ((f.items && f.items.length) || 1), 0);

  const lines = [];
  lines.push(`# Video → automazione — istruzioni per Copilot`, '');
  lines.push(`Sei un agente che deve **ricostruire e riprodurre un flusso utente a partire dai FOTOGRAMMI di un video** (uno screen recording). I fotogrammi sono gia' stati estratti e salvati come immagini locali. **Non hai il video**, solo le immagini elencate sotto, in ordine cronologico.`, '');
  if (composite) {
    lines.push(`> ⚠️ **Formato immagini**: per rispettare il limite di immagini del modello, i ${totalFrames} fotogrammi sono raggruppati in **${frames.length} immagini "a griglia" (contact sheet)**. Ogni cella e' un fotogramma con in alto un'etichetta **#numero · istante** (es. \`#7 · 12.3s\`). Leggi le celle **in ordine di lettura**: prima riga da sinistra a destra, poi la riga sotto, e cosi' per ogni immagine in sequenza.`, '');
  }
  lines.push(`Userai i tool Playwright MCP (\`mcp_playwright_browser_navigate\`, \`mcp_playwright_browser_click\`, \`mcp_playwright_browser_type\`, \`mcp_playwright_browser_snapshot\`, \`mcp_playwright_browser_press_key\`, \`mcp_playwright_browser_select_option\`, ecc.). Non scrivere codice Playwright: **chiama direttamente i tool MCP**.`, '');
  lines.push(`## Contesto`, '');
  if (fileName) lines.push(`- **File video**: \`${fileName}\``);
  if (Number.isFinite(durationSec) && durationSec > 0) lines.push(`- **Durata video**: ~${Math.round(durationSec)} s`);
  lines.push(`- **URL di partenza**: ${startUrl || '(non fornito: deducilo dai fotogrammi, es. dalla barra degli indirizzi o dal contenuto della pagina)'}`);
  lines.push(`- **Cartella fotogrammi**: \`${framesDir}\``);
  lines.push(`- **Numero fotogrammi**: ${totalFrames}${composite ? ` (in ${frames.length} immagini a griglia)` : ''}`);
  if (hint) { lines.push(`- **Contesto fornito dall'utente**:`, '', '```', hint, '```'); }
  lines.push('');
  lines.push(`## Fase 1 — Analisi visiva dei fotogrammi`, '');
  lines.push(`**Apri e osserva ogni immagine elencata** usando la tua capacita' di analisi visiva (sono file locali: leggile come immagini, non come testo).${composite ? ` Ricorda che ogni immagine contiene **piu' fotogrammi in griglia**: analizza ogni cella separatamente, seguendo le etichette #numero · istante.` : ''} Confronta ogni fotogramma con il precedente per dedurre **cosa ha fatto l'utente** tra l'uno e l'altro:`);
  lines.push(`- comparsa/sparizione di elementi, cambi di pagina o di URL (leggi la barra degli indirizzi se visibile),`);
  lines.push(`- campi che si riempiono di testo (deduci il valore digitato dove leggibile; **non inventare credenziali o dati mascherati**),`);
  lines.push(`- menu/tendine aperti, click su pulsanti, scroll, cambi di tab.`);
  lines.push('');
  if (composite) {
    lines.push(`### Immagini a griglia (in ordine)`, '');
    lines.push(`| Immagine | Fotogrammi contenuti (#numero · istante) | File |`);
    lines.push(`|---:|:---|:---|`);
    frames.forEach((f, i) => {
      const its = (f.items || []).map(it => `#${it.index}·${(it.t != null && Number.isFinite(it.t)) ? it.t + 's' : '?'}`).join(', ');
      lines.push(`| ${i + 1} | ${its} | \`${path.join(framesDir, f.name)}\` |`);
    });
  } else {
    lines.push(`### Fotogrammi (in ordine)`, '');
    lines.push(`| # | Istante (s) | Immagine |`);
    lines.push(`|---:|---:|:---|`);
    frames.forEach((f, i) => {
      const t0 = (f.items && f.items[0]) ? f.items[0].t : f.t;
      const tv = (t0 != null && Number.isFinite(t0)) ? String(t0) : '';
      lines.push(`| ${i + 1} | ${tv} | \`${path.join(framesDir, f.name)}\` |`);
    });
  }
  lines.push('');
  lines.push(`## Fase 2 — Ricostruzione dei passaggi`, '');
  lines.push(`Produci una **lista ordinata e numerata delle azioni** dedotte dai fotogrammi (es. "1. apri ${startUrl || 'l\u2019URL'} · 2. clic sul campo Email · 3. digita l'email · 4. clic su Accedi …"). Per ogni passaggio indica il tool MCP che userai. Se un passaggio e' ambiguo o un dato non e' leggibile, **segnalalo esplicitamente** invece di inventare.`, '');
  lines.push(`## Fase 3 — Riproduzione nel browser`, '');
  lines.push(`1. **Apri il browser** ${startUrl ? `su \`${startUrl}\`` : `sull'URL dedotto dai fotogrammi`} con \`mcp_playwright_browser_navigate\`.`);
  lines.push(`2. Esegui i passaggi ricostruiti **in ordine**. Prima di ogni interazione usa \`mcp_playwright_browser_snapshot\` per trovare l'elemento reale (usa **testo / ruolo / aria-label** come riferimento principale: la UI live puo' differire dai fotogrammi).`);
  lines.push(`3. Se un elemento non si trova al primo tentativo, prova fino a 3 strategie alternative (testo parziale, role+name, scroll-into-view, attesa di 1-2 s) prima di dichiarare fallito il passaggio, poi **prosegui** con i successivi.`);
  lines.push(`4. **Non eseguire azioni distruttive o irreversibili** (eliminazioni, pagamenti, invii definitivi) se non sono chiaramente parte del flusso e indispensabili.`);
  lines.push(`5. Al termine, **scrivi un report markdown** in:`, '', '```', reportFile, '```', '');
  lines.push(`   Il report deve contenere: la lista dei passaggi ricostruiti dai fotogrammi, l'esito complessivo (\`COMPLETATO\` / \`PARZIALE\` / \`FALLITO\`), una tabella \`# | Azione dedotta | Esito | Note\`, i punti ambigui o non riproducibili, l'URL finale e i timestamp.`);
  lines.push(`6. **Genera anche un report Word executive** \`.docx\` e salvalo nel path esatto:`, '', '```', docxPath, '```', '');
  lines.push(`   Libreria \`docx\` (npm) gia' installata in: \`${docxLib || '<extensionDir>/node_modules/docx'}\` — usala da Node, oppure usa la skill \`docx\`. Destinatario: **manager non tecnico**; heading nativi (Title, Heading 1), tabelle vere, italiano, niente emoji, niente dettagli tecnici (selettori, codice).`);
  lines.push(`7. Quando hai finito, **chiudi il browser** con \`mcp_playwright_browser_close\`.`, '');
  lines.push(`---`, '');
  lines.push(`**Nota (beta)**: la ricostruzione da fotogrammi e' inferenziale. Dove i pixel non bastano (testo mascherato, URL non inquadrato, click senza cursore visibile) **dichiara l'incertezza** nel report invece di indovinare.`);
  return lines.join('\n');
}

// ---------------- Markdown comparison ----------------
function buildComparisonMarkdown({ sessionName, replayName, events, report, sessionDir, replayDir, wordOutDir, extensionDir, docxLib }) {
  const okN = report.steps.filter(s => s.status === 'ok').length;
  const failN = report.steps.filter(s => s.status === 'fail').length;
  const skipN = report.steps.filter(s => s.status === 'skip').length;
  const failed = report.steps.filter(s => s.status === 'fail');
  const dur = (report.durationMs/1000).toFixed(1);

  // Eventi che hanno coordinate "di click" significative.
  const COORD_TYPES = new Set(['click', 'dblclick', 'contextmenu', 'mousedown', 'mouseup', 'drop']);
  function coordsOf(e) {
    if (!e || !COORD_TYPES.has(e.type)) return null;
    const hasXY = Number.isFinite(e.x) && Number.isFinite(e.y);
    const b = e.target && e.target.bbox;
    if (!hasXY && !b) return null;
    const parts = [];
    if (hasXY) parts.push(`click @ (${e.x}, ${e.y})`);
    if (b) {
      const cx = Math.round(b.x + b.w / 2);
      const cy = Math.round(b.y + b.h / 2);
      parts.push(`elemento ${b.w}x${b.h} @ (${b.x}, ${b.y}) centro (${cx}, ${cy})`);
    }
    return parts.join(' · ');
  }
  function shortCoord(e) {
    if (!e || !COORD_TYPES.has(e.type)) return '';
    if (Number.isFinite(e.x) && Number.isFinite(e.y)) return `${e.x},${e.y}`;
    const b = e.target && e.target.bbox;
    if (b) return `~${Math.round(b.x + b.w/2)},${Math.round(b.y + b.h/2)}`;
    return '';
  }

  // Target "umano" leggibile: preferiamo testo / aria-label / ruolo,
  // CSS solo come ultima risorsa. Selettori CSS lunghi e xpath restano
  // disponibili nei dettagli degli step falliti per chi serve davvero.
  function humanTarget(e) {
    const t = (e && e.target) || {};
    if (t.text) return `"${t.text}"`;
    if (t.ariaLabel) return `"${t.ariaLabel}" (aria-label)`;
    if (t.title) return `"${t.title}" (title)`;
    if (t.role) return `${t.role}${t.tag ? ` <${t.tag}>` : ''}`;
    if (t.testId) return `data-testid="${t.testId}"`;
    if (t.id) return `#${t.id}`;
    if (t.tag) return `<${t.tag}>`;
    if (e && e.url) return e.url;
    if (e && e.key) return `key:${e.key}`;
    return '';
  }

  const lines = [];
  lines.push(`# Confronto sessione vs replay`, '');
  if (report.partial) {
    lines.push(`> ⚠️ **Report parziale** — ${report.partialReason || 'il replay non è stato completato.'}`);
    lines.push(`> Le statistiche sotto possono essere vuote o incomplete.`, '');
  }
  lines.push(`- **Sessione registrata**: \`${sessionName}\``);
  lines.push(`- **Replay**: \`${replayName}\``);
  lines.push(`- **Eseguito il**: ${report.replayedAt}`);
  lines.push(`- **Durata replay**: ${dur} s`);
  if (sessionDir) lines.push(`- **Cartella sessione**: \`${sessionDir}\``);
  if (replayDir)  lines.push(`- **Cartella replay**: \`${replayDir}\``);
  lines.push('');
  lines.push(`## Esito`, '', `| Totale | OK | FAIL | SKIP |`, `|---:|---:|---:|---:|`, `| ${report.total} | ${okN} | ${failN} | ${skipN} |`, '');

  // Verdetto a colpo d'occhio (servira' a Copilot per la prima frase del .docx).
  const intentional = okN + failN;
  const successRate = intentional > 0 ? Math.round((okN / intentional) * 100) : 0;
  let verdict;
  if (failN === 0 && okN > 0) verdict = '✅ **FUNZIONANTE** — il flusso è stato rieseguito senza differenze.';
  else if (failN === 0)        verdict = 'ℹ️ **NON VALUTABILE** — nessuna azione intenzionale registrata.';
  else if (failN < okN)        verdict = `⚠️ **DEGRADATO** — ${failN} regressioni su ${intentional} azioni (${successRate}% di successo).`;
  else                          verdict = `❌ **ROTTO** — ${failN} regressioni su ${intentional} azioni (${successRate}% di successo).`;
  lines.push(verdict, '');

  if (failed.length === 0) {
    lines.push(`Nessun fallimento. Il replay ha eseguito con successo tutte le azioni intenzionali.`);
  } else {
    lines.push(`## Step falliti (${failed.length})`, '');
    for (const f of failed) {
      const e = events[f.idx] || {};
      const t = e.target || {};
      lines.push(`### ❌ Step #${f.idx + 1} — \`${f.type}\` su ${humanTarget(e)}`, '');
      lines.push(`**Errore**: \`${f.error || ''}\``, '');
      lines.push(`**Azione attesa**:`);
      if (t.selector) lines.push(`- selector CSS: \`${t.selector}\``);
      if (t.xpath)    lines.push(`- xpath: \`${t.xpath}\``);
      if (t.id)       lines.push(`- id: \`${t.id}\``);
      if (t.testId)   lines.push(`- data-testid: \`${t.testId}\``);
      if (t.role)     lines.push(`- role: \`${t.role}\` (aria-label: \`${t.ariaLabel || ''}\`)`);
      if (t.text)     lines.push(`- text: \`${t.text}\``);
      if (t.tag)      lines.push(`- tag: \`<${t.tag}>\``);
      if (e.value !== undefined && e.value !== null) lines.push(`- valore: \`${String(e.value).slice(0, 200)}\``);
      if (e.url)      lines.push(`- url: ${e.url}`);
      const co = coordsOf(e);
      if (co)         lines.push(`- coordinate: ${co}`);
      if (f.screenshot) lines.push('', `**Screenshot**: \`${f.screenshot}\``);
      lines.push('');
    }
  }

  // Sequenza completa: SOLO step intenzionali (ok/fail), niente "skip".
  // Il rumore (mousemove, request, console, navigation, focus/blur, ecc.)
  // resta in events.json per il debug ma non gonfia il prompt a Copilot.
  const intentionalSteps = report.steps.filter(s => s.status !== 'skip');
  if (intentionalSteps.length) {
    lines.push(`## Azioni intenzionali (${intentionalSteps.length})`, '',
      '| # | Stato | Tipo | Target | Coord (x,y) | Errore |',
      '|---:|:---:|:---|:---|:---|:---|');
    for (const s of intentionalSteps) {
      const e = events[s.idx] || {};
      const icon = s.status === 'ok' ? '✅' : '❌';
      const desc = humanTarget(e).replace(/\|/g, '\\|').slice(0, 80);
      const err = (s.error || '').replace(/\|/g, '\\|').slice(0, 120);
      const coord = shortCoord(e);
      lines.push(`| ${s.idx+1} | ${icon} | ${e.type} | ${desc} | ${coord} | ${err} |`);
    }
    lines.push('');
    if (skipN > 0) {
      lines.push(`> Esclusi ${skipN} eventi non intenzionali (mousemove, navigation, console, request/response, focus/blur, ecc.) — disponibili in \`events.json\`.`, '');
    }
  }

  const docxName = `report-${sessionName}__${replayName}.docx`.replace(/[\\/:*?"<>|]/g, '_');
  const docxPath = path.join(wordOutDir || replayDir || '.', docxName);
  lines.push(`---`, '');
  lines.push(`## Istruzioni per Copilot — genera un report Word (.docx) per il manager`, '');
  lines.push(`Genera un documento Word **executive, max 1 pagina (2 solo se ci sono molte regressioni)** e salvalo in:`);
  lines.push('');
  lines.push('```');
  lines.push(docxPath);
  lines.push('```');
  lines.push('');
  lines.push(`Libreria \`docx\` (npm) già installata in: \`${docxLib || '<extensionDir>/node_modules/docx'}\` — usala direttamente da Node, oppure usa la skill \`docx\` (python-docx). Salva nel path esatto sopra.`);
  lines.push('');
  lines.push(`**Destinatario**: manager non tecnico. **Scopo**: capire in 30 secondi se il flusso funziona ancora e cosa è cambiato. Niente CSS, xpath, selettori, snippet di codice, comandi shell: il dettaglio tecnico è già in questo file \`.md\` (è disponibile per gli sviluppatori).`);
  lines.push('');
  lines.push(`### Struttura del documento (4 sezioni, niente di più)`);
  lines.push('');
  lines.push(`1. **Intestazione**`);
  lines.push(`   - Titolo: nome leggibile del flusso testato (deducilo dagli URL e dalle azioni — es. "Navigazione articolo Wikipedia: Microsoft").`);
  lines.push(`   - Data di esecuzione del replay e durata.`);
  lines.push(`   - Esito a colpo d'occhio: **FUNZIONANTE / DEGRADATO / ROTTO** (usa il verdetto già calcolato sopra).`);
  lines.push('');
  lines.push(`2. **Risultato in una frase**`);
  lines.push(`   - Una sola frase che riassume tutto, in italiano. Esempio se OK: *"Il flusso è stato rieseguito con successo: ${okN} azioni su ${intentional} completate (${successRate}%). Nessuna differenza rilevata rispetto all'originale."*`);
  lines.push(`   - Se ci sono fallimenti, indica quanti e cosa è rotto in linguaggio naturale (es. "Il pulsante X non risponde più", "Il menu Y non si apre").`);
  lines.push('');
  lines.push(`3. **Tabella delle differenze**`);
  lines.push(`   - 3 colonne: **Cosa doveva succedere** | **Cosa è successo** | **Impatto**.`);
  lines.push(`   - Una riga per ogni azione intenzionale (ok/fail). Niente skip.`);
  lines.push(`   - Linguaggio naturale, no tecnicismi. Per gli OK scrivi semplicemente "OK" o "Nessun problema" nella colonna Impatto.`);
  lines.push(`   - Se 0 fallimenti, scrivi una sola riga: "Nessuna differenza rilevata."`);
  lines.push('');
  lines.push(`4. **Riferimento al dettaglio tecnico**`);
  lines.push(`   - Una frase finale: *"Il dettaglio tecnico completo (selettori, errori, coordinate, screenshot) è disponibile nel file \`compare-${sessionName}__${replayName}.md\` nella cartella \`final report\`."*`);
  lines.push('');
  lines.push(`**Stile**: Word con heading nativi (Title, Heading 1), tabelle vere, italiano, niente emoji. Lunghezza target: 1 pagina.`);
  return lines.join('\n');
}

function renderHtml(webview, context) {
  const htmlPath = path.join(context.extensionPath, 'webview.html');
  return fs.readFileSync(htmlPath, 'utf8');
}

function deactivate() {
  try { stopChild(); } catch (_) {}
}

module.exports = { activate, deactivate };
