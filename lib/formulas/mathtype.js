// 公式相关：解 pptx 的「幻灯片 → MathType 公式对象」映射（doc_formulas 的 scan/stats 用），
// 以及用 LibreOffice 把 pptx 转成 PDF 供 OCR 抽公式（extract 用）。
// 注：旧的 WMF/EMF 抽图 + System.Drawing 转 PNG 路线已于 2026-11-14 删除——字体渲染型课件会出乱码。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { listEntries, readEntry } from '../formats/ooxml.js';

const MAX_BYTES = 300 * 1024 * 1024;

export function formulaRoot(dir) {
  return path.join(dir, 'formula');
}

/** 找 LibreOffice 的 soffice（可用 SOFFICE_PATH 覆盖）。 */
export function findSoffice() {
  if (process.env.SOFFICE_PATH) return process.env.SOFFICE_PATH;
  const cands = [
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  ];
  for (const c of cands) {
    if (fs.existsSync(c)) return c;
  }
  return '';
}

/**
 * 用 LibreOffice 把 pptx 转成 PDF（公式由 LibreOffice 自己渲染，字体问题比 System.Drawing 画 WMF 少）。
 * 产物落在 <dir>/formula/<name>.pdf。
 */
export function deckToPdf(abs, dir, opts = {}) {
  const base = formulaRoot(dir);
  fs.mkdirSync(base, { recursive: true });
  const pdf = path.join(base, path.basename(abs).replace(/\.pptx?$/i, '.pdf'));
  if (!opts.force && fs.existsSync(pdf) && fs.statSync(pdf).size > 1024) {
    return { pdf, cached: true };
  }
  const soffice = findSoffice();
  if (!soffice) throw new Error('LibreOffice not found (set SOFFICE_PATH to soffice.exe)');
  const t0 = Date.now();
  const r = spawnSync(
    soffice,
    ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', base, abs],
    { encoding: 'utf8', timeout: 300000, windowsHide: true },
  );
  if (!fs.existsSync(pdf) || fs.statSync(pdf).size < 1024) {
    const why = (r.error && r.error.message) || (r.stderr || r.stdout || '').slice(0, 800) || 'unknown';
    throw new Error('LibreOffice convert failed: ' + why);
  }
  return { pdf, cached: false, elapsedMs: Date.now() - t0 };
}


/** 解 pptx 并建「幻灯片 → 公式矢量图」映射。 */
export function loadDeck(abs) {
  const st = fs.statSync(abs);
  if (st.size > MAX_BYTES) {
    throw new Error(`file too large (${(st.size / 1048576).toFixed(0)} MB > 300 MB)`);
  }
  const buf = fs.readFileSync(abs);
  const entries = listEntries(buf);

  const media = entries.filter((e) => /^ppt\/media\/[^/]+\.(wmf|emf)$/i.test(e.name));
  const ole = entries.filter((e) => /^ppt\/embeddings\/oleObject\d+\.bin$/i.test(e.name));
  const slideXml = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name));
  const relsXml = entries.filter((e) => /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(e.name));

  // rels: rId -> target basename
  const relsOf = new Map();
  for (const e of relsXml) {
    const txt = readEntry(buf, e).toString('utf8');
    const map = new Map();
    for (const m of txt.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
      map.set(m[1], m[2].split('/').pop());
    }
    relsOf.set(e.name.replace('_rels/', '').replace('.rels', ''), map);
  }

  const bySlide = [];
  for (const e of slideXml) {
    const txt = readEntry(buf, e).toString('utf8');
    const rels = relsOf.get(e.name) || new Map();
    // 同一个公式在 slide XML 里常出现两条：一条是 VML 备用（无图），一条带 <a:blip>。
    // 按 oleObject 名去重，保留带图的那条。
    const seen = new Map();
    for (const m of txt.matchAll(/<p:oleObj[^>]*r:id="([^"]+)"([\s\S]*?)<\/p:oleObj>/g)) {
      const oleName = rels.get(m[1]) || '';
      if (!oleName) continue;
      const inner = m[2] || '';
      const blip = inner.match(/<a:blip[^>]*r:embed="([^"]+)"/);
      const imgName = blip ? rels.get(blip[1]) || '' : '';
      const prev = seen.get(oleName);
      if (!prev || (!prev.img && imgName)) seen.set(oleName, { ole: oleName, img: imgName });
    }
    const slideNo = Number(e.name.match(/slide(\d+)\.xml$/)[1]);
    bySlide.push({ slide: slideNo, file: e.name, name: path.basename(e.name), items: [...seen.values()] });
  }
  bySlide.sort((a, b) => a.slide - b.slide);

  return { buf, entries, media, ole, bySlide };
}

/** 只做统计，不落盘。 */
export function deckStats(deck) {
  const total = deck.bySlide.reduce((n, s) => n + s.items.length, 0);
  const noImg = deck.bySlide.reduce((n, s) => n + s.items.filter((i) => !i.img).length, 0);
  return {
    slides: deck.bySlide.length,
    ole: deck.ole.length,
    media: deck.media.length,
    total,
    noImg,
    sheets: Math.ceil(total / 10),
  };
}


/** 缓存统计：只数 formula 目录。 */
export function cacheStats(base) {
  let files = 0;
  let bytes = 0;
  const walk = (p) => {
    let ents;
    try {
      ents = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const q = path.join(p, e.name);
      if (e.isDirectory()) walk(q);
      else {
        files++;
        try {
          bytes += fs.statSync(q).size;
        } catch {}
      }
    }
  };
  walk(base);
  return { files, bytes };
}

