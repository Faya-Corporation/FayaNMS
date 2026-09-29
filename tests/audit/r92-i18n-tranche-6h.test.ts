import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** R92 — i18n tranche 6h: drift view keyed. */

const REPO = join(import.meta.dir, "..", "..");
const VIEW = "src/components/views/drift-view.tsx";

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

describe("R92 — drift namespace", () => {
  test("has 51 non-empty leaves with deep EN/AR parity", () => {
    const en = readJson("messages/en.json") as Record<string, any>;
    const ar = readJson("messages/ar.json") as Record<string, any>;
    expect(leaves(en.driftView).length).toBe(51);
    expect(leaves(ar.driftView).length).toBe(51);
    expect(new Set(leaves(en.driftView))).toEqual(new Set(leaves(ar.driftView)));
    for (const file of ["messages/en.json", "messages/ar.json"]) {
      const namespace = (readJson(file) as Record<string, any>).driftView;
      const walk = (node: unknown, path: string) => {
        if (node !== null && typeof node === "object") {
          for (const [key, value] of Object.entries(node as Messages)) walk(value, `${path}.${key}`);
          return;
        }
        expect(typeof node === "string" && node.length > 0, `${file}:${path}`).toBe(true);
      };
      walk(namespace, "driftView");
    }
  });

  test("checks dictionary totals at current HEAD after R102", () => {
    expect(leaves(readJson("messages/en.json")).length).toBe(3214);
    expect(leaves(readJson("messages/ar.json")).length).toBe(3214);
  });
});

describe("R92 — view keying and ledger", () => {
  test("consumes driftView and has zero shallow sweep candidates", () => {
    const src = readRepo(VIEW);
    expect(src).toContain('useTranslations("driftView")');
    expect(candidates(src)).toEqual([]);
  });

  test("keeps dynamic row and dialog interpolation shapes", () => {
    const src = readRepo(VIEW);
    const en = readJson("messages/en.json") as Record<string, any>;
    expect(src).toContain('t("dialog.title"');
    expect(src).toContain('t("triage.acceptDescription"');
    expect(en.driftView.dialog.title).toContain("{hostname}");
    expect(en.driftView.dialog.title).toContain("{baseline}");
    expect(en.driftView.dialog.title).toContain("{current}");
    expect(en.driftView.pagination.summary).toContain("{total, plural,");
  });

  test("updates the R56 ledger to 0 views and 0 candidates", () => {
    const sweep = readRepo("tests/audit/r56-i18n-chrome-sweep.test.ts");
    const block = sweep.slice(sweep.indexOf("const PENDING_VIEWS"));
    expect(block).not.toMatch(/"drift-view\.tsx":\s*\d/);
    const entries = Array.from(block.matchAll(/"([a-z-]+-view\.tsx)":\s*(\d+)/g));
    expect(entries.length).toBe(0);
    expect(entries.reduce((sum, [, , count]) => sum + Number(count), 0)).toBe(0);
  });
});
