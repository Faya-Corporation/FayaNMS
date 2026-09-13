import { describe, expect, test } from "bun:test";

import {
  ConcurrencyGuardError,
  DeviceWriteLockedError,
  DEVICE_LOCK_TTL_MS,
  ExecutionInFlightError,
  EXECUTION_LEASE_TTL_MS,
  StepClaimLostError,
  deviceLockExpiry,
  deviceLockRows,
  executionLeaseExpiry,
  isStepClaimWon,
  isUniqueConflict,
} from "../../src/lib/change/execution-guard";

/**
 * SAFE-003/004/005 (production-safety sprint) — execution concurrency
 * guards. The external ULTRA audit's P0-003: (a) POST /changes/[id]/execute
 * unconditionally queued a second CHANGE_EXECUTE job (duplicate device
 * mutations on retry/double-click); (b) the change engine picked the next
 * PENDING step with a plain find() and marked it RUNNING with a blind id
 * update — a genuine read→write TOCTOU under concurrency; (c) nothing
 * serialized two concurrent changes over the same device.
 *
 * The ENFORCEMENT is database-side (lease PK = changeId, conditional
 * updateMany rowcounts, DeviceWriteLock deviceId @unique) so it holds
 * across processes. This suite pins the pure half: the deterministic TTL
 * policies, the P2002 classifier the routes rely on to convert unique
 * violations into typed 409 sentinels, the sentinel→HTTP contract, the
 * lock-row builder the claim transaction persists, and the CAS rowcount
 * semantics (ONLY count === 1 wins).
 */
describe("SAFE-003/004/005 — execution concurrency guards", () => {
  /* ───────────────────────── TTL policies ───────────────────────── */

  test("lease TTL is 4h — far beyond the tick reaper's 15-min RUNNING reap", () => {
    expect(EXECUTION_LEASE_TTL_MS).toBe(4 * 60 * 60 * 1000);
  });

  test("device lock TTL is 3× the change engine's 5-min orphan threshold", () => {
    expect(DEVICE_LOCK_TTL_MS).toBe(15 * 60 * 1000);
  });

  test("expiry functions are deterministic offsets of the passed clock", () => {
    const now = new Date("2026-09-13T12:00:00.000Z");
    expect(executionLeaseExpiry(now).getTime()).toBe(now.getTime() + EXECUTION_LEASE_TTL_MS);
    expect(deviceLockExpiry(now).getTime()).toBe(now.getTime() + DEVICE_LOCK_TTL_MS);
    // Never mutate the caller's clock.
    const probe = new Date("2026-09-13T12:00:00.000Z");
    deviceLockExpiry(probe);
    executionLeaseExpiry(probe);
    expect(probe.getTime()).toBe(new Date("2026-09-13T12:00:00.000Z").getTime());
  });

  /* ────────────────── P2002 → sentinel classification ────────────────── */

  test("isUniqueConflict matches P2002 with the marker anywhere in meta.target", () => {
    const conflict = {
      code: "P2002",
      meta: { target: ["ChangeExecutionLease_changeId_key"] },
    };
    expect(isUniqueConflict(conflict, "ChangeExecutionLease")).toBe(true);
    expect(isUniqueConflict(conflict, "changeId_key")).toBe(true);
    expect(isUniqueConflict(conflict)).toBe(true); // any-P2002 form
  });

  test("isUniqueConflict rejects marker misses, other codes, and junk input", () => {
    const conflict = { code: "P2002", meta: { target: ["DeviceWriteLock_deviceId_key"] } };
    expect(isUniqueConflict(conflict, "ChangeExecutionLease")).toBe(false);
    expect(isUniqueConflict({ code: "P2025", meta: { target: ["x"] } }, "x")).toBe(false);
    expect(isUniqueConflict(new Error("unique failed"), "unique")).toBe(false);
    expect(isUniqueConflict(null)).toBe(false);
    expect(isUniqueConflict(undefined)).toBe(false);
    expect(isUniqueConflict("P2002")).toBe(false);
    expect(isUniqueConflict({ code: "P2002" })).toBe(true); // no marker → any P2002
    // A P2002 WITHOUT meta must not match a specific marker (fail closed —
    // the caller rethrows instead of misreporting a conflict it cannot see).
    expect(isUniqueConflict({ code: "P2002" }, "ChangeExecutionLease")).toBe(false);
  });

  /* ──────────────────── typed sentinel → HTTP contract ─────────────────── */

  test("all sentinels are 409 ConcurrencyGuardErrors with their audit-pinned codes", () => {
    const sentinels = [
      new ExecutionInFlightError("CHG-2026-00042"),
      new StepClaimLostError(3, "Apply configuration"),
      new DeviceWriteLockedError(),
    ];
    for (const sentinel of sentinels) {
      expect(sentinel).toBeInstanceOf(ConcurrencyGuardError);
      expect(sentinel.httpStatus).toBe(409);
      expect(sentinel.message.length).toBeGreaterThan(20);
    }
    expect(sentinels[0].code).toBe("EXECUTION_IN_FLIGHT");
    expect(sentinels[1].code).toBe("STEP_IN_FLIGHT"); // rides the driver's existing 409-retry path
    expect(sentinels[2].code).toBe("DEVICE_WRITE_LOCKED");
    expect((sentinels[0] as ExecutionInFlightError).message).toContain("CHG-2026-00042");
  });

  /* ───────────────────── device lock row construction ─────────────────── */

  test("deviceLockRows builds one TTL-stamped exclusive row per device, order-stable", () => {
    const now = new Date("2026-09-13T12:00:00.000Z");
    const rows = deviceLockRows(
      ["dev-c", "dev-a", "dev-b"],
      { changeId: "chg-1", jobId: "job-9", stepId: "step-3" },
      now
    );
    expect(rows.map((row) => row.deviceId)).toEqual(["dev-c", "dev-a", "dev-b"]);
    for (const row of rows) {
      expect(row.changeId).toBe("chg-1");
      expect(row.jobId).toBe("job-9");
      expect(row.stepId).toBe("step-3");
      expect(row.acquiredAt).toBe(now);
      expect(row.expiresAt.getTime()).toBe(now.getTime() + DEVICE_LOCK_TTL_MS);
    }
  });

  test("deviceLockRows on an empty scope is empty (no lock transaction noise)", () => {
    const now = new Date("2026-09-13T12:00:00.000Z");
    expect(
      deviceLockRows([], { changeId: "c", jobId: "j", stepId: "s" }, now)
    ).toEqual([]);
  });

  /* ─────────────────────── SAFE-004 CAS semantics ─────────────────────── */

  test("isStepClaimWon: ONLY exactly-one affected row wins the claim", () => {
    expect(isStepClaimWon(1)).toBe(true);
    expect(isStepClaimWon(0)).toBe(false); // someone else claimed first
    expect(isStepClaimWon(2)).toBe(false); // impossible for an id filter, refuse anyway
    expect(isStepClaimWon(-1)).toBe(false);
  });
});
