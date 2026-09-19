/**
 * R71 — CI bring-up iteration 2: the certify step's lab-hatch env.
 *
 * Context (docs/audits/FayaNMS-R70-Merge-to-Main-and-CI-Bootstrap-2026-09-19.md,
 * R71 addendum): with the DB bootstrap fixed (R70), the gate advanced to its
 * next never-executed step — "Live SSH adapter certification" — and run
 * 35415388173 failed there with
 *   certify driver crashed: TargetPolicyError: SSH_TARGET_POLICY_REFUSED:
 *   loopback — the target network policy refuses this address class before
 *   any credential or connection work.
 * The certification IS the loopback lab (it dials in-process 127.0.0.1
 * harnesses by design), and the R50 target-policy honors the documented
 * caller-provided hatch FAYANMS_PROBE_ALLOW_SPECIAL=true. The step never set
 * it because the driver had only ever run inside the sandbox shell that
 * exported the hatch. Fix: the ci.yml step now presents the hatch plus the
 * three R64 hermeticity knobs (explicit-empty service plane). CI-replica
 * re-execution with exactly that env: CERT RESULT: PASSED (134 checks,
 * 5 flavors, protocol level).
 *
 * These pins freeze the step env. They never execute the driver.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../..");
const CI = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8");
const DOC = readFileSync(
  join(REPO, "docs/audits/FayaNMS-R70-Merge-to-Main-and-CI-Bootstrap-2026-09-19.md"),
  "utf8",
);

describe("R71: the certify step presents the documented lab hatch + hermetic service plane", () => {
  const stepAt = CI.indexOf("- name: Live SSH adapter certification");
  const stepBlock = stepAt > -1 ? CI.slice(stepAt, CI.indexOf("- name: Brand asset validation", stepAt)) : "";

  test("the certify step exists exactly once and carries its env block", () => {
    expect(CI.split("- name: Live SSH adapter certification").length - 1).toBe(1);
    expect(stepBlock).toContain("env:");
  });

  test("the loopback lab hatch is presented by the step (R50 documented knob)", () => {
    expect(stepBlock).toContain('FAYANMS_PROBE_ALLOW_SPECIAL: "true"');
  });

  test("the R64 hermeticity knobs pin the in-process service plane", () => {
    expect(stepBlock).toContain('FAYANMS_SERVICE_PRIVATE_KEY: ""');
    expect(stepBlock).toContain('FAYANMS_SERVICE_PUBLIC_KEYS: ""');
    expect(stepBlock).toContain('FAYANMS_SERVICE_ENV_FILE: ""');
  });

  test("the run-35415388173 finding + replica proof are recorded", () => {
    expect(DOC).toContain("35415388173");
    expect(DOC).toContain("SSH_TARGET_POLICY_REFUSED");
    expect(DOC).toContain("CERT RESULT: PASSED");
  });

  test("PAT hygiene on the touched artifacts", () => {
    for (const [name, text] of [["ci.yml", CI], ["doc", DOC]] as const) {
      expect(text.includes("github_pat_"), name).toBeFalse();
      expect(text.includes("ghp_"), name).toBeFalse();
    }
  });
});
