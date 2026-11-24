"""用 pypdfium2 抽取指定页的文字层（pdfjs 对部分中文 PDF 返回空）。

用法: python text_pdfium.py <pdf> <pages json> <out json>
输出: {"页码": "文本", ...}（空文本的页不输出）
"""
import json
import sys

import pypdfium2 as pdfium


def main():
    pdf, pages_json, out = sys.argv[1], sys.argv[2], sys.argv[3]
    pages = json.loads(pages_json)
    doc = pdfium.PdfDocument(pdf)
    res = {}
    try:
        for n in pages:
            try:
                t = doc[n - 1].get_textpage().get_text_bounded().strip()
            except Exception:  # noqa: BLE001
                t = ''
            if t and len(t) >= 40:
                res[str(n)] = t
    finally:
        doc.close()
    with open(out, 'w', encoding='utf-8') as fp:
        json.dump(res, fp, ensure_ascii=False)


if __name__ == '__main__':
    main()
