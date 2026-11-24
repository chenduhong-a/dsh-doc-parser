"""Render one PDF page with PDFium (supports CCITT/JBIG2 etc.).

Usage: python render_pdfium.py <pdf> <page 1-based> <out.png> [scale]
"""
import sys

import pypdfium2 as pdfium


def main():
    pdf_path = sys.argv[1]
    page_no = int(sys.argv[2])
    out_png = sys.argv[3]
    scale = float(sys.argv[4]) if len(sys.argv) > 4 else 2.5
    pdf = pdfium.PdfDocument(pdf_path)
    try:
        page = pdf[page_no - 1]
        bitmap = page.render(scale=scale)
        image = bitmap.to_pil()
        image.save(out_png, format="PNG")
    finally:
        pdf.close()


if __name__ == "__main__":
    main()
