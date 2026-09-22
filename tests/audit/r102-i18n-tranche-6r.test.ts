import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** R102 — i18n tranche 6r: backups view keyed and the ledger closed. */

const REPO = join(import.meta.dir, "..", "..");
const VIEW = "src/components/views/backups-view.tsx";
type Messages = Record<string, unknown>;

function leaves(obj: unknown, prefix = "", acc: string[] = []): string[] {
  if (obj !== null && typeof obj === "object") {
    for (const [key, value] of Object.entries(obj as Messages)) leaves(value, prefix ? `${prefix}.${key}` : key, acc);
  } else acc.push(prefix);
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
  return [...[...src.matchAll(prop)].map((match) => match[2]), ...[...src.matchAll(jsx)].map((match) => match[1])];
}

describe("R102 — backups namespace", () => {
  test("has the complete balanced namespace with deep EN/AR parity", () => {
    const en = readJson("messages/en.json") as Record<string, Messages>;
    const ar = readJson("messages/ar.json") as Record<string, Messages>;
    expect(leaves(en.backups).length).toBe(117);
    expect(leaves(ar.backups).length).toBe(117);
    expect(new Set(leaves(en.backups))).toEqual(new Set(leaves(ar.backups)));
    for (const file of ["messages/en.json", "messages/ar.json"]) {
      const namespace = (readJson(file) as Record<string, Messages>).backups;
      const walk = (node: unknown, path: string) => {
        if (node !== null && typeof node === "object") {
          for (const [key, value] of Object.entries(node as Messages)) walk(value, `${path}.${key}`);
          return;
        }
        expect(typeof node === "string" && node.length > 0, `${file}:${path}`).toBe(true);
      };
      walk(namespace, "backups");
    }
  });

  test("updates dictionary totals from R101's 2,733 leaves", () => {
    expect(leaves(readJson("messages/en.json")).length).toBe(2850);
    expect(leaves(readJson("messages/ar.json")).length).toBe(2850);
  });
});

describe("R102 — view keying and empty-ledger governance", () => {
  test("consumes backups and has zero shallow sweep candidates", () => {
    const src = readRepo(VIEW);
    expect(src).toContain('useTranslations("backups")');
    expect(candidates(src)).toEqual([]);
  });

  test("keeps dynamic history, form, and policy interpolation shapes", () => {
    const src = readRepo(VIEW);
    const en = readJson("messages/en.json") as Record<string, Messages>;
    expect(src).toContain('t("history.pagination"');
    expect(src).toContain('t("policies.toggle"');
    expect(en.backups.history.pagination).toContain("{total, plural");
    expect(en.backups.history.openDevice).toContain("{hostname}");
    expect(en.backups.policies.deleteDescription).toContain("{name}");
  });

  test("closes the R56 ledger and forbids all remaining candidates", () => {
    const sweep = readRepo("tests/audit/r56-i18n-chrome-sweep.test.ts");
    const block = sweep.slice(sweep.indexOf("const PENDING_VIEWS"));
    expect(block).not.toMatch(/"[a-z-]+-view\.tsx":\s*\d/);
    expect(block).toContain("const PENDING_VIEWS: Record<string, number> = {};");
  });
});
