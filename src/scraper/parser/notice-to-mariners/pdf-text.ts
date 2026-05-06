// Wraps pdfjs-dist to produce per-page line-broken text. Items are clustered
// into lines by Y-coordinate, then split horizontally at large gaps so that
// side-by-side tables (very common in Maltese NTMs) end up as separate logical
// lines with independent X ranges. Downstream code assigns regex-extracted
// coordinates to LLM-emitted section headings using X-overlap, so the column
// structure is what makes coord-to-section assignment unambiguous.
//
// pdfjs ships ESM; the legacy build is the supported path under nodenext+CJS
// emit. We dynamic-import to avoid pulling in browser-only globals at startup.

export interface PdfLine {
  // 1-based page number, matches what an LLM sees if we render the PDF.
  page: number;
  // 0-based line index within the page, in reading order.
  lineIdx: number;
  text: string;
  // PDF user space (origin bottom-left). Larger y = higher on page.
  y: number;
  // Horizontal extent in user space. Used to attribute coords on this line
  // to the correct heading when multiple headings share a y range.
  xStart: number;
  xEnd: number;
}

export interface PdfText {
  pages: number;
  lines: PdfLine[];
  // Convenience: full document as a single string with page markers. Lines
  // are emitted column-major (per row top-to-bottom, left-to-right within row)
  // — the LLM sees content in roughly the order a human reading the page would.
  joined: string;
}

// pdfjs's transform array: [a, b, c, d, e, f] — e and f are x, y translation.
type RawItem = { str: string; transform: number[]; width?: number };

// Items within this many user-space units share a row.
const ROW_Y_TOLERANCE = 4;
// Horizontal gap above which a row is split into separate logical lines.
// In NTM PDFs, the within-table lat→long gap is ~40–50u and the between-table
// gap (e.g. Valletta Approaches | Marsaxlokk Approaches) is ~100u+. A 70u
// threshold cleanly separates side-by-side tables without splitting intra-row
// fields apart.
const COLUMN_GAP_THRESHOLD = 70;

export async function extractPdfText(buffer: Buffer): Promise<PdfText> {
  // Dynamic import: pdfjs-dist is ESM, our emit is CJS under nodenext.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const data = new Uint8Array(buffer);
  const doc = await pdfjs.getDocument({
    data,
    // Disable worker — we're in Node, not a browser; the fake worker is fine.
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
  }).promise;

  const lines: PdfLine[] = [];

  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      try {
        const content = await page.getTextContent();
        const items = content.items as RawItem[];
        lines.push(...clusterIntoLines(items, p));
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await doc.destroy();
  }

  // Re-index lineIdx now that all pages are merged and ordered.
  for (let i = 0; i < lines.length; i++) lines[i].lineIdx = i;

  return { pages: doc.numPages, lines, joined: serialize(lines) };
}

interface PositionedItem {
  x: number;
  xEnd: number;
  str: string;
}

function clusterIntoLines(items: RawItem[], page: number): PdfLine[] {
  // Bucket items by y, then split each bucket at large horizontal gaps to
  // separate side-by-side tables / columns.
  type Row = { y: number; items: PositionedItem[] };
  const rows: Row[] = [];

  for (const item of items) {
    const str = item.str;
    if (!str.trim()) continue;
    const x = item.transform[4];
    const y = item.transform[5];
    const w = item.width ?? estimateWidth(str, item.transform);
    const row = rows.find((r) => Math.abs(r.y - y) <= ROW_Y_TOLERANCE);
    const positioned: PositionedItem = { x, xEnd: x + w, str };
    if (row) row.items.push(positioned);
    else rows.push({ y, items: [positioned] });
  }

  rows.sort((a, b) => b.y - a.y);

  const out: PdfLine[] = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    for (const segment of splitRowAtGaps(row.items)) {
      out.push({
        page,
        lineIdx: 0, // reassigned in extractPdfText after merge
        text: segment.text,
        y: row.y,
        xStart: segment.xStart,
        xEnd: segment.xEnd,
      });
    }
  }
  return out;
}

// Width estimation for items pdfjs didn't annotate. Falls back to a coarse
// average glyph width × character count; only used when item.width is missing.
function estimateWidth(str: string, transform: number[]): number {
  const fontScale = Math.abs(transform[0]) || 10;
  return str.length * fontScale * 0.5;
}

interface RowSegment {
  text: string;
  xStart: number;
  xEnd: number;
}

function splitRowAtGaps(items: PositionedItem[]): RowSegment[] {
  if (items.length === 0) return [];
  const segments: RowSegment[] = [];
  let current: PositionedItem[] = [items[0]];
  for (let i = 1; i < items.length; i++) {
    const prev = current[current.length - 1];
    const next = items[i];
    const gap = next.x - prev.xEnd;
    if (gap > COLUMN_GAP_THRESHOLD) {
      segments.push(toSegment(current));
      current = [next];
    } else {
      current.push(next);
    }
  }
  segments.push(toSegment(current));
  return segments;
}

function toSegment(items: PositionedItem[]): RowSegment {
  // pdfjs returns explicit space items as " "; joining with no separator
  // preserves them. Collapse runs of whitespace for sane regex matching.
  const text = items
    .map((it) => it.str)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    text,
    xStart: items[0].x,
    xEnd: items[items.length - 1].xEnd,
  };
}

function serialize(lines: PdfLine[]): string {
  let currentPage = -1;
  const parts: string[] = [];
  for (const line of lines) {
    if (line.page !== currentPage) {
      if (currentPage !== -1) parts.push('\n');
      parts.push(`=== PAGE ${line.page} ===\n`);
      currentPage = line.page;
    }
    parts.push(line.text + '\n');
  }
  return parts.join('');
}
