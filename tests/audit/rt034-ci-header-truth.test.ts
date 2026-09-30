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
 *      must hash to the pre-RT-034 snapshot below — any semantic edit
 *      must update that hash deliberately, never side-effect-of-a-comment.
 *
 * Scope note: docs/deploy/WINDOWS-SERVER-DOCKER-DESKTOP.md still carries a
 * 2026-09-15-era "NOT active" line that p3-hardening pins; refreshing that
 * historical runbook section is NOT part of this RT (comment-only, ci.yml
 * scope).
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const CI = readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
const CI_LINES = CI.split("\n");

/** Non-comment YAML of ci.yml, hashed before this RT touched the header. */
const PRE_RT034_STIPPED_YAML_SHA256 =
  "91902f72b394a01aae9c56ccf762427bafa9a2137db4dbbc3f4cf7468108ce70";

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
