import { db } from "@/lib/db";
import { authErrorToFail, requirePermission } from "@/lib/auth/session";
import { RETRYABLE_JOB_STATUSES } from "@/lib/jobs/lifecycle";
import { fail, newJobCorrelationId, ok } from "../../../_lib/api";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/jobs/[id]/retry (Phase 9-b) — queue a fresh clone of an
 * existing job execution (same type / target / payload).
 *
 * The clone starts clean (QUEUED, attempts 0, fresh JOB- correlation id)
 * and carries a RETRY_OF correlation link in two places:
 *   - payloadJson.retryOf / payloadJson.retryOfCorrelationId (worker-safe:
 *     the runners read known keys and ignore extras),
 *   - the JOB_RETRIED audit event's before/after snapshot.
 *
 * - 404 JOB_NOT_FOUND — unknown id
 * - 409 JOB_NOT_RETRYABLE — the source job is not a terminal failure
 *   (only FAILED/DEAD clone; wave-6: the guard closes the SAFE-003 lease
 *   bypass where POST /jobs/<running-id>/retry produced TWO live
 *   executions of one change — the UI's retry button already only showed
 *   for FAILED/DEAD, now the API enforces the same contract)
 * - 201               — { job, audit } for the newly queued clone.
 *
 * Standard _lib envelope; session enforced (middleware + requirePermission).
 */

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Phase 19-C (audit AUTHZ-001 sweep): retrying a job requires the
  // "job.run" permission (was authentication-only via requireUser).
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "job.run");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  const source = await db.jobExecution.findUnique({ where: { id } });
  if (!source) {
    return fail(
      "JOB_NOT_FOUND",
      "The requested job execution does not exist",
      404
    );
  }

  // Wave-6 (SAFE-003): only terminal failures are retryable. A clone of a
  // QUEUED/RUNNING job would run beside its source — for CHANGE_EXECUTE
  // that means two live executions of one change (the per-change lease
  // row keeps pointing at the ORIGINAL job, so the clone's completion
  // could not even release it). Mirrors the job center's retry button.
  if (!RETRYABLE_JOB_STATUSES.has(source.status)) {
    return fail(
      "JOB_NOT_RETRYABLE",
      `Only terminal FAILED or DEAD jobs can be retried — job ${source.correlationId} is ${source.status}`,
      409
    );
  }

  const correlationId = newJobCorrelationId();

  // Merge the RETRY_OF link into a copy of the original payload (the worker
  // runners read known keys and tolerate extras).
  let payloadJson = source.payloadJson;
  try {
    const parsed: unknown = payloadJson ? JSON.parse(payloadJson) : {};
    payloadJson = JSON.stringify({
      ...(typeof parsed === "object" && parsed !== null ? parsed : {}),
      retryOf: source.id,
      retryOfCorrelationId: source.correlationId,
    });
  } catch {
    // Unparseable source payload — keep it verbatim; the audit event still
    // records the link.
  }

  const [job, audit] = await db.$transaction([
    db.jobExecution.create({
      data: {
        type: source.type,
        targetType: source.targetType,
        targetId: source.targetId,
        status: "QUEUED",
        progress: 0,
        priority: source.priority,
        attempts: 0,
        maxAttempts: source.maxAttempts,
        payloadJson,
        correlationId,
      },
    }),
    db.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName: actor.name ?? actor.email,
        action: "JOB_RETRIED",
        resourceType: source.targetType ?? "SYSTEM",
        resourceId: source.targetId ?? source.id,
        resourceLabel: source.correlationId,
        result: "SUCCESS",
        correlationId,
        beforeJson: JSON.stringify({
          retriedFromJobId: source.id,
          retriedFromCorrelationId: source.correlationId,
          sourceStatus: source.status,
          sourceAttempts: source.attempts,
        }),
        afterJson: JSON.stringify({ type: source.type, correlationId }),
      },
    }),
  ]);

  return ok({ job, audit }, { correlationId }, 201);
}
