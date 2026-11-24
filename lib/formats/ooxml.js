// 零依赖 OOXML 读取：docx / pptx / xlsx。
// 不引第三方库（插件目录不跑 pnpm），zip 自己解、XML 用正则取文本。
import fs from 'node:fs';
import zlib from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** 从尾部找 EOCD（可能带注释，最多回溯 64 KB）。 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/** 列出 zip 内所有条目。 */
export function listEntries(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('not a zip file (EOCD not found)');
  const total = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(ptr) !== SIG_CD) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const size = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const offset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    out.push({ name, method, compressedSize, size, offset });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 读单个条目，返回 Buffer。只支持 store(0) 与 deflate(8)。 */
export function readEntry(buf, entry) {
  const p = entry.offset;
  if (buf.readUInt32LE(p) !== SIG_LOCAL) throw new Error(`bad local header for ${entry.name}`);
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);
}

const OFFICE_EXTS = new Set(['docx', 'pptx', 'xlsx', 'docm', 'pptm', 'xlsm']);

/** 按扩展名判断是否 OOXML（不做魔数校验，调用方负责）。 */
export function ooxmlExt(abs) {
  const m = /\.([a-z0-9]+)$/i.exec(String(abs || ''));
  const ext = m ? m[1].toLowerCase() : '';
  return OFFICE_EXTS.has(ext) ? ext.replace(/m$/, 'x') : null;
}

export function isOoxml(abs) {
  return ooxmlExt(abs) !== null;
}

function decodeXml(s) {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m0, g) => {
    const k = g.toLowerCase();
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'amp') return '&';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    if (g[0] === '#') {
      const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      try {
        return String.fromCodePoint(n);
      } catch {
        return m0;
      }
    }
    return m0;
  });
}

/** 取某个标签内的纯文本（去内嵌标签、解实体），返回数组。 */
function texts(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml))) {
    const t = decodeXml(m[1].replace(/<[^>]+>/g, '')).trim();
    if (t) out.push(t);
  }
  return out;
}

export function openOoxml(abs) {
  const buf = fs.readFileSync(abs);
  const entries = listEntries(buf);
  const map = new Map(entries.map((e) => [e.name, e]));
  const kind = ooxmlExt(abs);
  return {
    buf,
    entries,
    map,
    kind,
    has: (name) => map.has(name),
    read: (name) => {
      const e = map.get(name);
      return e ? readEntry(buf, e) : null;
    },
    text: (name) => {
      const e = map.get(name);
      return e ? readEntry(buf, e).toString('utf8') : null;
    },
  };
}

function slideNames(o) {
  return o.entries
    .map((e) => e.name)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = Number(/(\d+)\.xml$/.exec(a)[1]);
      const nb = Number(/(\d+)\.xml$/.exec(b)[1]);
      return na - nb;
    });
}

function sheetNames(o) {
  return o.entries
    .map((e) => e.name)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]));
}

function sharedStrings(o) {
  const xml = o.text('xl/sharedStrings.xml');
  if (!xml) return [];
  // texts() 内部已 decodeXml；再解一次会把 &amp;lt; 变成 <（2026-11-22 审计）
return texts(xml, 'si');
}

/** 体检：格式、页/段/sheet 数、文本量、图片、公式、表格。 */
export function ooxmlInfo(abs) {
  const o = openOoxml(abs);
  const media = o.entries.filter((e) => /^(ppt|word|xl)\/media\//.test(e.name));
  const ole = o.entries.filter((e) => /^ppt\/embeddings\/oleObject\d+\.bin$/.test(e.name));
  const out = {
    kind: o.kind,
    mediaCount: media.length,
    oleObjects: ole.length,
    hasMath: false,
    hasTables: false,
    pages: 0,
    textChars: 0,
    notes: [],
  };

  if (o.kind === 'pptx') {
    const slides = slideNames(o);
    out.pages = slides.length;
    let chars = 0;
    for (const name of slides) {
      const xml = o.text(name) || '';
      chars += texts(xml, 'a:t').join('').length;
      if (/<p:oleObj\b/.test(xml) || /<m:oMath\b/.test(xml)) out.hasMath = true;
      if (/<a:tbl\b/.test(xml)) out.hasTables = true;
    }
    out.textChars = chars;
    if (ole.length) {
      out.hasMath = true;
      out.notes.push(`MathType OLE objects: ${ole.length}（文本层不含公式，需抽图识读）`);
    }
  } else if (o.kind === 'docx') {
    const xml = o.text('word/document.xml') || '';
    out.pages = (xml.match(/<w:p\b/g) || []).length;
    out.textChars = texts(xml, 'w:t').join('').length;
    out.hasMath = /<m:oMath\b/.test(xml);
    out.hasTables = /<w:tbl\b/.test(xml);
    out.notes.push('docx 没有固定页，pages 是段落数');
  } else if (o.kind === 'xlsx') {
    const sheets = sheetNames(o);
    out.pages = sheets.length;
    // 之前按单元格数 ×4 估算，比真实文本量虚高约 4 倍（2026-11-13 tester 发现）；
    // 改成把每行单元格的真实值拼起来量长度
    let chars = 0;
    const ss = sharedStrings(o);
    for (const name of sheets) {
      const xml = o.text(name) || '';
      for (const row of sheetRows(xml, ss)) {
        for (const cell of row) chars += String(cell ?? '').length;
      }
    }
    out.textChars = chars;
    out.hasTables = true;
    out.notes.push('pages = sheet 数');
  }
  return out;
}

/** 文本提取：返回 blocks（pptx 每 slide 一块 / docx 全文一块 / xlsx 每 sheet 一块）。 */
export function ooxmlText(abs, { pages } = {}) {
  const o = openOoxml(abs);
  const blocks = [];
  const want = parsePageSel(pages);

  if (o.kind === 'pptx') {
    const slides = slideNames(o);
    slides.forEach((name, i) => {
      const num = i + 1;
      if (want && !want.has(num)) return;
      const xml = o.text(name) || '';
      const parts = texts(xml, 'a:t');
      const body = parts.length ? parts.join('\n') : '';
      const extra = [];
      if (/<p:oleObj\b/.test(xml)) extra.push('[本页含 OLE 嵌入对象（可能是 MathType 公式），文本层不含其内容]');
      if (/<a:tbl\b/.test(xml)) extra.push('[本页含表格]');
      blocks.push({ num, text: [body, ...extra].filter(Boolean).join('\n') });
    });
  } else if (o.kind === 'docx') {
    const xml = o.text('word/document.xml') || '';
    const paras = [];
    const pRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
    let m;
    while ((m = pRe.exec(xml))) {
      const t = texts(m[1], 'w:t').join('');
      if (t.trim()) paras.push(t);
    }
    (want ? [...want].filter((n) => n === 1) : [1]).forEach((num) => {
      blocks.push({ num, text: paras.join('\n') });
    });
  } else if (o.kind === 'xlsx') {
    const sheets = sheetNames(o);
    const ss = sharedStrings(o);
    sheets.forEach((name, i) => {
      const num = i + 1;
      if (want && !want.has(num)) return;
      const xml = o.text(name) || '';
      const rows = sheetRows(xml, ss);
      blocks.push({ num, text: rows.map((r) => r.join('\t')).join('\n') });
    });
  }
  const chars = blocks.reduce((a, b) => a + b.text.length, 0);
  return { blocks, counts: { blocks: blocks.length, chars } };
}

function parsePageSel(pages) {
  if (!pages || typeof pages !== 'string') return null;
  const set = new Set();
  for (const part of pages.split(',')) {
    const s = part.trim();
    if (!s) continue;
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(s);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) set.add(i);
    } else if (/^\d+$/.test(s)) {
      set.add(Number(s));
    }
  }
  return set.size ? set : null;
}

function colToIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || '');
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function sheetRows(xml, shared) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cells = [];
    // 自闭合单元格 <c r="A1" s="1"/> 以前匹配不到，整格当空值丢掉（2026-11-22 审计）
    const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cRe.exec(rm[1]))) {
      const attrs = cm[1];
      const body = cm[2] ?? '';
      const refM = /r="([A-Z]+\d+)"/.exec(attrs);
      const idx = refM ? colToIndex(refM[1]) : cells.length;
      const tM = /t="([^"]+)"/.exec(attrs);
      const vM = /<v>([\s\S]*?)<\/v>/.exec(body);
      const isM = /<is>([\s\S]*?)<\/is>/.exec(body);
      let val = '';
      if (tM && tM[1] === 's' && vM) val = shared[Number(vM[1])] ?? '';
      else if (isM) val = texts(isM[1], 't').join('');
      else if (vM) val = decodeXml(vM[1]);
      if (val !== '') cells[idx] = val;
    }
    // 空行以前被整行丢弃，输出行序与 Excel 行号错位（2026-11-22 审计）
    // 注意：cells 因按列号赋值可能是稀疏数组，map 会跳过空槽（序列化后成 null），这里显式铺平
    const row = [];
    for (let ci = 0; ci < cells.length; ci++) row.push(cells[ci] === undefined ? '' : cells[ci]);
    rows.push(row);
  }
  // 尾部连续空行裁掉（Excel 常留一大片只有样式没有内容的空 row）
  while (rows.length && !rows[rows.length - 1].some((c) => c !== '')) rows.pop();
  return rows;
}

/** 表格提取：xlsx 每 sheet 一组行列；docx 的 w:tbl 逐表；pptx 的 a:tbl 逐表。 */
export function ooxmlTables(abs, { maxRows = 200, pages = null } = {}) {
  const o = openOoxml(abs);
  const out = [];
  if (o.kind === 'xlsx') {
    const sheets = sheetNames(o);
    const ss = sharedStrings(o);
    sheets.forEach((name, i) => {
      const xml = o.text(name) || '';
      // pages 是 sheet 序号数组（doc_tables 传进来），不给就是全部（2026-11-22 审计）
      if (pages && !pages.includes(i + 1)) return;
      const rows = sheetRows(xml, ss).slice(0, maxRows);
      out.push({ label: `sheet${i + 1}`, rows, truncated: rows.length >= maxRows });
    });
  } else if (o.kind === 'docx') {
    const xml = o.text('word/document.xml') || '';
    const tRe = /<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>/g;
    let m;
    let i = 0;
    while ((m = tRe.exec(xml))) {
      i++;
      const rows = [];
      const rRe = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g;
      let r;
      while ((r = rRe.exec(m[1]))) {
        const cells = [];
        const cRe = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g;
        let c;
        while ((c = cRe.exec(r[1]))) cells.push(texts(c[1], 'w:t').join(' '));
        rows.push(cells);
      }
      out.push({ label: `table${i}`, rows: rows.slice(0, maxRows), truncated: rows.length >= maxRows });
    }
  } else if (o.kind === 'pptx') {
    const slides = slideNames(o);
    slides.forEach((name, idx) => {
      const xml = o.text(name) || '';
      const tRe = /<a:tbl\b[^>]*>([\s\S]*?)<\/a:tbl>/g;
      let m;
      let i = 0;
      while ((m = tRe.exec(xml))) {
        i++;
        const rows = [];
        const rRe = /<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g;
        let r;
        while ((r = rRe.exec(m[1]))) {
          const cells = [];
          const cRe = /<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/g;
          let c;
          while ((c = cRe.exec(r[1]))) cells.push(texts(c[1], 'a:t').join(' '));
          rows.push(cells);
        }
        out.push({ label: `slide${idx + 1}-table${i}`, rows: rows.slice(0, maxRows), truncated: rows.length >= maxRows });
      }
    });
  }
  return out;
}
