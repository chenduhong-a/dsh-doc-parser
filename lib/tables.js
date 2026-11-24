/**
 * 坐标启发式表格：把 pdfjs 的文本 items 按 y 聚类成行，再按 x 间隙切成单元格。
 * 不做复杂表格识别，只给出可读的 TSV；列数不一致时标注低置信度。
 */

export function rowsFromItems(items, { yTol = 2.5, xGap = 10 } = {}) {
  const words = items
    .filter((it) => typeof it.str === 'string' && it.str.trim() && it.transform)
    .map((it) => ({
      text: it.str,
      x: it.transform[4],
      y: it.transform[5],
      endX: it.transform[4] + (it.width ?? 0),
    }));
  words.sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const rows = [];
  for (const w of words) {
    let row = rows.find((r) => Math.abs(r.y - w.y) <= yTol);
    if (!row) {
      row = { y: w.y, words: [] };
      rows.push(row);
    }
    row.words.push(w);
  }
  for (const row of rows) {
    row.words.sort((a, b) => a.x - b.x);
    const cells = [];
    let cur = null;
    for (const w of row.words) {
      if (!cur) cur = { text: w.text, x: w.x, endX: w.endX };
      else if (w.x - cur.endX > xGap) {
        cells.push(cur);
        cur = { text: w.text, x: w.x, endX: w.endX };
      } else {
        cur.text += (w.x - cur.endX > 1.6 ? ' ' : '') + w.text;
        cur.endX = Math.max(cur.endX, w.endX);
      }
    }
    if (cur) cells.push(cur);
    row.cells = cells.map((c) => c.text.trim()).filter(Boolean);
    delete row.words;
  }
  return rows.filter((r) => r.cells.length);
}

export function rowsToTsv(rows) {
  const maxCols = Math.max(0, ...rows.map((r) => r.cells.length));
  const lowConfidence = rows.some((r) => r.cells.length !== maxCols);
  const lines = rows.map((r) => {
    const cells = r.cells.slice();
    while (cells.length < maxCols) cells.push('');
    // 单元格里的换行/制表符会把 TSV 行列冲散（2026-11-22 审计），压成空格
return cells.map((c) => String(c ?? '').replace(/[\t\n\r]+/g, ' ').trim()).join('\t');
  });
  return { tsv: lines.join('\n'), maxCols, lowConfidence };
}
