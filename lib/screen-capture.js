'use strict';
/**
 * screen-capture.js — registrazione UNICA a schermo intero
 * ---------------------------------------------------------
 * Avvia una singola cattura continua di TUTTO lo schermo (tutti i monitor),
 * dall'inizio alla fine della registrazione, e ne ricava dei frame a 1 fps.
 * A differenza del video di Playwright (che riprende solo il viewport del
 * browser), qui si cattura l'intero desktop: dialoghi di sistema, selettori
 * file, altre finestre, notifiche, ecc.
 *
 * Backend:
 *  - ffmpeg (preferito, Windows con gdigrab): UN solo processo che scrive
 *    contemporaneamente il video (`screen.mp4`, mp4 frammentato -> resta
 *    riproducibile anche in caso di stop brusco) e la sequenza di frame a
 *    1 fps (`frames/frame-000001.jpg`, ...). I frame vengono scritti in tempo
 *    reale, quindi lo stop e' immediato: basta finalizzare il video.
 *  - fallback Windows senza ffmpeg: un loop PowerShell che salva uno screenshot
 *    del desktop virtuale ogni secondo (solo frame, niente video).
 *
 * Nessuna dipendenza npm: usa solo child_process / fs / path / os del runtime.
 */

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Rilevamento ffmpeg: prima il path esplicito (impostazione/env), poi il binario
// incluso nell'estensione (bin/ffmpeg.exe), infine il PATH di sistema.
// Serve un build completo (gdigrab + libx264): quello incluso in Playwright NON
// va bene, e' minimale e non ha gdigrab. Per questo l'estensione ne include uno
// completo, cosi' la cattura a schermo intero funziona anche senza ffmpeg installato.
// ---------------------------------------------------------------------------
function bundledFfmpeg() {
  const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  return path.join(__dirname, '..', 'bin', name);
}

function resolveFfmpeg(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  const bundled = bundledFfmpeg();
  if (fs.existsSync(bundled)) candidates.push(bundled);
  candidates.push('ffmpeg'); // sul PATH
  for (const c of candidates) {
    try {
      const r = cp.spawnSync(c, ['-hide_banner', '-version'], { stdio: 'ignore', windowsHide: true });
      if (r && !r.error && r.status === 0) return c;
    } catch (_) { /* prova il prossimo */ }
  }
  return null;
}

function countFrames(dir) {
  try {
    return fs.readdirSync(dir).filter(f => /^frame-\d+\.(png|jpe?g)$/i.test(f)).length;
  } catch (_) { return 0; }
}

// PowerShell string literal: raddoppia gli apici singoli.
function psQuote(s) { return "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'"; }

// ---------------------------------------------------------------------------
// Backend ffmpeg (Windows / gdigrab): video + frame 1 fps da un unico input.
// ---------------------------------------------------------------------------
function startFfmpeg({ ff, videoDir, framesDir, captureFps, frameFps, startedAt, log, _inputArgs }) {
  const videoPath = path.join(videoDir, 'screen.mp4');
  const framePattern = path.join(framesDir, 'frame-%06d.jpg');
  // Input: gdigrab (Windows, tutto il desktop) salvo override per altre piattaforme.
  const inputArgs = _inputArgs || ['-f', 'gdigrab', '-framerate', String(captureFps), '-i', 'desktop'];
  const args = [
    '-hide_banner', '-loglevel', 'warning', '-y',
    ...inputArgs,
    // Output 1: video a schermo intero. scale trunc(/2)*2 = dimensioni pari
    // (richiesto da libx264). movflags frammentato = file valido anche se il
    // processo viene ucciso senza chiusura pulita.
    '-map', '0:v',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-movflags', '+frag_keyframe+empty_moov',
    videoPath,
    // Output 2: frame a frameFps (default 1 fps), scritti live durante la cattura.
    '-map', '0:v',
    '-vf', `fps=${frameFps}`,
    '-q:v', '4',
    framePattern
  ];
  const proc = cp.spawn(ff, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  try { proc.stderr.on('data', (d) => { stderr += String(d); }); } catch (_) {}
  proc.on('error', (e) => log('[screen] ffmpeg errore: ' + e.message));

  const stop = () => new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      clearTimeout(t1); clearTimeout(t2);
      const video = fs.existsSync(videoPath) ? videoPath : null;
      if (!video && stderr) log('[screen] ffmpeg: ' + stderr.split(/\r?\n/).filter(Boolean).slice(-2).join(' | '));
      resolve({ backend: 'ffmpeg', video, frames: countFrames(framesDir), durationMs: Date.now() - startedAt });
    };
    proc.on('exit', finish);
    // 'q' su stdin = uscita pulita di ffmpeg (finalizza entrambi gli output).
    try { proc.stdin.write('q'); } catch (_) {}
    try { proc.stdin.end(); } catch (_) {}
    const t1 = setTimeout(() => { try { proc.kill('SIGTERM'); } catch (_) {} }, 4000);
    const t2 = setTimeout(() => {
      try {
        if (process.platform === 'win32' && proc.pid) {
          cp.spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
        } else { proc.kill('SIGKILL'); }
      } catch (_) {}
      finish();
    }, 8000);
    t1.unref?.(); t2.unref?.();
  });

  return { backend: 'ffmpeg', videoPath, framesDir, startedAt, stop };
}

// ---------------------------------------------------------------------------
// Fallback Windows senza ffmpeg: screenshot del desktop virtuale ogni secondo
// via System.Drawing (sempre presente su Windows). Solo frame, niente video.
// ---------------------------------------------------------------------------
function startGdiFallback({ framesDir, frameFps, startedAt, log }) {
  const intervalMs = Math.max(200, Math.round(1000 / (frameFps || 1)));
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Add-Type -AssemblyName System.Drawing | Out-Null",
    "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
    "$dir=" + psQuote(framesDir),
    "$i=0",
    "while($true){",
    "  try{",
    "    $b=[System.Windows.Forms.SystemInformation]::VirtualScreen",
    "    $bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height)",
    "    $g=[System.Drawing.Graphics]::FromImage($bmp)",
    "    $g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size)",
    "    $i++",
    "    $p=Join-Path $dir ('frame-{0:D6}.png' -f $i)",
    "    $bmp.Save($p,[System.Drawing.Imaging.ImageFormat]::Png)",
    "    $g.Dispose(); $bmp.Dispose()",
    "  }catch{}",
    "  Start-Sleep -Milliseconds " + intervalMs,
    "}"
  ].join('\n');
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  const proc = cp.spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
    { windowsHide: true, stdio: 'ignore' });
  proc.on('error', (e) => log('[screen] fallback screenshot errore: ' + e.message));

  const stop = () => new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      resolve({ backend: 'gdi', video: null, frames: countFrames(framesDir), durationMs: Date.now() - startedAt });
    };
    proc.on('exit', finish);
    try { proc.kill(); } catch (_) {}
    const t = setTimeout(() => {
      try {
        if (process.platform === 'win32' && proc.pid) {
          cp.spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
        } else { proc.kill('SIGKILL'); }
      } catch (_) {}
      finish();
    }, 2000);
    t.unref?.();
    setTimeout(finish, 3500).unref?.();
  });

  return { backend: 'gdi', framesDir, startedAt, stop };
}

/**
 * Avvia la cattura a schermo intero.
 * @param {object} opts
 * @param {string} opts.videoDir   cartella per il video (screen.mp4)
 * @param {string} opts.framesDir  cartella per i frame (frame-NNNNNN.jpg/png)
 * @param {number} [opts.captureFps=4]  fps di cattura del video
 * @param {number} [opts.frameFps=1]    fps di estrazione dei frame
 * @param {string} [opts.ffmpegPath]    path esplicito a ffmpeg
 * @param {function} [opts.log]
 * @returns {{backend:string, stop:()=>Promise<object>}}
 */
function start(opts) {
  const {
    videoDir, framesDir,
    captureFps = 4, frameFps = 1,
    ffmpegPath = '', log = () => {}
  } = opts || {};
  try { fs.mkdirSync(framesDir, { recursive: true }); } catch (_) {}
  try { fs.mkdirSync(videoDir, { recursive: true }); } catch (_) {}
  const startedAt = Date.now();

  if (process.platform === 'win32') {
    const ff = resolveFfmpeg(ffmpegPath);
    if (ff) return startFfmpeg({ ff, videoDir, framesDir, captureFps, frameFps, startedAt, log });
    log('[screen] ffmpeg non trovato: uso il fallback a screenshot (solo frame, niente video).');
    return startGdiFallback({ framesDir, frameFps, startedAt, log });
  }

  // Altre piattaforme: prova ffmpeg con l'input nativo, altrimenti no-op.
  const ff = resolveFfmpeg(ffmpegPath);
  if (ff && process.platform === 'linux') {
    const display = process.env.DISPLAY || ':0.0';
    return startFfmpeg({
      ff, videoDir, framesDir, captureFps, frameFps, startedAt, log,
      _inputArgs: ['-f', 'x11grab', '-framerate', String(captureFps), '-i', display]
    });
  }
  log('[screen] Cattura a schermo intero non supportata su questa piattaforma: salto.');
  return { backend: 'none', startedAt, stop: async () => ({ backend: 'none', video: null, frames: 0, durationMs: 0 }) };
}

module.exports = { start, resolveFfmpeg, countFrames };

// ---------------------------------------------------------------------------
// Self-test: node lib/screen-capture.js --test <secondi> --out <cartella>
// ---------------------------------------------------------------------------
if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
  const sec = Number(arg('--test', '5')) || 5;
  const out = arg('--out', path.join(os.tmpdir(), 'screen-capture-test-' + Date.now()));
  const videoDir = path.join(out, 'video');
  const framesDir = path.join(out, 'frames');
  (async () => {
    const cap = start({
      videoDir, framesDir, captureFps: 4, frameFps: 1,
      ffmpegPath: process.env.FFMPEG_PATH || '', log: (l) => console.log(l)
    });
    console.log(`backend=${cap.backend} — cattura ${sec}s in ${out} ...`);
    await new Promise((r) => setTimeout(r, sec * 1000));
    const sum = await cap.stop();
    console.log('RESULT ' + JSON.stringify(sum));
  })().catch((e) => { console.error(e); process.exit(1); });
}
