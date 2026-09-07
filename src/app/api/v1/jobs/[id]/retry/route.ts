import { db } from "@/lib/db";
import { requireUser, authErrorToFail } from "@/lib/auth/session";
import { fail, newJobCorrelationId, ok, requestContext } from "../../../_lib/api";

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
 * - 201               — { job, audit } for the newly queued clone.
 *
 * Standard _lib envelope; session enforced (middleware + requireUser).
 */

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let user;
  try {
    user = await requireUser(request);
  } catch (error) {
    const envelope = authErrorToFail(error);
    if (envelope) return envelope;
    throw error;
  }

  const source = await db.jobExecution.findUnique({ where: { id } });
  if (!source) {
    return fail(
      "JOB_NOT_FOUND",
      "The requested job execution does not exist",
      404,
      requestContext(request)
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
        actorId: user.id,
        actorName: user.name ?? user.email,
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

  return ok({ job, audit }, { correlationId }, 201, requestContext(request));
}
