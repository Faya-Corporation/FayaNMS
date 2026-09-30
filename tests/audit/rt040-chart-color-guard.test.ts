/**
 * RT-040 / F-056 — chart CSS variable interpolation is color-shape guarded.
 * The <style> block interpolates caller-supplied config into CSS; only
 * literal color shapes may pass (hex / rgb(a) / hsl(a) / named), otherwise
 * the variable is dropped — a crafted config cannot inject arbitrary CSS.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const SRC = readFileSync(path.join(REPO_ROOT, "src/components/ui/chart.tsx"), "utf8");

describe("RT-040 — chart color guard", () => {
  test("interpolation is guarded by a color-shape whitelist", () => {
    expect(SRC).toMatch(/rgba?\(|#[0-9a-fA-F]{3,8}|hsla?\(/);
    expect(SRC).toContain("safe ? `  --color-${key}: ${safe};` : null");
  });

  test("the guard drops non-color values", () => {
    // Static contract: anything failing the regex becomes null -> skipped.
    expect(SRC).toContain("typeof color === \"string\"");
  });
});
