import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * R81 — i18n tranche 2: three views keyed (admin-drivers,
 * perf-capacity, admin-system).
 *
 * Pins:
 *   A. The TWO new namespaces (drivers, systemSettings) exist in BOTH
 *      dictionaries and are leaf-balanced; the capacity.chrome chrome
 *      block was added to the EXISTING `capacity` namespace in both
 *      locales (all balanced, non-empty).
 *   B. New-key parity is deep (same leaf-path sets, both directions) —
 *      full-dictionary deep parity stays pinned by the r56 sweep.
 *   C. All three views consume their namespaces (perf-capacity already
 *      consumed `capacity`; the two admin views are NEW consumers).
 *   D. Sweep candidates: all three views are at ZERO (hand-cleaned
 *      against the full inventories — including non-swept literals:
 *      lowercase copy, colon-syntax GROUPS, ternary status labels,
 *      template aria-labels, the module-level metricLabel helper and
 *      the ErrorState `reason` prop which the shallow regexes never
 *      matched).
 *   E. Ledger governance: the r56 sweep no longer ledgered the three
 *      files, the numeric ledger carried EXACTLY 23 entries at R81 HEAD
 *      (22 since R82's tranche 3 — the pin below tracks HEAD truth), and
 *      the ICU plurals exist in both locales (en one/other; ar full
 *      one/two/few/many/other set).
 *
 * Documented technical survivors (unchanged policy): ConfidenceBadge's
 * HIGH/MEDIUM/LOW API tokens (LIVE-chip precedent), Setting-table
 * setting.label rows (DB content, like hostnames), drivers-registry
 * manifests (vendorLabel/cap.label/configFlavor/notes — VENDOR_LABELS
 * precedent), date-fns English date formatting, "n/a" and "—".
 */

const REPO = join(import.meta.dir, "..", "..");
const VIEWS = "src/components/views";

const NEW_NAMESPACES = ["drivers", "systemSettings"] as const;

const VIEWS_AND_NS: Record<string, string> = {
  "admin-drivers-view.tsx": "drivers",
  "perf-capacity-view.tsx": "capacity",
  "admin-system-view.tsx": "systemSettings",
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

function ns(obj: Messages, path: string): Messages {
  let node: unknown = obj;
  for (const part of path.split(".")) {
    node = (node as Messages)[part];
  }
  return (node ?? null) as Messages;
}

describe("R81 — tranche 2 namespaces exist and are balanced", () => {
  test("A: the two new namespaces exist in both dictionaries with equal leaf counts", () => {
    const en = readJson("messages/en.json") as Record<string, any>;
    const ar = readJson("messages/ar.json") as Record<string, any>;
    for (const key of NEW_NAMESPACES) {
      expect(en[key], `en.${key}`).toBeDefined();
      expect(ar[key], `ar.${key}`).toBeDefined();
      const enLeaves = leaves(en[key]).length;
      const arLeaves = leaves(ar[key]).length;
      expect(enLeaves, `en.${key} leaves`).toBe(arLeaves);
      expect(enLeaves, `en.${key} must be non-trivial`).toBeGreaterThan(0);
    }
    expect(leaves(en.drivers).length).toBe(13);
    expect(leaves(en.systemSettings).length).toBe(45);
  });

  test("A: capacity.chrome exists in both dictionaries with 35 balanced leaves", () => {
    const en = readJson("messages/en.json") as Record<string, any>;
    const ar = readJson("messages/ar.json") as Record<string, any>;
    const enChrome = leaves(ns(en, "capacity.chrome"));
    const arChrome = leaves(ns(ar, "capacity.chrome"));
    expect(enChrome.length).toBe(35);
    expect(arChrome.length).toBe(35);
  });

  test("B: new-key parity is deep — identical leaf paths both directions", () => {
    const en = readJson("messages/en.json") as Record<string, any>;
    const ar = readJson("messages/ar.json") as Record<string, any>;
    for (const key of [...NEW_NAMESPACES, "capacity.chrome"]) {
      const enSet = new Set(leaves(ns(en, key)));
      const arSet = new Set(leaves(ns(ar, key)));
      const onlyEn = Array.from(enSet).filter((k) => !arSet.has(k));
      const onlyAr = Array.from(arSet).filter((k) => !enSet.has(k));
      expect(onlyEn, `en.${key} only keys`).toEqual([]);
      expect(onlyAr, `ar.${key} only keys`).toEqual([]);
    }
  });

  test("every new-key leaf value is a non-empty string in both locales", () => {
    for (const file of ["messages/en.json", "messages/ar.json"]) {
      const json = readJson(file) as Record<string, any>;
      for (const key of [...NEW_NAMESPACES, "capacity.chrome"]) {
        const walk = (node: unknown, path: string) => {
          if (node !== null && typeof node === "object") {
            for (const [k, v] of Object.entries(node as Messages)) {
              walk(v, `${path}.${k}`);
            }
            return;
          }
          expect(typeof node === "string" && node.length > 0, `${file}:${path}`).toBe(true);
        };
        walk(ns(json, key), key);
      }
    }
  });
});

describe("R81 — the three views are keyed", () => {
  test("C: every tranche view consumes its namespace", () => {
    for (const [file, key] of Object.entries(VIEWS_AND_NS)) {
      expect(readRepo(`${VIEWS}/${file}`), file).toContain(`useTranslations("${key}")`);
    }
  });

  test("D: all three views sweep at ZERO candidates", () => {
    for (const file of Object.keys(VIEWS_AND_NS)) {
      const found = candidates(readRepo(`${VIEWS}/${file}`));
      expect(found, `${file} still carries literals`).toEqual([]);
    }
  });
});

describe("R81 — sweep governance moved with the tranche", () => {
  test("E: the r56 ledger no longer lists the three keyed views", () => {
    const sweep = readRepo("tests/audit/r56-i18n-chrome-sweep.test.ts");
    for (const file of Object.keys(VIEWS_AND_NS)) {
      const ledgerPattern = new RegExp(`"${file.replace(".", "\\.")}":\\s*\\d`);
      expect(ledgerPattern.test(sweep), `${file} must not be ledgered anymore`).toBe(false);
    }
  });

  test("E: the numeric ledger carries EXACTLY 0 entries at current HEAD (R102 removed backups)", () => {
    const sweep = readRepo("tests/audit/r56-i18n-chrome-sweep.test.ts");
    const block = sweep.slice(sweep.indexOf("const PENDING_VIEWS"));
    const entries = Array.from(block.matchAll(/"[a-z-]+-view\.tsx":\s*\d/g));
      expect(entries.length).toBe(0);
  });

  test("E: the unsaved-changes ICU plural exists with locale-appropriate categories", () => {
    const en = readJson("messages/en.json") as Record<string, any>;
    const ar = readJson("messages/ar.json") as Record<string, any>;
    const enPlural = (en.systemSettings as Messages).unsavedChanges as string;
    const arPlural = (ar.systemSettings as Messages).unsavedChanges as string;
    expect(enPlural).toContain("{count, plural,");
    expect(enPlural).toContain("one {");
    expect(enPlural).toContain("other {");
    for (const category of ["one {", "two {", "few {", "many {", "other {"]) {
      expect(arPlural, `ar plural missing ${category}`).toContain(category);
    }
  });
});
