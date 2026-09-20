import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * HC-4 (R56) — i18n completion of chrome copy (devices plane) + the
 * brand/i18n audit extension the roadmap scheduled:
 *
 *   1. DICTIONARY PARITY PIN — messages/en.json and messages/ar.json must
 *      carry the SAME leaf-key set (deep, both directions) with non-empty
 *      string values. This is the first machine-enforced parity check;
 *      until now "1285 = 1285" was only stated in prose.
 *   2. THE DOCUMENTED TRIAGE IS CLOSED — devices-view.tsx and
 *      device-detail-view.tsx (the two views deliberately left with
 *      English literals in the earlier i18n sweep) are now keyed through
 *      the NEW `devices` / `deviceDetail` namespaces. The sweep below
 *      pins them at ZERO user-visible literal candidates, except the
 *      documented `LIVE` technical chip (a governed data-plane token,
 *      rendered identically in both locales).
 *   3. PENDING-VIEWS DEBT LEDGER — the rest of the views still carry
 *      chrome literals (partial i18n coverage is a documented program
 *      state: 18 views keyed, the rest pending future passes). Each
 *      pending file is pinned at a CEILING equal to its candidate count
 *      at R56: the number can only go DOWN. When a view is keyed, drop
 *      it from the ledger; when the ledger is empty, flip the sweep to
 *      forbid all candidates everywhere.
 *
 * R80 (tranche 1, 2026-09-19): SIX views keyed by hand against their
 * full inventories (including non-swept literals such as lowercase and
 * template-literal copy): placeholder, ztp, changes-templates, noc,
 * changes-calendar, sites → ledger 32 → 26 entries (824 → 791
 * candidates). ztp-view's three remaining candidates are TECHNICAL
 * example placeholders (FAB-2026-0117 / BR2-ACC-SW-09 / C9200L-48P-4X),
 * locale-neutral tokens governed by KEYED_SURVIVORS below — the same
 * exact-match precedent as devices-view's LIVE chip.
 *
 * R81 (tranche 2, 2026-09-19): THREE views keyed by hand —
 * admin-drivers (new `drivers` namespace), perf-capacity (chrome added
 * to the EXISTING `capacity` namespace: KPI/status/chip/metric/legend
 * copy incl. the module-level metricLabel helper and template
 * aria-labels) and admin-system (new `systemSettings` namespace incl.
 * the colon-syntax GROUPS block and the unsaved-changes ICU plural) →
 * ledger 26 → 23 entries. Documented survivors:
 * capacity's ConfidenceBadge renders the API's HIGH/MEDIUM/LOW token
 * as-is (data-plane, LIVE-chip precedent); admin-system's setting.label
 * rows are Setting-table DB content (like hostnames); admin-drivers'
 * registry manifests (vendorLabel/cap.label/configFlavor/notes) are
 * data-plane (VENDOR_LABELS precedent).
 *
 * R82 (tranche 3, 2026-09-20): perf-interfaces keyed by hand (new
 * `perfInterfaces` namespace, 30 leaves) — full inventory cleaned incl.
 * non-swept literals: the SORT_CHIPS module-level labels (resolved via
 * t(`sort.${labelKey}`) at render), the PageHeader/table template
 * literals ({range} via the shared perfRangeLabel helper), the SectionCard
 * conditional title (cardTitle / cardTitleCounted), the pagination
 * summary template and the UtilBar sr-only ternary suffixes
 * (sr.utilization + sr.critical/sr.high) → ledger 23 → 22 entries
 * (748 → 730 candidates). CORRECTION: R81's prose quoted 749; the exact
 * ledger sum at R81 HEAD was 748 (re-derived live — ceilings and live
 * counts agree on every entry). Documented cross-view survivor: the
 * shared perf chrome (PerfRangeChips + perfRangeLabel, exported from
 * perf-overview-view.tsx) stays English until the perf-overview tranche
 * keys it; its file remains ledgered. fmtSpeed units (Gb/s / Mb/s) and
 * "—" placeholders are locale-neutral technical tokens.
 *
 * R83 (tranche 4, 2026-09-20): TWO views keyed by hand — perf-devices
 * (new `perfDevices` namespace, 36 leaves: METRIC_CHIPS module labels
 * resolved via t(`metric.${labelKey}`) at render, the {metric} + {range}
 * description/table-aria templates preserving the original
 * lowercase-in-prose EN shape, SectionCard conditional counted title,
 * the sparkline title template and the delta sr-only ternary suffixes)
 * and baselines (new `baselines` namespace, 37 leaves: row aria-label
 * templates, the drift-chip title/label pair, diff dialog title with
 * v{from} → v{to}, and the revoke dialog description split AROUND the
 * styled v{version} token so the font-tech span survives) → ledger
 * 22 → 20 entries (730 → 690 candidates). Documented survivors:
 * date-fns formatDistanceToNow relative time stays English (no date-fns
 * ar locale is wired anywhere in the app — same precedent as the keyed
 * device-config-tab), data-plane titles (hostname/sha256/note),
 * fmtMetric's "—" placeholder, and the technical v{version} tokens.
 *
 * R84 (tranche 5, 2026-09-20): TWO views keyed by hand — incidents
 * (new `incidents` namespace, 38 leaves: STATUS_GROUPS module labels
 * resolved via t(`group.${key}`) at render — the R82 SORT_CHIPS /
 * admin-system GROUPS dynamic-key precedent, five KPI labels + the
 * keyed KPI "live" status chip + the {count}/{samples}/{days}
 * KPI description templates, severity/site/sort toolbars, the
 * SectionCard conditional counted title, the row.counts ICU plural
 * (en one/other; ar zero/one/two/few/many/other) for the
 * "{devices} dev · {alerts} alert{s}" strip and the pagination summary)
 * and perf-availability (new `perfAvailability` namespace, 28 leaves:
 * the {range} description via the shared perfRangeLabel survivor, the
 * OverallCard target chip + progress aria + meets/below ternary pair,
 * and both table scopes — site 5 cols / device 4 cols — with the
 * " — open device detail" sr-only) → ledger 20 → 18 entries (690 →
 * 646 candidates). Documented survivors: date-fns formatDistanceToNow
 * (incidents rows — no ar locale wired), the openBySeverity KPI
 * description (static config SEV tokens split from " — ", data-plane
 * ConfidenceBadge precedent), fmtMinutes/fmtDowntime unit tokens
 * ("min"/"h"/"d") and "—" placeholders (NOC "MTTA {m}m" precedent),
 * the numeric chip count separators, and the shared perf chrome import
 * from perf-overview-view.tsx (English until the perf-overview tranche).
 *
 * R85 (tranche 6a, 2026-09-20): perf-overview keyed by hand (new
 * `perfOverview` namespace, 76 leaves) — AND the shared perf chrome is
 * now keyed, resolving the cross-view survivor documented by R82/R83/R84:
 * PerfRangeChips' "Time range" aria-label resolves through the
 * namespace, and perfRangeLabel(range, t) / granularityLabel(g, t) take
 * a structural TranslateFn (R81 metricLabel precedent), so the already
 * keyed perf views (perf-interfaces / perf-devices / perf-availability)
 * now render their {range} placeholders in the active locale — the
 * previously documented "English range label inside the Arabic
 * sentence" state is gone. Ledger 18 → 17 entries (646 → 619
 * candidates). Documented survivors: PERF_RANGES chip tokens
 * (1H/24H/7D/30D — locale-neutral range tokens, v{version} precedent),
 * fmtPct/fmtMs units + em-dash placeholders, date-fns tick/label
 * formats and formatDistanceToNow (no ar locale wired anywhere),
 * data-plane hostnames/siteCodes, chart dataKey/name props and gradient
 * ids, and the defensive code-side em-dash fallbacks.
 *
 * Detection regexes (documented, deliberately shallow):
 *   - PROP_RE  : literal string props  title=/placeholder=/aria-label=/
 *                label=/description=/heading= starting with a capital.
 *   - JSX_RE   : JSX text nodes `>Text<` starting with a capital.
 * Known limitations (accepted): dynamic ternary strings, template
 * literals and lowercase openings are NOT matched by the shallow sweep —
 * the two named views were cleaned BY HAND against the full inventory
 * (including ternaries such as exit/enter maintenance and the
 * `Sort by ${label}` template), the sweep is the regression net.
 */

const REPO = join(import.meta.dir, "..", "..");
const VIEWS = "src/components/views";

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

/**
 * Keyed views whose remaining candidates are DOCUMENTED technical tokens
 * (exact-match governance, same precedent as devices-view's LIVE chip):
 * file → the exact allowed candidate list. Any addition or change to
 * these views' literals fails the sweep.
 */
const KEYED_SURVIVORS: Record<string, string[]> = {
  "ztp-view.tsx": ["FAB-2026-0117", "BR2-ACC-SW-09", "C9200L-48P-4X"],
};

/**
 * Pending-views debt ledger (R56 baseline; R80 tranche 1 + R81 tranche 2
 * + R82 tranche 3 + R83 tranche 4 + R84 tranche 5 + R85 tranche 6a shrank it). Format: file → candidate ceiling (the count
 * at R56; may only DECREASE). A view leaves the ledger the day it is
 * keyed; when the ledger is empty the sweep flips to forbid candidates in
 * every view. Counts use the documented shallow regexes above —
 * regenerate with the same extractors when editing.
 */
const PENDING_VIEWS: Record<string, number> = {
  "admin-api-clients-view.tsx": 27,
  "admin-collectors-view.tsx": 19,
  "admin-credentials-view.tsx": 26,
  "admin-integrations-view.tsx": 47,
  "admin-users-view.tsx": 51,
  "alerts-view.tsx": 36,
  "backup-compliance-view.tsx": 30,
  "backups-view.tsx": 61,
  "change-approvals-view.tsx": 33,
  "change-detail-view.tsx": 52,
  "changes-view.tsx": 27,
  "discovery-view.tsx": 43,
  "drift-view.tsx": 30,
  "events-view.tsx": 27,
  "incident-detail-view.tsx": 43,
  "maintenance-view.tsx": 38,
  "snapshots-view.tsx": 29,
};

describe("HC-4 — dictionary parity is machine-enforced", () => {
  test("en and ar leaf-key sets are identical in BOTH directions", () => {
    const en = leaves(readJson("messages/en.json"));
    const ar = leaves(readJson("messages/ar.json"));
    const enSet = new Set(en);
    const arSet = new Set(ar);
    const onlyEn = en.filter((k) => !arSet.has(k));
    const onlyAr = ar.filter((k) => !enSet.has(k));
    expect(onlyEn).toEqual([]);
    expect(onlyAr).toEqual([]);
    expect(en.length).toBe(ar.length);
  });

  test("every leaf value is a non-empty string in both dictionaries", () => {
    for (const file of ["messages/en.json", "messages/ar.json"]) {
      const json = readJson(file);
      const walk = (node: unknown, path: string) => {
        if (node !== null && typeof node === "object") {
          for (const [k, v] of Object.entries(node as Messages)) walk(v, `${path}.${k}`);
          return;
        }
        expect(typeof node === "string" && node.length > 0, `${file}:${path}`).toBe(true);
      };
      walk(json, file);
    }
  });

  test("the new devices/deviceDetail namespaces exist and are balanced", () => {
    const en = readJson("messages/en.json") as Record<string, Messages>;
    const ar = readJson("messages/ar.json") as Record<string, Messages>;
    for (const ns of ["devices", "deviceDetail"]) {
      expect(en[ns], `en.${ns}`).toBeDefined();
      expect(ar[ns], `ar.${ns}`).toBeDefined();
      const enLeaves = leaves(en[ns]).length;
      const arLeaves = leaves(ar[ns]).length;
      expect(enLeaves).toBe(arLeaves);
      expect(enLeaves).toBeGreaterThan(40);
    }
  });
});

describe("HC-4 — the documented triage is closed: the devices plane is keyed", () => {
  test("both views consume their namespaces", () => {
    expect(readRepo(`${VIEWS}/devices-view.tsx`)).toContain('useTranslations("devices")');
    expect(readRepo(`${VIEWS}/device-detail-view.tsx`)).toContain('useTranslations("deviceDetail")');
  });

  test("devices-view has ZERO literal candidates beyond the LIVE technical chip", () => {
    const found = candidates(readRepo(`${VIEWS}/devices-view.tsx`));
    // The single allowed survivor: the governed data-plane token.
    expect(found).toEqual(["LIVE"]);
  });

  test("device-detail-view has ZERO literal candidates", () => {
    const found = candidates(readRepo(`${VIEWS}/device-detail-view.tsx`));
    expect(found).toEqual([]);
  });
});

describe("HC-4 — pending-views debt ledger (ceilings may only shrink)", () => {
  test("keyed views carry EXACTLY their documented technical survivors", () => {
    for (const [file, survivors] of Object.entries(KEYED_SURVIVORS)) {
      const found = candidates(readRepo(`${VIEWS}/${file}`));
      expect(found, `${file}: candidates drifted from the documented survivors`).toEqual(
        survivors
      );
    }
  });

  test("every view with candidates is either clean, keyed, the LIVE chip, or ledgered", () => {
    const files = readdirSync(join(REPO, VIEWS)).filter((f) => f.endsWith(".tsx"));
    for (const file of files) {
      if (file === "devices-view.tsx" || file === "device-detail-view.tsx") continue;
      if (KEYED_SURVIVORS[file]) continue;
      const count = candidates(readRepo(`${VIEWS}/${file}`)).length;
      if (count === 0) continue;
      const ceiling = PENDING_VIEWS[file];
      expect(ceiling, `${file} carries ${count} literals but is not in the ledger`).toBeDefined();
    }
  });

  test("no ledgered view may GROW its literal count", () => {
    for (const [file, ceiling] of Object.entries(PENDING_VIEWS)) {
      const count = candidates(readRepo(`${VIEWS}/${file}`)).length;
      expect(count, `${file}: ${count} candidates > ceiling ${ceiling}`).toBeLessThanOrEqual(ceiling);
    }
  });
});
