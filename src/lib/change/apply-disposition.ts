/**
 * SAFE-006 — fail-fast multi-device apply + truthful per-device states
 * (production-safety sprint, external ULTRA audit P0-005).
 *
 * Pure, dependency-free decision helpers shared by the change engine's
 * APPLY / ROLLBACK / VALIDATE executors in
 * src/app/api/v1/worker/change-step/route.ts and unit-pinned in
 * tests/audit/apply-failfast.test.ts.
 *
 * The defect this closes: the multi-device APPLY loop used to contact EVERY
 * device (LIVE apply or simulator) and only evaluated `anyFailure` AFTER the
 * loop — later LIVE devices really were modified past a failure — and the
 * failure-path writer then labeled the first failing device FAILED and every
 * other device SKIPPED, including devices whose apply had actually SUCCEEDED
 * (they were modified, but the audit trail claimed they were skipped, and
 * their collected post-apply configs were thrown away).
 *
 * The contract now:
 *   SUCCESS → the device was contacted and the plan applied (its collected
 *             post-apply config is recorded as a POST_CHANGE snapshot even
 *             when the step as a whole fails);
 *   FAILED  → the device was contacted and its apply failed (the stopper);
 *   SKIPPED → the device was provably NEVER contacted (fail-fast stop, or an
 *             engine-side refusal such as the demo failAt control on the
 *             LIVE plane). A missing attempt is SKIPPED — never FAILED.
 */

/* ───────────────────────────── attempt shape ──────────────────────────── */

/** One per-device apply attempt recorded by the engine's device loop. */
export interface ApplyAttempt {
  ok: boolean;
  /** The real post-apply running config (LIVE) / intended config (sim). */
  configText: string;
  error?: string;
  /**
   * true ⇒ the apply was refused engine-side BEFORE any device contact
   * (demo `failAt=APPLY` control on the LIVE plane). The device is provably
   * unmodified, so its truthful disposition is SKIPPED — never FAILED.
   */
  refusedBeforeContact?: boolean;
}

/* ─────────────────────────── disposition model ────────────────────────── */

export type ApplyDeviceResult = "SUCCESS" | "FAILED" | "SKIPPED";

export type ApplyStopReasonKind =
  | "none"
  | "device-failure"
  | "refused-before-contact";

export interface ApplyDispositionInput {
  deviceId: string;
  hostname: string;
  /** undefined ⇒ the device was never contacted (fail-fast stop). */
  attempt?: ApplyAttempt;
}

export interface ApplyDispositionRow {
  deviceId: string;
  hostname: string;
  result: ApplyDeviceResult;
  /** The collected post-apply config for SUCCESS rows; null otherwise. */
  snapshotText: string | null;
  /** The error/reason text for FAILED and refused rows; null for SUCCESS. */
  reason: string | null;
}

export interface ApplyDispositionSummary {
  /** 1:1 with the input devices, input order preserved. */
  rows: ApplyDispositionRow[];
  appliedHostnames: string[];
  failedHostnames: string[];
  /** Never-contacted devices (fail-fast stop + engine-side refusals). */
  uncontactedHostnames: string[];
  /** The device where the apply stopped; null on a fully healthy run. */
  stopHostname: string | null;
  stopReasonKind: ApplyStopReasonKind;
  firstError: string | null;
  /** true ⇒ every device has a SUCCESS row (the healthy-run condition). */
  allApplied: boolean;
}

/** Standard reason recorded on devices the failed apply never contacted. */
export const UNCONTACTED_REASON =
  "not contacted — apply stopped after an earlier device failure (SAFE-006 fail-fast)";

/** Audit action written when a multi-device apply stops at the first failure. */
export const APPLY_FAIL_FAST_AUDIT_ACTION = "APPLY_FAIL_FAST";

/* ─────────────────────────── the classifier ───────────────────────────── */

/**
 * Classify per-device dispositions from the engine's attempt map. Total and
 * order-preserving: exactly one row per input device, input order kept, so
 * the route can zip rows back onto its device links by index.
 */
export function classifyApplyDispositions(
  devices: readonly ApplyDispositionInput[]
): ApplyDispositionSummary {
  const rows: ApplyDispositionRow[] = [];
  const appliedHostnames: string[] = [];
  const failedHostnames: string[] = [];
  const uncontactedHostnames: string[] = [];
  let stopHostname: string | null = null;
  let stopReasonKind: ApplyStopReasonKind = "none";
  let firstError: string | null = null;

  for (const device of devices) {
    const attempt = device.attempt;

    if (!attempt) {
      // Never contacted — the fail-fast loop stopped before this device.
      // Truthful state: SKIPPED (the pre-SAFE-006 code treated a missing
      // result as `!result?.ok` → truthy, mis-labeling uncontacted devices
      // as failures).
      rows.push({
        deviceId: device.deviceId,
        hostname: device.hostname,
        result: "SKIPPED",
        snapshotText: null,
        reason: UNCONTACTED_REASON,
      });
      uncontactedHostnames.push(device.hostname);
      continue;
    }

    if (attempt.ok) {
      rows.push({
        deviceId: device.deviceId,
        hostname: device.hostname,
        result: "SUCCESS",
        snapshotText: attempt.configText,
        reason: null,
      });
      appliedHostnames.push(device.hostname);
      continue;
    }

    const error = attempt.error ?? "apply failed";

    if (attempt.refusedBeforeContact === true) {
      // Refused engine-side BEFORE any device contact — the device is
      // provably unmodified, so SKIPPED (never FAILED) is the truthful
      // state, and the demo control cannot make a device report FAILED.
      rows.push({
        deviceId: device.deviceId,
        hostname: device.hostname,
        result: "SKIPPED",
        snapshotText: null,
        reason: error,
      });
      uncontactedHostnames.push(device.hostname);
      if (stopReasonKind === "none") {
        stopReasonKind = "refused-before-contact";
        stopHostname = device.hostname;
        firstError = error;
      }
      continue;
    }

    // Contacted and failed — the stopper (with fail-fast, the only one).
    rows.push({
      deviceId: device.deviceId,
      hostname: device.hostname,
      result: "FAILED",
      snapshotText: null,
      reason: error,
    });
    failedHostnames.push(device.hostname);
    if (stopReasonKind === "none") {
      stopReasonKind = "device-failure";
      stopHostname = device.hostname;
      firstError = error;
    }
  }

  return {
    rows,
    appliedHostnames,
    failedHostnames,
    uncontactedHostnames,
    stopHostname,
    stopReasonKind,
    firstError,
    allApplied: rows.every((row) => row.result === "SUCCESS"),
  };
}

/* ─────────────────────── step error / audit detail ────────────────────── */

/**
 * Deterministic step-error text for a failed (fail-fast) APPLY step. Names
 * the stop device, the first error, which devices WERE applied before the
 * failure, and which were never contacted.
 */
export function applyFailFastStepError(summary: ApplyDispositionSummary): string {
  const parts = [
    `Apply failed (fail-fast at ${summary.stopHostname ?? "unknown device"}): ${
      summary.firstError ?? "apply failed"
    }`,
  ];
  if (summary.appliedHostnames.length > 0) {
    parts.push(`applied before the failure: ${summary.appliedHostnames.join(", ")}`);
  }
  if (summary.uncontactedHostnames.length > 0) {
    parts.push(`NOT contacted: ${summary.uncontactedHostnames.join(", ")}`);
  }
  return parts.join(" — ");
}

export interface ApplyFailFastAuditDetail {
  reason: "SAFE-006 fail-fast";
  stop: { hostname: string; kind: Exclude<ApplyStopReasonKind, "none"> };
  firstError: string;
  applied: string[];
  failed: string[];
  uncontacted: string[];
}

/**
 * The `afterJson` payload for the APPLY_FAIL_FAST audit event — the one-stop
 * operator record of which devices were modified, which failed, and which
 * were never touched. Returns null on a healthy run (no event is written).
 * Array copies: callers may mutate the returned object freely.
 */
export function applyFailFastAuditDetail(
  summary: ApplyDispositionSummary
): ApplyFailFastAuditDetail | null {
  if (summary.stopReasonKind === "none" || !summary.stopHostname) {
    return null;
  }
  return {
    reason: "SAFE-006 fail-fast",
    stop: { hostname: summary.stopHostname, kind: summary.stopReasonKind },
    firstError: summary.firstError ?? "apply failed",
    applied: [...summary.appliedHostnames],
    failed: [...summary.failedHostnames],
    uncontacted: [...summary.uncontactedHostnames],
  };
}

/* ───────────────────── rollback restore targeting ─────────────────────── */

/**
 * SAFE-006 — restore targeting is EXCLUSION-based: a device the failed apply
 * PROVABLY never contacted (SKIPPED under fail-fast, or an engine-side
 * refusal) must not be "restored" — that would be the first write it ever
 * sees. Unknown/null states (e.g. an orphaned apply reaped mid-flight before
 * it could write per-device results) stay restore targets — fail-safe,
 * matching the pre-SAFE-006 behavior where the rollback restored every
 * device it could reach.
 */
export function isRollbackRestoreTarget(
  perDeviceResult: string | null | undefined
): boolean {
  return perDeviceResult !== "SKIPPED";
}

/* ─────────────────── post-rollback validate context ───────────────────── */

/**
 * SAFE-006 — the appended "Post-rollback validation" step runs while the
 * change is in ROLLBACK (the status only leaves ROLLBACK at job completion).
 * In this context the truthful assertion is INVERTED: a device that was
 * applied and then restored must NOT carry the applied marker anymore — its
 * presence means the restore failed. (Pre-SAFE-006 this step asserted
 * marker-PRESENT in both contexts: a restored device failed validation
 * forever, and each failure re-engaged rollback unboundedly.)
 */
export function isPostRollbackValidateContext(changeStatus: string): boolean {
  return changeStatus === "ROLLBACK";
}
