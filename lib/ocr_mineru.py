"""OCR/parse pages with MinerU 3.x CLI (pipeline backend, ONNX+PaddleOCR+UniMERNet).

Usage: python ocr_mineru.py <pdf> <pages_csv> <out_json> [lang]
  pages_csv: "171,172,180" 或 "171-180"
Output: {"pages": {"171": {"text": "...", "type": "mineru"}}, "elapsed": 61.2}

Requires the mineru venv (default C:\\deepseek\\tools\\mineru4-venv, override MINERU_VENV).
"""
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse

MINERU_VENV = os.environ.get("MINERU_VENV", r"C:\deepseek\tools\mineru4-venv")
MINERU_EXE = os.path.join(MINERU_VENV, "Scripts", "mineru.exe")


def api_alive(url: str, timeout: float = 0.5) -> bool:
    """常驻 mineru-api 探活：只验 TCP 能否连上，不判 HTTP 语义（省掉一次 HTTP 往返）。"""
    try:
        u = urlparse(url if "://" in url else "http://" + url)
        host = u.hostname or "127.0.0.1"
        port = u.port or (443 if u.scheme == "https" else 80)
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except Exception:
        return False


def parse_pages(spec: str):
    out = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            out.extend(range(int(a), int(b) + 1))
        else:
            out.append(int(part))
    return out


def main():
    pdf, pages_spec, out_json = sys.argv[1], sys.argv[2], sys.argv[3]
    lang = sys.argv[4] if len(sys.argv) > 4 else "ch"
    pages = parse_pages(pages_spec)
    if not pages:
        raise SystemExit("no pages given")
    if not os.path.exists(MINERU_EXE):
        raise SystemExit(f"mineru exe not found: {MINERU_EXE}")
    base_page = min(pages)

    work = Path(tempfile.mkdtemp(prefix="mineru-ocr-"))
    try:
        # 常驻 mineru-api 可用时复用它：省掉每次起停临时服务 + 加载模型的约 45 秒
        api_url = (os.environ.get("MINERU_API_URL") or "").strip()
        if api_url and not api_alive(api_url):
            print(f"[mineru] api unreachable, fallback to temp service: {api_url}", file=sys.stderr)
            api_url = ""

        def build_cmd(out_root, use_api):
            args = [
                MINERU_EXE,
                "-p", str(Path(pdf).resolve()),
                "-o", str(out_root),
                "-b", "pipeline",
                "-m", "ocr",
                "-l", lang,
                # ⚠️ mineru 的 -s/-e 是 **0-based**（--help 原文 "beginning from 0"），
                # 传 1-based 页码会整体偏一页（内容对但页号错，最坑的是不报错）。
                "-s", str(min(pages) - 1),
                "-e", str(max(pages) - 1),
            ]
            if use_api:
                args += ["--api-url", use_api]
            return args

        env = dict(os.environ)
        env.setdefault("PYTHONIOENCODING", "utf-8")
        env.setdefault("MINERU_MODEL_SOURCE", "modelscope")
        t0 = time.time()
        proc = subprocess.run(build_cmd(work, api_url), capture_output=True, text=True, encoding="utf-8", env=env)
        if proc.returncode != 0 and api_url:
            # 兜底：常驻服务中途挂了/不兼容 → 换一个干净输出目录退回临时服务再跑一次（只慢不坏）
            print(f"[mineru] api mode failed ({proc.returncode}), retry with temp service", file=sys.stderr)
            work2 = Path(tempfile.mkdtemp(prefix="mineru-ocr-"))
            try:
                proc2 = subprocess.run(
                    build_cmd(work2, ""), capture_output=True, text=True, encoding="utf-8", env=env
                )
                if proc2.returncode == 0:
                    shutil.rmtree(work, ignore_errors=True)
                    work = work2
                    proc = proc2
                else:
                    shutil.rmtree(work2, ignore_errors=True)
            except Exception:
                shutil.rmtree(work2, ignore_errors=True)
        elapsed = time.time() - t0
        if proc.returncode != 0:
            raise SystemExit(f"mineru failed ({proc.returncode}): {(proc.stderr or proc.stdout or '')[-800:]}")

        # find per-page content_list.json produced by mineru.
        # NOTE: mineru names it "<stem>_content_list.json"; also emits *_content_list_v2.json
        content_lists = [p for p in work.rglob("*_content_list.json") if "v2" not in p.name]
        if not content_lists:
            content_lists = [p for p in work.rglob("*content_list.json") if "v2" not in p.name]
        result = {"pages": {}, "elapsed": round(elapsed, 1)}
        if content_lists:
            items = json.loads(content_lists[0].read_text(encoding="utf-8"))
            # MinerU 的 type -> main.js 读的 label（页头 [blocks: ...] 用）
            LABEL = {"text": "Text", "equation": "Equation", "table": "Table",
                     "image": "Figure", "figure": "Figure", "title": "Section-Header",
                     "page_number": "Page-Number", "header": "Page-Header",
                     "footer": "Page-Footer", "list": "List"}
            by_page = {}
            for it in items:
                if not isinstance(it, dict):
                    continue
                idx = it.get("page_idx")
                if idx is None:
                    continue
                # mineru 的 page_idx 是「相对本次运行起点的 0-based 索引」
                pnum = base_page + int(idx)
                if pnum not in pages:
                    continue
                tp = it.get("type") or "text"
                latex = it.get("latex") or ""
                if tp == "text":
                    chunk = it.get("text") or ""
                    md = chunk
                elif tp == "table":
                    chunk = it.get("table_body") or it.get("text") or ""
                    md = chunk
                elif tp in ("image", "figure"):
                    cap = it.get("image_caption") or ""
                    if isinstance(cap, list):
                        cap = " ".join(map(str, cap))
                    chunk = f"![{it.get('img_path') or ''}]({it.get('img_path') or ''})\n{cap}"
                    md = chunk
                elif tp == "equation":
                    chunk = latex or it.get("text") or ""
                    # 公式块包成 $$...$$，下游 KaTeX 才能渲染
                    body = chunk.strip()
                    if body and not body.startswith("$$"):
                        md = "$$\n" + body + "\n$$"
                        chunk = md
                    else:
                        md = chunk
                else:
                    chunk = it.get("text") or ""
                    md = chunk
                if chunk:
                    by_page.setdefault(pnum, {"chunks": [], "blocks": [], "md": []})
                    by_page[pnum]["chunks"].append(str(chunk))
                    by_page[pnum]["md"].append(str(md))
                    by_page[pnum]["blocks"].append({
                        "type": tp,
                        "label": LABEL.get(tp, "Text"),
                        "text": str(chunk)[:4000],
                    })
            for pnum, d in by_page.items():
                result["pages"][str(pnum)] = {
                    "text": "\n\n".join(d["chunks"]),
                    "markdown": "\n\n".join(d["md"]),
                    "blocks": d["blocks"],
                    "type": "mineru",
                }
        else:
            # fallback: whole markdown
            md_files = list(work.rglob("*.md"))
            text = md_files[0].read_text(encoding="utf-8") if md_files else ""
            for pnum in pages:
                result["pages"][str(pnum)] = {"text": text, "type": "mineru"}
        Path(out_json).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        print(json.dumps({"ok": True, "pages": len(result["pages"]), "elapsed": result["elapsed"]}))
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
