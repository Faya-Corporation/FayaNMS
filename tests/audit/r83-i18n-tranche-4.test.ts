import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * R83 — i18n tranche 4: perf-devices + baselines keyed (two views).
 *
 * Pins:
 *   A. The NEW `perfDevices` (36 leaves) and `baselines` (37 leaves)
 *      namespaces exist in BOTH dictionaries, deep parity (identical
 *      leaf-path sets both directions) and non-empty string values
 *      everywhere.
 *   B. The views consume their namespaces in every component scope
 *      (PerfDevicesView + DeviceRow; BaselinesView is a single scope —
 *      rows/dialogs are inline in its render, closing over t).
 *   C. Sweep candidates: both files are at ZERO (hand-cleaned against
 *      the full inventory — including non-swept literals the shallow
 *      regexes never matched: the METRIC_CHIPS module-level labels, the
 *      {metric}/{range} description and table-aria template literals,
 *      the SectionCard conditional counted title, the sparkline title,
 *      the delta sr-only ternary suffixes, the row aria-label templates,
 *      the "+N more" template and the "Unknown error" ErrorState
 *      reason fallback).
 *   D. Source pins: the pre-tranche literals are GONE from both files
 *      (each individually asserted absent).
 *   E. Ledger governance: the r56 sweep no longer ledgers the two
 *      files, the numeric ledger carries EXACTLY 20 entries, and the
 *      LIVE candidate sum over the ledgered files is EXACTLY 690
 *      (computed from the tree, not quoted).
 *   F. Interpolation shape: the dictionary values carry the placeholders
 *      the views pass ({metric}, {range}, {total}, {page}, {totalPages},
 *      {count}, {pct}-free sr suffixes, {hostname}, {by}, {version},
 *      {from}, {to}).
 *   G. Documented technical survivors (unchanged policy): date-fns
 *      formatDistanceToNow relative time stays English (no date-fns ar
 *      locale wired anywhere — device-config-tab precedent), data-plane
 *      titles (hostname/sha256/note/siteCode), fmtMetric's "—"
 *      placeholder, the technical v{version} font-tech spans, and the
 *      shared perf chrome import from perf-overview-view.tsx (keyed by
 *      the perf-overview tranche, R85 — the chrome now renders in the
 *      active locale via a perfOverview tRange hook).
 */

const REPO = join(import.meta.dir, "..", "..");
const VIEWS = "src/components/views";
const PERF_DEVICES = "perf-devices-view.tsx";
const BASELINES = "baselines-view.tsx";

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

describe("R83 — tranche 4 namespaces exist and are balanced", () => {
  test("A: perfDevices exists in both dictionaries with EXACTLY 36 leaves", () => {
    const en = readJson("messages/en.json") as Record<string, Messages>;
    const ar = readJson("messages/ar.json") as Record<string, Messages>;
    expect(en.perfDevices, "en.perfDevices").toBeDefined();
    expect(ar.perfDevices, "ar.perfDevices").toBeDefined();
    expect(leaves(en.perfDevices).length).toBe(36);
    expect(leaves(ar.perfDevices).length).toBe(36);
  });

  test("A: baselines exists in both dictionaries with EXACTLY 37 leaves", () => {
    const en = readJson("messages/en.json") as Record<string, Messages>;
    const ar = readJson("messages/ar.json") as Record<string, Messages>;
    expect(en.baselines, "en.baselines").toBeDefined();
    expect(ar.baselines, "ar.baselines").toBeDefined();
    expect(leaves(en.baselines).length).toBe(37);
    expect(leaves(ar.baselines).length).toBe(37);
  });

  test("A: deep parity — identical leaf paths in BOTH directions (both namespaces)", () => {
    const en = readJson("messages/en.json") as Record<string, Messages>;
    const ar = readJson("messages/ar.json") as Record<string, Messages>;
    for (const ns of ["perfDevices", "baselines"]) {
      const enSet = new Set(leaves(en[ns]));
      const arSet = new Set(leaves(ar[ns]));
      expect(Array.from(enSet).filter((k) => !arSet.has(k)), `en-only in ${ns}`).toEqual([]);
      expect(Array.from(arSet).filter((k) => !enSet.has(k)), `ar-only in ${ns}`).toEqual([]);
    }
  });

  test("A: every tranche-4 leaf value is a non-empty string in both locales", () => {
    for (const file of ["messages/en.json", "messages/ar.json"]) {
      const json = readJson(file) as Record<string, Messages>;
      for (const ns of ["perfDevices", "baselines"]) {
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
    const pd = en.perfDevices as Messages;
    expect(pd.description as string).toContain("{metric}");
    expect(pd.description as string).toContain("{range}");
    expect((pd.table as Messages).ariaLabel as string).toContain("{metric}");
    expect((pd.table as Messages).ariaLabel as string).toContain("{range}");
    expect((pd.table as Messages).cardTitleCounted as string).toContain("{total}");
    expect((pd.pagination as Messages).summary as string).toContain("{page}");
    expect((pd.pagination as Messages).summary as string).toContain("{totalPages}");
    expect((pd.pagination as Messages).summary as string).toContain("{total}");
    expect((pd.row as Messages).trendTitle as string).toContain("{count}");

    const bl = en.baselines as Messages;
    const row = bl.row as Messages;
    expect(row.openDeviceAria as string).toContain("{hostname}");
    expect(row.approvedBy as string).toContain("{by}");
    expect(row.driftTitle as string).toContain("{count}");
    expect(row.driftOpen as string).toContain("{count}");
    expect(row.diffAria as string).toContain("{hostname}");
    expect(row.vsRunningVersion as string).toContain("{version}");
    expect(row.revokeAria as string).toContain("{hostname}");
    const missing = bl.missing as Messages;
    expect(missing.title as string).toContain("{count}");
    expect(missing.more as string).toContain("{count}");
    const diff = bl.diff as Messages;
    expect(diff.title as string).toContain("{hostname}");
    expect(diff.title as string).toContain("{from}");
    expect(diff.title as string).toContain("{to}");
    const revoke = bl.revoke as Messages;
    expect(revoke.title as string).toContain("{hostname}");
  });
});

describe("R83 — perf-devices is keyed", () => {
  test("B: the view consumes the namespace in both component scopes", () => {
    const src = readRepo(`${VIEWS}/${PERF_DEVICES}`);
    const hits = src.match(/useTranslations\("perfDevices"\)/g) ?? [];
    expect(hits.length).toBe(2); // PerfDevicesView + DeviceRow
  });

  test("C: the view sweeps at ZERO candidates", () => {
    const found = candidates(readRepo(`${VIEWS}/${PERF_DEVICES}`));
    expect(found, "perf-devices still carries literals").toEqual([]);
  });

  test("D: the pre-tranche literals are gone from the file", () => {
    const src = readRepo(`${VIEWS}/${PERF_DEVICES}`);
    const gone: string[] = [
      'title="Device Performance"',
      "Per-device ${",
      'aria-label="Metric"',
      'label: "CPU"',
      'label: "Memory"',
      'label: "Latency"',
      'label: "Packet loss"',
      'label: "Utilization"',
      ">Search devices<",
      'placeholder="Search hostname',
      'aria-label="Site"',
      ">Any site<",
      ">Reset<",
      "Device performance could not be loaded</",
      "No devices match the current filters",
      ">No performance rows to show<",
      "Devices${listMeta",
      "Page {listMeta.page} of",
      ">Previous<",
      ">Next<",
      "open device detail</span>",
      "buckets · oldest to newest`",
      '" worsening"',
      '" improving"',
      '" flat"',
    ];
    for (const literal of gone) {
      expect(src.includes(literal), `literal still present: ${literal}`).toBe(false);
    }
  });

  test("D: keyed call sites exist for the full inventory", () => {
    const src = readRepo(`${VIEWS}/${PERF_DEVICES}`);
    for (const key of [
      't("title")',
      "t(`metric.${metricKey}`)",
      't("description", {',
      "t(`metric.${chip.labelKey}`)",
      't("metricGroupAria")',
      't("toolbar.searchSr")',
      't("toolbar.searchPlaceholder")',
      't("toolbar.siteAria")',
      't("toolbar.anySite")',
      't("toolbar.reset")',
      't("table.cardTitleCounted", { total: listMeta.total })',
      't("table.cardTitle")',
      't("error.title")',
      't("empty.title")',
      't("empty.description")',
      't("table.ariaLabel", {',
      't("table.col.device")',
      't("table.col.site")',
      't("table.col.status")',
      't("table.col.trend")',
      't("table.col.latest")',
      't("table.col.avg")',
      't("table.col.max")',
      't("table.col.p95")',
      't("table.col.delta")',
      't("pagination.summary", {',
      't("pagination.prev")',
      't("pagination.next")',
      't("row.openDevice")',
      't("row.trendTitle", { count: row.trend.length })',
      't("sr.worsening")',
      't("sr.improving")',
      't("sr.flat")',
    ]) {
      expect(src.includes(key), `missing keyed call site: ${key}`).toBe(true);
    }
  });
});

describe("R83 — baselines is keyed", () => {
  test("B: the view consumes the namespace in its single component scope", () => {
    const src = readRepo(`${VIEWS}/${BASELINES}`);
    const hits = src.match(/useTranslations\("baselines"\)/g) ?? [];
    expect(hits.length).toBe(1); // BaselinesView (rows + dialogs inline, closing over t)
  });

  test("C: the view sweeps at ZERO candidates", () => {
    const found = candidates(readRepo(`${VIEWS}/${BASELINES}`));
    expect(found, "baselines still carries literals").toEqual([]);
  });

  test("D: the pre-tranche literals are gone from the file", () => {
    const src = readRepo(`${VIEWS}/${BASELINES}`);
    const gone: string[] = [
      'title="Baselines"',
      "Approved golden configurations",
      'title="Approved baselines"',
      "The latest approval per device wins",
      "Baselines could not be loaded</",
      '"Unknown error"',
      ">No baselines approved yet<",
      "Open a device → Config tab",
      'aria-label="Approved baselines — device',
      "open drift record(s) — open the Drift view",
      "} open<",
      ">Clean<",
      "vs running (v${",
      '"vs running"}',
      "· by ${",
      "Revoke baseline of {revokeTarget?.hostname}?",
      "The approval row is deleted and{",
      "returns to Historical",
      "Secrets are masked.",
      "Any visible difference here",
      "Baseline vs running — {diffBaseline",
      ">Revoke<",
      ">Cancel<",
      ">Revoke baseline<",
      "Devices without a baseline — ${meta.devicesWithoutBaseline}",
      "These managed devices have no approved reference",
      "· open device</span>",
      "} more</li>",
      "`Open ${row.hostname} device detail`",
      "`Diff baseline vs running config for ${row.hostname}`",
      "`Revoke baseline for ${row.hostname}`",
    ];
    for (const literal of gone) {
      expect(src.includes(literal), `literal still present: ${literal}`).toBe(false);
    }
  });

  test("D: keyed call sites exist for the full inventory", () => {
    const src = readRepo(`${VIEWS}/${BASELINES}`);
    for (const key of [
      't("title")',
      't("description")',
      't("card.title")',
      't("card.description")',
      't("error.title")',
      't("error.unknown")',
      't("empty.title")',
      't("empty.description")',
      't("table.ariaLabel")',
      't("table.col.device")',
      't("table.col.site")',
      't("table.col.baseline")',
      't("table.col.approved")',
      't("table.col.note")',
      't("table.col.drift")',
      't("table.col.actions")',
      't("row.openDeviceAria", { hostname: row.hostname })',
      't("row.approvedBy", { by: row.approvedBy })',
      't("row.driftTitle", { count: row.openDriftCount })',
      't("row.driftOpen", { count: row.openDriftCount })',
      't("row.clean")',
      't("row.diffAria", { hostname: row.hostname })',
      't("row.vsRunningVersion", { version: row.current.version })',
      't("row.vsRunning")',
      't("row.revokeAria", { hostname: row.hostname })',
      't("row.revoke")',
      't("missing.title", { count: meta.devicesWithoutBaseline })',
      't("missing.description")',
      't("missing.openDevice")',
      't("missing.more", {',
      't("diff.title", {',
      't("diff.description")',
      't("revoke.title", {',
      't("revoke.descriptionStart")',
      't("revoke.descriptionEnd")',
      't("revoke.cancel")',
      't("revoke.confirm")',
    ]) {
      expect(src.includes(key), `missing keyed call site: ${key}`).toBe(true);
    }
  });
});

describe("R83 — ledger governance", () => {
  test("E: the r56 ledger no longer lists the two keyed views", () => {
    const sweep = readRepo("tests/audit/r56-i18n-chrome-sweep.test.ts");
    expect(/"perf-devices-view\.tsx":\s*\d/.test(sweep)).toBe(false);
    expect(/"baselines-view\.tsx":\s*\d/.test(sweep)).toBe(false);
  });

  test("E: the numeric ledger carries EXACTLY 10 entries at current HEAD (R92 removed drift)", () => {
    const sweep = readRepo("tests/audit/r56-i18n-chrome-sweep.test.ts");
    const block = sweep.slice(sweep.indexOf("const PENDING_VIEWS"));
    const entries = Array.from(block.matchAll(/"([a-z-]+-view\.tsx)":\s*(\d+)/g));
    expect(entries.length).toBe(10);
  });

  test("E: the LIVE candidate sum over ledgered files is EXACTLY 434 at current HEAD (R92 removed drift)", () => {
    const sweep = readRepo("tests/audit/r56-i18n-chrome-sweep.test.ts");
    const block = sweep.slice(sweep.indexOf("const PENDING_VIEWS"));
    const entries = Array.from(block.matchAll(/"([a-z-]+-view\.tsx)":\s*(\d+)/g));
    let sum = 0;
    for (const [, file] of entries) {
      sum += candidates(readRepo(`${VIEWS}/${file}`)).length;
    }
    expect(sum).toBe(434);
  });
});

describe("R83 — documented technical survivors", () => {
  test("G: date-fns relative time stays English (no ar locale wired — device-config-tab precedent)", () => {
    const src = readRepo(`${VIEWS}/${BASELINES}`);
    expect(src).toContain('import { formatDistanceToNow } from "date-fns";');
    expect(src).toContain("addSuffix: true");
    expect(src).not.toMatch(/from "date-fns\/locale/);
  });

  test("G: data-plane titles and technical tokens survive (hostname/sha256/note, v{version} spans)", () => {
    const src = readRepo(`${VIEWS}/${BASELINES}`);
    expect(src).toContain("title={row.sha256}");
    expect(src).toContain("title={row.note ?? undefined}");
    expect(src).toContain('v{revokeTarget?.version}</span>');
    expect(src).toContain("v{row.version}");
  });

  test("G: fmtMetric's em-dash placeholder survives; shared perf chrome import intact (keyed by R85)", () => {
    const src = readRepo(`${VIEWS}/${PERF_DEVICES}`);
    expect(src).toContain('return "—";');
    expect(src).toContain(
      'import { PerfRangeChips, fmtMs, fmtPct, perfRangeLabel } from "./perf-overview-view";'
    );
  });
});
