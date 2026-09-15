import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";

/**
 * TASK-BROWSER-E2E — governance pins for the rendering-layer browser suite.
 *
 * The HTTP-level E2E journeys (tests/e2e/, R39) drive the real topology
 * without a browser; TASK-BROWSER-E2E adds the RENDERING layer: real
 * headless-Chromium journeys (sign-in → app shell), axe-core accessibility
 * scans (sign-in + authenticated dashboard), a keyboard-only sweep and an
 * RTL (ar) direction + overflow sweep — all against the SAME real
 * production topology harness (tests/e2e/e2e-server.ts), gated behind
 * FAYANMS_BROWSER_E2E=1 so the hermetic unit suite never depends on a
 * browser.
 *
 * Pinned here (governance, not behavior):
 *   1. package.json declares the browser tooling as REAL devDependencies
 *      (playwright + axe-core) — the suite never leans on a hoisted
 *      transitive or a global install;
 *   2. ci.yml carries a dedicated `browser` job (build + browser install +
 *      FAYANMS_BROWSER_E2E=1) so rendering-layer evidence becomes a CI
 *      artifact the moment runners return (CI-001);
 *   3. the browser suite gates on FAYANMS_BROWSER_E2E=1 (hermetic default).
 */

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  devDependencies: Record<string, string>;
};

const ciYml = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

describe("TASK-BROWSER-E2E: browser tooling is a declared dependency", () => {
  test("PIN: playwright is a real devDependency (no transitive/global leaning)", () => {
    const version = pkg.devDependencies["playwright"];
    expect(version).toBeDefined();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/); // exact pin, no range
  });

  test("PIN: axe-core is a real devDependency", () => {
    const version = pkg.devDependencies["axe-core"];
    expect(version).toBeDefined();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("TASK-BROWSER-E2E: CI carries the rendering-layer gate", () => {
  test("PIN: ci.yml has a browser job that installs chromium and runs the suite", () => {
    expect(ciYml).toMatch(/browser:/); // the job id
    expect(ciYml).toContain("FAYANMS_BROWSER_E2E=1");
    expect(ciYml).toContain("playwright install");
    expect(ciYml).toContain("tests/browser/");
  });

  test("PIN: the browser job is REQUIRED (hard gate, not advisory)", () => {
    const requiredBlock = ciYml.match(/required-checks:[\s\S]*$/)?.[0] ?? "";
    // The workflow's own governance documentation lists browser among the
    // required checks (same honesty block the GOV-001 owner action uses).
    expect(requiredBlock).toContain("browser");
  });
});

describe("TASK-BROWSER-E2E: the suite stays out of the hermetic unit gate", () => {
  test("PIN: browser journeys skip unless FAYANMS_BROWSER_E2E=1", () => {
    const journey = readFileSync(
      new URL("../browser/browser-journeys.test.ts", import.meta.url),
      "utf8"
    );
    expect(journey).toContain("FAYANMS_BROWSER_E2E");
    expect(journey).toContain("test.skipIf");
  });
});
