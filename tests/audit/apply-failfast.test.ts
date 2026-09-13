import { describe, expect, test } from "bun:test";

import {
  APPLY_FAIL_FAST_AUDIT_ACTION,
  applyFailFastAuditDetail,
  applyFailFastStepError,
  classifyApplyDispositions,
  isPostRollbackValidateContext,
  isRollbackRestoreTarget,
  UNCONTACTED_REASON,
  type ApplyDispositionInput,
} from "../../src/lib/change/apply-disposition";

/**
 * SAFE-006 (production-safety sprint) — fail-fast multi-device apply +
 * truthful per-device states. The external ULTRA audit's P0-005: the
 * multi-device APPLY loop contacted EVERY device and only evaluated
 * `anyFailure` after the loop (later LIVE devices really were modified past
 * a failure), and the failure-path writer then labeled the first failing
 * device FAILED and every other device SKIPPED — including devices whose
 * apply had actually succeeded. This suite pins the pure half of the fix:
 * the disposition classifier (a missing attempt is SKIPPED, never FAILED;
 * a contacted-and-applied device is SUCCESS even on a failed step), the
 * engine-side-refusal semantics (refused-before-contact ⇒ SKIPPED), the
 * deterministic step-error / audit-detail builders, the exclusion-based
 * rollback restore targeting, and the inverted post-rollback validation
 * context (the pre-fix assertion re-engaged rollback unboundedly).
 */

function devices(
  definitions: {
    deviceId: string;
    hostname: string;
    attempt?: { ok: boolean; configText?: string; error?: string; refusedBeforeContact?: boolean };
  }[]
): ApplyDispositionInput[] {
  return definitions.map((definition) => ({
    deviceId: definition.deviceId,
    hostname: definition.hostname,
    ...(definition.attempt
      ? {
          attempt: {
            ok: definition.attempt.ok,
            configText: definition.attempt.configText ?? "",
            ...(definition.attempt.error !== undefined
              ? { error: definition.attempt.error }
              : {}),
            ...(definition.attempt.refusedBeforeContact !== undefined
              ? { refusedBeforeContact: definition.attempt.refusedBeforeContact }
              : {}),
          },
        }
      : {}),
  }));
}

describe("SAFE-006 — fail-fast apply dispositions", () => {
  /* ─────────────────────── healthy run ─────────────────────── */

  test("all-ok run: every device SUCCESS with its collected config; no stop", () => {
    const summary = classifyApplyDispositions(
      devices([
        { deviceId: "d1", hostname: "edge-01", attempt: { ok: true, configText: "cfg-1" } },
        { deviceId: "d2", hostname: "edge-02", attempt: { ok: true, configText: "cfg-2" } },
      ])
    );
    expect(summary.allApplied).toBe(true);
    expect(summary.stopReasonKind).toBe("none");
    expect(summary.stopHostname).toBeNull();
    expect(summary.firstError).toBeNull();
    expect(summary.appliedHostnames).toEqual(["edge-01", "edge-02"]);
    expect(summary.failedHostnames).toEqual([]);
    expect(summary.uncontactedHostnames).toEqual([]);
    expect(summary.rows.map((row) => row.result)).toEqual(["SUCCESS", "SUCCESS"]);
    expect(summary.rows.map((row) => row.snapshotText)).toEqual(["cfg-1", "cfg-2"]);
    expect(summary.rows.every((row) => row.reason === null)).toBe(true);
  });

  test("rows preserve input order 1:1 with the device links", () => {
    const input = devices([
      { deviceId: "a", hostname: "h-a" },
      { deviceId: "b", hostname: "h-b" },
      { deviceId: "c", hostname: "h-c" },
    ]);
    const summary = classifyApplyDispositions(input);
    expect(summary.rows.map((row) => row.deviceId)).toEqual(["a", "b", "c"]);
    expect(summary.rows.map((row) => row.hostname)).toEqual(["h-a", "h-b", "h-c"]);
  });

  /* ─────────────── P0-005 core: truthful failure states ─────────────── */

  test("mid-loop failure: applied device is SUCCESS (the old code said SKIPPED), stopper FAILED, the rest SKIPPED", () => {
    const summary = classifyApplyDispositions(
      devices([
        { deviceId: "d1", hostname: "edge-01", attempt: { ok: true, configText: "cfg-1" } },
        { deviceId: "d2", hostname: "edge-02", attempt: { ok: false, error: "apply: rejected" } },
        // With fail-fast the loop stops — devices 3/4 have NO attempt.
        { deviceId: "d3", hostname: "edge-03" },
        { deviceId: "d4", hostname: "edge-04" },
      ])
    );
    expect(summary.allApplied).toBe(false);
    expect(summary.stopReasonKind).toBe("device-failure");
    expect(summary.stopHostname).toBe("edge-02");
    expect(summary.firstError).toBe("apply: rejected");
    expect(summary.rows.map((row) => row.result)).toEqual([
      "SUCCESS",
      "FAILED",
      "SKIPPED",
      "SKIPPED",
    ]);
    // The applied device keeps its collected post-apply config for the
    // POST_CHANGE snapshot the engine records in the failure transaction.
    expect(summary.rows[0]?.snapshotText).toBe("cfg-1");
    expect(summary.rows[1]?.snapshotText).toBeNull();
    expect(summary.appliedHostnames).toEqual(["edge-01"]);
    expect(summary.failedHostnames).toEqual(["edge-02"]);
    expect(summary.uncontactedHostnames).toEqual(["edge-03", "edge-04"]);
  });

  test("first device fails: FAILED first, everything after SKIPPED", () => {
    const summary = classifyApplyDispositions(
      devices([
        { deviceId: "d1", hostname: "edge-01", attempt: { ok: false, error: "boom" } },
        { deviceId: "d2", hostname: "edge-02" },
        { deviceId: "d3", hostname: "edge-03" },
      ])
    );
    expect(summary.rows.map((row) => row.result)).toEqual(["FAILED", "SKIPPED", "SKIPPED"]);
    expect(summary.failedHostnames).toEqual(["edge-01"]);
    expect(summary.uncontactedHostnames).toEqual(["edge-02", "edge-03"]);
  });

  test("a MISSING attempt is SKIPPED — never mis-read as a failure (the old `!result?.ok` trap)", () => {
    const summary = classifyApplyDispositions(
      devices([{ deviceId: "d1", hostname: "edge-01" }])
    );
    expect(summary.rows[0]?.result).toBe("SKIPPED");
    expect(summary.rows[0]?.reason).toBe(UNCONTACTED_REASON);
    expect(summary.failedHostnames).toEqual([]);
    expect(summary.uncontactedHostnames).toEqual(["edge-01"]);
    expect(summary.stopReasonKind).toBe("none");
  });

  test("missing attempt on an otherwise-ok run still fails the step (fail-safe)", () => {
    const summary = classifyApplyDispositions(
      devices([
        { deviceId: "d1", hostname: "edge-01", attempt: { ok: true, configText: "cfg-1" } },
        { deviceId: "d2", hostname: "edge-02" },
      ])
    );
    expect(summary.allApplied).toBe(false);
  });

  test("missing-error attempt still classifies as FAILED with the default error text", () => {
    const summary = classifyApplyDispositions(
      devices([{ deviceId: "d1", hostname: "edge-01", attempt: { ok: false, configText: "" } }])
    );
    expect(summary.rows[0]?.result).toBe("FAILED");
    expect(summary.firstError).toBe("apply failed");
  });

  /* ────────────── engine-side refusal (demo failAt, LIVE) ────────────── */

  test("refused-before-contact: SKIPPED (the device is provably unmodified), never FAILED", () => {
    const summary = classifyApplyDispositions(
      devices([
        {
          deviceId: "d1",
          hostname: "fw-live-01",
          attempt: {
            ok: false,
            error: "Demo control failAt=APPLY — live apply suppressed before device contact",
            refusedBeforeContact: true,
          },
        },
        { deviceId: "d2", hostname: "fw-live-02" },
      ])
    );
    expect(summary.rows.map((row) => row.result)).toEqual(["SKIPPED", "SKIPPED"]);
    expect(summary.failedHostnames).toEqual([]);
    expect(summary.uncontactedHostnames).toEqual(["fw-live-01", "fw-live-02"]);
    expect(summary.stopReasonKind).toBe("refused-before-contact");
    expect(summary.stopHostname).toBe("fw-live-01");
    expect(summary.allApplied).toBe(false);
  });

  /* ────────────────────── step error text builder ────────────────────── */

  test("step error names the stop device, the first error, applied and uncontacted lists", () => {
    const summary = classifyApplyDispositions(
      devices([
        { deviceId: "d1", hostname: "edge-01", attempt: { ok: true, configText: "cfg-1" } },
        { deviceId: "d2", hostname: "edge-02", attempt: { ok: false, error: "apply: rejected" } },
        { deviceId: "d3", hostname: "edge-03" },
        { deviceId: "d4", hostname: "edge-04" },
      ])
    );
    expect(applyFailFastStepError(summary)).toBe(
      "Apply failed (fail-fast at edge-02): apply: rejected — " +
        "applied before the failure: edge-01 — NOT contacted: edge-03, edge-04"
    );
  });

  test("step error without applied/uncontacted devices stays truthful and readable", () => {
    const onlyFailure = classifyApplyDispositions(
      devices([{ deviceId: "d1", hostname: "solo-01", attempt: { ok: false, error: "boom" } }])
    );
    expect(applyFailFastStepError(onlyFailure)).toBe(
      "Apply failed (fail-fast at solo-01): boom"
    );

    const refusedOnly = classifyApplyDispositions(
      devices([
        {
          deviceId: "d1",
          hostname: "fw-live-01",
          attempt: { ok: false, error: "demo refusal", refusedBeforeContact: true },
        },
        { deviceId: "d2", hostname: "fw-live-02" },
      ])
    );
    expect(applyFailFastStepError(refusedOnly)).toBe(
      "Apply failed (fail-fast at fw-live-01): demo refusal — NOT contacted: fw-live-01, fw-live-02"
    );
  });

  /* ───────────────────────── audit detail builder ───────────────────────── */

  test("audit detail is null on a healthy run (no APPLY_FAIL_FAST event is written)", () => {
    const summary = classifyApplyDispositions(
      devices([{ deviceId: "d1", hostname: "edge-01", attempt: { ok: true, configText: "c" } }])
    );
    expect(applyFailFastAuditDetail(summary)).toBeNull();
  });

  test("audit detail carries the stop, dispositions, and defensive array copies", () => {
    const summary = classifyApplyDispositions(
      devices([
        { deviceId: "d1", hostname: "edge-01", attempt: { ok: true, configText: "cfg-1" } },
        { deviceId: "d2", hostname: "edge-02", attempt: { ok: false, error: "apply: rejected" } },
        { deviceId: "d3", hostname: "edge-03" },
      ])
    );
    const detail = applyFailFastAuditDetail(summary);
    expect(detail).toEqual({
      reason: "SAFE-006 fail-fast",
      stop: { hostname: "edge-02", kind: "device-failure" },
      firstError: "apply: rejected",
      applied: ["edge-01"],
      failed: ["edge-02"],
      uncontacted: ["edge-03"],
    });
    // Mutating the returned arrays must not corrupt the summary.
    detail?.applied.push("injected");
    expect(summary.appliedHostnames).toEqual(["edge-01"]);
  });

  test("audit action name is the pinned APPLY_FAIL_FAST string", () => {
    expect(APPLY_FAIL_FAST_AUDIT_ACTION).toBe("APPLY_FAIL_FAST");
  });

  /* ─────────────────── rollback restore targeting ─────────────────── */

  test("restore targeting is exclusion-based: SKIPPED excluded, everything else (incl. unknown) a target", () => {
    expect(isRollbackRestoreTarget("SKIPPED")).toBe(false);
    expect(isRollbackRestoreTarget("SUCCESS")).toBe(true);
    expect(isRollbackRestoreTarget("FAILED")).toBe(true);
    // Unknown/null states (orphaned apply reaped mid-flight) stay targets —
    // fail-safe, matching the pre-SAFE-006 restore-everything behavior.
    expect(isRollbackRestoreTarget(null)).toBe(true);
    expect(isRollbackRestoreTarget(undefined)).toBe(true);
    expect(isRollbackRestoreTarget("")).toBe(true);
  });

  /* ───────────────── post-rollback validate context ───────────────── */

  test("post-rollback validate context is exactly change status ROLLBACK", () => {
    expect(isPostRollbackValidateContext("ROLLBACK")).toBe(true);
    for (const status of [
      "APPROVED",
      "SCHEDULED",
      "PRE_CHECK",
      "EXECUTING",
      "VALIDATING",
      "SUCCESSFUL",
      "FAILED",
      "ROLLBACK_FAILED",
    ]) {
      expect(isPostRollbackValidateContext(status)).toBe(false);
    }
  });
});
