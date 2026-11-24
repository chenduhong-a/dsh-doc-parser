/**
 * MinerU 官方在线 API 通道（mineru.net /api/v4）。
 *
 * 与本地 `/file_parse` 的根本差别：本地是「一次请求同步返回」，在线是「申请上传 → PUT →
 * 轮询任务 → 下 zip」。所以这一层按「整本一次性解析」设计：第一次调用把整本 PDF 交上去，
 * 结果逐页写进现有页缓存（engine 标 'mineru'，与本地结果同构），之后任意页都是缓存命中。
 *
 * 开关：环境变量 `MINERU_MODE=online`。token 读 `MINERU_API_TOKEN` 或文件
 * `C:\deepseek\tools\.mineru-token`（可用 MINERU_TOKEN_FILE 覆盖路径）。
 *
 * 2026-11-13 实测（0.11 MB / 3 页讲义）：上传到 done 共 11 秒；zip 0.24 MB；
 * content_list 12 块，公式 LaTeX 与中文都正确。
 * 坑：PUT 上传**不能带 Content-Type** —— OSS 预签名把 header 算进签名，带了就 403。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { readJson, writeJson } from './cache.js';

const API_BASE = (process.env.MINERU_API_BASE || 'https://mineru.net').replace(/\/+$/, '');
const TOKEN_FILE = process.env.MINERU_TOKEN_FILE || 'C:\\deepseek\\tools\\.mineru-token';
const POLL_MS = Math.max(1000, Number(process.env.MINERU_POLL_MS) || 4000);
const MAX_WAIT_MS = Number(process.env.MINERU_MAX_WAIT_MS) || 60 * 60 * 1000;
const MODEL = process.env.MINERU_ONLINE_MODEL || 'vlm';
// 页缓存 schema 版本，必须与 main.js 的 CACHE_SCHEMA 一致；对不上就当没缓存（2026-11-13）
const PAGE_SCHEMA = 2;

const LABEL = {
  text: 'Text',
  title: 'Title',
  equation: 'Formula',
  table: 'Table',
  image: 'Image',
  figure: 'Figure',
  list: 'List',
  header: 'Page-Header',
  footer: 'Page-Footer',
};

/** token：环境变量优先，其次文件。不写进日志、不回显。 */
export function mineruOnlineToken() {
  const env = String(process.env.MINERU_API_TOKEN || '').trim();
  if (env) return env;
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

export function mineruOnlineReady() {
  return !!mineruOnlineToken();
}

async function apiCall(pathname, { method = 'GET', body, timeoutMs = 60000 } = {}) {
  const token = mineruOnlineToken();
  if (!token) throw new Error('MinerU token missing (MINERU_API_TOKEN or ' + TOKEN_FILE + ')');
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(API_BASE + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  if (!res.ok) throw new Error(`${method} ${pathname} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  if (!json) throw new Error(`${method} ${pathname} → 非 JSON: ${text.slice(0, 200)}`);
  const code = json.code;
  if (code !== undefined && code !== 0 && code !== 200) {
    throw new Error(`${method} ${pathname} → code=${code} ${json.msg || ''}`);
  }
  return json.data ?? json;
}

/** 申请上传链接并 PUT 原始字节。返回 marker（内含 batchId 与状态）。 */
async function submit(abs, outDir) {
  const name = path.basename(abs);
  const size = fs.statSync(abs).size;
  const up = await apiCall('/api/v4/file-urls/batch', {
    method: 'POST',
    body: { files: [{ name, data_id: name }], model_version: MODEL },
  });
  const batchId = up.batch_id;
  const fileUrl = (up.file_urls && up.file_urls[0]) || (Array.isArray(up.files) ? up.files[0]?.file_url : '');
  if (!batchId || !fileUrl) throw new Error(`上传链接响应异常: ${JSON.stringify(up).slice(0, 200)}`);
  const buf = fs.readFileSync(abs);
  // ⚠️ 绝不能带 Content-Type：OSS 预签名把 header 算进签名（带了 403 SignatureDoesNotMatch）
  const put = await fetch(fileUrl, {
    method: 'PUT',
    body: buf,
    signal: AbortSignal.timeout(Math.max(120000, Math.round(size / 20480))), // 20 KB/s 起步给足
  });
  if (!put.ok) {
    const t = await put.text().catch(() => '');
    throw new Error(`上传失败 HTTP ${put.status}: ${t.slice(0, 200)}`);
  }
  const marker = {
    batchId,
    pdf: abs,
    bytes: size,
    model: MODEL,
    state: 'submitted',
    submittedAt: Date.now(),
  };
  writeJson(path.join(outDir, 'online-task.json'), marker);
  return marker;
}

/** 轮询到 done，更新 marker；返回 {state, zipUrl, progress}。 */
async function poll(marker, outDir, onProgress) {
  const started = Date.now();
  let last = '';
  for (;;) {
    const data = await apiCall(`/api/v4/extract-results/batch/${encodeURIComponent(marker.batchId)}`);
    const list = Array.isArray(data.extract_result) ? data.extract_result : [];
    const one = list[0] || {};
    const state = String(one.state || 'unknown');
    const pr = one.extract_progress || {};
    // 2026-11-17 修：原先只在 state 变化时回调一次，抽取过程中 done 永远不动；
    // 现在页数变化也回调，并把真实页数交给上层，进度条才会走。
    const donePages = Number(pr.extracted_pages) || 0;
    const totalPages = Number(pr.total_pages) || 0;
    const key = `${state}|${donePages}`;
    if (key !== last) {
      last = key;
      onProgress({
        state,
        done: donePages,
        total: totalPages,
        note: `online ${state}${totalPages ? ` ${donePages}/${totalPages}` : ''}`,
      });
    }
    if (state === 'done') {
      const next = { ...marker, state: 'done', zipUrl: one.full_zip_url || '', doneAt: Date.now() };
      writeJson(path.join(outDir, 'online-task.json'), next);
      return next;
    }
    if (state === 'failed') {
      const next = { ...marker, state: 'failed', error: one.err_msg || 'unknown' };
      writeJson(path.join(outDir, 'online-task.json'), next);
      throw new Error(`MinerU 在线解析失败: ${one.err_msg || '未知原因'}`);
    }
    if (Date.now() - started > MAX_WAIT_MS) throw new Error(`等待在线解析超时（>${MAX_WAIT_MS / 60000} 分钟）`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** 下 zip 并解开；返回解压目录。 */
async function fetchZip(zipUrl) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mineru-online-'));
  const res = await fetch(zipUrl, { signal: AbortSignal.timeout(600000) });
  if (!res.ok) throw new Error(`下载结果包失败 HTTP ${res.status}`);
  const zip = path.join(tmp, 'r.zip');
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  const out = path.join(tmp, 'out');
  fs.mkdirSync(out, { recursive: true });
  // Windows 10+ 自带 tar（bsdtar）能解 zip，比手写 central directory 解析稳
  const r = spawnSync('tar', ['-xf', zip, '-C', out], { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) throw new Error(`解压失败: ${(r.stderr || '').slice(0, 200)}`);
  return { root: out, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

function findFile(dir, re) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(abs);
      else if (re.test(e.name)) return abs;
    }
  }
  return '';
}

/**
 * 只收集本次要的页里引用到的图片名，避免整本 images/ 全量复制。
 * 大文件整本 zip 的图像可能有上百 MB，单页 OCR 全量搬一遍纯属浪费（2026-11-13）。
 */
function neededImages(items, nums) {
  const want = new Set(nums);
  const set = new Set();
  for (const it of items) {
    const tp = it.type || 'text';
    if (tp !== 'image' && tp !== 'figure') continue;
    if (!want.has(Number(it.page_idx) + 1)) continue;
    const ref = String(it.img_path || '').trim();
    if (!ref) continue;
    set.add(ref.split('/').pop());
  }
  return set;
}

/** zip 里的 images/ 落到缓存目录，返回 {serverName → 本地绝对路径} 映射。 */
function relocateImages(root, outDir, needed = null) {
  const srcImg = findFileDirPath(root, 'images');
  if (!srcImg) return {};
  const dstImg = path.join(outDir, 'images');
  const map = {};
  try {
    fs.mkdirSync(dstImg, { recursive: true });
    for (const name of fs.readdirSync(srcImg)) {
      // 只搬这次真正引用到的图（needed 为 null 表示全搬，兼容 mineruParseFile 的整本场景）
      if (needed && !needed.has(name)) continue;
      const from = path.join(srcImg, name);
      if (!fs.statSync(from).isFile()) continue;
      const to = path.join(dstImg, name);
      fs.copyFileSync(from, to);
      map[name] = to;
      map['images/' + name] = to;
    }
  } catch {
    /* 图拷不出来不影响正文 */
  }
  return map;
}

function findFileDirPath(dir, name) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (e.name === name) return abs;
        stack.push(abs);
      }
    }
  }
  return '';
}

/** content_list → 每页 {text, markdown, blocks}。page_idx 是整本 0-based。 */
function splitByPage(items, imgMap) {
  const byPage = new Map();
  for (const it of items) {
    const idx = Number(it.page_idx);
    if (!Number.isFinite(idx)) continue;
    const num = idx + 1;
    const tp = it.type || 'text';
    let chunk = '';
    let imgFile = '';
    if (tp === 'equation') {
      const body = String(it.latex || it.text || '').trim();
      if (body) chunk = body.startsWith('$$') ? body : `$$\n${body}\n$$`;
    } else if (tp === 'table') {
      chunk = String(it.table_body || it.text || '');
    } else if (tp === 'image' || tp === 'figure') {
      const cap = Array.isArray(it.image_caption) ? it.image_caption.join(' ') : String(it.image_caption || '');
      const ref = String(it.img_path || '');
      imgFile = imgMap[ref] || imgMap[ref.split('/').pop()] || '';
      chunk = imgFile
        ? `![${cap || ref}](${imgFile})`
        : `[figure${cap ? ': ' + cap : ''}${ref ? ` — ${ref}` : ''}]`;
    } else {
      chunk = String(it.text || '');
    }
    if (!chunk) continue;
    if (!byPage.has(num)) byPage.set(num, { chunks: [], md: [], blocks: [] });
    const acc = byPage.get(num);
    acc.chunks.push(chunk);
    acc.md.push(chunk);
    acc.blocks.push({
      type: tp,
      label: LABEL[tp] || 'Text',
      // 2026-11-22：与本地通道同修——截断会让长表静默丢行列
      text: chunk,
      ...(imgFile ? { img_file: imgFile } : {}),
    });
  }
  const out = new Map();
  for (const [num, acc] of byPage) {
    out.set(num, {
      text: acc.chunks.join('\n\n'),
      markdown: acc.md.join('\n\n'),
      confidence: null,
      blocks: acc.blocks,
    });
  }
  return out;
}

/**
 * 整本在线解析，返回 `{results, failed}`（形状同 mineruBatch）。
 * 已缓存的页不重复请求；marker 里已有 done 任务且缓存齐全时直接命中。
 */
export async function mineruOnlineRun(abs, nums, outDir, opts = {}, onProgress = () => {}) {
  // force 必须重解析：只按页缓存判断会把 force 吞掉（2026-11-13 测试发现 doc_ocr/doc_formulas 的 force 都失效）
  const need = opts.force
    ? nums.slice()
    : nums.filter((n) => {
        const rec = readJson(path.join(outDir, `p${String(n).padStart(3, '0')}.json`));
        // schema 对不上等于没有缓存：旧版本的记录字段可能不同，复用会拿到半截数据（2026-11-13）
        return !rec || rec.schema !== PAGE_SCHEMA || !Array.isArray(rec.blocks) || !rec.blocks.length;
      });
  const failed = [];
  if (!need.length) {
    onProgress({ state: 'cached', note: 'online cached' });
  } else {
    const markerPath = path.join(outDir, 'online-task.json');
    let marker = readJson(markerPath);
    // force 要的是「重新解析」而不是「复用上次的结果包」——否则怀疑结果有问题时永远拿不到新数据
    if (opts.force) marker = null;
    // done 且有 zipUrl → 直接复用结果包（页缓存被清时不必重新解析整本）；失败过的重新提交一次
    if (marker && marker.state === 'failed') marker = null;
    if (!marker) {
      onProgress({ state: 'submitting', note: 'online submitting' });
      marker = await submit(abs, outDir);
    }
    const done = marker.state === 'done' && marker.zipUrl ? marker : await poll(marker, outDir, onProgress);
    if (!done.zipUrl) throw new Error('在线任务完成但没有 zip 链接');
    onProgress({ state: 'downloading', note: 'online downloading' });
    const { root, cleanup } = await fetchZip(done.zipUrl);
    try {
      const clPath = findFile(root, /content_list\.json$/i);
      if (!clPath) throw new Error('结果包里没有 content_list.json');
      const items = JSON.parse(fs.readFileSync(clPath, 'utf8'));
      const imgMap = opts.withImages ? relocateImages(root, outDir, neededImages(items, nums)) : {};
      const byPage = splitByPage(items, imgMap);
      const results = [];
      for (const n of nums) {
        const rec = byPage.get(n);
        if (rec && (rec.text || rec.blocks.length)) results.push({ ...rec, num: n, via: 'online' });
        else {
          results.push(null);
          failed.push({ page: n, error: 'page missing in online result' });
        }
      }
      onProgress({ state: 'parsed', note: `online parsed ${byPage.size} page(s)` });
      return { results, failed };
    } finally {
      cleanup();
    }
  }
  // 缓存命中路径
  const results = nums.map((n) => {
    const rec = readJson(path.join(outDir, `p${String(n).padStart(3, '0')}.json`));
    if (!rec) return null;
    return {
      num: n,
      text: rec.text || '',
      markdown: rec.markdown || rec.text || '',
      confidence: rec.confidence == null ? null : rec.confidence,
      blocks: rec.blocks || [],
      via: rec.via || 'cache',
    };
  });
  return { results, failed };
}

/**
 * 通用文档解析（0.5.0 doc_parse 用）：任意受支持格式 → markdown + content_list。
 *
 * 与 mineruOnlineRun 的差别：不分页、不写页缓存——直接把整份文件交上去，拿回 full.md。
 * 在线精准解析 API 支持 pdf / doc / docx / ppt / pptx / 图片(png jpg jpeg jp2 webp gif bmp) / html，
 * 上限 200 MB、600 页；本地开源版只吃 pdf 和图片，所以 docx/pptx 必须走这条。
 */
export async function mineruParseFile(abs, outDir, opts = {}, onProgress = () => {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const markerPath = path.join(outDir, 'online-task.json');
  let marker = readJson(markerPath);
  if (marker && marker.state === 'failed') marker = null;
  // 同一个 outDir 可能被复用（测试脚本、或调用方自己指定目录），marker 里记着 pdf 路径，对不上就重跑
  if (marker && marker.pdf !== abs) marker = null;
  // force 要重新上传重新解析，不能复用上次的结果包（2026-11-13 测试发现 doc_parse 的 force 也失效）
  if (opts.force) marker = null;
  if (!marker) {
    onProgress({ state: 'submitting', note: 'online submitting' });
    marker = await submit(abs, outDir);
  }
  const done = marker.state === 'done' && marker.zipUrl ? marker : await poll(marker, outDir, onProgress);
  if (!done.zipUrl) throw new Error('在线任务完成但没有 zip 链接');
  onProgress({ state: 'downloading', note: 'online downloading' });
  const { root, cleanup } = await fetchZip(done.zipUrl);
  try {
    const mdPath = findFile(root, /^full\.md$/i);
    const clPath = findFile(root, /content_list\.json$/i);
    let markdown = '';
    if (mdPath) markdown = fs.readFileSync(mdPath, 'utf8');
    let items = [];
    if (clPath) {
      try {
        items = JSON.parse(fs.readFileSync(clPath, 'utf8'));
      } catch {
        items = [];
      }
    }
    if (!markdown && !items.length) throw new Error('结果包里既没有 full.md 也没有 content_list.json');
    let imgMap = {};
    if (opts.withImages) imgMap = relocateImages(root, outDir);
    // 图片只有在 withImages 时才真落盘。不开的时候 full.md 里的 ![](images/xxx)
    // 会指向一个不存在的文件——改写成明确的「未提取」标注，免得下游以为图就在那。
    // （2026-11-14 试用 doc_parse 转 pptx 时发现：figure 计数 8，doc 目录只有两个 json）
    if (/\]\(images\//.test(markdown)) {
      if (opts.withImages) {
        markdown = markdown.replace(/\]\(images\/([^)]+)\)/g, (m, name) => {
          const hit = imgMap['images/' + name] || imgMap[name];
          return hit ? `](${hit.replace(/\\/g, '/')})` : `](images/${name})`;
        });
      } else {
        markdown = markdown.replace(
          /!\[([^\]]*)\]\(images\/([^)]+)\)/g,
          (m, alt, name) => `[figure: ${alt || name} — images/${name} (not extracted; pass withImages=true)]`,
        );
      }
    }
    const counts = { text: 0, equation: 0, table: 0, image: 0 };
    let maxIdx = -1;
    for (const it of items) {
      const t = it.type || 'text';
      if (counts[t] !== undefined) counts[t] += 1;
      const idx = Number(it.page_idx);
      if (Number.isFinite(idx) && idx > maxIdx) maxIdx = idx;
    }
    onProgress({ state: 'parsed', note: 'online parsed' });
    return { markdown, items, pages: maxIdx + 1, counts, marker: done };
  } finally {
    cleanup();
  }
}
