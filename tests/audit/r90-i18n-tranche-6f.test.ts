import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** R90 — i18n tranche 6f: events view keyed. */

const REPO = join(import.meta.dir, "..", "..");
const VIEW = "src/components/views/events-view.tsx";

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

describe("R90 — events namespace", () => {
  test("has 42 non-empty leaves with deep EN/AR parity", () => {
    const en = readJson("messages/en.json") as Record<string, Messages>;
    const ar = readJson("messages/ar.json") as Record<string, Messages>;
    expect(leaves(en.eventsView).length).toBe(42);
    expect(leaves(ar.eventsView).length).toBe(42);
    expect(new Set(leaves(en.eventsView))).toEqual(new Set(leaves(ar.eventsView)));
    for (const file of ["messages/en.json", "messages/ar.json"]) {
      const namespace = (readJson(file) as Record<string, Messages>).eventsView;
      const walk = (node: unknown, path: string) => {
        if (node !== null && typeof node === "object") {
          for (const [key, value] of Object.entries(node as Messages)) walk(value, `${path}.${key}`);
          return;
        }
        expect(typeof node === "string" && node.length > 0, `${file}:${path}`).toBe(true);
      };
      walk(namespace, "eventsView");
    }
  });

  test("checks dictionary totals at current HEAD after R95", () => {
    expect(leaves(readJson("messages/en.json")).length).toBe(2250);
    expect(leaves(readJson("messages/ar.json")).length).toBe(2250);
  });
});

describe("R90 — view keying and ledger", () => {
  test("consumes eventsView and has zero shallow sweep candidates", () => {
    const src = readRepo(VIEW);
    expect(src).toContain('useTranslations("eventsView")');
    expect(candidates(src)).toEqual([]);
  });

  test("keys row expansion and copy chrome in the helper components", () => {
    const src = readRepo(VIEW);
    expect(src).toContain('t("row.copyJson"');
    expect(src).toContain('t("row.notRecorded")');
    expect(src).toContain('t("row.noPayload")');
    expect(src).toContain('t("row.correlationFilterTitle")');
  });

  test("updates the R56 ledger to 7 views and 335 candidates", () => {
    const sweep = readRepo("tests/audit/r56-i18n-chrome-sweep.test.ts");
    const block = sweep.slice(sweep.indexOf("const PENDING_VIEWS"));
    expect(block).not.toMatch(/"events-view\.tsx":\s*\d/);
    const entries = Array.from(block.matchAll(/"([a-z-]+-view\.tsx)":\s*(\d+)/g));
    expect(entries.length).toBe(7);
    expect(entries.reduce((sum, [, , count]) => sum + Number(count), 0)).toBe(335);
  });
});
