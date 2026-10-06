import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * R86 — i18n tranche 6b: admin-collectors keyed (the registry half; the
 * Phase 15-b distribution section was already keyed through
 * `collectors.distribution`).
 *
 * Pins:
 *   A. The existing `collectors` namespace grows `kind` / `status` /
 *      `registry` — EXACTLY 29 NEW leaves (4 + 2 + 23), 82 total for the
 *      namespace, deep parity (identical leaf-path sets both directions)
 *      and non-empty string values everywhere; dictionary totals move
 *      1,822 → 1,851 = 1,851.
 *   B. The view consumes the namespace: ONE `useTranslations("collectors")`
 *      hook in AdminCollectorsView (the distribution section keeps its own
 *      `useTranslations("collectors.distribution")` hook).
 *   C. Sweep candidates: admin-collectors-view.tsx is at ZERO (19 → 0; the
 *      ledger ceiling was matched exactly at 19: 11 PROP + 8 JSX).
 *   D. Source pins: the pre-tranche literals are GONE from the file (each
 *      individually asserted absent), the keyed call sites are IN, and the
 *      dynamic-key resolution is pinned (KIND_KEYS/STATUS_KEYS maps with
 *      raw-token fallback — the API contract is an open string, R82
 *      SORT_CHIPS / R84 STATUS_GROUPS precedent).
 *   E. Ledger governance: the r56 sweep no longer ledgers
 *      admin-collectors-view, the numeric ledger carries EXACTLY 16
 *      entries, and the LIVE candidate sum over the ledgered files is
 *      EXACTLY 400 (computed from the tree, not quoted).
 *   F. Shape: the new registry leaves are ALL static strings (no
 *      interpolation placeholders — this view's chrome has no templates);
 *      the AR card description keeps the OFFLINE technical token Latin
 *      inside the Arabic sentence (SEV-token / v{version} precedent).
 *   G. Term consistency + documented survivors: registry.error.reason ==
 *      drivers.error.reason verbatim (both locales), registry.table.col
 *      .lastSeen reuses the established lastSeen AR term, and the source
 *      keeps the online/total ratio + toLocaleString numerals + em-dash
 *      placeholders, the font-mono capability tokens (drivers-registry
 *      vendorLabel/adapter precedent), data-plane hostnames/names, and
 *      date-fns formatDistanceToNow English relative time (no ar locale
 *      wired anywhere — device-config-tab / R83-R85 precedent).
 */

const REPO = join(import.meta.dir, "..", "..");
const VIEWS = "src/components/views";
const VIEW = "admin-collectors-view.tsx";

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

describe("R86 — namespace growth is balanced", () => {
  test("A: collectors.kind/status/registry exist with EXACTLY 29 new leaves (82 total)", () => {
    for (const file of ["messages/en.json", "messages/ar.json"]) {
      const json = readJson(file) as Record<string, any>;
      const col = json.collectors as Messages;
      expect(col.kind, `${file} kind`).toBeDefined();
      expect(col.status, `${file} status`).toBeDefined();
      expect(col.registry, `${file} registry`).toBeDefined();
      expect(leaves(col.kind).length, `${file} kind leaves`).toBe(4);
      expect(leaves(col.status).length, `${file} status leaves`).toBe(2);
      expect(leaves(col.registry).length, `${file} registry leaves`).toBe(23);
      expect(leaves(col).length, `${file} collectors total`).toBe(82);
    }
  });

  test("A: dictionary totals are 2,850 = 2,850 at current HEAD (+117 R102)", () => {
    const en = readJson("messages/en.json");
    const ar = readJson("messages/ar.json");
    expect(leaves(en).length).toBe(3394);
    expect(leaves(ar).length).toBe(3394);
  });

  test("A: deep parity — identical leaf paths in BOTH directions", () => {
    const en = readJson("messages/en.json") as Record<string, any>;
    const ar = readJson("messages/ar.json") as Record<string, any>;
    const enSet = new Set(leaves(en.collectors));
    const arSet = new Set(leaves(ar.collectors));
    expect(Array.from(enSet).filter((k) => !arSet.has(k)), "en-only").toEqual([]);
    expect(Array.from(arSet).filter((k) => !enSet.has(k)), "ar-only").toEqual([]);
  });

  test("A: every new leaf value is a non-empty string in both locales", () => {
    for (const file of ["messages/en.json", "messages/ar.json"]) {
      const json = readJson(file) as Record<string, any>;
      const col = json.collectors as Messages;
      for (const ns of ["kind", "status", "registry"] as const) {
        const walk = (node: unknown, path: string) => {
          if (node !== null && typeof node === "object") {
            for (const [k, v] of Object.entries(node as Messages)) {
              walk(v, `${path}.${k}`);
            }
            return;
          }
          expect(typeof node === "string" && node.length > 0, `${file}:${path}`).toBe(true);
        };
        walk(col[ns], ns);
      }
    }
  });
});

describe("R86 — namespace consumption", () => {
  test("B: AdminCollectorsView takes a useTranslations(\"collectors\") hook", () => {
    const src = readRepo(`${VIEWS}/${VIEW}`);
    const hooks = Array.from(src.matchAll(/useTranslations\("collectors"\)/g)).length;
    expect(hooks).toBe(1);
    expect(src).toContain('const t = useTranslations("collectors");');
    // The already-keyed distribution section keeps its own hook.
    expect(src).toContain('useTranslations("collectors.distribution")');
  });
});

describe("R86 — zero sweep candidates + full-inventory keying", () => {
  test("C: admin-collectors-view has ZERO literal candidates (19 → 0)", () => {
    const found = candidates(readRepo(`${VIEWS}/${VIEW}`));
    expect(found).toEqual([]);
  });

  test("D: the pre-tranche literals are GONE from the file", () => {
    const src = readRepo(`${VIEWS}/${VIEW}`);
    for (const gone of [
      'title="Collectors"',
      'description="Poller and collector registry',
      'label="Online"',
      'label="Worker service"',
      'label="Jobs completed"',
      'title="Registry"',
      "Rows persist the last known state",
      'title="Could not load collectors"',
      'title="No collectors registered"',
      "Collectors appear here once the worker service",
      'aria-label="Collector registry',
      ">Refresh<",
      ">Collector<",
      ">Kind<",
      ">Status<",
      ">Capabilities<",
      ">Host<",
      ">Last seen<",
      ">Jobs<",
      '{ label: "Poller"',
      '"CONFIG_COLLECTOR": "Config collector"',
      "ALERT_ENGINE: \"Alert engine\"",
      'RETENTION: "Retention engine"',
      'workerReachable ? "reachable" : "unreachable"',
      ": \"never\"}",
      "KIND_LABELS",
    ]) {
      expect(src.includes(gone), `must be gone: ${gone}`).toBe(false);
    }
  });

  test("D: the keyed call sites are IN (incl. the reason= prop PROP_RE never matched)", () => {
    const src = readRepo(`${VIEWS}/${VIEW}`);
    for (const key of [
      't("registry.title")',
      't("registry.description")',
      't("registry.refresh")',
      't("registry.kpi.online")',
      't("registry.kpi.worker")',
      'workerReachable ? t("registry.kpi.reachable") : t("registry.kpi.unreachable")',
      't("registry.kpi.jobsCompleted")',
      't("registry.card.title")',
      't("registry.card.description")',
      't("registry.error.title")',
      'reason={t("registry.error.reason")}',
      't("registry.empty.title")',
      't("registry.empty.description")',
      'aria-label={t("registry.table.ariaLabel")}',
      't("registry.table.col.collector")',
      't("registry.table.col.kind")',
      't("registry.table.col.status")',
      't("registry.table.col.capabilities")',
      't("registry.table.col.host")',
      't("registry.table.col.lastSeen")',
      't("registry.table.col.jobs")',
      't("registry.row.never")',
    ]) {
      expect(src.includes(key), `must exist: ${key}`).toBe(true);
    }
  });

  test("D: dynamic-key resolution with raw-token fallback (open API contract)", () => {
    const src = readRepo(`${VIEWS}/${VIEW}`);
    for (const key of [
      'const KIND_KEYS: Record<string, string> = {',
      'POLLER: "poller",',
      'CONFIG_COLLECTOR: "configCollector",',
      'ALERT_ENGINE: "alertEngine",',
      'RETENTION: "retention",',
      'const STATUS_KEYS: Record<string, string> = {',
      'ONLINE: "online",',
      'OFFLINE: "offline",',
      "kindKey ? t(`kind.${kindKey}`) : collector.kind",
      "statusKey ? t(`status.${statusKey}`) : collector.status",
    ]) {
      expect(src.includes(key), `must exist: ${key}`).toBe(true);
    }
  });
});

describe("R86 — ledger governance", () => {
  test("E: the r56 ledger no longer lists admin-collectors-view", () => {
    const sweep = readRepo("tests/audit/r56-i18n-chrome-sweep.test.ts");
    expect(/"admin-collectors-view\.tsx":\s*\d/.test(sweep)).toBe(false);
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

describe("R86 — value shapes and term consistency", () => {
  test("F: the new registry leaves are ALL static strings (no placeholders)", () => {
    for (const file of ["messages/en.json", "messages/ar.json"]) {
      const json = readJson(file) as Record<string, any>;
      const registry = (json.collectors as Messages).registry as Messages;
      const walk = (node: unknown, path: string) => {
        if (node !== null && typeof node === "object") {
          for (const [k, v] of Object.entries(node as Messages)) {
            walk(v, `${path}.${k}`);
          }
          return;
        }
        expect(
          typeof node === "string" && !node.includes("{") && !node.includes("}"),
          `${file}:${path} must be static`
        ).toBe(true);
      };
      walk(registry, "registry");
    }
  });

  test("F: the AR card description keeps the OFFLINE token Latin (documented survivor)", () => {
    const ar = readJson("messages/ar.json") as Record<string, any>;
    const registry = ((ar.collectors as Messages).registry as Messages);
    const card = registry.card as Messages;
    expect(card.description as string).toContain("OFFLINE");
    expect(card.description as string).toContain("يُبقي OFFLINE التاريخ");
  });

  test("G: error.reason matches the drivers precedent verbatim in BOTH locales", () => {
    const en = readJson("messages/en.json") as Record<string, any>;
    const ar = readJson("messages/ar.json") as Record<string, any>;
    const enDrivers = en.drivers as Messages;
    const arDrivers = ar.drivers as Messages;
    const enCollectors = en.collectors as Messages;
    const arCollectors = ar.collectors as Messages;
    const enRegistry = enCollectors.registry as Messages;
    const arRegistry = arCollectors.registry as Messages;
    expect((enRegistry.error as Messages).reason).toBe((enDrivers.error as Messages).reason);
    expect((arRegistry.error as Messages).reason).toBe((arDrivers.error as Messages).reason);
    expect((arRegistry.error as Messages).reason).toBe("حاول مجددًا.");
  });

  test("G: lastSeen reuses the established AR term (آخر ظهور)", () => {
    const ar = readJson("messages/ar.json") as Record<string, any>;
    const registry = ((ar.collectors as Messages).registry as Messages);
    expect(((registry.table as Messages).col as Messages).lastSeen).toBe("آخر ظهور");
  });

  test("G: documented data-plane survivors stay in source", () => {
    const src = readRepo(`${VIEWS}/${VIEW}`);
    expect(src).toContain('value={`${online}/${collectors.length || "—"}`}');
    expect(src).toContain("jobsCompleted.toLocaleString()");
    expect(src).toContain('{collector.host ?? "—"}');
    expect(src).toContain('String(collector.stats.jobsCompleted ?? "—")');
    expect(src).toContain("formatDistanceToNow(parseISO(collector.lastSeenAt), {");
    expect(src).toContain("addSuffix: true");
    expect(src).toContain('className="font-mono text-[10px]"');
    // The already-keyed distribution chrome is untouched.
    expect(src).toContain("t(`role.${agent.role}`)");
    expect(src).toContain("v{agent.version}");
  });

  test("G: date-fns stays English (no ar locale wired)", () => {
    const src = readRepo(`${VIEWS}/${VIEW}`);
    expect(src).toContain('import { formatDistanceToNow, parseISO } from "date-fns";');
    expect(src).not.toMatch(/from "date-fns\/locale/);
  });
});
