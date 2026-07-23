/**
 * Edge Action Replayer
 * --------------------
 * Riesegue una sessione salvata da recorder.js e produce un report con
 * lo stato di ogni step (ok / fail / skipped) ed eventuale errore.
 *
 * Uso:
 *   node replay.js <cartella-sessione-o-events.json> [opzioni]
 *
 * Esempi:
 *   node replay.js recordings/session-2026-05-04T19-30-00-000Z
 *   node replay.js recordings/session-.../events.json --headless --speed 2
 *
 * Opzioni:
 *   --headless        esegui senza UI (default: con UI)
 *   --speed <n>       velocità (1=naturale, 2=2x più veloce, 0=senza pause)
 *   --timeout <ms>    timeout per singola azione (default 15000)
 *   --stop-on-fail    interrompi al primo errore (default: continua)
 *   --no-shots        non salvare screenshot di fallimento
 *   --url <url>       sovrascrivi l'URL iniziale
 *   --include-noise   esegui anche hover/scroll/resize/navigation/dialog
 *   --realistic       movimento mouse "umano" + trail prima dei click + pause
 *                     extra (utile per menu a cascata Fluent UI/SharePoint)
 *   --countdown <n>   secondi di countdown prima di iniziare (default 3, 0=off)
 *   --profile <name>  preset di tweak per stack specifici. Valori:
 *                       d365  - Dynamics 365 / Power Apps model-driven
 *                               (force click, frame match per name,
 *                                attesa busy-indicator, data-id prioritario)
 *                     Auto-rilevato se l'URL contiene dynamics.com o /main.aspx.
 */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
// Euristiche dei selettori estratte in un modulo testabile (vedi test/).
const { buildLocators: buildLocatorsImpl, stripHashedClassesFromSelector } = require('./lib/selectors');
// Avvio browser centralizzato: Microsoft Edge E Google Chrome (vedi lib/browser.js).
const browserLauncher = require('./lib/browser');

// Preferenza browser propagata dall'estensione VS Code (edgeRecorder.browser).
const BROWSER_PREF = process.env.BROWSER_PREF || 'auto';

// ---------------------------------------------------------------------------
// Avvio del browser con fallback sui canali Edge/Chrome (vedi recorder.js).
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

// -------------------- argv --------------------
const args = process.argv.slice(2);
// Primo argomento posizionale: il path. Se manca o inizia con "--" => menu interattivo.
const firstPositional = args.find(a => !a.startsWith('--'));
const opts = {
  headless: args.includes('--headless'),
  stopOnFail: args.includes('--stop-on-fail'),
  shots: !args.includes('--no-shots'),
  includeNoise: args.includes('--include-noise'),
  realistic: args.includes('--realistic'),
  speed: parseFloat(getArg('--speed', '1')) || 1,
  timeout: parseInt(getArg('--timeout', '15000'), 10),
  url: getArg('--url', null),
  // Pausa MINIMA fra uno step e l'altro (ms). In modalità realistic aiuta
  // quando la pagina ha menu/popup che impiegano un attimo a comparire dopo
  // il click precedente. Default 0: rispetta solo la cadenza originale.
  stepDelay: parseInt(getArg('--step-delay', args.includes('--realistic') ? '300' : '0'), 10),
  // Cap massimo (ms) della pausa derivata dalla cadenza originale registrata.
  // Default alto: rispettiamo le pause reali dell'utente. In realistic torna
  // al vecchio comportamento più "compresso".
  maxStep: parseInt(getArg('--max-step', args.includes('--realistic') ? '1000' : '60000'), 10),
  // Secondi di countdown prima di iniziare i passaggi (0 = disattivato).
  countdown: parseInt(getArg('--countdown', '10'), 10),
  // Preset per stack specifici (es. 'd365'). Auto-rilevato dall'URL se assente.
  profile: (getArg('--profile', '') || '').toLowerCase(),
};
function getArg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

// -------------------- locate files --------------------
let eventsFile, sessionDir;

(async () => {
  let target = firstPositional;
  if (!target) {
    target = await pickSessionInteractively();
    if (!target) { console.log('Nessuna sessione selezionata.'); process.exit(0); }
  }
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    sessionDir = path.resolve(target);
    const ofPath = path.join(sessionDir, 'original flow', 'events.json');
    const rootPath = path.join(sessionDir, 'events.json');
    eventsFile = fs.existsSync(ofPath) ? ofPath : rootPath;
  } else {
    eventsFile = path.resolve(target);
    sessionDir = path.dirname(eventsFile);
    if (path.basename(sessionDir) === 'original flow') sessionDir = path.dirname(sessionDir);
  }
  if (!fs.existsSync(eventsFile)) {
    console.error(`Non trovo events.json in: ${eventsFile}`);
    process.exit(1);
  }
  await main();
})().catch((err) => {
  console.error('[replay] Errore fatale:', err);
  process.exit(2);
});

// -------------------- session picker --------------------
function listSessions() {
  const root = process.env.RECORDINGS_DIR || path.join(__dirname, 'recordings');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .map(name => path.join(root, name))
    .filter(p => fs.statSync(p).isDirectory() && (fs.existsSync(path.join(p, 'original flow', 'events.json')) || fs.existsSync(path.join(p, 'events.json'))))
    .map(p => {
      let nEvents = 0, firstUrl = '';
      try {
        const evFile = fs.existsSync(path.join(p, 'original flow', 'events.json')) ? path.join(p, 'original flow', 'events.json') : path.join(p, 'events.json');
        const ev = JSON.parse(fs.readFileSync(evFile, 'utf8'));
        nEvents = ev.length;
        const nav = ev.find(e => e.url);
        firstUrl = nav ? nav.url : '';
      } catch (_) {}
      return { path: p, name: path.basename(p), mtime: fs.statSync(p).mtimeMs, nEvents, firstUrl };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function pickSessionInteractively() {
  const readline = require('readline');
  function ask(rl, q) { return new Promise(r => rl.question(q, a => r(a))); }

  return new Promise(async (resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    while (true) {
      const sessions = listSessions();
      if (sessions.length === 0) {
        console.error('\nNessuna sessione trovata in recordings/. Esegui prima: npm run record -- <url>');
        rl.close(); return resolve(null);
      }
      console.log('\nSessioni disponibili (più recente in alto):\n');
      sessions.forEach((s, i) => {
        const when = new Date(s.mtime).toLocaleString();
        console.log(`  [${String(i + 1).padStart(2, ' ')}]  ${s.name}`);
        console.log(`        ${when}  —  ${s.nEvents} eventi  —  ${s.firstUrl || '?'}`);
      });
      console.log('\nComandi: <numero> per riprodurre  ·  /rename <n> <nuovo-nome>  ·  /delete <n>  ·  /clear  ·  /open <n>  ·  /refresh  ·  /help  ·  /quit\n');

      const ans = (await ask(rl, '> ')).trim();
      if (!ans) continue;

      // Numero secco => seleziona
      if (/^\d+$/.test(ans)) {
        const idx = parseInt(ans, 10);
        if (idx < 1 || idx > sessions.length) { console.log('Numero fuori intervallo.'); continue; }
        rl.close(); return resolve(sessions[idx - 1].path);
      }

      // Slash command
      if (ans.startsWith('/')) {
        const [cmdRaw, ...rest] = ans.slice(1).split(/\s+/);
        const cmd = cmdRaw.toLowerCase();
        try {
          if (cmd === 'quit' || cmd === 'q' || cmd === 'exit') { rl.close(); return resolve(null); }
          if (cmd === 'help' || cmd === 'h') { printHelp(); continue; }
          if (cmd === 'refresh' || cmd === 'r') { continue; }
          if (cmd === 'open') {
            const i = parseInt(rest[0], 10);
            if (!sessions[i-1]) { console.log('Indice non valido.'); continue; }
            const { spawn } = require('child_process');
            spawn('explorer', [sessions[i-1].path], { detached: true, stdio: 'ignore' }).unref();
            console.log(`Aperto: ${sessions[i-1].path}`);
            continue;
          }
          if (cmd === 'delete' || cmd === 'del' || cmd === 'rm') {
            const i = parseInt(rest[0], 10);
            const s = sessions[i-1];
            if (!s) { console.log('Indice non valido.'); continue; }
            const conf = (await ask(rl, `Eliminare definitivamente "${s.name}"? [y/N] `)).trim().toLowerCase();
            if (conf === 'y' || conf === 'yes' || conf === 's' || conf === 'si' || conf === 'sì') {
              fs.rmSync(s.path, { recursive: true, force: true });
              console.log(`Eliminato: ${s.name}`);
            } else {
              console.log('Annullato.');
            }
            continue;
          }
          if (cmd === 'rename' || cmd === 'mv') {
            const i = parseInt(rest[0], 10);
            const s = sessions[i-1];
            if (!s) { console.log('Indice non valido.'); continue; }
            let newName = rest.slice(1).join(' ').trim();
            if (!newName) newName = (await ask(rl, `Nuovo nome per "${s.name}": `)).trim();
            if (!newName) { console.log('Nome vuoto. Annullato.'); continue; }
            // Sanitizza: niente separatori di percorso o caratteri non validi su Windows
            const safe = newName.replace(/[\\/:*?"<>|]/g, '_');
            const dest = path.join(path.dirname(s.path), safe);
            if (fs.existsSync(dest)) { console.log('Esiste già una cartella con quel nome.'); continue; }
            fs.renameSync(s.path, dest);
            console.log(`Rinominato: ${s.name}  →  ${safe}`);
            continue;
          }
          if (cmd === 'clear' || cmd === 'clearall' || cmd === 'purge') {
            const conf = (await ask(rl, `Eliminare TUTTE le ${sessions.length} sessioni in recordings/? Digita ELIMINA per confermare: `)).trim();
            if (conf === 'ELIMINA') {
              let n = 0;
              for (const s of sessions) {
                try { fs.rmSync(s.path, { recursive: true, force: true }); n++; }
                catch (e) { console.error(`  ! errore su ${s.name}: ${e.message}`); }
              }
              console.log(`Eliminate ${n} sessioni.`);
            } else {
              console.log('Annullato.');
            }
            continue;
          }
          console.log(`Comando sconosciuto: /${cmd}. Digita /help per la lista.`);
        } catch (e) {
          console.error('Errore:', e.message);
        }
        continue;
      }

      console.log('Input non riconosciuto. Digita /help.');
    }
  });

  function printHelp() {
    console.log(`
Comandi disponibili:
  <numero>             riproduci la sessione N
  /rename <n> [nome]   rinomina la sessione N (chiede il nome se omesso)
  /delete <n>          elimina la sessione N (chiede conferma)
  /clear               elimina TUTTE le sessioni (richiede ELIMINA)
  /open <n>            apri la cartella della sessione N in Esplora risorse
  /refresh             ricarica l'elenco
  /help                mostra questo aiuto
  /quit                esci senza riprodurre nulla
`);
  }
}

async function main() {

const REPLAY_TS = new Date().toISOString().replace(/[:.]/g, '-');
const REPLAY_DIR = path.join(sessionDir, `replay-${REPLAY_TS}`);
const FAIL_SHOTS = path.join(REPLAY_DIR, 'failures');
fs.mkdirSync(REPLAY_DIR, { recursive: true });
if (opts.shots) fs.mkdirSync(FAIL_SHOTS, { recursive: true });

const events = JSON.parse(fs.readFileSync(eventsFile, 'utf8'));
// URL di partenza: prima 'session_start' (URL dove l'utente ha cliccato Start),
// poi --url override, poi prima 'navigation' (legacy/fallback), poi primo evento.
const sessionStart = events.find(e => e.type === 'session_start');
const startUrl = (sessionStart && sessionStart.url) || opts.url || (events.find(e => e.type === 'navigation') || {}).url || (events[0] || {}).url || 'about:blank';

console.log(`[replay] Sessione: ${eventsFile}`);
console.log(`[replay] Eventi:   ${events.length}`);
console.log(`[replay] URL:      ${startUrl}`);
console.log(`[replay] Output:   ${REPLAY_DIR}\n`);

// Auto-detect del profilo dallo startUrl se non specificato.
if (!opts.profile) {
  if (/dynamics\.com|crm\d*\.dynamics|\/main\.aspx|\.powerapps\.com/i.test(startUrl)) {
    opts.profile = 'd365';
  }
}
if (opts.profile) console.log(`[replay] Profilo:  ${opts.profile}`);

// -------------------- selettore robusto --------------------
/**
 * Prova più strategie per ritrovare l'elemento dopo settimane:
 *   1) data-testid (più stabile)
 *   2) role + aria-label / text
 *   3) #id
 *   4) selettore CSS originale
 *   5) XPath
 */
// I locator e le euristiche sui selettori sono in ./lib/selectors.js (testabili
// a parte e non duplicati). Qui buildLocators e' solo un wrapper che inietta le
// opzioni di replay correnti (es. il profilo 'd365'). stripHashedClassesFromSelector
// e' importato a livello di modulo (usato anche in findLocator).
function buildLocators(scope, target) {
  return buildLocatorsImpl(scope, target, opts);
}

// Cerca l'elemento prima nel frame indicato (frameUrl), poi nel main frame, poi
// in TUTTI i frame della pagina. Timeout per-strategia molto basso (default 600ms)
// per evitare cumulati di decine di secondi su step che fallirebbero comunque.
async function findLocator(page, target, totalTimeout) {
  const PER_TRY = 600;
  const scopes = [];
  // 1a) prova nel frame con frameName matching (più stabile dell'URL su D365:
  //     i ContentIFrame0/1 si swappano a ogni navigazione tra record)
  if (target && target.frameName) {
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      try { if (f.name() === target.frameName) { scopes.push(f); } } catch (_) {}
    }
  }
  // 1b) prova nel frame con frameUrl matching, se diverso dal main
  if (target && target.frameUrl) {
    for (const f of page.frames()) {
      if (f === page.mainFrame() || scopes.includes(f)) continue;
      if (f.url() === target.frameUrl) { scopes.push(f); break; }
    }
  }
  // 1c) D365: match laschi sul nome (ContentIFrame0/1 sono intercambiabili)
  if (opts.profile === 'd365') {
    for (const f of page.frames()) {
      if (f === page.mainFrame() || scopes.includes(f)) continue;
      let n = ''; try { n = f.name() || ''; } catch (_) {}
      if (/ContentIFrame\d*|areaSwitcherIFrame|InlineDialog/.test(n)) scopes.push(f);
    }
  }
  // 2) main frame (page)
  scopes.push(page);
  // 3) tutti gli altri frame come fallback
  for (const f of page.frames()) if (f !== page.mainFrame() && !scopes.includes(f)) scopes.push(f);

  const t0 = Date.now();
  for (const scope of scopes) {
    const tries = buildLocators(scope, target);
    for (const t of tries) {
      if (Date.now() - t0 > totalTimeout) break;
      try {
        await t.loc.first().waitFor({ state: 'visible', timeout: PER_TRY });
        return { loc: t.loc.first(), strategy: t.kind };
      } catch (_) {}
    }
  }
  // Ultima chance: attached anche se non visible (overlay coperti, ecc.)
  if (target && target.selector) {
    const candidates = [target.selector];
    const stable = stripHashedClassesFromSelector(target.selector);
    if (stable && stable !== target.selector) candidates.push(stable);
    for (const sel of candidates) {
      for (const scope of scopes) {
        try {
          const loc = scope.locator(sel).first();
          await loc.waitFor({ state: 'attached', timeout: 800 });
          return { loc, strategy: sel === target.selector ? 'css-attached' : 'css-stable-attached' };
        } catch (_) {}
      }
    }
  }
  throw new Error('elemento non trovato');
}

// Cerca il primo evento 'navigation' entro `windowMs` dal timestamp di `ev`.
// Ritorna l'URL trovato o null. Usato come fallback quando un click fallisce
// ma sappiamo che la registrazione subito dopo era una navigazione: in quel
// caso possiamo fare direttamente page.goto per proseguire la sessione.
function findFollowupNavigation(events, ev, windowMs) {
  if (!ev || !ev.ts || !Array.isArray(events)) return null;
  const idx = events.indexOf(ev);
  if (idx < 0) return null;
  const t0 = ev.ts;
  for (let j = idx + 1; j < events.length; j++) {
    const e = events[j];
    if (!e || !e.ts) continue;
    if (e.ts - t0 > windowMs) break;
    if (e.type === 'navigation' && e.url) return e.url;
  }
  return null;
}

// -------------------- main --------------------
// (corpo di main() definito sopra)
{
  const PROFILE_DIR = process.env.EDGE_PROFILE_DIR || path.join(__dirname, 'edge-profile');
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  let context;
  try {
    context = await launchEdgeWithFallback(PROFILE_DIR, {
      headless: opts.headless,
      viewport: opts.headless ? { width: 1366, height: 768 } : null
    });
  } catch (e) {
    console.error('[replay] Impossibile avviare il browser:', e.message);
    if (/Apertura nella sessione|existing browser session|browser has been closed/i.test(String(e.message))) {
      console.error('[replay] Chiudi tutte le finestre del browser aperte e riprova (oppure installa un canale Beta/Dev di Edge o Chrome).');
    }
    throw e;
  }
  const browser = context.browser();

  // Chiudi le tab residue del profilo (Edge restora spesso le tab della sessione
  // precedente: Wikipedia, msn.com, about:blank, ecc.) tranne la prima.
  const initialPages = context.pages();
  for (let i = 1; i < initialPages.length; i++) {
    try {
      const u = initialPages[i].url();
      console.log('[replay] Chiudo tab residua: ' + u);
      await initialPages[i].close();
    } catch (_) {}
  }
  let page = initialPages[0] || await context.newPage();

  // Tracking popup: SOLO le finestre realmente aperte dalla pagina corrente
  // (target="_blank", window.open, ecc.). Le tab residue del profilo NON devono
  // dirottare il replay (era il bug delle "Nuova tab Wikipedia / about:blank").
  function bindPopup(p) {
    p.on('popup', (np) => {
      console.log('[replay] Popup rilevato, switch su: ' + np.url());
      page = np;
      bindPopup(np);
    });
  }
  bindPopup(page);

  // Le nuove tab aperte fuori dal flow utente (es. estensioni, Edge startup)
  // vengono SEGNALATE ma NON dirottano il replay.
  context.on('page', (newPage) => {
    if (newPage === page) return;
    const u = newPage.url();
    console.log('[replay] (info) altra tab aperta dal browser: ' + u + ' (ignorata)');
  });

  /** @type {Array<{idx:number,type:string,status:string,strategy?:string,error?:string,durationMs:number,screenshot?:string,event:object}>} */
  const report = [];
  let prevTs = events[0] ? events[0].ts : null;
  const t0 = Date.now();

  // goto veloce: appena il DOM e' pronto si parte. Aspettare 'load' su SPA tipo
  // SharePoint puo' richiedere 30+ secondi di richieste analytics/telemetry.
  try {
    await page.goto(startUrl, { timeout: opts.timeout, waitUntil: 'domcontentloaded' });
  } catch (e) {
    console.log('[replay] goto timeout/fallito, proseguo comunque: ' + e.message);
  }
  // Piccola attesa per gli script iniziali (max 800ms)
  try { await page.waitForLoadState('domcontentloaded', { timeout: 800 }); } catch (_) {}

  // -------------------- Chiusura schede + countdown 10s --------------------
  // Stesso meccanismo del recorder: chiudi TUTTE le altre schede (anche quelle
  // aperte dall'utente fuori da Playwright) prima di iniziare i passaggi.
  try {
    let startTargetId = null;
    try {
      const s = await context.newCDPSession(page);
      const info = await s.send('Target.getTargetInfo').catch(() => null);
      startTargetId = info?.targetInfo?.targetId || null;
      await s.detach().catch(() => {});
    } catch (_) {}

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
      const playwrightOthers = context.pages().filter(p => p !== page && !p.isClosed());
      if (!toClose.length && !playwrightOthers.length) break;
      console.log(`[replay] Chiudo ${toClose.length || playwrightOthers.length} scheda/e altra/e (giro ${i + 1})...`);
      if (bs && toClose.length) {
        await Promise.all(toClose.map(tid =>
          bs.send('Target.closeTarget', { targetId: tid }).catch(() => {})
        ));
      }
      await Promise.all(playwrightOthers.map(p => p.close({ runBeforeUnload: false }).catch(() => {})));
      await new Promise(r => setTimeout(r, 250));
    }
    try { await bs?.detach?.(); } catch (_) {}
  } catch (e) { console.log('[replay] errore chiusura schede: ' + e.message); }

  // Countdown visivo nella pagina prima di iniziare i passaggi.
  const COUNTDOWN_SECONDS = Math.max(0, opts.countdown);
  if (COUNTDOWN_SECONDS === 0) {
    console.log('[replay] Countdown disattivato.');
  } else {
    console.log(`[replay] Countdown ${COUNTDOWN_SECONDS}s prima dei passaggi...`);
  }
  if (COUNTDOWN_SECONDS > 0) try {
    await page.evaluate((total) => {
      const id = '__replay_countdown__';
      document.getElementById(id)?.remove();
      const host = document.createElement('div');
      host.id = id;
      host.style.cssText = 'position:fixed!important;top:12px!important;right:12px!important;z-index:2147483647!important;';
      const sh = host.attachShadow({ mode: 'open' });
      sh.innerHTML = `
        <style>
          :host { all: initial; }
          .panel {
            font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
            background:rgba(20,20,28,0.92); color:#fff; padding:10px 14px;
            border-radius:10px; box-shadow:0 6px 18px rgba(0,0,0,.35);
            display:flex; align-items:center; gap:10px; font-size:13px;
            backdrop-filter:blur(6px); user-select:none;
          }
          .dot { width:10px; height:10px; border-radius:50%; background:#3498db;
                 animation:pulse 1s infinite; }
          @keyframes pulse {
            0% { box-shadow:0 0 0 0 rgba(52,152,219,.7); }
            70% { box-shadow:0 0 0 8px rgba(52,152,219,0); }
            100% { box-shadow:0 0 0 0 rgba(52,152,219,0); }
          }
          .label { font-weight:600; letter-spacing:.3px; }
          .num { font-variant-numeric:tabular-nums; min-width:18px; text-align:right;
                 font-weight:700; color:#3498db; }
        </style>
        <div class="panel">
          <span class="dot"></span>
          <span class="label">REPLAY tra</span>
          <span class="num" id="num">${total}</span>
          <span>s</span>
        </div>
      `;
      (document.documentElement || document.body).appendChild(host);
      window.__replayCountdownSet = (n) => {
        const el = sh.getElementById('num');
        if (el) el.textContent = String(n);
      };
      window.__replayCountdownDone = () => host.remove();
    }, COUNTDOWN_SECONDS).catch(() => {});
  } catch (_) {}

  for (let s = COUNTDOWN_SECONDS; s > 0; s--) {
    console.log(`[replay] ...${s}`);
    try { await page.evaluate((n) => window.__replayCountdownSet?.(n), s); } catch (_) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  try { await page.evaluate(() => window.__replayCountdownDone?.()); } catch (_) {}
  console.log('[replay] ▶ Avvio passaggi.');

  // Eventi NON intenzionali (conseguenze o rumore). Replay li salta a meno di --include-noise.
  // NOTA: 'navigation' NON e' qui: lo gestiamo in runStep come recupero quando
  // la pagina corrente non corrisponde a quella registrata (utile se un click
  // precedente non ha prodotto la navigazione attesa).
  const NOISE = new Set([
    'hover','scroll','resize','wheel',
    'mousedown','mouseup','focus','blur',
    'mousemove', // il trail viene riprodotto SOLO come preludio ai click
    'compositionstart','compositionend',
    'tab_open','tab_close','console','pageerror',
    'request','response','websocket_open','websocket_close','ws_send','ws_recv',
    'download','popstate','hashchange','colorscheme','dialog',
    'dragstart','dragend',
    'session_start', // metadato: gia' usato per startUrl
    'keyup' // teniamo solo keydown per le scorciatoie
  ]);
  // -------------------- Hover intenzionali --------------------
  // Stricter: hover replicato SOLO se entro 1.5s c'e' un click/contextmenu/dblclick
  // (le altre interazioni - tipo input - non aprono dropdown).
  const MEANINGFUL = new Set(['click','dblclick','contextmenu']);
  const intentionalHover = new Set();
  for (let i = 0; i < events.length; i++) {
    if (events[i].type !== 'hover') continue;
    const t0h = events[i].ts || 0;
    for (let j = i + 1; j < events.length; j++) {
      const dt = (events[j].ts || 0) - t0h;
      if (dt > 1500) break;
      if (MEANINGFUL.has(events[j].type)) { intentionalHover.add(i); break; }
    }
  }
  console.log(`[replay] hover intenzionali: ${intentionalHover.size}/${events.filter(e=>e.type==='hover').length}`);

  // -------------------- Coalesce input consecutivi --------------------
  // Se ci sono N eventi 'input' consecutivi sullo stesso target, mantengo solo l'ultimo.
  const skipInput = new Set();
  for (let i = 0; i < events.length - 1; i++) {
    if (events[i].type !== 'input') continue;
    const sel = events[i].target && events[i].target.selector;
    if (!sel) continue;
    let j = i + 1;
    while (j < events.length && events[j].type === 'input' && events[j].target && events[j].target.selector === sel) j++;
    for (let k = i; k < j - 1; k++) skipInput.add(k);
    i = j - 1;
  }
  if (skipInput.size) console.log(`[replay] input duplicati coalescati: ${skipInput.size}`);

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const stepStart = Date.now();

    // Determina SUBITO se l'evento va eseguito o skippato. Se viene skippato
    // non applichiamo n\u00e9 il throttle di cadenza n\u00e9 lo step-delay: altrimenti
    // 1500 eventi rumore (request/response/console/mousemove) generano minuti
    // di attesa inutile. La cadenza originale viene comunque rispettata perch\u00e9
    // `prevTs` viene aggiornato solo sugli eventi davvero eseguiti, quindi il
    // delta misurato \u00e8 quello tra azione utente e azione utente.
    const isSkipNoise = NOISE.has(ev.type) && !opts.includeNoise && !(ev.type === 'hover' && intentionalHover.has(i));
    const isSkipInput = skipInput.has(i);
    const willRun = !isSkipNoise && !isSkipInput;

    if (willRun) {
      // Throttle realistico: rispetta la cadenza originale (divisa per speed),
      // con un cap configurabile (--max-step). Aggiunge inoltre una pausa
      // minima configurabile (--step-delay) per dare tempo a menu/popup di
      // comparire dopo il click precedente.
      if (opts.speed > 0 && prevTs && ev.ts) {
        const wait = Math.max(0, Math.min(opts.maxStep, (ev.ts - prevTs) / opts.speed));
        if (wait > 0) await page.waitForTimeout(wait);
      }
      if (opts.stepDelay > 0) await page.waitForTimeout(opts.stepDelay);
      prevTs = ev.ts;
    }

    const entry = { idx: i, type: ev.type, status: 'ok', durationMs: 0, event: shortEv(ev) };

    if (isSkipInput) {
      entry.status = 'skip';
      entry.error = 'input coalescato (mantengo solo l\'ultimo)';
    } else if (isSkipNoise) {
      entry.status = 'skip';
      entry.error = 'evento non intenzionale (rumore)';
    } else {
      try {
        await runStep(page, ev);
      } catch (err) {
        entry.status = 'fail';
        entry.error = String(err && err.message || err).split('\n')[0].slice(0, 500);
        if (opts.shots) {
          // Screenshot async, non blocca il loop
          const shot = path.join(FAIL_SHOTS, `step-${String(i).padStart(5,'0')}-${ev.type}.png`);
          page.screenshot({ path: shot, fullPage: false, timeout: 2000 })
            .then(() => { entry.screenshot = path.relative(REPLAY_DIR, shot).replace(/\\/g,'/'); })
            .catch(() => {});
        }
      }
    }
    entry.durationMs = Date.now() - stepStart;

    const tag = entry.status === 'ok' ? '✓' : entry.status === 'skip' ? '·' : '✗';
    const desc = (ev.target && ev.target.selector) || ev.url || ev.key || '';
    console.log(`${tag} [${i+1}/${events.length}] ${ev.type.padEnd(14)} ${desc}`.slice(0, 200) + (entry.status === 'fail' ? `  → ${entry.error}` : ''));
    report.push(entry);

    if (entry.status === 'fail' && opts.stopOnFail) break;
  }

  // -------------------- main step dispatcher --------------------
  async function runStep(page, ev) {
    switch (ev.type) {
      case 'navigation':
        // Skip se gia' sulla stessa URL (anche con hash/query diversi minori)
        if (ev.url) {
          try {
            const cur = new URL(page.url());
            const tgt = new URL(ev.url);
            if (cur.origin === tgt.origin && cur.pathname === tgt.pathname) return;
          } catch (_) {}
          try { await page.waitForURL(ev.url, { timeout: 1500 }); }
          catch (_) {
            try { await page.goto(ev.url, { timeout: opts.timeout, waitUntil: 'domcontentloaded' }); }
            catch (e) { console.log('[replay] navigation goto fallita: ' + e.message); }
          }
        }
        return;
      case 'click': {
        // Riproduci sempre il "trail" di mouse + hover che precede il click:
        // su Fluent UI/SharePoint i menu a cascata si aprono solo se il mouse
        // attraversa fisicamente gli antenati nell'ordine giusto.
        await replayPrecedingTrail(page, events, ev);
        // D365: aspetta che la maschera "loading" sparisca prima di cliccare,
        // altrimenti il click viene intercettato dall'overlay.
        if (opts.profile === 'd365') await waitForBusyClear(page, 4000);
        const btn = ev.button === 2 ? 'right' : 'left';
        // D365: prima passata con force:true (gli overlay invisibili della UCI
        // bloccano spesso le actionability checks di Playwright).
        const firstClickOpts = opts.profile === 'd365'
          ? { timeout: opts.timeout, button: btn, force: true }
          : { timeout: opts.timeout, button: btn };
        try {
          const { loc } = await findLocator(page, ev.target, opts.timeout);
          await humanHover(page, loc);
          await loc.click(firstClickOpts);
        } catch (err) {
          // Retry 1: aspetta un attimo e riprova senza forzare
          try {
            await page.waitForTimeout(500);
            const { loc } = await findLocator(page, ev.target, opts.timeout);
            await humanHover(page, loc);
            await loc.click({ timeout: opts.timeout, button: btn });
            return;
          } catch (_) {}
          // Retry 2: click con force (bypassa actionability checks)
          try {
            const { loc } = await findLocator(page, ev.target, 2500);
            await loc.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
            await loc.click({ timeout: 3000, force: true, button: btn });
            return;
          } catch (_) {}
          // Retry 3: dispatch diretto dell'evento click via DOM
          try {
            const { loc } = await findLocator(page, ev.target, 2000);
            await loc.dispatchEvent('click');
            return;
          } catch (_) {}
          // Retry 4 (fallback navigazione): se entro ~5s dal click registrato
          // c'e' un evento 'navigation' verso un'URL diversa da quella corrente,
          // riproduciamo direttamente il goto. Questo permette di proseguire la
          // sessione anche quando un quick-link/menu non e' piu' clickabile (es.
          // tile SharePoint riordinati, target dinamici) ma sappiamo dove
          // l'utente sarebbe finito.
          try {
            const navUrl = findFollowupNavigation(events, ev, 5000);
            if (navUrl) {
              const cur = new URL(page.url());
              const tgt = new URL(navUrl);
              const samePath = cur.origin === tgt.origin && cur.pathname === tgt.pathname;
              if (!samePath) {
                console.log(`[replay] click fallito → fallback goto: ${navUrl.slice(0, 160)}`);
                await page.goto(navUrl, { timeout: opts.timeout, waitUntil: 'domcontentloaded' });
                return;
              }
            }
          } catch (_) {}
          throw err;
        }
        return;
      }
      case 'dblclick': {
        const { loc } = await findLocator(page, ev.target, opts.timeout);
        await humanHover(page, loc);
        await loc.dblclick({ timeout: opts.timeout });
        return;
      }
      case 'contextmenu': {
        const { loc } = await findLocator(page, ev.target, opts.timeout);
        await humanHover(page, loc);
        await loc.click({ button: 'right', timeout: opts.timeout });
        return;
      }
      case 'input': {
        const { loc } = await findLocator(page, ev.target, opts.timeout);
        const val = ev.value == null ? '' : String(ev.value);
        // contenteditable: fill() non funziona, serve digitazione vera.
        if (ev.target && ev.target.contentEditable) {
          try { await loc.click({ timeout: 2000 }); } catch (_) {}
          try { await page.keyboard.press('Control+A'); await page.keyboard.press('Delete'); } catch (_) {}
          await loc.pressSequentially(val, { delay: 5, timeout: opts.timeout });
        } else {
          try { await loc.fill(val, { timeout: opts.timeout }); }
          catch (_) { await loc.pressSequentially(val, { delay: 5, timeout: opts.timeout }); }
        }
        return;
      }
      case 'change': {
        const { loc } = await findLocator(page, ev.target, opts.timeout);
        if (ev.target && ev.target.multiValues && ev.target.multiValues.length) {
          await loc.selectOption(ev.target.multiValues.map(v => String(v)), { timeout: opts.timeout });
        } else if (ev.selectedValue !== undefined) {
          await loc.selectOption(String(ev.selectedValue), { timeout: opts.timeout });
        } else if (ev.checked !== undefined) {
          if (ev.checked) await loc.check({ timeout: opts.timeout });
          else            await loc.uncheck({ timeout: opts.timeout });
        } else if (ev.value !== undefined) {
          await loc.fill(String(ev.value), { timeout: opts.timeout });
        }
        return;
      }
      case 'submit': {
        const { loc } = await findLocator(page, ev.target, opts.timeout);
        await loc.evaluate((f) => { if (typeof f.submit === 'function') f.submit(); });
        return;
      }
      case 'keydown': {
        // Caratteri puri: se non c'e' un input target gestito, prova a digitare in pagina
        if (!(ev.key && ev.key.length > 1) && !ev.ctrl && !ev.alt && !ev.meta) {
          // se il target era contenteditable e non gia' coperto da input, digita
          if (ev.target && ev.target.contentEditable && ev.key) {
            try {
              const { loc } = await findLocator(page, ev.target, 1500);
              await loc.press(ev.key, { timeout: 1500 });
            } catch (_) { try { await page.keyboard.press(ev.key); } catch (_) {} }
          }
          return;
        }
        const mods = [];
        if (ev.ctrl) mods.push('Control');
        if (ev.shift) mods.push('Shift');
        if (ev.alt)  mods.push('Alt');
        if (ev.meta) mods.push('Meta');
        await page.keyboard.press([...mods, ev.key].join('+'));
        return;
      }
      case 'scroll':
        await page.evaluate(({ x, y }) => window.scrollTo(x || 0, y || 0), { x: ev.x, y: ev.y });
        return;
      case 'resize':
        try { await page.setViewportSize({ width: ev.w, height: ev.h }); } catch (_) {}
        return;
      case 'hover': {
        try {
          const { loc } = await findLocator(page, ev.target, 1500);
          await humanHover(page, loc);
          await page.waitForTimeout(180); // lascia tempo a menu/tooltip di apparire
        } catch (_) {}
        return;
      }
      case 'mousemove': {
        // Movimento "fisico" del mouse alle coordinate registrate.
        if (Number.isFinite(ev.x) && Number.isFinite(ev.y)) {
          try {
            await page.mouse.move(ev.x, ev.y, { steps: 4 });
            await updateGhostCursor(page, ev.x, ev.y);
          } catch (_) {}
        }
        return;
      }
      case 'drop': {
        // Cerca l'ultimo dragstart prima di questo drop (entro 30s) e simula dragTo
        try {
          const dropIdx = events.indexOf(ev);
          let dragStart = null;
          for (let k = dropIdx - 1; k >= 0; k--) {
            const dt = (ev.ts || 0) - (events[k].ts || 0);
            if (dt > 30000) break;
            if (events[k].type === 'dragstart' && events[k].target) { dragStart = events[k]; break; }
          }
          if (dragStart) {
            const { loc: src } = await findLocator(page, dragStart.target, 2000);
            const { loc: dst } = await findLocator(page, ev.target, 2000);
            await src.dragTo(dst, { timeout: opts.timeout });
          } else if (ev.target) {
            const { loc } = await findLocator(page, ev.target, 2000);
            await loc.dispatchEvent('drop');
          }
        } catch (_) {}
        return;
      }

      // Replay hover intenzionali precedenti l'evento corrente (chiamato da click in fallback).
      // (definita come funzione esterna allo switch; vedi sotto)
      case 'dialog':
        // I dialog vengono gestiti automaticamente da page.on('dialog')
        return;
      // Tutti gli altri sono solo informativi
      case 'tab_open': case 'tab_close':
      case 'console': case 'pageerror':
      case 'request': case 'response':
      case 'websocket_open': case 'websocket_close':
      case 'ws_send': case 'ws_recv':
      case 'download':
      case 'focus': case 'blur':
      case 'mousedown': case 'mouseup':
      case 'wheel':
      case 'compositionstart': case 'compositionend':
      case 'copy': case 'cut': case 'paste':
      case 'dragstart': case 'dragend':
      case 'popstate': case 'hashchange':
      case 'colorscheme':
        // no-op, è solo log
        return;
      default:
        return;
    }
  }

  await finalize();

  async function finalize() {
    const totalMs = Date.now() - t0;
    const okN   = report.filter(r => r.status === 'ok').length;
    const failN = report.filter(r => r.status === 'fail').length;
    const skipN = report.filter(r => r.status === 'skip').length;

    const summary = {
      session: eventsFile,
      replayedAt: new Date().toISOString(),
      durationMs: totalMs,
      total: report.length,
      ok: okN, fail: failN, skip: skipN,
      options: opts,
      steps: report
    };

    const jsonOut = path.join(REPLAY_DIR, 'replay-report.json');
    const htmlOut = path.join(REPLAY_DIR, 'replay-report.html');
    try { fs.writeFileSync(jsonOut, JSON.stringify(summary, null, 2), 'utf8'); } catch (_) {}
    try { fs.writeFileSync(htmlOut, renderHtml(summary), 'utf8'); } catch (_) {}

    console.log(`\n=== Replay completato in ${(totalMs/1000).toFixed(1)}s ===`);
    console.log(`  ✓ ok:   ${okN}`);
    console.log(`  ✗ fail: ${failN}`);
    console.log(`  · skip: ${skipN}`);
    console.log(`\nReport: ${htmlOut}`);

    // Chiusura con hard-exit garantito: le richieste di rete pendenti su SPA
    // pesanti (SharePoint ecc.) possono bloccare context.close() per decine di s.
    const exitCode = failN > 0 ? 1 : 0;
    const hardExit = setTimeout(() => {
      console.log('[replay] Hard-exit (close del browser troppo lento).');
      process.exit(exitCode);
    }, 5000);
    hardExit.unref?.();
    const withTimeout = (p, ms, label) => Promise.race([
      Promise.resolve(p).catch((e) => console.log(`[replay] ${label}: ${e.message || e}`)),
      new Promise((res) => setTimeout(() => { console.log(`[replay] ${label}: timeout ${ms}ms, salto`); res(); }, ms))
    ]);
    await withTimeout(context.close(), 3000, 'context.close');
    if (browser) await withTimeout(browser.close(), 1500, 'browser.close');
    clearTimeout(hardExit);
    process.exit(exitCode);
  }

  // -------------------- Stop pulito (Ctrl+C, SIGTERM, sentinella host) --------------------
  // Salva un report PARZIALE prima di chiudere: cosi' "Genera .md" funziona
  // anche se l'utente interrompe il replay a metà.
  let aborting = false;
  function gracefulAbort(reason) {
    if (aborting) return; aborting = true;
    console.log(`\n[replay] Interruzione (${reason}): salvo report parziale...`);
    finalize().catch((e) => {
      console.error('[replay] errore finalize:', e.message);
      process.exit(1);
    });
  }
  process.on('SIGINT',  () => gracefulAbort('SIGINT'));
  process.on('SIGTERM', () => gracefulAbort('SIGTERM'));
  try {
    process.stdin.setEncoding('utf8');
    let buf = '';
    process.stdin.on('data', (d) => {
      buf += d;
      if (buf.includes('__STOP__')) gracefulAbort('host stop');
    });
    process.stdin.on('end', () => { if (!aborting) gracefulAbort('stdin end'); });
  } catch (_) {}
}
} // end main()

// -------------------- helpers --------------------
// Riesegue gli hover registrati nei ~2.5 secondi prima dell'evento corrente
// (utile per riaprire menu a tendina/dropdown a cascata che sono stati nascosti).
async function replayPrecedingHovers(page, events, currentEv) {
  const tEnd = currentEv.ts || 0;
  const tStart = tEnd - 2500;
  let count = 0;
  for (const ev of events) {
    if (ev === currentEv) break;
    if (ev.type !== 'hover') continue;
    const ts = ev.ts || 0;
    if (ts < tStart || ts >= tEnd) continue;
    if (!ev.target) continue;
    try {
      const { loc } = await findLocator(page, ev.target, 1500);
      await humanHover(page, loc);
      await page.waitForTimeout(150);
      count++;
    } catch (_) {}
  }
  return count;
}

// Riproduce il "trail" di mousemove + hover che precede un click: percorso reale
// del cursore registrato. Indispensabile per menu a cascata (Fluent UI/SharePoint)
// che dipendono dal mouseenter/mouseleave fisico sugli antenati.
// Finestra: 3 secondi prima del click. Limita la lunghezza del trail per non
// rallentare troppo (max 30 mousemove + tutti gli hover).
// Attiva SOLO con --realistic; in modalità normale il replay va dritto al target.
async function replayPrecedingTrail(page, events, currentEv) {
  if (!opts.realistic) return;
  const tEnd = currentEv.ts || 0;
  const tStart = tEnd - 3000;
  const i = events.indexOf(currentEv);
  // raccogli tutti gli eventi nella finestra, in ordine
  const trail = [];
  for (let k = Math.max(0, i - 200); k < i; k++) {
    const ev = events[k];
    const ts = ev.ts || 0;
    if (ts < tStart) continue;
    if (ev.type === 'mousemove' || ev.type === 'hover') trail.push(ev);
  }
  // sotto-campiona se troppi mousemove (es. 1 ogni 3)
  const moves = trail.filter(e => e.type === 'mousemove');
  let stride = 1;
  if (moves.length > 30) stride = Math.ceil(moves.length / 30);
  let mvCount = 0;
  for (const ev of trail) {
    try {
      if (ev.type === 'mousemove') {
        if ((mvCount++ % stride) !== 0) continue;
        if (Number.isFinite(ev.x) && Number.isFinite(ev.y)) {
          await page.mouse.move(ev.x, ev.y, { steps: 3 });
          await updateGhostCursor(page, ev.x, ev.y);
        }
      } else if (ev.type === 'hover' && ev.target) {
        const { loc } = await findLocator(page, ev.target, 1000);
        await humanHover(page, loc);
        const pause = 80 / Math.max(0.1, opts.speed);
        await page.waitForTimeout(pause);
      }
    } catch (_) {}
  }
}

// Movimento del mouse "umano": va al centro dell'elemento con N step intermedi,
// emettendo veri mousemove (necessario per menu CSS :hover, dropdown a cascata,
// tooltip e UI che ascoltano mousemove invece di mouseenter).
// In modalità normale usa pochi step (rapido). Con --realistic ne usa molti.
async function humanHover(page, locator) {
  try {
    const box = await locator.boundingBox({ timeout: 1500 });
    if (!box) { await locator.hover({ timeout: 1500 }); return; }
    // scroll into view se serve
    try { await locator.scrollIntoViewIfNeeded({ timeout: 800 }); } catch (_) {}
    const target = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    // Mouse move con step intermedi (Playwright emette mousemove fluidi)
    const steps = opts.realistic ? Math.max(2, Math.round(18 / Math.max(0.1, opts.speed))) : 4;
    await page.mouse.move(target.x, target.y, { steps });
    await updateGhostCursor(page, target.x, target.y);
  } catch (_) {
    try { await locator.hover({ timeout: 1500 }); } catch (__) {}
  }
}

// Aspetta che la "busy mask" / loading overlay di Dynamics 365 sparisca.
// La UCI inietta div con data-id "loading-spinner" / classi "busy" che
// intercettano i click. Ritorno appena tutti questi elementi sono nascosti
// o entro `timeout` ms (best-effort: non fa fallire lo step).
async function waitForBusyClear(page, timeout) {
  const t0 = Date.now();
  const sels = [
    '[data-id="loading-container"]',
    '[data-id*="loading"]',
    '.busyindicator',
    '.unloadingmask',
    '#shell-spinner',
  ];
  while (Date.now() - t0 < timeout) {
    let busy = false;
    for (const f of [page, ...page.frames().filter(f => f !== page.mainFrame())]) {
      for (const s of sels) {
        try {
          const visible = await f.locator(s).first().isVisible({ timeout: 80 }).catch(() => false);
          if (visible) { busy = true; break; }
        } catch (_) {}
      }
      if (busy) break;
    }
    if (!busy) return;
    await page.waitForTimeout(120);
  }
}

// "Ghost cursor": pallino visibile nella pagina che segue il movimento simulato.
// Iniettato lazy alla prima chiamata e poi solo aggiornato (X, Y).
async function updateGhostCursor(page, x, y) {
  try {
    await page.evaluate(({ x, y }) => {
      let g = document.getElementById('__replay_ghost_cursor__');
      if (!g) {
        g = document.createElement('div');
        g.id = '__replay_ghost_cursor__';
        g.style.cssText = [
          'position:fixed','top:0','left:0',
          'width:22px','height:22px',
          'margin-left:-11px','margin-top:-11px',
          'border-radius:50%',
          'background:radial-gradient(circle, rgba(231,76,60,0.85) 0%, rgba(231,76,60,0.45) 55%, rgba(231,76,60,0) 75%)',
          'border:2px solid rgba(231,76,60,0.9)',
          'box-shadow:0 0 12px rgba(231,76,60,0.7)',
          'z-index:2147483646','pointer-events:none',
          'transition:transform 60ms linear,opacity 200ms',
          'opacity:0.95','will-change:transform'
        ].join(';');
        (document.documentElement || document.body).appendChild(g);
      }
      g.style.transform = `translate(${x}px,${y}px)`;
    }, { x, y });
  } catch (_) {}
}

function shortEv(ev) {
  return {
    type: ev.type,
    url: ev.url,
    key: ev.key,
    value: ev.value,
    selector: ev.target ? ev.target.selector : null,
    text: ev.target ? ev.target.text : null,
    role: ev.target ? ev.target.role : null,
    testId: ev.target ? ev.target.testId : null
  };
}

function renderHtml(s) {
  const rows = s.steps.map(r => {
    const colour = r.status === 'ok' ? '#2ecc71' : r.status === 'fail' ? '#e74c3c' : '#95a5a6';
    const desc = (r.event.selector || r.event.url || r.event.key || '') + (r.event.value ? ` = ${r.event.value}` : '');
    const shot = r.screenshot ? `<a href="${r.screenshot}" target="_blank">screenshot</a>` : '';
    return `<tr>
      <td>${r.idx + 1}</td>
      <td><span style="color:${colour};font-weight:600">${r.status.toUpperCase()}</span></td>
      <td>${escapeHtml(r.type)}</td>
      <td><code>${escapeHtml(desc).slice(0,200)}</code></td>
      <td>${r.durationMs}&nbsp;ms</td>
      <td>${escapeHtml(r.error || '')}</td>
      <td>${shot}</td>
    </tr>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>Replay report</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; margin: 24px; color:#222; }
  h1 { margin-top: 0; }
  .summary { display:flex; gap:16px; margin: 16px 0 24px; }
  .card { background:#f4f6fa; padding:12px 16px; border-radius:8px; min-width:120px; }
  .card .n { font-size: 28px; font-weight: 700; }
  .ok   { color:#2ecc71; } .fail { color:#e74c3c; } .skip { color:#95a5a6; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { padding: 6px 8px; border-bottom: 1px solid #eee; vertical-align: top; text-align: left; }
  th { background:#fafbfd; position: sticky; top: 0; }
  code { background:#f4f6fa; padding:2px 4px; border-radius:4px; }
</style></head><body>
<h1>Replay report</h1>
<p><b>Sessione:</b> <code>${escapeHtml(s.session)}</code><br>
<b>Eseguito:</b> ${escapeHtml(s.replayedAt)} — durata ${(s.durationMs/1000).toFixed(1)} s</p>
<div class="summary">
  <div class="card"><div>Totale</div><div class="n">${s.total}</div></div>
  <div class="card"><div>OK</div><div class="n ok">${s.ok}</div></div>
  <div class="card"><div>FAIL</div><div class="n fail">${s.fail}</div></div>
  <div class="card"><div>SKIP</div><div class="n skip">${s.skip}</div></div>
</div>
<table>
  <thead><tr><th>#</th><th>Stato</th><th>Tipo</th><th>Target</th><th>Durata</th><th>Errore</th><th></th></tr></thead>
  <tbody>${rows}</tbody>
</table>
</body></html>`;
}
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
