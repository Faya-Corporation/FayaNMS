/**
 * SAFE-003/004/005 — execution concurrency guards (production-safety sprint).
 *
 * Pure, dependency-free decision helpers shared by:
 *   - src/app/api/v1/changes/[id]/execute/route.ts   (SAFE-003 lease acquire)
 *   - src/app/api/v1/worker/change-step/route.ts      (SAFE-004 CAS claim +
 *                                                       SAFE-005 device locks)
 *   - src/app/api/v1/worker/complete/route.ts         (lease release)
 *   - src/app/api/v1/jobs/[id]/cancel/route.ts        (lease release)
 *   - src/app/api/v1/worker/tick/route.ts             (lease release on reap)
 *
 * The ENFORCEMENT lives in the database (unique constraints + conditional
 * updateMany rowcounts), never in memory: two app processes racing for the
 * same change/step/device are serialized by PostgreSQL, not by a mutex.
 * This module carries the typed sentinels the routes map to 409 responses,
 * the TTL policies, and the conflict classifier — all deterministic and
 * unit-pinned in tests/audit/execution-guard.test.ts.
 */

/* ───────────────────────────── TTL policies ───────────────────────────── */

/**
 * Execution lease TTL (SAFE-003 crash valve). A lease normally lives until
 * its job reaches a terminal state; this bounds the damage of a lease whose
 * job could never terminate (scheduler dead + worker dead + stuck row).
 * Generous by design — well beyond any reaper threshold the tick can apply
 * (a CHANGE_EXECUTE job's threshold derives from its own claim-time budget
 * per F-044; the largest 40-step case stays under 1.5 h) — so it can only
 * ever fire long after the execution itself is impossible.
 */
export const EXECUTION_LEASE_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * Device write-lock TTL (SAFE-005 crash valve). Locks are released when the
 * step reaches a terminal state (executor return / catch / orphan reap);
 * this bounds a lock stranded by a mid-step process death. 3× the change
 * engine's 5-min orphan threshold: an orphaned step is reaped (and its
 * locks deleted) long before this can fire.
 */
export const DEVICE_LOCK_TTL_MS = 15 * 60 * 1000;

/** Lease expiry for a change execution acquired at `now`. */
export function executionLeaseExpiry(now: Date): Date {
  return new Date(now.getTime() + EXECUTION_LEASE_TTL_MS);
}

/** Lock expiry for a device write lock acquired at `now`. */
export function deviceLockExpiry(now: Date): Date {
  return new Date(now.getTime() + DEVICE_LOCK_TTL_MS);
}

/* ─────────────────────── conflict classification ──────────────────────── */

/**
 * Duck-typed Prisma unique-violation check (same shape as the audit-chain
 * conflict detector in src/lib/db.ts): P2002 with the marker anywhere in
 * `meta.target`. Works inside and outside transactions; never throws.
 * `marker` may be omitted to match any P2002.
 */
export function isUniqueConflict(error: unknown, marker?: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  if ((error as { code?: unknown }).code !== "P2002") {
    return false;
  }
  if (marker === undefined) return true;
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  return JSON.stringify(target ?? "").includes(marker);
}

/* ──────────────────────────── typed sentinels ─────────────────────────── */

/** Base for the concurrency sentinels — carries the HTTP mapping. */
export class ConcurrencyGuardError extends Error {
  readonly code: string;
  readonly httpStatus = 409;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ConcurrencyGuardError";
    this.code = code;
  }
}

/**
 * SAFE-003 — the change already has an active execution (lease held by a
 * QUEUED/RUNNING CHANGE_EXECUTE job). The route answers 409
 * EXECUTION_IN_FLIGHT with the holding job's identity.
 */
export class ExecutionInFlightError extends ConcurrencyGuardError {
  constructor(changeNumber: string) {
    super(
      "EXECUTION_IN_FLIGHT",
      `${changeNumber} already has a queued or running execution — one execution at a time (follow the existing job in the Job Center)`
    );
    this.name = "ExecutionInFlightError";
  }
}

/**
 * SAFE-004 — the CAS step claim lost (`updateMany WHERE status='PENDING'`
 * counted 0): another executor claimed the step between our read and our
 * write. Maps to 409 STEP_IN_FLIGHT so the driver rides its existing
 * retry-with-backoff path.
 */
export class StepClaimLostError extends ConcurrencyGuardError {
  constructor(order: number, name: string) {
    super(
      "STEP_IN_FLIGHT",
      `Step ${order} (${name}) was just claimed by another executor — retry shortly`
    );
    this.name = "StepClaimLostError";
  }
}

/**
 * SAFE-005 — a device in the change's scope is exclusively locked by
 * another change's step. The route answers 409 DEVICE_WRITE_LOCKED with
 * the holding change ids; the driver retries with backoff.
 */
export class DeviceWriteLockedError extends ConcurrencyGuardError {
  constructor() {
    super(
      "DEVICE_WRITE_LOCKED",
      "A device in this change's scope is executing another change — one change, one device, one step at a time; retry after the other change's current step completes"
    );
    this.name = "DeviceWriteLockedError";
  }
}

/* ───────────────────────── lock row construction ──────────────────────── */

/**
 * Build the DeviceWriteLock createMany rows for a step claim — one row per
 * device id, TTL-stamped. Order-stable (input order preserved) so tests and
 * logs are deterministic.
 */
export function deviceLockRows(
  deviceIds: readonly string[],
  scope: { changeId: string; jobId: string; stepId: string },
  now: Date
): {
  deviceId: string;
  changeId: string;
  jobId: string;
  stepId: string;
  acquiredAt: Date;
  expiresAt: Date;
}[] {
  return deviceIds.map((deviceId) => ({
    deviceId,
    changeId: scope.changeId,
    jobId: scope.jobId,
    stepId: scope.stepId,
    acquiredAt: now,
    expiresAt: deviceLockExpiry(now),
  }));
}

/* ───────────────────────── CAS claim classification ───────────────────── */

/**
 * SAFE-004 CAS semantics: a conditional updateMany claiming a PENDING step
 * must affect EXACTLY the one row. count === 1 → claimed; anything else →
 * the claim was lost (or the row vanished) and the caller must NOT touch
 * the change's device locks (they belong to the winner).
 */
export function isStepClaimWon(count: number): boolean {
  return count === 1;
}
