/**
 * R79 — HC-6 ACCEPTED: the first full four-job green run in repo history.
 *
 * Context (docs/audits/FayaNMS-R70-Merge-to-Main-and-CI-Bootstrap-2026-09-19.md §15):
 * run 35424363304 @ cf258cd (2026-09-19) — SUCCESS across ALL FOUR jobs:
 * gate (every step, 3m21s), e2e (real-topology journeys), browser (12/12
 * rendering-layer journeys), scan (gitleaks, semgrep, osv ×2, SBOM, trivy
 * fs, BOTH artifact-verified image builds, BOTH security-channel-upgraded
 * image scans, per-image SBOMs — 7m58s). This closes the nine-iteration CI
 * bring-up (R70–R78) and the roadmap's authorable Phase HC: HC-6 is the
 * last item and it rode OWNER-CI-001's runner capacity, lifted in R70.
 * The README badge/prose now carry the green truth with the run id.
 *
 * These pins freeze the acceptance record. They never execute CI.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../..");
const read = (p: string): string => readFileSync(join(REPO, p), "utf8");

const README = read("README.md");
const DOC = read("docs/audits/FayaNMS-R70-Merge-to-Main-and-CI-Bootstrap-2026-09-19.md");

describe("R79: the README carries the green truth (badge + prose)", () => {
  test("the CI badge alt records the four-job green acceptance with the run id", () => {
    expect(README).toContain("35424363304");
    expect(README).toContain("ALL GREEN on main");
    expect(README).toContain("HC-6 accepted");
    // the stale pre-capacity claim is gone
    expect(README).not.toContain("the badge turns live at the protective merge");
  });

  test("the limitations section names all four green jobs incl. the image plane", () => {
    expect(README).toContain("all four jobs (`gate`, `e2e`, `browser`, `scan`) GREEN on `main`");
    expect(README).toContain("image builds + image scans + SBOMs");
    expect(README).not.toContain("green `gate` + `scan` runs on `main`");
  });
});

describe("R79: the acceptance record is frozen in the audit doc", () => {
  test("HC-6 milestone with the run table and the nine-iteration journey", () => {
    expect(DOC).toContain("## 15. R79");
    expect(DOC).toContain("HC-6 ACCEPTED");
    expect(DOC).toContain("35424363304");
    expect(DOC).toContain("nine-iteration");
    expect(DOC).toContain("GOV-PLAN-BLOCKER");
  });

  test("PAT hygiene on the touched artifacts", () => {
    for (const [name, text] of [
      ["README", README],
      ["doc", DOC],
    ] as const) {
      expect(text.includes("github_pat_"), name).toBeFalse();
      expect(text.includes("ghp_"), name).toBeFalse();
    }
  });
});
