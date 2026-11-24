// 整本预跑：分批走 pdf_ocr_page(engine=mineru)，把每页结果写进插件缓存。
// 跑完之后任意页查询都直接命中本地缓存（毫秒级），不用再上传整本 PDF。
//
// 用法（ELECTRON_RUN_AS_NODE=1 时用桌面版 exe 当 node）：
//   node prefetch_book.mjs <pdf> [--pages 1-597] [--batch 40] [--total N] [--with-images]
// 进度/大纲写在 %TEMP%\dsh-pdf-prefetch\<hash>.json，可以随时重跑（已缓存的页会跳过）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const pdfArg = argv.find((a) => !a.startsWith('--'));
if (!pdfArg) {
  console.log('usage: node prefetch_book.mjs <pdf> [--pages 1-597] [--batch 40] [--total N] [--with-images]');
  process.exit(2);
}
const optOf = (name, def) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const PDF = path.resolve(pdfArg);
const batchSize = Math.max(1, Math.min(Number(optOf('batch', 40)) || 40, 40));
// 实测（2026-10-24）：3 路并发跑 8 页 25 秒，串行跑 8 页 22 秒——服务端其实是顺序处理的，
// 并发只会多传几份 37MB PDF，没有收益。所以默认 1（串行）；想自己试验再显式传 --concurrency。
const concurrency = Math.max(1, Math.min(Number(optOf('concurrency', 1)) || 1, 4));
const withImages = argv.includes('--with-images');

const mod = await import('file:///C:/deepseek/tools/dsh-doc-parser/lib/main.js');
const tools = [];
mod.apply({ tools: { register: (t) => tools.push(t) } });
const ocrTool = tools.find((t) => t.name === 'pdf_ocr_page');
const infoTool = tools.find((t) => t.name === 'pdf_info');

const metaDir = path.join(os.tmpdir(), 'dsh-pdf-prefetch');
fs.mkdirSync(metaDir, { recursive: true });
const metaFile = path.join(metaDir, crypto.createHash('sha1').update(PDF).digest('hex').slice(0, 12) + '.json');

function parseSpec(spec, total) {
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const s = part.trim();
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(s);
    if (m) {
      for (let i = Number(m[1]); i <= Number(m[2]); i += 1) out.add(i);
    } else if (/^\d+$/.test(s)) {
      out.add(Number(s));
    }
  }
  return [...out].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
}

async function main() {
  const infoRaw = await infoTool.execute({ path: PDF });
  const infoStr = typeof infoRaw === 'string' ? infoRaw : JSON.stringify(infoRaw);
  const m = /(?:^|\n)pages:\s*(\d+)/i.exec(infoStr) || /"numPages"\s*:\s*(\d+)/.exec(infoStr);
  const total = Number(optOf('total', 0)) || (m ? Number(m[1]) : 0);
  if (!total) {
    console.log('ERR 拿不到总页数，请用 --total N 指定。info 片段：' + infoStr.slice(0, 160).replace(/\s+/g, ' '));
    process.exit(3);
  }
  const nums = parseSpec(optOf('pages', `1-${total}`), total);
  const meta = {
    pdf: PDF,
    total,
    requested: nums.length,
    engine: 'mineru',
    withImages,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    done: 0,
    failures: [],
    outline: [],
    batches: [],
  };
  const flush = () => fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8');
  flush();
  console.log(`pdf ${PDF}\ntotal ${total} pages, target ${nums.length}, batch ${batchSize}, concurrency ${concurrency}\nmeta ${metaFile}`);

  const t0 = Date.now();
  // 服务端日志写着 "Request concurrency limited to 3"——串行跑是浪费，默认 3 路并发
  const tasks = [];
  for (let i = 0; i < nums.length; i += batchSize) tasks.push(nums.slice(i, i + batchSize));
  let cursor = 0;
  const runTask = async () => {
    while (cursor < tasks.length) {
      const slice = tasks[cursor];
      cursor += 1;
      // 用逗号列表而不是「首-尾」区间：稀疏选页（--pages 2,5）会被拼成 2-5，白跑 p3/p4（2026-11-09 发现）
      const spec = slice.join(',');
      const bt = Date.now();
      let out = '';
      try {
        const r = await ocrTool.execute({ path: PDF, pages: spec, engine: 'mineru', withImages });
        out = typeof r === 'string' ? r : JSON.stringify(r);
      } catch (e) {
        meta.failures.push({ spec, error: String(e && e.message ? e.message : e) });
        flush();
        console.log(`  batch ${spec} FAILED: ${e && e.message ? e.message : e}`);
        continue;
      }
      const secs = ((Date.now() - bt) / 1000).toFixed(1);
      // 从页头抓 Section-Header 标题，攒成大纲
      const pageRe = /==========\s*PAGE\s+(\d+)[^\n]*\n(\[blocks: ([^\]]*)\])?([\s\S]*?)(?=\n==========\s*PAGE\s+\d+|$)/g;
      let pm;
      while ((pm = pageRe.exec(out))) {
        const pnum = Number(pm[1]);
        const body = pm[4] || '';
        if (body.length < 20) continue;
        const head = body.split('\n').find((line) => line.trim().length >= 4 && line.trim().length <= 80);
        if (head && /^(第.+章|§|Chapter|\d+\.\d+)/.test(head.trim())) {
          meta.outline.push({ page: pnum, title: head.trim().slice(0, 80) });
        }
      }
      meta.done += slice.length;
      meta.batches.push({ spec, secs: Number(secs), pages: slice.length });
      flush();
      const pct = ((meta.done / nums.length) * 100).toFixed(1);
      console.log(`  batch ${spec} ${secs}s (${meta.done}/${nums.length}, ${pct}%)`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => runTask()));
  meta.finishedAt = new Date().toISOString();
  meta.totalSecs = Math.round((Date.now() - t0) / 1000);
  meta.outline.sort((a, b) => a.page - b.page);
  flush();
  console.log(`\nDONE ${meta.done} pages in ${meta.totalSecs}s, failures ${meta.failures.length}, outline ${meta.outline.length} entries`);
  console.log(`meta ${metaFile}`);
}

await main();
