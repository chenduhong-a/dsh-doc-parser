import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 数据根目录：优先 PDF_READER_DATA，其次 $DSH_HOME\storages\pdf-reader。 */
export function dataRoot() {
  if (process.env.PDF_READER_DATA) return process.env.PDF_READER_DATA;
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'storages', 'pdf-reader');
}

/** 首尾各 4 KB 的指纹：size 与 mtime 都没变时，用它判断文件真的没被改（2026-11-22 审计）。 */
function edgeFingerprint(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const st = fs.fstatSync(fd);
    const n = Math.min(4096, st.size);
    const head = Buffer.alloc(n);
    fs.readSync(fd, head, 0, n, 0);
    h.update(head);
    if (st.size > n) {
      const tail = Buffer.alloc(n);
      fs.readSync(fd, tail, 0, n, Math.max(0, st.size - n));
      h.update(tail);
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex').slice(0, 16);
}

/** 流式计算文件 SHA-256。 */
export function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(65536);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/**
 * 带索引的哈希：同一路径若 size 与 mtime 都没变，直接复用上次的结果。
 * 大 PDF 每次调用都重算整份 SHA-256 是白付——实测 140 MB 153 ms、572 MB 572 ms、
 * 712 MB 712 ms（约 1 秒/GB），而工具每次调用都会走 prepare()。
 */
export function sha256Cached(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return sha256File(file);
  }
  const idxFile = path.join(dataRoot(), 'hash-index.json');
  const idx = readJson(idxFile) || {};
  const hit = idx[file];
  const mtimeMs = Math.round(st.mtimeMs);
  if (hit && hit.size === st.size && hit.mtimeMs === mtimeMs) {
    // 同毫秒内改写且大小不变会复用旧 hash（2026-11-22 审计），再对一次首尾指纹
    if (!hit.fp || hit.fp === edgeFingerprint(file)) return hit.hash;
  }
  const hash = sha256File(file);
  idx[file] = { size: st.size, mtimeMs, hash, fp: edgeFingerprint(file), at: Date.now() };
  let keys = Object.keys(idx);
  if (keys.length > 2000) {
    keys.sort((a, b) => (idx[a].at || 0) - (idx[b].at || 0));
    for (const k of keys.slice(0, keys.length - 1500)) delete idx[k];
    keys = null;
  }
  try {
    fs.mkdirSync(dataRoot(), { recursive: true });
    writeJson(idxFile, idx);
  } catch {
    /* 索引写失败不影响正确性，下次重算 */
  }
  return hash;
}

/** 按 PDF 内容哈希取缓存目录（前 16 位），并刷新 .last 访问时间。 */
export function cacheDirFor(hash, create = true) {
  const dir = path.join(dataRoot(), hash.slice(0, 16));
  if (!create) return dir;
  fs.mkdirSync(path.join(dir, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'ocr'), { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, '.last'), String(Date.now()));
  } catch {
    /* 只读缓存目录可忽略 */
  }
  return dir;
}

/** 读/写缓存 JSON。 */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  fs.renameSync(tmp, file);
}

/** 简单的 LRU 清理：按 .last 时间从旧到新删，直到总量低于上限。 */
export function lruCleanup(maxBytes = 500 * 1024 * 1024) {
  const root = dataRoot();
  if (!fs.existsSync(root)) return 0;
  const entries = [];
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    let st;
    try {
      st = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    let bytes = 0;
    const walk = (d) => {
      let items = [];
      try {
        items = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const it of items) {
        const p = path.join(d, it.name);
        if (it.isDirectory()) walk(p);
        else {
          try {
            bytes += fs.statSync(p).size;
          } catch {
            /* ignore */
          }
        }
      }
    };
    walk(dir);
    let last = 0;
    try {
      last = Number(fs.readFileSync(path.join(dir, '.last'), 'utf8')) || st.mtimeMs;
    } catch {
      last = st.mtimeMs;
    }
    entries.push({ dir, bytes, last });
  }
  let total = entries.reduce((a, e) => a + e.bytes, 0);
  let removed = 0;
  entries.sort((a, b) => a.last - b.last);
  for (const e of entries) {
    if (total <= maxBytes) break;
    try {
      fs.rmSync(e.dir, { recursive: true, force: true });
      total -= e.bytes;
      removed += e.bytes;
    } catch {
      /* ignore */
    }
  }
  return removed;
}
