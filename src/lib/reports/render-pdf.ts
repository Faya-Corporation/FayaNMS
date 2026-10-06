/**
 * GA-5 (2026-10-06 re-audit — report formats) — dependency-free PDF 1.4
 * renderer for report artifacts.
 *
 * Until this module the "PDF" format was a delivery tag only: a run whose
 * schedule requested PDF stored (and downloaded) the same JSON artifact as
 * every other format — an honest-data/dishonest-envelope gap. This writer
 * closes it: `renderArtifactPdf` emits a REAL single-font PDF 1.4 document
 * (landscape A4, Helvetica regular + bold) rendering the artifact's title
 * block, column headers and rows across as many pages as the table needs.
 *
 * Design constraints (deliberate):
 *   - ZERO dependencies: the byte stream (header, objects, xref table,
 *     trailer) is assembled by hand with byte-accurate offsets — the
 *     byte-level tests in tests/audit/ga5-report-renderers.test.ts parse
 *     the xref and verify it.
 *   - The stored artifact (resultJson) stays the single source of truth;
 *     rendering happens at DELIVERY (download route), so no schema change
 *     and no binary blob in the persistence layer.
 *   - Deterministic output: same artifact → byte-identical PDF (no
 *     timestamps beyond the artifact's own generatedAt, no IDs).
 *
 * Text safety: strings are escaped per PDF string syntax; anything outside
 * WinAnsi/Latin-1 collapses to "?" (the audit trail already renders report
 * data as text; no binary payload is ever embedded).
 */

import type { ReportArtifact } from "./generate";

const PAGE_WIDTH = 842; // A4 landscape (points)
const PAGE_HEIGHT = 595;
const MARGIN = 36;
const USABLE_WIDTH = PAGE_WIDTH - MARGIN * 2;

const TITLE_SIZE = 16;
const SUBTITLE_SIZE = 9;
const HEADER_SIZE = 8;
const CELL_SIZE = 8;
const ROW_HEIGHT = 14;
const TITLE_BLOCK_HEIGHT = 58; // title + generatedAt + range (+ scope note)
const ROWS_PER_PAGE = Math.floor(
  (PAGE_HEIGHT - MARGIN * 2 - TITLE_BLOCK_HEIGHT - ROW_HEIGHT) / ROW_HEIGHT
);

/** Latin-1 encode a JS string (code points > 255 collapse to "?"). */
function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    out[i] = code <= 0xff ? code : 0x3f; // "?"
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Escape a string for a PDF literal text string. */
function pdfEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Collapse a cell value to its display text (null/undefined → empty). */
function cellText(value: ReportArtifact["rows"][number][string] | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

/**
 * Truncate a string to `maxChars` display characters, marking a cut with
 * "..." (ASCII — WinAnsi-safe). Column widths are deterministic, so the
 * truncation is deterministic too.
 */
function fit(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  return maxChars <= 3 ? text.slice(0, maxChars) : `${text.slice(0, maxChars - 3)}...`;
}

/** Helvetica average glyph width ≈ 0.5 × font size (fixed-width policy). */
function maxCharsForColumn(_index: number, columnCount: number, size: number): number {
  const columnWidth = USABLE_WIDTH / columnCount;
  return Math.floor((columnWidth - 10) / (size * 0.5));
}

interface PageLines {
  header: string[];
  rows: string[][];
}

/** Split the artifact's table into page-sized line batches. */
function paginate(artifact: ReportArtifact): PageLines[] {
  const columnCount = Math.max(1, artifact.columns.length);
  const header = artifact.columns.map((column, index) =>
    fit(column.label, maxCharsForColumn(index, columnCount, HEADER_SIZE))
  );
  const rows = artifact.rows.map((row) =>
    artifact.columns.map((column, index) =>
      fit(cellText(row[column.key]), maxCharsForColumn(index, columnCount, CELL_SIZE))
    )
  );

  const pages: PageLines[] = [];
  for (let start = 0; start < rows.length || pages.length === 0; start += ROWS_PER_PAGE) {
    pages.push({ header, rows: rows.slice(start, start + ROWS_PER_PAGE) });
    if (start + ROWS_PER_PAGE >= rows.length) break;
  }
  return pages;
}

/** One text line at an absolute position (Helvetica, regular or bold). */
function textLine(x: number, y: number, size: number, bold: boolean, text: string): string {
  const font = bold ? "/F2" : "/F1";
  return `BT ${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${pdfEscape(text)}) Tj ET`;
}

/** Build the content stream for one page (title block only on page 0). */
function contentStream(
  artifact: ReportArtifact,
  page: PageLines,
  pageIndex: number
): string {
  const columnCount = Math.max(1, artifact.columns.length);
  const columnWidth = USABLE_WIDTH / columnCount;
  const lines: string[] = [];

  let y = PAGE_HEIGHT - MARGIN;
  if (pageIndex === 0) {
    lines.push(
      textLine(MARGIN, y, TITLE_SIZE, true, fit(artifact.reportType, 64))
    );
    y -= TITLE_SIZE + 8;
    lines.push(textLine(MARGIN, y, SUBTITLE_SIZE, false, `Generated: ${artifact.generatedAt}`));
    y -= SUBTITLE_SIZE + 6;
    lines.push(textLine(MARGIN, y, SUBTITLE_SIZE, false, `Range: ${artifact.range}`));
    if (artifact.scopeNote) {
      y -= SUBTITLE_SIZE + 6;
      lines.push(
        textLine(MARGIN, y, SUBTITLE_SIZE, false, fit(`Note: ${artifact.scopeNote}`, 160))
      );
    }
    y = PAGE_HEIGHT - MARGIN - TITLE_BLOCK_HEIGHT;
  }

  // Header row (bold).
  let x = MARGIN;
  lines.push(textLine(x, y, HEADER_SIZE, true, page.header[0] ?? ""));
  for (let c = 1; c < page.header.length; c += 1) {
    x += columnWidth;
    lines.push(textLine(x, y, HEADER_SIZE, true, page.header[c]));
  }
  y -= ROW_HEIGHT;

  // Data rows.
  for (const row of page.rows) {
    x = MARGIN;
    lines.push(textLine(x, y, CELL_SIZE, false, row[0] ?? ""));
    for (let c = 1; c < row.length; c += 1) {
      x += columnWidth;
      lines.push(textLine(x, y, CELL_SIZE, false, row[c]));
    }
    y -= ROW_HEIGHT;
  }

  return lines.join("\n");
}

/**
 * Render a report artifact as a real PDF 1.4 document. Deterministic:
 * the same artifact produces byte-identical output.
 */
export function renderArtifactPdf(artifact: ReportArtifact): Uint8Array {
  const pages = paginate(artifact);

  // Object numbering: 1 catalog, 2 pages tree, 3 F1, 4 F2, then per page
  // a Page object and its content stream (page i → objects 5+2i, 6+2i).
  const objects: Uint8Array[] = []; // index 0 = object 1
  const offsets: number[] = []; // byte offset per object
  let stream = new Uint8Array(0);

  const pushObject = (body: string) => {
    const encoded = latin1(body);
    objects.push(encoded);
  };

  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(" ");

  pushObject("<< /Type /Catalog /Pages 2 0 R >>");
  pushObject(`<< /Type /Pages /Kids [ ${kids} ] /Count ${pages.length} >>`);
  pushObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  pushObject(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"
  );

  pages.forEach((page, i) => {
    const contentObjNumber = 6 + i * 2;
    pushObject(
      `<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT} ] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjNumber} 0 R >>`
    );
    const body = contentStream(artifact, page, i);
    pushObject(`<< /Length ${latin1(body).length} >>\nstream\n${body}\nendstream`);
  });

  // Assemble with byte-accurate offsets.
  const chunks: Uint8Array[] = [];
  const push = (text: string) => chunks.push(latin1(text));

  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(stream.length + chunks.reduce((sum, c) => sum + c.length, 0));
    push(`${i + 1} 0 obj\n`);
    chunks.push(objects[i]);
    push("\nendobj\n");
  }
  stream = concat(chunks);
  chunks.length = 0;

  const xrefStart = stream.length;
  const xrefLines: string[] = ["xref", `0 ${objects.length + 1}`, "0000000000 65535 f "];
  for (const offset of offsets) {
    xrefLines.push(`${String(offset).padStart(10, "0")} 00000 n `);
  }
  xrefLines.push(
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    String(xrefStart),
    "%%EOF"
  );
  push(xrefLines.join("\n") + "\n");

  return concat([stream, ...chunks]);
}
