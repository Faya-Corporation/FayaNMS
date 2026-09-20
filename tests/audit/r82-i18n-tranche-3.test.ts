import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * R82 — i18n tranche 3: perf-interfaces keyed.
 *
 * Pins:
 *   A. The NEW `perfInterfaces` namespace exists in BOTH dictionaries
 *      with EXACTLY 30 leaves each, deep parity (identical leaf-path
 *      sets both directions) and non-empty string values everywhere.
 *   B. The view consumes the namespace in all three component scopes
 *      (main view + InterfaceRow + UtilBar each call useTranslations).
 *   C. Sweep candidates: perf-interfaces-view.tsx is at ZERO (hand-
 *      cleaned against the full inventory — including non-swept
 *      literals the shallow regexes never matched: the SORT_CHIPS
 *      module-level labels, the PageHeader/SectionCard/pagination
 *      template literals, and the UtilBar sr-only ternary suffixes).
 *   D. Source pins: the pre-tranche literals are GONE from the file
 *      (title, sort chips, toolbar, empty state, pagination summary,
 *      sr-only ternary — each individually asserted absent).
 *   E. Ledger governance: the r56 sweep no longer ledger
 *      perf-interfaces-view.tsx, the numeric ledger carried EXACTLY 22
 *      entries at R82 HEAD (20 since R83's tranche 4 — the pins below
 *      track HEAD truth), and the LIVE candidate sum over the ledgered
 *      files was EXACTLY 730 at R82 HEAD (690 since R83 — computed from
 *      the tree, not quoted).
 *   F. Documented cross-view survivor: the shared perf chrome
 *      (PerfRangeChips + perfRangeLabel) is still imported from
 *      perf-overview-view.tsx — it stays English until the
 *      perf-overview tranche keys it; this pin makes the dependency
 *      explicit so the perf-overview work cannot silently regress it.
 *   G. Interpolation shape: the dictionary values carry the ICU/ICU-like
 *      placeholders the view passes ({range}, {total}, {page},
 *      {totalPages}, {pct}).
 *
 * Documented technical survivors (unchanged policy): fmtSpeed's Gb/s and
 * Mb/s units (locale-neutral technical tokens), "—" placeholders, the
 * sr-only " — " separator, data-plane title={row.hostname}/ifName.
 */

const REPO = join(import.meta.dir, "..", "..");
const VIEWS = "src/components/views";
const VIEW = "perf-interfaces-view.tsx";

const PROP_RE = /\b(title|placeholder|aria-label|label|description|heading)="([A-Z][^"]{2,})"/g;
const JSX_RE = />\s*([A-Z][a-zA-Z0-9 ,.·…—''-]{2,70})\s*</g;

type Messages = Record<string, unknown>;

function leaves(obj: unknown, prefix = "", acc: string[] = []): string[] {
  if (obj !== null && typeof obj === "object") {
    for (const [key, value] of Object.entries(obj as Messages)) {
      leaves(value, prefix ? `${prefix}.${key}` : key, acc);
    }
  } else {
    acc.push(prefix);
  }
  return acc;
}

function readJson(rel: string): Messages {
  return JSON.parse(readFileSync(join(REPO, rel), "utf8")) as Messages;
}

function readRepo(rel: string): string {
  return readFileSync(join(REPO, rel), "utf8");
}

function candidates(src: string): string[] {
  return [
    ...[...src.matchAll(PROP_RE)].map((m) => m[2]),
    ...[...src.matchAll(JSX_RE)].map((m) => m[1]),
  ];
}

describe("R82 — tranche 3 namespace exists and is balanced", () => {
  test("A: perfInterfaces exists in both dictionaries with EXACTLY 30 leaves", () => {
    const en = readJson("messages/en.json") as Record<string, Messages>;
    const ar = readJson("messages/ar.json") as Record<string, Messages>;
    expect(en.perfInterfaces, "en.perfInterfaces").toBeDefined();
    expect(ar.perfInterfaces, "ar.perfInterfaces").toBeDefined();
    expect(leaves(en.perfInterfaces).length).toBe(30);
    expect(leaves(ar.perfInterfaces).length).toBe(30);
  });

  test("A: deep parity — identical leaf paths in BOTH directions", () => {
    const en = readJson("messages/en.json") as Record<string, Messages>;
    const ar = readJson("messages/ar.json") as Record<string, Messages>;
    const enSet = new Set(leaves(en.perfInterfaces));
    const arSet = new Set(leaves(ar.perfInterfaces));
    expect(Array.from(enSet).filter((k) => !arSet.has(k))).toEqual([]);
    expect(Array.from(arSet).filter((k) => !enSet.has(k))).toEqual([]);
  });

  test("A: every perfInterfaces leaf value is a non-empty string in both locales", () => {
    for (const file of ["messages/en.json", "messages/ar.json"]) {
      const json = readJson(file) as Record<string, Messages>;
      const walk = (node: unknown, path: string) => {
        if (node !== null && typeof node === "object") {
          for (const [k, v] of Object.entries(node as Messages)) {
            walk(v, `${path}.${k}`);
          }
          return;
        }
        expect(typeof node === "string" && node.length > 0, `${file}:${path}`).toBe(true);
      };
      walk(json.perfInterfaces, "perfInterfaces");
    }
  });

  test("G: interpolation placeholders are present in the dictionary values", () => {
    const en = readJson("messages/en.json") as Record<string, Messages>;
    const ns = en.perfInterfaces as Messages;
    expect((ns.description as string)).toContain("{range}");
    expect(((ns.table as Messages).ariaLabel as string)).toContain("{range}");
    expect(((ns.table as Messages).cardTitleCounted as string)).toContain("{total}");
    expect((ns.pagination as Messages).summary as string).toContain("{page}");
    expect((ns.pagination as Messages).summary as string).toContain("{totalPages}");
    expect((ns.pagination as Messages).summary as string).toContain("{total}");
    expect((ns.sr as Messages).utilization as string).toContain("{pct}");
  });
});

describe("R82 — perf-interfaces is keyed", () => {
  test("B: the view consumes the namespace in all three component scopes", () => {
    const src = readRepo(`${VIEWS}/${VIEW}`);
    const hits = src.match(/useTranslations\("perfInterfaces"\)/g) ?? [];
    expect(hits.length).toBe(3); // PerfInterfacesView + InterfaceRow + UtilBar
  });

  test("C: the view sweeps at ZERO candidates", () => {
    const found = candidates(readRepo(`${VIEWS}/${VIEW}`));
    expect(found, "perf-interfaces still carries literals").toEqual([]);
  });

  test("D: the pre-tranche literals are gone from the file", () => {
    const src = readRepo(`${VIEWS}/${VIEW}`);
    const gone: string[] = [
      'title="Interface Utilization"',
      "Per-interface in/out utilization and loss —",
      'aria-label="Sort by"',
      'label: "Utilization"',
      'label: "Packet loss"',
      ">Search interfaces<",
      'placeholder="Search host or ifName',
      'aria-label="Site"',
      ">Any site<",
      ">Reset<",
      "Interface performance could not be loaded</",
      "No interfaces match the current filters",
      ">No interface rows to show<",
      "Interfaces${listMeta",
      "Page {listMeta.page} of",
      ">Previous<",
      ">Next<",
      "open device detail</span>",
      "utilization{pct > 80",
      " — critical\" : pct > 60",
    ];
    for (const literal of gone) {
      expect(src.includes(literal), `literal still present: ${literal}`).toBe(false);
    }
  });

  test("D: keyed call sites exist for the full inventory", () => {
    const src = readRepo(`${VIEWS}/${VIEW}`);
    for (const key of [
      't("title")',
      't("description", { range: perfRangeLabel(range) })',
      't("sort.groupAria")',
      "t(`sort.${chip.labelKey}`)",
      't("toolbar.searchSr")',
      't("toolbar.searchPlaceholder")',
      't("toolbar.siteAria")',
      't("toolbar.anySite")',
      't("toolbar.reset")',
      't("table.cardTitleCounted", { total: listMeta.total })',
      't("table.cardTitle")',
      't("error.title")',
      't("table.emptyDescription")',
      't("table.emptyTitle")',
      't("table.ariaLabel", { range: perfRangeLabel(range) })',
      't("table.col.interface")',
      't("table.col.oper")',
      't("table.col.speed")',
      't("table.col.in")',
      't("table.col.out")',
      't("table.col.peak")',
      't("table.col.loss")',
      't("pagination.summary", {',
      't("pagination.prev")',
      't("pagination.next")',
      't("row.openDevice")',
      't("sr.utilization", { pct: fmtPct(pct) })',
      't("sr.critical")',
      't("sr.high")',
    ]) {
      expect(src.includes(key), `missing keyed call site: ${key}`).toBe(true);
    }
  });
});

describe("R82 — ledger governance", () => {
  test("E: the r56 ledger no longer lists perf-interfaces-view", () => {
    const sweep = readRepo("tests/audit/r56-i18n-chrome-sweep.test.ts");
    expect(/"perf-interfaces-view\.tsx":\s*\d/.test(sweep)).toBe(false);
  });

  test("E: the numeric ledger carries EXACTLY 18 entries (22 − 2 R83 − 2 R84)", () => {
    const sweep = readRepo("tests/audit/r56-i18n-chrome-sweep.test.ts");
    const block = sweep.slice(sweep.indexOf("const PENDING_VIEWS"));
    const entries = Array.from(block.matchAll(/"([a-z-]+-view\.tsx)":\s*(\d+)/g));
    expect(entries.length).toBe(18);
  });

  test("E: the LIVE candidate sum over ledgered files is EXACTLY 646 (730 − 40 R83 − 44 R84)", () => {
    const sweep = readRepo("tests/audit/r56-i18n-chrome-sweep.test.ts");
    const block = sweep.slice(sweep.indexOf("const PENDING_VIEWS"));
    const entries = Array.from(block.matchAll(/"([a-z-]+-view\.tsx)":\s*(\d+)/g));
    let sum = 0;
    for (const [, file] of entries) {
      sum += candidates(readRepo(`${VIEWS}/${file}`)).length;
    }
    expect(sum).toBe(646);
  });
});

describe("R82 — documented cross-view survivor", () => {
  test("F: the shared perf chrome import is intact (English until perf-overview tranche)", () => {
    const src = readRepo(`${VIEWS}/${VIEW}`);
    expect(src).toContain(
      'import { PerfRangeChips, fmtPct, perfRangeLabel } from "./perf-overview-view";'
    );
    expect(src).toContain("perf-overview tranche");
  });

  test("F: locale-neutral technical tokens survive (fmtSpeed units, em-dash placeholders)", () => {
    const src = readRepo(`${VIEWS}/${VIEW}`);
    expect(src).toContain("Gb/s`");
    expect(src).toContain("Mb/s`");
    expect(src).toContain('return "—";');
  });
});
