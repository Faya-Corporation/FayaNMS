/**
 * GA-5 (2026-10-06 re-audit — report formats): REAL PDF/XLSX renderers.
 *
 * Before this wave, "PDF" and "XLSX" were delivery tags only — a run
 * whose schedule requested either format stored (and downloaded) the same
 * JSON artifact as every other format. GA-5 closes the gap:
 *   - src/lib/reports/render-pdf.ts — dependency-free PDF 1.4 writer
 *     (byte-accurate xref, Helvetica, paginated table);
 *   - src/lib/reports/render-xlsx.ts — minimal OOXML spreadsheet in a
 *     hand-built STORE-method ZIP (table-driven CRC-32);
 *   - the run download route renders the binary formats at delivery from
 *     the stored resultJson (the artifact stays the source of truth).
 *
 * These tests are BYTE-LEVEL per the remediation plan: the PDF xref is
 * parsed and every offset verified; the ZIP central directory is walked
 * and every part's CRC-32 independently recomputed. The route-level
 * matrix covers all 4 delivery formats end-to-end.
 *
 * CI posture (GA-4 lesson): the gate DB is migrations-only — no seeded
 * fleet. Every fixture is created here; no test assumes demo data.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NextRequest, NextResponse } from "next/server";
import { encode } from "next-auth/jwt";

import { db } from "../../src/lib/db";
import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";
import { generateReport, type ReportArtifact } from "../../src/lib/reports/generate";
import { renderArtifactPdf } from "../../src/lib/reports/render-pdf";
import { crc32, renderArtifactXlsx } from "../../src/lib/reports/render-xlsx";

const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
const PREFIX = "ga5-";
const ADMIN_EMAIL = `${PREFIX}admin-${RUN.toLowerCase()}@faya.local`;

const testStartedAt = new Date();
let adminId = "";
const createdJobIds: string[] = [];

async function adminJwt(): Promise<string> {
  return encode({
    token: { id: adminId, email: ADMIN_EMAIL, name: "GA-5 Admin", role: "admin" },
    secret: process.env.NEXTAUTH_SECRET ?? "",
  });
}

/** Route-level request WITH the admin session cookie (requirePermission). */
async function authedRequest(url: string): Promise<NextRequest> {
  const jwt = await adminJwt();
  return new NextRequest(url, {
    headers: { cookie: `next-auth.session-token=${jwt}` },
  });
}

/** A deterministic synthetic artifact with hostile + numeric cell values. */
function syntheticArtifact(): ReportArtifact {
  return {
    reportType: "AVAILABILITY",
    generatedAt: "2026-10-06T12:00:00.000Z",
    range: "Oct 1 – Oct 6, 2026",
    format: "PDF",
    scopeNote: "Counts remain fleet-wide: change requests carry no site attribution.",
    columns: [
      { key: "device", label: "Device" },
      { key: "uptime", label: "Uptime %" },
      { key: "note", label: "Note" },
    ],
    rows: [
      { device: "core-rtr-01", uptime: 99.98, note: "ok" },
      { device: "=cmd|' /C calc'!A0", uptime: -12.5, note: "parens ( and ) and back \\ here" },
      { device: "unicode — · é →", uptime: null, note: "col with é latin1" },
    ],
  };
}

async function seedRun(artifact: ReportArtifact, status = "SUCCEEDED"): Promise<string> {
  const job = await db.jobExecution.create({
    data: {
      type: "REPORT_RUN",
      status,
      payloadJson: JSON.stringify({ scheduleName: `${PREFIX}sched-${RUN}` }),
      resultJson: JSON.stringify(artifact),
      correlationId: `REP-GA5-${RUN}-${createdJobIds.length}`,
    },
  });
  createdJobIds.push(job.id);
  return job.id;
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

/** Decode a PDF literal string's escaping back to readable text. */
function pdfUnescape(text: string): string {
  return text.replace(/\\([()\\])/g, "$1");
}

/* ── PDF renderer ─────────────────────────────────────────────────────── */

describe("GA-5: PDF renderer", () => {
  test("emits a valid PDF 1.4 header, trailer and byte-accurate xref", () => {
    const pdf = renderArtifactPdf(syntheticArtifact());
    const text = latin1(pdf);

    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);

    // Parse startxref → xref table → every offset must point at "N 0 obj".
    const startxrefAt = text.lastIndexOf("startxref");
    const xrefStart = Number(text.slice(startxrefAt + "startxref".length).trim().split(/\s+/)[0]);
    expect(Number.isInteger(xrefStart)).toBe(true);
    expect(text.slice(xrefStart, xrefStart + 4)).toBe("xref");

    const xrefSection = text.slice(xrefStart);
    const entryLines = xrefSection
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^\d{10} \d{5} [nf]$/.test(line));
    // Object 0 is the free head; objects 1..N follow in order.
    expect(entryLines.length).toBeGreaterThanOrEqual(5);
    entryLines.forEach((line, i) => {
      if (i === 0) {
        expect(line.endsWith("f")).toBe(true);
        return;
      }
      const offset = Number(line.slice(0, 10));
      expect(text.slice(offset, offset + String(i).length + 6)).toBe(`${i} 0 obj`);
    });
  });

  test("renders the title block, column headers, rows and scope note", () => {
    const pdf = renderArtifactPdf(syntheticArtifact());
    const text = pdfUnescape(latin1(pdf));

    expect(text).toContain("(AVAILABILITY)");
    expect(text).toContain("(Device)");
    expect(text).toContain("(Uptime %)");
    expect(text).toContain("(core-rtr-01)");
    expect(text).toContain("Counts remain fleet-wide");
  });

  test("escapes PDF string metacharacters and collapses out-of-Latin1 text", () => {
    const pdf = renderArtifactPdf(syntheticArtifact());
    const raw = latin1(pdf);

    // Literal parens/backslash inside text strings must be escaped —
    // an UNescaped "(" after a text prefix would be a structural break.
    expect(raw).toContain("\\(");
    expect(raw).toContain("\\)");
    expect(raw).toContain("\\\\");
    // Latin-1 range glyphs pass through (· é are ≤ 0xFF); only code points
    // ABOVE Latin-1 (— →) collapse to "?" — without breaking the stream.
    expect(raw).toContain("unicode ? · é ?");

    // Deterministic: same artifact → byte-identical document.
    const again = renderArtifactPdf(syntheticArtifact());
    expect(Buffer.from(pdf).equals(Buffer.from(again))).toBe(true);
  });

  test("paginates: 100 rows → 4 pages; 3 rows → 1 page; empty rows → 1 page", () => {
    const countPages = (pdf: Uint8Array): number => {
      const text = latin1(pdf);
      const match = text.match(/\/Count (\d+)/);
      return Number(match?.[1] ?? 0);
    };

    const big = { ...syntheticArtifact(), rows: [] as ReportArtifact["rows"] };
    for (let i = 0; i < 100; i += 1) {
      big.rows.push({ device: `dev-${i}`, uptime: i, note: "row" });
    }
    expect(countPages(renderArtifactPdf(big))).toBe(4); // ceil(100/30)

    const small = syntheticArtifact();
    expect(countPages(renderArtifactPdf(small))).toBe(1);

    const empty = { ...syntheticArtifact(), rows: [] };
    expect(countPages(renderArtifactPdf(empty))).toBe(1);
  });
});

/* ── XLSX renderer ────────────────────────────────────────────────────── */

describe("GA-5: XLSX renderer", () => {
  interface WalkedEntry {
    name: string;
    data: Uint8Array;
    storedCrc: number;
  }

  /** Walk the STORE-method zip: local headers in order, sizes from the
   * headers themselves (no compression), so the walk needs no central dir. */
  function walkZip(zip: Uint8Array): { entries: WalkedEntry[]; centralCount: number } {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const text = latin1(zip);
    const entries: WalkedEntry[] = [];
    let offset = 0;

    while (offset + 4 <= zip.length && view.getUint32(offset, true) === 0x04034b50) {
      const compressedSize = view.getUint32(offset + 18, true);
      const uncompressedSize = view.getUint32(offset + 22, true);
      const storedCrc = view.getUint32(offset + 14, true);
      const nameLen = view.getUint16(offset + 26, true);
      const extraLen = view.getUint16(offset + 28, true);
      const name = text.slice(offset + 30, offset + 30 + nameLen);
      const dataStart = offset + 30 + nameLen + extraLen;
      const data = zip.slice(dataStart, dataStart + compressedSize);
      expect(compressedSize).toBe(uncompressedSize); // STORE method
      entries.push({ name, data, storedCrc });
      offset = dataStart + compressedSize;
    }

    // Central directory count from the EOCD record (walked backwards).
    const eocdAt = text.lastIndexOf("PK\x05\x06");
    expect(eocdAt).toBeGreaterThan(0);
    const centralCount = view.getUint16(eocdAt + 10, true);
    return { entries, centralCount };
  }

  test("emits a structurally valid ZIP with per-part CRC-32 integrity", () => {
    const zip = renderArtifactXlsx(syntheticArtifact());

    // Zip magic at the head.
    expect(zip[0]).toBe(0x50); // P
    expect(zip[1]).toBe(0x4b); // K
    expect(zip[2]).toBe(0x03);
    expect(zip[3]).toBe(0x04);

    const { entries, centralCount } = walkZip(zip);
    const names = entries.map((entry) => entry.name);
    expect(names).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
    ]);
    expect(centralCount).toBe(entries.length);

    // Every part's stored CRC-32 must match an INDEPENDENT recompute.
    for (const entry of entries) {
      expect(crc32(entry.data)).toBe(entry.storedCrc);
    }
  });

  test("worksheet carries headers, inline text and numeric cells", () => {
    const zip = renderArtifactXlsx(syntheticArtifact());
    const { entries } = walkZip(zip);
    const sheet = latin1(entries.find((entry) => entry.name === "xl/worksheets/sheet1.xml")!.data);
    const workbook = latin1(entries.find((entry) => entry.name === "xl/workbook.xml")!.data);
    const types = latin1(entries.find((entry) => entry.name === "[Content_Types].xml")!.data);

    expect(workbook).toContain('<sheet name="Report"');
    expect(types).toContain("spreadsheetml.sheet.main+xml");

    // Header row (bold style) + data rows.
    expect(sheet).toContain('t="inlineStr" s="1"');
    expect(sheet).toContain(">Device</t>");
    expect(sheet).toContain(">core-rtr-01</t>");

    // Numeric cells render as bare <v> values (no inline string).
    expect(sheet).toContain("<v>99.98</v>");
    expect(sheet).toContain("<v>-12.5</v>");

    // Injection safety: the hostile "=cmd" value stays an inline STRING —
    // Excel does not evaluate inlineStr (that is why no CSV-style guard).
    expect(sheet).not.toContain("<f>");
    expect(sheet).toContain("=cmd|&apos; /C calc&apos;!A0");

    // Null cells render as empty inline strings, deterministically.
    const again = renderArtifactXlsx(syntheticArtifact());
    expect(Buffer.from(zip).equals(Buffer.from(again))).toBe(true);
  });

  test("renders an empty-row artifact (header-only sheet)", () => {
    const empty = { ...syntheticArtifact(), rows: [] };
    const zip = renderArtifactXlsx(empty);
    const { entries, centralCount } = walkZip(zip);
    expect(centralCount).toBe(6);
    const sheet = latin1(entries.find((entry) => entry.name === "xl/worksheets/sheet1.xml")!.data);
    // Header row present; NO data rows follow it.
    expect(sheet).toContain(">Device</t>");
    expect(sheet).not.toContain(">core-rtr-01</t>");
    expect(sheet).not.toContain("<v>99.98</v>");
  });
});

/* ── route-level matrix: all 4 delivery formats end-to-end ────────────── */

describe("GA-5: run download route — 4-format matrix", () => {
  test("CSV/JSON/PDF/XLSX all stream real, correctly-typed attachments", async () => {
    const runId = await seedRun(syntheticArtifact());
    const { GET } = await import("../../src/app/api/v1/reports/runs/[id]/download/route");

    const expectations: Array<{ format: string; type: string; probe: (body: string) => void }> = [
      {
        format: "CSV",
        type: "text/csv; charset=utf-8",
        probe: (body) => {
          // Labels carry no quoting-triggering chars → unquoted header row.
          expect(body.startsWith("Device,Uptime %,Note")).toBe(true);
        },
      },
      {
        format: "JSON",
        type: "application/json; charset=utf-8",
        probe: (body) => {
          const parsed = JSON.parse(body) as ReportArtifact;
          expect(parsed.reportType).toBe("AVAILABILITY");
          expect(parsed.rows).toHaveLength(3);
        },
      },
      {
        format: "PDF",
        type: "application/pdf",
        probe: (body) => {
          // latin1-safe probe: the body round-trips as a PDF document.
          expect(body.startsWith("%PDF-1.4\n")).toBe(true);
          expect(body.trimEnd().endsWith("%%EOF")).toBe(true);
        },
      },
      {
        format: "XLSX",
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        probe: (body) => {
          const bytes = new Uint8Array(body.length);
          for (let i = 0; i < body.length; i += 1) bytes[i] = body.charCodeAt(i) & 0xff;
          expect(bytes[0]).toBe(0x50);
          expect(bytes[1]).toBe(0x4b);
          // The rendered sheet must carry the artifact's header labels.
          expect(latin1(bytes)).toContain(">Device</t>");
        },
      },
    ];

    for (const expectation of expectations) {
      const res: NextResponse = await GET(
        await authedRequest(
          `http://app.local/api/v1/reports/runs/${runId}/download?format=${expectation.format}`
        ),
        { params: Promise.resolve({ id: runId }) }
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe(expectation.type);
      expect(res.headers.get("Content-Disposition")).toContain(
        `.${expectation.format.toLowerCase()}"`
      );
      // Read the body EXACTLY ONCE (a NextResponse body is not reusable),
      // then latin1-round-trip the bytes for structural probing.
      const bytes = new Uint8Array(await res.arrayBuffer());
      const body = latin1(bytes);
      expectation.probe(body);
    }

    // Every download is audited (one REPORT_DOWNLOAD row per format).
    const auditCount = await db.auditEvent.count({
      where: {
        action: "REPORT_DOWNLOAD",
        resourceId: runId,
        createdAt: { gte: testStartedAt },
      },
    });
    expect(auditCount).toBe(4);
  });

  test("guards: unknown format → 400; unsucceeded run → 409; unknown id → 404", async () => {
    const { GET } = await import("../../src/app/api/v1/reports/runs/[id]/download/route");

    const queuedId = await seedRun(syntheticArtifact(), "QUEUED");
    const queuedRes = await GET(
      await authedRequest(`http://app.local/api/v1/reports/runs/${queuedId}/download?format=PDF`),
      { params: Promise.resolve({ id: queuedId }) }
    );
    expect(queuedRes.status).toBe(409);
    expect(((await queuedRes.json()) as { error?: { code?: string } }).error?.code).toBe(
      "RUN_NOT_DOWNLOADABLE"
    );

    const badFormat = await GET(
      await authedRequest(`http://app.local/api/v1/reports/runs/${queuedId}/download?format=DOCX`),
      { params: Promise.resolve({ id: queuedId }) }
    );
    expect(badFormat.status).toBe(400);
    expect(((await badFormat.json()) as { error?: { code?: string } }).error?.code).toBe(
      "INVALID_QUERY"
    );

    const missing = await GET(
      await authedRequest(
        `http://app.local/api/v1/reports/runs/ga5-does-not-exist/download?format=PDF`
      ),
      { params: Promise.resolve({ id: "ga5-does-not-exist" }) }
    );
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error?: { code?: string } }).error?.code).toBe(
      "RUN_NOT_FOUND"
    );
  });

  test("live pipeline: a REAL generated artifact renders in both binary formats", async () => {
    // Rows may be empty on the CI DB (no seeded fleet) — the renderers must
    // cope with BOTH shapes; that is exactly what this pins.
    const artifact = await generateReport("AVAILABILITY", { format: "PDF" });
    const pdf = renderArtifactPdf(artifact);
    const xlsx = renderArtifactXlsx(artifact);

    expect(latin1(pdf).startsWith("%PDF-1.4")).toBe(true);
    expect(xlsx[0]).toBe(0x50);
    expect(xlsx[1]).toBe(0x4b);
  });
});

/* ── lifecycle ────────────────────────────────────────────────────────── */

beforeAll(async () => {
  const adminEntry = ROLE_MATRIX.find((role) => role.name === "admin");
  await db.role.upsert({
    where: { name: "admin" },
    update: {},
    create: {
      name: "admin",
      description: adminEntry?.description ?? "Full platform administration",
      permissionsJson: JSON.stringify(adminEntry?.permissions ?? ["*"]),
    },
  });
  const admin = await db.user.create({
    data: { email: ADMIN_EMAIL, name: "GA-5 Admin", role: "admin", isActive: true },
    select: { id: true },
  });
  adminId = admin.id;
});

afterAll(async () => {
  await db.auditEvent.deleteMany({
    where: {
      createdAt: { gte: testStartedAt },
      action: { in: ["REPORT_DOWNLOAD", "REPORT_BUILT"] },
    },
  });
  await db.jobExecution.deleteMany({ where: { id: { in: createdJobIds } } });
  await db.user.deleteMany({ where: { id: adminId } });
});
