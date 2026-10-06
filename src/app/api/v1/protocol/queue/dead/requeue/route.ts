import { db } from "@/lib/db";
import { fail, firstIssueMessage, newCorrelationId, ok } from "../../../../_lib/api";
import { authErrorToFail, requireRole } from "@/lib/auth/session";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/protocol/queue/dead/requeue — operator replay for dead
 * letters (P1-O03, GA re-audit 2026-10-06).
 *
 * Body: { ids: string[] } (1..200 rows per call).
 *
 * Semantics:
 *   - ONLY rows currently in status DEAD are moved back to QUEUED — the
 *     update is guarded on status, so a concurrent delivery racing the
 *     operator cannot double-count, and re-invoking with the same ids is
 *     IDEMPOTENT (already-requeued rows simply stop matching);
 *   - attempts resets to 0 (a fresh bounded-retry budget — that is what
 *     "replay after fixing the downstream cause" means); lastError is kept
 *     for forensics until the next delivery attempt overwrites it;
 *   - the batch is audited (PROTOCOL_DLQ_REQUEUED, PLA-XXXXXX correlation)
 *     with the requested ids, the matched count and the operator — the
 *     recovery action is as accountable as the original ingest;
 *   - human accountability: admin-ROLE gated (requireRole), not a client
 *     plane — a machine token cannot replay the machine plane's own
 *     failures.
 */

const requeueSchema = z.object({
  ids: z.array(z.string().trim().min(1).max(64)).min(1, "ids is required").max(200),
});

export async function POST(request: Request) {
  let actor: Awaited<ReturnType<typeof requireRole>>;
  try {
    actor = await requireRole(request, "admin");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }
  const parsed = requeueSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }

  const correlationId = newCorrelationId("PLA");
  const requeued = await db.$transaction(async (tx) => {
    // status guard IS the replay idempotency: DEAD → QUEUED only.
    const moved = await tx.protocolEventQueue.updateMany({
      where: { id: { in: parsed.data.ids }, status: "DEAD" },
      data: { status: "QUEUED", attempts: 0 },
    });
    await tx.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName: actor.name ?? actor.email,
        action: "PROTOCOL_DLQ_REQUEUED",
        resourceType: "ProtocolEventQueue",
        resourceId: correlationId,
        resourceLabel: `${moved.count} dead letter(s)`,
        result: "SUCCESS",
        correlationId,
        afterJson: JSON.stringify({
          requested: parsed.data.ids,
          requeued: moved.count,
        }),
      },
    });
    return moved.count;
  });

  return ok(
    { requested: parsed.data.ids.length, requeued, correlationId },
    { correlationId },
    200
  );
}
