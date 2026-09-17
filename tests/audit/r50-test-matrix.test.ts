import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

/**
 * R50.8 — the test-matrix GOVERNANCE pin.
 *
 * The R50 remediation roadmap's §10 "Test Matrix" defines 42 coverage
 * cells across five groups. The consolidation pass (this increment)
 * mapped every cell onto executable evidence in
 * docs/audits/FayaNMS-R50.8-Test-Matrix-2026-09-17.md and CLOSED the
 * authorable gaps (tests/audit/r50-worker-detect-failures.test.ts +
 * tests/browser/detection-journeys.test.ts).
 *
 * THIS suite keeps that mapping honest forever:
 *   - every roadmap §10 cell literal must have a registry row in the
 *     matrix doc (roadmap ↔ matrix bidirectional, the same discipline the
 *     contract suite uses for the error-code registry);
 *   - every disposition must come from the closed vocabulary;
 *   - every COVERED / GAP-CLOSED-R50.8 row must cite evidence as
 *     "file :: marker" chains (" + "-joined) where the file EXISTS and
 *     contains the marker — a renamed test or deleted suite fails here;
 *   - the gap-closure must stay real (the two NEW suites must exist and
 *     pin their named cases — the matrix cannot silently regress to
 *     "documented only");
 *   - the N-A row keeps its written rationale (tenant crossing).
 */

const ROADMAP = "docs/audits/FayaNMS-R50-Vendor-IP-Autodetect-Remediation-Roadmap-2026-09-16.md";
const MATRIX = "docs/audits/FayaNMS-R50.8-Test-Matrix-2026-09-17.md";
const WORKER_SUITE = "tests/audit/r50-worker-detect-failures.test.ts";
const BROWSER_SUITE = "tests/browser/detection-journeys.test.ts";

const DISPOSITIONS = ["COVERED", "GAP-CLOSED-R50.8", "LIVE-EVIDENCE", "N-A-DOCUMENTED"] as const;

interface MatrixRow {
  cell: string;
  disposition: (typeof DISPOSITIONS)[number];
  evidence: string;
}

/** Roadmap §10 cells: the "- <literal>" list items between §10 and §11. */
function roadmapCells(): string[] {
  const doc = readFileSync(ROADMAP, "utf8");
  const start = doc.indexOf("# 10. Phase R50.8");
  const end = doc.indexOf("# 11. Phase R50.9");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return doc
    .slice(start, end)
    .split("\n")
    .filter((line) => /^- /.test(line))
    .map((line) => line.slice(2).trim())
    .filter((cell) => cell.length > 0);
}

/** Registry rows: "| cell | DISPOSITION | evidence |" table lines. */
function matrixRows(): MatrixRow[] {
  const doc = readFileSync(MATRIX, "utf8");
  const rows: MatrixRow[] = [];
  for (const line of doc.split("\n")) {
    const match = line.match(/^\| (.+?) \| ([A-Z0-9.\-]+) \| (.+?) \|$/);
    if (!match) continue;
    const [, cell, disposition, evidence] = match;
    if (cell === "Cell (roadmap §10 literal)") continue; // header row
    rows.push({
      cell: cell.trim(),
      disposition: disposition.trim() as MatrixRow["disposition"],
      evidence: evidence.trim(),
    });
  }
  return rows;
}

describe("R50.8 — test-matrix governance (roadmap §10 ↔ matrix doc)", () => {
  const cells = roadmapCells();
  const rows = matrixRows();

  test("the roadmap §10 defines exactly 41 cells and every one has a registry row", () => {
    expect(cells.length).toBe(41);
    const covered = new Set(rows.map((row) => row.cell));
    const missing = cells.filter((cell) => !covered.has(cell));
    expect(missing).toEqual([]);
  });

  test("every registry row uses a disposition from the closed vocabulary", () => {
    expect(rows.length).toBeGreaterThanOrEqual(41);
    for (const row of rows) {
      expect(DISPOSITIONS as readonly string[]).toContain(row.disposition);
      expect(row.evidence.length).toBeGreaterThan(0);
    }
  });

  test("every COVERED / GAP-CLOSED row cites an EXISTING file containing its marker", () => {
    for (const row of rows) {
      if (row.disposition !== "COVERED" && row.disposition !== "GAP-CLOSED-R50.8") continue;
      for (const entry of row.evidence.split(" + ")) {
        const [file, ...markerParts] = entry.split(" :: ");
        expect(file, `row "${row.cell}" evidence must be "file :: marker"`).toBeTruthy();
        const marker = markerParts.join(" :: ").trim();
        expect(existsSync(file!), `row "${row.cell}": file ${file} must exist`).toBe(true);
        const content = readFileSync(file!, "utf8");
        expect(
          content.includes(marker),
          `row "${row.cell}": ${file} must contain the marker "${marker}"`,
        ).toBe(true);
      }
    }
  });

  test("the gap closure is real: the two NEW suites exist and pin their cases", () => {
    expect(existsSync(WORKER_SUITE)).toBe(true);
    expect(existsSync(BROWSER_SUITE)).toBe(true);
    const worker = readFileSync(WORKER_SUITE, "utf8");
    const browser = readFileSync(BROWSER_SUITE, "utf8");
    // The worker failure matrix pins the seven closed §10.3 behaviors.
    for (const marker of [
      "probe fallback",
      "auth-failure control",
      "auth failure — wrong vault secret",
      "host-key mismatch",
      "connect failure",
      "output truncation",
      "worker-plane loopback refusal",
      "vault miss",
      "timeout behavior",
    ]) {
      expect(worker.includes(marker), `worker suite must pin "${marker}"`).toBe(true);
    }
    // The detection journeys pin the seven closed §10.5 cells (D6–D12).
    for (const marker of ["D6:", "D7:", "D8+D9:", "D10:", "D11:", "D12:"]) {
      expect(browser.includes(marker), `browser suite must pin "${marker}"`).toBe(true);
    }
  });

  test("the gap-closure volume cannot silently shrink", () => {
    const gapClosed = rows.filter((row) => row.disposition === "GAP-CLOSED-R50.8");
    expect(gapClosed.length).toBeGreaterThanOrEqual(14);
    const bySuite = (file: string): number =>
      gapClosed.filter((row) => row.evidence.includes(file)).length;
    expect(bySuite(WORKER_SUITE)).toBeGreaterThanOrEqual(7);
    expect(bySuite(BROWSER_SUITE)).toBeGreaterThanOrEqual(5);
  });

  test("R51-D1 — §4 prose counts are pinned to the §3 registry (26→24 COVERED drift)", () => {
    // The registry is the single source of truth; the doc's §4 summary
    // previously claimed "26 cells COVERED" against 24 actual rows. Pin
    // every disposition count so the prose can never drift again.
    const count = (d: MatrixRow["disposition"]): number =>
      rows.filter((row) => row.disposition === d).length;
    expect(count("COVERED")).toBe(24);
    expect(count("GAP-CLOSED-R50.8")).toBe(14);
    expect(count("LIVE-EVIDENCE")).toBe(2);
    expect(count("N-A-DOCUMENTED")).toBe(1);
    // The four dispositions partition the 41 roadmap cells exactly.
    expect(count("COVERED") + count("GAP-CLOSED-R50.8") + count("LIVE-EVIDENCE") + count("N-A-DOCUMENTED")).toBe(41);
    // And the §4 prose itself carries the corrected numbers (no silent rewrite).
    const docText = readFileSync(MATRIX, "utf8");
    expect(docText).toContain("24 cells `COVERED`");
    expect(docText).not.toContain("26 cells `COVERED`");
    expect(docText).toContain("1 cell `N-A-DOCUMENTED`");
    expect(docText).toContain("2 cells `LIVE-EVIDENCE`");
  });

  test("the N-A row keeps its written rationale (tenant crossing)", () => {
    const na = rows.filter((row) => row.disposition === "N-A-DOCUMENTED");
    expect(na.length).toBe(1);
    expect(na[0].cell).toBe("tenant crossing");
    const doc = readFileSync(MATRIX, "utf8");
    expect(doc).toContain("single-tenant schema");
    expect(doc).toContain('tenantScope: "single-tenant"');
  });

  test("the LIVE-EVIDENCE rows cite artifacts that exist", () => {
    for (const row of rows) {
      if (row.disposition !== "LIVE-EVIDENCE") continue;
      const docRef = row.evidence.split(" ").find((token) => token.endsWith(".md"));
      expect(docRef, `row "${row.cell}" must cite a doc`).toBeTruthy();
      expect(existsSync(docRef!), `row "${row.cell}": ${docRef} must exist`).toBe(true);
    }
  });
});
