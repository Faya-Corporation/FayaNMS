import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** R93 — i18n tranche 6i: backup compliance view keyed. */

const REPO = join(import.meta.dir, "..", "..");
const VIEW = "src/components/views/backup-compliance-view.tsx";

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
  const prop = /\b(title|placeholder|aria-label|label|description|heading)="([A-Z][^"]{2,})"/g;
  const jsx = />\s*([A-Z][a-zA-Z0-9 ,.·…—''-]{2,70})\s*</g;
  return [
    ...[...src.matchAll(prop)].map((match) => match[2]),
    ...[...src.matchAll(jsx)].map((match) => match[1]),
  ];
}

describe("R93 — backup compliance namespace", () => {
  test("has 37 non-empty leaves with deep EN/AR parity", () => {
    const en = readJson("messages/en.json") as Record<string, any>;
    const ar = readJson("messages/ar.json") as Record<string, any>;
    expect(leaves(en.backupCompliance).length).toBe(37);
    expect(leaves(ar.backupCompliance).length).toBe(37);
    expect(new Set(leaves(en.backupCompliance))).toEqual(new Set(leaves(ar.backupCompliance)));
    for (const file of ["messages/en.json", "messages/ar.json"]) {
      const namespace = (readJson(file) as Record<string, any>).backupCompliance;
      const walk = (node: unknown, path: string) => {
        if (node !== null && typeof node === "object") {
          for (const [key, value] of Object.entries(node as Messages)) walk(value, `${path}.${key}`);
          return;
        }
        expect(typeof node === "string" && node.length > 0, `${file}:${path}`).toBe(true);
      };
      walk(namespace, "backupCompliance");
    }
  });

  test("checks dictionary totals at current HEAD after R102", () => {
    expect(leaves(readJson("messages/en.json")).length).toBe(3193);
    expect(leaves(readJson("messages/ar.json")).length).toBe(3193);
  });
});

describe("R93 — view keying and ledger", () => {
  test("consumes backupCompliance and has zero shallow sweep candidates", () => {
    const src = readRepo(VIEW);
    expect(src).toContain('useTranslations("backupCompliance")');
    expect(candidates(src)).toEqual([]);
  });

  test("keeps KPI and row interpolation shapes", () => {
    const src = readRepo(VIEW);
    const en = readJson("messages/en.json") as Record<string, any>;
    expect(src).toContain('t("kpi.compliant.description"');
    expect(src).toContain('t("row.openDeviceAria"');
    expect(en.backupCompliance.kpi.compliant.description).toContain("{compliant}");
    expect(en.backupCompliance.kpi.compliant.description).toContain("{managed}");
    expect(en.backupCompliance.site.percent).toContain("{percent}");
  });

  test("updates the R56 ledger to 0 views and 0 candidates", () => {
    const sweep = readRepo("tests/audit/r56-i18n-chrome-sweep.test.ts");
    const block = sweep.slice(sweep.indexOf("const PENDING_VIEWS"));
    expect(block).not.toMatch(/"backup-compliance-view\.tsx":\s*\d/);
    const entries = Array.from(block.matchAll(/"([a-z-]+-view\.tsx)":\s*(\d+)/g));
    expect(entries.length).toBe(0);
    expect(entries.reduce((sum, [, , count]) => sum + Number(count), 0)).toBe(0);
  });
});
