/**
 * GA-5 (2026-10-06 re-audit — report formats) — dependency-free XLSX
 * (SpreadsheetML) renderer for report artifacts.
 *
 * Closes the same honesty gap as render-pdf.ts: a run whose schedule
 * requested XLSX now DOWNLOADS a real .xlsx package — a ZIP container of
 * the minimal OOXML spreadsheet parts — instead of a JSON artifact tagged
 * "XLSX".
 *
 * Design constraints (deliberate):
 *   - ZERO dependencies: the ZIP container is assembled by hand (local
 *     file headers, central directory, EOCD) with STORE (no compression)
 *     and a table-driven CRC-32 — the byte-level tests verify the CRC of
 *     every part and walk the central directory.
 *   - The stored artifact (resultJson) stays the single source of truth;
 *     rendering happens at DELIVERY (download route) — no schema change,
 *     no binary blob in the persistence layer.
 *   - Deterministic output: a fixed DOS timestamp is used so the same
 *     artifact renders byte-identically.
 *
 * Injection safety: data cells are emitted as `t="inlineStr"` text cells.
 * Excel does NOT evaluate formula syntax in inline strings (unlike CSV
 * ingestion), so the OWASP leading-quote neutralization used by
 * artifactToCsv is intentionally NOT applied here — it would corrupt
 * legitimate values (e.g. "=CMD" as a device label) without adding
 * safety. The audit trail and the CSV renderer keep the CSV-side guard.
 */

import type { ReportArtifact } from "./generate";

/* ── CRC-32 (IEEE 802.3, reflected, poly 0xEDB88320) ─────────────────── */

const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* ── ZIP container (STORE method) ────────────────────────────────────── */

// Fixed DOS timestamp 2026-01-01 00:00:00 → determinism.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

interface ZipEntry {
  name: string;
  data: Uint8Array;
  crc: number;
  offset: number;
}

/** Assemble a STORE-method ZIP from name/data pairs. */
export function buildStoreZip(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const made: ZipEntry[] = [];
  let offset = 0;

  const push = (bytes: Uint8Array) => {
    parts.push(bytes);
    offset += bytes.length;
  };
  const u16 = (value: number): Uint8Array =>
    new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
  const u32 = (value: number): Uint8Array =>
    new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const crc = crc32(entry.data);
    made.push({ name: entry.name, data: entry.data, crc, offset });

    // Local file header: sig, version, flags, method(0=STORE), time, date,
    // crc, compressed size, uncompressed size, name len, extra len.
    push(u32(0x04034b50));
    push(u16(20));
    push(u16(0));
    push(u16(0));
    push(u16(DOS_TIME));
    push(u16(DOS_DATE));
    push(u32(crc));
    push(u32(entry.data.length));
    push(u32(entry.data.length));
    push(u16(nameBytes.length));
    push(u16(0));
    push(nameBytes);
    push(entry.data);
  }

  const centralStart = offset;
  for (const entry of made) {
    const nameBytes = new TextEncoder().encode(entry.name);
    // Central directory header: sig, made by, needed, flags, method, time,
    // date, crc, sizes, name len, extra len, comment len, disk, int attr,
    // ext attr, local offset, name.
    push(u32(0x02014b50));
    push(u16(20));
    push(u16(20));
    push(u16(0));
    push(u16(0));
    push(u16(DOS_TIME));
    push(u16(DOS_DATE));
    push(u32(entry.crc));
    push(u32(entry.data.length));
    push(u32(entry.data.length));
    push(u16(nameBytes.length));
    push(u16(0));
    push(u16(0));
    push(u16(0));
    push(u16(0));
    push(u32(0));
    push(u32(entry.offset));
    push(nameBytes);
  }
  const centralSize = offset - centralStart;

  // End of central directory.
  push(u32(0x06054b50));
  push(u16(0));
  push(u16(0));
  push(u16(made.length));
  push(u16(made.length));
  push(u32(centralSize));
  push(u32(centralStart));
  push(u16(0));

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

/* ── SpreadsheetML parts ─────────────────────────────────────────────── */

/** XML 1.0 escape + control-character stripping (XML 1.0 has no refs for
 * C0 controls other than tab/lf/cr; cell text never needs them). */
function xmlEscape(text: string): string {
  const stripped = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");
  return stripped
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 0-based column index → spreadsheet reference letters (A, B, … AA). */
function columnRef(index: number): string {
  let n = index + 1;
  let ref = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    ref = String.fromCharCode(65 + rem) + ref;
    n = Math.floor((n - 1) / 26);
  }
  return ref;
}

const PLAIN_NUMBER = /^[+-]?\d+(?:\.\d+)?$/;

function cellXml(
  value: ReportArtifact["rows"][number][string],
  ref: string,
  style: number
): string {
  const s = value === null || value === undefined ? "" : String(value);
  const styleAttr = style > 0 ? ` s="${style}"` : "";
  if (s !== "" && PLAIN_NUMBER.test(s)) {
    return `<c r="${ref}"${styleAttr}><v>${s}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"${styleAttr}><is><t xml:space="preserve">${xmlEscape(s)}</t></is></c>`;
}

function sheetXml(artifact: ReportArtifact): string {
  const columnCount = Math.max(1, artifact.columns.length);
  const rowCount = artifact.rows.length + 1;
  const dimension = `A1:${columnRef(columnCount - 1)}${rowCount}`;

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    `<dimension ref="${dimension}"/>`,
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>',
    '<sheetFormatPr defaultRowHeight="15"/>',
    "<sheetData>",
  ];

  // Header row (style 1 = bold).
  lines.push('<row r="1">');
  artifact.columns.forEach((column, c) => {
    lines.push(cellXml(column.label, `${columnRef(c)}1`, 1));
  });
  lines.push("</row>");

  artifact.rows.forEach((row, r) => {
    lines.push(`<row r="${r + 2}">`);
    artifact.columns.forEach((column, c) => {
      const ref = `${columnRef(c)}${r + 2}`;
      lines.push(cellXml(row[column.key], ref, 0));
    });
    lines.push("</row>");
  });

  lines.push("</sheetData>", "</worksheet>");
  return lines.join("\n");
}

function workbookXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    '<sheets><sheet name="Report" sheetId="1" r:id="rId1"/></sheets>',
    "</workbook>",
  ].join("\n");
}

function contentTypesXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    "</Types>",
  ].join("\n");
}

function rootRelsXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
    "</Relationships>",
  ].join("\n");
}

function workbookRelsXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    "</Relationships>",
  ].join("\n");
}

function stylesXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>',
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>',
    '<borders count="1"><border/></borders>',
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>',
    "</styleSheet>",
  ].join("\n");
}

/**
 * Render a report artifact as a real .xlsx package (minimal OOXML,
 * STORE-method zip). Deterministic: the same artifact produces
 * byte-identical output.
 */
export function renderArtifactXlsx(artifact: ReportArtifact): Uint8Array {
  const enc = new TextEncoder();
  const text = (value: string) => enc.encode(value);

  return buildStoreZip([
    { name: "[Content_Types].xml", data: text(contentTypesXml()) },
    { name: "_rels/.rels", data: text(rootRelsXml()) },
    { name: "xl/workbook.xml", data: text(workbookXml()) },
    { name: "xl/_rels/workbook.xml.rels", data: text(workbookRelsXml()) },
    { name: "xl/styles.xml", data: text(stylesXml()) },
    { name: "xl/worksheets/sheet1.xml", data: text(sheetXml(artifact)) },
  ]);
}
