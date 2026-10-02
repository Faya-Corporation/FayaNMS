import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

/**
 * R66 — governance required-checks SHAPE unification.
 *
 * Defect: ci.yml has FOUR jobs (gate, e2e, browser, scan — added across
 * R45/R47) and its own header pins the `required-checks: gate, scan, e2e,
 * browser` marker, but SEVEN operation-facing documents still carried
 * stale 2-check (`gate`+`scan`, pre-R47 wording) or 3-check
 * (`gate`+`scan`+`e2e`, pre-R47 wording) configurations. An operator
 * following any of them would have protected `main` with FEWER required
 * checks than the workflow actually runs — e2e/browser failures could
 * then MERGE. That is a governance under-protection defect, not a typo:
 * the required-checks set is the enforcement boundary of the release.
 *
 * Canonical shape pinned here: exactly {gate, e2e, browser, scan} —
 * matching (a) the ci.yml job graph, (b) the ci.yml header marker,
 * (c) the R47 browser-e2e governance pin.
 *
 * Historical audit snapshots are point-in-time records and are NOT
 * rewritten (truth-first applies forward, not retroactively); every
 * operation-facing surface now carries the four-check shape.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

const FOUR = ["gate", "e2e", "browser", "scan"] as const;

describe("R66: required-checks shape unification (4 jobs)", () => {
  const ci = readRepoFile(".github/workflows/ci.yml");

  test("A: ci.yml defines EXACTLY the four jobs gate/e2e/browser/scan (job id = check name, no name: override)", () => {
    const jobsIdx = ci.indexOf("\njobs:");
    expect(jobsIdx).toBeGreaterThan(0);
    const jobsBlock = ci.slice(jobsIdx);
    // top-level job ids = lines inside the jobs: block indented exactly 2 spaces ending with ':'
    // (note: "e2e" contains a digit — the class must include 0-9)
    const jobIds = [...jobsBlock.matchAll(/^  ([a-z][a-z0-9-]*):\s*$/gm)].map(
      (m) => m[1],
    );
    expect(jobIds.sort()).toEqual([...FOUR].sort());
    // no display-name override: GitHub check-run names must equal the job ids
    // (a `name:` at 4-space indent right under a job id would change the check name)
    for (const id of FOUR) {
      const jobStart = jobsBlock.indexOf(`\n  ${id}:\n`);
      expect(jobStart).toBeGreaterThan(-1);
      const nextJobOrEnd = jobsBlock.slice(jobStart + 1).search(/^  [a-z][a-z0-9-]*:\s*$/m);
      const jobBody = jobsBlock.slice(
        jobStart,
        nextJobOrEnd === -1 ? undefined : jobStart + 1 + nextJobOrEnd,
      );
      expect(jobBody).not.toMatch(/^    name:/m);
    }
  });

  test("B: ci.yml header marker still pins all four checks (R47 marker intact)", () => {
    expect(ci).toContain("required-checks: gate, scan, e2e, browser");
  });

  test("C: TASK-GOV-001-A (the authoritative ruleset definition) requires all FOUR checks", () => {
    const nextTasks = readRepoFile("docs/audits/FayaNMS-NEXT-TASKS.md");
    const govIdx = nextTasks.indexOf("TASK-GOV-001-A — Restore branch protection");
    expect(govIdx).toBeGreaterThan(-1);
    const govBlock = nextTasks.slice(govIdx, govIdx + 900);
    expect(govBlock).toContain("required `gate`+`e2e`+`browser`+`scan`");
    // the stale 2-check goal wording must be gone from the GOAL line
    expect(govBlock).not.toContain("with required `gate`+`scan`;");
  });

  test("D: every operation-facing config surface carries the four-check shape", () => {
    // ci-gate.yml (CI governance doc)
    const ciGateDoc = readRepoFile("docs/ci/ci-gate.yml");
    expect(ciGateDoc).toContain("(`gate`, `e2e`, `browser`,\n   `scan` — all FOUR jobs)");

    // certification MATRIX GOV-001-A row
    const matrix = readRepoFile("docs/certification/MATRIX.md");
    expect(matrix).toContain("required checks `gate`+`e2e`+`browser`+`scan` (all FOUR ci.yml jobs");
    expect(matrix).not.toContain("`gate`+`scan`+`e2e`");

    // deploy note 4 (Windows Server runbook)
    const win = readRepoFile("docs/deploy/WINDOWS-SERVER-DOCKER-DESKTOP.md");
    expect(win).toContain("`gate`+`e2e`+`browser`+`scan` jobs run on every push");
    expect(win).toContain("all FOUR\n   (gate+e2e+browser+scan) required");
    expect(win).not.toContain("`gate`+`scan`+`e2e`");

    // FINAL production gate owner checklist
    const finalGate = readRepoFile("docs/audits/FayaNMS-FINAL-Production-Gate-2026-09-15.md");
    expect(finalGate).toContain("required checks `gate` + `e2e` + `browser` + `scan` (all FOUR ci.yml jobs");
    expect(finalGate).toContain("4-job battery (`gate`+`e2e`+`browser`+`scan`)");

    // operator hand-off step 2 — all four configured NOW (the deferred-checks
    // wording replaced; the correction note itself QUOTES the old wording)
    const handoff = readRepoFile(
      "docs/audits/FayaNMS-Operator-Handoff-Release-Notes-2026-09-18.md",
    );
    expect(handoff).toContain("(`gate`, `e2e`, `browser`, `scan` — all FOUR jobs");
    expect(handoff).not.toContain("`scan` — and `e2e`, `browser` once runners exist");
  });

  test("E: SOCIAL-REPOSITORY historical record keeps its point-in-time fact AND the R66 correction note", () => {
    const social = readRepoFile("docs/brand/SOCIAL-REPOSITORY.md");
    // historical fact retained (R9 era had two jobs)
    expect(social).toContain("both jobs `gate` and `scan` concluded `success`");
    // correction note present with the canonical four
    expect(social).toContain("R66 correction: at R9 time the workflow had only `gate`+`scan`");
    expect(social).toContain("`gate`, `e2e`,\n   `browser`, `scan`");
  });

  test("F: roadmap go-live definition and owner item name the four checks explicitly", () => {
    const roadmap = readRepoFile(
      "docs/audits/FayaNMS-Production-Readiness-Implementation-Roadmap-2026-09-18.md",
    );
    expect(roadmap).toContain(
      "the 4 required checks `gate`+`e2e`+`browser`+`scan`",
    );
    expect(roadmap).toContain(
      "the 4 required checks (`gate`, `e2e`, `browser`, `scan`)",
    );
  });

  test("G: governance runbook required-checks line = the four-check shape (F-025: ARM64 not required while container.yml is disabled)", () => {
    // F-025 (2026-10-02): the runbook listed "…browser, scan, and the ARM64
    // certification workflow" as required while container.yml is
    // disabled_manually — a required context that cannot exist. The narrowed
    // runbook carries exactly the FOUR ci.yml jobs and documents the
    // deliberate re-enable path (with RT-017) instead of a silent drop.
    const gov = readRepoFile("docs/runbooks/governance.md");
    expect(gov).toContain(
      "required status checks: gate, e2e, browser, scan",
    );
    // the stale fifth context is gone from the required set
    expect(gov).not.toContain(
      "browser, scan, and the ARM64 certification workflow",
    );
    // the re-enable path is documented, not silently dropped
    expect(gov).toContain("container.yml");
    expect(gov).toContain("RT-017");
    // the F-025 honesty rule: owner-pending controls are reported as [GAP],
    // never claimed enforced
    expect(gov).toContain("[GAP]");
  });
});
