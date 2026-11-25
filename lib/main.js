import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { sha256Cached, cacheDirFor, readJson, writeJson, dataRoot, lruCleanup } from './cache.js';
import {
  loadPdf,
  parsePages,
  extractPage,
  renderPage,
  probePage,
  outlineOf,
  metadataOf,
} from './pdf-core.js';
import { mineruOnlineRun, mineruOnlineReady, mineruParseFile } from './mineru-online.js';
import { rowsFromItems, rowsToTsv } from './tables.js';
import { isOoxml, ooxmlExt, ooxmlInfo, ooxmlText, ooxmlTables } from './formats/ooxml.js';
import { loadDeck, deckStats, cacheStats, formulaRoot, deckToPdf } from './formulas/mathtype.js';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

const here = path.dirname(fileURLToPath(import.meta.url));

export const name = 'doc-parser';
export const inject = ['tools', 'webServer'];

/**
 * 侧栏进度条的数据源：mineruBatch 每写完一块 progress.json 时同步更新这里。
 * key = ocr 缓存目录；前端每秒轮询 /plugins/dsh-doc-parser/api/progress。
 * 只放内存，不落盘——进度是旁路信息，宿主重启后自然清空。
 */
const OCR_PROGRESS = new Map();
const PROGRESS_TTL_AFTER_DONE_MS = 5 * 60 * 1000;

const MAX_BYTES = 200 * 1024 * 1024;
const envMaxChars = Number(process.env.PDF_MAX_CHARS);
const DEFAULT_MAX_CHARS = envMaxChars > 0 ? envMaxChars : 12000;
// MinerU 在线通道内部固定传 'ch'，页缓存键以前三处写死值不一致（ch / chi_sim+eng），跨工具永远打不中（2026-11-22 审计）
const DEFAULT_LANG = 'chi_sim+eng';
// doc_info 的 probeLimit 以前无上限：传 100000 会逐页 probe 到 180 s 超时（2026-11-22 审计）
const PROBE_CAP = 2000;

/** 文本层真伪判定：字数够 + 常用字符占比够（扫描件上别人留下的乱码文本层不算真文本层）。 */
function isRealTextLayer(s) {
  const t = String(s || '').trim();
  if (t.length < 40) return false;
  return textLayerScore(t) >= 0.6;
}

/** pypdfium2 兜底用的 python：只用 MinerU 的 venv（插件自带 ocr-venv 已于 2026-11-18 删除）；找不到就跳过兜底。 */
function pdfiumPython() {
  const candidates = [
    path.join(process.env.MINERU_VENV || 'C:\\deepseek\\tools\\mineru4-venv', 'Scripts', 'python.exe'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return '';
}

// 2026-11-22 审计：apiPortOpenCached 与 apiProbeCache 全文件无调用，已删除。

/**
 * 用 MinerU 3.x（pipeline 后端）解析指定页：公式→LaTeX、表格→HTML、图片裁切。
 * MinerU 直接吃 PDF，不需要事先渲染 PNG。首次调用要加载模型（约 1 分钟）。
 */
const MINERU_API_DEFAULT = 'http://127.0.0.1:18000';
/** MinerU 4.x：mineru-kit file-parse-server 对外提供同步 /v1/file_parse（api-server 自己只有 /v1/tasks 异步口），默认 18001。 */
const MINERU_FP_PORT = Number(process.env.MINERU_FP_PORT || 18001);
/**
 * 解析档位（flash < basic < standard < advanced）。2026-11-26 起改成「文件优先、env 兜底」：
 * MINERU_TIER 是进程环境变量，改了必须重启宿主才被继承（插件进程内加载），
 * 而对比档位要来回改很多次——落成文件后每次调用重读，改完立即生效。
 */
const mineruTierFile =
  process.env.MINERU_TIER_FILE || 'C:\\deepseek\\tools\\dsh-doc-parser\\mineru-tier.txt';
// 2026-11-26 缺陷测试 C2：与 mineru-mode.txt 一样改 fail-closed —— 文件在但值不认识（含空文件）
// 就报错，不再静默回落到 MINERU_TIER，更不会把白名单外的字符串原样发给服务端。
const readMineruTier = () => {
  let exists = false;
  let raw = '';
  try {
    raw = String(fs.readFileSync(mineruTierFile, 'utf8')).trim();
    exists = true;
  } catch {
    /* 文件不存在 → 走环境变量 */
  }
  if (exists) {
    const v = raw.toLowerCase();
    if (v === 'flash' || v === 'basic' || v === 'standard' || v === 'advanced') return v;
    throw new Error(
      `mineru-tier.txt 的内容 ${raw ? `"${raw}"` : '（空）'} 不是 flash/basic/standard/advanced 之一（文件：${mineruTierFile}）。` +
        '请改成其中一档；写错不再回落到 MINERU_TIER，否则会把它原样发给服务端。',
    );
  }
  const env = String(process.env.MINERU_TIER || '').trim().toLowerCase();
  if (env) {
    if (env === 'flash' || env === 'basic' || env === 'standard' || env === 'advanced') return env;
    throw new Error(`MINERU_TIER="${env}" 不是 flash/basic/standard/advanced 之一；请改正或直接写 ${mineruTierFile}。`);
  }
  // 默认 standard（ONNX 小模型 + MinerU2.5-Pro 1.2B VLM）：2026-11-26 同页对比实测，
  // standard 在印刷体文字页上不再出现简繁混（來/體）、漏括号编号、串行丢字，手写板书
  // 也把 (hkil)/i=-(h+k) 认对（basic 认成 (hRil)/-(htk)）。50 页整批 1.16 秒/页，advanced 2.13 秒/页。
  return 'standard';
};
let mineruApiTried = false;
/**
 * 上一次 mineruHttpPages 失败的**具体原因**（HTTP 状态 / content-type / 抛出的异常）。
 * 2026-11-25 加：原先失败只有「返回 null」，一路走到 CLI 兜底的闸门才报错，
 * 报的是一句通用提示，看不出到底是服务没响应、回了非 zip、还是 fetch 抛了。
 */
let lastMineruHttpWhy = '';

/** TCP 级探活：常驻 mineru-api 在听就返回 true（不做 HTTP 语义判断）。 */
function apiPortOpen(url, timeoutMs = 400) {
  return new Promise((resolve) => {
    let host = '127.0.0.1';
    let port = 18000;
    try {
      const u = new URL(url);
      host = u.hostname || host;
      port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    } catch {
      /* 保持默认 */
    }
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const sock = net.connect({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      done(false);
    }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.destroy();
      done(true);
    });
    sock.once('error', () => {
      clearTimeout(timer);
      sock.destroy();
      done(false);
    });
  });
}

/**
 * 常驻 mineru-api 没起就顺手拉一次（每个宿主进程只尝试一次）。
 * MinerU 每次临时起服务要花约 45 秒，常驻后单页约 9 秒。设 MINERU_API_AUTOSTART=0 可关。
 */
/** mineru-api 的工作目录：不设 cwd 它会往宿主当前目录写 `output/<uuid>/`（整本 PDF 副本）。
 *  2026-11-13 测试实测在宿主 CWD 留下 61 文件 / 194.9 MB（含 95 MB PDF 副本两份），且不自动清理。 */
function apiWorkDir() {
  const dir = path.join(os.tmpdir(), 'mineru-api-work');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 建不出来就退回默认 cwd */
  }
  return dir;
}

async function startMineruApi(url) {
  const venv = process.env.MINERU_VENV || 'C:\\deepseek\\tools\\mineru4-venv';
  const exe = path.join(venv, 'Scripts', 'mineru-api.exe');
  if (!fs.existsSync(exe)) return false;
  let host = '127.0.0.1';
  let port = 18000;
  try {
    const u = new URL(url);
    host = u.hostname || host;
    port = Number(u.port) || port;
  } catch {
    /* 保持默认 */
  }
  // 4.x 默认开遥测：统一关掉（MINERU_TELEMETRY_DISABLED=1 对 mineru-api 与 mineru-kit 都生效）
  const env = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    MINERU_MODEL_SOURCE: 'modelscope',
    MINERU_TELEMETRY_DISABLED: '1',
  };
  try {
    const child = spawn(exe, ['--host', host, '--port', String(port)], {
      cwd: apiWorkDir(),
      // 刻意 detached：服务会逃出 DSH 的 Job Object、跨宿主重启继续可用（2026-10-24 用户拍板保留），
      // 换来免掉每次重启后的 30–40 秒冷启动；不用时 `mineru-api.cmd stop` 清掉，清掉后下次调用会自己再拉起。
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    });
    child.unref();
  } catch {
    return false;
  }
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if (await apiPortOpen(url, 500)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!(await apiPortOpen(url, 500))) return false;
  // 4.x 只有 /v1/tasks（异步）；同步口子是 mineru-kit 的 file-parse-server（对外 /v1/file_parse），
  // 它必须连上 api-server 才工作，所以这里把第二个进程也拉起来、等端口开。
  const kit = path.join(venv, 'Scripts', 'mineru-kit.exe');
  const fpUrl = `http://${host}:${MINERU_FP_PORT}`;
  if (fs.existsSync(kit) && !(await apiPortOpen(fpUrl, 400))) {
    try {
      const fp = spawn(
        kit,
        ['file-parse-server', '--api-url', url, '--host', host, '--port', String(MINERU_FP_PORT)],
        { cwd: apiWorkDir(), detached: true, stdio: 'ignore', windowsHide: true, env },
      );
      fp.unref();
    } catch {
      return true;
    }
    const d2 = Date.now() + 30000;
    while (Date.now() < d2) {
      if (await apiPortOpen(fpUrl, 500)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return true;
}

// MinerU 的 type -> 页头 [blocks: ...] 用的 label（与 lib/ocr_mineru.py 的 LABEL 保持一致）
const MINERU_LABEL = {
  text: 'Text',
  equation: 'Equation',
  table: 'Table',
  image: 'Figure',
  figure: 'Figure',
  title: 'Section-Header',
  page_number: 'Page-Number',
  header: 'Page-Header',
  footer: 'Page-Footer',
  list: 'List',
};

/**
 * MinerU 4.x 同步直调：`POST /v1/file_parse` 拿回一个 zip（structured_content.json + images/ + markdown.md）。
 * 相比「spawn python → spawn mineru.exe → 写盘 → 读回」省掉两次进程冷启动
 *（3.x 实测 1.4 秒 vs 10–12 秒；4.x 49 页首轮 82.6 秒含载模型、3 页热态 3.9 秒）。
 * 返回与 ocrMineruPages 同形状的数组；任何不合适的情况（服务不通、文件过大、跨度过大、返回异常）一律返回 null。
 */
// 把要的页按「连续段」切开：[36,193,222] → [[36],[193],[222]]；[1,2,3,7] → [[1,2,3],[7]]。
// 4.x 的 page_range 只能表达一个区间，散页整段发会连带跑中间页，所以必须分开请求。
// 2026-11-25 踩过：下面原来的守卫拿「首尾页差」算跨度，36,193,222 被当成 187 页直接拒掉。
function splitConsecutivePages(nums) {
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const out = [];
  let cur = [];
  for (const n of sorted) {
    if (!cur.length || n === cur[cur.length - 1] + 1) cur.push(n);
    else {
      out.push(cur);
      cur = [n];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

async function mineruHttpPages(pdfAbs, nums, apiUrl, outDir, opts = {}) {
  lastMineruHttpWhy = '';
  let st;
  try {
    st = fs.statSync(pdfAbs);
  } catch (e) {
    lastMineruHttpWhy = `statSync failed: ${e?.message || e} (${pdfAbs})`;
    return null;
  }
  // 2026-11-26 从 120 提到 200：按用户拍板——500 页以上的图片型整本（如 510 页 116 MiB 的课件）要能一次过。
  // 这是内存闸门（multipart 必须整本 readFileSync 进内存），不是「值不值得走 HTTP」，所以调大要掂量机器内存。
  const maxMb = Number(process.env.MINERU_HTTP_MAX_MB || 200);
  if (st.size > maxMb * 1024 * 1024) {
    lastMineruHttpWhy = `file ${Math.round(st.size / 1024 / 1024)} MB exceeds MINERU_HTTP_MAX_MB=${maxMb}`;
    return null; // 大书每次重传代价高，本地 CLI 更快
  }
  // 散页先按连续段拆开、逐段请求：API 的 page_range 只能表达一个区间，整段发会连带跑中间页
  // （36,193,222 拿首尾算会变成 187 页、被下面的守卫误拒——2026-11-25 LB 实测踩到）。
  const segments = splitConsecutivePages(nums);
  if (segments.length > 1) {
    const merged = [];
    for (const seg of segments) {
      const part = await mineruHttpPages(pdfAbs, seg, apiUrl, outDir, opts);
      // 任一段失败就整体交给上层兜底：混着返回会让调用方以为整批都成了
      if (!Array.isArray(part) || !part.length) return null;
      merged.push(...part);
    }
    lastMineruHttpWhy = '';
    return merged;
  }
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const span = hi - lo + 1;
  // 单段仍要判跨度：直调耗时 ≈ 1 秒上传 + 页数×0.8 秒；CLI ≈ 7 秒冷启动 + 每页 7.4 秒 —— span 大到不划算才交给 CLI。
  if (span > 40 || span > Math.max(8 + nums.length * 8, 12)) {
    lastMineruHttpWhy = `page span p${lo}-${hi} (${span} pages) is too wide for the HTTP channel`;
    return null;
  }
  let buf;
  try {
    buf = fs.readFileSync(pdfAbs);
  } catch (e) {
    lastMineruHttpWhy = `readFileSync failed: ${e?.message || e} (${pdfAbs})`;
    return null;
  }
  const fd = new FormData();
  // 4.x 的字段与 3.x 完全不同：单个 file、tier/ocr_mode/page_range/output_formats，
  // 不再有 backend / lang_list / parse_method / return_* / formula_enable / table_enable。
  fd.append('file', new Blob([buf], { type: 'application/pdf' }), path.basename(pdfAbs));
  // 档位优先级：mineru-tier.txt > MINERU_TIER 环境变量 > standard（见 readMineruTier）。
  // opts.tier 用于「按页自动分档」：主档跑完后对只有图没有字的页用 advanced 补跑（见 mineruHttpPagesAuto）。
  // flash < basic < standard < advanced；实测单页成本 standard 1.16 s、advanced 2.13 s、在线 ≈2.56 s。
  fd.append('tier', opts.tier || readMineruTier());
  fd.append('ocr_mode', 'auto');
  fd.append('output_formats', 'default'); // 只要 zip（里面是 structured_content.json + images/ + markdown.md）
  // ⚠️ 4.x 的 page_range 是 **1-based** 字符串（实测传 "1-3" 回 3 页、page_idx 从 0 开始）：
  // 3.x 那两个 start_page_id/end_page_id（0-based）已经不存在了，别再按老写法传。
  fd.append('page_range', `${lo}-${hi}`);
  const t0 = Date.now();
  // 4.x 的同步口子在 file-parse-server（默认 18001）；api-server 的 18000 只有异步 /v1/tasks。
  const fpBase = (
    process.env.MINERU_FP_URL || `http://${new URL(apiUrl).hostname}:${MINERU_FP_PORT}`
  ).replace(/\/$/, '');
  let zipBuf;
  try {
    const res = await fetch(new URL('/v1/file_parse', fpBase).href, {
      method: 'POST',
      body: fd,
      signal: AbortSignal.timeout(900000),
    });
    // 200 + application/zip 是正常路径；202 是 StatusResponse（任务还没跑完），这里不轮询、交回调用方
    if (!res.ok) {
      lastMineruHttpWhy = `HTTP ${res.status} from ${fpBase}/v1/file_parse`;
      return null;
    }
    if (!/zip/i.test(String(res.headers.get('content-type') || ''))) {
      lastMineruHttpWhy = `content-type ${res.headers.get('content-type')} (expected zip) from ${fpBase}`;
      return null;
    }
    zipBuf = Buffer.from(await res.arrayBuffer());
    lastMineruHttpWhy = '';
  } catch (e) {
    lastMineruHttpWhy = `fetch failed: ${String(e?.message || e)} (${fpBase})`;
    return null;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineru4-'));
  try {
    const zipPath = path.join(tmpDir, 'result.zip');
    fs.writeFileSync(zipPath, zipBuf);
    // Node 没有内置 zip 解压；Windows 10+ 自带的 bsdtar（System32\tar.exe）能直接解开 zip
    const un = spawnSync('tar', ['-xf', zipPath, '-C', tmpDir], { encoding: 'utf8', timeout: 120000 });
    if (un.status !== 0) {
      // 解 zip 失败也要落原因：宿主进程的 PATH 可能没有 System32，tar 直接 ENOENT（status=null）
      lastMineruHttpWhy =
        `tar -xf failed (status ${un.status === null ? 'null/ENOENT' : un.status}` +
        `${un.error ? `, ${un.error.message}` : ''}): ${String(un.stderr || '').trim().slice(-200) || '(no stderr)'}` +
        `；zip ${zipBuf.length} B`;
      return null;
    }
    const scPath = path.join(tmpDir, 'structured_content.json');
    if (!fs.existsSync(scPath)) {
      let entries = '';
      try {
        entries = fs.readdirSync(tmpDir).join(',');
      } catch {
        entries = '?';
      }
      lastMineruHttpWhy = `structured_content.json missing after tar; tmpDir entries: [${entries}]`;
      return null;
    }
    const sc = JSON.parse(fs.readFileSync(scPath, 'utf8'));
    const pages = Array.isArray(sc.pages) ? sc.pages : [];
    if (!pages.length) {
      lastMineruHttpWhy =
        `structured_content.json has 0 pages (asked p${lo}-${hi}, ` +
        `top-level keys: [${Object.keys(sc || {}).join(',')}])`;
      return null;
    }
    const allBlocks = pages.flatMap((pg) => (Array.isArray(pg.blocks) ? pg.blocks : []));
    // 图片：4.x 给的是 zip 内相对路径（如 images/page_0_equation_4.jpg），不再是 base64 data URI
    const imgFiles = {};
    if (opts.withImages && outDir) {
      const imgDir = path.join(outDir, 'images');
      try {
        fs.mkdirSync(imgDir, { recursive: true });
        for (const b of allBlocks) {
          const rel = b && b.image_source;
          if (!rel || typeof rel !== 'string') continue;
          const src = path.join(tmpDir, rel.split('/').join(path.sep));
          if (!fs.existsSync(src)) continue;
          const safe = path.basename(rel).replace(/[^\w.-]+/g, '_');
          const absImg = path.join(imgDir, safe);
          fs.copyFileSync(src, absImg);
          imgFiles[rel] = absImg;
          imgFiles[safe] = absImg;
        }
      } catch {
        /* 图片落地失败不影响正文 */
      }
    }
    if (opts.withImages && !Object.keys(imgFiles).length) {
      const hasFigure = allBlocks.some((b) => b && (b.type === 'figure' || b.type === 'image'));
      process.stderr.write(
        `[mineru] withImages=true but the API returned 0 images for p${lo}-${hi}` +
          `${hasFigure ? ' (page has figure blocks)' : ''}; ` +
          'figure paths stay inside the result zip. Try doc_render for the page instead.\n',
      );
    }
    const byPage = new Map();
    for (const pg of pages) {
      const idx = Number(pg.page_idx);
      if (!Number.isFinite(idx)) continue;
      // page_idx 是文档内的 **绝对 0-based 页号**，不是相对 page_range 起点的偏移：
      // 实测 page_range="1-3" 回 [0,1,2]（恰好等于绝对页号）、"36-36" 回 [35]。
      // 2026-11-26 踩过：按 lo + idx 算会把第 36 页映射成第 71 页，所有页都对不上、报「没能解析」。
      const pnum = idx + 1;
      if (!nums.includes(pnum)) continue;
      for (const it of Array.isArray(pg.blocks) ? pg.blocks : []) {
        const tp = it.type || 'text';
        // 4.x 把 3.x 的 text / latex / table_body / image_caption 统一成一个 content 字段
        const body = String(it.content == null ? '' : it.content).trim();
        let chunk = '';
        let md = '';
        let imgFile = '';
        if (tp === 'equation') {
          if (body && !body.startsWith('$$')) {
            chunk = '$$\n' + body + '\n$$';
            md = chunk;
          } else {
            chunk = body;
            md = body;
          }
        } else if (tp === 'table') {
          chunk = body;
          md = chunk;
        } else if (tp === 'image' || tp === 'figure') {
          const ref = it.image_source || '';
          imgFile = imgFiles[ref] || imgFiles[path.basename(String(ref))] || '';
          // 图没导出时不要写 markdown 图片语法：悬空路径会让读者以为能直接打开。
          chunk = imgFile
            ? `![${body || path.basename(String(ref))}](${imgFile})`
            : `[figure${body ? ': ' + body : ''}${ref ? ` — ${ref} (not extracted; re-run with withImages=true)` : ''}]`;
          md = chunk;
        } else if (tp === 'chart') {
          // 4.x 的 chart 块：advanced 档 content 是 markdown 表格/图内文字，standard 档多半为空。
          // 空 content 不能丢（以前走 else 分支 → chunk='' → continue 丢块 → 整页 0 块 → 被上层判成解析失败），
          // 2026-11-26 实测 p193/p222 就是这样连块都留不下来、advanced 的 227/330 字表格永远补不到。
          const ref = it.image_source || '';
          imgFile = imgFiles[ref] || imgFiles[path.basename(String(ref))] || '';
          chunk = body
            ? body
            : imgFile
              ? `![${path.basename(String(ref))}](${imgFile})`
              : `[chart${ref ? ` — ${ref} (not extracted; re-run with withImages=true)` : ''}]`;
          md = chunk;
        } else {
          chunk = body;
          md = chunk;
        }
        if (!chunk) continue;
        if (!byPage.has(pnum)) byPage.set(pnum, { chunks: [], md: [], blocks: [] });
        const acc = byPage.get(pnum);
        acc.chunks.push(chunk);
        acc.md.push(md);
        acc.blocks.push({
          type: tp,
          label: MINERU_LABEL[tp] || 'Text',
          // 2026-11-22：原 slice(0,4000) 会把长表从标签中间截断、行列静默丢失，改为存全文
          text: chunk,
          ...(imgFile ? { img_file: imgFile } : {}),
        });
      }
    }
    if (!byPage.size) {
      lastMineruHttpWhy =
        `parsed ${pages.length} page(s) but none carried text for p${lo}-${hi} ` +
        `(page_idx range: ${pages.map((p) => p.page_idx).join(',') || 'none'})`;
      // 不再返回 null：整页图/图表页在主档下可能真的一块都留不下来（standard 的 chart content 为空）。
      // 返回空记录让上层走「空页重试」，也让自动分档把这类页挑出来补 advanced —— 2026-11-26 修（P1）。
      return nums.map(() => ({ text: '', confidence: null, markdown: '', blocks: [] }));
    }
    process.stderr.write(
      `[mineru] http direct p${lo}-${hi} ${((Date.now() - t0) / 1000).toFixed(1)}s (4.x zip)\n`,
    );
    return nums.map((n) => {
      const p = byPage.get(n);
      if (!p) return { text: '', confidence: 0, markdown: '', blocks: [] };
      const t = p.chunks.join('\n\n');
      // MinerU 不返回置信度：以前这里硬编码 95，页头的「ocr 95%」是编的。改记 null，输出时显示引擎名。
      return { text: t, confidence: null, markdown: p.md.join('\n\n'), blocks: p.blocks };
    });
  } catch (e) {
    // 解压后的 JSON 解析、块归并等任何异常也要落原因：只往上层冒泡的话，上层只会记一句 failed
    lastMineruHttpWhy = `post-process failed: ${e?.message || e}`;
    return null;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// 按页自动分档：主档跑完，把「只有图、没有文字块」的页挑出来用 advanced 补跑一次。
// 依据 2026-11-26 实测（50 页样本，LB 与本地两侧都验过）：standard 单页 1.16 s、与在线 0.902 相似；
// advanced 2.13 s，但在整页图/图表上独有图注与图内文字（standard 与在线都只给空 image 块）。
// 所以默认走主档，只对这类页付第二次成本。
// 「真文字」口径：图片/chart 的占位符与 VLM 图片描述不算正文。
// 2026-11-26 实测 p20：advanced 的真文字 0→0，却多出 964 字符英文描述（"Simple diagram of concentric circles…"），
// 按纯长度比会被当成升级、把零信息的描述写进页文本（P2）。
// 2026-11-26 缺陷测试 BT-OCR-01：`withImages=true` 时占位符会变成 markdown 图片链接
// `![page_221_chart_0.jpg](path)`，以 `![` 开头而不是 `[`，旧正则 /^\[(figure|chart)/ 匹配不上，
// 图表页于是被判成「有真文字」、拿不到 advanced 补跑（p222 从 3 张表退化成 4 条图片链接）。
const AUTO_TIER_PLACEHOLDER = /^(!\[|\[(figure|chart))/;
function realTextOf(r) {
  const blocks = Array.isArray(r?.blocks) ? r.blocks : [];
  let s = '';
  for (const b of blocks) {
    if (!b) continue;
    const tp = b.type || '';
    // BT-OCR-01 的反向误升级：图片块的 text 在 withImages 时是 VLM 写的英文描述（"Simple diagram of
    // concentric circles…"），按块类型直接跳过，不让它充当「真文字」把纯图页升上去（p20 842→1887）。
    if (tp === 'image' || tp === 'figure') continue;
    const t = String(b.text || '');
    if (!t || AUTO_TIER_PLACEHOLDER.test(t)) continue;
    s += t;
  }
  return s;
}

// 该页是不是「没有真文字」：页码/页眉/页脚不算文字，image/figure 以及 content 为空的 chart 只是图。
// blocks 为空也算——整页图在主档下可能一块都留不下来（P1：standard 的 chart content 为空会被丢块）。
const AUTO_TIER_META = new Set(['page_number', 'header', 'footer']);
function isNoRealText(r) {
  const blocks = Array.isArray(r?.blocks) ? r.blocks : [];
  for (const b of blocks) {
    if (!b) continue;
    const tp = b.type || '';
    if (AUTO_TIER_META.has(tp)) continue;
    if (tp === 'image' || tp === 'figure') continue;
    const t = String(b.text || '');
    if (!t || AUTO_TIER_PLACEHOLDER.test(t)) continue; // 空 chart 也只是张图
    return false;
  }
  return true;
}

async function mineruHttpPagesAuto(pdfAbs, nums, apiUrl, outDir, opts = {}) {
  const mainTier = opts.tier || readMineruTier();
  const main = await mineruHttpPages(pdfAbs, nums, apiUrl, outDir, { ...opts, tier: mainTier });
  if (!main) return null;
  // 主档已经是 advanced、或调用方显式关掉（`opts.autoTier === false` 或 `MINERU_AUTO_TIER=0`），就不补
  const envOff = ['0', 'false', 'off', 'no'].includes(
    String(process.env.MINERU_AUTO_TIER || '').trim().toLowerCase(),
  );
  if (mainTier === 'advanced' || opts.autoTier === false || envOff) return main;
  const candidates = [];
  nums.forEach((n, i) => {
    if (isNoRealText(main[i])) candidates.push(n);
  });
  if (!candidates.length) return main;
  process.stderr.write(
    `[mineru] auto-tier: ${candidates.length} no-text page(s) of ${nums.length} get an advanced pass ` +
      `(p${candidates.join(',p')})\n`,
  );
  // 候选页可能分散，按连续段逐段补跑；任何一段失败都保留主档结果，不因此让整批失败
  const merged = main.slice();
  let upgraded = 0;
  for (const seg of splitConsecutivePages(candidates)) {
    let adv = null;
    try {
      adv = await mineruHttpPages(pdfAbs, seg, apiUrl, outDir, { ...opts, tier: 'advanced' });
    } catch {
      adv = null;
    }
    if (!adv) {
      process.stderr.write(
        `[mineru] auto-tier: advanced pass failed for p${seg.join(',p')}, keeping ${mainTier} result` +
          `${lastMineruHttpWhy ? ` (${lastMineruHttpWhy})` : ''}\n`,
      );
      continue;
    }
    seg.forEach((n, j) => {
      const idx = nums.indexOf(n);
      if (idx < 0) return;
      const page = adv[j];
      // 只有真文字变多才替换：advanced 也常在这类页上「没字但有描述」，那种保留主档（P2）
      if (!page) return;
      if (realTextOf(page).length > realTextOf(merged[idx]).length) {
        merged[idx] = { ...page, tier: 'advanced' };
        upgraded += 1;
      }
    });
  }
  if (upgraded) {
    process.stderr.write(`[mineru] auto-tier: ${upgraded} page(s) upgraded to advanced\n`);
  }
  return merged;
}

async function ocrMineruPages(pdfAbs, nums, outDir, opts = {}) {
  const venv = process.env.MINERU_VENV || 'C:\\deepseek\\tools\\mineru4-venv';
  const py = path.join(venv, 'Scripts', 'python.exe');
  const script = path.join(here, 'ocr_mineru.py');
  if (!fs.existsSync(py)) throw new Error(`mineru venv not found: ${py}`);
  // 有常驻服务就复用（单页 ~9 秒），没起就拉一次；探不通则传空串，由 python 走临时服务（~50 秒）
  let apiUrl = (process.env.MINERU_API_URL || MINERU_API_DEFAULT).trim();
  if (apiUrl) {
    let alive = await apiPortOpen(apiUrl);
    if (!alive && !mineruApiTried && process.env.MINERU_API_AUTOSTART !== '0') {
      mineruApiTried = true;
      alive = await startMineruApi(apiUrl);
    }
    if (!alive) {
      // 服务探不通时也要落原因：否则闸门只会说「没能解析」，看不出是端口没起（2026-11-25 排查时 why 为空）
      lastMineruHttpWhy = `api port not reachable: ${apiUrl} (MINERU_API_URL / MINERU_API_DEFAULT); HTTP channel skipped`;
      apiUrl = '';
    }
  }
  // 先试 HTTP 直调（实测单页 1.4 秒）；服务不通、文件过大、跨度过大或返回异常都返回 null，落到下面的 CLI 路径。
  // 走 mineruHttpPagesAuto：主档跑完对「只有图没有字」的页自动补一次 advanced（autoTier:false 可关）。
  if (apiUrl) {
    const fast = await mineruHttpPagesAuto(pdfAbs, nums, apiUrl, outDir, opts);
    if (fast) return fast;
  }
  // 闸门必须放在 HTTP 通道「试过并失败」之后：放在前面会把本可以走通的通道直接堵死（2026-11-25 踩过）。
  // 4.x 的 CLI 参数与 3.x 完全不同（ocr_mineru.py 是按 3.x 的 mineru.exe 写的），不给假兜底。
  if (fs.existsSync(path.join(venv, 'Scripts', 'mineru-kit.exe'))) {
    // 2026-11-26 缺陷测试 E1/E2：原来固定列四类原因，但 ③「整页图」在这条路径上不可达
    // （:489 起 0 块页不再返回 null），④「端口没在跑」在端口通、HTTP 报 4xx 时也照列 ——
    // 两处都把排查引向错误方向。现在按 lastMineruHttpWhy 的实际内容只列命中的那几类。
    const why = lastMineruHttpWhy || '<未记录>';
    const hints = [];
    if (/exceeds MINERU_HTTP_MAX_MB|too large|MB exceeds/i.test(why)) {
      hints.push('整本文件超过 MINERU_HTTP_MAX_MB —— 这是内存限制（multipart 要把整本读进内存），与「这次要解析几页」无关；可切体积或调大阈值');
    }
    if (/page span|too wide|span p/i.test(why)) {
      hints.push('某一段连续页跨度超过 40 页 —— splitConsecutivePages 已拆过，仍超说明这段本身太长；拆成更小的 pages 再试');
    }
    if (/port not reachable|HTTP channel skipped/i.test(why)) {
      hints.push('服务没在跑 —— mineru-api(18000) 与 mineru-kit file-parse-server(18001) 至少一个没起；这两个端口通了再看下面的 HTTP 状态');
    }
    if (/HTTP \d{3}|content-type|zip/i.test(why)) {
      hints.push('服务回了错误状态或不是 zip —— 端口是通的，问题在服务端（看上面的状态码/content-type 原文）');
    }
    if (!hints.length) {
      hints.push('没有可归类的具体原因，直接看上面的「本次失败原因」原文');
    }
    throw new Error(
      'MinerU 4.x：同步通道（/v1/file_parse）没能解析这段页码，CLI 兜底尚未按 4.x 重写。' +
        `本次失败原因：${why}；参数 pages=${fmtRanges(nums)}，api=${apiUrl || '(空)'}。` +
        '按这次的实际原因，命中以下几类：' +
        hints.map((h, i) => `${i + 1}) ${h}`).join('；'),
    );
  }
  const tmpOut = path.join(outDir, `.mineru-${process.pid}-${Date.now()}.json`);
  const run = spawnSync(py, [script, pdfAbs, nums.join(','), tmpOut, 'ch'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      MINERU_MODEL_SOURCE: 'modelscope',
      MINERU_API_URL: apiUrl,
    },
    timeout: 1800000,
  });
  if (run.status !== 0 || !fs.existsSync(tmpOut)) {
    // stderr 尾巴带出来：能看到 python 侧的 api 探活/回退提示，不再是「exit 1」黑盒
    const tail = String(run.stderr || '').trim().slice(-400);
    throw new Error(`mineru failed (exit ${run.status})${tail ? `: ${tail}` : ''}`);
  }
  const data = JSON.parse(fs.readFileSync(tmpOut, 'utf8'));
  try {
    fs.rmSync(tmpOut, { force: true });
  } catch {
    /* ignore */
  }
  return nums.map((n) => {
    const p = data.pages && data.pages[String(n)];
    const t = (p && p.text) || '';
    const md = (p && p.markdown) || t;
    const bl = (p && Array.isArray(p.blocks)) ? p.blocks : [];
    return { text: t, confidence: t ? null : 0, markdown: md, blocks: bl };
  });
}

/**
 * 伪文本层粗判：返回「常见字符」占比（0–1）。
 * 扫描件被别的 OCR 软件跑过之后会留下一层垃圾文本（乱码、替换字符、私用区字符），
 * 字数够多（≥40）但不是真文本层——直接当文本层返回会给用户一堆乱码还判 100% 置信度。
 */
/**
 * MinerU 分块调度：①进度落盘（整本几百页时不再干等）；②整批失败时逐页重试，
 * 把具体哪几页失败报出来（以前只有一句 batch failed，排查要重跑）。
 */
async function mineruBatch(abs, nums, outDir, opts = {}) {
  // 2026-11-11 实测：MinerU 一次 40 页时常「返回 200 但内容只到一半」，10 页一批最稳；
  // 想更激进可以用 MINERU_CHUNK 调大，但超大书建议保持 10 并配合空页重试。
  const CHUNK = Math.max(1, Math.min(40, Number(process.env.MINERU_CHUNK) || 10));
  const results = new Array(nums.length).fill(null);
  const failed = [];
  const progressFile = path.join(outDir, 'progress.json');
  const startedAt = Date.now();
  const writeProgress = (done, note) => {
    const snap = {
      schema: CACHE_SCHEMA,
      pdf: abs,
      total: nums.length,
      done,
      failed: failed.map((f) => f.page),
      note: note || '',
      startedAt,
      updatedAt: Date.now(),
    };
    try {
      writeJson(progressFile, snap);
    } catch {
      /* 进度只是旁路信息 */
    }
    // 侧栏进度条读这份内存快照；跑完后再留一分钟，让前端看到 100% 而不是突然消失。
    try {
      OCR_PROGRESS.set(outDir, { ...snap, cacheDir: outDir });
      if (done >= nums.length) {
        // 2026-11-17 修：定时器必须先确认「这条记录还是我写的那条」再删。
        // 原先无条件 delete(outDir)，同一份 PDF 先后跑两次（或 doc_tables 后来又调一次）时，
        // 前一次的定时器会把后一次正在跑的记录一起删掉——表现就是进度条跑一会儿突然消失。
        const stamp = startedAt;
        const timer = setTimeout(() => {
          const cur = OCR_PROGRESS.get(outDir);
          if (cur && cur.startedAt === stamp && cur.done >= cur.total) OCR_PROGRESS.delete(outDir);
        }, PROGRESS_TTL_AFTER_DONE_MS);
        if (typeof timer.unref === 'function') timer.unref();
      }
    } catch {
      /* 旁路 */
    }
  };
  // 在线通道：MINERU_MODE=online 且有 token 时，整本一次性提交（结果按页写缓存）。
  // 本地 MinerU 仍是默认；在线用于「不想占 GPU」或本地服务起不来的时候。
  // 在线通道：MINERU_MODE=online 强制走；未设且本地 venv 不存在时有 token 就走在线；
  // MINERU_MODE=local 强制本地。本地 MinerU 仍是默认。
  //
  // 2026-11-25：改成「文件优先、环境变量兜底」。
  // 起因：Windows 改用户级环境变量只写注册表、不刷新已运行的 explorer，宿主重启后继承的
  // 仍是旧快照——当天 23:15 明明改成了 local，23:19 重启后进程里读到的还是 online，
  // 差一步就把 PDF 又传上去了。文件每次调用重读，改完下一次 doc_ocr 即生效，不必重启宿主。
  const mineruModeFile =
    process.env.MINERU_MODE_FILE || 'C:\\deepseek\\tools\\dsh-doc-parser\\mineru-mode.txt';
  // 2026-11-26 缺陷测试 C1：这个文件是「隐私开关」，旧实现值不认识就静默回落 MINERU_MODE，
  // 而环境变量在 Windows 上是宿主进程的旧快照、可能仍是 online —— 差一步就把 PDF 传上去。
  // 现在 fail-closed：文件存在但内容不是 local/online（含空文件）直接报错，不再回落。
  const readMineruMode = () => {
    let exists = false;
    let raw = '';
    try {
      raw = String(fs.readFileSync(mineruModeFile, 'utf8')).trim();
      exists = true;
    } catch {
      /* 文件不存在 → 走环境变量 */
    }
    if (exists) {
      const v = raw.toLowerCase();
      if (v === 'local' || v === 'online') return v;
      throw new Error(
        `mineru-mode.txt 的内容 ${raw ? `"${raw}"` : '（空）'} 不是 local 或 online（文件：${mineruModeFile}）。` +
          '为避免误上传，此处不回落 MINERU_MODE；请把文件内容改成 local（不上传）或 online（上传到 mineru.net）。',
      );
    }
    const env = String(process.env.MINERU_MODE || '').trim().toLowerCase();
    if (!env) return ''; // 未设 → 自动：本地 venv 在就在本地，不在且有 token 才走在线
    if (env === 'local' || env === 'online') return env;
    throw new Error(
      `MINERU_MODE="${env}" 不是 local 或 online；请改成 local 或 online，或直接写 ${mineruModeFile}。`,
    );
  };
  const mineruMode = readMineruMode();
  const localVenv = process.env.MINERU_VENV || 'C:\\deepseek\\tools\\mineru4-venv';
  const wantOnline =
    mineruOnlineReady() &&
    (mineruMode === 'online' ||
      (mineruMode !== 'local' && !fs.existsSync(path.join(localVenv, 'Scripts', 'python.exe'))));
  // 2026-11-22：这两种切换原来完全静默——用户既不知道降级了，也不知道整份 PDF 被上传了
  if (mineruMode === 'online' && !mineruOnlineReady()) {
    writeProgress(0, 'MINERU_MODE=online but MINERU_API_TOKEN is missing; falling back to local MinerU');
  } else if (mineruMode !== 'online' && mineruMode !== 'local' && wantOnline) {
    writeProgress(0, `online: uploading the PDF to mineru.net (write "local" to ${mineruModeFile} or set MINERU_MODE=local to keep it on this machine)`);
  }
  if (wantOnline) {
    writeProgress(0, 'online submitting');
    const online = await mineruOnlineRun(
      abs,
      nums,
      outDir,
      { ...opts, lang: 'ch' },
      // 2026-11-17 修：原先这里把 done 写死 0 —— 在线通道整段解析期间进度条永远 0%，
      // 只有跑完那一刻跳到 100%。现在接住 mineru.net 报的 extracted_pages。
      (info) => writeProgress(Math.max(0, Math.min(nums.length, Number(info.done) || 0)), info.note || 'online'),
    );
    const got = online.results.filter(Boolean);
    if (got.length) writeMineruPageCache(got, outDir, opts.lang || DEFAULT_LANG, opts.withImages === true);
    for (const f of online.failed) failed.push(f);
    writeProgress(got.length, online.failed.length ? `${online.failed.length} page(s) failed` : 'done');
    return { results: online.results, failed };
  }
  writeProgress(0, 'started');
  for (let i = 0; i < nums.length; i += CHUNK) {
    const slice = nums.slice(i, i + CHUNK);
    let part = null;
    try {
      part = await ocrMineruPages(abs, slice, outDir, opts);
    } catch (err) {
      if (slice.length > 1) {
        process.stderr.write(
          `[mineru] chunk p${slice[0]}-p${slice[slice.length - 1]} failed: ${String(err?.message || err).slice(0, 160)}; retrying page by page\n`,
        );
      }
      part = [];
      for (const n of slice) {
        try {
          const one = await ocrMineruPages(abs, [n], outDir, opts);
          part.push(one[0]);
        } catch (e2) {
          failed.push({ page: n, error: String(e2?.message || e2).slice(0, 200) });
          part.push(null);
        }
      }
    }
    // MinerU 偶尔返回 200，但某些页是空的（批量被服务端截断、单页解析失败）。
    // 以前这些空记录被当成「这页没字」静默写进结果——整本几百页时表现为「跑完了却少一半」。
    // 这里挑出来逐页重试一次；仍然空就记 failed，让调用方明确知道哪几页没成。
    if (part && part.length > 1) {
      const emptyAt = [];
      part.forEach((r, k) => {
        // null = 上面逐页重试时已经失败过，别再请求一次：
        // 2026-11-26 实测 4 页散页跑了 12 次 121 MB 上传、28 秒，源头就是这里把 null 也当空页重试（P5）
        if (r === null) return;
        const hasText = !!(r && String(r.text || '').trim());
        const hasBlocks = !!(r && Array.isArray(r.blocks) && r.blocks.length);
        if (!hasText && !hasBlocks) emptyAt.push(k);
      });
      if (emptyAt.length) {
        process.stderr.write(
          `[mineru] ${emptyAt.length}/${slice.length} page(s) came back empty (batch likely truncated); retrying page by page\n`,
        );
        for (const k of emptyAt) {
          const n = slice[k];
          try {
            const one = await ocrMineruPages(abs, [n], outDir, opts);
            const rec = one && one[0];
            const ok =
              rec && (String(rec.text || '').trim() || (Array.isArray(rec.blocks) && rec.blocks.length));
            if (ok) {
              part[k] = rec;
            } else {
              part[k] = null;
              // 服务返回了、但这一页 0 块 = 整页图（曲线图/相图，只有轴标签与图注），不是解析失败。
              // 2026-11-26 按用户拍板单独记一类：混在 failed 里会让人去切小 PDF、查服务，白跑。
              failed.push({ page: n, error: 'no text on this page (figure-only)', figureOnly: true });
            }
          } catch (e2) {
            part[k] = null;
            failed.push({ page: n, error: `empty, retry failed: ${String(e2?.message || e2).slice(0, 160)}` });
          }
        }
      }
    }
    (part || []).forEach((r, k) => {
      if (r) results[i + k] = { ...r, num: nums[i + k] };
    });
    writeProgress(Math.min(i + CHUNK, nums.length));
  }
  // 同一页可能在「chunk 失败后逐页重试」与「空页重试」两处各记一次（P5 实测 p193/p222 各有两条 failed），
  // 按 page 去重、保留最后一条，避免同一个问题在报告里出现两次、也避免失败计数翻倍
  const seenFailed = new Map();
  for (const f of failed) seenFailed.set(f.page, f);
  const deduped = [...seenFailed.values()];
  writeProgress(nums.length, deduped.length ? `${deduped.length} page(s) failed` : 'done');
  return { results, failed: deduped };
}

/**
 * 把 MinerU 批量结果写回页缓存（prefetch 与 doc_tables 共用）。
 * 2026-11-09 测试发现：prefetch 直接把 {results} 丢掉，进度显示完成、页缓存一个文件都没有。
 */
function writeMineruPageCache(results, outDir, lang, withImages) {
  let written = 0;
  for (const rec of results || []) {
    const num = Number(rec && rec.num);
    if (!Number.isFinite(num) || num < 1) continue;
    if (!Array.isArray(rec.blocks) || !rec.blocks.length) continue;
    const cacheFile = path.join(outDir, `p${String(num).padStart(3, '0')}.json`);
    try {
      writeJson(cacheFile, {
        schema: CACHE_SCHEMA,
        num,
        lang,
        engine: 'mineru',
        ...(rec.via ? { via: rec.via } : {}),
        // 记下这页是哪个档位产出的。命中缓存时 doc_ocr 目前不看它（P3 未修：缓存键不含 tier），
        // 但排查「为什么这页图注没升级」时这是唯一线索（0.3.9 加）
        ...(rec.tier ? { tier: rec.tier } : {}),
        text: rec.text || '',
        confidence: rec.confidence == null ? null : rec.confidence,
        markdown: rec.markdown || rec.text || '',
        blocks: rec.blocks,
        withImages: withImages === true,
      });
      written += 1;
    } catch {
      /* 缓存写失败不影响本次输出 */
    }
  }
  return written;
}

function textLayerScore(s) {
  const t = String(s || '').replace(/\s+/g, '');
  if (!t) return 0;
  let good = 0;
  for (const ch of t) {
    const c = ch.codePointAt(0);
    const ok =
      (c >= 0x4e00 && c <= 0x9fff) || // 汉字
      (c >= 0x20 && c <= 0x7e) || // 可打印 ASCII
      (c >= 0x3000 && c <= 0x303f) || // 中文标点
      (c >= 0x370 && c <= 0x3ff) || // 希腊字母
      (c >= 0x2000 && c <= 0x22ff) || // 常用符号与数学运算符
      (c >= 0xff00 && c <= 0xffef); // 全角字符
    if (ok) good += 1;
  }
  return good / t.length;
}

function text(value) {
  return [{ type: 'text', text: String(value) }];
}

function prepare(file, create = true) {
  if (!file || typeof file !== 'string') throw new Error('path is required');
  const abs = path.resolve(file);
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error(`file not found: ${file}`);
  }
  if (!st.isFile()) throw new Error(`not a file: ${file}`);
  if (st.size > MAX_BYTES) throw new Error(`file too large (${st.size} bytes > ${MAX_BYTES})`);
  const hash = sha256Cached(abs);
  const dir = cacheDirFor(hash, create); // cacheAction=stats 不该顺手建目录
  return { abs, st, hash, dir };
}

/** 有并发上限的 map：pdf.js 取文本/渲染是 IO + 解析，串行跑几百页纯等。 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const k = cursor++;
      if (k >= items.length) return;
      out[k] = await fn(items[k], k);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 页缓存结构版本：加字段时 +1，读的时候只拒绝「比本插件还新」的记录。 */
const CACHE_SCHEMA = 2;

/** 后台预跑任务表（prefetch=true）：同一次宿主生命周期内避免重复排队。 */
const PREFETCH = new Map();

function clamp(textValue, limit = DEFAULT_MAX_CHARS) {
  const s = String(textValue ?? '');
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `\n[note: output truncated at ${limit} chars; use pages="N-M" to continue]`;
}

/**
 * 按页边界截断（2026-11-11 实测踩坑：40 页请求被字符级 slice 砍到约 12 页，
 * 后面的页静默消失，只有末尾一行小字提示，很容易被当成「已经跑完」）。
 * 规则：①只在页与页之间切，不把某页正文切成两半；②提示放**开头**，写明返回了哪些页、
 * 还剩哪些页、怎么续跑；③只有单页就超预算时才退化成字符级截断。
 */
function clampByPages(blocks, limit, nums) {
  const list = (blocks || []).map((b) => String(b ?? ''));
  const pages = (nums || []).map(Number);
  if (!list.length) return '';
  const whole = list.join('\n\n');
  if (whole.length <= limit) return whole;
  const keep = [];
  let used = 0;
  for (let i = 0; i < list.length; i += 1) {
    const add = (keep.length ? 2 : 0) + list[i].length;
    // 预留约 180 字符给开头的提示，避免正文把提示挤掉
    if (used + add > limit - 180) break;
    keep.push(list[i]);
    used += add;
  }
  // 2026-11-26 缺陷测试 P-01：limit 小于「提示预留 + 第一页」时，旧写法直接退化成
  // `clamp(list[0], limit)` —— 只返回第一页、连一行提示都没有，调用方会当成整批已返回。
  // 现在即使一页都放不下，也先说清只返回了哪页、其余在哪、怎么续跑。
  if (!keep.length) {
    const head =
      `[pages ${fmtRanges(pages.slice(0, 1))} of ${fmtRanges(pages)} returned (1/${list.length}, ` +
      `content truncated to fit maxChars); ${list.length - 1} page(s) not shown — ` +
      `raise maxChars or call again with pages="${fmtRanges(pages.slice(1))}"]\n\n`;
    const budget = Math.max(0, limit - head.length);
    return head + clamp(list[0], budget);
  }
  const kept = pages.slice(0, keep.length);
  const rest = pages.slice(keep.length);
  const head =
    `[pages ${fmtRanges(kept)} of ${fmtRanges(pages)} returned (${keep.length}/${list.length}); ` +
    `${rest.length} page(s) not shown — call again with pages="${fmtRanges(rest)}"]\n\n`;
  let body = keep.join('\n\n');
  const budget = limit - head.length;
  if (body.length > budget) {
    body = body.slice(0, Math.max(0, budget - 32)) + '\n[page truncated]';
  }
  return head + body;
}

/** 缓存管理入口：以前缓存只能手动翻目录。 */
// 页码列表压成区间：1-300、1-5, 9, 12-20。逐页列出 300 个数字要 1.5K token，纯浪费。
function fmtRanges(nums) {
  const a = [...new Set((nums || []).map(Number).filter((n) => Number.isFinite(n)))].sort((x, y) => x - y);
  if (!a.length) return 'none';
  const out = [];
  let start = a[0];
  let prev = a[0];
  for (let i = 1; i < a.length; i += 1) {
    if (a[i] === prev + 1) {
      prev = a[i];
      continue;
    }
    out.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = a[i];
    prev = a[i];
  }
  out.push(start === prev ? `${start}` : `${start}-${prev}`);
  return out.join(', ');
}

function cacheAction(action, dir, confirmed) {
  const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
  const sizeOf = (d) => {
    let bytes = 0;
    let files = 0;
    const walk = (p) => {
      let items = [];
      try {
        items = fs.readdirSync(p, { withFileTypes: true });
      } catch {
        return;
      }
      for (const it of items) {
        const q = path.join(p, it.name);
        if (it.isDirectory()) walk(q);
        else {
          try {
            bytes += fs.statSync(q).size;
            files += 1;
          } catch {
            /* ignore */
          }
        }
      }
    };
    walk(d);
    return { bytes, files };
  };
  if (action === 'stats') {
    const me = sizeOf(dir);
    const all = sizeOf(dataRoot());
    const countIn = (sub, filter) => {
      const p = path.join(dir, sub);
      try {
        return fs.readdirSync(p).filter(filter).length;
      } catch {
        return 0;
      }
    };
    return [
      `cache dir: ${dir}`,
      `this pdf: ${mb(me.bytes)} / ${me.files} files`,
      `rendered page images: ${countIn('pages', () => true)}`,
      // progress.json 不是页记录，别算进来（2026-11-09 第二轮测试：报 13，实际 12）
      `ocr page records: ${countIn('ocr', (f) => /^p\d+\.json$/.test(f))}`,
      `all cached pdfs: ${mb(all.bytes)} / ${all.files} files under ${dataRoot()}`,
      'clear this pdf: cacheAction="clear" + confirm=true · global LRU: cacheAction="prune" + confirm=true (500 MB cap)',
    ].join('\n');
  }
  if (action === 'clear') {
    if (!confirmed) return `refusing to delete ${dir} — pass confirm=true (only this pdf cache is removed)`;
    const me = sizeOf(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    return `cleared ${dir} (${mb(me.bytes)} / ${me.files} files)`;
  }
  if (action === 'prune') {
    if (!confirmed) return 'refusing to prune the global cache — pass confirm=true (LRU down to 500 MB)';
    const removed = lruCleanup(500 * 1024 * 1024);
    return `pruned ${mb(removed)} from the global cache (cap 500 MB) under ${dataRoot()}`;
  }
  return `unknown cacheAction: ${action}`;
}

const pdfInfoTool = {
  name: 'doc_info',
  description:
    'Inspect a local PDF or Office file (docx/pptx/xlsx). PDF: page count, per-page size, text density and image count, scanned-page detection, metadata, outline. OOXML: slide/paragraph/sheet count, text volume, media files, tables, and whether formulas are MathType OLE objects. Use before reading a large or unknown file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path of the local PDF file.' },
      probeLimit: { type: 'integer', description: 'Max pages to probe (default 300).' },
      cacheAction: {
        type: 'string',
        enum: ['stats', 'clear', 'prune'],
        description:
          'Cache management instead of inspection: "stats" reports how much cache this PDF occupies plus the global total; "clear" deletes this PDF\'s cache (needs confirm=true); "prune" runs the global LRU cleanup down to 500 MB (needs confirm=true).',
      },
      confirm: { type: 'boolean', description: 'Required for cacheAction=clear|prune.' },
    },
    required: ['path'],
  },
  output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
  timeoutMs: 180000,
  async execute(args) {
    try {
      if (isOoxml(args.path)) {
        if (args.cacheAction) return 'cacheAction is only available for PDF files';
        return formatOoxmlInfo(path.resolve(args.path));
      }
      const { abs, dir } = prepare(args.path, !args.cacheAction);
      if (args.cacheAction) return cacheAction(String(args.cacheAction), dir, args.confirm === true);
      const cacheFile = path.join(dir, 'info.json');
      const wantLimit = Math.min(PROBE_CAP, Math.max(1, Number(args.probeLimit) || 300));
      let data = readJson(cacheFile);
      // probeLimit 必须进缓存键：否则一次浅探测（probeLimit:1）会把「全书只有 1 页是扫描页」永久钉死。
      if (data && Number(data.probeLimit || 0) < wantLimit && Number(data.pages) > Number(data.probeLimit || 0)) {
        data = null;
      }
      if (!data) {
        const doc = await loadPdf(abs);
        const total = doc.numPages;
        const limit = Math.min(total, wantLimit);
        // 探页并发 6 路：单页取文本 10–30 ms，300 页串行要 3–9 秒，并发后 1 秒内。
        const probeNums = Array.from({ length: limit }, (_, k) => k + 1);
        const pageStats = await mapLimit(probeNums, 6, (i) => probePage(doc, i));
        const scannedPages = pageStats.filter((s) => s.scanned).map((s) => s.num);
        const outlineAll = await outlineOf(doc);
        data = {
          pages: total,
          probeLimit: limit,
          metadata: await metadataOf(doc),
          // 2026-11-26 缺陷测试 P-02：旧写法只存 60 条、只显示 30 条且不提截断，一份 11,717 条
          // 大纲的 PDF 看起来像只有 30 条。现在存 200 条并记总数，显示时把「多少条没显示」写出来。
          outline: outlineAll.slice(0, 200),
          outlineTotal: outlineAll.length,
          scannedPages,
          pageStats,
        };
        writeJson(cacheFile, data);
      }
      const meta = Object.entries(data.metadata || {})
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => `${k}=${v !== null && typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(', ');
      const sp = data.scannedPages || [];
      const spText = !sp.length ? 'none' : sp.length === data.pages ? `all ${data.pages}` : fmtRanges(sp);
      const lines = [
        `path: ${abs}`,
        `pages: ${data.pages}`,
        `metadata: ${meta || '(none)'}`,
        `scanned pages: ${spText}${sp.length ? ` (${sp.length} page(s))` : ''}`,
      ];
      if (data.outline?.length) {
        const outlineTotal = Number.isFinite(data.outlineTotal) ? data.outlineTotal : data.outline.length;
        const shownOutline = data.outline.slice(0, 30);
        lines.push(
          outlineTotal > shownOutline.length
            ? `outline (showing ${shownOutline.length} of ${outlineTotal}):`
            : 'outline:',
        );
        for (const o of shownOutline) {
          lines.push(`  ${'  '.repeat(Math.min(o.depth || 0, 4))}[p${o.page ?? '?'}] ${o.title}`);
        }
        if (outlineTotal > shownOutline.length) {
          lines.push(
            `  … ${outlineTotal - shownOutline.length} more outline entr` +
              `${outlineTotal - shownOutline.length === 1 ? 'y' : 'ies'} not shown (doc_info caps at 200 in cache)`,
          );
        }
      }
      const scanned = data.scannedPages?.length ? data.scannedPages : [];
      const sample = (data.pageStats || []).slice(0, 5).map((p) => `p${p.num}: ${p.textChars} chars, ${p.images} img`);
      if (sample.length) lines.push('first pages: ' + sample.join(' | '));
      if (data.pageStats?.length && data.pageStats.length < data.pages) {
        lines.push(`[note: probed first ${data.pageStats.length} of ${data.pages} pages]`);
      }
      if (scanned.length) lines.push('hint: scanned pages have no text layer; use doc_ocr on them.');
      return lines.join('\n');
    } catch (err) {
      return 'error: ' + String(err?.message || err);
    }
  },
};

const pdfTextTool = {
  name: 'doc_text',
  description:
    'Extract text from a local PDF or Office file (docx/pptx/xlsx), per page/slide/sheet. Use pages like "1-3,5" for ranges. Optional withPosition adds per-line x/y coordinates and font size. Scanned pages have no text layer - use doc_ocr for those.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path of the local PDF file.' },
      pages: { type: 'string', description: 'Page selection like "1-3,5" or "all" (default all).' },
      withPosition: { type: 'boolean', description: 'Also return per-line coordinates.' },
      maxChars: {
        type: 'integer',
        description: 'Output cap in characters (default 12000; env PDF_MAX_CHARS overrides the default).',
      },
    },
    required: ['path'],
  },
  output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
  timeoutMs: 180000,
  async execute(args) {
    try {
      if (isOoxml(args.path)) return formatOoxmlText(path.resolve(args.path), args);
      const { abs } = prepare(args.path);
      const doc = await loadPdf(abs);
      const nums = parsePages(args.pages, doc.numPages);
      // 并发 4 路取页（保持页码顺序由 mapLimit 保证）
      const parts = await mapLimit(nums, 4, async (n) => {
        const p = await extractPage(doc, n, !!args.withPosition);
        let block = `========== PAGE ${p.num} ==========\n${p.text}`;
        if (p.lines?.length) {
          block +=
            '\n--- position ---\n' +
            p.lines.slice(0, 40).map((l) => `[x=${l.x} y=${l.y} ${l.size}pt] ${l.text}`).join('\n');
        }
        return { block, chars: String(p.text || '').trim().length };
      });
      if (!parts.length) {
        return `no pages matched pages="${args.pages}" (this PDF has ${doc.numPages} page(s))`;
      }
      if (parts.every((x) => x.chars === 0)) {
        return (
          `no text layer on pages="${args.pages || 'all'}" (${parts.length} page(s) matched, this PDF has ${doc.numPages}) — ` +
          'these pages are scanned; use doc_ocr for them'
        );
      }
      return clampByPages(parts.map((x) => x.block), Number(args.maxChars) > 0 ? Number(args.maxChars) : DEFAULT_MAX_CHARS, nums);
    } catch (err) {
      return 'error: ' + String(err?.message || err);
    }
  },
};

const pdfRenderTool = {
  name: 'doc_render',
  description:
    'Render pages of a local PDF to PNG files and return their local paths. Use pages like "1-3" or a single page number. Default scale 2.5 (1 = 72dpi).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path of the local PDF file.' },
      pages: { type: 'string', description: 'Page selection like "1-3" (default "1").' },
      scale: { type: 'number', description: 'Render scale, default 2.5.' },
      outDir: { type: 'string', description: 'Optional output directory.' },
    },
    required: ['path'],
  },
  output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
  timeoutMs: 180000,
  async execute(args) {
    try {
      const { abs, dir } = prepare(args.path);
      // doc_render 只认 PDF：Office 文件传进来 loadPdf 会抛 "Invalid PDF structure"，看不出所以然
      if (!/\.pdf$/i.test(abs)) {
        return `doc_render only renders PDF pages — "${path.basename(abs)}" is not a PDF. For Word/PPT/Excel use doc_text (text), doc_tables (tables), doc_parse (whole document to Markdown), or doc_formulas (pptx formulas to LaTeX).`;
      }
      const doc = await loadPdf(abs);
      const wanted = parsePages(args.pages || '1', doc.numPages);
      const RENDER_CAP = 50;
      const nums = wanted.slice(0, RENDER_CAP);
      // pages="abc" 会解析出空数组，早先直接返回空串（2026-11-09 第二轮测试发现）
      if (!nums.length) {
        return `no pages matched pages="${args.pages}" (this PDF has ${doc.numPages} page(s))`;
      }
      const scale = Number(args.scale) > 0 ? Number(args.scale) : 2.5;
      const outDir = args.outDir ? path.resolve(args.outDir) : path.join(dir, 'pages');
      fs.mkdirSync(outDir, { recursive: true });
      // 渲染吃内存，并发压到 2 路；输出顺序由 mapLimit 保证
      const lines = await mapLimit(nums, 2, async (n) => {
        const file = await renderPage(doc, n, scale, outDir, abs);
        return `page ${n}: ${file}`;
      });
      if (wanted.length > RENDER_CAP) {
        // 提示里要给「真实未渲染的页码」，不是数量：稀疏选择（1..49,51,53,55）时按数量提示会指错页。
        const rest = wanted.slice(RENDER_CAP);
        const shown = rest.slice(0, 20).join(',');
        lines.push(
          `[note: rendered ${RENDER_CAP} of ${wanted.length} requested pages — the per-call cap is ${RENDER_CAP}; not rendered: ${rest.length > 20 ? shown + ', …' : shown} (pass a narrower pages range)]`,
        );
      }
      return lines.join('\n');
    } catch (err) {
      return 'error: ' + String(err?.message || err);
    }
  },
};

const pdfOcrTool = {
  name: 'doc_ocr',
  description:
    'OCR scanned pages of a local PDF. Default engine is MinerU 4.2.3 (LaTeX formulas + Markdown tables + figures, via the resident local API on ports 18000/18001, ~1-6 s/page). The online path (mineru.net, which uploads the PDF) is used only when the mode file says "online" — `C:\\deepseek\\tools\\dsh-doc-parser\\mineru-mode.txt`, re-read on every call, so writing "local" there forbids uploading and takes effect immediately. With no mode file it falls back to MINERU_MODE, and to the online path only if the local venv is missing while a token exists at `C:\\deepseek\\tools\\.mineru-token`. By default only pages detected as scanned are processed; force=true OCRs every selected page. Pages in one call share a single model load, so batching pages is much faster than one-by-one.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path of the local PDF file.' },
      pages: { type: 'string', description: 'Page selection like "1-3"; default all pages.' },
      engine: {
        type: 'string',
        enum: ['mineru'],
        description:
          'OCR engine. Only "mineru" is available: MinerU 3.x pipeline through the resident local API (LaTeX formulas, HTML tables, figures, 1-6 s/page). The Indra CPU fallback was removed on 2026-11-18; MinerU failures are reported as errors instead of silently degrading to plain text.',
      },
      lang: {
        type: 'string',
        description:
          'Language tag, default "chi_sim+eng". Only participates in the cache key now — MinerU is pinned to "ch", so changing it forces a re-OCR without changing engine behaviour.',
      },
      force: { type: 'boolean', description: 'OCR all selected pages, not just scanned ones.' },
      withImages: {
        type: 'boolean',
        description:
          'Engine=mineru only: also fetch figure/formula images and save them as real files next to the page cache, so markdown gets usable local paths instead of dead server-side names. Slower — turn on only when figures matter.',
      },
      maxChars: {
        type: 'integer',
        description: 'Output cap in characters (default 12000; env PDF_MAX_CHARS overrides the default).',
      },
      prefetch: {
        type: 'boolean',
        description:
          'Queue pages for OCR in the background and return immediately (progress lands in the cache dir as ocr/progress.json). Defaults to every scanned page; pass pages= to limit the scope. Useful before reading a large scanned book page by page.',
      },
      exportImages: {
        type: 'boolean',
        description:
          'Engine=mineru: copy every figure/formula image found in this call\'s pages into <cache>/figures/ and list them, so the whole book\'s images can be collected in one call.',
      },
    },
    required: ['path'],
  },
  output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
  timeoutMs: 600000,
  async execute(args) {
    try {
      const { abs, dir } = prepare(args.path);
      const doc = await loadPdf(abs);
      const nums = parsePages(args.pages, doc.numPages);
      const lang = args.lang || DEFAULT_LANG;
      const outDir = path.join(dir, 'ocr');
      fs.mkdirSync(outDir, { recursive: true });
      const engine = 'mineru'; // Indra CPU 备用引擎已于 2026-11-18 移除，只剩 MinerU 一条路
      const wantImages = args.withImages === true;
      const force = args.force === true;
      // F4：整本预跑（后台，立即返回）。以前只有 prefetch_book.mjs 脚本、没有工具入口。
      if (args.prefetch === true) {
        const all = parsePages('all', doc.numPages);
        const job = PREFETCH.get(dir);
        if (job && !job.finishedAt) {
          return `prefetch already running for this pdf: ${job.total} page(s), started ${Math.round((Date.now() - job.startedAt) / 1000)}s ago (progress: ${path.join(outDir, 'progress.json')})`;
        }
        // pages 在 prefetch 下也要尊重：指定了就只排这些页（以前静默忽略，一律跑整本）。
        const prefetchScope =
          args.pages && String(args.pages).trim() && String(args.pages).trim().toLowerCase() !== 'all' ? nums : all;
        const rec = { total: prefetchScope.length, startedAt: Date.now(), finishedAt: 0, error: '' };
        PREFETCH.set(dir, rec);
        const todo = [];
        for (const n of prefetchScope) {
          const cacheFile = path.join(outDir, `p${String(n).padStart(3, '0')}.json`);
          const hit = readJson(cacheFile);
          const usable =
            hit &&
            (hit.schema == null || hit.schema <= CACHE_SCHEMA) &&
            hit.lang === lang &&
            (!hit.engine || hit.engine === 'text' || hit.engine === engine);
          if (usable) continue;
          // 只对扫描页排队：纯文本页白烧 GPU（2026-11-09 测试发现 14 页文本 PDF 被整本 OCR）。
          try {
            const probe = await probePage(doc, n);
            if (!probe.scanned) continue;
          } catch {
            /* 探不出就照排 */
          }
          todo.push(n);
        }
        if (!todo.length) {
          rec.finishedAt = Date.now();
          return `prefetch not needed: all ${prefetchScope.length} page(s) are already cached or have a text layer`;
        }
        (async () => {
          try {
            const out = await mineruBatch(abs, todo, outDir, { withImages: wantImages, force: !!args.force });
            // 结果必须写回页缓存 —— 以前直接丢弃，进度显示 done、页缓存一个文件都没有。
            rec.cachedCount = writeMineruPageCache(out?.results, outDir, lang, wantImages);
            rec.failedCount = (out?.failed || []).length;
          } catch (err) {
            rec.error = String(err?.message || err).slice(0, 300);
          } finally {
            rec.finishedAt = Date.now();
          }
        })();
        return `prefetch started: ${todo.length} of ${prefetchScope.length} page(s) queued in the background (progress: ${path.join(outDir, 'progress.json')}) — keep the app running; results are written to the page cache as they land`;
      }
      const cached = [];
      const pending = [];
      for (const n of nums) {
        const probe = await probePage(doc, n);
        const cacheFile = path.join(outDir, `p${String(n).padStart(3, '0')}.json`);
        const rec = readJson(cacheFile);
        // 旧缓存没有 engine 字段（RapidOCR 时代）也直接复用；engine=text（文字层直返）与当前 OCR 引擎无关，永远复用。
        // withImages 也进缓存键：先跑无图、后来要图时不能直接命中那条没图的记录（以前会静默返回空图）。
        const imagesOk = !wantImages || rec?.withImages === true;
        // schema：老记录没有这个字段（按旧规则兼容），比本插件更新的记录才拒用
        const schemaOk = rec?.schema == null || rec.schema <= CACHE_SCHEMA;
        if (
          !force &&
          rec &&
          schemaOk &&
          rec.lang === lang &&
          (!rec.engine || rec.engine === 'text' || rec.engine === engine) &&
          (rec.engine === 'text' || imagesOk)
        ) {
          cached.push(rec);
          continue;
        }
        // 文本层页也进 pending：由下面的文本层分支直接返回，OCR 只兜底扫描页
        pending.push({ num: n, cacheFile, scanned: probe.scanned });
      }
      const fresh = [];
      // 文本层优先：有文字层的页直接取文本，OCR 只兜底扫描页（快约 10 倍）
      const textLayer = new Map();
      for (const item of pending) {
        try {
          const pg = await doc.getPage(item.num);
          const tc = await pg.getTextContent();
          const t = (tc.items || []).map((i) => i.str || '').join('').replace(/\s+/g, ' ').trim();
          if (!force && isRealTextLayer(t)) textLayer.set(item.num, t);
        } catch {
          /* ignore */
        }
      }
      // pdfjs 对部分中文 PDF 取不到文字层（items=0），用 pypdfium2 兜一次。
      // 只对 pdfjs 没拿到真文本层的页跑：以前是「只要有待处理页就起一次 python」，
      // 哪怕每页都已有文本层，也要白付一次进程启动 + 整份 PDF 解析（0.5–1 秒）。
      const needPdfium = pending.filter((p) => !textLayer.has(p.num));
      const pdfiumPy = needPdfium.length ? pdfiumPython() : '';
      if (needPdfium.length && pdfiumPy) {
        try {
          const pyOut = path.join(outDir, `.text-${process.pid}-${Date.now()}.json`);
          const r = spawnSync(
            pdfiumPy,
            ['-X', 'utf8', path.join(here, 'text_pdfium.py'), abs, JSON.stringify(needPdfium.map((p) => p.num)), pyOut],
            { stdio: ['ignore', 'ignore', 'ignore'], timeout: 30000, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } },
          );
          if (r.status === 0 && fs.existsSync(pyOut)) {
            const dict = JSON.parse(fs.readFileSync(pyOut, 'utf8'));
            for (const [k, v] of Object.entries(dict)) {
              const n = Number(k);
              const vt = String(v || '').replace(/\s+/g, ' ').trim();
              // force 必须在这里也短路：否则文本层照旧命中，force 变成假开关，
              // 还会把已有的 mineru 记录改写成 engine:'text' 并丢掉 blocks（2026-11-09 第二轮测试发现）。
              if (!force && isRealTextLayer(vt) && !textLayer.has(n)) textLayer.set(n, vt);
            }
            fs.rmSync(pyOut, { force: true });
          }
        } catch {
          /* 兜底失败就走 OCR */
        }
      }
      const used = [];
      for (const item of pending) {
        const t = textLayer.get(item.num);
        if (!t) {
          used.push(item);
          continue;
        }
        const rec = {
          schema: CACHE_SCHEMA,
          num: item.num,
          lang,
          engine: 'text',
          text: t,
          // 2026-11-22：文本层没跑 OCR，不能写 100（页头会显示 (ocr 100%)，与 MinerU 不返回置信度的事实矛盾）
          confidence: null,
          withImages: false,
        };
        writeJson(item.cacheFile, rec);
        fresh.push(rec);
      }
      let mineruDone = false;
      let mineruFailed = [];
      let mineruError = '';
      if (used.length) {
        // MinerU 直接吃 PDF（pipeline 后端：公式→LaTeX、表格→HTML、图片裁切）
        let mres = null;
        try {
          const out = await mineruBatch(abs, used.map((u) => u.num), outDir, {
            withImages: args.withImages === true,
            // force 必须一路传到底：只跳过本地页缓存不够，在线通道还要清 online-task.json 才会重传
            force: !!args.force,
          });
          mres = out.results;
          mineruFailed = out.failed;
        } catch (err) {
          // 整批连同逐页重试都失败（服务不通 + CLI 也失败）。Indra 已移除，不再退备用引擎。
          mineruError = String(err && err.message ? err.message : err);
          process.stderr.write(`[mineru] batch failed: ${mineruError.slice(0, 200)}\n`);
        }
        if (mres) {
          const left = [];
          used.forEach((item, i) => {
            const r = mres[i];
            if (!r) {
              left.push(item); // 这页 MinerU 没成功，登记为失败
              return;
            }
            const freshRec = {
              schema: CACHE_SCHEMA,
              num: item.num,
              lang,
              engine,
              // 2026-11-13：这层重建会把 mineruBatch 里写好的 via 覆盖掉，
              // 于是 0.4.0 在线通道的页缓存看不出走的哪条路；透传一次。
              ...(r.via ? { via: r.via } : {}),
              // 2026-11-26：自动分档标记同理——这层重建只透传 via 时，
              // 「这页是 advanced 补的」在页缓存里查不到（p193 实测：内容已升级、tier 仍是空）
              ...(r.tier ? { tier: r.tier } : {}),
              text: r.text,
              confidence: r.confidence,
              markdown: r.markdown || r.text,
              blocks: Array.isArray(r.blocks) ? r.blocks : [],
              withImages: wantImages,
            };
            writeJson(item.cacheFile, freshRec);
            fresh.push(freshRec);
          });
          used.splice(0, used.length, ...left);
          mineruDone = left.length === 0;
        }
      }
      if (used.length && !mineruDone) {
        // Indra CPU 备用引擎已于 2026-11-18 移除（用户拍板，用不上）。
        // MinerU 没成功的页直接登记为失败——不再静默降级成纯文本，让调用方看到真实原因。
        for (const item of used) {
          mineruFailed.push({ page: item.num, error: mineruError || 'mineru returned no result for this page' });
        }
        used.length = 0;
      }
      const pages = cached.concat(fresh).sort((a, b) => a.num - b.num);
      if (!pages.length) {
        const realFailed = mineruFailed.filter((f) => !f.figureOnly);
        const figOnly = mineruFailed.filter((f) => f.figureOnly);
        const whyParts = [];
        if (realFailed.length) {
          whyParts.push(`mineru failed on: ${realFailed.map((f) => `p${f.page} (${f.error})`).join('; ')}`);
        }
        if (figOnly.length) {
          // 2026-11-26：整页图（曲线/相图）本来就没文字，跟真失败分开报，否则会被当成故障去查。
          whyParts.push(
            `figure-only page(s), no text by design (not a failure): ${figOnly.map((f) => `p${f.page}`).join(', ')}`,
          );
        }
        const why = whyParts.length ? `\n${whyParts.join('\n')}` : '';
        const sel = String(args.pages || 'all');
        return (
          `no pages to OCR for pages="${sel}" — ` +
          (force
            ? 'force=true was set, so every selected page was attempted; nothing came back'
            : 'all selected pages already have a usable text layer (or no page matched the range); pass force=true to OCR them anyway')
        ) + why;
      }
      const blocks = pages.map((rec) => {
        const labels = Array.isArray(rec.blocks)
          ? rec.blocks.map((b) => (typeof b === 'string' ? b : b && b.label)).filter(Boolean)
          : [];
        const score = rec.confidence == null ? rec.engine || 'mineru' : `${rec.confidence}%`;
        const head = `========== PAGE ${rec.num} (ocr ${score}) ==========`;
        const tag = labels.length ? `[blocks: ${[...new Set(labels)].join(', ')}]\n` : '';
        return `${head}\n${tag}${rec.text}`;
      });
      // F3：把本次页缓存里的图统一拷到 figures/，一次就能拿到整本的图
      let figures = [];
      if (args.exportImages === true) {
        const figDir = path.join(dir, 'figures');
        fs.mkdirSync(figDir, { recursive: true });
        for (const rec of pages) {
          for (const b of Array.isArray(rec.blocks) ? rec.blocks : []) {
            const src = b && (b.img_file || b.imgFile);
            if (!src || !fs.existsSync(src)) continue;
            const dest = path.join(figDir, `p${String(rec.num).padStart(3, '0')}-${path.basename(src)}`);
            try {
              fs.copyFileSync(src, dest);
              figures.push(dest);
            } catch {
              /* 单张失败不影响其余 */
            }
          }
        }
      }
      const limit = Number(args.maxChars) > 0 ? Number(args.maxChars) : DEFAULT_MAX_CHARS;
      const tails = [];
      if (figures.length) {
        tails.push(`[figures: ${figures.length} file(s) exported to ${path.join(dir, 'figures')}]\n${figures.join('\n')}`);
      }
      const realFailed = mineruFailed.filter((f) => !f.figureOnly);
      const figOnly = mineruFailed.filter((f) => f.figureOnly);
      if (realFailed.length) {
        tails.push(
          `[note: ${realFailed.length} page(s) failed on MinerU: ` +
            `${realFailed.map((f) => `p${f.page}`).join(', ')} — see plugin stderr for the per-page error]`,
        );
      }
      if (figOnly.length) {
        // 2026-11-26：整页图没有文字是正常的，单独一句说明，不占「失败」计数。
        tails.push(
          `[note: ${figOnly.length} page(s) have no text layer by design (full-page figures): ` +
            `${figOnly.map((f) => `p${f.page}`).join(', ')} — not a failure]`,
        );
      }
      const tail = tails.join('\n\n');
      const bodyLimit = Math.max(80, limit - (tail ? tail.length + 2 : 0));
      const body = clampByPages(blocks, bodyLimit, pages.map((rec) => rec.num));
      return tail ? `${body}\n\n${tail}` : body;
    } catch (err) {
      return 'error: ' + String(err?.message || err);
    }
  },
};

/** 取 HTML 表的第一行文本，用来判断相邻两页是不是同一张续表。 */
function firstTableRow(html) {
  const m = String(html || '').match(/<tr[\s\S]*?<\/tr>/i);
  if (!m) return '';
  return m[0]
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 2026-11-26 缺陷测试 BT-OCR-03：表格不只出现在 `type==='table'` 块里。实测 p193 的热容表在
// `chart` 块中（advanced 把表识别成 chart 并给出 Markdown 表），扫描件的表在 `text` 块中；旧写法
// 只认 table 块，这几类页一律输出 `no table found`，调用方会以为 PDF 里没有表。判据改成「块文本里
// 有没有 Markdown 表格」——`| a | b |` 后紧跟 `| --- | --- |` 分隔行才算，避免把正文里的竖线当表。
const MD_TABLE_RE = /(?:^|\n)[ \t]*\|[^\n]*\|[^\n]*\n[ \t]*\|[\s:|-]+\|/;
function tableTextOf(blocks) {
  const found = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b) continue;
    const t = String(b.text || '');
    if (!t) continue;
    if (b.type === 'table' || MD_TABLE_RE.test(t)) found.push(t);
  }
  return found.join('\n\n');
}

// ---- OOXML（docx/pptx/xlsx）直读：零依赖，不走 pdfjs ----
function formatOoxmlInfo(abs) {
  const info = ooxmlInfo(abs);
  const kindName = { docx: 'Word 文档', pptx: 'PowerPoint 演示', xlsx: 'Excel 工作簿' }[info.kind] || info.kind;
  const lines = [
    `path: ${abs}`,
    `kind: ${info.kind}（${kindName}）`,
    info.kind === 'pptx' ? `slides: ${info.pages}` : info.kind === 'xlsx' ? `sheets: ${info.pages}` : `paragraphs: ${info.pages}`,
    `text chars: ${info.textChars}`,
    `media files: ${info.mediaCount}`,
    `has tables: ${info.hasTables ? 'yes' : 'no'}`,
    `has formulas: ${info.hasMath ? 'yes' : 'no'}`,
  ];
  if (info.oleObjects) lines.push(`math type ole objects: ${info.oleObjects}`);
  for (const n of info.notes || []) lines.push('note: ' + n);
  if (info.kind === 'pptx' && info.oleObjects) {
    lines.push('hint: 这些公式是 MathType OLE 嵌入对象，文本层里没有内容；用 doc_formulas（action=extract）把课件转成 PDF 再 OCR，直接出 LaTeX。');
  }
  return lines.join('\n');
}

function formatOoxmlText(abs, args) {
  const { blocks } = ooxmlText(abs, { pages: args.pages });
  if (!blocks.length) return `no blocks matched pages="${args.pages || 'all'}"`;
  const label = { docx: 'PARA', pptx: 'SLIDE', xlsx: 'SHEET' }[ooxmlExt(abs)] || 'PART';
  const parts = blocks.map((b) => `========== ${label} ${b.num} ==========\n${b.text}`);
  const limit = Number(args.maxChars) > 0 ? Number(args.maxChars) : DEFAULT_MAX_CHARS;
  return clampByPages(parts, limit, blocks.map((b) => b.num));
}

function formatOoxmlTables(abs, args) {
  const maxRows = Number(args.maxRows) > 0 ? Number(args.maxRows) : 200;
  // sheet 序号过滤：1000 只是 parsePages 需要的上界，xlsx 的 sheet 数远小于它（2026-11-22 审计）
  const pageNums = args.pages ? parsePages(args.pages, 1000) : null;
  const tables = ooxmlTables(abs, { maxRows, pages: pageNums });
  if (!tables.length) return `no tables found in this ${ooxmlExt(abs)} file`;
  const out = [];
  for (const tb of tables) {
    out.push(`== ${tb.label} (${tb.rows.length} row(s)${tb.truncated ? ', truncated' : ''}) ==`);
    out.push(tb.rows.map((r) => r.join('\t')).join('\n'));
  }
  return out.join('\n\n');
}

const DOC_EXTS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.png',
  '.jpg',
  '.jpeg',
  '.jp2',
  '.webp',
  '.gif',
  '.bmp',
  '.tiff',
  '.tif',
  '.html',
  '.htm',
]);

/**
 * 0.5.0：通用文档解析。在线精准解析 API 支持 pdf/doc/docx/ppt/pptx/图片/html，
 * 而本地 MinerU 只吃 pdf 和图片，所以 docx/pptx 只能走这条。
 * 与 pdf_* 工具的分工：pdf_* 是页级操作（渲染/页范围/文本层），doc_parse 是「整份转 markdown」。
 */
const docParseTool = {
  name: 'doc_parse',
  description:
    'Parse one local document through the MinerU online API and return Markdown (LaTeX formulas, HTML tables, figure references). Supports pdf, doc, docx, ppt, pptx, images (png/jpg/jpeg/jp2/webp/gif/bmp/tiff) and html. The file is uploaded to mineru.net (not a local operation); token comes from MINERU_API_TOKEN or C:\\deepseek\\tools\\.mineru-token. Results are cached per file content, so a repeat call costs nothing. For page-level PDF work use the doc_text / doc_render / doc_ocr tools instead.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path of the local document.' },
      force: { type: 'boolean', description: 'Ignore the cached result and re-parse (default false).' },
      maxChars: {
        type: 'integer',
        description: 'Output cap in characters (default 20000); cut at line boundaries and the rest stays on disk.',
      },
      withImages: {
        type: 'boolean',
        description:
          'Also extract figures into <cache>/doc/images and rewrite Markdown links to their absolute paths (default false: figures stay as "[figure: … (not extracted)]" placeholders).',
      },
    },
    required: ['path'],
  },
  output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
  timeoutMs: 900000,
  async execute(args) {
    try {
      const ext = path.extname(String(args.path || '')).toLowerCase();
      if (!DOC_EXTS.has(ext)) {
        return `error: unsupported extension ${ext || '(none)'} — supported: ${[...DOC_EXTS].join(' ')}`;
      }
      if (!mineruOnlineReady()) {
        return 'error: MinerU online token missing — set MINERU_API_TOKEN or write it to C:\\deepseek\\tools\\.mineru-token';
      }
      const { abs, st, dir } = prepare(args.path);
      const outDir = path.join(dir, 'doc');
      fs.mkdirSync(outDir, { recursive: true });
      const cacheFile = path.join(outDir, 'parsed.json');
      let rec = args.force ? null : readJson(cacheFile);
      // 不带图那次的缓存里没有 images/，带 withImages 再调要重跑一遍才能把图落下来
      const cached = !!rec && !!rec.markdown && (!args.withImages || rec.withImages === true);
      if (!cached) {
        const t0 = Date.now();
        const parsed = await mineruParseFile(abs, outDir, { force: !!args.force, withImages: args.withImages === true });
        rec = {
          schema: CACHE_SCHEMA,
          file: abs,
          bytes: st.size,
          pages: parsed.pages || 0,
          counts: parsed.counts || {},
          markdown: parsed.markdown || '',
          batchId: (parsed.marker && parsed.marker.batchId) || '',
          submittedAt: (parsed.marker && parsed.marker.submittedAt) || '',
          zipUrl: (parsed.marker && parsed.marker.zipUrl) || '',
          parsedAt: Date.now(),
          elapsedMs: Date.now() - t0,
          withImages: args.withImages === true,
        };
        writeJson(cacheFile, rec);
      }
      const c = rec.counts || {};
      const head =
        `== ${path.basename(abs)} — ${rec.pages || '?'} page(s), ` +
        `text ${c.text || 0} / formula ${c.equation || 0} / table ${c.table || 0} / figure ${c.image || 0}` +
        (cached ? ' (cached)' : ` (parsed in ${((rec.elapsedMs || 0) / 1000).toFixed(1)}s)`) +
        (rec.batchId
          ? ' [batch ' + rec.batchId + (rec.submittedAt ? ' @ ' + new Date(rec.submittedAt).toISOString().slice(0, 19) + 'Z' : '') + ']'
          : '');
      const md = String(rec.markdown || '');
      if (!md) return `${head}\n\n(empty markdown in result)`;
      // 以前写死 20000，env PDF_MAX_CHARS 对 doc_parse 无效（2026-11-22 审计）
      const envLimit = Number(process.env.PDF_MAX_CHARS) > 0 ? Number(process.env.PDF_MAX_CHARS) : 0;
      const limit = Number(args.maxChars) > 0 ? Number(args.maxChars) : envLimit || 20000;
      if (md.length <= limit) return `${head}\n\n${md}`;
      const lines = md.split('\n');
      let acc = 0;
      const keep = [];
      for (const line of lines) {
        // maxChars 很小时留 200 字符的余量会把预算压成 0，正文一行都不给（2026-11-13 测试发现）
        if (acc + line.length + 1 > Math.max(60, limit - 200)) break;
        keep.push(line);
        acc += line.length + 1;
      }
      return (
        `${head}\n\n${keep.join('\n')}\n\n` +
        `[... ${md.length - acc} of ${md.length} characters not shown — raise maxChars, or the full markdown is at ${cacheFile}]`
      );
    } catch (err) {
      return 'error: ' + String((err && err.message) || err);
    }
  },
};

const docFormulasTool = {
  name: 'doc_formulas',
  description:
    'MathType formula extraction for .pptx. action=scan counts formula objects (embedded OLE) and vector images (WMF/EMF) and shows the per-slide distribution — cheap, no unzip-and-render; action=extract converts the deck to PDF with LibreOffice and OCRs every page, returning only the equation blocks as LaTeX with page numbers (rendering the raw WMF/EMF files gives garbled glyphs for font-rendered formulas, so that path is not used); action=stats / clean manage the cache for this file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path of the local .pptx file.' },
      action: {
        type: 'string',
        enum: ['scan', 'extract', 'stats', 'clean'],
        description:
          '"scan" (default): count formula objects (embedded OLE) and vector images (WMF/EMF) with the per-slide distribution — cheap, no rendering. "extract": convert the deck to PDF with LibreOffice and OCR every page, returning only equation blocks as LaTeX. "stats": size of this file\'s formula cache. "clean": delete it (needs confirm=true).',
      },
      force: { type: 'boolean', description: 'extract: force the PDF conversion. The OCR stage always re-runs (the local MinerU path does not reuse the page cache), so a second extract is not cheap.' },
      maxChars: { type: 'integer', description: 'extract: output cap in characters (default 12000; cut at line boundaries with a hint).' },
      confirm: { type: 'boolean', description: 'Required for action=clean.' },
    },
    required: ['path'],
  },
  output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
  timeoutMs: 600000,
  async execute(args) {
    try {
      const abs = path.resolve(String(args.path || ''));
      if (!fs.existsSync(abs)) return 'error: file not found: ' + abs;
      if (!/\.pptx$/i.test(abs)) return 'error: doc_formulas only handles .pptx (got ' + path.basename(abs) + ')';
      const { dir } = prepare(abs);
      const action = String(args.action || 'scan');

      // 2026-11-26 缺陷测试：损坏的 .pptx 会被 LibreOffice 转成一份空 PDF，OCR 后一句
      // 「没有识别到公式块」——把「文件坏了」说成「没有公式」是假阴性，调用方会据此判定课件没公式。
      // 先用 loadDeck 走一遍 OOXML 结构（也是 scan 用的那个解析器），坏了就明说，不再往下转 PDF。
      if (action === 'extract') {
        try {
          loadDeck(abs);
        } catch (err) {
          return (
            'error: ' + path.basename(abs) + ' 不是可读的 .pptx（' +
            String(err?.message || err).slice(0, 160) +
            '）——文件可能已损坏或只是改了扩展名。这里不再转 PDF，' +
            '避免把「文件坏了」误报成「没有公式」。'
          );
        }
      }

      if (action === 'scan') {
        const deck = loadDeck(abs);
        const s = deckStats(deck);
        const rows = deck.bySlide
          .filter((x) => x.items.length)
          .map((x) => '  p' + x.slide + ': ' + x.items.length + ' 个公式图');
        return [
          'file: ' + abs,
          'slides: ' + s.slides,
          'formula objects (oleObject): ' + s.ole,
          'formula images (wmf/emf): ' + s.media,
          'per-slide total: ' + s.total + (s.noImg ? ' (' + s.noImg + ' 条没有配图，只能靠 OLE 数据)' : ''),
          'per slide:',
          rows.length ? rows.join('\n') : '  （没有任何公式图）',
        ].join('\n');
      }

      if (action === 'extract') {
        // 2026-11-13 实测结论：直接拿 WMF 抽图，遇到「靠字体渲染」的公式会变成乱码字形；
        // 改成 LibreOffice 先把幻灯片渲染成 PDF，再让 OCR 通道识别公式块，LaTeX 才可靠。
        const t0 = Date.now();
        const conv = deckToPdf(abs, dir, { force: !!args.force });
        const pdfDoc = await loadPdf(conv.pdf);
        const nums = Array.from({ length: pdfDoc.numPages }, (_, i) => i + 1);
        const ocrDir = path.join(dir, 'formula', 'ocr');
        fs.mkdirSync(ocrDir, { recursive: true });
        const out = await mineruBatch(conv.pdf, nums, ocrDir, { force: !!args.force });
        const results = Array.isArray(out) ? out : (out && out.results) || [];
        const lines = [];
        let total = 0;
        let pages = 0;
        for (const r of results) {
          const fb = (r.blocks || []).filter((b) => b && (b.type === 'equation' || b.label === 'Formula'));
          if (!fb.length) continue;
          total += fb.length;
          pages++;
          lines.push('========== slide ' + r.num + ' — ' + fb.length + ' 个公式 ==========');
          for (const b of fb) lines.push(String(b.text || '').trim());
        }
        if (!total) {
          return (
            '== ' + path.basename(abs) + ' — 转成 PDF 后没有识别到公式块\n' +
            'pdf: ' + conv.pdf + '\n' +
            '（若确实有公式，可能是 OCR 通道不可用；先跑 doc_ocr 看单页输出）'
          );
        }
        const head =
          '== ' + path.basename(abs) + ' — ' + total + ' 个公式 / ' + pages + ' 页' +
          (conv.cached ? '（PDF 复用，要重转加 force=true）' : '（LibreOffice 转换 ' + (conv.elapsedMs / 1000).toFixed(1) + 's）') +
          '，总用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's';
        // 300 页的课件可能有几百个公式，直接拼会撑爆工具结果：按行截断并给 PDF 位置。
        const body = [head, 'pdf: ' + conv.pdf, '', lines.join('\n')].join('\n');
        const lim = Number(args.maxChars) > 0 ? Number(args.maxChars) : DEFAULT_MAX_CHARS;
        if (body.length <= lim) return body;
        const cut = body.slice(0, lim);
        const at = cut.lastIndexOf('\n');
        const keep = at > 0 ? at : lim;
        return (
          cut.slice(0, keep) +
          '\n\n[... ' + (body.length - keep) + ' of ' + body.length +
          ' characters not shown — raise maxChars; the PDF is at ' + conv.pdf + ']'
        );
      }

      if (action === 'stats') {
        const base = formulaRoot(dir);
        if (!fs.existsSync(base)) return '== no formula cache yet for ' + path.basename(abs);
        const st = cacheStats(base);
        return [
          '== formula cache for ' + path.basename(abs),
          '  dir: ' + base,
          '  files: ' + st.files,
          '  size: ' + (st.bytes / 1048576).toFixed(1) + ' MB',
        ].join('\n');
      }

      if (action === 'clean') {
        if (!args.confirm) return 'error: action=clean needs confirm=true';
        const base = formulaRoot(dir);
        if (!fs.existsSync(base)) return 'nothing to clean for ' + path.basename(abs);
        const st = cacheStats(base);
        fs.rmSync(base, { recursive: true, force: true });
        return 'cleaned ' + base + ' (' + st.files + ' files, ' + (st.bytes / 1048576).toFixed(1) + ' MB)';
      }

      return 'error: unknown action ' + action;
    } catch (err) {
      return 'error: ' + String((err && err.message) || err);
    }
  },
};

const pdfTablesTool = {
  name: 'doc_tables',
  description:
    'Table extraction from a local PDF or Office file (xlsx/docx/pptx are read from OOXML directly). Text-layer pages use a heuristic (group text by rows, split columns by x gaps) and return TSV; scanned pages automatically fall back to engine=mineru, which returns the real HTML table. engine="mineru" forces that path for every page.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path of the local PDF file.' },
      pages: { type: 'string', description: 'Page selection like "1-3"; default all pages.' },
      engine: {
        type: 'string',
        enum: ['auto', 'mineru'],
        description:
          '"auto" (default): text layer first, MinerU fallback when a page yields no usable table; "mineru": always use MinerU HTML tables.',
      },
      maxChars: {
        type: 'integer',
        description: 'Output cap in characters (default 12000; env PDF_MAX_CHARS overrides the default).',
      },
      maxMineruPages: {
        type: 'integer',
        description:
          'Safety cap on how many pages may go through MinerU in one call (default 24). Whole-book table scans on scanned PDFs are slow; pages beyond the cap are reported as skipped instead of silently processed.',
      },
      maxRows: {
        type: 'integer',
        description:
          'Maximum data rows per table (default 200). Applies to OOXML tables; PDF tables are not row-capped.',
      },
    },
    required: ['path'],
  },
  output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
  // 2026-11-22：默认最多 24 页送 MinerU（冷启动 40 s + 每页 1.2–7 s），120000 必超时；与 doc_ocr 的 600000 对齐
  timeoutMs: 600000,
  async execute(args) {
    try {
      if (isOoxml(args.path)) return formatOoxmlTables(path.resolve(args.path), args);
      const { abs, dir } = prepare(args.path);
      const doc = await loadPdf(abs);
      const nums = parsePages(args.pages, doc.numPages);
      const forceMineru = args.engine === 'mineru';
      const tableOut = path.join(dir, 'ocr');
      fs.mkdirSync(tableOut, { recursive: true });
      // 第一阶段：文本层启发式（便宜）
      const local = new Map();
      const wantMineru = [];
      // engine="mineru" 时整批都要 OCR，再跑一遍文本层启发式纯属白算（2026-11-22 审计）
      if (forceMineru) wantMineru.push(...nums);
      for (const n of forceMineru ? [] : nums) {
        let tsv = '';
        let maxCols = 0;
        let lowConfidence = false;
        try {
          const page = await doc.getPage(n);
          const tc = await page.getTextContent();
          const r = rowsToTsv(rowsFromItems(tc.items));
          tsv = r.tsv;
          maxCols = r.maxCols;
          lowConfidence = r.lowConfidence;
        } catch {
          /* ignore */
        }
        // 正文被坐标启发式切成多列时会「有表」：列数多 + 每行平均字符多 = 多半是正文。
        // 这种要回退 MinerU，否则双栏论文整页会被当 6 列表格吐出来（2026-11-09 测试发现）。
        const tsvRows = tsv ? String(tsv).split('\n').length : 0;
        const avgRowChars = tsvRows ? String(tsv).length / tsvRows : 0;
        const looksLikeProse = maxCols >= 4 && avgRowChars > 90;
        // lowConfidence 的含义是「有一行格数与最大列数不同」——纯文字页（考题、诗歌、目录）
        // 几乎必中，于是 58 页文字页会 58 页全送 GPU（2026-11-09 第二轮测试实测 43 秒 + 大面积 skipped）。
        // 只在列数明显（≥4）时才让 lowConfidence 参与判定，其余交给空表与 prose 检测。
        // 2026-11-13 第三轮测试：58 页考卷有 52 页被判 thin 送去 OCR，2 页白烧 49 秒仍然「无表」。
        // 收紧成「至少 3 列且有 3 个以上非空行」才算有表格形状；2 列版面（考卷、目录、诗歌）交给文本层，
        // 真需要强制 OCR 时用 engine="mineru"。
        const nonEmptyRows = tsv ? String(tsv).split('\n').filter((l) => l.trim()).length : 0;
        const tableShaped = !!tsv && !!tsv.trim() && maxCols >= 3 && nonEmptyRows >= 3 && !looksLikeProse;
        const thin = !tableShaped || (lowConfidence && maxCols >= 4);
        if (forceMineru || thin) wantMineru.push(n);
        else local.set(n, { tsv, maxCols, lowConfidence });
      }
      // 第二阶段：需要 MinerU 的页先读 ocr 缓存，剩下的**一次批量**跑完。
      // 旧写法是每页各调一次 ocrMineruPages —— n 页就等于把整份 PDF 读进内存上传 n 次，
      // 而且完全不复用 doc_ocr 已经写好的页缓存。
      const htmlByPage = new Map();
      const missing = [];
      let mineruError = '';
      for (const n of wantMineru) {
        const cacheFile = path.join(tableOut, `p${String(n).padStart(3, '0')}.json`);
        const rec = readJson(cacheFile);
        // 只信 MinerU 写下的页缓存（老的 text 记录没有 blocks，不能代表表格）
        if (!rec || rec.engine !== 'mineru' || (rec.schema != null && rec.schema > CACHE_SCHEMA)) {
          missing.push(n);
          continue;
        }
        // BT-OCR-03：块类型不再是门槛，看块文本里有没有 Markdown 表
        const html = tableTextOf(rec.blocks);
        // BT-OCR-03：缓存命中不等于「这页没有表」。MinerU 缓存记的是「解析过」，不是「没表」——
        // standard 档下整页图/图表页常只留空 chart 块，此时取不到表但 advanced 能给出表（p193 实测）。
        // 所以没取到表就放进 missing 让它重跑一次，不拿空的缓存结果当结论。
        if (html) htmlByPage.set(n, html);
        else missing.push(n);
      }
      // F1：一次调用最多让多少页进 MinerU（整本扫表时几百页会跑很久）
      const tableCap = Number(args.maxMineruPages) > 0 ? Number(args.maxMineruPages) : 24;
      const runNow = missing.slice(0, tableCap);
      const skipped = missing.slice(tableCap);
      if (runNow.length) {
        try {
          const out = await mineruBatch(abs, runNow, tableOut, {});
          const res = Array.isArray(out) ? out : (out && out.results) || [];
          runNow.forEach((n, i) => {
            const rec = res[i] || {};
            const html = tableTextOf(rec.blocks);
            if (html) htmlByPage.set(n, html);
            // 顺手写回页缓存（只在没有缓存时写），下次取同一页表格不必再跑一次 OCR
            const cacheFile = path.join(tableOut, `p${String(n).padStart(3, '0')}.json`);
            const existing = readJson(cacheFile);
            const reusable =
              existing &&
              existing.engine === 'mineru' &&
              (existing.schema == null || existing.schema <= CACHE_SCHEMA);
            // 旧记录（非 mineru）不能当表格用，但必须被替换掉：
            // 以前只在「无记录」时写盘，结果是每次调用都重跑 GPU（2026-11-09 测试发现）。
            if (!reusable && Array.isArray(rec.blocks) && rec.blocks.length) {
              writeJson(cacheFile, {
                schema: CACHE_SCHEMA,
                num: n,
                lang: DEFAULT_LANG,
                engine: 'mineru',
                text: rec.text || '',
                confidence: rec.confidence ?? null,
                markdown: rec.markdown || rec.text || '',
                blocks: rec.blocks,
                withImages: false,
              });
            }
          });
        } catch (err) {
          // 整批失败：auto 模式退回文本层结果；但必须留痕，否则和「确实没有表格」无法区分。
          mineruError = String(err?.message || err).slice(0, 200);
        }
      }
      const blocks = [];
      let prevTablePage = 0;
      let prevHead = '';
      for (const n of nums) {
        if (htmlByPage.has(n)) {
          const html = htmlByPage.get(n);
          const head = firstTableRow(html);
          // F2：相邻页且首行相同 = 同一张表的续表，标出来（不自动合并，避免拼错）
          const cont =
            head && prevHead && head === prevHead && n === prevTablePage + 1
              ? ` [continues table from p${prevTablePage}]`
              : '';
          const why = forceMineru ? 'MinerU' : 'MinerU fallback (no text layer)';
          // 2026-11-26：4.x 本地通道给的是 Markdown 表、在线通道给的是 HTML 表，
          // 早先这里一律写 "HTML table"，与实际内容不符（p193 输出 Markdown 却标 HTML）。
          const fmt = /<table[\s>]/i.test(html) ? 'HTML table' : 'Markdown table';
          blocks.push(`========== PAGE ${n} (${why}, ${fmt}${cont}) ==========\n${html}`);
          prevTablePage = n;
          prevHead = head;
        } else if (local.has(n)) {
          const { tsv, maxCols, lowConfidence } = local.get(n);
          blocks.push(
            `========== PAGE ${n} (${maxCols} cols${lowConfidence ? ', low confidence' : ''}) ==========\n${tsv}`,
          );
          prevTablePage = 0;
          prevHead = '';
        } else if (skipped.includes(n)) {
          blocks.push(`========== PAGE ${n} (skipped: MinerU page cap ${tableCap} reached — narrow the pages range) ==========`);
          prevTablePage = 0;
          prevHead = '';
        } else if (mineruError) {
          // MinerU 挂了必须和「确实没表」区分开：以前异常被吞，输出里只有 (no table found)。
          blocks.push(`========== PAGE ${n} (MinerU unavailable, page not checked: ${mineruError}) ==========`);
          prevTablePage = 0;
          prevHead = '';
        } else {
          blocks.push(`========== PAGE ${n} (no table found) ==========`);
          prevTablePage = 0;
          prevHead = '';
        }
      }
      return clampByPages(blocks, Number(args.maxChars) > 0 ? Number(args.maxChars) : DEFAULT_MAX_CHARS, nums);
    } catch (err) {
      return 'error: ' + String(err?.message || err);
    }
  },
};

export function apply(ctx) {
  const tools = [pdfInfoTool, pdfTextTool, pdfRenderTool, pdfOcrTool, pdfTablesTool, docParseTool, docFormulasTool];
  for (const tool of tools) {
    try {
      tool.isConcurrencySafe ??= () => true;
      tool.presentCall ??= (args) => ({ card: 'generic', title: tool.name, kind: 'read', rawInput: args });
      ctx.tools.register(tool);
    } catch (err) {
      console.error(`[doc-parser] register ${tool.name} failed: ${err?.stack || err}`);
    }
  }
  registerProgressRoute(ctx);
}

/**
 * 侧栏进度条的数据入口：GET /plugins/dsh-doc-parser/api/progress
 * 只接受回环 Host，返回所有活跃/刚完成的 OCR 任务快照（内存态，不读盘）。
 */
function registerProgressRoute(ctx) {
  const BASE = '/plugins/dsh-doc-parser';
  const loopbackHost = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
  try {
    ctx.webServer.register({
      kind: 'prefix',
      path: BASE,
      handler: (req, res) => {
        const send = (code, text, type = 'text/plain; charset=utf-8') => {
          const buf = Buffer.from(text, 'utf8');
          res.writeHead(code, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-store' });
          res.end(buf);
        };
        try {
          const host = String(req.headers.host || '');
          if (!loopbackHost.test(host)) return send(403, 'forbidden: not loopback');
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          const p = url.pathname.slice(BASE.length) || '/';
          if (p !== '/api/progress') return send(404, 'not found');
          const now = Date.now();
          const jobs = [...OCR_PROGRESS.values()].map((j) => ({
            pdf: j.pdf,
            cacheDir: j.cacheDir,
            total: j.total,
            done: j.done,
            failed: j.failed,
            note: j.note,
            startedAt: j.startedAt,
            updatedAt: j.updatedAt,
            elapsedMs: Math.max(0, now - j.startedAt),
            // total=0（空页集）不能算完成；部分页失败（done+failed>=total）也应当算结束，
            // 否则这类任务会一直显示「进行中」，直到 5 分钟 TTL 才被清掉。
            finished: j.total > 0 && j.done + j.failed.length >= j.total,
          }));
          return send(200, JSON.stringify({ now, jobs }), 'application/json; charset=utf-8');
        } catch (err) {
          return send(500, 'progress route failed: ' + String(err?.message || err));
        }
      },
    });
  } catch (err) {
    console.error(`[doc-parser] progress route failed: ${err?.stack || err}`);
  }
}
