import { createHash } from "node:crypto";
import { decryptSnapshotTexts } from "@/lib/config/crypto";
import { db } from "@/lib/db";
import {
  createSnapshot,
  shortSha,
  type CreateSnapshotResult,
  type TxClient,
} from "@/lib/config/create-snapshot";
import { fail, firstIssueMessage, ok } from "../../_lib/api";
import { authenticateServiceRequest } from "@/lib/auth/service-auth";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/worker/change-step — the Next-side change execution engine
 * (Task 4-b). Called BY the worker mini-service in a loop after it claims a
 * CHANGE_EXECUTE job; the worker never touches SQLite.
 *
 * Contract: executes EXACTLY ONE next PENDING ChangeStep per call, then
 * returns { done, … } so the driver either keeps looping or completes the
 * job. HTTP calls to the worker's /simulate/* endpoints happen OUTSIDE
 * transactions; results are written in one short transaction per step
 * (SQLite WAL — never hold a tx across a fetch).
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

const WORKER_BASE_URL = "http://localhost:3030";

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
      headers: { "content-type": "application/json" },
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
  const service = authenticateServiceRequest(request);
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
  for (const link of change.devices) {
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
          `${link.device.hostname} v${snapshot.version} captured (sha ${shortSha(snapshot.sha256)})`
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

  for (const link of change.devices) {
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

  const outputs = change.devices.map(
    (link) => `${link.device.hostname} ok — running-config committed`
  );
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

  const outputs: string[] = [];
  await db.$transaction(
    async (tx) => {
      for (const link of change.devices) {
        const source = restoreSources.get(link.deviceId);
        if (!source) continue;
        // Idempotency: reuse this job's restore snapshot when the sha already
        // matches the pre-change text (retries never duplicate).
        const existing = await tx.configSnapshot.findFirst({
          where: { deviceId: link.deviceId, changeId: change.id, jobId },
          orderBy: { version: "desc" },
          select: { id: true, version: true, sha256: true },
        });
        const restoredSha = createHash("sha256").update(source.rawText).digest("hex");
        const snapshot =
          existing && existing.sha256 === restoredSha
            ? { ok: true as const, version: existing.version, sha256: existing.sha256 }
            : await createSnapshot(tx as unknown as TxClient, {
                deviceId: link.deviceId,
                rawText: source.rawText,
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
          `${link.device.hostname} restored to pre-change config (v${source.version} → v${snapshot.version}, sha ${shortSha(snapshot.sha256)})`
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
