import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

/**
 * RT-034 (F-064) — the ci.yml GOVERNANCE STATUS header must state the
 * CURRENT truth, not the 2026-09-15 bring-up-era snapshot.
 *
 * The finding: the header still claimed "Branch protection: NOT ACTIVE.
 * Live API read-back 2026-09-15 …" although protection has been ACTIVE
 * since worklog Task 3 (2026-09-19: required checks gate/e2e/browser/scan,
 * strict, enforce_admins=false) — contradicting the current state and the
 * gov-verify contract (scripts/gov-verify.ts,
 * tests/audit/r66-gov-required-checks-shape.test.ts,
 * docs/runbooks/governance.md). Comment-only refresh: zero non-comment
 * diff in ci.yml (this RT does NOT touch A5-04's executable-contract
 * reconciliation).
 *
 * Pinned here:
 *   1. the header no longer claims protection is NOT ACTIVE — it states
 *      ACTIVE with the owner-application date and the gov-verify pointer;
 *   2. the header lists the four enforced required checks (and the
 *      r66 marker line survives verbatim — r66 test B pins it);
 *   3. workflow semantics untouched: the YAML with comment lines stripped
 *      must hash to the pinned snapshot below — any semantic edit must
 *      update that hash deliberately, never side-effect-of-a-comment.
 *
 * Deliberate hash moves (each recorded here, never silent):
 *   - 91902f72… → 9f761be2… (2026-10-01, F-068 round-trip, commit
 *     a7a4512): the browser job gained ONE automatic full-suite re-run
 *     after renderer-starvation flakes across runs
 *     36768543791..36779703553 burned the job four ways with no product
 *     bug underneath. Deterministic failures still fail both attempts,
 *     so the retry only absorbs environment wedges; no assertion,
 *     violation verdict, or journey step was weakened (see the a7a4512
 *     commit message for the full bounded-harness rationale).
 *   - 9f761be2… → 33ca4961… (2026-10-02, F-026 batch 9): the "Build
 *     runtime images (app + worker)" step dropped the
 *     `--build-arg NEXT_PUBLIC_SITE_URL=…` line — the origin is now the
 *     RUNTIME `SITE_URL` resolved per request by
 *     src/lib/brand/site-url.ts (root layout generateMetadata under
 *     force-dynamic), so the client bundles ship origin-free. The
 *     semantic delta is the build-arg removal ONLY; no job, step, gate,
 *     or scan assertion was added/removed/weakened.
 *   - 33ca4961… → 376b3736… (2026-10-03, CI-infra hotfix — semgrep
 *     registry drift): the SAST step swapped the archived
 *     returntocorp/semgrep-action@v1 wrapper (whose frozen
 *     semgrep-agent:v1 image embeds semgrep 1.36.0 — it crashes on the
 *     live p/default registry's `severity: MEDIUM` rules) for the
 *     official semgrep/semgrep image DIGEST-pinned (1.179.0 at pin
 *     time) run directly: `semgrep scan --config p/default --error
 *     --metrics=off`. The gate policy is unchanged (--error keeps any
 *     finding failing the build); the pre-planned A5-13/RT-035
 *     migration, forced by the upstream drift.
 *   - 376b3736… → 666f8c70… (2026-10-04, dependabot actions/checkout
 *     5.1.0 → 7.0.1, PR #15): the four `actions/checkout@` pin SHAs
 *     moved to the real v7.0.1 commit (3d3c42e…) with their trailing
 *     pin comments refreshed to name it (deliberate-pin governance).
 *     Zero semantic delta: same action, same inputs (fetch-depth: 0
 *     kept where present), no job/step/gate/scan change. The hash move
 *     is the SHA text + trailing comment text on those four lines
 *     (trailing comments are part of the stripped-YAML snapshot by
 *     design — the stripper removes whole-line comments only).
 *
 * Scope note: docs/deploy/WINDOWS-SERVER-DOCKER-DESKTOP.md still carries a
 * 2026-09-15-era "NOT active" line that p3-hardening pins; refreshing that
 * historical runbook section is NOT part of this RT (comment-only, ci.yml
 * scope).
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const CI = readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
const CI_LINES = CI.split("\n");

/**
 * Non-comment YAML of ci.yml, hashed before this RT touched the header.
 * Moved deliberately to 9f761be2… on 2026-10-01 (F-068): the browser job
 * gained one automatic full-suite retry — see the move log in the
 * docstring above. Moved again to 33ca4961… on 2026-10-02 (F-026, batch
 * 9): the image-build step dropped the NEXT_PUBLIC_SITE_URL build-arg
 * (runtime-only origin). Comment-only edits must never move this hash.
 * Moved to 666f8c70… on 2026-10-04 (PR #15): dependabot checkout
 * v5.1.0 → v7.0.1 pin-SHA refresh — see the move log in the docstring.
 */
const PRE_RT034_STIPPED_YAML_SHA256 =
  "666f8c70f861802639f7a3a3a887274839c4a01575281a6fd26c7e8acd204e0e";

const HEADER_BLOCK = CI_LINES.slice(0, 30).join("\n");

describe("RT-034: ci.yml governance header truth", () => {
  test("header no longer claims protection is NOT ACTIVE", () => {
    expect(CI).not.toContain("NOT ACTIVE");
    expect(HEADER_BLOCK).toMatch(/Branch protection:\s*ACTIVE \(owner-applied, worklog Task 3, 2026-09-19\)/);
    // The executable-contract pointer replaces the "until then, direct
    // pushes…" prose.
    expect(HEADER_BLOCK).toContain("bun scripts/gov-verify.ts");
    expect(HEADER_BLOCK).toContain("docs/runbooks/governance.md");
    // The self-flagging maintenance rule exists so the next drift is caught.
    expect(HEADER_BLOCK).toMatch(/MAINTENANCE RULE/);
    // The bring-up era stays as clearly-labeled HISTORY, not status.
    expect(HEADER_BLOCK).toMatch(/History \(NOT status\)/);
    expect(HEADER_BLOCK).toContain("runs #1–#6");
  });

  test("header lists the enforced required checks", () => {
    for (const check of ["gate", "e2e", "browser", "scan"]) {
      expect(HEADER_BLOCK).toContain(check);
    }
    // The R66 marker survives verbatim (tests/audit/r66 test B pins it).
    expect(CI).toContain("required-checks: gate, scan, e2e, browser");
    // The strict/no-admin-bypass facts from the applied protection.
    expect(HEADER_BLOCK).toContain("strict");
    expect(HEADER_BLOCK).toContain("enforce_admins=false");
  });

  test("workflow semantics untouched (comment-only diff vs pre-RT snapshot)", () => {
    const stripped = CI_LINES.filter((line) => !/^\s*#/.test(line)).join("\n");
    const hash = createHash("sha256").update(stripped).digest("hex");
    expect(
      hash,
      "ci.yml non-comment YAML changed — if the workflow semantics really " +
        "changed, update PRE_RT034_STIPPED_YAML_SHA256 deliberately; comment " +
        "edits alone must never move it"
    ).toBe(PRE_RT034_STIPPED_YAML_SHA256);
  });
});
