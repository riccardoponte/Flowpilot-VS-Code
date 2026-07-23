/**
 * Visual diff engine (autosufficiente, zero dipendenze esterne)
 * -------------------------------------------------------------
 * Confronta due screenshot PNG (es. un fotogramma del flusso ORIGINALE contro
 * lo stesso momento del REPLAY) e produce:
 *   - un'immagine "diff" con i pixel cambiati evidenziati in rosso,
 *   - un'immagine "side-by-side" (originale | replay | diff) per il report,
 *   - statistiche quantitative (percentuale di pixel cambiati, bounding box,
 *     griglia delle zone "calde").
 *
 * Perche' fatto a mano: l'estensione NON puo' dipendere da pngjs/pixelmatch
 * (proxy npm aziendale inaffidabile). Qui si usa solo `zlib` di Node per
 * deccomprimere/comprimere gli stream PNG. Decoder PNG supportato: bit depth
 * 8 e 16, color type 0/2/3/4/6, NON interlacciato (formato prodotto da
 * Playwright/Chromium per gli screenshot).
 *
 * Uso da riga di comando:
 *   node visual-diff.js --pair <orig.png> <replay.png> [--out <diff.png>] [--json]
 *   node visual-diff.js --baseline <cartellaOrig> --actual <cartellaReplay> --out <cartellaDiff>
 *
 * Opzioni:
 *   --threshold <0..1>   sensibilita' colore (default 0.1; piu' basso = piu' sensibile)
 *   --max-panel <px>     larghezza max di ogni pannello nel side-by-side (default 900)
 *   --json               stampa il risultato JSON su stdout
 *
 * Uso programmatico:
 *   const vd = require('./lib/visual-diff');
 *   const stat = vd.diffPair(baseP, actP, outDir, { index: 3 });
 *   const report = vd.diffFolders({ baselineDir, actualDir, outDir });
 */

'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------------------
// CRC32 (per i chunk PNG in scrittura)
// ---------------------------------------------------------------------------
let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    CRC_TABLE[n] = c >>> 0;
  }
  return CRC_TABLE;
}
function crc32(buf) {
  const t = crcTable();
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---------------------------------------------------------------------------
// PNG decode (subset: bit depth 8/16, color type 0/2/3/4/6, non interlacciato)
// ---------------------------------------------------------------------------
function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilterRow(filter, cur, prev, bpp) {
  const len = cur.length;
  if (filter === 0) return;
  for (let i = 0; i < len; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    let val = cur[i];
    if (filter === 1) val = (val + a) & 0xFF;
    else if (filter === 2) val = (val + b) & 0xFF;
    else if (filter === 3) val = (val + ((a + b) >> 1)) & 0xFF;
    else if (filter === 4) val = (val + paethPredictor(a, b, c)) & 0xFF;
    else throw new Error('Filtro PNG sconosciuto: ' + filter);
    cur[i] = val;
  }
}

function decodePNG(buf) {
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) throw new Error('Non e\' un PNG valido');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let palette = null, trns = null;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    pos += 12 + len; // len + type + data + crc
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (interlace !== 0) throw new Error('PNG interlacciato (Adam7) non supportato');
  if (bitDepth !== 8 && bitDepth !== 16) throw new Error('Bit depth ' + bitDepth + ' non supportato');
  const CH = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = CH[colorType];
  if (!channels) throw new Error('Color type ' + colorType + ' non supportato');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bytesPerSample = bitDepth / 8;
  const bpp = channels * bytesPerSample;
  const stride = width * bpp;
  const decoded = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const cur = decoded.slice(y * stride, (y + 1) * stride);
    raw.copy(cur, 0, rp, rp + stride);
    rp += stride;
    unfilterRow(filter, cur, prev, bpp);
    prev = cur;
  }

  // Converte in RGBA 8-bit. Per il 16-bit prende il byte alto (big-endian).
  const rgba = Buffer.alloc(width * height * 4);
  const s = bytesPerSample; // offset per canale
  for (let p = 0; p < width * height; p++) {
    const so = p * bpp, dPos = p * 4;
    if (colorType === 6) {
      rgba[dPos] = decoded[so]; rgba[dPos + 1] = decoded[so + s];
      rgba[dPos + 2] = decoded[so + 2 * s]; rgba[dPos + 3] = decoded[so + 3 * s];
    } else if (colorType === 2) {
      rgba[dPos] = decoded[so]; rgba[dPos + 1] = decoded[so + s];
      rgba[dPos + 2] = decoded[so + 2 * s]; rgba[dPos + 3] = 255;
    } else if (colorType === 0) {
      const g = decoded[so]; rgba[dPos] = g; rgba[dPos + 1] = g; rgba[dPos + 2] = g; rgba[dPos + 3] = 255;
    } else if (colorType === 4) {
      const g = decoded[so]; rgba[dPos] = g; rgba[dPos + 1] = g; rgba[dPos + 2] = g; rgba[dPos + 3] = decoded[so + s];
    } else if (colorType === 3) {
      const idx = decoded[so];
      rgba[dPos] = palette ? palette[idx * 3] : 0;
      rgba[dPos + 1] = palette ? palette[idx * 3 + 1] : 0;
      rgba[dPos + 2] = palette ? palette[idx * 3 + 2] : 0;
      rgba[dPos + 3] = (trns && idx < trns.length) ? trns[idx] : 255;
    }
  }
  return { width, height, data: rgba };
}

// ---------------------------------------------------------------------------
// PNG encode (color type 6 RGBA, bit depth 8, filtro 0 su ogni riga)
// ---------------------------------------------------------------------------
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  const stride = width * 4;
  const rawImg = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    rawImg[y * (stride + 1)] = 0; // filtro None
    rgba.copy(rawImg, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(rawImg, { level: 6 });
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// Ridimensionamento nearest-neighbor (per allineare screenshot di risoluzione
// diversa e per creare i pannelli ridotti del side-by-side).
// ---------------------------------------------------------------------------
function resizeNearest(img, dw, dh) {
  if (img.width === dw && img.height === dh) return img;
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(img.height - 1, (y * img.height / dh) | 0);
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(img.width - 1, (x * img.width / dw) | 0);
      const so = (sy * img.width + sx) * 4, dPos = (y * dw + x) * 4;
      out[dPos] = img.data[so]; out[dPos + 1] = img.data[so + 1];
      out[dPos + 2] = img.data[so + 2]; out[dPos + 3] = img.data[so + 3];
    }
  }
  return { width: dw, height: dh, data: out };
}

// ---------------------------------------------------------------------------
// Confronto colore in spazio YIQ (stessa metrica di pixelmatch)
// ---------------------------------------------------------------------------
function blend(c, a) { return 255 + (c - 255) * a; }
function pixelDelta(b, a, o) {
  let r1 = b[o], g1 = b[o + 1], bl1 = b[o + 2], a1 = b[o + 3];
  let r2 = a[o], g2 = a[o + 1], bl2 = a[o + 2], a2 = a[o + 3];
  if (r1 === r2 && g1 === g2 && bl1 === bl2 && a1 === a2) return 0;
  if (a1 < 255) { const k = a1 / 255; r1 = blend(r1, k); g1 = blend(g1, k); bl1 = blend(bl1, k); }
  if (a2 < 255) { const k = a2 / 255; r2 = blend(r2, k); g2 = blend(g2, k); bl2 = blend(bl2, k); }
  const y1 = r1 * 0.29889531 + g1 * 0.58662247 + bl1 * 0.11448223;
  const y2 = r2 * 0.29889531 + g2 * 0.58662247 + bl2 * 0.11448223;
  const i1 = r1 * 0.59597799 - g1 * 0.27417610 - bl1 * 0.32180189;
  const i2 = r2 * 0.59597799 - g2 * 0.27417610 - bl2 * 0.32180189;
  const q1 = r1 * 0.21147017 - g1 * 0.52261711 + bl1 * 0.31114694;
  const q2 = r2 * 0.21147017 - g2 * 0.52261711 + bl2 * 0.31114694;
  const dy = y1 - y2, di = i1 - i2, dq = q1 - q2;
  return 0.5053 * dy * dy + 0.299 * di * di + 0.1957 * dq * dq;
}

// ---------------------------------------------------------------------------
// Diff di due immagini gia' decodificate. Restituisce buffer diff + statistiche.
// ---------------------------------------------------------------------------
function diffDecoded(base, act, opts) {
  const t = (opts && opts.threshold != null) ? opts.threshold : 0.1;
  const maxDelta = 35215 * t * t;
  const w = base.width, h = base.height;
  const a = resizeNearest(act, w, h);
  const diff = Buffer.alloc(w * h * 4);
  let changed = 0;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  const cols = Math.max(1, Math.min(12, w)), rows = Math.max(1, Math.min(8, h));
  const grid = new Uint32Array(cols * rows);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const d = pixelDelta(base.data, a.data, o);
      if (d > maxDelta) {
        changed++;
        diff[o] = 255; diff[o + 1] = 0; diff[o + 2] = 0; diff[o + 3] = 255;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        const cc = Math.min(cols - 1, (x * cols / w) | 0);
        const cr = Math.min(rows - 1, (y * rows / h) | 0);
        grid[cr * cols + cc]++;
      } else {
        const yv = base.data[o] * 0.29889531 + base.data[o + 1] * 0.58662247 + base.data[o + 2] * 0.11448223;
        const val = Math.round(255 + (yv - 255) * 0.1); // base sbiadito
        diff[o] = val; diff[o + 1] = val; diff[o + 2] = val; diff[o + 3] = 255;
      }
    }
  }
  const total = w * h;
  const boundingBox = maxX >= 0 ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null;
  const cellArea = (w / cols) * (h / rows);
  const hotCells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ratio = grid[r * cols + c] / cellArea;
      if (ratio > 0.02) hotCells.push({ col: c, row: r, ratio: +ratio.toFixed(3) });
    }
  }
  return {
    width: w, height: h, diff, changed, total,
    changedRatio: total ? changed / total : 0,
    boundingBox,
    grid: { cols, rows, hotCells },
    resizedActual: act.width !== w || act.height !== h,
    actualSize: { w: act.width, h: act.height },
    baseSize: { w, h }
  };
}

// Composito orizzontale: originale | replay | diff (pannelli ridotti).
function makeSideBySide(base, act, diffImg, maxPanel) {
  const mp = maxPanel || 900;
  const scale = base.width > mp ? mp / base.width : 1;
  const pw = Math.max(1, Math.round(base.width * scale));
  const ph = Math.max(1, Math.round(base.height * scale));
  const p1 = resizeNearest(base, pw, ph);
  const p2 = resizeNearest(act, pw, ph);
  const p3 = resizeNearest({ width: diffImg.width, height: diffImg.height, data: diffImg.diff }, pw, ph);
  const gap = 6;
  const W = pw * 3 + gap * 2, H = ph;
  const out = Buffer.alloc(W * H * 4);
  out.fill(255); // sfondo bianco opaco
  function paste(src, ox) {
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        const so = (y * pw + x) * 4, dPos = (y * W + (ox + x)) * 4;
        out[dPos] = src.data[so]; out[dPos + 1] = src.data[so + 1];
        out[dPos + 2] = src.data[so + 2]; out[dPos + 3] = 255;
      }
    }
  }
  paste(p1, 0); paste(p2, pw + gap); paste(p3, pw * 2 + gap * 2);
  return { width: W, height: H, data: out };
}

function verdictLabel(ratio) {
  if (ratio <= 0) return 'identico';
  if (ratio < 0.01) return 'differenze trascurabili';
  if (ratio < 0.05) return 'piccole differenze';
  if (ratio < 0.20) return 'differenze evidenti';
  return 'differenze marcate';
}

// ---------------------------------------------------------------------------
// Diff di una singola coppia di file. Scrive diff-*.png e sidebyside-*.png.
// ---------------------------------------------------------------------------
function diffPair(basePath, actPath, outDir, opts) {
  opts = opts || {};
  const label = opts.label || path.basename(basePath).replace(/\.png$/i, '');
  const safe = label.replace(/[\\/:*?"<>|]/g, '_');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (_) {}
  const res = { label, base: basePath, actual: actPath, status: 'ok' };
  if (!fs.existsSync(basePath)) { res.status = 'missing-base'; return res; }
  if (!fs.existsSync(actPath)) { res.status = 'missing-actual'; return res; }
  let base, act;
  try { base = decodePNG(fs.readFileSync(basePath)); }
  catch (e) { res.status = 'error'; res.error = 'decode originale: ' + e.message; return res; }
  try { act = decodePNG(fs.readFileSync(actPath)); }
  catch (e) { res.status = 'error'; res.error = 'decode replay: ' + e.message; return res; }

  const d = diffDecoded(base, act, opts);
  const diffFile = path.join(outDir, `diff-${safe}.png`);
  const sbsFile = path.join(outDir, `sidebyside-${safe}.png`);
  try { fs.writeFileSync(diffFile, encodePNG(d.width, d.height, d.diff)); } catch (e) { res.error = 'write diff: ' + e.message; }
  try {
    const sbs = makeSideBySide(base, act, d, opts.maxPanel);
    fs.writeFileSync(sbsFile, encodePNG(sbs.width, sbs.height, sbs.data));
    res.sideBySide = sbsFile;
  } catch (e) { res.error = (res.error ? res.error + '; ' : '') + 'write sidebyside: ' + e.message; }

  res.status = d.changed > 0 ? 'changed' : 'identical';
  res.changedPixels = d.changed;
  res.totalPixels = d.total;
  res.changedRatio = +d.changedRatio.toFixed(5);
  res.changedPercent = +(d.changedRatio * 100).toFixed(2);
  res.verdict = verdictLabel(d.changedRatio);
  res.boundingBox = d.boundingBox;
  res.hotCells = d.grid.hotCells;
  res.gridSize = { cols: d.grid.cols, rows: d.grid.rows };
  res.resizedActual = d.resizedActual;
  res.baseSize = d.baseSize;
  res.actualSize = d.actualSize;
  res.diff = diffFile;
  return res;
}

// ---------------------------------------------------------------------------
// Estrae un indice numerico dal nome file (es. "shot-00007-click.png" -> 7).
// ---------------------------------------------------------------------------
function numericIndex(name) {
  const m = /(\d{2,})/.exec(name);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function listPngs(dir) {
  try {
    return fs.readdirSync(dir).filter(n => /\.png$/i.test(n)).sort();
  } catch (_) { return []; }
}

// ---------------------------------------------------------------------------
// Diff di due cartelle di screenshot. Accoppia i file per nome identico, con
// fallback sull'indice numerico. Scrive un report .json/.md/.html.
// ---------------------------------------------------------------------------
function diffFolders(cfg) {
  const { baselineDir, actualDir, outDir } = cfg;
  const opts = { threshold: cfg.threshold, maxPanel: cfg.maxPanel };
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (_) {}

  const baseFiles = listPngs(baselineDir);
  const actFiles = listPngs(actualDir);
  const actByName = new Map(actFiles.map(n => [n, n]));
  const actByIndex = new Map();
  for (const n of actFiles) { const i = numericIndex(n); if (i != null && !actByIndex.has(i)) actByIndex.set(i, n); }

  const pairs = [];
  const usedActual = new Set();
  for (const bn of baseFiles) {
    let an = actByName.get(bn);
    if (!an) { const i = numericIndex(bn); if (i != null) an = actByIndex.get(i); }
    if (an) usedActual.add(an);
    const label = bn.replace(/\.png$/i, '');
    if (!an) {
      pairs.push({ label, base: path.join(baselineDir, bn), status: 'missing-actual' });
      continue;
    }
    pairs.push(diffPair(path.join(baselineDir, bn), path.join(actualDir, an), outDir, { ...opts, label }));
  }
  // Screenshot presenti solo nel replay (elementi/pagine nuovi rispetto all'originale).
  for (const an of actFiles) {
    if (usedActual.has(an)) continue;
    pairs.push({ label: an.replace(/\.png$/i, ''), actual: path.join(actualDir, an), status: 'missing-base' });
  }

  const changed = pairs.filter(p => p.status === 'changed');
  const ratios = pairs.filter(p => typeof p.changedRatio === 'number').map(p => p.changedRatio);
  const summary = {
    generatedAt: new Date().toISOString(),
    baselineDir, actualDir,
    threshold: opts.threshold != null ? opts.threshold : 0.1,
    pairs: pairs.length,
    compared: ratios.length,
    changed: changed.length,
    identical: pairs.filter(p => p.status === 'identical').length,
    missingActual: pairs.filter(p => p.status === 'missing-actual').length,
    missingBase: pairs.filter(p => p.status === 'missing-base').length,
    errors: pairs.filter(p => p.status === 'error').length,
    maxChangedPercent: ratios.length ? +(Math.max(...ratios) * 100).toFixed(2) : 0,
    avgChangedPercent: ratios.length ? +((ratios.reduce((a, b) => a + b, 0) / ratios.length) * 100).toFixed(2) : 0
  };
  const report = { summary, pairs };

  try { fs.writeFileSync(path.join(outDir, 'visual-diff-report.json'), JSON.stringify(report, null, 2)); } catch (_) {}
  try { fs.writeFileSync(path.join(outDir, 'visual-diff.md'), renderMarkdown(report, outDir)); } catch (_) {}
  try { fs.writeFileSync(path.join(outDir, 'visual-diff.html'), renderHtml(report, outDir)); } catch (_) {}
  return report;
}

function rel(p, from) { try { return path.relative(from, p).replace(/\\/g, '/'); } catch (_) { return p; } }

function renderMarkdown(report, outDir) {
  const s = report.summary;
  const L = [];
  L.push('# Diff visivo — replay vs originale', '');
  L.push(`- Checkpoint confrontati: **${s.compared}** su ${s.pairs}`);
  L.push(`- Con differenze: **${s.changed}** · identici: ${s.identical}`);
  L.push(`- Solo nel replay (nuovi): ${s.missingBase} · non catturati nel replay: ${s.missingActual} · errori: ${s.errors}`);
  L.push(`- Massima variazione: **${s.maxChangedPercent}%** · media: ${s.avgChangedPercent}%`, '');
  L.push('| Checkpoint | Esito | Pixel cambiati | Zona (bounding box) | Immagini |');
  L.push('|:---|:---|---:|:---|:---|');
  for (const p of report.pairs) {
    let outcome = p.status;
    if (p.status === 'changed') outcome = `⚠️ ${p.verdict}`;
    else if (p.status === 'identical') outcome = '✅ identico';
    else if (p.status === 'missing-actual') outcome = '⛔ non catturato nel replay';
    else if (p.status === 'missing-base') outcome = '🆕 solo nel replay';
    else if (p.status === 'error') outcome = `❌ errore (${p.error || ''})`;
    const pct = (typeof p.changedPercent === 'number') ? `${p.changedPercent}%` : '';
    const box = p.boundingBox ? `${p.boundingBox.w}×${p.boundingBox.h} @ (${p.boundingBox.x},${p.boundingBox.y})` : '';
    const imgs = [];
    if (p.sideBySide) imgs.push(`[side-by-side](${rel(p.sideBySide, outDir)})`);
    if (p.diff) imgs.push(`[diff](${rel(p.diff, outDir)})`);
    L.push(`| ${p.label} | ${outcome} | ${pct} | ${box} | ${imgs.join(' · ')} |`);
  }
  L.push('');
  L.push('> Legenda side-by-side: **sinistra = originale**, **centro = replay**, **destra = diff** (in rosso i pixel cambiati).');
  L.push('> Il diff quantifica DOVE e QUANTO e\' cambiato; l\'interpretazione del PERCHE\' (colori/valori/grafiche) va fatta guardando le immagini.');
  return L.join('\n');
}

function renderHtml(report, outDir) {
  const s = report.summary;
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cards = report.pairs.map(p => {
    const sbs = p.sideBySide ? `<img loading="lazy" src="${esc(rel(p.sideBySide, outDir))}" alt="side by side">` : '';
    const badge = p.status === 'changed' ? `${esc(p.verdict)} · ${esc(p.changedPercent)}%`
      : p.status === 'identical' ? 'identico'
        : esc(p.status);
    const cls = p.status === 'changed' ? 'chg' : p.status === 'identical' ? 'ok' : 'na';
    return `<div class="card ${cls}"><h3>${esc(p.label)} <span class="b">${badge}</span></h3>${sbs}</div>`;
  }).join('\n');
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Diff visivo — replay vs originale</title>
<style>
 body{font:14px/1.5 system-ui,Segoe UI,sans-serif;margin:0;background:#0f0f14;color:#e6e6ee}
 header{padding:16px 20px;background:#1b1b24;position:sticky;top:0}
 h1{font-size:18px;margin:0 0 6px} .sum{color:#9aa;font-size:13px}
 .grid{padding:16px;display:grid;gap:16px}
 .card{background:#181820;border:1px solid #2a2a36;border-radius:8px;padding:10px}
 .card h3{margin:0 0 8px;font-size:14px;display:flex;justify-content:space-between;align-items:center;gap:8px}
 .card img{width:100%;height:auto;border-radius:4px;display:block;background:#fff}
 .b{font-weight:600;font-size:12px;padding:2px 8px;border-radius:999px;background:#33333f;white-space:nowrap}
 .chg .b{background:#5a1f24;color:#ffb4ad} .ok .b{background:#1f3a24;color:#9be2a8} .na .b{background:#333}
</style></head><body>
<header><h1>Diff visivo — replay vs originale</h1>
<div class="sum">Confrontati ${esc(s.compared)}/${esc(s.pairs)} · con differenze ${esc(s.changed)} · max ${esc(s.maxChangedPercent)}% · media ${esc(s.avgChangedPercent)}%</div></header>
<div class="grid">
${cards}
</div></body></html>`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--pair') o.pair = true;
    else if (a === '--baseline') o.baseline = argv[++i];
    else if (a === '--actual') o.actual = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--threshold') o.threshold = parseFloat(argv[++i]);
    else if (a === '--max-panel') o.maxPanel = parseInt(argv[++i], 10);
    else o._.push(a);
  }
  return o;
}

if (require.main === module) {
  const o = parseArgs(process.argv.slice(2));
  try {
    if (o.pair || (o._.length >= 2 && !o.baseline)) {
      const [basePath, actPath] = o._;
      if (!basePath || !actPath) { console.error('Uso: --pair <orig.png> <replay.png> [--out <diff.png>]'); process.exit(2); }
      const outDir = o.out ? path.dirname(path.resolve(o.out)) : path.dirname(path.resolve(actPath));
      const label = o.out ? path.basename(o.out).replace(/\.png$/i, '') : undefined;
      const res = diffPair(basePath, actPath, outDir, { threshold: o.threshold, maxPanel: o.maxPanel, label });
      console.log(o.json ? JSON.stringify(res, null, 2)
        : `${res.status}${res.changedPercent != null ? ' · ' + res.changedPercent + '% cambiato (' + res.verdict + ')' : ''}`);
      process.exit(res.status === 'error' ? 1 : 0);
    }
    if (o.baseline && o.actual && o.out) {
      const report = diffFolders({ baselineDir: o.baseline, actualDir: o.actual, outDir: o.out, threshold: o.threshold, maxPanel: o.maxPanel });
      const s = report.summary;
      console.log(o.json ? JSON.stringify(report, null, 2)
        : `Confrontati ${s.compared}/${s.pairs} · con differenze ${s.changed} · max ${s.maxChangedPercent}% · report: ${path.join(o.out, 'visual-diff.md')}`);
      process.exit(0);
    }
    console.error('Uso:\n  node visual-diff.js --pair <orig.png> <replay.png> [--out <diff.png>] [--json]\n  node visual-diff.js --baseline <dir> --actual <dir> --out <dir> [--threshold 0.1] [--json]');
    process.exit(2);
  } catch (e) {
    console.error('[visual-diff] Errore:', e.message);
    process.exit(1);
  }
}

module.exports = { decodePNG, encodePNG, diffPair, diffFolders, diffDecoded, resizeNearest };
