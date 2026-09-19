/**
 * R77 — CI bring-up iteration 8: artifact-verified image build + disk prewash.
 *
 * Context (docs/audits/FayaNMS-R70-Merge-to-Main-and-CI-Bootstrap-2026-09-19.md §13):
 * run 35423093770 @ c73f14b — gate GREEN sixth consecutive, e2e GREEN fifth
 * consecutive, browser GREEN second consecutive (12/12 twice). The image
 * build then went DEEPER THAN EVER: the T1 guard passed, the portable user
 * worked, the frozen worker install resolved the types, and `next build`
 * COMPLETED SUCCESSFULLY — the full route summary printed — and THEN Bun
 * 1.3.14 segfaulted at process exit (its own teardown bug, deterministic,
 * bun.report/1.3.14/...): exit 132 failed the RUN although the build had
 * succeeded. The runner also warned "Free space left: 0 MB" mid-build.
 * FIX (two planes, gate strength preserved):
 *   - Dockerfile: the build's success is verified by its ARTIFACTS —
 *     .next/BUILD_ID + .next/standalone must exist or the RUN fails (a
 *     genuinely failed build cannot produce them in this fresh stage);
 *     a nonzero bun exit AFTER artifacts exist is documented as the known
 *     teardown segfault. No `|| true` anywhere — a failed build still fails.
 *   - ci.yml scan job: a "Free disk space" step removes the hosted image's
 *     unused multi-GB toolchains (android/dotnet/ghc/boost/jvm) and prunes
 *     docker state BEFORE the image build.
 *
 * These pins freeze both fixes and the run record. They never execute
 * docker.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../..");
const read = (p: string): string => readFileSync(join(REPO, p), "utf8");

const DOCKERFILE = read("Dockerfile");
const CI = read(".github/workflows/ci.yml");
const DOC = read("docs/audits/FayaNMS-R70-Merge-to-Main-and-CI-Bootstrap-2026-09-19.md");

describe("R77-A: the image build's gate is artifact-verified, never weakened", () => {
  test("BUILD_ID + standalone are the success criterion; no blind swallow", () => {
    const buildStage = DOCKERFILE.slice(
      DOCKERFILE.indexOf("FROM deps AS build"),
      DOCKERFILE.indexOf("FROM oven/bun:1.3.14-slim")
    );
    expect(buildStage).toContain("35423093770");
    expect(buildStage).toContain("[ ! -f .next/BUILD_ID ]");
    expect(buildStage).toContain("[ ! -d .next/standalone ]");
    expect(buildStage).toContain("BUILD FAILED: no build artifacts");
    expect(buildStage).toContain("teardown segfault, artifacts verified");
    // the gate cannot be weakened: no unconditional success, no `|| true`
    // on the build line itself
    expect(buildStage).not.toContain("bun run build || true");
    expect(buildStage).toContain("bun run build; code=$?;");
  });

  test("the known-segfault provenance is recorded in the file itself", () => {
    expect(DOCKERFILE).toContain("bun.report/1.3.14");
    expect(DOCKERFILE).toContain("COMPLETES SUCCESSFULLY");
  });
});

describe("R77-B: the scan job frees the runner's disk before the image build", () => {
  test("a disk-prewash step precedes the build step", () => {
    const prewash = CI.indexOf("- name: Free disk space (before image build)");
    const build = CI.indexOf("- name: Build runtime images (app + worker)");
    expect(prewash, "prewash step exists").toBeGreaterThan(-1);
    expect(prewash < build, "prewash precedes the build").toBeTrue();
    // slice from the R77 comment above the step so the record rides along
    const step = CI.slice(CI.indexOf("# R77 (run 35423093770)"), build);
    expect(step).toContain("/usr/local/lib/android");
    expect(step).toContain("docker builder prune -af");
    expect(step).toContain("35423093770");
  });
});

describe("R77-C: the run record is frozen in the audit doc", () => {
  test("iteration-8 facts recorded (build completed, teardown segfault, 0 MB)", () => {
    expect(DOC).toContain("## 13. R77 ADDENDUM");
    expect(DOC).toContain("35423093770");
    expect(DOC).toContain("Free space left: 0 MB");
    expect(DOC).toContain("teardown");
  });

  test("PAT hygiene on the touched artifacts", () => {
    for (const [name, text] of [
      ["Dockerfile", DOCKERFILE],
      ["ci.yml", CI],
      ["doc", DOC],
    ] as const) {
      expect(text.includes("github_pat_"), name).toBeFalse();
      expect(text.includes("ghp_"), name).toBeFalse();
    }
  });
});
