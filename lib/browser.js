/**
 * Browser launch helpers — Microsoft Edge **e** Google Chrome.
 * -----------------------------------------------------------
 * Centralizza la logica di avvio del browser usata da recorder.js e replay.js
 * e la scelta del canale per il server Playwright MCP (extension.js).
 *
 * Obiettivo: l'estensione funziona sia per chi ha Microsoft Edge sia per chi
 * ha (solo) Google Chrome installato. Per impostazione predefinita rileva
 * automaticamente quale browser è disponibile; l'utente può forzare la scelta
 * con l'impostazione `edgeRecorder.browser` (auto | msedge | chrome).
 *
 * Modulo CommonJS puro (solo fs/path/os): può essere richiesto sia
 * dall'extension host (Electron) sia dai processi figli Node.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// Canali Chromium per famiglia, in ordine di preferenza (stable → beta → dev).
const EDGE_CHANNELS = ['msedge', 'msedge-beta', 'msedge-dev'];
const CHROME_CHANNELS = ['chrome', 'chrome-beta', 'chrome-dev'];

/** Normalizza la preferenza utente in uno di: 'auto' | 'msedge' | 'chrome'. */
function normalizePreference(pref) {
  const p = String(pref == null ? 'auto' : pref).trim().toLowerCase();
  if (p === 'chrome' || p === 'google-chrome' || p === 'google chrome') return 'chrome';
  if (p === 'msedge' || p === 'edge' || p === 'microsoft-edge' || p === 'microsoft edge') return 'msedge';
  return 'auto';
}

/**
 * Ordine dei canali da provare in base alla preferenza.
 * - 'chrome' → prima Chrome, poi Edge come fallback.
 * - 'msedge'/'auto' → prima Edge, poi Chrome (mantiene il comportamento storico
 *   e aggiunge Chrome come rete di sicurezza per chi non ha Edge).
 */
function channelsForPreference(pref) {
  const p = normalizePreference(pref);
  if (p === 'chrome') return [...CHROME_CHANNELS, ...EDGE_CHANNELS];
  return [...EDGE_CHANNELS, ...CHROME_CHANNELS];
}

/** Famiglia ('chrome' | 'msedge') a partire dal nome del canale. */
function familyOf(channel) {
  return String(channel || '').toLowerCase().startsWith('chrome') ? 'chrome' : 'msedge';
}

/** Etichetta leggibile del browser per i log. */
function labelForChannel(channel) {
  return familyOf(channel) === 'chrome' ? 'Google Chrome' : 'Microsoft Edge';
}

/**
 * Vero se l'errore indica che il canale NON è utilizzabile e conviene
 * passare al successivo: browser non installato/non trovato, eseguibile
 * mancante, oppure hand-off a un'istanza già aperta (Edge esce subito).
 */
function isChannelUnavailable(msg) {
  const m = String(msg || '');
  return /Apertura nella sessione|existing browser session|browser has been closed|Target page, context or browser has been closed|is not found|not found at|is not installed|Failed to launch|No such file|Chromium distribution|channel "?[a-z-]+"? is not|executable doesn'?t exist|executable doesn'?t exist|ENOENT/i.test(m);
}

/**
 * Profilo persistente per-famiglia: per non lockare/corrompere il profilo Edge
 * quando si usa Chrome (e viceversa), Chrome usa una cartella sorella
 * "<base>-chrome". Il profilo Edge resta sul path storico (nessuna rottura per
 * gli utenti esistenti).
 */
function effectiveProfileDir(baseDir, channel) {
  return familyOf(channel) === 'chrome' ? baseDir + '-chrome' : baseDir;
}

/**
 * Avvia un contesto persistente provando in sequenza i canali compatibili.
 * Continua al canale successivo se quello corrente non è disponibile
 * (non installato / hand-off); si ferma solo su errori "veri".
 *
 * @param {object} p
 * @param {import('playwright-core').BrowserType} p.chromium  modulo chromium di playwright-core
 * @param {string} p.profileDir  cartella base del profilo persistente
 * @param {object} p.baseOpts    opzioni passate a launchPersistentContext
 * @param {string} [p.preference] 'auto' | 'msedge' | 'chrome'
 * @param {(line:string)=>void} [p.log] funzione di logging (default: console.log)
 * @returns {Promise<import('playwright-core').BrowserContext>}
 */
async function launchWithFallback({ chromium, profileDir, baseOpts, preference, log }) {
  const logger = typeof log === 'function' ? log : function () {};
  const commonArgs = [
    '--no-first-run',
    '--no-default-browser-check',
    '--profile-directory=Default',
    '--restore-last-session=false',
    '--hide-crash-restore-bubble',
    '--disable-features=Translate,AutofillServerCommunication,IdentityConsistency,EdgeAutoLaunchProtocolListFromUser,SessionRestore'
  ];
  if (!baseOpts || !baseOpts.headless) commonArgs.push('--start-maximized');

  const channels = channelsForPreference(preference);
  let lastErr = null;
  for (const channel of channels) {
    const dir = effectiveProfileDir(profileDir, channel);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    try {
      logger(`[launcher] Tentativo canale: ${channel} (${labelForChannel(channel)})`);
      const ctx = await chromium.launchPersistentContext(dir, {
        channel,
        ...baseOpts,
        args: commonArgs,
        ignoreDefaultArgs: ['--enable-automation']
      });
      logger(`[launcher] OK canale: ${channel} (${labelForChannel(channel)}) — profilo: ${dir}`);
      return ctx;
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message || '');
      const skip = isChannelUnavailable(msg);
      logger(`[launcher] Canale ${channel} fallito${skip ? ' (non disponibile, provo il prossimo)' : ''}: ${msg.split('\n')[0]}`);
      if (!skip) break; // errore reale: inutile insistere sugli altri canali
    }
  }
  // playwright-core non ha un browser "bundled": serve Edge o Chrome installato.
  throw new Error(
    'Impossibile avviare un browser compatibile. Verifica che Microsoft Edge oppure '
    + 'Google Chrome (canale stable, beta o dev) sia installato e che non ci siano altre '
    + 'istanze in conflitto. Dettaglio: '
    + (lastErr ? (lastErr.message || String(lastErr)).split('\n')[0] : 'sconosciuto')
  );
}

/** Percorsi noti degli eseguibili per piattaforma, per canale. */
function knownExecutables() {
  const plat = process.platform;
  const env = process.env;
  if (plat === 'win32') {
    const pf = env['ProgramFiles'] || 'C:\\Program Files';
    const pfx86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
    return {
      'msedge': [
        path.join(pfx86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      ],
      'msedge-beta': [
        path.join(pfx86, 'Microsoft', 'Edge Beta', 'Application', 'msedge.exe'),
        path.join(pf, 'Microsoft', 'Edge Beta', 'Application', 'msedge.exe')
      ],
      'msedge-dev': [
        path.join(pfx86, 'Microsoft', 'Edge Dev', 'Application', 'msedge.exe'),
        path.join(pf, 'Microsoft', 'Edge Dev', 'Application', 'msedge.exe')
      ],
      'chrome': [
        path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(pfx86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')
      ],
      'chrome-beta': [
        path.join(pf, 'Google', 'Chrome Beta', 'Application', 'chrome.exe'),
        path.join(pfx86, 'Google', 'Chrome Beta', 'Application', 'chrome.exe')
      ],
      'chrome-dev': [
        path.join(pf, 'Google', 'Chrome Dev', 'Application', 'chrome.exe'),
        path.join(pfx86, 'Google', 'Chrome Dev', 'Application', 'chrome.exe')
      ]
    };
  }
  if (plat === 'darwin') {
    return {
      'msedge': ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      'msedge-beta': ['/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta'],
      'msedge-dev': ['/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev'],
      'chrome': ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      'chrome-beta': ['/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta'],
      'chrome-dev': ['/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev']
    };
  }
  // linux e altri
  return {
    'msedge': ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge'],
    'msedge-beta': ['/usr/bin/microsoft-edge-beta', '/opt/microsoft/msedge-beta/msedge'],
    'msedge-dev': ['/usr/bin/microsoft-edge-dev', '/opt/microsoft/msedge-dev/msedge'],
    'chrome': ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'],
    'chrome-beta': ['/usr/bin/google-chrome-beta', '/opt/google/chrome-beta/chrome'],
    'chrome-dev': ['/usr/bin/google-chrome-unstable', '/opt/google/chrome-unstable/chrome']
  };
}

/**
 * Rileva il miglior canale singolo realmente installato (per il server MCP,
 * che non supporta il fallback multi-canale). Rispetta la preferenza utente
 * nell'ordine di ricerca. Se non trova nulla: 'chrome' se l'utente ha chiesto
 * Chrome, altrimenti 'msedge' (default storico).
 */
function detectInstalledChannel(pref) {
  const exes = knownExecutables();
  for (const ch of channelsForPreference(pref)) {
    const paths = exes[ch] || [];
    for (const p of paths) {
      try { if (fs.existsSync(p)) return ch; } catch (_) {}
    }
  }
  return normalizePreference(pref) === 'chrome' ? 'chrome' : 'msedge';
}

module.exports = {
  EDGE_CHANNELS,
  CHROME_CHANNELS,
  normalizePreference,
  channelsForPreference,
  familyOf,
  labelForChannel,
  isChannelUnavailable,
  effectiveProfileDir,
  launchWithFallback,
  detectInstalledChannel,
  knownExecutables
};
