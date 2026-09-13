import { describe, expect, test } from "bun:test";

import {
  ConcurrencyGuardError,
  DeviceWriteLockedError,
  ExecutionInFlightError,
  StepClaimLostError,
  isUniqueConflict,
} from "../../src/lib/change/execution-guard";
import {
  ROLLBACK_STEP_TEMPLATES,
  isPostRollbackValidateContext,
  isRollbackRestoreTarget,
  shouldReuseRestoredSnapshot,
} from "../../src/lib/change/apply-disposition";
import {
  HOSTKEY_FINGERPRINT_RE,
  HostKeyPolicyError,
  parseHostKeyPin,
} from "../../mini-services/worker/adapter-router";
import {
  computeHostKeyFingerprint,
  parseHostKeyType,
} from "../../mini-services/worker/ssh-transport";

/**
 * TEST-001/002/003 (production-safety sprint) — the change-engine safety
 * CONTRACT in one place. The per-fix suites already pin each mechanism
 * (tests/audit/execution-guard.test.ts → SAFE-003/004/005 concurrency,
 * tests/audit/live-restore-guard.test.ts + apply-failfast.test.ts → SAFE-006/
 * 007 restore/fail-fast pipeline, tests/audit/ssh-hostkey-guard.test.ts →
 * SAFE-001 host-trust, certify.ts → protocol-level per-flavor proofs).
 * This suite pins the CROSS-CUTTING invariants any future refactor must
 * keep, closing audit remediation order item 6:
 *
 *   TEST-001 (concurrency)  — the sentinel→409 semantics the worker driver
 *                             relies on: which guards are requeue-resumable.
 *   TEST-002 (restore)      — the appended rollback plan order, the rollback
 *                             retry-idempotency decision, and the composed
 *                             "SKIPPED ⇒ never restored, never re-asserted"
 *                             rule.
 *   TEST-003 (host-trust)   — the enrollment↔transport format identity: the
 *                             fingerprint the engine pins is EXACTLY the
 *                             fingerprint the worker transport verifies.
 */
describe("TEST-001/002/003 — change-engine safety contract", () => {
  /* ────────────── TEST-001: concurrency guard semantics ────────────── */

  test("driver-visible guard 409s are requeue-resumable; the operator-facing one is machine-deadly", () => {
    // The worker driver treats ANY error from /worker/change-step as
    // retryable (requeue + backoff) — which is only SAFE if the guards it
    // can hit are exactly the resumable ones. STEP_IN_FLIGHT (lost CAS
    // claim) and DEVICE_WRITE_LOCKED (another change owns a device) answer
    // the DRIVER and must stay resumable; EXECUTION_IN_FLIGHT answers the
    // OPERATOR on the execute route (a human decision, never auto-retried).
    const stepClaimLost = new StepClaimLostError(3, "Apply changes");
    const deviceLocked = new DeviceWriteLockedError();
    const executionInFlight = new ExecutionInFlightError("CHG-2026-00001");

    for (const guard of [stepClaimLost, deviceLocked, executionInFlight]) {
      expect(guard).toBeInstanceOf(ConcurrencyGuardError);
      expect((guard as ConcurrencyGuardError).httpStatus).toBe(409);
    }
    expect(stepClaimLost.code).toBe("STEP_IN_FLIGHT");
    expect(deviceLocked.code).toBe("DEVICE_WRITE_LOCKED");
    expect(executionInFlight.code).toBe("EXECUTION_IN_FLIGHT");
    // The resumable set is exactly the two driver-visible codes.
    const driverResumable = new Set(["STEP_IN_FLIGHT", "DEVICE_WRITE_LOCKED"]);
    expect(driverResumable.has(stepClaimLost.code)).toBe(true);
    expect(driverResumable.has(deviceLocked.code)).toBe(true);
    expect(driverResumable.has(executionInFlight.code)).toBe(false);
  });

  test("the DB enforcement markers classify as unique conflicts (lease + device lock)", () => {
    const leaseConflict = {
      code: "P2002",
      meta: { target: ["ChangeExecutionLease_changeId_key"] },
    };
    const lockConflict = {
      code: "P2002",
      meta: { target: ["DeviceWriteLock_deviceId_key"] },
    };
    expect(isUniqueConflict(leaseConflict, "ChangeExecutionLease_changeId_key")).toBe(true);
    expect(isUniqueConflict(lockConflict, "DeviceWriteLock_deviceId_key")).toBe(true);
    // Cross-marked rows must NOT match (a lease fight is not a lock fight).
    expect(isUniqueConflict(leaseConflict, "DeviceWriteLock_deviceId_key")).toBe(false);
    expect(isUniqueConflict(lockConflict, "ChangeExecutionLease_changeId_key")).toBe(false);
  });

  /* ─────────────────── TEST-002: restore/rollback contract ─────────────────── */

  test("the appended rollback plan is exactly ROLLBACK → VALIDATE → BACKUP, in order", () => {
    expect(ROLLBACK_STEP_TEMPLATES.map((t) => t.type)).toEqual([
      "ROLLBACK",
      "VALIDATE",
      "BACKUP",
    ]);
    expect(ROLLBACK_STEP_TEMPLATES.map((t) => t.name)).toEqual([
      "Restore pre-change configuration",
      "Post-rollback validation",
      "Post-rollback backup",
    ]);
  });

  test("rollback retry idempotency: reuse ONLY on an exact sha match", () => {
    const restored = "hostname restored-router\n!";
    const sha = new Bun.CryptoHasher("sha256").update(restored).digest("hex");
    // Exact match → the device is provably in the restored state → reuse.
    expect(shouldReuseRestoredSnapshot({ sha256: sha }, sha)).toBe(true);
    // Different content → mint a fresh snapshot (audit trail stays real).
    expect(shouldReuseRestoredSnapshot({ sha256: "deadbeef" }, sha)).toBe(false);
    // No existing row → mint.
    expect(shouldReuseRestoredSnapshot(null, sha)).toBe(false);
    expect(shouldReuseRestoredSnapshot(undefined, sha)).toBe(false);
  });

  test("composed SKIPPED rule: a provably-uncontacted device is never restored and never re-asserted", () => {
    // The restore gate and the post-rollback validation gate must agree on
    // SKIPPED: the device the failed apply never contacted is excluded from
    // BOTH — no restore write, no post-rollback contact, no marker assertion.
    for (const result of ["SKIPPED", null, "SUCCESS", "FAILED"] as const) {
      const restoreTarget = isRollbackRestoreTarget(result);
      const needsPostRollbackAssertion = result !== "SKIPPED";
      expect(restoreTarget).toBe(needsPostRollbackAssertion);
    }
    // And the post-rollback context is exactly status ROLLBACK (the appended
    // VALIDATE), so a healthy run's VALIDATE keeps the marker-present rule.
    expect(isPostRollbackValidateContext("ROLLBACK")).toBe(true);
    expect(isPostRollbackValidateContext("EXECUTING")).toBe(false);
  });

  /* ───────────────── TEST-003: host-trust format identity ──────────────── */

  /**
   * Build a synthetic SSH wire-format public key blob: the first field is a
   * length-prefixed string (the key algorithm name), followed by filler.
   */
  function wireBlob(keyType: string, fillerLength = 32): Buffer {
    const typeBytes = Buffer.from(keyType, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(typeBytes.length, 0);
    return Buffer.concat([length, typeBytes, Buffer.alloc(fillerLength, 0xab)]);
  }

  test("enrollment↔transport identity: the derived fingerprint IS the pin the transport verifies", () => {
    for (const keyType of ["ssh-ed25519", "rsa-sha2-512", "ecdsa-sha2-nistp256"]) {
      const blob = wireBlob(keyType);
      const fingerprint = computeHostKeyFingerprint(blob);
      // The derived value is canonical OpenSSH SHA256 form...
      expect(HOSTKEY_FINGERPRINT_RE.test(fingerprint)).toBe(true);
      // ...accepted verbatim by the worker's pin parser...
      expect(parseHostKeyPin({ fingerprint })).toBe(fingerprint);
      // ...and the key type captured alongside it reads the same blob.
      expect(parseHostKeyType(blob)).toBe(keyType);
    }
  });

  test("distinct keys derive distinct fingerprints (no cross-device pin collisions in format)", () => {
    const a = computeHostKeyFingerprint(wireBlob("ssh-ed25519", 32));
    const b = computeHostKeyFingerprint(wireBlob("ssh-ed25519", 33));
    expect(a).not.toBe(b);
  });

  test("a tampered or malformed pin still fails CLOSED (never degrades to unpinned)", () => {
    const fingerprint = computeHostKeyFingerprint(wireBlob("ssh-ed25519"));
    expect(() => parseHostKeyPin({ fingerprint: fingerprint.slice(0, 20) })).toThrow(
      HostKeyPolicyError
    );
    expect(() => parseHostKeyPin("SHA256:not-an-object")).toThrow(HostKeyPolicyError);
    expect(() => parseHostKeyPin({})).toThrow(HostKeyPolicyError);
    // Absent stays null = "refuse live connections" upstream, not "skip pin".
    expect(parseHostKeyPin(null)).toBeNull();
    expect(parseHostKeyPin(undefined)).toBeNull();
  });
});
