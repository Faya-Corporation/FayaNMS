import { db } from "@/lib/db";
import { authErrorToFail, requirePermission } from "@/lib/auth/session";
import { fail, ok, requestContext } from "../../../_lib/api";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/jobs/[id]/cancel (Phase 9-b) — cancel a queued or running
 * job execution.
 *
 * Only QUEUED / RUNNING jobs are cancellable (the worker's complete()
 * handler already refuses to touch anything that is not RUNNING, so a
 * CANCELLED job can never be overwritten by a late completion).
 *
 * - 404 JOB_NOT_FOUND       — unknown id
 * - 409 JOB_NOT_CANCELLABLE — terminal status (SUCCEEDED/FAILED/DEAD/CANCELLED)
 * - 200                     — status → CANCELLED + finishedAt, audited
 *                             JOB_CANCELLED (session actor + correlationId).
 *
 * Standard _lib envelope; session enforced (middleware + requirePermission).
 */

const CANCELLABLE_STATUSES = new Set(["QUEUED", "RUNNING"]);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Phase 19-C (audit AUTHZ-001 sweep): cancelling a job requires the
  // "job.run" permission (was authentication-only via requireUser).
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "job.run");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  const job = await db.jobExecution.findUnique({ where: { id } });
  if (!job) {
    return fail(
      "JOB_NOT_FOUND",
      "The requested job execution does not exist",
      404,
      requestContext(request)
    );
  }
  if (!CANCELLABLE_STATUSES.has(job.status)) {
    return fail(
      "JOB_NOT_CANCELLABLE",
      `Job status is ${job.status} — only QUEUED or RUNNING jobs can be cancelled`,
      409,
      requestContext(request)
    );
  }

  const finishedAt = new Date();
  const actorName = actor.name ?? actor.email;

  const [, updated] = await db.$transaction([
    db.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName,
        action: "JOB_CANCELLED",
        resourceType: job.targetType ?? "SYSTEM",
        resourceId: job.targetId ?? job.id,
        resourceLabel: job.correlationId,
        result: "SUCCESS",
        correlationId: job.correlationId,
        beforeJson: JSON.stringify({ id: job.id, status: job.status }),
        afterJson: JSON.stringify({ id: job.id, status: "CANCELLED" }),
      },
    }),
    db.jobExecution.update({
      where: { id },
      data: { status: "CANCELLED", finishedAt },
    }),
  ]);

  return ok(
    { job: updated },
    { correlationId: updated.correlationId },
    200,
    requestContext(request)
  );
}
