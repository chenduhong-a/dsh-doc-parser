import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
// pypdfium2 兜底解释器：插件自带 ocr-venv 已于 2026-11-18 删除（Indra 移除），改用 MinerU 的 venv。
const venvPython = path.join(
  process.env.MINERU_VENV || 'C:\\deepseek\\tools\\mineru4-venv',
  'Scripts',
  'python.exe',
);
const pdfiumScript = path.join(here, 'render_pdfium.py');
const pdfjsEntry = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
const pdfjsRoot = path.resolve(path.dirname(pdfjsEntry), '..', '..');
const cMapUrl = pathToFileURL(path.join(pdfjsRoot, 'cmaps')).href + '/';
const standardFontDataUrl = pathToFileURL(path.join(pdfjsRoot, 'standard_fonts')).href + '/';

export async function loadPdf(file) {
  const data = new Uint8Array(fs.readFileSync(file));
  return pdfjs.getDocument({
    data,
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
}

/** "1-3,5" / "all" → 升序页码数组。 */
export function parsePages(spec, total) {
  if (!spec || String(spec).trim().toLowerCase() === 'all') {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const out = new Set();
  let bad = 0;
  for (const part of String(spec).split(',')) {
    const t = part.trim();
    if (!t) continue;
    const m = t.match(/^(\d+)(?:-(\d+))?$/);
    // 以前语法错的行被静默跳过，整串非法时返回空数组，调用方又退回「全部页」——
    // 用户以为只跑了 3 页，其实跑了整本（2026-11-13 测试发现）。
    if (!m) {
      bad += 1;
      continue;
    }
    const a = Math.max(1, Number(m[1]));
    // 2026-11-26 缺陷测试：整段越界（如 49 页的 PDF 传 pages="999"）原先静默返回空数组，
    // doc_tables 那条路径直接输出空、看起来像「这页没东西」。起点越界就报错；终点越界仍按
    // 文件末尾钳制（"1-999" 是常见写法，不能算错）。
    if (a > total) {
      throw new Error(`page ${a} is beyond this file (it has ${total} page(s)); use 1-${total} or "all"`);
    }
    const b = Math.min(total, m[2] ? Number(m[2]) : a);
    for (let i = a; i <= b; i++) out.add(i);
  }
  if (!out.size && bad) {
    throw new Error(`invalid page spec "${spec}" — use "all", "3", or "1-3,5"`);
  }
  return [...out].sort((x, y) => x - y);
}

/** 单页文本：复用 _pdftest 的行/空格启发式；withPosition 时附行坐标。 */
export async function extractPage(doc, num, withPosition = false) {
  const page = await doc.getPage(num);
  const tc = await page.getTextContent();
  let text = '';
  let lastY = null;
  let lastEndX = null;
  const lines = [];
  let line = null;
  for (const it of tc.items) {
    if (typeof it.str !== 'string') continue;
    const tr = it.transform;
    if (!tr) {
      text += it.str;
      continue;
    }
    const y = Math.round(tr[5]);
    const x = tr[4];
    const size = Math.hypot(tr[0], tr[1]) || 0;
    if (lastY !== null && Math.abs(y - lastY) > 2.5) {
      text += '\n';
      if (line) lines.push(line);
      line = null;
    } else if (lastEndX !== null && x - lastEndX > 1.6) {
      text += ' ';
    }
    text += it.str;
    if (!line) line = { text: it.str, x, y, size: Math.round(size * 10) / 10 };
    else line.text += (x - lastEndX > 1.6 ? ' ' : '') + it.str;
    lastY = y;
    lastEndX = x + (it.width ?? 0);
  }
  if (line) lines.push(line);
  return {
    num,
    text,
    lines: withPosition
      ? lines.map((l) => ({ text: l.text, x: Math.round(l.x * 10) / 10, y: l.y, size: l.size }))
      : undefined,
  };
}

/** 渲染单页为 PNG，返回文件路径。 */
export async function renderPage(doc, num, scale, outDir, pdfPath) {
  const page = await doc.getPage(num);
  const vp = page.getViewport({ scale });
  const width = Math.ceil(vp.width);
  const height = Math.ceil(vp.height);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, vp.width, vp.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  // 文件名带 scale，否则先渲 scale=1 再渲 4 会互相覆盖（2026-11-22 审计）
const file = path.join(outDir, `p${String(num).padStart(3, '0')}@${scale}x.png`);
  // pdfjs 缺少 CCITT/JBIG2 解码器时会渲染成纯白；检测到白页改用 PDFium 重渲。
  if (pdfPath && nonWhiteRatio(canvas, width, height) < 0.001 && fs.existsSync(venvPython)) {
    const r = spawnSync(venvPython, [pdfiumScript, pdfPath, String(num), file, String(scale)], {
      stdio: 'ignore',
      timeout: 60000,
    });
    if (r.status === 0 && fs.existsSync(file) && fs.statSync(file).size > 1000) return file;
  }
  fs.writeFileSync(file, canvas.toBuffer('image/png'));
  return file;
}

/** 采样统计 canvas 的非白像素占比（0~1）。 */
function nonWhiteRatio(canvas, width, height) {
  try {
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, width, height).data;
    let non = 0;
    let total = 0;
    const step = 4 * 17;
    for (let i = 0; i < data.length; i += step) {
      total += 1;
      if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) non += 1;
    }
    return total ? non / total : 1;
  } catch {
    return 1;
  }
}

/** 单页画像：文本字符数、文本算子数、图片算子数、尺寸。用于扫描件判定。 */
export async function probePage(doc, num) {
  const page = await doc.getPage(num);
  const [tc, ops] = await Promise.all([page.getTextContent(), page.getOperatorList()]);
  const textChars = tc.items.reduce((a, it) => a + (typeof it.str === 'string' ? it.str.trim().length : 0), 0);
  const textOps = ops.fnArray.filter((f) => f === pdfjs.OPS.showText).length;
  const images = ops.fnArray.filter(
    (f) => f === pdfjs.OPS.paintImageXObject || f === pdfjs.OPS.paintInlineImageXObject,
  ).length;
  const vp = page.getViewport({ scale: 1 });
  return {
    num,
    width: Math.round(vp.width),
    height: Math.round(vp.height),
    textChars,
    textOps,
    images,
    scanned: textChars < 20 && images > 0,
  };
}

/** 目录/书签（带页码）。 */
export async function outlineOf(doc) {
  const outline = await doc.getOutline();
  if (!outline) return [];
  const out = [];
  const walk = async (items, depth) => {
    for (const it of items) {
      let pageNo = null;
      try {
        const dest = typeof it.dest === 'string' ? await doc.getDestination(it.dest) : it.dest;
        if (dest && dest[0]) pageNo = (await doc.getPageIndex(dest[0])) + 1;
      } catch {
        /* dest may be a raw array */
      }
      out.push({ title: it.title, page: pageNo, depth });
      if (it.items?.length) await walk(it.items, depth + 1);
    }
  };
  await walk(outline, 0);
  return out;
}

/** 元数据对象（字段名尽量保持 pdfjs 原样；Map 转普通对象便于展示）。 */
export async function metadataOf(doc) {
  try {
    const meta = await doc.getMetadata();
    const info = meta?.info ?? {};
    if (info instanceof Map) return Object.fromEntries(info);
    return info;
  } catch {
    return {};
  }
}
