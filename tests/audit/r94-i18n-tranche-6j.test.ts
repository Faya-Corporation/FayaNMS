import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** R94 — i18n tranche 6j: change approvals view keyed. */

const REPO = join(import.meta.dir, "..", "..");
const VIEW = "src/components/views/change-approvals-view.tsx";

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

describe("R94 — change approvals namespace", () => {
  test("has 50 non-empty leaves with deep EN/AR parity", () => {
    const en = readJson("messages/en.json") as Record<string, Messages>;
    const ar = readJson("messages/ar.json") as Record<string, Messages>;
    expect(leaves(en.changeApprovals).length).toBe(50);
    expect(leaves(ar.changeApprovals).length).toBe(50);
    expect(new Set(leaves(en.changeApprovals))).toEqual(new Set(leaves(ar.changeApprovals)));
    for (const file of ["messages/en.json", "messages/ar.json"]) {
      const namespace = (readJson(file) as Record<string, Messages>).changeApprovals;
      const walk = (node: unknown, path: string) => {
        if (node !== null && typeof node === "object") {
          for (const [key, value] of Object.entries(node as Messages)) walk(value, `${path}.${key}`);
          return;
        }
        expect(typeof node === "string" && node.length > 0, `${file}:${path}`).toBe(true);
      };
      walk(namespace, "changeApprovals");
    }
  });

  test("checks dictionary totals at current HEAD after R100", () => {
    expect(leaves(readJson("messages/en.json")).length).toBe(2632);
    expect(leaves(readJson("messages/ar.json")).length).toBe(2632);
  });
});

describe("R94 — view keying and ledger", () => {
  test("consumes changeApprovals and has zero shallow sweep candidates", () => {
    const src = readRepo(VIEW);
    expect(src).toContain('useTranslations("changeApprovals")');
    expect(candidates(src)).toEqual([]);
  });

  test("keeps decision interpolation and validation shapes", () => {
    const src = readRepo(VIEW);
    const en = readJson("messages/en.json") as Record<string, Messages>;
    expect(src).toContain('t("row.approveAria"');
    expect(src).toContain('t("dialog.rejectDescription"');
    expect(en.changeApprovals.row.approveAria).toContain("{level}");
    expect(en.changeApprovals.row.approveAria).toContain("{number}");
    expect(en.changeApprovals.dialog.rejectDescription).toContain("4");
    expect(en.changeApprovals.tooltips.sod).toContain("{risk}");
  });

  test("updates the R56 ledger to 2 views and 113 candidates", () => {
    const sweep = readRepo("tests/audit/r56-i18n-chrome-sweep.test.ts");
    const block = sweep.slice(sweep.indexOf("const PENDING_VIEWS"));
    expect(block).not.toMatch(/"change-approvals-view\.tsx":\s*\d/);
    const entries = Array.from(block.matchAll(/"([a-z-]+-view\.tsx)":\s*(\d+)/g));
    expect(entries.length).toBe(2);
    expect(entries.reduce((sum, [, , count]) => sum + Number(count), 0)).toBe(113);
  });
});
