/**
 * R78 — CI bring-up iteration 9: base-image OS vulns triaged (security
 * channel + fixable-only gate).
 *
 * Context (docs/audits/FayaNMS-R70-Merge-to-Main-and-CI-Bootstrap-2026-09-19.md §14):
 * run 35423693016 @ 819feb1 — gate/e2e/browser GREEN again, AND the image
 * build PASSED with the artifact verification (BUILD_ID + standalone proven;
 * the Bun teardown segfault survived only as the documented note). The
 * failure moved to the FIRST IMAGE-SCAN execution: 88 HIGH/CRITICAL
 * findings, ALL in the base's Debian packages (trixie), with fixes published
 * to the Debian security channel AFTER the base was built. The pinned
 * digest IS the current tag resolution (verified against the registry — no
 * bump exists), so the remediation is:
 *   - both runtime stages track the Debian security channel (apt-get
 *     upgrade; lists dropped) — every fixable finding is patched at build
 *     time; forward-compatible within the release (Debian security patches
 *     never break ABI, so the glibc/openssl consistency note holds);
 *   - the image scans gain `ignore-unfixed: true` — the gate stays fatal
 *     for every HIGH/CRITICAL WITH a published fix; a vulnerability with NO
 *     fix anywhere has no operator remediation path and is reported instead.
 *     The fs scan is untouched (narrowness). Widening requires a new note.
 *
 * These pins freeze the security-channel upgrades and the gate scope.
 * They never execute docker or a scanner.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../..");
const read = (p: string): string => readFileSync(join(REPO, p), "utf8");

const DOCKERFILE = read("Dockerfile");
const WORKER = read("Dockerfile.worker");
const CI = read(".github/workflows/ci.yml");
const DOC = read("docs/audits/FayaNMS-R70-Merge-to-Main-and-CI-Bootstrap-2026-09-19.md");

describe("R78-A: both runtime images track the Debian security channel", () => {
  test("the app runtime stage upgrades and drops the package lists", () => {
    const runtime = DOCKERFILE.slice(DOCKERFILE.indexOf("FROM oven/bun:1.3.14-slim"));
    expect(runtime).toContain("RUN apt-get update");
    expect(runtime).toContain("apt-get upgrade -y");
    expect(runtime).toContain("rm -rf /var/lib/apt/lists/*");
    expect(runtime).toContain("35423693016");
    // upgrade happens as root BEFORE the non-root user is set
    const aptAt = runtime.indexOf("RUN apt-get update");
    const userAt = runtime.indexOf("USER faya");
    expect(aptAt < userAt, "upgrade before USER faya").toBeTrue();
  });

  test("the worker runtime stage upgrades too (same base)", () => {
    expect(WORKER).toContain("RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*");
    expect(WORKER).toContain("35423693016");
    // the pinned digest is unchanged — the SDK/base binaries stay immutable
    expect(WORKER).toContain(
      "oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04"
    );
  });
});

describe("R78-B: the image-scan gate is scoped to fixable findings", () => {
  test("both image scans carry ignore-unfixed; the fs scan does not", () => {
    const appScan = CI.slice(
      CI.indexOf("- name: Image scan — app"),
      CI.indexOf("- name: Image scan — worker")
    );
    const workerScan = CI.slice(
      CI.indexOf("- name: Image scan — worker"),
      CI.indexOf("- name: Image SBOMs")
    );
    expect(appScan).toContain("ignore-unfixed: true");
    expect(workerScan).toContain("ignore-unfixed: true");
    expect(appScan).toContain("35423693016");
    expect(appScan).toContain("Widening requires a new");
    // the fs scan stays untouched
    const fsScan = CI.slice(
      CI.indexOf("- name: Container scan (trivy)"),
      CI.indexOf("- name: Container scan skipped")
    );
    expect(fsScan).not.toContain("ignore-unfixed");
  });
});

describe("R78-C: the run record is frozen in the audit doc", () => {
  test("iteration-10 facts recorded (artifact proof passed, 88 base findings)", () => {
    expect(DOC).toContain("## 14. R78 ADDENDUM");
    expect(DOC).toContain("35423693016");
    expect(DOC).toContain("88 HIGH/CRITICAL");
    expect(DOC).toContain("BUILD_ID");
    expect(DOC).toContain("current tag resolution");
  });

  test("PAT hygiene on the touched artifacts", () => {
    for (const [name, text] of [
      ["Dockerfile", DOCKERFILE],
      ["Dockerfile.worker", WORKER],
      ["ci.yml", CI],
      ["doc", DOC],
    ] as const) {
      expect(text.includes("github_pat_"), name).toBeFalse();
      expect(text.includes("ghp_"), name).toBeFalse();
    }
  });
});
