import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * R80 — i18n tranche 1: six views keyed (placeholder, ztp,
 * changes-templates, noc, changes-calendar, sites).
 *
 * Pins:
 *   A. The FIVE new namespaces (sites, noc, changesCalendar,
 *      changeTemplates, placeholder) exist in BOTH dictionaries and are
 *      leaf-balanced with non-empty values.
 *   B. New-namespace parity is deep (same leaf-path sets, both
 *      directions).
 *   C. All six views consume their namespaces (ztp-view already did).
 *   D. Sweep candidates: the five newly keyed views are at ZERO; ztp's
 *      remaining three are EXACTLY the documented technical example
 *      placeholders (locale-neutral tokens, KEYED_SURVIVORS governance
 *      in the r56 sweep).
 *   E. Ledger governance: the r56 sweep no longer ledgered the six
 *      files, and KEYED_SURVIVORS carries ztp-view (source-level pin).
 *
 * Documented technical survivors (unchanged, per R56 policy): the LIVE
 * chip, date-fns English relative times/month names (en-GB formatting
 * pinned as locale-neutral for technical surfaces), MTTA/MTTR/SLA/NOC
 * acronyms, and VENDOR_LABELS product names (Cisco IOS / IOS-XE,
 * Fortinet FortiOS, Sophos SFOS, HPE AOS-CX).
 */

const REPO = join(import.meta.dir, "..", "..");
const VIEWS = "src/components/views";

const NAMESPACES = [
  "sites",
  "noc",
  "changesCalendar",
  "changeTemplates",
  "placeholder",
] as const;

const VIEWS_AND_NS: Record<string, string> = {
  "placeholder-view.tsx": "placeholder",
  "ztp-view.tsx": "ztp",
  "changes-templates-view.tsx": "changeTemplates",
  "noc-view.tsx": "noc",
  "changes-calendar-view.tsx": "changesCalendar",
  "sites-view.tsx": "sites",
};

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

describe("R80 — tranche 1 namespaces exist and are balanced", () => {
  test("A: five new namespaces exist in both dictionaries with equal leaf counts", () => {
    const en = readJson("messages/en.json") as Record<string, Messages>;
    const ar = readJson("messages/ar.json") as Record<string, Messages>;
    for (const ns of NAMESPACES) {
      expect(en[ns], `en.${ns}`).toBeDefined();
      expect(ar[ns], `ar.${ns}`).toBeDefined();
      const enLeaves = leaves(en[ns]).length;
      const arLeaves = leaves(ar[ns]).length;
      expect(enLeaves, `en.${ns} leaves`).toBe(arLeaves);
      expect(enLeaves, `en.${ns} must be non-trivial`).toBeGreaterThan(0);
    }
    expect(enLeavesSum(en)).toBeGreaterThan(1450);
  });

  test("B: new-namespace parity is deep — identical leaf paths both directions", () => {
    const en = readJson("messages/en.json") as Record<string, Messages>;
    const ar = readJson("messages/ar.json") as Record<string, Messages>;
    for (const ns of NAMESPACES) {
      const enSet = new Set(leaves(en[ns]));
      const arSet = new Set(leaves(ar[ns]));
      const onlyEn = Array.from(enSet).filter((k) => !arSet.has(k));
      const onlyAr = Array.from(arSet).filter((k) => !enSet.has(k));
      expect(onlyEn, `en.${ns} only keys`).toEqual([]);
      expect(onlyAr, `ar.${ns} only keys`).toEqual([]);
    }
  });

  test("every new-namespace leaf value is a non-empty string in both locales", () => {
    for (const file of ["messages/en.json", "messages/ar.json"]) {
      const json = readJson(file) as Record<string, Messages>;
      for (const ns of NAMESPACES) {
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
});

describe("R80 — the six views are keyed", () => {
  test("C: every tranche view consumes its namespace", () => {
    for (const [file, ns] of Object.entries(VIEWS_AND_NS)) {
      expect(readRepo(`${VIEWS}/${file}`), file).toContain(`useTranslations("${ns}")`);
    }
  });

  test("D: the five newly keyed views sweep at ZERO candidates", () => {
    for (const file of [
      "placeholder-view.tsx",
      "changes-templates-view.tsx",
      "noc-view.tsx",
      "changes-calendar-view.tsx",
      "sites-view.tsx",
    ]) {
      const found = candidates(readRepo(`${VIEWS}/${file}`));
      expect(found, `${file} still carries literals`).toEqual([]);
    }
  });

  test("D: ztp-view's remaining candidates are exactly the technical placeholders", () => {
    const found = candidates(readRepo(`${VIEWS}/ztp-view.tsx`));
    expect(found).toEqual(["FAB-2026-0117", "BR2-ACC-SW-09", "C9200L-48P-4X"]);
  });
});

describe("R80 — sweep governance moved with the tranche", () => {
  test("E: the r56 ledger no longer lists the six keyed views", () => {
    const sweep = readRepo("tests/audit/r56-i18n-chrome-sweep.test.ts");
    for (const file of [
      "placeholder-view.tsx",
      "ztp-view.tsx",
      "changes-templates-view.tsx",
      "noc-view.tsx",
      "changes-calendar-view.tsx",
      "sites-view.tsx",
    ]) {
      // Ledger entries carry a NUMERIC ceiling (`"file": 27`); ztp-view
      // legitimately reappears in KEYED_SURVIVORS with an ARRAY value.
      const ledgerPattern = new RegExp(`"${file.replace(".", "\\.")}":\\s*\\d`);
      expect(ledgerPattern.test(sweep), `${file} must not be ledgered anymore`).toBe(false);
    }
  });

  test("E: KEYED_SURVIVORS governs ztp-view's technical tokens", () => {
    const sweep = readRepo("tests/audit/r56-i18n-chrome-sweep.test.ts");
    expect(sweep).toContain('"ztp-view.tsx": ["FAB-2026-0117", "BR2-ACC-SW-09", "C9200L-48P-4X"]');
  });
});

/** Total leaf count helper (kept top-level for tsc portability). */
function enLeavesSum(en: Messages): number {
  return leaves(en).length;
}
