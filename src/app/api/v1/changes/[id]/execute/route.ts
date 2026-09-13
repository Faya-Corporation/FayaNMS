import { db } from "@/lib/db";
import { fail, failWithDetail, firstIssueMessage, newJobCorrelationId, ok } from "../../../_lib/api";
import { authErrorToFail, requirePermission } from "@/lib/auth/session";
import {
  ExecutionInFlightError,
  executionLeaseExpiry,
  isUniqueConflict,
} from "@/lib/change/execution-guard";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/changes/[id]/execute — queue a change execution (Task 4-b).
 *
 * Body: { failAt?: "APPLY"|"VALIDATE"|null }
 *   failAt is the DEMO-ONLY control rendered as "Simulate failure at" in the
 *   execute dialog — it forces the engine down its rollback path.
 *
 * Guards:
 *   404 CHANGE_NOT_FOUND / 400 ACTOR_NOT_FOUND;
 *   409 INVALID_STATE — only APPROVED | SCHEDULED changes can be executed;
 *   409 APPROVALS_PENDING — every approval row must be APPROVED (or
 *     NOT_REQUIRED) before the engine may run;
 *   409 EXECUTION_IN_FLIGHT — SAFE-003 single-flight: the change already
 *     carries a QUEUED/RUNNING CHANGE_EXECUTE job (a DB-enforced execution
 *     lease — the PK IS the lock — so even two racing POSTs can never both
 *     queue; the loser's whole transaction rolls back);
 *   403 RBAC_FORBIDDEN — Phase 19-C (audit AUTHZ-101B): queueing an
 *     execution requires the "change.execute" permission (engineer; admin
 *     via wildcard). Once real adapters land this is the direct
 *     production network-control gate.
 *
 * Creates a QUEUED JobExecution (type CHANGE_EXECUTE, targetType CHANGE,
 * targetId = change.id, payloadJson { failAt, triggerUserId })
 * + a CHANGE_EXECUTION_QUEUED audit event. The change status stays untouched
 * until the worker claims the job and the step executor drives the state
 * machine (PRE_CHECK → EXECUTING → VALIDATING → SUCCESSFUL / ROLLBACK…).
 *
 * Transaction order (SAFE-003): job INSERT → lease INSERT → step injection
 * → audit. The lease INSERT is the serialization point — its P2002 fires
 * before any step row or audit event exists, and the losing transaction
 * rolls back its job row too, leaving exactly one execution behind.
 */
const ID_MAX = 64;

const executeSchema = z.object({
  failAt: z.enum(["APPLY", "VALIDATE"]).nullable().optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id || id.length > ID_MAX) {
    return fail("INVALID_ID", "Invalid change id", 400);
  }

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const parsed = executeSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const { failAt } = parsed.data;

  // Phase 19-C (audit AUTHZ-101B): executions are permission-gated FIRST —
  // change.execute (engineer; admin wildcard) — before any resource lookup
  // so unauthorized callers learn nothing about change existence.
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "change.execute");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  const change = await db.changeRequest.findUnique({
    where: { id },
    select: {
      id: true,
      number: true,
      title: true,
      status: true,
      riskLevel: true,
      _count: { select: { steps: true } },
    },
  });
  if (!change) {
    return fail("CHANGE_NOT_FOUND", "The requested change does not exist", 404);
  }
  if (!["APPROVED", "SCHEDULED"].includes(change.status)) {
    return fail(
      "INVALID_STATE",
      `Only APPROVED or SCHEDULED changes can be executed — this change is ${change.status}`,
      409
    );
  }

  const approvals = await db.changeApproval.findMany({
    where: { changeId: change.id },
    select: { level: true, status: true },
  });
  const pending = approvals.filter((row) => row.status === "PENDING");
  if (pending.length > 0) {
    return fail(
      "APPROVALS_PENDING",
      `Approvals still pending: ${pending.map((row) => row.level).join(", ")} — decide them before executing`,
      409
    );
  }

  const correlationId = newJobCorrelationId();
  const now = new Date();

  // SAFE-003 — job creation, lease acquisition, step injection and audit all
  // happen in ONE transaction; the lease INSERT (PK = changeId) is the
  // DB-enforced single-flight serialization point.
  let jobId: string;
  try {
    const result = await db.$transaction(
      async (tx) => {
        // Crash valve: a lease past its TTL may be taken over (its job could
        // never reach a terminal state — see the model docstring). Live
        // leases are never touched here.
        await tx.changeExecutionLease.deleteMany({
          where: { changeId: change.id, expiresAt: { lt: now } },
        });

        const job = await tx.jobExecution.create({
          data: {
            type: "CHANGE_EXECUTE",
            targetType: "CHANGE",
            targetId: change.id,
            status: "QUEUED",
            progress: 0,
            priority: 3,
            maxAttempts: 3,
            payloadJson: JSON.stringify({
              failAt: failAt ?? null,
              triggerUserId: actor.id,
              changeNumber: change.number,
              changeTitle: change.title,
            }),
            correlationId,
          },
        });

        // THE guard: a live lease for this change makes the unique violation
        // fire here — before any step row or audit event exists — aborting
        // this transaction (the fresh job row rolls back with it).
        try {
          await tx.changeExecutionLease.create({
            data: {
              changeId: change.id,
              jobId: job.id,
              acquiredAt: now,
              expiresAt: executionLeaseExpiry(now),
            },
          });
        } catch (error) {
          if (isUniqueConflict(error)) {
            throw new ExecutionInFlightError(change.number);
          }
          throw error;
        }

        // Stepless changes (some seeded rows ship without a plan): inject the
        // standard 5-step execution plan so the engine has real work to drive
        // and the timeline is meaningful. Changes authored via the wizard or
        // the restore flow already carry their steps.
        if (change._count.steps === 0) {
          await tx.changeStep.createMany({
            data: [
              { changeId: change.id, order: 1, name: "Pre-change checks", type: "CHECK" },
              { changeId: change.id, order: 2, name: "Pre-change backup", type: "BACKUP" },
              { changeId: change.id, order: 3, name: "Apply configuration", type: "APPLY" },
              { changeId: change.id, order: 4, name: "Post-change validation", type: "VALIDATE" },
              { changeId: change.id, order: 5, name: "Post-change backup", type: "BACKUP" },
            ],
          });
        }

        await tx.auditEvent.create({
          data: {
            actorId: actor.id,
            actorName: actor.name ?? "Acting user",
            action: "CHANGE_EXECUTION_QUEUED",
            resourceType: "ChangeRequest",
            resourceId: change.id,
            resourceLabel: change.number,
            result: "SUCCESS",
            correlationId,
            afterJson: JSON.stringify({
              jobId: job.id,
              failAt: failAt ?? null,
              riskLevel: change.riskLevel,
              singleFlight: "lease-acquired",
            }),
          },
        });

        return job;
      },
      { maxWait: 5_000, timeout: 20_000 }
    );
    jobId = result.id;
  } catch (error) {
    if (error instanceof ExecutionInFlightError) {
      // Name the execution that holds the lease so the operator can follow
      // it instead of fighting it (the winner's tx has committed by now —
      // the unique violation only fires after the holder's row is visible).
      const active = await db.jobExecution.findFirst({
        where: {
          type: "CHANGE_EXECUTE",
          targetType: "CHANGE",
          targetId: change.id,
          status: { in: ["QUEUED", "RUNNING"] },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, correlationId: true, createdAt: true },
      });
      return failWithDetail(
        error.code,
        active
          ? `${error.message} (active job ${active.id}, correlation ${active.correlationId})`
          : error.message,
        error.httpStatus,
        active
          ? { activeJob: { id: active.id, status: active.status, correlationId: active.correlationId } }
          : undefined
      );
    }
    throw error;
  }

  return ok(
    {
      job: {
        id: jobId,
        type: "CHANGE_EXECUTE",
        status: "QUEUED",
        correlationId,
      },
      change: {
        id: change.id,
        number: change.number,
        status: change.status,
      },
      message: `Execution queued for ${change.number} — follow the steps on this page or the Job Center (correlation ${correlationId}).`,
      audit: { action: "CHANGE_EXECUTION_QUEUED", correlationId },
    },
    undefined,
    201
  );
}
