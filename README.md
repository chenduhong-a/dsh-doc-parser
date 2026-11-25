# dsh-doc-parser（自用 · P1 阶段）

> **改名说明（2026-11-13）**：本包从 `dsh-pdf-enhanced` 重写而来，P1 阶段先把 PDF 六个工具搬过来并把工具名统一成 `doc_*`；下文历史章节里出现的 `pdf_info` / `pdf_extract_text` / `pdf_render_page` / `pdf_ocr_page` / `pdf_tables` 分别对应现在的 `doc_info` / `doc_text` / `doc_render` / `doc_ocr` / `doc_tables`。Office 与公式通道在 P2、P3 接入。
> 
> DeepSeek Harness 的 PDF / 文档处理工具插件。host 半提供工具与进度接口，client 半在侧栏显示 OCR 进度；本地处理为主，但 `doc_parse` 与「在线模式」（插件根目录 `mineru-mode.txt` 写 `online`，或环境变量 `MINERU_MODE=online`）会把文件上传到 mineru.net。

## 工具

| 工具 | 能力 |
|---|---|
| `doc_info` | 页数、每页尺寸、文本密度/图片数、扫描页判定、元数据、目录/书签；`cacheAction=stats\|clear\|prune` 管缓存 |
| `doc_text` | 按页提取文本；`pages="1-3,5"` 分块；`withPosition` 附行坐标与字号 |
| `doc_render` | 渲染页面为 PNG（默认 scale 2.5），返回本地路径；单次上限 50 页，超出会明确提示 |
| `doc_ocr` | 对扫描页 OCR：**文本层优先**（有文字层直接读，0.3 秒）；**默认且唯一 MinerU 4.2.3**（公式→LaTeX、表格→HTML、图片裁切，走 GPU，首次加载约 80 秒）；`engine` 只有 `mineru` 一个合法值（Indra 兜底已于 2026-11-18 移除，失败直接报错）；默认只处理判定为扫描的页，`force=true` 强制；`prefetch=true` 后台整本预跑，`exportImages=true` 把图统一导出到 `figures/` |
| `doc_tables` | 坐标启发式表格 → TSV（`engine=mineru` 时可出真 HTML 表格）；列数不一致时标注低置信度；相邻页首行相同会标注「续表」；`maxMineruPages`（默认 24）限制一次调用最多让多少页进 MinerU |

| `doc_parse` | 通用文档解析：pdf / doc / docx / ppt / pptx / 图片 / html 交给 mineru.net，返回 markdown（公式 LaTeX、表格 HTML）；**文件会上传**，需要 token；按文件内容缓存，重复调用 0 成本 |
## 数据目录

`$DSH_HOME\storages\pdf-reader\`（可用环境变量 `PDF_READER_DATA` 覆盖）：

```
hash-index.json               # 路径+大小+mtime → sha256 的索引（大文件免重复哈希）
<sha256前16位>\info.json      # pdf_info 缓存
<sha256前16位>\pages\pNNN.png # 渲染产物
<sha256前16位>\ocr\pNNN.json  # OCR 缓存（跨会话共享，带 schema 版本）
<sha256前16位>\ocr\progress.json # 整本 OCR / prefetch 的进度
<sha256前16位>\figures\      # exportImages=true 导出的图片
```

缓存上限 500 MB，按 `.last` 访问时间 LRU 清理（也可 `pdf_info cacheAction="prune"` 手动触发）。

## 实现要点

- 用 `node:fs` 直接读绝对路径（0.2.1 内核的 `ctx.fs` 不支持 `readBytes`）。
- pdfjs-dist 用 `legacy/build/pdf.mjs`，cmaps / standard_fonts 从包内解析。
- 文本提取沿用 `_pdftest/dump.mjs` 的行/空格启发式。
- OCR 只有一条路：**MinerU 4.2.3**（公式→LaTeX、表格→HTML、图落成真实文件，走 GPU）。MinerU 用独立 venv（默认 `C:\deepseek\tools\mineru4-venv`，可用 `MINERU_VENV` 覆盖）；插件自带的 `ocr-venv` 与 **Indra 备用通道已于 2026-11-18 移除**（用户拍板，用不上），MinerU 失败现在直接报错、不再静默降级成纯文本。
- **4.x 起是两个常驻进程**：`mineru-api.exe`（18000，只有异步 `/v1/tasks`）与 `mineru-kit file-parse-server --api-url http://127.0.0.1:18000`（18001，提供同步 `/v1/file_parse`）。插件 `startMineruApi()` 首次调用时把两个都拉起来并等端口；`MINERU_FP_PORT` 可改第二个端口。`MINERU_TELEMETRY_DISABLED=1` 已在 spawn 环境里写死（4.x 默认开遥测）。
- **实测（2026-11-09，`kittel_20p.pdf` 前 3 页）**：
  - **文本层优先**：pdfjs 取到 ≥40 字直接返回（`engine=text`，100%），0.38 秒；
  - **MinerU 3.4.5**（历史记录，2026-11-25 已换 4.2.3）：3 页 77 秒（含首次模型加载，之后很快——OCR 138 块仅 0.75 秒），content_list 50 项（text 33 / equation 8 / image 2 / chart 1 / page_number 3 / header 3），**8 个公式块全部 LaTeX**（含 `\frac`、`\int`、`\hbar`、`\tag{73}`），行内公式同样是 LaTeX，图片落成 jpg 并带真实路径，中文准确；
  - **MinerU 4.2.3**（当前，2026-11-25 实测同一份 49 页物理论文）：`tier=basic` 首轮 **82.6 秒**（含载模型）、3 页热态 **2.6–3.9 秒**；返回 zip 里 `structured_content.json` 按页分组 49 页 / 336 块（text 164 / equation 90 / page_number 46 / paragraph_title 36），**公式块的 `content` 就是 LaTeX**，图片是 `images/page_<n>_equation_<k>.jpg`（91 张，不再是 base64 data URI）；注意 block 字段统一成 `content` + `image_source`，3.x 的 `text`/`latex`/`table_body`/`img_path` 都没了；
  - ~~Indra~~ 已于 2026-11-18 移除（见文末第十四轮）；旧缓存里 `engine=indra` 的记录仍可读，但不再产生新记录；
  - **RapidOCR 已于 2026-10-24 移除**（用户拍板）；`engine` 参数现在只剩 `mineru` 一个合法值。
- OCR 结果按页缓存在 `<data>\<hash>\ocr\pNNN.json`（含 `engine` 字段；切换引擎会重识别），跨会话共享（`$DSH_HOME\storages\pdf-reader`），命中即跳过识别。
- 渲染比例固定 1.5 倍：与 2.5 倍精度持平（封面 99.2 vs 99.1），速度快约 3 倍。
- MinerU 的 venv 另装（4.x 基础版不带 torch，走 `onnxruntime-directml`，GPU 直接可用）：

```sh
pip install "mineru>=4.0,<5"
mineru-models-download --tier basic --small-backend onnx --source modelscope
```

  4.x 的模型不再落 `.cache\modelscope`，改放 `C:\Users\<用户>\.mineru`（basic 档 13 文件 / 839.3 MB）。旧 venv（`C:\deepseek\tools\mineru3-test\venv`，6.6 GB）与旧模型（`.cache\modelscope` 下 1180.2 MB）已不再被代码引用；3.4.5 的包清单备份在 `C:\deepseek\tools\mineru3-test\freeze-before-345.txt` 与 `C:\deepseek\work\handover\mineru-3.4.5-freeze.txt`。
- **注意（2026-11-09 已修正的旧结论）**：`onnxruntime 1.31` 曾在本机 Python 3.12 上 `0xC0000005` 崩溃——根因是**系统 VC 运行时被旧程序覆盖**（`System32\vcruntime140.dll`、`msvcp140.dll` 停在 14.00.24215.1，而 redist 装的是 14.51.36247），用 Package Cache 里的原包跑 `VC_redist.x64.exe /repair /quiet /norestart` 修好后，1.31 已可正常 import。这条只对已移除的 Indra 通道有意义，留作历史记录。
- 工具用原生对象 + `ctx.tools.register`，不依赖 `@deepseek-ai/dsh-tools`。
- **扫描件渲染回退**：pdfjs 缺 CCITT/JBIG2 解码器，会把这类页面渲染成纯白图；`pdf_render_page` 渲染后检测纯白（非白像素 <0.1%），自动改用 **PDFium（`pypdfium2`）** 重渲（`lib/render_pdfium.py`），`pdf_ocr_page` 复用同一结果。兜底解释器现在只用 MinerU 的 venv（它自带 `pypdfium2`），插件不再自带 venv。

## 2026-11-09 第二轮优化（D/E/F 组）

- **D1 哈希索引**：`sha256Cached()` 用「路径+大小+mtime」索引，命中就直接用上次的哈希。实测 572 MB 课件 冷 408 ms → 热 0 ms（PDF 哈希约 1 秒/GB，每次调用都重算是白付）。
- **D2 探页并发**：`pdf_info` 探 300 页从串行改并发 6 路。
- **D3 取页/渲染并发**：`pdf_extract_text` 4 路、`pdf_render_page` 2 路（渲染吃内存，所以压低）。
- **E1 截断明说**：`pdf_render_page` 单次上限 50 页，超出会在输出里写清「rendered 50 of N」并给出下一次的页码区间。
- **E2 缓存 schema**：页缓存写 `schema: 2`；读取时老记录按旧规则兼容，只拒绝「比本插件还新」的记录，避免升级后读到结构不认识的数据。
- **E3 缓存管理**：`pdf_info` 新增 `cacheAction`——`stats`（这本占多少、全局占多少）、`clear`（删这本，需 `confirm`）、`prune`（全局 LRU 到 500 MB，需 `confirm`）。
- **E4 失败定位到页**：MinerU 改成 12 页一块调度；某块失败会逐页重试，最终把具体失败页号连同错误写进输出与 stderr，不再只有一句 `batch failed`。
- **E5 进度可见**：分块调度与 prefetch 都会写 `ocr/progress.json`（total / done / failed / startedAt）。
- **F1 整本找表有闸**：`pdf_tables` 的 `maxMineruPages`（默认 24）超出的页标 `skipped`，不再悄悄把整本扫描书送进 OCR。
- **F2 续表标注**：相邻两页 HTML 表首行相同 → 后一页标 `[continues table from pN]`（只标注不合并，避免拼错）。
- **F3 图片一次导出**：`pdf_ocr_page exportImages=true` 把本次页缓存里的图统一拷到 `<cache>/figures/` 并列出路径。
- **F4 整本预跑有入口**：`pdf_ocr_page prefetch=true` 后台跑整本、立即返回；同一 PDF 重复调用会提示「已在跑」。

## 2026-11-09 第三轮：独立测试发现的 12 个 BUG

测试由另一个 agent 独立跑（黑盒调工具 + 白盒 `import` 后直接 `execute`），证据留 `work\_pdfbug\REPORT.md`。修完实测：

- **prefetch 结果其实没落盘**（严重）：后台 IIFE 把 `mineruBatch()` 返回的 `results` 丢了，只写了 `progress.json`，页缓存一个文件都没写，返回文案却还说「results land in the page cache」；之后单页调用又重跑一次（2131 ms）。现在 `mineruBatch` 的元素带 `num`，`writeMineruPageCache()` 把结果按页写盘 —— 实测 prefetch 3–4 页后 `p003.json`/`p004.json` 出现，单页调用 **38 ms** 命中。
- **图片永远拿不到**：API 的 images 键是裸文件名，`content_list` 的 `img_path` 带 `images/` 前缀，`imgFiles` 只登记了一种键 → `img_file` 恒为空（图其实已落盘）。现在登记三种键并在读取时回退 basename —— 实测缓存记录里 `img_file` 有 2 条。
- **tables 旧记录既不用也不换**：非 mineru 记录（旧的 text 记录）被忽略却永不覆盖，同一页每次调用都重跑 GPU（2.0–2.5 秒/页）。改成「非合格 mineru 记录就覆盖」—— 实测同一份 PDF 第二次 **5 ms**，内容一致。
- **`pdf_info` 的 `probeLimit` 不进缓存键**：一次 `probeLimit:1` 就把「全书只有 1 页是扫描页」钉死。现在 `probeLimit` 写进 `info.json`，浅探测后再来全量会重算 —— 实测 probe1 报 1 页、probe50 报 20 页。
- **正文被当成表格**：坐标启发式对双栏正文会切出 6 列，且永不回退 MinerU。门控加 `lowConfidence || (maxCols>=4 && avgRowChars>90)`。
- **`force` 是空开关**：schema 与文案里都有，代码里从没读过。现在缓存命中、文本层短路两处都要 `!force`。
- **render 续页提示用数量当页码**：改成列真实未渲染页码（实测 `not rendered: 51,52,…,60`）。
- **`pdf_extract_text` 静默输出空**：扫到扫描页、页码超界、语法错都返回空串。现在分别给 `no text layer on pages=… use pdf_ocr_page`、`no pages matched …`。
- **信任未来 schema**：`pdf_tables` 读到 `schema:99` 也照用，现在拒绝比 `CACHE_SCHEMA` 新的记录。
- **MinerU 挂了谎报「无表」**：异常被 `catch {}` 吞掉。现在留痕并输出 `(MinerU unavailable, page not checked: …)`。
- **prefetch 不过滤、也不认 `pages`**：现在只排扫描页（`probePage().scanned`）并遵守传入的页码范围。
- **`cacheAction=stats` 有副作用**：`prepare()` 会建缓存目录。现在 `prepare(file, create)` + `cacheDirFor(hash, create)` 双开关 —— 实测 stats 前后目录都不存在。

## 2026-11-09 第四轮：输出层的三处打磨（用户提的）

1. **扫描页列表压成区间**：以前 `scanned pages: 1, 2, 3, … 300` 逐页列出，597 页的书一次要 1.5K token 全是数字。现在走 `fmtRanges()`——连续段写成 `1-300`、离散段写 `1-5, 9, 12-20`，整本都扫描时写 `all 597`，后面只跟一个总数 `(597 page(s))`。
2. **没导出的图不再写悬空路径**：`withImages=false` 时 markdown 里以前仍写 `![](images/xxx.jpg)`，文件其实不存在，读的人会以为能直接打开。现在写成 `[figure: 图注 — images/xxx.jpg (not extracted; re-run with withImages=true)]`，一眼看出要不要重跑。
3. **版本号补上**：描述里早就写着 MinerU 3.4.5，`version` 却停在 `0.1.0`。升到 **0.2.0**（三轮优化 + 17 个 BUG 修复 + 本轮输出打磨），以后回滚或分发好认。

`lib/main.js` 1326 行 / SHA256 前缀 `27E7F29654BFF82E`。

## 2026-11-11 第五轮：侧栏 OCR 进度条（0.3.0）

以前 OCR 只能干等：`pdf_ocr_page` 阻塞到全部完成，进度只写进缓存目录的 `ocr\progress.json`，不主动去读文件就看不到。本版把它搬进界面：

- **宿主半体**：`mineruBatch` 每写完一块 `progress.json`，同步更新模块级 `OCR_PROGRESS` 内存快照（跑完保留 60 秒再清）；新增 `GET /plugins/dsh-pdf-enhanced/api/progress`，只回环 Host、只回 JSON，用 `ctx.webServer.register({ kind: 'prefix', path })` 注册，`inject` 增加 `webServer`。
- **客户端半体**（`client.js`，新增）：`sidebar.footer.action` 有任务时才渲染「3/48」与细进度条，没任务不占位；点开 `shell.overlay` 浮层显示逐任务进度、已用时间、预计剩余、失败页与缓存目录，每 2 秒轮询一次。不 require 任何 `@deepseek-ai/dsh-client-*`，只从 module table 取 React。
- **包声明**：`exports["./client"]` 指向新文件，`dsh.client = { platform: 'web', immediately: true, inject: ['@deepseek-ai/dsh-client-ui-sidebar'] }`。

覆盖范围：前台 `pdf_ocr_page`、后台 `prefetch`、以及 `pdf_tables` 的 MinerU 兜底都走 `mineruBatch`，三种入口都会出现在侧栏。

## 2026-11-11 第六轮：按页截断与 MinerU 空页重试（0.3.1 / 0.3.2）

反馈来自另一个会话的实测：一次 40 页 OCR，返回被字符级 `slice` 截到约 12 页，后面的页静默消失，只在末尾留一行 `[note: output truncated at 12000 chars]`——很容易被当成「已经跑完」，于是带着错的批大小白跑了两整轮。

改法：新增 `clampByPages(blocks, limit, nums)`，`pdf_extract_text` / `pdf_ocr_page` / `pdf_tables` 三处出口都换过去：

- 只在**页与页之间**切，不再把某页正文切成两半；
- 提示移到**开头**并写清区间：`[pages 1-14 of 1-40 returned (14/40); 26 page(s) not shown — call again with pages="15-40"]`；
- 只有单页就超预算时才退回字符级截断（末尾 `[page truncated]`）；
- OCR 的 figures / mineruFailed 尾巴单独拼接，不占正文预算。

实测：40 页 × 800 字符、预算 12000 → 返回 14 个完整页块、总长 11870，第一行就是区间提示。

同一份反馈还有第二半：她 40 页只回 186 页内容、20 页每批只回 10 页。查下来是 MinerU 服务端的批量上限——返回 HTTP 200，但 `content_list` 只覆盖一部分页。旧代码把这些空页当成「这页没字」静默写进结果，于是看起来「跑完了」，实际少了一截。现在两处收紧：

- `mineruBatch` 的 `CHUNK` 从 12 降到 **10**（可用环境变量 `MINERU_CHUNK` 覆盖）；
- 每批回来先查空页（`text` 与 `blocks` 都为空），挑出来**逐页重试一次**；仍然空就记进 `failed`，最终出现在输出的 `[note: N page(s) failed on MinerU: p…]` 里，不再静默消失。

## 第七轮：MinerU 官方在线 API（0.4.0）

本地 MinerU 要占 GPU、还得维护那套 venv；官方在线 API（mineru.net）是另一条路：PDF 传上去、云端解析、结果打包回来。2026-11-13 接上，新增 `lib/mineru-online.js`。

**怎么开**（两个来源，文件优先）：

- 插件根目录的 `mineru-mode.txt` 写 `local` 或 `online`（一行）。**每次调用重读，改完下一次 `doc_ocr` 即生效，不用重启宿主。**
- 没有那个文件时看 `MINERU_MODE` 环境变量：`online` 强制在线、`local` 强制本地、不设则本地 venv 在就走本地、不在且有 token 才走在线。

2026-11-25 加文件这一层，是因为 Windows 改用户级环境变量只写注册表、**不刷新已运行的 explorer**，宿主重启后继承的仍是旧快照——当天 23:15 把 `MINERU_MODE` 改成 `local`、23:19 重启宿主，进程里读到的还是 `online`，差一步又把 PDF 传了上去。

**token**：单行写进 `C:\deepseek\tools\.mineru-token`，或设 `MINERU_API_TOKEN`。别贴聊天、别写进命令行。

**流程**（与本地同步 `/file_parse` 完全不同）：

1. `POST /api/v4/file-urls/batch` 拿 `batch_id` 与上传 URL；
2. `PUT` 原始字节——**不能带 Content-Type**（OSS 预签名把它算进签名，带了返回 403 `SignatureDoesNotMatch`）；
3. 轮询 `GET /api/v4/extract-results/batch/{batch_id}`，`state` 走 waiting-file → pending → running → converting → done；
4. `full_zip_url` 下 zip，解出 `*_content_list.json`，按 `page_idx`（整本 0-based）拆页。

**缓存策略**：整本提交一次，结果按页写进现有页缓存（`engine:'mineru'`、`via:'online'`），所以第一次慢（等整本解析完），之后都是缓存命中；zip 链接记在 `online-task.json`，页缓存被清时直接重下 zip 而不重新提交。实测 0.11 MB / 3 页：首次 13.9 秒，二次 0.3 秒。

**代价**：PDF 会上传到 mineru.net（本地通道不会）；额度按账号计；token 90 天要重建。

## 第八轮：doc_parse 通用文档解析（0.5.0）

在线精准解析 API 支持 PDF 之外的格式，于是加了一个「整份转 markdown」入口——不复用页级工具，因为 docx/pptx 没有「页」的概念。

- 支持后缀：`.pdf .doc .docx .ppt .pptx .png .jpg .jpeg .jp2 .webp .gif .bmp .tiff .html`；服务端上限 200 MB / 600 页。
- 走 mineru.net（不是本地）：token 取 `MINERU_API_TOKEN` 或 `C:\deepseek\tools\.mineru-token`；**文件会上传**。
- 返回 `full.md` 加一行计数头：`== <文件名> — N page(s), text X / formula Y / table Z / figure W (cached|parsed in Ns, uploaded)`。
- 缓存在 `<data>\<hash>\doc\parsed.json`，同一文件重复调用 0 成本；`force:true` 强制重跑。
- 超过 `maxChars`（默认 20000）按行截断，其余留在缓存文件里，提示给出路径。

实测（2026-11-13）：

| 输入 | 页 | 用时 | 文本块 | 公式块 | 结论 |
| --- | --- | --- | --- | --- | --- |
| `ch05_s02.pdf`（群论讲稿，矢量公式） | 3 | 9.7s | 6 | **6** | 公式全部出 LaTeX（`\begin{array}`、`\vec{r}`、`R^{-1}`） |
| `高等量子力学__高量1-矢量空间.pptx` | 54 | 10.3s | 439 | **0** | 章节与要点正确，公式全丢 |

**重要限制**：pptx 里的公式是 MathType OLE 嵌入对象，在线通道转换时只取文本层，公式位置留空（原文形如「并把            记为」）。这类课件要用 `doc_formulas`（action=extract）：LibreOffice 转 PDF 后逐页 OCR，公式会以 LaTeX 返回（实测高量1：67 个公式 / 32 页 / 40.8 秒）。PDF 因为逐页渲染看图，公式质量反而好。

## 第九轮：P2 Office OOXML 直读（0.2.0）

新包 `dsh-doc-parser` 起，`doc_info` / `doc_text` / `doc_tables` 直接读 docx / pptx / xlsx，不走 pdfjs、不联外网：

- 解包用零依赖 zip 读取（store/deflate，`lib/formats/ooxml.js`），XML 用正则取 `<w:t>` / `<a:t>` / `<v>`。
- `doc_info` 报 kind / slides|paragraphs|sheets / 文本字符数 / 媒体文件数 / 有无表格 / 有无公式 / MathType OLE 个数。
- `doc_text` 按 SLIDE / PARA / SHEET 分块；xlsx 输出 TSV 行。
- `doc_tables` 读 xlsx 每 sheet 的单元格、docx 的 `w:tbl`、pptx 的 `a:tbl`。
- pptx 的 MathType 公式仍是 OLE 嵌入对象，文本层空白——`doc_info` 会明确报 OLE 个数并提示走公式通道。

实测（2026-11-13）：高量1-矢量空间.pptx → 54 slides / 6616 字符 / 319 媒体 / 360 OLE；测试 docx → 6 段 + 2×2 表格；测试 xlsx → 2 sheet 的 TSV 全对。

## 第十轮：doc_formulas 改用 LibreOffice + OCR（0.3.0）

第一版把 `dsh-pptx-formula` 的 WMF 抽图搬了过来，实测发现两条路差别很大：

- **直接抽 WMF/EMF 用 System.Drawing 渲染**：对「第四章第一节」这类公式靠字体渲染的 pptx，10 个图里 9 个变成乱码字形（MT Extra / Symbol 在 WMF 的文本记录里不生效，只有内嵌了说明文字的那一个正常）。高量1 那种在线化的矢量图没问题，但不能赌。
- **LibreOffice 渲染成 PDF + OCR 识别公式块**：同一份文件转换 3.9 秒、整份识别 30.9 秒，得到 **54 个公式 / 19 页**，全是正常 LaTeX（`\begin{array}`、`\varphi^i`、`\tag{2}`）。

所以 `doc_formulas` 现在是：

| action | 做什么 |
| --- | --- |
| `scan`（默认） | 读 pptx 结构：幻灯片数、oleObject 数、WMF/EMF 数、每页分布。不解压不渲染，用来判断值不值得跑 extract |
| `extract` | LibreOffice 转 PDF（缓存）→ 逐页 OCR → 只回公式块（LaTeX，带页号） |
| `stats` | 该文件的公式缓存大小 |
| `clean` | 删该文件的公式缓存（需 confirm=true） |

`extract` 走的是 OCR 通道：`MINERU_MODE=online` 时上传到 mineru.net，否则用本地 GPU。PDF 缓存在 `<data>/<hash>/formula/<name>.pdf`，页缓存在 `<data>/<hash>/formula/ocr/`。

旧的 WMF 抽图实现（`extractDeck` + `to_png.ps1`）已于 2026-11-14 删除——乱码率太高，留着只会误导。`lib/formulas/mathtype.js` 现在只保留 scan 用的 deck 解析与 LibreOffice 转换。

## 第十一轮：四个轻级 bug 修复（0.3.2）

pdf-tester 报的 15 个问题里最后四个已经修掉：

| 编号 | 现象 | 修法 |
|---|---|---|
| 轻-1 | 在线单页 OCR 也把整本 `images/` 全量拷进缓存目录 | `relocateImages` 加 `needed` 集合，只搬本次页真正引用的图 |
| 轻-2 | 旧 `schema` 页缓存被直接复用 | 缓存命中判断加 `rec.schema === PAGE_SCHEMA`（=2） |
| 轻-3 | `doc_text` 对 xlsx 的字符数虚高约 4 倍 | 从「单元格数 ×4」改成把每行单元格真实值拼起来量长度 |
| 轻-4 | `doc_render` 传 pptx 抛 `Invalid PDF structure` | 先判后缀，直接回「只渲染 PDF，Office 用 doc_text / doc_tables / doc_parse / doc_formulas」 |

另外 `force` 现在会清掉 `online-task.json`——真的重新上传重新解析，不再复用旧结果包；`doc_parse` 的 `force` 也补上了同样的语义。

## 第十二轮：doc_parse 的图片占位与 withImages（0.3.4）

第一次真用 `doc_parse` 转课件（群论 1.1，17 页）就发现一处：返回的 markdown 里写着 `![](images/a903a2…jpg)`，但缓存目录 `<cache>/doc/` 下只有 `parsed.json` 和 `online-task.json`——**图从来没落盘**，header 里的 `figure 8` 只是 content_list 的计数。

- **默认（不传 `withImages`）**：图片引用改写成 `[figure: <图注> — images/xxx.jpg (not extracted; pass withImages=true)]`，不再指向一个不存在的文件；
- **传 `withImages: true`**：图落到 `<cache>/doc/images/`，markdown 链接换成绝对路径；缓存记录带 `withImages` 标记，**先不带图、后带图再调会重跑一次**把图补上（不再命中那条没图的缓存）。

修法在 `lib/mineru-online.js` 的 `mineruParseFile`：`relocateImages()` 的返回值现在真正被用上（之前 `opts.withImages` 时调了但结果丢掉），并加两条正则替换。

（2026-11-14 试用发现）

## 第十三轮：侧栏进度条的三个 BUG（0.3.5）

用户反馈「文件还没跑完，进度条像是到固定时间就关了」。查下来是三处，全在进度这条旁路上，与解析结果无关：

1. **在线通道 done 恒为 0** —— `mineru-online.js` 的 `poll()` 原先只在 state 变化时回调一次，抽取过程中页数怎么变都不通知；`main.js` 接的时候又写死 `writeProgress(0, ...)`。结果是整段解析期间进度条停在 0%，跑完那一刻直接跳满。现在 `poll()` 按 `state|extracted_pages` 去重回调，把真实页数交给上层。
2. **完成后的定时器会删掉新任务** —— `OCR_PROGRESS` 以缓存目录为 key，任务完成时挂一个定时 `delete(outDir)`。同一份 PDF 先后跑两次（或 `doc_tables` 后来又调一次）时，前一次的定时器会把后一次正在跑的记录一起删掉，表现就是「跑到一半突然消失」。现在删除前先比对 `startedAt`，不是自己写的那条就不动。
3. **`total=0` 被判完成** —— 空页集时 `done >= total` 成立，侧栏入口立刻不显示。现在要求 `total > 0`，并把「部分页失败」也算结束（`done + failed >= total`），否则这类任务会一直挂到 TTL 才被清。

保留时间同时从 60 秒放宽到 **5 分钟**，让跑完那一刻的 100% 能被看见。

（2026-11-17 用户反馈后修）

## 安装

```sh
dsh plugin --profile desktop add link:C:\deepseek\tools\dsh-doc-parser
```

卸载：

```sh
dsh plugin --profile desktop remove dsh-doc-parser
```

## 限制

- 扫描件必须走 OCR；没有文字层时 `pdf_extract_text` 返回空文本。
- 表格是坐标启发式，复杂跨页表格不保证还原（要真 HTML 表格用 `pdf_tables` 的 `engine=mineru`）；跨页表只做「续表」标注，不自动拼接。
- 整本找表在扫描书上仍然慢——`maxMineruPages` 默认只放 24 页进 MinerU，其余需要分批调用。
- `prefetch` 是进程内后台任务，宿主退出就停；重开后再调一次会从已有缓存接着算。
- 首次 OCR 需下载语言包（约 20 MB），离线可把 `chi_sim.traineddata.gz`、`eng.traineddata.gz` 放进 `<data>\tessdata\`。

## 目录说明

- `lib/main.js`（1777 行）工具定义与路由；`lib/cache.js` 缓存、哈希索引与 LRU；`lib/pdf-core.js`（199 行）pdfjs 封装与 PDFium 兜底；`lib/tables.js` 坐标表格启发式；`lib/ocr_mineru.py` MinerU 本地通道；`lib/mineru-online.js`（439 行）MinerU 官方在线通道（申请上传 → PUT → 轮询 → 下 zip → content_list 拆页）；`lib/render_pdfium.py`/`lib/text_pdfium.py` PDFium 兜底；`lib/prefetch_book.mjs` 整本预跑脚本（手动用；插件内已有 `pdf_ocr_page prefetch=true` 入口）。
- `test/` 历史调试脚本，已归档到 `test/_archive/`（索引见其 `README.md`），不影响运行。
- ~~`ocr-venv/`~~ 已于 2026-11-18 删除（362.5 MB，Indra 移除）；PDFium 兜底解释器改用 MinerU 的 venv（`MINERU_VENV` 可覆盖）。

## 2026-11-18 第十四轮：移除 Indra 通道（0.3.6）

用户拍板「Indra 卸了，用不上」。插件内自带的 `ocr-venv`（362.5 MB）与 Indra 备用通道整体摘除：

- **删**：`lib/ocr.js`、`lib/ocr_indra.py`、`ocr-venv/` —— 插件体积 **432 MB → 70 MB**（587 文件）。
- **改**：`doc_ocr` 的 `engine` 枚举只剩 `['mineru']`；MinerU 整批失败时不再静默降级到 Indra，而是把失败页写进 `mineruFailed` 并返回错误（stderr 打印 `[mineru] batch failed: <原始错误>`，不再吞掉）。
- **改**：`pdfiumPython()` 与 `lib/pdf-core.js` 的兜底解释器都只找 MinerU 的 venv（`MINERU_VENV` 可覆盖），PDFium 纯白兜底仍然可用。
- **兼容**：旧缓存里 `engine=indra` 的页记录仍可读，但不会再产生新记录；`doc_tables` 的「非 mineru 记录就覆盖」逻辑把旧的 `text` 记录一并视为可覆盖。
- **验证**：两个改过的文件 `node --check` 通过；MinerU venv 的 `pypdfium2` 与 `pillow 13.0.0` 可用；插件内已无 Indra 代码引用。

## 2026-11-22 审计修复

三份只读审计里，本插件命中的是「会让人做错事」的六处，已全修并验证：

- **`lib/formulas/mathtype.js` 缺 `import fs`**（八处在用 `fs.*`）→ 四个 `doc_formulas` action 全抛 `fs is not defined`；`findSoffice` 里的 `try/catch` 又把它吞掉，报成 `LibreOffice not found (set SOFFICE_PATH to soffice.exe)`，会把人引去装 LibreOffice。现在补 import，错误不再被伪装。
- **`slice(0, 4000)` 静默截断**（`lib/main.js` 与 `lib/mineru-online.js`）→ `doc_tables` 长表从标签中间断开、行列丢失且写回缓存。现在整段保留。
- **文本层页假置信度**：纯文本页写 `confidence: 100`，页头显示 `(ocr 100%)`，与「MinerU 不返回置信度」的注释矛盾。现在记 `null`，页头显示 `(ocr text)`。
- **`doc_tables` 超时**：默认最多 24 页送 MinerU，冷启动 40 s + 每页 1.2–7 s 必超 120 s；改成 600000，与 `doc_ocr` 一致。
- **`MINERU_MODE` 两条静默路径**：显式 `online` 但无 token 会静默走本地；未设 mode、本地 venv 缺失而有 token 会**静默把整份 PDF 上传**。现在两条都打显式提示，`doc_ocr` 描述也写明「设 `MINERU_MODE=local` 可禁止上传」。（2026-11-25 起模式优先取插件根目录的 `mineru-mode.txt`，环境变量降为兜底——原因见第七轮那节。）
- **本轮另修的中低 30 处**（同批审计，已落盘并验证）：OOXML/TSV 侧 —— xlsx 自闭合单元格 `<c r="A1" s="1"/>` 不再丢格与错列、稀疏数组铺平（`formats/ooxml.js`）、空行保留且裁尾部空行、`sharedStrings` 去掉二次 `decodeXml`、`rowsToTsv` 把单元格内 `\t\n` 压成空格（`tables.js`）、`ooxmlTables` 支持 `pages` 按 sheet 过滤；工具面 —— `doc_parse` 的 20000 改吃 `PDF_MAX_CHARS`、输出头带 `[batch <id> @ <时间>]`、`force` 描述改实话（OCR 阶段不读页缓存）、`/\.pptx?$/` 收紧成 `\.pptx$`、`doc_tables` 增加 `maxRows` 并透传 `pages`、`engine=mineru` 时跳过文本层启发式、`doc_info` 的 `probeLimit` 夹到 2000、删死代码 `apiProbeCache`；语言与缓存 —— `DEFAULT_LANG` 常量统一三处写死值、`cache.js` 命中时加首尾 4 KB 指纹校验（同 size+mtime 的内容替换不再复用旧 hash）；超时与产物 —— 三处 `spawnSync` 补 `timeout`（`main.js` 30 s / `pdf-core.js` 60 s / `mineru-online.js` 120 s，`main.js:361` 的本地 MinerU CLI 原本就有 1800000）、渲染 PNG 名带 scale（`p003@2.5x.png`）。
- **仍未修的一项**：`loadPdf` 的 6 处不 `destroy`（pdfjs 不释放 worker）。要重构 6 个工具的执行结构才能加 `finally`，而 `prepare()` 返回的 abs 是否内容不可变尚未确认（复用缓存可能拿到陈旧 doc），风险高于收益——留给专门一轮做。完整清单见 `C:\deepseek\work\_audit\docparser-bugs.md`。

验证：三文件 `node --check` 通过；`findSoffice()` 实测返回 `C:\Program Files\LibreOffice\program\soffice.exe`；`slice(0, 4000)` / `confidence: 100` / `timeoutMs: 120000` 残留均为 0。
