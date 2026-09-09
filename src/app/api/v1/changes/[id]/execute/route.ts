import { db } from "@/lib/db";
import { fail, firstIssueMessage, newJobCorrelationId, ok } from "../../../_lib/api";
import { resolveActingUser } from "../../../_lib/actor";
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
 *     NOT_REQUIRED) before the engine may run.
 *
 * Creates a QUEUED JobExecution (type CHANGE_EXECUTE, targetType CHANGE,
 * targetId = change.id, payloadJson { failAt, triggerUserId })
 * + a CHANGE_EXECUTION_QUEUED audit event. The change status stays untouched
 * until the worker claims the job and the step executor drives the state
 * machine (PRE_CHECK → EXECUTING → VALIDATING → SUCCESSFUL / ROLLBACK…).
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

  const actor = await resolveActingUser(request);
  if (!actor) {
    return fail(
      "UNAUTHENTICATED",
      "Sign in required — executions are attributed to the authenticated session principal (P19 SEC-001).",
      401
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

  const result = await db.$transaction(
    async (tx) => {
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
          }),
        },
      });

      return job;
    },
    { maxWait: 5_000, timeout: 20_000 }
  );

  return ok(
    {
      job: {
        id: result.id,
        type: result.type,
        status: result.status,
        correlationId: result.correlationId,
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
