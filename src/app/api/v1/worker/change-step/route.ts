import { createHash } from "node:crypto";
import { decryptSnapshotTexts } from "@/lib/config/crypto";
import { db } from "@/lib/db";
import {
  createSnapshot,
  shortSha,
  type CreateSnapshotResult,
  type TxClient,
} from "@/lib/config/create-snapshot";
import {
  changeSlugFromTitle,
  expectedDescriptionMarker,
  extractLiveAnchor,
  extractOriginalDescription,
  isRestoreOperation,
  LIVE_NO_ANCHOR,
  LIVE_RESTORE_NOT_CERTIFIED,
  VENDOR_CONFIG_FLAVORS,
} from "@/lib/change/live-plan";
import { fail, failWithDetail, firstIssueMessage, ok } from "../../_lib/api";
import { authenticateServiceRequest } from "@/lib/auth/service-auth";
import {
  DeviceWriteLockedError,
  StepClaimLostError,
  deviceLockRows,
  isStepClaimWon,
  isUniqueConflict,
} from "@/lib/change/execution-guard";
import {
  APPLY_FAIL_FAST_AUDIT_ACTION,
  ROLLBACK_STEP_TEMPLATES,
  applyFailFastAuditDetail,
  applyFailFastStepError,
  classifyApplyDispositions,
  isPostRollbackValidateContext,
  isRollbackRestoreTarget,
  shouldReuseRestoredSnapshot,
  type ApplyAttempt,
} from "@/lib/change/apply-disposition";
import { getHostKeyPin } from "@/lib/ssh/host-keys";
import {
  RESTORE_APPLIED_AUDIT_ACTION,
  RESTORE_REFUSED_AUDIT_ACTION,
  buildRestoreValidateOutputs,
  classifyRestoreTarget,
  isRestoreCommitSizeOk,
  restoreCommitEchoOk,
  type RestoreTargetData,
  type RestoreValidateRow,
  type RestoreTargetVerdict,
} from "@/lib/change/restore-op";
import { workerControlHeaders } from "@/lib/worker/control-client";
import { WORKER_BASE_URL } from "@/lib/worker/worker-url";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/worker/change-step — the Next-side change execution engine
 * (Task 4-b). Called BY the worker mini-service in a loop after it claims a
 * CHANGE_EXECUTE job; the worker never touches the database directly
 * (PostgreSQL since Phase 21 — the app owns all persistence).
 *
 * Contract: executes EXACTLY ONE next PENDING ChangeStep per call, then
 * returns { done, … } so the driver either keeps looping or completes the
 * job. HTTP calls to the worker's /simulate/* and /live/* endpoints happen
 * OUTSIDE transactions; results are written in one short transaction per
 * step (never hold a tx across a fetch).
 * DATA PLANE ROUTING (Phase 23): every per-device call resolves the
 * device's data plane first. SIMULATOR (default) keeps the historical
 * /simulate/* behavior verbatim. LIVE_SSH devices route through the
 * worker's CONTROLLED-CHANGE plane: real SSH probes for CHECK
 * (/simulate/connect with dataSource+credential), real config collection
 * for BACKUP and VALIDATE (/live/fetch-config), and plan-based controlled
 * applies for APPLY and ROLLBACK (/live/apply — the worker builds the
 * command list itself from the validated plan; the control plane can
 * never send command text). The applied delta is a single
 * description/comment token under the first interface extracted from the
 * pre-change snapshot — deterministic, reversible, idempotent on retry.
 *
 * Demo control (failAt) never WRITES to live devices: the APPLY/VALIDATE
 * failure is injected engine-side BEFORE any device contact, so a demo
 * run can never induce a real fault on production hardware. (The appended
 * post-rollback steps may READ live devices — config collection cannot
 * fault hardware — but a refused/refused-then-rolled-back device is never
 * written: see SAFE-006 below.)
 *
 * SAFE-006 — fail-fast multi-device APPLY + truthful per-device states
 * (audit P0-005): the APPLY loop STOPS at the first device failure (device-
 * level or transport) — no later device is contacted, so the blast radius is
 * exactly the devices actually reached. Per-device dispositions are TRUTHFUL:
 *   SUCCESS → contacted and applied (its collected post-apply config is
 *             recorded as a POST_CHANGE snapshot even when the step fails);
 *   FAILED  → contacted and its apply failed (the stopper);
 *   SKIPPED → provably never contacted (fail-fast stop, or an engine-side
 *             refusal such as the demo failAt control on the LIVE plane).
 * The failure transaction also writes an APPLY_FAIL_FAST audit event with
 * the full disposition map. The ROLLBACK executor restores ONLY devices the
 * failed apply actually reached (SKIPPED devices are never "restored" —
 * that would be the first write they ever see); unknown per-device states
 * (orphaned apply reaped mid-flight) stay restore targets — fail-safe.
 * The post-rollback VALIDATE asserts the INVERSE of the post-apply one for
 * LIVE devices (the applied marker must be ABSENT after a restore) and
 * skips SKIPPED devices entirely — the pre-SAFE-006 marker-present
 * assertion failed forever there and re-engaged rollback unboundedly.
 *
 * Step semantics:
 *   CHECK     per device — reachability via /simulate/connect (non-ok ⇒
 *             unreachable; OFFLINE devices fail fast like the backup engine)
 *             + config-changed-since-approval BLOCK: latest snapshot at the
 *             latest approval decision vs latest CURRENT now; a different
 *             sha256 ⇒ FAILED ("re-approval required"). Results are merged
 *             into preChecksJson (same-name entries replaced, earlier ones
 *             preserved). Any device failure ⇒ change FAILED immediately —
 *             nothing was applied, so NO rollback steps are appended.
 *   BACKUP    per device — /simulate/generate-config ⇒ createSnapshot.
 *             PRE_CHANGE for the first backup (no APPLY before it in the
 *             plan), POST_CHANGE for every later one (post-change and
 *             post-rollback backups alike).
 *   APPLY     per device, FAIL-FAST (SAFE-006) — /simulate/apply (or the
 *             live controlled plane) ⇒ the intended running config is
 *             captured as a CURRENT POST_CHANGE snapshot; ChangeDevice.result
 *             = SUCCESS per applied device. First failure ⇒ the loop STOPS:
 *             the failing device FAILED, every later device SKIPPED (never
 *             contacted), devices already applied keep SUCCESS + their
 *             POST_CHANGE snapshots, and an APPLY_FAIL_FAST audit event
 *             records the disposition map. payload.failAt === "APPLY" ⇒ the
 *             sim answers HTTP 500 (first device FAILED + rest SKIPPED) or,
 *             on the LIVE plane, the apply is refused engine-side with
 *             refusedBeforeContact (every device SKIPPED — no live write).
 *   VALIDATE  payload.failAt === "VALIDATE" ⇒ FAILED (simulated) else PASSED
 *             with a per-device ok list. Context-aware (SAFE-006): while the
 *             change is in ROLLBACK the LIVE assertion inverts — the applied
 *             marker must be ABSENT (its presence means the restore failed)
 *             — and SKIPPED devices are neither contacted nor asserted.
 *   ROLLBACK  (driven once the change is in ROLLBACK) — restores ONLY the
 *             devices the failed apply actually reached (SAFE-006; result
 *             SKIPPED devices are left untouched with a truthful step note).
 *             Each restored device gets a CURRENT snapshot from the
 *             PRE_CHANGE snapshot's rawText captured earlier this run
 *             (fallback: latest snapshot created before the job started;
 *             none ⇒ step FAILED → ROLLBACK_FAILED). The restored running
 *             config is stored with source POST_CHANGE (documented decision:
 *             every snapshot this execution produced belongs to the change's
 *             post-activity state). A ROLLBACK step reached during a healthy
 *             run (user-authored plan) is SKIPPED "on standby" — the same
 *             story the seeded changes tell.
 *
 * On APPLY/VALIDATE failure the remaining original steps are SKIPPED and
 * three PENDING steps are appended (order continues): ROLLBACK "Restore
 * pre-change configuration", VALIDATE "Post-rollback validation", BACKUP
 * "Post-rollback backup"; change.status = ROLLBACK; failAt is consumed on
 * the job payload so the post-rollback steps run clean.
 *
 * Completion: all steps done → change SUCCESSFUL + CHANGE_EXECUTED audit
 * (actor system:change-engine), or — after the appended rollback steps all
 * pass — change FAILED + CHANGE_FAILED audit { rolledBack: true }.
 * Response: { done, outcome: "SUCCESS"|"FAILED"|"ROLLBACK_FAILED",
 *   changeStatus, suggestIncident (outcome !== "SUCCESS"), stepsTotal,
 *   stepsCompleted, message, lastStep }.
 *
 * Locking/idempotency: the job row is the lock (single claim — SAFE-003's
 * execution lease guarantees ONE queued/running execution per change).
 * Steps are claimed with an atomic CAS (SAFE-004: conditional updateMany on
 * status='PENDING' with a rowcount check — the read→blind-update TOCTOU
 * from audit P0-003 is gone); a lost claim answers 409 STEP_IN_FLIGHT (the
 * driver retries with backoff). Every step claim ALSO takes exclusive
 * DeviceWriteLock rows on every device in the change's scope (SAFE-005 —
 * one change, one device, one step at a time); a lock conflict aborts the
 * claim transaction and answers 409 DEVICE_WRITE_LOCKED. Locks are
 * released when the step reaches a terminal state (executor return /
 * catch / orphan reap); expiresAt is the crash valve. A RUNNING
 * step younger than 5 min answers 409 STEP_IN_FLIGHT (the driver retries
 * with backoff); an older one is reaped to FAILED ("orphaned step") — an
 * orphaned APPLY/VALIDATE still engages the rollback path, anything else
 * fails the change directly. Snapshot creation reuses this job's earlier
 * snapshot for the same device+source so step retries never duplicate.
 */

const stepSchema = z.object({
  jobId: z.string().trim().min(1),
});

const ORPHAN_THRESHOLD_MS = 5 * 60 * 1000;
const EXECUTABLE_CHANGE_STATUSES = [
  "APPROVED",
  "SCHEDULED",
  "PRE_CHECK",
  "EXECUTING",
  "VALIDATING",
  "ROLLBACK",
];

// The appended rollback plan (ROLLBACK → VALIDATE → BACKUP) lives in
// src/lib/change/apply-disposition.ts — pinned contract, shared with tests.

/** Worker sim endpoints answer { ok: true, ... } — non-ok/5xx/network throw. */
class WorkerSimError extends Error {}

async function workerSimPost(
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(WORKER_BASE_URL + path, {
      method: "POST",
      headers: workerControlHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new WorkerSimError(
      `worker sim ${path} unreachable: ${(error as Error)?.message ?? "network error"}`
    );
  }
  let json: Record<string, unknown> | null = null;
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  if (!response.ok || !json || json.ok !== true) {
    const message =
      typeof json?.error === "string" ? json.error : `HTTP ${response.status}`;
    throw new WorkerSimError(`worker sim ${path} failed: ${message}`);
  }
  return json;
}

/* ───────────────── Phase 23: data-plane routing helpers ───────────────── */

function isLiveDeviceLink(link: DeviceLink): boolean {
  return (link.device.dataSource ?? "SIMULATOR").trim().toUpperCase() === "LIVE_SSH";
}

function credentialBlockOf(link: DeviceLink): {
  username: string;
  port: number;
  secretRef: string;
} | null {
  const profile = link.device.credentialProfile;
  if (!profile) return null;
  return {
    username: profile.username,
    port: profile.port,
    secretRef: profile.secretRef,
  };
}

/**
 * SAFE-001 — the enrolled host-key pin for a live device link
 * ({ fingerprint } | null). The worker refuses UNPINNED live connections
 * (SSH_HOSTKEY_UNENROLLED), so a null here is a fail-closed state that
 * surfaces as an actionable step/pre-check failure — never a bypass.
 */
async function hostKeyPinOf(link: DeviceLink): Promise<{ fingerprint: string } | null> {
  const credential = credentialBlockOf(link);
  const host = link.device.mgmtIp;
  if (!credential || !host) return null;
  return getHostKeyPin(host, credential.port);
}

/** Live config flavor for a vendor code — null when not certified. */
function liveFlavorOf(link: DeviceLink): string | null {
  return VENDOR_CONFIG_FLAVORS[link.device.vendor.key] ?? null;
}

/**
 * Call a worker device endpoint and CLASSIFY the outcome:
 *   ok              → 200 { ok: true, ... }
 *   device-failure  → 200 { ok: false } (real probe/apply failure) or 4xx
 *                     (request-level rejection — fail closed, no retry)
 *   throw           → network error / 5xx (the step retries)
 */
type DeviceCallResult =
  | { kind: "ok"; json: Record<string, unknown> }
  | { kind: "device-failure"; message: string };

async function workerDevicePost(
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<DeviceCallResult> {
  let response: Response;
  try {
    response = await fetch(WORKER_BASE_URL + path, {
      method: "POST",
      headers: workerControlHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new WorkerSimError(
      `worker ${path} unreachable: ${(error as Error)?.message ?? "network error"}`
    );
  }
  let json: Record<string, unknown> | null = null;
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  if (response.status >= 500 || !json) {
    throw new WorkerSimError(
      `worker ${path} failed: ${
        json && typeof json.error === "string" ? json.error : `HTTP ${response.status}`
      }`
    );
  }
  if (json.ok !== true) {
    return {
      kind: "device-failure",
      message:
        typeof json.error === "string" ? json.error : `HTTP ${response.status}`,
    };
  }
  return { kind: "ok", json };
}

function safeParseJson(text: string | null | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

interface PreCheckEntry {
  name: string;
  status: string;
  detail?: string;
}

/** Merge-by-name: earlier entries preserved, same-name rows replaced. */
function mergePreChecks(existing: string | null, entries: PreCheckEntry[]): string {
  let list: PreCheckEntry[] = [];
  if (existing) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (Array.isArray(parsed)) {
        list = parsed
          .filter(
            (entry): entry is Record<string, unknown> =>
              typeof entry === "object" && entry !== null
          )
          .map((entry) => ({
            name: typeof entry.name === "string" ? entry.name : "Pre-check",
            status: typeof entry.status === "string" ? entry.status : "PENDING",
            ...(typeof entry.detail === "string" ? { detail: entry.detail } : {}),
          }));
      }
    } catch {
      // corrupt JSON degrades to a fresh list
    }
  }
  const byName = new Map(list.map((entry) => [entry.name, entry]));
  for (const entry of entries) byName.set(entry.name, entry);
  return JSON.stringify([...byName.values()]);
}

/* ─────────────────────────── shared row types ─────────────────────────── */

type ChangeWithRelations = NonNullable<
  Awaited<ReturnType<typeof loadChange>>
> & {};
type StepRow = ChangeWithRelations["steps"][number];
type DeviceLink = ChangeWithRelations["devices"][number];

function loadChange(changeId: string) {
  return db.changeRequest.findUnique({
    where: { id: changeId },
    include: {
      devices: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          deviceId: true,
          result: true,
          device: {
            select: {
              hostname: true,
              mgmtIp: true,
              status: true,
              vendor: { select: { key: true } },
              // Phase 23 — data-plane routing (vault REFERENCE fields only;
              // the secret itself never travels — the worker resolves the
              // secretRef against its own environment at connect time).
              dataSource: true,
              credentialProfile: {
                select: { username: true, port: true, secretRef: true },
              },
            },
          },
        },
      },
      steps: { orderBy: { order: "asc" } },
      approvals: {
        where: { decidedAt: { not: null } },
        orderBy: { decidedAt: "desc" },
        take: 1,
        select: { decidedAt: true },
      },
    },
  });
}

/** Re-read the change and shape the driver response (progress + outcome). */
async function buildResponse(
  changeId: string,
  overrides: {
    done: boolean;
    outcome?: "SUCCESS" | "FAILED" | "ROLLBACK_FAILED";
    suggestIncident?: boolean;
    message: string;
  }
) {
  const fresh = await loadChange(changeId);
  const steps = fresh?.steps ?? [];
  const total = steps.length;
  const completed = steps.filter(
    (step) => step.status !== "PENDING" && step.status !== "RUNNING"
  ).length;
  const lastTouched = [...steps]
    .filter((step) => step.status !== "PENDING")
    .sort((a, b) => b.order - a.order)[0];
  return {
    done: overrides.done,
    outcome: overrides.outcome ?? null,
    changeStatus: fresh?.status ?? null,
    suggestIncident: overrides.suggestIncident ?? false,
    stepsTotal: total,
    stepsCompleted: completed,
    message: overrides.message,
    lastStep: lastTouched
      ? {
          order: lastTouched.order,
          name: lastTouched.name,
          type: lastTouched.type,
          status: lastTouched.status,
        }
      : null,
  };
}

/** Idempotency: reuse a snapshot this job already produced (device+source). */
async function snapshotForJob(
  tx: TxClient,
  deviceId: string,
  jobId: string,
  source: string
): Promise<{ ok: true; id: string; version: number; sha256: string } | null> {
  const row = await tx.configSnapshot.findFirst({
    where: { deviceId, jobId, source },
    orderBy: { version: "desc" },
    select: { id: true, version: true, sha256: true },
  });
  // Normalized to an `ok: true` shape so call sites can narrow on `ok`
  // across both the reused and the freshly-created branches.
  return row ? { ok: true, ...row } : null;
}

/** Skip the remaining original steps + append the rollback plan (failure). */
async function engageRollback(
  tx: TxClient,
  changeId: string,
  steps: { order: number }[]
) {
  const maxOrder = Math.max(...steps.map((step) => step.order));
  await tx.changeStep.updateMany({
    where: { changeId, status: "PENDING", order: { lte: maxOrder } },
    data: { status: "SKIPPED", output: "Skipped — change failed, rollback engaged" },
  });
  await tx.changeStep.createMany({
    data: ROLLBACK_STEP_TEMPLATES.map((template, index) => ({
      changeId,
      order: maxOrder + 1 + index,
      name: template.name,
      type: template.type,
      status: "PENDING",
    })),
  });
  await tx.changeRequest.update({
    where: { id: changeId },
    data: { status: "ROLLBACK" },
  });
}

/** Consume the demo failAt control so post-rollback steps run clean. */
async function consumeFailAt(jobId: string, payload: Record<string, unknown>) {
  await db.jobExecution
    .update({
      where: { id: jobId },
      data: { payloadJson: JSON.stringify({ ...payload, failAt: null }) },
    })
    .catch(() => {});
}

/* ───────────────────────────── main handler ───────────────────────────── */

export async function POST(request: Request) {
  // P19 SEC-002 — machine principal only (service JWT; see service-auth.ts).
  const service = authenticateServiceRequest(request, "jobs");
  if (!service.ok) {
    return fail(service.code, service.message, 401);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = stepSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }

  const job = await db.jobExecution.findUnique({
    where: { id: parsed.data.jobId },
  });
  if (!job) {
    return fail("JOB_NOT_FOUND", "The referenced job does not exist", 404);
  }
  if (job.type !== "CHANGE_EXECUTE") {
    return fail(
      "INVALID_JOB_TYPE",
      `change-step expects a CHANGE_EXECUTE job (received ${job.type})`,
      400
    );
  }
  if (job.status !== "RUNNING") {
    return fail(
      "NOT_RUNNING",
      `change-step requires a RUNNING job — this job is ${job.status}`,
      409
    );
  }
  if (!job.targetId) {
    return fail("INVALID_TARGET", "CHANGE_EXECUTE job carries no change targetId", 400);
  }

  const payload = safeParseJson(job.payloadJson);
  const failAt =
    payload.failAt === "APPLY" || payload.failAt === "VALIDATE" ? payload.failAt : null;

  const change = await loadChange(job.targetId);
  if (!change) {
    return fail(
      "CHANGE_NOT_FOUND",
      "The change targeted by this job no longer exists",
      404
    );
  }
  if (!EXECUTABLE_CHANGE_STATUSES.includes(change.status)) {
    return fail(
      "INVALID_STATE",
      `Change ${change.number} is ${change.status} — the engine only drives execution states`,
      409
    );
  }

  const now = new Date();
  const correlationId = job.correlationId;

  /* ── orphan reap / in-flight guard ──────────────────────────────────── */
  const runningSteps = change.steps.filter((step) => step.status === "RUNNING");
  const freshRunning = runningSteps.find(
    (step) => now.getTime() - (step.startedAt ?? new Date(0)).getTime() <= ORPHAN_THRESHOLD_MS
  );
  if (freshRunning) {
    return fail(
      "STEP_IN_FLIGHT",
      `Step ${freshRunning.order} (${freshRunning.name}) is already executing — retry shortly`,
      409
    );
  }
  const orphan = runningSteps.find(
    (step) => now.getTime() - (step.startedAt ?? new Date(0)).getTime() > ORPHAN_THRESHOLD_MS
  );
  if (orphan) {
    const engagedRollback = ["APPLY", "VALIDATE"].includes(orphan.type);
    await db.$transaction(
      async (tx) => {
        await tx.changeStep.update({
          where: { id: orphan.id },
          data: {
            status: "FAILED",
            error: "Orphaned step — executor stopped mid-run (reaped)",
            finishedAt: now,
          },
        });
        // SAFE-005 — the reaped step can no longer release its own locks:
        // drop them here so the device frees immediately (TTL is the
        // backstop, not the primary mechanism).
        await tx.deviceWriteLock.deleteMany({ where: { stepId: orphan.id } });
        if (engagedRollback) {
          await engageRollback(tx as unknown as TxClient, change.id, change.steps);
        } else {
          await tx.changeRequest.update({
            where: { id: change.id },
            data: { status: "FAILED" },
          });
          await tx.auditEvent.create({
            data: {
              actorName: "system:change-engine",
              action: "CHANGE_FAILED",
              resourceType: "ChangeRequest",
              resourceId: change.id,
              resourceLabel: change.number,
              result: "FAILURE",
              correlationId,
              afterJson: JSON.stringify({ reason: "orphaned step", step: orphan.name }),
            },
          });
        }
      },
      { maxWait: 5_000, timeout: 20_000 }
    );

    if (!engagedRollback) {
      return ok(
        await buildResponse(change.id, {
          done: true,
          outcome: "FAILED",
          suggestIncident: true,
          message: `Orphaned step reaped — change FAILED (${orphan.name})`,
        })
      );
    }
    await consumeFailAt(job.id, payload);
    return ok(
      await buildResponse(change.id, {
        done: false,
        message: "Orphaned step reaped — rollback engaged",
      })
    );
  }

  /* ── pick the next PENDING step ─────────────────────────────────────── */
  const next = change.steps.find((step) => step.status === "PENDING");

  if (!next) {
    // No PENDING steps → finalize by the current change status.
    if (change.status === "ROLLBACK") {
      await db.$transaction(
        async (tx) => {
          await tx.changeRequest.update({
            where: { id: change.id },
            data: { status: "FAILED" },
          });
          await tx.auditEvent.create({
            data: {
              actorName: "system:change-engine",
              action: "CHANGE_FAILED",
              resourceType: "ChangeRequest",
              resourceId: change.id,
              resourceLabel: change.number,
              result: "FAILURE",
              correlationId,
              afterJson: JSON.stringify({ rolledBack: true }),
            },
          });
        },
        { maxWait: 5_000, timeout: 20_000 }
      );
      return ok(
        await buildResponse(change.id, {
          done: true,
          outcome: "FAILED",
          suggestIncident: true,
          message: "Rollback completed — change FAILED (rolled back)",
        })
      );
    }
    if (["SUCCESSFUL", "FAILED", "ROLLBACK_FAILED"].includes(change.status)) {
      const outcome =
        change.status === "SUCCESSFUL"
          ? "SUCCESS"
          : change.status === "FAILED"
            ? "FAILED"
            : "ROLLBACK_FAILED";
      return ok(
        await buildResponse(change.id, {
          done: true,
          outcome,
          suggestIncident: change.status !== "SUCCESSFUL",
          message: `Change already finalized as ${change.status}`,
        })
      );
    }
    // Healthy completion.
    const total = change.steps.length;
    const passed = change.steps.filter(
      (step) => step.status === "PASSED" || step.status === "SKIPPED"
    ).length;
    await db.$transaction(
      async (tx) => {
        await tx.changeRequest.update({
          where: { id: change.id },
          data: { status: "SUCCESSFUL" },
        });
        await tx.auditEvent.create({
          data: {
            actorName: "system:change-engine",
            action: "CHANGE_EXECUTED",
            resourceType: "ChangeRequest",
            resourceId: change.id,
            resourceLabel: change.number,
            result: "SUCCESS",
            correlationId,
            afterJson: JSON.stringify({
              steps: `${passed}/${total} passed`,
              devices: change.devices.length,
            }),
          },
        });
      },
      { maxWait: 5_000, timeout: 20_000 }
    );
    return ok(
      await buildResponse(change.id, {
        done: true,
        outcome: "SUCCESS",
        suggestIncident: false,
        message: "All steps passed — change SUCCESSFUL",
      })
    );
  }

  /* ── claim the step (SAFE-004 CAS) + take device locks (SAFE-005) ───── */
  try {
    await db.$transaction(
      async (tx) => {
        // SAFE-004 — ATOMIC claim: conditional update with a rowcount check.
        // The previous read-then-blind-update let two concurrent change-step
        // calls both "claim" the same PENDING step (the check-then-act gap
        // between the pick above and the update — audit P0-003). The
        // conditional updateMany is atomic on PostgreSQL: exactly one
        // concurrent claimant sees count === 1.
        const claimed = await tx.changeStep.updateMany({
          where: { id: next.id, status: "PENDING" },
          data: { status: "RUNNING", startedAt: now, error: null },
        });
        if (!isStepClaimWon(claimed.count)) {
          // Another executor won the row between our read and our write —
          // touch NOTHING else (their locks and state own the change now).
          throw new StepClaimLostError(next.order, next.name);
        }

        // SAFE-005 — exclusive per-device write locks, atomic with the
        // claim (a conflict aborts this transaction — the claim rolls back
        // with it, so no executor ever runs a step it did not fully win):
        //   1. drop OUR change's previous-step locks (single-flight + the
        //      claim CAS guarantee no concurrent executor of this change);
        //   2. purge expired locks (crash valve — any owner);
        //   3. take exclusive locks on every device in scope.
        await tx.deviceWriteLock.deleteMany({ where: { changeId: change.id } });
        await tx.deviceWriteLock.deleteMany({ where: { expiresAt: { lt: now } } });
        if (change.devices.length > 0) {
          try {
            await tx.deviceWriteLock.createMany({
              data: deviceLockRows(
                change.devices.map((link) => link.deviceId),
                { changeId: change.id, jobId: job.id, stepId: next.id },
                now
              ),
            });
          } catch (error) {
            if (isUniqueConflict(error)) {
              throw new DeviceWriteLockedError();
            }
            throw error;
          }
        }

        let transition: string | null = null;
        if (next.type === "CHECK" && ["APPROVED", "SCHEDULED"].includes(change.status)) {
          transition = "PRE_CHECK";
        } else if (next.type === "APPLY" && change.status !== "ROLLBACK") {
          transition = "EXECUTING";
        } else if (next.type === "VALIDATE" && change.status !== "ROLLBACK") {
          transition = "VALIDATING";
        } else if (next.type === "ROLLBACK") {
          transition = "ROLLBACK";
        }
        if (transition && transition !== change.status) {
          await tx.changeRequest.update({
            where: { id: change.id },
            data: { status: transition },
          });
        }
      },
      { maxWait: 5_000, timeout: 20_000 }
    );
  } catch (error) {
    if (error instanceof StepClaimLostError) {
      return fail(error.code, error.message, error.httpStatus);
    }
    if (error instanceof DeviceWriteLockedError) {
      // Name the holding change(s) so the operator can see WHO owns the
      // device right now. Filter our own id defensively: the deleteMany of
      // our previous-step locks reverted with the aborted transaction, but
      // a stale row of ours must never make this change look self-blocked.
      const holders = await db.deviceWriteLock.findMany({
        where: { deviceId: { in: change.devices.map((link) => link.deviceId) } },
        select: { changeId: true },
      });
      const heldBy = [...new Set(holders.map((row) => row.changeId))].filter(
        (id) => id !== change.id
      );
      return failWithDetail(
        error.code,
        heldBy.length > 0
          ? `${error.message} (held by change ${heldBy.join(", ")})`
          : error.message,
        error.httpStatus,
        { heldByChanges: heldBy }
      );
    }
    throw error;
  }

  /* ── execute the step (HTTP outside tx — writes in one short tx) ────── */
  type StepResponse = Awaited<ReturnType<typeof executeCheckStep>>;
  let stepResponse: StepResponse;
  try {
    switch (next.type) {
      case "CHECK":
        stepResponse = await executeCheckStep(change, next, correlationId);
        break;
      case "BACKUP":
        stepResponse = await executeBackupStep(change, next, correlationId, job.id);
        break;
      case "APPLY":
        stepResponse = await executeApplyStep(
          change, next, correlationId, job.id, failAt, payload
        );
        break;
      case "VALIDATE":
        stepResponse = await executeValidateStep(
          change, next, correlationId, job.id, failAt, payload
        );
        break;
      case "ROLLBACK":
        stepResponse = await executeRollbackStep(change, next, correlationId, job.id);
        break;
      default:
        throw new Error(`Unsupported step type: ${next.type}`);
    }
  } catch (error) {
    // SAFE-005 — the step did not reach a terminal state: release its
    // device locks alongside the step itself (the driver's retry will
    // re-claim and re-acquire atomically).
    await db.deviceWriteLock
      .deleteMany({ where: { stepId: next.id } })
      .catch(() => {});
    // Release the step so the driver's retry re-executes it (the change
    // status transition stays — harmless bookkeeping).
    await db.changeStep
      .update({
        where: { id: next.id },
        data: { status: "PENDING", startedAt: null },
      })
      .catch(() => {});
    return fail(
      "STEP_EXECUTION_ERROR",
      `Step ${next.order} (${next.name}) could not execute: ${
        (error as Error)?.message ?? "unknown error"
      }`,
      500
    );
  }
  // SAFE-005 — the step reached a terminal state inside its executor
  // (PASSED/FAILED + change bookkeeping): release its device locks. The
  // next step's claim re-acquires them atomically with its own CAS.
  await db.deviceWriteLock
    .deleteMany({ where: { stepId: next.id } })
    .catch(() => {});
  return ok(stepResponse);
}

/* ───────────────────────────── CHECK step ────────────────────────────── */

async function executeCheckStep(
  change: ChangeWithRelations,
  step: StepRow,
  correlationId: string
) {
  const approvalDecidedAt = change.approvals[0]?.decidedAt ?? null;

  const entries: PreCheckEntry[] = [];
  const failures: string[] = [];
  const failedHostnames = new Set<string>();

  for (const link of change.devices) {
    const hostname = link.device.hostname;

    // (a) Reachability — OFFLINE devices fail fast (mirrors the backup engine).
    if ((link.device.status ?? "").toUpperCase() === "OFFLINE") {
      const detail = "Device state OFFLINE — connect skipped";
      entries.push({ name: `Reachability — ${hostname}`, status: "FAILED", detail });
      failures.push(`${hostname}: ${detail}`);
      failedHostnames.add(hostname);
      continue;
    }
    let reachable = false;
    let reachDetail: string;
    if (isLiveDeviceLink(link)) {
      // Phase 23 — LIVE plane: a REAL SSH probe (read-only) through the
      // worker with the device's credential block (vault REFERENCE only).
      const credential = credentialBlockOf(link);
      if (!credential) {
        reachDetail = "LIVE_SSH device has no credential profile — link an SSH credential first";
      } else {
        try {
          const call = await workerDevicePost(
            "/simulate/connect",
            {
              vendor: link.device.vendor.key,
              host: link.device.mgmtIp ?? hostname,
              hostname,
              dataSource: "LIVE_SSH",
              credential,
              // SAFE-001 — pinned probe; unenrolled → the worker refuses
              // (SSH_HOSTKEY_UNENROLLED) and the pre-check fails closed.
              sshHostKeyPin: await hostKeyPinOf(link),
            },
            15_000
          );
          if (call.kind === "ok") {
            reachable = true;
            reachDetail = `reachable over real SSH (${String(call.json.latencyMs ?? "?")} ms)`;
          } else {
            reachDetail = `unreachable — ${call.message}`;
          }
        } catch (error) {
          reachDetail = `unreachable — ${(error as Error).message}`;
        }
      }
    } else {
      try {
        const sim = await workerSimPost(
          "/simulate/connect",
          {
            vendor: link.device.vendor.key,
            host: link.device.mgmtIp ?? hostname,
            hostname,
          },
          5_000
        );
        reachable = true;
        reachDetail = `reachable via ${String(sim.negotiated ?? "ssh2")} (${String(sim.latencyMs ?? "?")} ms)`;
      } catch (error) {
        reachDetail = `unreachable — ${(error as Error).message}`;
      }
    }
    entries.push({
      name: `Reachability — ${hostname}`,
      status: reachable ? "PASSED" : "FAILED",
      detail: reachDetail,
    });
    if (!reachable) {
      failures.push(`${hostname}: ${reachDetail}`);
      failedHostnames.add(hostname);
      continue;
    }

    // (b) Config-changed-since-approval BLOCK.
    if (approvalDecidedAt) {
      const [snapshotAtApproval, currentNow] = await Promise.all([
        db.configSnapshot.findFirst({
          where: { deviceId: link.deviceId, createdAt: { lte: approvalDecidedAt } },
          orderBy: { createdAt: "desc" },
          select: { version: true, sha256: true },
        }),
        db.configSnapshot.findFirst({
          where: { deviceId: link.deviceId, status: "CURRENT" },
          orderBy: { version: "desc" },
          select: { version: true, sha256: true, createdAt: true },
        }),
      ]);
      if (
        snapshotAtApproval &&
        currentNow &&
        snapshotAtApproval.sha256 !== currentNow.sha256 &&
        approvalDecidedAt.getTime() < currentNow.createdAt.getTime()
      ) {
        // The config moved AFTER the latest approval decision and no newer
        // approval exists — block and demand re-approval.
        const detail = `Config changed on ${hostname} since approval (v${snapshotAtApproval.version} → v${currentNow.version}) — re-approval required`;
        entries.push({
          name: `Config unchanged since approval — ${hostname}`,
          status: "FAILED",
          detail,
        });
        failures.push(`${hostname}: ${detail}`);
        failedHostnames.add(hostname);
        continue;
      }
      entries.push({
        name: `Config unchanged since approval — ${hostname}`,
        status: "PASSED",
        detail: snapshotAtApproval
          ? `sha ${shortSha(snapshotAtApproval.sha256)} matches latest CURRENT`
          : "no prior snapshot — first execution",
      });
    }
  }

  const failed = failures.length > 0;
  await db.$transaction(
    async (tx) => {
      await tx.changeStep.update({
        where: { id: step.id },
        data: {
          status: failed ? "FAILED" : "PASSED",
          finishedAt: new Date(),
          output: failed
            ? null
            : `All ${change.devices.length} device${
                change.devices.length === 1 ? "" : "s"
              } reachable · config unchanged since approval`,
          error: failed ? failures.join(" · ") : null,
        },
      });

      // Merge pre-check results (earlier entries preserved).
      const current = await tx.changeRequest.findUnique({
        where: { id: change.id },
        select: { preChecksJson: true },
      });
      await tx.changeRequest.update({
        where: { id: change.id },
        data: { preChecksJson: mergePreChecks(current?.preChecksJson ?? null, entries) },
      });

      if (failed) {
        // Nothing applied — no rollback steps. Failed devices FAILED, rest SKIPPED.
        for (const link of change.devices) {
          await tx.changeDevice.update({
            where: { id: link.id },
            data: { result: failedHostnames.has(link.device.hostname) ? "FAILED" : "SKIPPED" },
          });
        }
        await tx.changeRequest.update({
          where: { id: change.id },
          data: { status: "FAILED" },
        });
        await tx.auditEvent.create({
          data: {
            actorName: "system:change-engine",
            action: "CHANGE_FAILED",
            resourceType: "ChangeRequest",
            resourceId: change.id,
            resourceLabel: change.number,
            result: "FAILURE",
            correlationId,
            afterJson: JSON.stringify({ reason: "pre-check", failures }),
          },
        });
      }
    },
    { maxWait: 5_000, timeout: 20_000 }
  );

  if (failed) {
    return buildResponse(change.id, {
      done: true,
      outcome: "FAILED",
      suggestIncident: true,
      message: "Pre-check failed — change FAILED before anything was applied",
    });
  }
  return buildResponse(change.id, {
    done: false,
    message: "Pre-checks passed",
  });
}

/* ───────────────────────────── BACKUP step ───────────────────────────── */

async function executeBackupStep(
  change: ChangeWithRelations,
  step: StepRow,
  correlationId: string,
  jobId: string
) {
  // The first BACKUP (no APPLY before it in the plan) is the pre-change
  // backup; every later one — post-change and post-rollback — is POST_CHANGE.
  const isPreChange = !change.steps.some(
    (candidate) => candidate.type === "APPLY" && candidate.order < step.order
  );
  const source = isPreChange ? "PRE_CHANGE" : "POST_CHANGE";

  const generated = new Map<string, string>();
  const backups: string[] = [];
  const backupFailures: string[] = [];

  for (const link of change.devices) {
    if (isLiveDeviceLink(link)) {
      // Phase 23 — LIVE plane: collect the REAL running config over SSH.
      const credential = credentialBlockOf(link);
      if (!credential) {
        backupFailures.push(
          `${link.device.hostname}: LIVE_SSH without a credential profile`
        );
        continue;
      }
      try {
        const call = await workerDevicePost(
          "/live/fetch-config",
          {
            vendor: link.device.vendor.key,
            host: link.device.mgmtIp ?? link.device.hostname,
            hostname: link.device.hostname,
            deviceId: link.deviceId,
            credential,
            // SAFE-001 — pinned collection (fail-closed when unenrolled).
            sshHostKeyPin: await hostKeyPinOf(link),
          },
          25_000
        );
        if (call.kind === "ok") {
          generated.set(link.deviceId, String(call.json.configText ?? ""));
          backups.push(
            `${link.device.hostname} live config collected (${
              String(call.json.configFlavor ?? "live")
            }, ${String(call.json.bytes ?? "?")} bytes)`
          );
        } else {
          backupFailures.push(`${link.device.hostname}: ${call.message}`);
        }
      } catch (error) {
        backupFailures.push(`${link.device.hostname}: ${(error as Error).message}`);
      }
    } else {
      // SIMULATOR plane (unchanged).
      const sim = await workerSimPost(
        "/simulate/generate-config",
        {
          hostname: link.device.hostname,
          flavor: link.device.vendor.key,
          managementIp: link.device.mgmtIp,
        },
        10_000
      );
      generated.set(link.deviceId, String(sim.configText ?? ""));
    }
  }

  if (backupFailures.length > 0) {
    // A device whose config cannot be collected must never be applied to
    // (nothing has been applied yet → the change fails BEFORE the apply,
    // exactly like a failed pre-check).
    await db.$transaction(
      async (tx) => {
        await tx.changeStep.update({
          where: { id: step.id },
          data: {
            status: "FAILED",
            finishedAt: new Date(),
            error: `Pre-change backup failed — nothing was applied: ${backupFailures.join(" · ")}`,
          },
        });
        for (const link of change.devices) {
          await tx.changeDevice.update({
            where: { id: link.id },
            data: { result: "SKIPPED" },
          });
        }
        await tx.changeRequest.update({
          where: { id: change.id },
          data: { status: "FAILED" },
        });
        await tx.auditEvent.create({
          data: {
            actorName: "system:change-engine",
            action: "CHANGE_FAILED",
            resourceType: "ChangeRequest",
            resourceId: change.id,
            resourceLabel: change.number,
            result: "FAILURE",
            correlationId,
            afterJson: JSON.stringify({
              reason: "pre-change backup",
              dataSource: "LIVE_SSH",
              failures: backupFailures,
            }),
          },
        });
      },
      { maxWait: 5_000, timeout: 20_000 }
    );
    return buildResponse(change.id, {
      done: true,
      outcome: "FAILED",
      suggestIncident: true,
      message: "Pre-change backup failed — change FAILED before anything was applied",
    });
  }

  const outputs: string[] = [];
  await db.$transaction(
    async (tx) => {
      for (const link of change.devices) {
        const rawText = generated.get(link.deviceId) ?? "";
        const reused = await snapshotForJob(tx as unknown as TxClient, link.deviceId, jobId, source);
        const snapshot =
          reused ??
          (
            await createSnapshot(tx as unknown as TxClient, {
              deviceId: link.deviceId,
              rawText,
              source,
              changeId: change.id,
              jobId,
              correlationId,
              actorName: "system:change-engine",
            })
          );
        if (!snapshot.ok) {
          throw new Error(`Device ${link.device.hostname} disappeared during backup step`);
        }
        outputs.push(
          isLiveDeviceLink(link) && backups.length > 0
            ? `${link.device.hostname} v${snapshot.version} captured LIVE (sha ${shortSha(snapshot.sha256)})`
            : `${link.device.hostname} v${snapshot.version} captured (sha ${shortSha(snapshot.sha256)})`
        );
      }

      await tx.changeStep.update({
        where: { id: step.id },
        data: {
          status: "PASSED",
          finishedAt: new Date(),
          output: `${isPreChange ? "Pre-change" : "Post-change"} backup — ${outputs.join(" · ")}`,
          error: null,
        },
      });
    },
    { maxWait: 5_000, timeout: 20_000 }
  );

  return buildResponse(change.id, {
    done: false,
    message: `Snapshot captured (${source})`,
  });
}

/* ───────────────────────────── APPLY step ────────────────────────────── */

async function executeApplyStep(
  change: ChangeWithRelations,
  step: StepRow,
  correlationId: string,
  jobId: string,
  failAt: "APPLY" | "VALIDATE" | null,
  payload: Record<string, unknown>
) {
  const now = new Date();
  const slug = changeSlugFromTitle(change.title);

  // ── SAFE-008: typed restore operation (snapshot-exact, simulator plane) ──
  // A restore-flow change carries its approved target on restoreSnapshotId
  // (stamped once at creation, immutable). The dedicated executor consumes
  // that snapshot as the desired configuration — the generic
  // description-marker plan below NEVER runs for a restore change, closing
  // the audit's P0-004 ("restore does not restore the selected snapshot").
  if (isRestoreOperation(change.operationKind)) {
    return executeRestoreApplyStep(change, step, correlationId, jobId, failAt, payload);
  }

  // ── SAFE-006: fail-fast multi-device APPLY ──
  // The loop STOPS at the first device failure (device-level or transport):
  // no later device is contacted, so the blast radius is exactly the devices
  // actually reached. Devices after the stop have NO attempt — the
  // classifier records them SKIPPED (never-contacted), never FAILED.
  const results = new Map<string, ApplyAttempt>();
  let applyStopped = false;

  for (const link of change.devices) {
    if (applyStopped) continue; // SAFE-006 — no further device contact
    if (isLiveDeviceLink(link)) {
      // ── LIVE plane (Phase 23): controlled apply over real SSH ──
      if (failAt === "APPLY") {
        // Demo control NEVER contacts live devices — the failure is
        // injected engine-side so a demo run can't fault real hardware.
        // refusedBeforeContact ⇒ the classifier records the device SKIPPED
        // (provably unmodified — never FAILED), and the loop stops here.
        results.set(link.deviceId, {
          ok: false,
          configText: "",
          error: "Demo control failAt=APPLY — live apply suppressed before device contact",
          refusedBeforeContact: true,
        });
        applyStopped = true;
        continue;
      }
      try {
        // Runs the plan-based controlled apply + collects the REAL
        // post-apply running config (becomes the POST_CHANGE snapshot).
        const result = await applyLiveDevice(change, link, jobId, slug);
        results.set(link.deviceId, result);
        if (!result.ok) applyStopped = true;
      } catch (error) {
        // Transport-level throw (worker unreachable / 5xx) — fail-fast
        // applies here too: with the transport down, later devices would
        // only burn timeouts. The step as a whole retries (the driver's
        // backoff re-claims the step; SAFE-003/004's single-flight + CAS
        // claim serialize the attempts; the live plan itself is
        // content-idempotent — the same slug rewrites the same
        // description), and devices already applied keep their truthful
        // SUCCESS state + POST_CHANGE snapshot for the audit trail.
        results.set(link.deviceId, {
          ok: false,
          configText: "",
          error: (error as Error).message,
        });
        applyStopped = true;
      }
      continue;
    }

    // ── SIMULATOR plane ──
    try {
      const sim = await workerSimPost(
        "/simulate/apply",
        {
          hostname: link.device.hostname,
          flavor: link.device.vendor.key,
          changeTitle: change.title,
          failAt,
        },
        10_000
      );
      results.set(link.deviceId, { ok: true, configText: String(sim.configText ?? "") });
    } catch (error) {
      results.set(link.deviceId, {
        ok: false,
        configText: "",
        error: (error as Error).message,
      });
      applyStopped = true;
    }
  }

  // SAFE-006 — truthful per-device dispositions (pure classifier, unit-
  // pinned in tests/audit/apply-failfast.test.ts). Rows are 1:1 with
  // change.devices in order.
  const summary = classifyApplyDispositions(
    change.devices.map((link) => ({
      deviceId: link.deviceId,
      hostname: link.device.hostname,
      attempt: results.get(link.deviceId),
    }))
  );
  const anyFailure = !summary.allApplied;
  const outputs: string[] = [];

  await db.$transaction(
    async (tx) => {
      if (anyFailure) {
        // SAFE-006 — truthful per-device states on failure:
        //   SUCCESS → actually applied: keeps SUCCESS and its collected
        //             post-apply config is recorded as a POST_CHANGE
        //             snapshot (the audit trail must show what the device
        //             really runs now — the pre-SAFE-006 code labeled these
        //             devices SKIPPED and discarded their configs);
        //   FAILED  → the contacted device whose apply failed (the stopper);
        //   SKIPPED → provably never contacted.
        const appliedSnapshots: { hostname: string; version: number; sha256: string }[] = [];
        for (let index = 0; index < change.devices.length; index += 1) {
          const link = change.devices[index];
          const row = summary.rows[index];
          if (!link || !row) continue; // defensive — rows are 1:1 with devices
          if (row.result === "SUCCESS" && row.snapshotText !== null) {
            const reused = await snapshotForJob(
              tx as unknown as TxClient,
              link.deviceId,
              jobId,
              "POST_CHANGE"
            );
            const snapshot =
              reused ??
              (
                await createSnapshot(tx as unknown as TxClient, {
                  deviceId: link.deviceId,
                  rawText: row.snapshotText,
                  source: "POST_CHANGE",
                  changeId: change.id,
                  jobId,
                  correlationId,
                  actorName: "system:change-engine",
                  // The device really took a new config.
                  bumpLastConfigChangeAt: true,
                })
              );
            if (!snapshot.ok) {
              throw new Error(`Device ${link.device.hostname} disappeared during apply step`);
            }
            appliedSnapshots.push({
              hostname: link.device.hostname,
              version: snapshot.version,
              sha256: snapshot.sha256,
            });
          }
          await tx.changeDevice.update({
            where: { id: link.id },
            data: { result: row.result },
          });
        }
        await tx.changeStep.update({
          where: { id: step.id },
          data: {
            status: "FAILED",
            finishedAt: now,
            error: applyFailFastStepError(summary),
          },
        });
        const auditDetail = applyFailFastAuditDetail(summary);
        if (auditDetail) {
          await tx.auditEvent.create({
            data: {
              actorName: "system:change-engine",
              action: APPLY_FAIL_FAST_AUDIT_ACTION,
              resourceType: "ChangeRequest",
              resourceId: change.id,
              resourceLabel: change.number,
              result: "FAILURE",
              correlationId,
              afterJson: JSON.stringify({ ...auditDetail, appliedSnapshots }),
            },
          });
        }
        await engageRollback(tx as unknown as TxClient, change.id, change.steps);
        return;
      }

      for (const link of change.devices) {
        const result = results.get(link.deviceId);
        const reused = await snapshotForJob(tx as unknown as TxClient, link.deviceId, jobId, "POST_CHANGE");
        const snapshot =
          reused ??
          (
            await createSnapshot(tx as unknown as TxClient, {
              deviceId: link.deviceId,
              rawText: result?.configText ?? "",
              source: "POST_CHANGE",
              changeId: change.id,
              jobId,
              correlationId,
              actorName: "system:change-engine",
              // A real config push also stamps the device's change timestamp.
              bumpLastConfigChangeAt: true,
            })
          );
        if (!snapshot.ok) {
          throw new Error(`Device ${link.device.hostname} disappeared during apply step`);
        }
        await tx.changeDevice.update({
          where: { id: link.id },
          data: { result: "SUCCESS" },
        });
        outputs.push(
          `${link.device.hostname} applied → snapshot v${snapshot.version} (sha ${shortSha(snapshot.sha256)})`
        );
      }

      await tx.changeStep.update({
        where: { id: step.id },
        data: {
          status: "PASSED",
          finishedAt: now,
          output: `Configuration applied — ${outputs.join(" · ")}`,
          error: null,
        },
      });
    },
    { maxWait: 5_000, timeout: 20_000 }
  );

  if (anyFailure) {
    await consumeFailAt(jobId, payload);
    const uncontactedCount = summary.uncontactedHostnames.length;
    return buildResponse(change.id, {
      done: false,
      message:
        `Apply failed at ${summary.stopHostname ?? "device"} — fail-fast: ` +
        (uncontactedCount > 0
          ? `${uncontactedCount} remaining device(s) not contacted; `
          : "") +
        "rollback engaged",
    });
  }
  return buildResponse(change.id, {
    done: false,
    message: "Configuration applied",
  });
}

/* ─────────── SAFE-008/009: typed snapshot-exact restore (simulator plane) ── */

/**
 * SAFE-008 — load + decrypt the approved restore target and classify it.
 * The decrypt layer (decryptSnapshotTexts) already enforces the stored
 * sha256 digest (CONFIG_INTEGRITY_FAIL on mismatch); a throw maps to the
 * typed RESTORE_TARGET_INTEGRITY refusal — unverified bytes are never
 * pushed anywhere.
 */
async function resolveRestoreTarget(
  change: ChangeWithRelations
): Promise<RestoreTargetVerdict> {
  const id = change.restoreSnapshotId ?? null;
  let target: RestoreTargetData | null = null;
  let rawTextPresent = false;
  if (id) {
    const row = await db.configSnapshot.findUnique({
      where: { id },
      select: {
        id: true,
        deviceId: true,
        version: true,
        sha256: true,
        rawText: true,
        encKeyId: true,
        encIv: true,
        encTag: true,
        normIv: true,
        normTag: true,
        wrappedDek: true,
        encAad: true, // AAD binding (CRYPTO-101) — required by decryptSnapshotTexts
        wrapIv: true,
        wrapTag: true,
      },
    });
    if (row) {
      try {
        const rawText = decryptSnapshotTexts(row).rawText;
        rawTextPresent = true;
        target = {
          id: row.id,
          deviceId: row.deviceId,
          version: row.version,
          sha256: row.sha256,
          rawText,
        };
      } catch {
        rawTextPresent = false; // digest mismatch — classified as integrity failure
      }
    }
  }
  return classifyRestoreTarget({
    restoreSnapshotId: id,
    target,
    rawTextPresent,
    changeDeviceIds: change.devices.map((link) => link.deviceId),
  });
}

/**
 * SAFE-008 — shared fail-closed restore refusal: step FAILED, every device
 * SKIPPED (provably never contacted), change FAILED, typed RESTORE_REFUSED
 * audit event. No rollback — nothing was modified.
 */
async function refuseRestore(
  change: ChangeWithRelations,
  step: StepRow,
  correlationId: string,
  detail: { error: string; reason: string; extra: Record<string, unknown> }
): Promise<void> {
  const now = new Date();
  await db.$transaction(
    async (tx) => {
      await tx.changeStep.update({
        where: { id: step.id },
        data: { status: "FAILED", finishedAt: now, error: detail.error },
      });
      for (const link of change.devices) {
        await tx.changeDevice.update({
          where: { id: link.id },
          data: { result: "SKIPPED" },
        });
      }
      await tx.changeRequest.update({
        where: { id: change.id },
        data: { status: "FAILED" },
      });
      await tx.auditEvent.create({
        data: {
          actorName: "system:change-engine",
          action: RESTORE_REFUSED_AUDIT_ACTION,
          resourceType: "ChangeRequest",
          resourceId: change.id,
          resourceLabel: change.number,
          result: "FAILURE",
          correlationId,
          afterJson: JSON.stringify({
            reason: detail.reason,
            operationKind: change.operationKind,
            devices: change.devices.length,
            ...detail.extra,
          }),
        },
      });
    },
    { maxWait: 5_000, timeout: 20_000 }
  );
}

/**
 * SAFE-008 — snapshot-exact restore APPLY (simulator plane). The approved
 * snapshot's raw text IS the desired configuration: the worker's typed
 * /simulate/restore commit verifies sha256(text) BEFORE committing (409
 * otherwise) and echoes the committed bytes; the engine records the echo as
 * the job's POST_CHANGE snapshot and re-asserts the echo (SAFE-009) inside
 * the same transaction. Fail-fast (SAFE-006 semantics) and the truthful
 * disposition classifier are reused unchanged; the rollback machinery needs
 * no restore-specific handling (the job's PRE_CHANGE backup IS the
 * pre-restore restore point).
 *
 * Refusals (fail-closed, zero device contact):
 *   - RESTORE_TARGET_UNRESOLVABLE family — unresolvable/tampered target;
 *   - LIVE_RESTORE_NOT_CERTIFIED — any LIVE_SSH device in scope (the live
 *     transport is certified for bounded description-marker deltas only;
 *     full-config pushes need per-flavor vendor certification).
 */
async function executeRestoreApplyStep(
  change: ChangeWithRelations,
  step: StepRow,
  correlationId: string,
  jobId: string,
  failAt: "APPLY" | "VALIDATE" | null,
  payload: Record<string, unknown>
) {
  const now = new Date();

  // 1. Resolve the approved target BEFORE any device contact.
  const verdict = await resolveRestoreTarget(change);
  if (!verdict.ok) {
    await refuseRestore(change, step, correlationId, {
      error: verdict.message,
      reason: verdict.code,
      extra: {
        restoreSnapshotId: change.restoreSnapshotId ?? null,
        devices: change.devices.length,
      },
    });
    return buildResponse(change.id, {
      done: true,
      outcome: "FAILED",
      suggestIncident: true,
      message:
        "Restore refused — the approved snapshot target could not be resolved; no device was contacted",
    });
  }
  const target = verdict.target;

  // 2. LIVE boundary — capability refusal, not an implementation gap.
  if (change.devices.some((link) => isLiveDeviceLink(link))) {
    await refuseRestore(change, step, correlationId, {
      error: LIVE_RESTORE_NOT_CERTIFIED,
      reason: "LIVE_RESTORE_NOT_CERTIFIED",
      extra: {
        restoreSnapshotId: target.id,
        targetVersion: target.version,
        devices: change.devices.length,
      },
    });
    return buildResponse(change.id, {
      done: true,
      outcome: "FAILED",
      suggestIncident: true,
      message: `Live restore refused — full-config pushes are not vendor-certified (snapshot v${target.version} NOT pushed); no device was contacted`,
    });
  }

  // 3. Simulator plane — snapshot-exact commit, fail-fast.
  const results = new Map<string, ApplyAttempt>();
  let applyStopped = false;
  for (const link of change.devices) {
    if (applyStopped) continue; // SAFE-006 — no further device contact
    try {
      const sim = await workerSimPost(
        "/simulate/restore",
        {
          hostname: link.device.hostname,
          flavor: link.device.vendor.key,
          configText: target.rawText,
          expectedSha256: target.sha256,
          failAt,
        },
        15_000
      );
      const committedText = String(sim.configText ?? "");
      if (!committedText || !isRestoreCommitSizeOk(committedText)) {
        results.set(link.deviceId, {
          ok: false,
          configText: "",
          error: "restore commit echo invalid (empty or over the size bound)",
        });
        applyStopped = true;
        continue;
      }
      results.set(link.deviceId, { ok: true, configText: committedText });
    } catch (error) {
      // Transport-level failure (worker unreachable / 4xx / 5xx): fail-fast
      // — with the data plane down, later devices would only burn timeouts.
      results.set(link.deviceId, {
        ok: false,
        configText: "",
        error: (error as Error).message,
      });
      applyStopped = true;
    }
  }

  // 4. SAFE-006 classifier + write transaction (echo gate inside).
  const summary = classifyApplyDispositions(
    change.devices.map((link) => ({
      deviceId: link.deviceId,
      hostname: link.device.hostname,
      attempt: results.get(link.deviceId),
    }))
  );
  const anyFailure = !summary.allApplied;
  const echoMismatches: {
    hostname: string;
    committedSha: string;
    targetSha: string;
  }[] = [];
  const outputs: string[] = [];
  const restored: { hostname: string; version: number; sha256: string }[] = [];
  let echoGateFailed = false;

  await db.$transaction(
    async (tx) => {
      if (anyFailure) {
        // Truthful per-device failure semantics — identical contract to the
        // generic apply (APPLY_FAIL_FAST carries the disposition map).
        const appliedSnapshots: {
          hostname: string;
          version: number;
          sha256: string;
        }[] = [];
        for (let index = 0; index < change.devices.length; index += 1) {
          const link = change.devices[index];
          const row = summary.rows[index];
          if (!link || !row) continue;
          if (row.result === "SUCCESS" && row.snapshotText !== null) {
            const reused = await snapshotForJob(
              tx as unknown as TxClient,
              link.deviceId,
              jobId,
              "POST_CHANGE"
            );
            const snapshot =
              reused ??
              (
                await createSnapshot(tx as unknown as TxClient, {
                  deviceId: link.deviceId,
                  rawText: row.snapshotText,
                  source: "POST_CHANGE",
                  changeId: change.id,
                  jobId,
                  correlationId,
                  actorName: "system:change-engine",
                  bumpLastConfigChangeAt: true,
                })
              );
            if (!snapshot.ok) {
              throw new Error(
                `Device ${link.device.hostname} disappeared during restore step`
              );
            }
            appliedSnapshots.push({
              hostname: link.device.hostname,
              version: snapshot.version,
              sha256: snapshot.sha256,
            });
          }
          await tx.changeDevice.update({
            where: { id: link.id },
            data: { result: row.result },
          });
        }
        await tx.changeStep.update({
          where: { id: step.id },
          data: {
            status: "FAILED",
            finishedAt: now,
            error: applyFailFastStepError(summary),
          },
        });
        const auditDetail = applyFailFastAuditDetail(summary);
        if (auditDetail) {
          await tx.auditEvent.create({
            data: {
              actorName: "system:change-engine",
              action: APPLY_FAIL_FAST_AUDIT_ACTION,
              resourceType: "ChangeRequest",
              resourceId: change.id,
              resourceLabel: change.number,
              result: "FAILURE",
              correlationId,
              afterJson: JSON.stringify({ ...auditDetail, appliedSnapshots }),
            },
          });
        }
        // Rollback of a failed restore = re-apply the job's PRE_CHANGE
        // (pre-restore backup) — the generic rollback machinery already
        // resolves exactly that restore source.
        await engageRollback(tx as unknown as TxClient, change.id, change.steps);
        return;
      }

      // Success path — record the commit echo, gate it, audit the restore.
      for (const link of change.devices) {
        const result = results.get(link.deviceId);
        const reused = await snapshotForJob(
          tx as unknown as TxClient,
          link.deviceId,
          jobId,
          "POST_CHANGE"
        );
        const snapshot =
          reused ??
          (
            await createSnapshot(tx as unknown as TxClient, {
              deviceId: link.deviceId,
              rawText: result?.configText ?? "",
              source: "POST_CHANGE",
              changeId: change.id,
              jobId,
              correlationId,
              actorName: "system:change-engine",
              // The device really took a new (the approved) configuration.
              bumpLastConfigChangeAt: true,
            })
          );
        if (!snapshot.ok) {
          throw new Error(
            `Device ${link.device.hostname} disappeared during restore step`
          );
        }
        if (restoreCommitEchoOk(snapshot.sha256, target.sha256)) {
          await tx.changeDevice.update({
            where: { id: link.id },
            data: { result: "SUCCESS" },
          });
          outputs.push(
            `${link.device.hostname} restored → snapshot v${snapshot.version} (sha ${shortSha(snapshot.sha256)})`
          );
          restored.push({
            hostname: link.device.hostname,
            version: snapshot.version,
            sha256: snapshot.sha256,
          });
        } else {
          // Defensive: the worker refuses sha-mismatched commits (409), so a
          // SUCCESS attempt whose recorded digest differs means the echo was
          // corrupted in transit. Fail closed — no blind rollback against a
          // data plane whose state cannot be trusted.
          echoMismatches.push({
            hostname: link.device.hostname,
            committedSha: snapshot.sha256,
            targetSha: target.sha256,
          });
          await tx.changeDevice.update({
            where: { id: link.id },
            data: { result: "FAILED" },
          });
        }
      }

      if (echoMismatches.length > 0) {
        echoGateFailed = true;
        await tx.changeStep.update({
          where: { id: step.id },
          data: {
            status: "FAILED",
            finishedAt: now,
            error: `RESTORE_COMMIT_ECHO_MISMATCH — committed config does not equal the approved snapshot for: ${echoMismatches
              .map((m) => m.hostname)
              .join(", ")}`,
          },
        });
        await tx.changeRequest.update({
          where: { id: change.id },
          data: { status: "FAILED" },
        });
        await tx.auditEvent.create({
          data: {
            actorName: "system:change-engine",
            action: RESTORE_REFUSED_AUDIT_ACTION,
            resourceType: "ChangeRequest",
            resourceId: change.id,
            resourceLabel: change.number,
            result: "FAILURE",
            correlationId,
            afterJson: JSON.stringify({
              reason: "RESTORE_COMMIT_ECHO_MISMATCH",
              targetSnapshot: {
                id: target.id,
                version: target.version,
                sha256: target.sha256,
              },
              mismatches: echoMismatches,
            }),
          },
        });
        return;
      }

      await tx.changeStep.update({
        where: { id: step.id },
        data: {
          status: "PASSED",
          finishedAt: now,
          output: `Snapshot restore committed (approved v${target.version}, sha ${shortSha(
            target.sha256
          )}) — ${outputs.join(" · ")}`,
          error: null,
        },
      });
      await tx.auditEvent.create({
        data: {
          actorName: "system:change-engine",
          action: RESTORE_APPLIED_AUDIT_ACTION,
          resourceType: "ChangeRequest",
          resourceId: change.id,
          resourceLabel: change.number,
          result: "SUCCESS",
          correlationId,
          afterJson: JSON.stringify({
            targetSnapshot: {
              id: target.id,
              version: target.version,
              sha256: target.sha256,
            },
            restored,
          }),
        },
      });
    },
    { maxWait: 5_000, timeout: 20_000 }
  );

  if (anyFailure) {
    await consumeFailAt(jobId, payload);
    const uncontactedCount = summary.uncontactedHostnames.length;
    return buildResponse(change.id, {
      done: false,
      message:
        `Restore failed at ${summary.stopHostname ?? "device"} — fail-fast: ` +
        (uncontactedCount > 0
          ? `${uncontactedCount} remaining device(s) not contacted; `
          : "") +
        "rollback engaged",
    });
  }
  if (echoGateFailed) {
    return buildResponse(change.id, {
      done: true,
      outcome: "FAILED",
      suggestIncident: true,
      message:
        "Restore commit echo mismatch — the data plane did not return the approved bytes; change failed closed",
    });
  }
  return buildResponse(change.id, {
    done: false,
    message: `Snapshot restore committed — approved snapshot v${target.version} applied byte-exact`,
  });
}

/**
 * SAFE-009 — post-restore validation: the committed configuration recorded
 * by the APPLY step (the job's POST_CHANGE snapshot) must equal the approved
 * snapshot byte-exact (sha256 equality). No device re-contact: the simulator
 * plane is stateless by design, so the commit echo IS the truthful record of
 * what the plane committed; a LIVE validation path arrives with per-flavor
 * full-config certification. A mismatch fails the step and engages the
 * rollback (re-apply the pre-restore backup).
 */
async function executeRestoreValidateStep(
  change: ChangeWithRelations,
  step: StepRow,
  correlationId: string,
  jobId: string
) {
  const now = new Date();

  // Defensive re-resolution — APPLY refuses an unresolvable target first;
  // if it vanished between APPLY and VALIDATE the change still fails closed.
  const verdict = await resolveRestoreTarget(change);
  if (!verdict.ok) {
    await refuseRestore(change, step, correlationId, {
      error: verdict.message,
      reason: verdict.code,
      extra: { stage: "VALIDATE", restoreSnapshotId: change.restoreSnapshotId ?? null },
    });
    return buildResponse(change.id, {
      done: true,
      outcome: "FAILED",
      suggestIncident: true,
      message:
        "Restore validation refused — the approved snapshot target could not be resolved",
    });
  }
  const target = verdict.target;

  const rows: RestoreValidateRow[] = [];
  for (const link of change.devices) {
    const post = await db.configSnapshot.findFirst({
      where: { deviceId: link.deviceId, jobId, source: "POST_CHANGE" },
      orderBy: { version: "desc" },
      select: { sha256: true },
    });
    rows.push({
      hostname: link.device.hostname,
      committedSha: post?.sha256 ?? null,
      targetSha: target.sha256,
    });
  }
  const allOk = rows.every((row) => restoreCommitEchoOk(row.committedSha, row.targetSha));
  const outputs = buildRestoreValidateOutputs(rows);

  await db.$transaction(
    async (tx) => {
      await tx.changeStep.update({
        where: { id: step.id },
        data: {
          status: allOk ? "PASSED" : "FAILED",
          finishedAt: now,
          output: allOk ? `Post-restore validation — ${outputs.join(" · ")}` : null,
          error: allOk
            ? null
            : "Post-restore validation failed — committed config does not equal the approved snapshot",
        },
      });
      if (!allOk) {
        await engageRollback(tx as unknown as TxClient, change.id, change.steps);
      }
    },
    { maxWait: 5_000, timeout: 20_000 }
  );

  if (!allOk) {
    return buildResponse(change.id, {
      done: false,
      message: "Post-restore validation failed — rollback engaged",
    });
  }
  return buildResponse(change.id, {
    done: false,
    message:
      "Post-restore validation passed — committed config matches the approved snapshot byte-exact",
  });
}

/* ───────────── Phase 23: controlled apply against a live device ───────────── */

interface LiveApplyOutcome {
  ok: boolean;
  configText: string;
  error?: string;
}

/**
 * Run the CONTROLLED change for one LIVE_SSH device:
 *   1. resolve the anchor from THIS job's decrypted pre-change snapshot
 *      (fail closed — no anchor ⇒ no apply);
 *   2. /live/apply with the validated plan (the worker builds the
 *      commands; stop-on-first-rejection);
 *   3. /live/fetch-config to capture the REAL post-apply running config
 *      (becomes the POST_CHANGE snapshot upstream).
 *
 * Throws only on transport-level problems (worker unreachable / 5xx) so
 * the step retries; device-level failures return a typed outcome.
 */
async function applyLiveDevice(
  change: ChangeWithRelations,
  link: DeviceLink,
  jobId: string,
  slug: string
): Promise<LiveApplyOutcome> {
  const credential = credentialBlockOf(link);
  if (!credential) {
    return {
      ok: false,
      configText: "",
      error: "LIVE_SSH without a credential profile — link an SSH credential first",
    };
  }
  const flavor = liveFlavorOf(link);
  if (!flavor) {
    return {
      ok: false,
      configText: "",
      error: `Vendor "${link.device.vendor.key}" has no certified live plane — refusing to apply`,
    };
  }
  const preChange = await db.configSnapshot.findFirst({
    where: { deviceId: link.deviceId, changeId: change.id, jobId, source: "PRE_CHANGE" },
    orderBy: { version: "desc" },
    select: {
      rawText: true,
      version: true,
      sha256: true,
      encKeyId: true,
      encIv: true,
      encTag: true,
      normIv: true,
      normTag: true,
      wrappedDek: true,
      encAad: true, // AAD binding (CRYPTO-101) — required by decryptSnapshotTexts
      wrapIv: true,
      wrapTag: true,
    },
  });
  if (!preChange) {
    return {
      ok: false,
      configText: "",
      error: "no pre-change snapshot from this job — refusing to apply without a restore point",
    };
  }
  const rawText = decryptSnapshotTexts(preChange).rawText;
  const anchor = extractLiveAnchor(flavor, rawText);
  if (!anchor) {
    return {
      ok: false,
      configText: "",
      error: `no anchorable interface found in the pre-change snapshot (flavor ${flavor}) — refusing blind apply`,
    };
  }

  const host = link.device.mgmtIp ?? link.device.hostname;
  const deviceBody = {
    vendor: link.device.vendor.key,
    host,
    hostname: link.device.hostname,
    deviceId: link.deviceId,
    credential,
    // SAFE-001 — the controlled apply and every subsequent collection on
    // this endpoint ride on the pinned host key (fail-closed when null).
    sshHostKeyPin: await hostKeyPinOf(link),
  };

  const apply = await workerDevicePost(
    "/live/apply",
    { ...deviceBody, plan: { kind: "APPLY", anchor, slug } },
    40_000
  );
  if (apply.kind === "device-failure") {
    return { ok: false, configText: "", error: `apply: ${apply.message}` };
  }
  if (apply.json.applied !== true) {
    return {
      ok: false,
      configText: "",
      error: "apply: the device rejected the change commands (rollback plan required)",
    };
  }

  const fetchPost = await workerDevicePost("/live/fetch-config", deviceBody, 25_000);
  if (fetchPost.kind === "device-failure") {
    return {
      ok: false,
      configText: "",
      error: `post-apply collection failed: ${fetchPost.message}`,
    };
  }
  return {
    ok: true,
    configText: String(fetchPost.json.configText ?? ""),
  };
}

/* ──────────────────────────── VALIDATE step ──────────────────────────── */

async function executeValidateStep(
  change: ChangeWithRelations,
  step: StepRow,
  correlationId: string,
  jobId: string,
  failAt: "APPLY" | "VALIDATE" | null,
  payload: Record<string, unknown>
) {
  const now = new Date();

  if (failAt === "VALIDATE") {
    await db.$transaction(
      async (tx) => {
        await tx.changeStep.update({
          where: { id: step.id },
          data: {
            status: "FAILED",
            finishedAt: now,
            output: "Validation failed: post-change checks report errors (simulated)",
            error: "Post-change validation reported errors (simulated failure)",
          },
        });
        await engageRollback(tx as unknown as TxClient, change.id, change.steps);
      },
      { maxWait: 5_000, timeout: 20_000 }
    );
    await consumeFailAt(jobId, payload);
    void correlationId;
    return buildResponse(change.id, {
      done: false,
      message: "Validation failed — rollback engaged",
    });
  }

  // Phase 23 — LIVE devices: a REAL post-change assertion — re-fetch the
  // running config over SSH and confirm the applied description marker is
  // present in the live config (the same slug the APPLY plan used).
  // SAFE-006 — context-aware: while the change is in ROLLBACK (the appended
  // "Post-rollback validation" step) the truthful assertion INVERTS — a
  // restored device must NOT carry the applied marker anymore (its presence
  // means the restore failed) — and SKIPPED devices (the fail-fast apply
  // provably never contacted them) need neither contact nor assertion.
  // (Pre-SAFE-006 this step asserted marker-PRESENT in both contexts: a
  // restored device failed validation forever and each failure re-engaged
  // rollback unboundedly.)
  const postRollback = isPostRollbackValidateContext(change.status);

  // SAFE-008/009 — a restore change validates sha-exact against the approved
  // snapshot (the commit echo), not the description-marker assertion. The
  // appended post-rollback VALIDATE of a FAILED restore falls through to the
  // generic context-aware path: restore changes are simulator-only (live
  // restore is refused at APPLY) and no marker semantics exist, so its
  // truthful per-device notes apply unchanged.
  if (isRestoreOperation(change.operationKind) && !postRollback) {
    return executeRestoreValidateStep(change, step, correlationId, jobId);
  }

  const outputs: string[] = [];
  const validateFailures: string[] = [];
  for (const link of change.devices) {
    if (!isLiveDeviceLink(link)) {
      if (postRollback && link.result === "SKIPPED") {
        outputs.push(
          `${link.device.hostname} — not modified by the failed apply (fail-fast); nothing to validate`
        );
      } else {
        outputs.push(`${link.device.hostname} ok — running-config committed`);
      }
      continue;
    }
    if (postRollback && link.result === "SKIPPED") {
      outputs.push(
        `${link.device.hostname} — not modified by the failed apply (fail-fast); validation not required`
      );
      continue; // no contact with a provably-unmodified device
    }
    const credential = credentialBlockOf(link);
    const flavor = liveFlavorOf(link);
    if (!credential || !flavor) {
      validateFailures.push(
        `${link.device.hostname}: ${
          !credential ? "LIVE_SSH without a credential profile" : "uncertified live vendor"
        }`
      );
      continue;
    }
    try {
      const call = await workerDevicePost(
        "/live/fetch-config",
        {
          vendor: link.device.vendor.key,
          host: link.device.mgmtIp ?? link.device.hostname,
          hostname: link.device.hostname,
          deviceId: link.deviceId,
          credential,
          // SAFE-001 — pinned validation fetch (fail-closed when unenrolled).
          sshHostKeyPin: await hostKeyPinOf(link),
        },
        25_000
      );
      if (call.kind === "device-failure") {
        validateFailures.push(
          `${link.device.hostname}: post-change validation could not read the device — ${call.message}`
        );
        continue;
      }
      const marker = expectedDescriptionMarker(flavor, changeSlugFromTitle(change.title));
      const normalized = String(call.json.normalizedText ?? "");
      const markerPresent = normalized.includes(marker);
      if (postRollback) {
        if (markerPresent) {
          validateFailures.push(
            `${link.device.hostname}: applied marker still present after rollback — restore did not complete`
          );
        } else {
          outputs.push(
            `${link.device.hostname} ok — pre-change state confirmed (applied marker absent)`
          );
        }
      } else if (markerPresent) {
        outputs.push(
          `${link.device.hostname} ok — change marker present in the live running config`
        );
      } else {
        validateFailures.push(
          `${link.device.hostname}: applied marker "${marker}" not present in the live running config`
        );
      }
    } catch (error) {
      validateFailures.push(`${link.device.hostname}: ${(error as Error).message}`);
    }
  }

  if (validateFailures.length > 0) {
    await db.$transaction(
      async (tx) => {
        await tx.changeStep.update({
          where: { id: step.id },
          data: {
            status: "FAILED",
            finishedAt: now,
            output: "Post-change validation failed against the live device(s)",
            error: validateFailures.join(" · "),
          },
        });
        await engageRollback(tx as unknown as TxClient, change.id, change.steps);
      },
      { maxWait: 5_000, timeout: 20_000 }
    );
    return buildResponse(change.id, {
      done: false,
      message: "Validation failed — rollback engaged",
    });
  }

  await db.$transaction(
    async (tx) => {
      await tx.changeStep.update({
        where: { id: step.id },
        data: {
          status: "PASSED",
          finishedAt: now,
          output: `Validation passed — ${outputs.join(" · ")}`,
          error: null,
        },
      });
    },
    { maxWait: 5_000, timeout: 20_000 }
  );

  return buildResponse(change.id, {
    done: false,
    message: "Validation passed",
  });
}

/* ──────────────────────────── ROLLBACK step ──────────────────────────── */

async function executeRollbackStep(
  change: ChangeWithRelations,
  step: StepRow,
  correlationId: string,
  jobId: string
) {
  const now = new Date();

  // Fallback window anchor: snapshots created before this job started. The
  // caller passes jobId (not the job row) — fetch the startedAt here.
  const job = await db.jobExecution.findUnique({
    where: { id: jobId },
    select: { startedAt: true },
  });
  if (change.status !== "ROLLBACK") {
    // A ROLLBACK step reached during a healthy run (user-authored plan) is
    // skipped — the rollback plan stayed on standby.
    await db.$transaction(
      async (tx) => {
        await tx.changeStep.update({
          where: { id: step.id },
          data: {
            status: "SKIPPED",
            finishedAt: now,
            output: "Not needed — no failure; rollback plan on standby",
          },
        });
      },
      { maxWait: 5_000, timeout: 20_000 }
    );
    return buildResponse(change.id, {
      done: false,
      message: "Rollback plan on standby — skipped",
    });
  }

  // SAFE-006 — restore ONLY the devices the failed apply actually reached.
  // A device the fail-fast apply provably never contacted (result SKIPPED)
  // must not be "restored" — that would be the first write it ever sees.
  // Unknown/null states (e.g. an orphaned apply reaped mid-flight before it
  // could write per-device results) stay restore targets — fail-safe.
  const restoreTargets = change.devices.filter((link) =>
    isRollbackRestoreTarget(link.result)
  );

  // Resolve restore sources OUTSIDE the write transaction.
  const restoreSources = new Map<string, { rawText: string; version: number; sha256: string }>();
  const missing: string[] = [];
  for (const link of restoreTargets) {
    const preChange = await db.configSnapshot.findFirst({
      where: { changeId: change.id, deviceId: link.deviceId, source: "PRE_CHANGE" },
      orderBy: { version: "desc" },
      select: {
        rawText: true,
        version: true,
        sha256: true,
        encKeyId: true,
        encIv: true,
        encTag: true,
        normIv: true,
        normTag: true,
        wrappedDek: true,
        encAad: true, // AAD binding (CRYPTO-101) — required by decryptSnapshotTexts
        wrapIv: true,
        wrapTag: true,
      },
    });
    if (preChange) {
      // P19 SEC-003: decrypt the stored envelope (legacy rows pass through).
      restoreSources.set(link.deviceId, {
        rawText: decryptSnapshotTexts(preChange).rawText,
        version: preChange.version,
        sha256: preChange.sha256,
      });
      continue;
    }
    // Fallback: the latest snapshot created before the job started.
    const fallback = await db.configSnapshot.findFirst({
      where: {
        deviceId: link.deviceId,
        ...(job?.startedAt ? { createdAt: { lt: job.startedAt } } : {}),
      },
      orderBy: { version: "desc" },
      select: {
        rawText: true,
        version: true,
        sha256: true,
        encKeyId: true,
        encIv: true,
        encTag: true,
        normIv: true,
        normTag: true,
        wrappedDek: true,
        encAad: true, // AAD binding (CRYPTO-101) — required by decryptSnapshotTexts
        wrapIv: true,
        wrapTag: true,
      },
    });
    if (fallback) {
      restoreSources.set(link.deviceId, {
        rawText: decryptSnapshotTexts(fallback).rawText,
        version: fallback.version,
        sha256: fallback.sha256,
      });
    } else {
      missing.push(link.device.hostname);
    }
  }

  if (missing.length > 0) {
    await db.$transaction(
      async (tx) => {
        await tx.changeStep.update({
          where: { id: step.id },
          data: {
            status: "FAILED",
            finishedAt: now,
            error: `Rollback failed — no pre-change snapshot to restore for: ${missing.join(", ")}`,
          },
        });
        await tx.changeRequest.update({
          where: { id: change.id },
          data: { status: "ROLLBACK_FAILED" },
        });
        await tx.auditEvent.create({
          data: {
            actorName: "system:change-engine",
            action: "CHANGE_FAILED",
            resourceType: "ChangeRequest",
            resourceId: change.id,
            resourceLabel: change.number,
            result: "FAILURE",
            correlationId,
            afterJson: JSON.stringify({ reason: "rollback", detail: "no pre-change snapshot" }),
          },
        });
      },
      { maxWait: 5_000, timeout: 20_000 }
    );
    return buildResponse(change.id, {
      done: true,
      outcome: "ROLLBACK_FAILED",
      suggestIncident: true,
      message: "Rollback FAILED — no pre-change snapshot available",
    });
  }

  // Phase 23 — LIVE devices: push the inverse plan (restore the original
  // description, or remove the line when the anchor carried none) over the
  // worker's controlled-change plane, then collect the REAL post-rollback
  // running config for the POST_CHANGE snapshot. Simulator devices keep the
  // historical behavior (the pre-change text IS the restored state).
  const liveCaptured = new Map<string, string>();
  const liveSkipped = new Set<string>();
  const rollbackFailures: string[] = [];

  for (const link of restoreTargets) {
    if (!isLiveDeviceLink(link)) continue;
    const source = restoreSources.get(link.deviceId);
    if (!source) continue; // handled by the missing path above
    const credential = credentialBlockOf(link);
    const flavor = liveFlavorOf(link);
    if (!credential || !flavor) {
      rollbackFailures.push(
        `${link.device.hostname}: ${
          !credential ? "LIVE_SSH without a credential profile" : "uncertified live vendor"
        }`
      );
      continue;
    }
    try {
      const anchor = extractLiveAnchor(flavor, source.rawText);
      if (!anchor) {
        // No anchor in the pre-change snapshot ⇒ the apply step refused
        // this device — nothing to restore.
        liveSkipped.add(link.deviceId);
        continue;
      }
      const original = extractOriginalDescription(flavor, source.rawText, anchor);
      if (original === LIVE_NO_ANCHOR) {
        liveSkipped.add(link.deviceId);
        continue;
      }
      const pin = await hostKeyPinOf(link);
      const rollback = await workerDevicePost(
        "/live/apply",
        {
          vendor: link.device.vendor.key,
          host: link.device.mgmtIp ?? link.device.hostname,
          hostname: link.device.hostname,
          deviceId: link.deviceId,
          credential,
          // SAFE-001 — pinned rollback (fail-closed when unenrolled).
          sshHostKeyPin: pin,
          plan: { kind: "ROLLBACK", anchor, slug: original },
        },
        40_000
      );
      if (rollback.kind === "device-failure") {
        rollbackFailures.push(`${link.device.hostname}: rollback — ${rollback.message}`);
        continue;
      }
      if (rollback.json.applied !== true) {
        rollbackFailures.push(
          `${link.device.hostname}: rollback — the device rejected the restore commands`
        );
        continue;
      }
      const fetchPost = await workerDevicePost(
        "/live/fetch-config",
        {
          vendor: link.device.vendor.key,
          host: link.device.mgmtIp ?? link.device.hostname,
          hostname: link.device.hostname,
          deviceId: link.deviceId,
          credential,
          // SAFE-001 — pinned post-rollback collection.
          sshHostKeyPin: pin,
        },
        25_000
      );
      if (fetchPost.kind === "device-failure") {
        rollbackFailures.push(
          `${link.device.hostname}: post-rollback collection failed — ${fetchPost.message}`
        );
        continue;
      }
      liveCaptured.set(link.deviceId, String(fetchPost.json.configText ?? ""));
    } catch (error) {
      rollbackFailures.push(`${link.device.hostname}: ${(error as Error).message}`);
    }
  }

  if (rollbackFailures.length > 0) {
    await db.$transaction(
      async (tx) => {
        await tx.changeStep.update({
          where: { id: step.id },
          data: {
            status: "FAILED",
            finishedAt: now,
            error: `Rollback failed against live device(s): ${rollbackFailures.join(" · ")}`,
          },
        });
        await tx.changeRequest.update({
          where: { id: change.id },
          data: { status: "ROLLBACK_FAILED" },
        });
        await tx.auditEvent.create({
          data: {
            actorName: "system:change-engine",
            action: "CHANGE_FAILED",
            resourceType: "ChangeRequest",
            resourceId: change.id,
            resourceLabel: change.number,
            result: "FAILURE",
            correlationId,
            afterJson: JSON.stringify({
              reason: "rollback",
              dataSource: "LIVE_SSH",
              failures: rollbackFailures,
            }),
          },
        });
      },
      { maxWait: 5_000, timeout: 20_000 }
    );
    return buildResponse(change.id, {
      done: true,
      outcome: "ROLLBACK_FAILED",
      suggestIncident: true,
      message: "Rollback FAILED — the live device(s) could not be restored",
    });
  }

  const outputs: string[] = [];
  await db.$transaction(
    async (tx) => {
      for (const link of change.devices) {
        const source = restoreSources.get(link.deviceId);
        if (!source) {
          // Not a restore target (SKIPPED under the fail-fast apply):
          // truthful note only — no snapshot, no result overwrite; the
          // device keeps its provably-unmodified SKIPPED state.
          if (!isRollbackRestoreTarget(link.result)) {
            outputs.push(
              `${link.device.hostname} — not modified by the failed apply (fail-fast); nothing to restore`
            );
          }
          continue;
        }
        // Idempotency: reuse this job's restore snapshot when the sha already
        // matches the restored text (retries never duplicate). For live
        // devices the restored text is what the DEVICE shows now.
        const restoredText = liveCaptured.get(link.deviceId) ?? source.rawText;
        const existing = await tx.configSnapshot.findFirst({
          where: { deviceId: link.deviceId, changeId: change.id, jobId },
          orderBy: { version: "desc" },
          select: { id: true, version: true, sha256: true },
        });
        const restoredSha = createHash("sha256").update(restoredText).digest("hex");
        const snapshot =
          existing && shouldReuseRestoredSnapshot(existing, restoredSha)
            ? { ok: true as const, version: existing.version, sha256: existing.sha256 }
            : await createSnapshot(tx as unknown as TxClient, {
                deviceId: link.deviceId,
                rawText: restoredText,
                // Documented: the restored running config is part of the
                // change's post-activity state → source POST_CHANGE.
                source: "POST_CHANGE",
                changeId: change.id,
                jobId,
                correlationId,
                actorName: "system:change-engine",
              });
        if (!snapshot.ok) {
          throw new Error(`Device ${link.device.hostname} disappeared during rollback`);
        }
        // The change FAILED on every device; the rollback step itself succeeded.
        await tx.changeDevice.update({
          where: { id: link.id },
          data: { result: "FAILED" },
        });
        outputs.push(
          liveCaptured.has(link.deviceId)
            ? `${link.device.hostname} restored over live SSH (v${source.version} → v${snapshot.version}, sha ${shortSha(snapshot.sha256)})`
            : liveSkipped.has(link.deviceId)
              ? `${link.device.hostname} — nothing to restore (no anchor was applied); state confirmed (v${snapshot.version})`
              : `${link.device.hostname} restored to pre-change config (v${source.version} → v${snapshot.version}, sha ${shortSha(snapshot.sha256)})`
        );
      }

      await tx.changeStep.update({
        where: { id: step.id },
        data: {
          status: "PASSED",
          finishedAt: now,
          output: `${
            restoreTargets.length > 0
              ? "Pre-change configuration restored"
              : "Nothing to restore — the failed apply modified no device (SAFE-006)"
          }${outputs.length > 0 ? ` — ${outputs.join(" · ")}` : ""}`,
          error: null,
        },
      });
    },
    { maxWait: 5_000, timeout: 20_000 }
  );

  return buildResponse(change.id, {
    done: false,
    message:
      restoreTargets.length > 0
        ? "Pre-change configuration restored"
        : "Nothing to restore — no device was modified by the failed apply",
  });
}
