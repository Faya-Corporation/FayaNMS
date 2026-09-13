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
  LIVE_NO_ANCHOR,
  VENDOR_CONFIG_FLAVORS,
} from "@/lib/change/live-plan";
import { fail, firstIssueMessage, ok } from "../../_lib/api";
import { authenticateServiceRequest } from "@/lib/auth/service-auth";
import { workerControlHeaders } from "@/lib/worker/control-client";
import { WORKER_BASE_URL } from "@/lib/worker/worker-url";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/worker/change-step — the Next-side change execution engine
 * (Task 4-b). Called BY the worker mini-service in a loop after it claims a
 * CHANGE_EXECUTE job; the worker never touches SQLite.
 *
 * Contract: executes EXACTLY ONE next PENDING ChangeStep per call, then
 * returns { done, … } so the driver either keeps looping or completes the
 * job. HTTP calls to the worker's /simulate/* and /live/* endpoints happen
 * OUTSIDE transactions; results are written in one short transaction per
 * step (never hold a tx across a fetch).
 *
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
 * Demo control (failAt) NEVER touches live devices: the APPLY/VALIDATE
 * failure is injected engine-side BEFORE any device contact, so a demo
 * run can never induce a real fault on production hardware.
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
 *   APPLY     per device — /simulate/apply ⇒ the intended running config is
 *             captured as a CURRENT POST_CHANGE snapshot (the new running
 *             config); ChangeDevice.result = SUCCESS.
 *             payload.failAt === "APPLY" ⇒ the sim answers HTTP 500 ⇒ step
 *             FAILED, first device FAILED + the rest SKIPPED.
 *   VALIDATE  payload.failAt === "VALIDATE" ⇒ FAILED (simulated) else PASSED
 *             with a per-device ok list.
 *   ROLLBACK  (driven once the change is in ROLLBACK) — recreates a CURRENT
 *             snapshot per device from the PRE_CHANGE snapshot's rawText
 *             captured earlier this run (fallback: latest snapshot created
 *             before the job started; none ⇒ step FAILED → ROLLBACK_FAILED).
 *             The restored running config is stored with source POST_CHANGE
 *             (documented decision: every snapshot this execution produced
 *             belongs to the change's post-activity state). A ROLLBACK step
 *             reached during a healthy run (user-authored plan) is SKIPPED
 *             "on standby" — the same story the seeded changes tell.
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
 * Locking/idempotency: the job row is the lock (single claim). A RUNNING
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

const ROLLBACK_STEP_TEMPLATES = [
  { name: "Restore pre-change configuration", type: "ROLLBACK" },
  { name: "Post-rollback validation", type: "VALIDATE" },
  { name: "Post-rollback backup", type: "BACKUP" },
];

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

  /* ── mark the step RUNNING + change status bookkeeping ──────────────── */
  await db.$transaction(
    async (tx) => {
      await tx.changeStep.update({
        where: { id: next.id },
        data: { status: "RUNNING", startedAt: now, error: null },
      });
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

  /* ── execute the step (HTTP outside tx — writes in one short tx) ────── */
  try {
    switch (next.type) {
      case "CHECK":
        return ok(await executeCheckStep(change, next, correlationId));
      case "BACKUP":
        return ok(
          await executeBackupStep(change, next, correlationId, job.id)
        );
      case "APPLY":
        return ok(
          await executeApplyStep(change, next, correlationId, job.id, failAt, payload)
        );
      case "VALIDATE":
        return ok(
          await executeValidateStep(change, next, correlationId, job.id, failAt, payload)
        );
      case "ROLLBACK":
        return ok(await executeRollbackStep(change, next, correlationId, job.id));
      default:
        throw new Error(`Unsupported step type: ${next.type}`);
    }
  } catch (error) {
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
  const results = new Map<string, { ok: boolean; configText: string; error?: string }>();
  const slug = changeSlugFromTitle(change.title);

  for (const link of change.devices) {
    if (isLiveDeviceLink(link)) {
      // ── LIVE plane (Phase 23): controlled apply over real SSH ──
      if (failAt === "APPLY") {
        // Demo control NEVER contacts live devices — the failure is
        // injected engine-side so a demo run can't fault real hardware.
        results.set(link.deviceId, {
          ok: false,
          configText: "",
          error: "Demo control failAt=APPLY — live apply suppressed before device contact",
        });
        continue;
      }
      try {
        // Runs the plan-based controlled apply + collects the REAL
        // post-apply running config (becomes the POST_CHANGE snapshot).
        const result = await applyLiveDevice(change, link, jobId, slug);
        results.set(link.deviceId, result);
      } catch (error) {
        // Transport-level throw (worker unreachable / 5xx) — the step
        // retries; already-applied devices are idempotent (same plan).
        results.set(link.deviceId, {
          ok: false,
          configText: "",
          error: (error as Error).message,
        });
      }
      continue;
    }

    // ── SIMULATOR plane (unchanged) ──
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
    }
  }

  const anyFailure = [...results.values()].some((result) => !result.ok);
  const outputs: string[] = [];

  await db.$transaction(
    async (tx) => {
      if (anyFailure) {
        // First failing device FAILED, the rest SKIPPED.
        let markedFirst = false;
        for (const link of change.devices) {
          const result = results.get(link.deviceId);
          if (!result?.ok && !markedFirst) {
            await tx.changeDevice.update({
              where: { id: link.id },
              data: { result: "FAILED" },
            });
            markedFirst = true;
          } else {
            await tx.changeDevice.update({
              where: { id: link.id },
              data: { result: "SKIPPED" },
            });
          }
        }
        const firstError =
          [...results.values()].find((result) => !result.ok)?.error ?? "apply failed";
        await tx.changeStep.update({
          where: { id: step.id },
          data: {
            status: "FAILED",
            finishedAt: now,
            error: `Apply failed: ${firstError}`,
          },
        });
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
    return buildResponse(change.id, {
      done: false,
      message: "Apply failed — rollback engaged",
    });
  }
  return buildResponse(change.id, {
    done: false,
    message: "Configuration applied",
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
  const outputs: string[] = [];
  const validateFailures: string[] = [];
  for (const link of change.devices) {
    if (!isLiveDeviceLink(link)) {
      outputs.push(`${link.device.hostname} ok — running-config committed`);
      continue;
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
      if (normalized.includes(marker)) {
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

  // Resolve restore sources OUTSIDE the write transaction.
  const restoreSources = new Map<string, { rawText: string; version: number; sha256: string }>();
  const missing: string[] = [];
  for (const link of change.devices) {
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

  for (const link of change.devices) {
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
      const rollback = await workerDevicePost(
        "/live/apply",
        {
          vendor: link.device.vendor.key,
          host: link.device.mgmtIp ?? link.device.hostname,
          hostname: link.device.hostname,
          deviceId: link.deviceId,
          credential,
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
        if (!source) continue;
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
          existing && existing.sha256 === restoredSha
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
          output: `Pre-change configuration restored — ${outputs.join(" · ")}`,
          error: null,
        },
      });
    },
    { maxWait: 5_000, timeout: 20_000 }
  );

  return buildResponse(change.id, {
    done: false,
    message: "Pre-change configuration restored",
  });
}
