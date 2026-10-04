import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * R85 — i18n tranche 6a: perf-overview keyed + the SHARED PERF CHROME
 * keyed (one view, cross-view payoff).
 *
 * Pins:
 *   A. The NEW `perfOverview` namespace exists in BOTH dictionaries with
 *      EXACTLY 76 leaves, deep parity (identical leaf-path sets both
 *      directions) and non-empty string values everywhere; dictionary
 *      totals move 1,746 → 1,822 = 1,822 (1,851 = 1,851 at HEAD
 *      after R86's +29 collectors leaves).
 *   B. The view consumes its namespace in ALL SEVEN component scopes
 *      (PerfOverviewView, PerfRangeChips, AvailabilityCard, LatencyCard,
 *      ChartEmpty, TopUtilizersCard, RetentionPanel) and the three
 *      already-keyed sibling perf views each keep a `tRange`
 *      useTranslations("perfOverview") hook for the shared chrome.
 *   C. Sweep candidates: perf-overview-view.tsx is at ZERO (hand-cleaned
 *      against the full inventory — including non-swept literals the
 *      shallow regexes never matched: the Updated stamp, the KPI status
 *      ternary, both chart tooltip series labels, the ChartEmpty ternary
 *      pair, TIER_ROWS labels/hints (now resolved via
 *      t(`retention.tier.${key}.label|.hint`) — the R82 SORT_CHIPS /
 *      R81 GROUPS / R84 STATUS_GROUPS dynamic-key precedent), the
 *      {tier} retention aria templates, the Save/Saving· and
 *      Active/Paused ternaries, and the whole prune dialog).
 *   D. Source pins: the pre-tranche literals are GONE from the file
 *      (each individually asserted absent), and the keyed signatures
 *      perfRangeLabel(range, t) / granularityLabel(g, t) are IN.
 *   E. Ledger governance: the r56 sweep no longer ledgers
 *      perf-overview-view, the numeric ledger carries EXACTLY 16
 *      entries, and the LIVE candidate sum over the ledgered files is
 *      EXACTLY 400 (computed from the tree, not quoted).
 *   F. Interpolation shape: the dictionary values carry the placeholders
 *      the views pass ({range}, {granularity}, {unit}, {avg}, {lowest},
 *      {highest}, {peak}, {count}, {tier}, {state}, {samples}, {m5},
 *      {h1}, {d1}, {seconds}) in BOTH locales.
 *   G. Documented technical survivors (unchanged policy): PERF_RANGES
 *      chip tokens (1H/24H/7D/30D — locale-neutral range tokens,
 *      v{version} precedent), fmtPct/fmtMs "%" / "ms" units and em-dash
 *      placeholders, date-fns tick/label formats ("MMM d"/"HH:mm"/
 *      "EEE, MMM d — HH:mm") and formatDistanceToNow relative time (no
 *      ar locale wired anywhere — device-config-tab / R83 / R84
 *      precedent), data-plane hostnames/siteCodes, chart dataKey/name
 *      props, the gradient id, the defensive code-side em-dash
 *      fallbacks, and the YAxis tick formatters.
 */

const REPO = join(import.meta.dir, "..", "..");
const VIEWS = "src/components/views";
const VIEW = "perf-overview-view.tsx";
const PERF_IFACES = "perf-interfaces-view.tsx";
const PERF_DEVICES = "perf-devices-view.tsx";
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

describe("R85 — tranche 6a namespace exists and is balanced", () => {
  test("A: perfOverview exists in both dictionaries with EXACTLY 76 leaves", () => {
    const en = readJson("messages/en.json") as Record<string, any>;
    const ar = readJson("messages/ar.json") as Record<string, any>;
    expect(en.perfOverview, "en.perfOverview").toBeDefined();
    expect(ar.perfOverview, "ar.perfOverview").toBeDefined();
    expect(leaves(en.perfOverview).length).toBe(76);
    expect(leaves(ar.perfOverview).length).toBe(76);
  });

  test("A: dictionary totals are 2,850 = 2,850 at current HEAD (+117 R102)", () => {
    const en = readJson("messages/en.json");
    const ar = readJson("messages/ar.json");
    expect(leaves(en).length).toBe(3385);
    expect(leaves(ar).length).toBe(3385);
  });

  test("A: deep parity — identical leaf paths in BOTH directions", () => {
    const en = readJson("messages/en.json") as Record<string, any>;
    const ar = readJson("messages/ar.json") as Record<string, any>;
    const enSet = new Set(leaves(en.perfOverview));
    const arSet = new Set(leaves(ar.perfOverview));
    expect(Array.from(enSet).filter((k) => !arSet.has(k)), "en-only").toEqual([]);
    expect(Array.from(arSet).filter((k) => !enSet.has(k)), "ar-only").toEqual([]);
  });

  test("A: every perfOverview leaf value is a non-empty string in both locales", () => {
    for (const file of ["messages/en.json", "messages/ar.json"]) {
      const json = readJson(file) as Record<string, any>;
      const walk = (node: unknown, path: string) => {
        if (node !== null && typeof node === "object") {
          for (const [k, v] of Object.entries(node as Messages)) {
            walk(v, `${path}.${k}`);
          }
          return;
        }
        expect(typeof node === "string" && node.length > 0, `${file}:${path}`).toBe(true);
      };
      walk(json.perfOverview, "perfOverview");
    }
  });
});

describe("R85 — namespace consumption across every scope", () => {
  test("B: perf-overview-view consumes perfOverview in ALL SEVEN scopes", () => {
    const src = readRepo(`${VIEWS}/${VIEW}`);
    const hooks = Array.from(src.matchAll(/useTranslations\("perfOverview"\)/g)).length;
    expect(hooks).toBe(7);
  });

  test("B: each sibling perf view keeps a tRange perfOverview hook for the shared chrome", () => {
    for (const file of [PERF_IFACES, PERF_DEVICES, PERF_AVAIL]) {
      const src = readRepo(`${VIEWS}/${file}`);
      expect(
        Array.from(src.matchAll(/useTranslations\("perfOverview"\)/g)).length,
        `${file} tRange hook`
      ).toBe(1);
      expect(src, `${file} passes tRange`).toContain("perfRangeLabel(range, tRange)");
    }
  });
});

describe("R85 — zero sweep candidates + full-inventory keying", () => {
  test("C: perf-overview-view has ZERO literal candidates", () => {
    const found = candidates(readRepo(`${VIEWS}/${VIEW}`));
    expect(found).toEqual([]);
  });

  test("D: the pre-tranche literals are GONE from the file", () => {
    const src = readRepo(`${VIEWS}/${VIEW}`);
    for (const gone of [
      'aria-label="Time range"',
      'description="Fleet-wide performance at a glance — availability, latency, utilization"',
      'title="Performance Overview"',
      'title="Performance data could not be loaded"',
      'label="Avg Availability"',
      'label="Latency p95"',
      'label="CPU Avg"',
      'label="Memory Avg"',
      'label="Avg Utilization"',
      'label="Packet Loss"',
      'Updated{" "}',
      '{ label: "on target", token: "success" }',
      ': "watch"',
      ': "below target"',
      "Availability across managed devices · ",
      '`Availability across managed devices',
      'description="Fleet average CPU"',
      'description="Fleet average memory"',
      'description="Interface in + out average"',
      'description="Fleet-wide packet loss"',
      'title="Availability"',
      "Share of managed devices reachable — ",
      "`Availability trend, averaged ",
      "`Area chart of ",
      ', "Availability"]',
      'title="Latency p95"',
      "`95th-percentile round-trip latency — ",
      "`Latency p95 trend, peaking at ",
      "`Line chart of ",
      ', "Latency p95"]',
      "`No data for the last ",
      "Raw samples are still being collected",
      "No rollups cover this window yet",
      'title="Top Utilizers"',
      "Interfaces with the highest average utilization",
      'title="No utilization data"',
      "No interface utilization rollups for this window yet.",
      'title="Metrics Retention"',
      "How long raw samples and rollups are kept",
      'label: "Raw samples"',
      "Collector-resolution MetricSample rows",
      '"5-minute rollups"',
      "Fine-grained aggregates",
      '"Hourly rollups"',
      "Powers 7-day dashboards",
      '"Daily rollups"',
      "Powers 30-day views and capacity forecasts",
      'title="Retention settings could not be loaded"',
      "{label} retention in days",
      '>days<',
      "retention ${value.enabled ? \"enabled\" : \"disabled\"}",
      '? "Active" : "Paused"',
      '": "Saving…" : "Save"',
      'Prune expired metrics now?',
      "Deletes raw samples and rollups older than their retention",
      "Last prune ran",
      "` — deleted ${",
      "Pruning has not run yet.",
      "<AlertDialogCancel>Cancel</AlertDialogCancel>",
      '? "Pruning…" : "Prune now"',
    ]) {
      expect(src.includes(gone), `must be gone: ${gone}`).toBe(false);
    }
  });

  test("D: the keyed signatures are IN (shared chrome takes a TranslateFn)", () => {
    const src = readRepo(`${VIEWS}/${VIEW}`);
    expect(src).toContain("export function perfRangeLabel(range: PerfRange, t: TranslateFn): string");
    expect(src).toContain("export function granularityLabel(granularity: string | undefined, t: TranslateFn): string");
    expect(src).toContain(
      "type TranslateFn = (key: string, values?: Record<string, string | number>) => string;"
    );
    expect(src).toContain('const t = useTranslations("perfOverview");');
  });
});

describe("R85 — keyed call sites exist for the full inventory", () => {
  test("D: view + chrome call sites", () => {
    const src = readRepo(`${VIEWS}/${VIEW}`);
    for (const key of [
      'aria-label={t("chips.ariaLabel")}',
      't("title")',
      't("description")',
      '{t("updated")}',
      't("error.title")',
      't("kpi.availability.label")',
      't("kpi.availability.description", {',
      "granularityLabel(meta.granularity, t)",
      't("granularity.fallback")',
      't("kpi.status.onTarget")',
      't("kpi.status.watch")',
      't("kpi.status.below")',
      't("kpi.latency.label")',
      't("kpi.latency.description")',
      't("kpi.cpu.label")',
      't("kpi.cpu.description")',
      't("kpi.memory.label")',
      't("kpi.memory.description")',
      't("kpi.utilization.label")',
      't("kpi.utilization.description")',
      't("kpi.packetLoss.label")',
      't("kpi.packetLoss.description")',
      't("availability.title")',
      't("availability.description", { range: rangeLabel })',
      't("availability.chartAria", { avg, range: rangeLabel })',
      't("availability.chartSummary", {',
      't("availability.tooltip")',
      't("latency.title")',
      't("latency.description", { range: rangeLabel })',
      't("latency.chartAria", { peak, range: rangeLabel })',
      't("latency.chartSummary", {',
      't("latency.tooltip")',
      'range === "1H" ? t("empty.raw") : t("empty.rollups")',
      't("empty.title", { range: perfRangeLabel(range, t) })',
      't("utilizers.title")',
      't("utilizers.description")',
      't("utilizers.emptyTitle")',
      't("utilizers.emptyDescription")',
    ]) {
      expect(src.includes(key), `must exist: ${key}`).toBe(true);
    }
  });

  test("D: retention panel call sites (dynamic tier keys + dialog)", () => {
    const src = readRepo(`${VIEWS}/${VIEW}`);
    for (const key of [
      't("retention.title")',
      't("retention.description")',
      "t(`retention.tier.${key}.label`)",
      "t(`retention.tier.${key}.hint`)",
      't("retention.reset")',
      't("retention.saving")',
      't("retention.save")',
      't("retention.pruneNow")',
      't("retention.pruning")',
      't("retention.error.title")',
      't("retention.daysAria", { tier: tierLabel })',
      't("retention.daysUnit")',
      't("retention.switchAria", {',
      't("retention.state.enabled")',
      't("retention.state.disabled")',
      't("retention.active")',
      't("retention.paused")',
      't("retention.pruneTitle")',
      't("retention.pruneDescription")',
      't("retention.lastRan")',
      't("retention.lastRunStats", {',
      't("retention.neverRan")',
      't("retention.cancel")',
      'const TIER_KEYS: RetentionTierKey[] = ["raw", "rollup5M", "rollup1H", "rollup1D"];',
    ]) {
      expect(src.includes(key), `must exist: ${key}`).toBe(true);
    }
  });
});

describe("R85 — ledger governance", () => {
  test("E: the r56 ledger no longer lists perf-overview-view", () => {
    const sweep = readRepo("tests/audit/r56-i18n-chrome-sweep.test.ts");
    expect(/"perf-overview-view\.tsx":\s*\d/.test(sweep)).toBe(false);
  });

  test("E: the numeric ledger carries EXACTLY 0 entries at current HEAD (R102 removed backups)", () => {
    const sweep = readRepo("tests/audit/r56-i18n-chrome-sweep.test.ts");
    const block = sweep.slice(sweep.indexOf("const PENDING_VIEWS"));
    const entries = Array.from(block.matchAll(/"([a-z-]+-view\.tsx)":\s*(\d+)/g));
      expect(entries.length).toBe(0);
  });

  test("E: the LIVE candidate sum over ledgered files is EXACTLY 0 at current HEAD (R102 removed backups)", () => {
    const sweep = readRepo("tests/audit/r56-i18n-chrome-sweep.test.ts");
    const block = sweep.slice(sweep.indexOf("const PENDING_VIEWS"));
    const entries = Array.from(block.matchAll(/"([a-z-]+-view\.tsx)":\s*(\d+)/g));
    let sum = 0;
    for (const [, file] of entries) {
      sum += candidates(readRepo(`${VIEWS}/${file}`)).length;
    }
    expect(sum).toBe(0);
  });
});

describe("R85 — interpolation shape in BOTH locales", () => {
  test("F: EN placeholders match the values the view passes", () => {
    const en = readJson("messages/en.json") as Record<string, any>;
    const po = en.perfOverview as Messages;
    const gran = po.granularity as Messages;
    const kpi = po.kpi as Messages;
    const kpiAvail = kpi.availability as Messages;
    const avail = po.availability as Messages;
    const lat = po.latency as Messages;
    const empty = po.empty as Messages;
    const retention = po.retention as Messages;
    expect(gran.buckets as string).toContain("{unit}");
    expect(kpiAvail.description as string).toContain("{granularity}");
    expect(avail.description as string).toContain("{range}");
    expect(avail.chartAria as string).toContain("{avg}");
    expect(avail.chartAria as string).toContain("{range}");
    expect(avail.chartSummary as string).toContain("{count}");
    expect(avail.chartSummary as string).toContain("{lowest}");
    expect(avail.chartSummary as string).toContain("{highest}");
    expect(lat.description as string).toContain("{range}");
    expect(lat.chartAria as string).toContain("{peak}");
    expect(lat.chartAria as string).toContain("{range}");
    expect(lat.chartSummary as string).toContain("{count}");
    expect(lat.chartSummary as string).toContain("{highest}");
    expect(empty.title as string).toContain("{range}");
    expect(retention.daysAria as string).toContain("{tier}");
    expect(retention.switchAria as string).toContain("{tier}");
    expect(retention.switchAria as string).toContain("{state}");
    expect(retention.lastRunStats as string).toContain("{samples}");
    expect(retention.lastRunStats as string).toContain("{m5}");
    expect(retention.lastRunStats as string).toContain("{h1}");
    expect(retention.lastRunStats as string).toContain("{d1}");
    expect(retention.lastRunStats as string).toContain("{seconds}");
  });

  test("F: AR carries the SAME placeholder shapes", () => {
    const ar = readJson("messages/ar.json") as Record<string, any>;
    const po = ar.perfOverview as Messages;
    const gran = po.granularity as Messages;
    const kpi = po.kpi as Messages;
    const kpiAvail = kpi.availability as Messages;
    const avail = po.availability as Messages;
    const lat = po.latency as Messages;
    const empty = po.empty as Messages;
    const retention = po.retention as Messages;
    expect(gran.buckets as string).toContain("{unit}");
    expect(kpiAvail.description as string).toContain("{granularity}");
    expect(avail.description as string).toContain("{range}");
    expect(avail.chartAria as string).toContain("{avg}");
    expect(avail.chartAria as string).toContain("{range}");
    expect(avail.chartSummary as string).toContain("{count}");
    expect(avail.chartSummary as string).toContain("{lowest}");
    expect(avail.chartSummary as string).toContain("{highest}");
    expect(lat.description as string).toContain("{range}");
    expect(lat.chartAria as string).toContain("{peak}");
    expect(lat.chartAria as string).toContain("{range}");
    expect(lat.chartSummary as string).toContain("{count}");
    expect(lat.chartSummary as string).toContain("{highest}");
    expect(empty.title as string).toContain("{range}");
    expect(retention.daysAria as string).toContain("{tier}");
    expect(retention.switchAria as string).toContain("{tier}");
    expect(retention.switchAria as string).toContain("{state}");
    expect(retention.lastRunStats as string).toContain("{samples}");
    expect(retention.lastRunStats as string).toContain("{m5}");
    expect(retention.lastRunStats as string).toContain("{h1}");
    expect(retention.lastRunStats as string).toContain("{d1}");
    expect(retention.lastRunStats as string).toContain("{seconds}");
    // The {range} values themselves are genuine Arabic (the R82–R84
    // documented survivor — an English range label inside the Arabic
    // sentence — is resolved by this tranche).
    const range = po.range as Messages;
    expect(range["24H"] as string).toBe("آخر 24 ساعة");
    expect(range["30D"] as string).toBe("آخر 30 يومًا");
  });
});

describe("R85 — documented technical survivors", () => {
  test("G: PERF_RANGES chip tokens stay locale-neutral (v{version} precedent)", () => {
    const src = readRepo(`${VIEWS}/${VIEW}`);
    expect(src).toContain('{ value: "1H", label: "1H" }');
    expect(src).toContain('{ value: "24H", label: "24H" }');
    expect(src).toContain('{ value: "7D", label: "7D" }');
    expect(src).toContain('{ value: "30D", label: "30D" }');
  });

  test("G: fmtPct/fmtMs units + em-dash placeholders survive", () => {
    const src = readRepo(`${VIEWS}/${VIEW}`);
    expect(src).toContain('return "—";');
    expect(src).toContain('return `${Math.round(value)} ms`;');
  });

  test("G: date-fns formats + relative time stay English (no ar locale wired)", () => {
    const src = readRepo(`${VIEWS}/${VIEW}`);
    expect(src).toContain('import { format, formatDistanceToNow } from "date-fns";');
    expect(src).toContain('format(date, "MMM d")');
    expect(src).toContain('format(date, "HH:mm")');
    expect(src).toContain('format(new Date(ts), "EEE, MMM d — HH:mm")');
    expect(src).toContain("addSuffix: true");
    expect(src).not.toMatch(/from "date-fns\/locale/);
  });

  test("G: chart internals stay locale-neutral (ticks, dataKeys, gradient id)", () => {
    const src = readRepo(`${VIEWS}/${VIEW}`);
    expect(src).toContain("`${value}%`");
    expect(src).toContain("`${value} ms`");
    expect(src).toContain('id="perfAvailFill"');
    expect(src).toContain('dataKey="availabilityPct"');
    expect(src).toContain('dataKey="latencyP95"');
  });

  test("G: code-side em-dash defensive fallbacks survive (chart stats + Updated stamp)", () => {
    const src = readRepo(`${VIEWS}/${VIEW}`);
    expect(src).toContain(': "—";');
    expect(src).toContain('? format(overview.dataUpdatedAt, "HH:mm:ss")');
  });
});
