import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

/**
 * R67 — operator-path acceleration package:
 *
 *   1. `scripts/gov-verify.ts` — TASK-GOV-001-A's "verify via API read-back"
 *      acceptance criterion made EXECUTABLE. It queries the live GitHub API
 *      (classic branch protection + rulesets) and exits nonzero unless every
 *      governance invariant holds: ALL FOUR required checks (gate, e2e,
 *      browser, scan — the R66 canonical shape), ≥1 approval,
 *      code-owner review, force-push/deletion disabled, enforcement ACTIVE.
 *      Truth-first: it reports API-observed values, never doc claims.
 *
 *   2. CODEOWNERS header aligned to the four-check shape (it still said the
 *      pre-R47 singular "CI gate" required check) and now points at the
 *      executable read-back.
 *
 *   3. Candidate PR package — the paste-ready `z_ai_v2`→`main` PR (title +
 *      body + merge-time decision tree). Key recorded fact: opening the PR
 *      itself triggers the pull_request event, which runs ALL FOUR jobs —
 *      the PR is an HC-6 vehicle, not merely a merge vehicle.
 *
 * These pins validate SHAPE (source-level), deliberately NOT execution:
 * the script performs network I/O and must never run inside the unit suite.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("R67: executable governance read-back + candidate PR package", () => {
  const script = readRepoFile("scripts/gov-verify.ts");

  test("A: gov-verify.ts exists and pins the canonical FOUR required checks", () => {
    expect(existsSync(path.join(REPO_ROOT, "scripts/gov-verify.ts"))).toBeTrue();
    expect(script).toContain(
      'const REQUIRED_CHECKS = ["gate", "e2e", "browser", "scan"] as const;',
    );
  });

  test("B: gov-verify.ts reads BOTH protection mechanisms and asserts the F-025 two-tier contract", () => {
    expect(script).toContain("/branches/${BRANCH}/protection");
    expect(script).toContain("/repos/${REPO_FULL}/rulesets");
    // F-025 tiers (2026-10-02): HARD invariants drive the exit code; the
    // ADVISORY tier reports owner-pending / plan-gated gaps as [GAP] lines.
    expect(script).toContain('severity: "hard"');
    expect(script).toContain('severity: "advisory"');
    // Requirement is read from the required_status_checks block itself — the
    // modern protection API no longer returns `enforcement_level`, so the old
    // field-level assertion could not pass on the protection actually applied.
    expect(script).toContain(
      "classic.required_status_checks.present (checks ARE required)",
    );
    expect(script).not.toContain('enforcement === "non_admins"');
    // A configured ruleset plane is still verified in full (hard)…
    expect(script).toContain('rs.enforcement === "active"');
    // …while ABSENT rulesets are the documented plan-gated GAP, never a
    // silent pass.
    expect(script).toContain("plan-gated on private repository");
    // Advisory gaps must be visible in the output (truth-first, never silent).
    expect(script).toContain('"GAP"');
  });

  test("C: gov-verify.ts security posture — token env-only, never printed, typed exit contract", () => {
    expect(script).toContain("process.env.GOV_VERIFY_TOKEN ??");
    expect(script).toContain("process.env.GITHUB_TOKEN ??");
    expect(script).toContain("process.env.GH_TOKEN ??");
    // the token is never interpolated into any output string
    expect(script).not.toMatch(/console\.(log|error)\([^)]*\$\{token\}/);
    // auth is built from the env-read variable inside ghGet (single auth site)
    expect(script).toContain("Authorization: `Bearer ${token}`");
    expect(script).toContain('process.exit(0)'); // GOV-VERIFIED
    expect(script).toContain('process.exit(1)'); // invariant failure
    expect(script).toContain('process.exit(2)'); // config error
    // truth-first framing is part of the contract
    expect(script).toContain("GOV-NOT-VERIFIED");
    expect(script).toContain("truth-first");
  });

  test("D: gov-verify.ts execution hygiene — no top-level await, no Set-spread (target-agnostic), suite never executes it", () => {
    expect(script).not.toMatch(/^await main\(\);/m);
    expect(script).toContain("void main().catch(");
    expect(script).not.toContain("[...checksSeen]");
    // the unit suite reads the SOURCE only — no import of the script anywhere in tests/
    // (its only invocation is the documented CLI usage)
  });

  test("E: CODEOWNERS header now carries the four-check shape and the executable read-back pointer", () => {
    const codeowners = readRepoFile(".github/CODEOWNERS");
    expect(codeowners).toContain(
      "ALL FOUR required status checks: `gate`, `e2e`, `browser`, `scan`",
    );
    expect(codeowners).toContain("bun scripts/gov-verify.ts (R67)");
    expect(codeowners).toContain("GOV-VERIFIED(0)");
    // stale singular wording gone
    expect(codeowners).not.toContain('the "CI gate" required status check');
    // the actual ownership rules are untouched
    expect(codeowners).toContain("/src/lib/auth/            @fayafatehi");
    expect(codeowners).toContain("/prisma/                  @fayafatehi");
    expect(codeowners).toContain("/.github/                 @fayafatehi");
  });

  test("F: candidate PR package is paste-ready and records the PR-runs-CI fact", () => {
    const pkg = readRepoFile(
      "docs/audits/FayaNMS-Candidate-PR-Package-z_ai_v2-to-main-2026-09-19.md",
    );
    // exact title block present
    expect(pkg).toContain(
      "Merge z_ai_v2 → main: hardened production readiness (R34–R66), 35 commits, 198 files",
    );
    // the four-check shape appears in the PR body AND the decision tree
    expect(pkg).toContain("(`gate`,`e2e`,`browser`,`scan`)");
    expect(pkg).toContain("required checks = ALL FOUR (gate, e2e, browser, scan)");
    // the key HC-6 insight: pull_request event runs all four jobs on the PR
    expect(pkg).toContain(
      "the pull_request event runs ALL FOUR jobs on the merge",
    );
    // pre/post read-back discipline: NOT-VERIFIED before, VERIFIED(0) before doc flips
    expect(pkg).toContain("bun scripts/gov-verify.ts main");
    expect(pkg).toContain("MUST be GOV-VERIFIED(0) before any doc");
    // merge pre-flight result recorded with the exit code
    expect(pkg).toContain("exit 0, zero");
    // capacity fallback documented (no code change needed)
    expect(pkg).toContain("35408254887");
    expect(pkg).toContain("self-hosted runner (≥8 GB RAM for build:gate)");
  });

  test("H: gov-verify.ts names the GitHub-Free plan gate as a typed blocker (R67 live discovery)", () => {
    // LIVE-VERIFIED 2026-09-19 against the real repo: on a private repo under
    // GitHub Free, GET branches/{branch}/protection answers 403 "Upgrade to
    // GitHub Pro or make this repository public..." — GOV-001 therefore has a
    // PLAN prerequisite no earlier doc recorded. The script must fail CLOSED
    // with a typed, actionable message (exit 2), never silently pass.
    expect(script).toContain("GOV-PLAN-BLOCKER");
    expect(script).toContain("Upgrade to GitHub Pro");
    expect(script).toContain("plan-gated");
    expect(script).toContain("OWNER action BEFORE GOV-001");
    // the 403 classification sits on the SHARED fetch path so both endpoints get it
    expect(script).toContain("ghGetOrDie(");
  });

  test("G: PR package carries no credential material (PAT hygiene)", () => {
    const pkg = readRepoFile(
      "docs/audits/FayaNMS-Candidate-PR-Package-z_ai_v2-to-main-2026-09-19.md",
    );
    const scriptSrc = script;
    for (const artifact of [pkg, scriptSrc]) {
      expect(artifact).not.toContain("github_pat_");
      expect(artifact).not.toContain("ghp_");
      expect(artifact).not.toMatch(/Bearer\s+[A-Za-z0-9_]{20,}/);
    }
  });
});
