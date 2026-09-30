/**
 * RT-039 / F-055 — admin table action columns use logical `text-end`
 * (RTL-mirrored) instead of physical `text-right`. LTR rendering is
 * identical; the Arabic layout now mirrors correctly.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const FILES = [
  "src/components/views/admin-integrations-view.tsx",
  "src/components/views/admin-api-clients-view.tsx",
  "src/components/views/admin-collectors-view.tsx",
];

describe("RT-039 — text-end sweep", () => {
  test("no physical text-right remains in the three admin views", () => {
    for (const f of FILES) {
      expect(readFileSync(path.join(REPO_ROOT, f), "utf8")).not.toContain("text-right");
    }
  });

  test("the logical text-end utility is in place", () => {
    let total = 0;
    for (const f of FILES) {
      total += readFileSync(path.join(REPO_ROOT, f), "utf8").split("text-end").length - 1;
    }
    expect(total).toBeGreaterThanOrEqual(8);
  });
});
