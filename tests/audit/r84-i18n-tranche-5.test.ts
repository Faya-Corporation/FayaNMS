import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * R84 — i18n tranche 5: incidents + perf-availability keyed (two views).
 *
 * Pins:
 *   A. The NEW `incidents` (38 leaves) and `perfAvailability` (28 leaves)
 *      namespaces exist in BOTH dictionaries, deep parity (identical
 *      leaf-path sets both directions) and non-empty string values
 *      everywhere.
 *   B. The views consume their namespaces in every component scope
 *      (IncidentsView is a single scope — chips/rows/pagination are
 *      inline in its render, closing over t; PerfAvailabilityView spans
 *      FOUR scopes: the view + OverallCard + SiteTable + DeviceTable).
 *   C. Sweep candidates: both files are at ZERO (hand-cleaned against
 *      the full inventory — including non-swept literals the shallow
 *      regexes never matched: the STATUS_GROUPS module-level labels
 *      (resolved via t(`group.${key}`) — the R82 SORT_CHIPS precedent),
 *      the KPI "live" status chip, the {count}/{samples}/{days}/{met}
 *      KPI description templates, the row.counts ICU plural strip, the
 *      OverallCard target chip + progress aria + meets/below ternary,
 *      and the pagination summary template).
 *   D. Source pins: the pre-tranche literals are GONE from both files
 *      (each individually asserted absent).
 *   E. Ledger governance: the r56 sweep no longer ledgers the two
 *      files, the numeric ledger carries EXACTLY 18 entries, and the
 *      LIVE candidate sum over the ledgered files is EXACTLY 446
 *      (computed from the tree, not quoted).
 *   F. Interpolation shape: the dictionary values carry the placeholders
 *      the views pass ({count}, {samples}, {days}, {met}, {total},
 *      {page}, {totalPages}, {range}, {pct}, {target}, {delta}, {devices},
 *      {alerts}) — plus the row.counts ICU plural with locale-appropriate
 *      categories (en one/other; ar zero/one/two/few/many/other — the R81
 *      unsaved-changes precedent, with ar zero added because 0-alert rows
 *      occur).
 *   G. Documented technical survivors (unchanged policy): date-fns
 *      formatDistanceToNow relative time stays English (no date-fns ar
 *      locale wired anywhere — device-config-tab + R83 precedent), the
 *      openBySeverity KPI description (static config SEV tokens split
 *      from " — ", data-plane ConfidenceBadge precedent), fmtMinutes/
 *      fmtDowntime unit tokens ("min"/"h"/"d") and "—" placeholders (NOC
 *      "MTTA {m}m" precedent), and the shared perf chrome import from
 *      perf-overview-view.tsx (keyed by the perf-overview tranche, R85 —
 *      the chrome now renders in the active locale via a perfOverview
 *      tRange hook).
 */

const REPO = join(import.meta.dir, "..", "..");
const VIEWS = "src/components/views";
const INCIDENTS = "incidents-view.tsx";
const PERF_AVAIL = "perf-availability-view.tsx";

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

describe("R84 — tranche 5 namespaces exist and are balanced", () => {
  test("A: incidents exists in both dictionaries with EXACTLY 38 leaves", () => {
    const en = readJson("messages/en.json") as Record<string, Messages>;
    const ar = readJson("messages/ar.json") as Record<string, Messages>;
    expect(en.incidents, "en.incidents").toBeDefined();
    expect(ar.incidents, "ar.incidents").toBeDefined();
    expect(leaves(en.incidents).length).toBe(38);
    expect(leaves(ar.incidents).length).toBe(38);
  });

  test("A: perfAvailability exists in both dictionaries with EXACTLY 28 leaves", () => {
    const en = readJson("messages/en.json") as Record<string, Messages>;
    const ar = readJson("messages/ar.json") as Record<string, Messages>;
    expect(en.perfAvailability, "en.perfAvailability").toBeDefined();
    expect(ar.perfAvailability, "ar.perfAvailability").toBeDefined();
    expect(leaves(en.perfAvailability).length).toBe(28);
    expect(leaves(ar.perfAvailability).length).toBe(28);
  });

  test("A: deep parity — identical leaf paths in BOTH directions (both namespaces)", () => {
    const en = readJson("messages/en.json") as Record<string, Messages>;
    const ar = readJson("messages/ar.json") as Record<string, Messages>;
    for (const ns of ["incidents", "perfAvailability"]) {
      const enSet = new Set(leaves(en[ns]));
      const arSet = new Set(leaves(ar[ns]));
      expect(Array.from(enSet).filter((k) => !arSet.has(k)), `en-only in ${ns}`).toEqual([]);
      expect(Array.from(arSet).filter((k) => !enSet.has(k)), `ar-only in ${ns}`).toEqual([]);
    }
  });

  test("A: every tranche-5 leaf value is a non-empty string in both locales", () => {
    for (const file of ["messages/en.json", "messages/ar.json"]) {
      const json = readJson(file) as Record<string, Messages>;
      for (const ns of ["incidents", "perfAvailability"]) {
        const walk = (node: unknown, path: string) => {
          if (node !== null && typeof node === "object") {
            for (const [k, v] of Object.entries(node as Messages)) {
              walk(v, `${path}.${k}`);
            }
            return;
          }
          expect(typeof node === "string" && node.length > 0, `${file}:${path}`).toBe(true);
        };
        walk(json[ns], ns);
      }
    }
  });

  test("F: interpolation placeholders are present in the dictionary values", () => {
    const en = readJson("messages/en.json") as Record<string, Messages>;
    const inc = en.incidents as Messages;
    const kpi = inc.kpi as Messages;
    expect(kpi.breachedDesc as string).toContain("{count}");
    expect(kpi.mttaDesc as string).toContain("{samples}");
    expect(kpi.mttaDesc as string).toContain("{days}");
    expect(kpi.mttrDesc as string).toContain("{samples}");
    expect(kpi.mttrDesc as string).toContain("{days}");
    expect(kpi.slaDesc as string).toContain("{met}");
    expect(kpi.slaDesc as string).toContain("{total}");
    expect(kpi.slaDesc as string).toContain("{days}");
    expect((inc.table as Messages).cardTitleCounted as string).toContain("{total}");
    expect((inc.row as Messages).counts as string).toContain("{devices}");
    expect((inc.row as Messages).counts as string).toContain("{alerts");
    expect((inc.pagination as Messages).summary as string).toContain("{page}");
    expect((inc.pagination as Messages).summary as string).toContain("{totalPages}");
    expect((inc.pagination as Messages).summary as string).toContain("{total}");

    const pa = en.perfAvailability as Messages;
    expect(pa.description as string).toContain("{range}");
    const overall = pa.overall as Messages;
    expect(overall.target as string).toContain("{pct}");
    expect(overall.progressAria as string).toContain("{pct}");
    expect(overall.progressAria as string).toContain("{target}");
    expect(overall.below as string).toContain("{delta}");
  });

  test("F: the row.counts ICU plural carries locale-appropriate categories", () => {
    const en = readJson("messages/en.json") as Record<string, Messages>;
    const ar = readJson("messages/ar.json") as Record<string, Messages>;
    const enCounts = (en.incidents as Messages).row as Messages;
    const arCounts = (ar.incidents as Messages).row as Messages;
    // en: one/other (the R81 unsaved-changes en shape)
    expect(enCounts.counts as string).toContain("one {");
    expect(enCounts.counts as string).toContain("other {");
    // ar: zero/one/two/few/many/other (R81 precedent + zero — 0-alert rows occur)
    for (const category of ["zero {", "one {", "two {", "few {", "many {", "other {"]) {
      expect(arCounts.counts as string).toContain(category);
    }
  });
});

describe("R84 — incidents is keyed", () => {
  test("B: the view consumes the namespace in its single component scope", () => {
    const src = readRepo(`${VIEWS}/${INCIDENTS}`);
    const hits = src.match(/useTranslations\("incidents"\)/g) ?? [];
    expect(hits.length).toBe(1); // IncidentsView (chips/rows/pagination inline, closing over t)
  });

  test("C: the view sweeps at ZERO candidates", () => {
    const found = candidates(readRepo(`${VIEWS}/${INCIDENTS}`));
    expect(found, "incidents still carries literals").toEqual([]);
  });

  test("D: the pre-tranche literals are gone from the file", () => {
    const src = readRepo(`${VIEWS}/${INCIDENTS}`);
    const gone: string[] = [
      'title="Incidents"',
      "Incident lifecycle with SLA timers",
      'label="Open incidents"',
      'label: "live"',
      "past their SLA target`",
      "Mean time to acknowledge · ${",
      "Mean time to resolve · ${",
      'label="MTTA"',
      'label="MTTR"',
      "resolved within SLA / ${",
      'label="SLA compliance"',
      'label: "All"',
      'label: "Active"',
      'label: "Resolved"',
      'label: "In review"',
      'label: "Closed"',
      ">SLA breached",
      ">Search incidents<",
      'placeholder="Search title or number…"',
      'aria-label="Severity"',
      ">Any severity<",
      'aria-label="Site"',
      ">Any site<",
      'aria-label="Sort"',
      ">Newest first<",
      ">Severity (SEV1 first)<",
      ">SLA due soonest<",
      ">Reset<",
      "Incidents${listMeta",
      "Incidents could not be loaded</",
      "No incidents match the current filter.",
      ">No incidents to show<",
      "} dev · {incident._count.alerts} alert",
      "Page {listMeta.page} of",
      ">Previous<",
      ">Next<",
    ];
    for (const literal of gone) {
      expect(src.includes(literal), `literal still present: ${literal}`).toBe(false);
    }
  });

  test("D: keyed call sites exist for the full inventory", () => {
    const src = readRepo(`${VIEWS}/${INCIDENTS}`);
    for (const key of [
      't("title")',
      't("description")',
      't("kpi.open")',
      't("kpi.live")',
      't("kpi.breached")',
      't("kpi.breachedDesc", { count: statsData.breachedCount })',
      't("kpi.mtta")',
      't("kpi.mttaDesc", {',
      't("kpi.mttr")',
      't("kpi.mttrDesc", {',
      't("kpi.sla")',
      't("kpi.slaDesc", {',
      "t(`group.${entry.key}`)",
      't("group.slaBreached")',
      't("toolbar.searchSr")',
      't("toolbar.searchPlaceholder")',
      't("toolbar.severityAria")',
      't("toolbar.anySeverity")',
      't("toolbar.siteAria")',
      't("toolbar.anySite")',
      't("toolbar.sortAria")',
      't("sort.createdAt")',
      't("sort.severity")',
      't("sort.slaDueAt")',
      't("toolbar.reset")',
      't("table.cardTitleCounted", { total: listMeta.total })',
      't("table.cardTitle")',
      't("error.title")',
      't("empty.title")',
      't("empty.description")',
      't("row.counts", {',
      't("pagination.summary", {',
      't("pagination.prev")',
      't("pagination.next")',
    ]) {
      expect(src.includes(key), `missing keyed call site: ${key}`).toBe(true);
    }
  });
});

describe("R84 — perf-availability is keyed", () => {
  test("B: the view consumes the namespace in all FOUR component scopes", () => {
    const src = readRepo(`${VIEWS}/${PERF_AVAIL}`);
    const hits = src.match(/useTranslations\("perfAvailability"\)/g) ?? [];
    expect(hits.length).toBe(4); // PerfAvailabilityView + OverallCard + SiteTable + DeviceTable
  });

  test("C: the view sweeps at ZERO candidates", () => {
    const found = candidates(readRepo(`${VIEWS}/${PERF_AVAIL}`));
    expect(found, "perf-availability still carries literals").toEqual([]);
  });

  test("D: the pre-tranche literals are gone from the file", () => {
    const src = readRepo(`${VIEWS}/${PERF_AVAIL}`);
    const gone: string[] = [
      'title="Availability"',
      "Uptime and SLA attainment — ${",
      "Availability data could not be loaded</",
      'title="Fleet Availability"',
      "Target {fmtPct(target, 2)}",
      "Fleet availability ${fmtPct(overallPct, 2)} against target ${",
      "Meeting the SLA target for this window.",
      "Below target by ${",
      'title="By Site"',
      'description="Worst site first"',
      "No sites have availability samples in this window.",
      'title="No site data"',
      'aria-label="Availability by site — uptime vs the SLA target, worst sites first"',
      'description="Worst 25 devices in the selected window"',
      'title="By Device — worst 25"',
      "No device availability samples in this window.",
      'title="No device data"',
      'aria-label="Availability by device — uptime vs the SLA target, worst devices first"',
      'scope="col">Site<',
      'scope="col">Uptime<',
      'scope="col">Degraded<',
      'scope="col">Downtime<',
      'scope="col">Devices<',
      'scope="col">Device<',
      "open device detail</span>",
    ];
    for (const literal of gone) {
      expect(src.includes(literal), `literal still present: ${literal}`).toBe(false);
    }
  });

  test("D: keyed call sites exist for the full inventory", () => {
    const src = readRepo(`${VIEWS}/${PERF_AVAIL}`);
    for (const key of [
      't("title")',
      't("description", { range: perfRangeLabel(range, tRange) })',
      't("error.title")',
      't("overall.cardTitle")',
      't("overall.target", { pct: fmtPct(target, 2) })',
      't("overall.progressAria", {',
      't("overall.meets")',
      't("overall.below", { delta: (target - overallPct).toFixed(2) })',
      't("site.cardTitle")',
      't("site.cardDescription")',
      't("site.emptyTitle")',
      't("site.emptyDescription")',
      't("site.ariaLabel")',
      't("site.col.site")',
      't("site.col.uptime")',
      't("site.col.degraded")',
      't("site.col.downtime")',
      't("site.col.devices")',
      't("device.cardTitle")',
      't("device.cardDescription")',
      't("device.emptyTitle")',
      't("device.emptyDescription")',
      't("device.ariaLabel")',
      't("device.col.device")',
      't("device.col.site")',
      't("device.col.uptime")',
      't("device.col.downtime")',
      't("row.openDevice")',
    ]) {
      expect(src.includes(key), `missing keyed call site: ${key}`).toBe(true);
    }
  });
});

describe("R84 — ledger governance", () => {
  test("E: the r56 ledger no longer lists the two keyed views", () => {
    const sweep = readRepo("tests/audit/r56-i18n-chrome-sweep.test.ts");
    expect(/"incidents-view\.tsx":\s*\d/.test(sweep)).toBe(false);
    expect(/"perf-availability-view\.tsx":\s*\d/.test(sweep)).toBe(false);
  });

  test("E: the numeric ledger carries EXACTLY 4 entries at current HEAD (R98 removed incident detail)", () => {
    const sweep = readRepo("tests/audit/r56-i18n-chrome-sweep.test.ts");
    const block = sweep.slice(sweep.indexOf("const PENDING_VIEWS"));
    const entries = Array.from(block.matchAll(/"([a-z-]+-view\.tsx)":\s*(\d+)/g));
    expect(entries.length).toBe(4);
  });

  test("E: the LIVE candidate sum over ledgered files is EXACTLY 211 at current HEAD (R98 removed incident detail)", () => {
    const sweep = readRepo("tests/audit/r56-i18n-chrome-sweep.test.ts");
    const block = sweep.slice(sweep.indexOf("const PENDING_VIEWS"));
    const entries = Array.from(block.matchAll(/"([a-z-]+-view\.tsx)":\s*(\d+)/g));
    let sum = 0;
    for (const [, file] of entries) {
      sum += candidates(readRepo(`${VIEWS}/${file}`)).length;
    }
    expect(sum).toBe(211);
  });
});

describe("R84 — documented technical survivors", () => {
  test("G: date-fns relative time stays English (no ar locale wired — device-config-tab precedent)", () => {
    const src = readRepo(`${VIEWS}/${INCIDENTS}`);
    expect(src).toContain('import { formatDistanceToNow } from "date-fns";');
    expect(src).toContain("addSuffix: true");
    expect(src).not.toMatch(/from "date-fns\/locale/);
  });

  test("G: openBySeverity keeps the static config SEV tokens (data-plane ConfidenceBadge precedent)", () => {
    const src = readRepo(`${VIEWS}/${INCIDENTS}`);
    expect(src).toContain(
      "const label = getStatusConfig(INCIDENT_SEVERITY, key).label.split(\" — \")[0];"
    );
  });

  test("G: fmtMinutes/fmtDowntime unit tokens survive (NOC MTTA {m}m precedent)", () => {
    const inc = readRepo(`${VIEWS}/${INCIDENTS}`);
    const avail = readRepo(`${VIEWS}/${PERF_AVAIL}`);
    expect(inc).toContain("min`");
    expect(inc).toContain("h`");
    expect(inc).toContain("d`");
    expect(inc).toContain('return "—";');
    expect(avail).toContain("min`");
    expect(avail).toContain("h`");
    expect(avail).toContain("d`");
    expect(avail).toContain('return "—";');
  });

  test("G: shared perf chrome import intact (keyed by the perf-overview tranche, R85)", () => {
    const src = readRepo(`${VIEWS}/${PERF_AVAIL}`);
    expect(src).toContain(
      'import { PerfRangeChips, fmtPct, perfRangeLabel } from "./perf-overview-view";'
    );
  });
});
