import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** R96 — i18n tranche 6l: maintenance view keyed. */

const REPO = join(import.meta.dir, "..", "..");
const VIEW = "src/components/views/maintenance-view.tsx";

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

describe("R96 — maintenance namespace", () => {
  test("has 65 non-empty leaves with deep EN/AR parity", () => {
    const en = readJson("messages/en.json") as Record<string, Messages>;
    const ar = readJson("messages/ar.json") as Record<string, Messages>;
    expect(leaves(en.maintenanceView).length).toBe(65);
    expect(leaves(ar.maintenanceView).length).toBe(65);
    expect(new Set(leaves(en.maintenanceView))).toEqual(new Set(leaves(ar.maintenanceView)));
    for (const file of ["messages/en.json", "messages/ar.json"]) {
      const namespace = (readJson(file) as Record<string, Messages>).maintenanceView;
      const walk = (node: unknown, path: string) => {
        if (node !== null && typeof node === "object") {
          for (const [key, value] of Object.entries(node as Messages)) walk(value, `${path}.${key}`);
          return;
        }
        expect(typeof node === "string" && node.length > 0, `${file}:${path}`).toBe(true);
      };
      walk(namespace, "maintenanceView");
    }
  });

  test("updates dictionary totals from R95's 2,250 leaves to 2,315", () => {
    expect(leaves(readJson("messages/en.json")).length).toBe(2315);
    expect(leaves(readJson("messages/ar.json")).length).toBe(2315);
  });
});

describe("R96 — view keying and ledger", () => {
  test("consumes maintenanceView and has zero shallow sweep candidates", () => {
    const src = readRepo(VIEW);
    expect(src).toContain('useTranslations("maintenanceView")');
    expect(candidates(src)).toEqual([]);
  });

  test("keeps row, overlap, and delete-dialog interpolation shapes", () => {
    const src = readRepo(VIEW);
    const en = readJson("messages/en.json") as Record<string, Messages>;
    expect(src).toContain('"row.togglePause"');
    expect(src).toContain('t("form.overlap"');
    expect(src).toContain('t("delete.title"');
    expect(en.maintenanceView.row.togglePause).toContain("{name}");
    expect(en.maintenanceView.form.overlap).toContain("{count, plural");
    expect(en.maintenanceView.delete.title).toContain("{name}");
  });

  test("updates the R56 ledger to 6 views and 297 candidates", () => {
    const sweep = readRepo("tests/audit/r56-i18n-chrome-sweep.test.ts");
    const block = sweep.slice(sweep.indexOf("const PENDING_VIEWS"));
    expect(block).not.toMatch(/"maintenance-view\.tsx":\s*\d/);
    const entries = Array.from(block.matchAll(/"([a-z-]+-view\.tsx)":\s*(\d+)/g));
    expect(entries.length).toBe(6);
    expect(entries.reduce((sum, [, , count]) => sum + Number(count), 0)).toBe(297);
  });
});
