/**
 * RT-038 / F-054 — locked download hints must stay keyboard/AT-reachable.
 * `disabled` removes buttons from the a11y tree and blocks focus, making the
 * "why is this locked" hint unreachable exactly when it matters. The locked
 * branch now renders aria-disabled buttons with a guarded handler, no inner
 * anchor, and an sr-only hint node.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const SRC = readFileSync(path.join(REPO_ROOT, "src/components/views/reports-view.tsx"), "utf8");

describe("RT-038 — locked download reachability", () => {
  test("locked buttons use aria-disabled with a guarded handler, never disabled", () => {
    expect(SRC).not.toMatch(/aria-label=\{t\("downloadLockedHint"\)\}[\s\S]{0,120}disabled/);
    expect(SRC).toContain("aria-disabled");
    expect(SRC).toContain("onClick={(e) => e.preventDefault()}");
  });

  test("locked buttons carry an sr-only hint and no anchor", () => {
    const lockedBlock = SRC.slice(SRC.indexOf('aria-label={t("downloadLockedHint")}'));
    expect(lockedBlock).toContain('className="sr-only"');
    expect(lockedBlock).not.toContain("<a");
  });
});
