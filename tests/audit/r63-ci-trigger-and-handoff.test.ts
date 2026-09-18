import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

/**
 * R63 — process/hygiene fixes from the 2026-09-19 independent
 * re-verification (the parts that are authorable in-repo):
 *
 *   1. CI trigger: the workflow fires on push-to-main, pull_request, and
 *      (NEW) workflow_dispatch. Before R63 there was NO way to execute the
 *      4-job release gate on the z_ai_v2 integration branch — a push there
 *      runs nothing, and the old HC-6 step ("push a no-op docs commit")
 *      could never work. The manual dispatch + the candidate PR are the
 *      two corrected execution paths.
 *   2. The hand-off release notes carry an as-of snapshot marker and the
 *      corrected HC-6 ordering + the two Dependabot activation caveats
 *      (default-branch activation; separate update-job capacity).
 *
 * Pinned structurally here (YAML itself is parsed locally as a one-off
 * per the R57/R60 pattern; GitHub-side execution proves out with
 * OWNER-CI-001/HC-6).
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("R63: CI trigger + hand-off corrections", () => {
  const ci = readRepoFile(".github/workflows/ci.yml");

  test("the workflow declares push-to-main, pull_request AND workflow_dispatch", () => {
    const triggerIdx = ci.indexOf("\non:\n");
    expect(triggerIdx).toBeGreaterThan(0);
    const triggerBlock = ci.slice(triggerIdx, ci.indexOf("\njobs:", triggerIdx));
    expect(triggerBlock).toContain("push:");
    expect(triggerBlock).toContain("branches: [main]");
    expect(triggerBlock).toContain("pull_request:");
    expect(triggerBlock).toContain("workflow_dispatch:");
  });

  test("the trigger block contains no corrupted branch entries", () => {
    // The re-verification caught a historical corruption class in this
    // workflow ("the corrupted `branches:` trigger" era) — pin that the
    // TRIGGER BLOCK carries exactly one, well-formed branches entry.
    // (The file header's history comment mentions the old corruption —
    // that mention is legitimate and must not fail this pin.)
    const triggerBlock = ci.slice(ci.indexOf("\non:\n"), ci.indexOf("\njobs:"));
    expect(triggerBlock.match(/branches:/g)?.length).toBe(1);
    expect(triggerBlock).toContain("branches: [main]");
    expect(ci).not.toContain("branches: ain]");
  });

  test("the hand-off release notes document the corrected HC-6 execution path", () => {
    const handoff = readRepoFile("docs/audits/FayaNMS-Operator-Handoff-Release-Notes-2026-09-18.md");
    expect(handoff).toContain("workflow_dispatch");
    expect(handoff).toContain("CORRECTED ordering");
    expect(handoff).toContain("the config sits on `z_ai_v2`, NOT the");
    expect(handoff).toContain("DEFAULT branch");
    expect(handoff).toContain("GitHub-generated Actions jobs");
  });

  test("the roadmap HC-6 step no longer instructs a z_ai_v2 push", () => {
    const roadmap = readRepoFile(
      "docs/audits/FayaNMS-Production-Readiness-Implementation-Roadmap-2026-09-18.md",
    );
    expect(roadmap).toContain("workflow_dispatch");
    expect(roadmap).toContain("a push to `z_ai_v2` alone runs NOTHING");
    expect(roadmap).not.toContain("push a no-op docs commit");
  });
});
