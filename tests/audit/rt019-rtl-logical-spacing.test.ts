import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

/**
 * RT-019 / F-022 — RTL sweep: physical left/right + pl/pr/ml/mr → logical
 * start/end classes.
 *
 * Nine files still used physical directional utilities that don't mirror in
 * RTL (the rest of the app consistently uses `ms-/me-/ps-/pe-` and
 * `rtl:-scale-x-100`, so these read as leftovers): search-input icon +
 * padding on the big list views, leading icons on admin buttons, and two
 * paddings/margins on noc/flows.
 *
 * Pinned here (source police, style of the i18n tranche tests):
 *   1. no physical left/right spacing utilities remain in the nine files;
 *   2. the logical replacements are present at the mapped call sites;
 *   3. scope guard: `text-right` belongs to RT-039 (F-055) and must NOT
 *      fail this suite — the two sweeps stay independently revertible.
 */

const REPO_ROOT = join(import.meta.dir, "../..");

const NINE_FILES = [
  "src/components/views/devices-view.tsx",
  "src/components/views/interfaces-view.tsx",
  "src/components/device/device-interfaces-tab.tsx",
  "src/components/views/admin-integrations-view.tsx",
  "src/components/views/admin-system-view.tsx",
  "src/components/views/admin-api-clients-view.tsx",
  "src/components/views/admin-collectors-view.tsx",
  "src/components/views/noc-view.tsx",
  "src/components/views/flows-view.tsx",
] as const;

const contents = new Map<string, string>(
  NINE_FILES.map((rel) => [rel, readFileSync(join(REPO_ROOT, rel), "utf8")]),
);

// Boundary-guarded: `start-2.5`/`ps-8`/`me-2` must never match; `text-right`
// (RT-039's scope) must never match either.
const PHYSICAL_SPACING = /(?:^|["'\s])(left-\d|right-\d|pl-\d|pr-\d|ml-\d|mr-\d)/;

describe("RT-019: physical → logical directional utilities in the nine files", () => {
  test("no physical left/right spacing utilities remain in the nine files", () => {
    for (const rel of NINE_FILES) {
      const src = contents.get(rel)!;
      const hit = src.split("\n").findIndex((line) => PHYSICAL_SPACING.test(line));
      expect({ file: rel, firstOffendingLine: hit + 1 }).toEqual({
        file: rel,
        firstOffendingLine: 0,
      });
    }
  });

  test("logical replacements present: search inputs use start-2.5 + ps-8", () => {
    for (const rel of [
      "src/components/views/devices-view.tsx",
      "src/components/views/interfaces-view.tsx",
      "src/components/device/device-interfaces-tab.tsx",
    ]) {
      const src = contents.get(rel)!;
      expect(src).toContain("start-2.5");
      expect(src).toContain("ps-8");
    }
  });

  test("logical replacements present: admin views use me-2/me-1 leading icons", () => {
    for (const [rel, expected] of [
      ["src/components/views/admin-integrations-view.tsx", ["me-2", "me-1"]],
      ["src/components/views/admin-system-view.tsx", ["me-2", "me-1"]],
      ["src/components/views/admin-api-clients-view.tsx", ["me-2", "me-1"]],
      ["src/components/views/admin-collectors-view.tsx", ["me-2"]],
    ] as const) {
      const src = contents.get(rel)!;
      for (const cls of expected) expect(src).toContain(cls);
    }
  });

  test("logical replacements present: noc-view pe-1, flows-view ms-1.5", () => {
    expect(contents.get("src/components/views/noc-view.tsx")).toContain("pe-1");
    expect(contents.get("src/components/views/flows-view.tsx")).toContain("ms-1.5");
  });

  test("scope guard: text-right is RT-039's scope and does not fail this suite", () => {
    // Cross-RT guard: this suite must stay green before AND after RT-039
    // lands. text-right occurrences (if any) in the nine files belong to
    // F-055/RT-039 and are deliberately NOT asserted on here.
    for (const rel of NINE_FILES) {
      expect(PHYSICAL_SPACING.test(contents.get(rel)!)).toBe(false);
    }
  });
});
