import { describe, expect, test } from "bun:test";

import {
  RESTORE_APPLIED_AUDIT_ACTION,
  RESTORE_COMMIT_MAX_BYTES,
  RESTORE_REFUSED_AUDIT_ACTION,
  RESTORE_TARGET_REFUSAL_PREFIX,
  buildRestoreValidateOutputs,
  classifyRestoreTarget,
  isRestoreCommitSizeOk,
  restoreCommitEchoOk,
  type RestoreTargetData,
} from "../../src/lib/change/restore-op";
import { LIVE_RESTORE_NOT_CERTIFIED } from "../../src/lib/change/live-plan";

/**
 * SAFE-008/009 — typed snapshot-exact restore (pure half). The external
 * ULTRA audit's P0-004: an approved "restore to snapshot vN" ran the generic
 * description-marker plan because the engine never consumed the selected
 * snapshot. SAFE-008 makes the approved target a machine-readable column
 * (ChangeRequest.restoreSnapshotId) the engine resolves BEFORE any device
 * contact; every unresolvable/tampered case is a typed fail-closed refusal.
 * SAFE-009 asserts the committed configuration equals the approved snapshot
 * byte-exact (sha256 commit echo).
 *
 * These pins hold the DECISION contract; the engine wiring (refusals, echo
 * gate, validation) and the worker's pre-commit digest gate are exercised
 * live (sandbox E2E + per-flavor certification), mirroring the
 * apply-disposition/execution-guard split.
 */

const TARGET: RestoreTargetData = {
  id: "snap-1",
  deviceId: "dev-1",
  version: 7,
  sha256: "a".repeat(64),
  rawText: "interface GigabitEthernet0/1\n description restored\n",
};

function verdictOk(input: {
  restoreSnapshotId?: string | null;
  target?: RestoreTargetData | null;
  rawTextPresent?: boolean;
  changeDeviceIds?: string[];
}) {
  return classifyRestoreTarget({
    // "in" guard: an explicitly-passed null/"" must reach the classifier
    // verbatim (the ??-default only fills an OMITTED field).
    restoreSnapshotId:
      "restoreSnapshotId" in input ? (input.restoreSnapshotId ?? null) : "snap-1",
    target: input.target === undefined ? TARGET : input.target,
    rawTextPresent: input.rawTextPresent ?? true,
    changeDeviceIds: input.changeDeviceIds ?? ["dev-1"],
  });
}

describe("SAFE-008 — restore target resolution (classifyRestoreTarget)", () => {
  test("in-scope, digest-verified target resolves ok with its data", () => {
    const verdict = verdictOk({});
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.target).toEqual(TARGET);
    }
  });

  test("unset target (null column) refuses — never guess a substitute", () => {
    for (const id of [null, undefined, ""]) {
      const verdict = verdictOk({ restoreSnapshotId: id });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe("RESTORE_TARGET_UNSET");
    }
  });

  test("deleted target row refuses (SetNull → NOT_FOUND)", () => {
    const verdict = verdictOk({ target: null });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("RESTORE_TARGET_NOT_FOUND");
  });

  test("digest-verification failure refuses — unverified bytes push nowhere", () => {
    const verdict = verdictOk({ rawTextPresent: false });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("RESTORE_TARGET_INTEGRITY");
  });

  test("cross-device target refuses — no restore outside the change scope", () => {
    const verdict = verdictOk({ changeDeviceIds: ["dev-other"] });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("RESTORE_TARGET_CROSS_DEVICE");
  });

  test("every refusal is typed AND greppable (shared prefix in the message)", () => {
    const refusals = [
      verdictOk({ restoreSnapshotId: null }),
      verdictOk({ target: null }),
      verdictOk({ rawTextPresent: false }),
      verdictOk({ changeDeviceIds: ["dev-other"] }),
    ];
    for (const verdict of refusals) {
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.message).toContain(RESTORE_TARGET_REFUSAL_PREFIX);
        expect(verdict.message.length).toBeGreaterThan(RESTORE_TARGET_REFUSAL_PREFIX.length);
      }
    }
  });
});

describe("SAFE-009 — commit-echo integrity (restoreCommitEchoOk)", () => {
  const sha = "b".repeat(64);

  test("exact sha equality is the ONLY pass", () => {
    expect(restoreCommitEchoOk(sha, sha)).toBe(true);
    expect(restoreCommitEchoOk("c".repeat(64), sha)).toBe(false);
  });

  test("a missing committed sha never matches (fail-closed)", () => {
    expect(restoreCommitEchoOk(null, sha)).toBe(false);
    expect(restoreCommitEchoOk(undefined, sha)).toBe(false);
    expect(restoreCommitEchoOk("", sha)).toBe(false);
  });

  test("canonical lowercase comparison — no silent normalization", () => {
    expect(restoreCommitEchoOk(sha.toUpperCase(), sha)).toBe(false);
  });
});

describe("SAFE-008 — commit size bound", () => {
  test("bound is 256 KiB", () => {
    expect(RESTORE_COMMIT_MAX_BYTES).toBe(262_144);
  });

  test("at/under the bound passes, over it fails (byte-measured)", () => {
    expect(isRestoreCommitSizeOk("x".repeat(RESTORE_COMMIT_MAX_BYTES))).toBe(true);
    expect(isRestoreCommitSizeOk("x".repeat(RESTORE_COMMIT_MAX_BYTES + 1))).toBe(false);
    expect(isRestoreCommitSizeOk("")).toBe(true); // emptiness is the caller's check
  });

  test("multibyte text is measured in BYTES, not characters", () => {
    // "é" is 2 bytes in UTF-8: half the chars, exactly the bound in bytes.
    const twoByteChar = "\u00e9";
    expect(isRestoreCommitSizeOk(twoByteChar.repeat(RESTORE_COMMIT_MAX_BYTES / 2))).toBe(true);
    expect(isRestoreCommitSizeOk(twoByteChar.repeat(RESTORE_COMMIT_MAX_BYTES / 2 + 1))).toBe(false);
  });
});

describe("SAFE-008/009 — audit action names", () => {
  test("RESTORE_APPLIED / RESTORE_REFUSED are the pinned audit verbs", () => {
    expect(RESTORE_APPLIED_AUDIT_ACTION).toBe("RESTORE_APPLIED");
    expect(RESTORE_REFUSED_AUDIT_ACTION).toBe("RESTORE_REFUSED");
  });
});

describe("SAFE-009 — validation output builder (buildRestoreValidateOutputs)", () => {
  const sha = "d".repeat(64);

  test("matching echo yields a truthful byte-exact line per device", () => {
    const lines = buildRestoreValidateOutputs([
      { hostname: "HQ-Core-RTR-01", committedSha: sha, targetSha: sha },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("HQ-Core-RTR-01");
    expect(lines[0]).toContain("byte-exact");
    expect(lines[0]).not.toContain("MISMATCH");
  });

  test("mismatch (or missing echo) names the device and both digests", () => {
    const lines = buildRestoreValidateOutputs([
      { hostname: "HQ-Core-RTR-01", committedSha: "e".repeat(64), targetSha: sha },
      { hostname: "HQ-Access-SW-01", committedSha: null, targetSha: sha },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("MISMATCH");
    expect(lines[0]).toContain("HQ-Core-RTR-01");
    expect(lines[1]).toContain("HQ-Access-SW-01");
    expect(lines[1]).toContain("none"); // missing echo is surfaced, never faked
  });

  test("rows stay 1:1 and in input order", () => {
    const rows = [
      { hostname: "a", committedSha: sha, targetSha: sha },
      { hostname: "b", committedSha: sha, targetSha: sha },
      { hostname: "c", committedSha: null, targetSha: sha },
    ];
    const lines = buildRestoreValidateOutputs(rows);
    expect(lines).toHaveLength(3);
    expect(lines[0].startsWith("a ")).toBe(true);
    expect(lines[1].startsWith("b ")).toBe(true);
    expect(lines[2].startsWith("c ")).toBe(true);
  });
});

describe("SAFE-007/008 — live boundary wording stays truthful", () => {
  test("refusal names the guard, the SAFE IDs, the no-contact invariant — and the new truth", () => {
    // The original SAFE-007 pins (tests/audit/live-restore-guard.test.ts)
    // still hold; SAFE-008 adds the simulator-plane truth to the wording.
    expect(LIVE_RESTORE_NOT_CERTIFIED).toContain("LIVE_RESTORE_NOT_CERTIFIED");
    expect(LIVE_RESTORE_NOT_CERTIFIED).toContain("SAFE-008/009");
    expect(LIVE_RESTORE_NOT_CERTIFIED).toContain("no device was contacted");
    expect(LIVE_RESTORE_NOT_CERTIFIED).toContain("simulator plane");
    expect(LIVE_RESTORE_NOT_CERTIFIED).toContain("deltas");
  });
});
