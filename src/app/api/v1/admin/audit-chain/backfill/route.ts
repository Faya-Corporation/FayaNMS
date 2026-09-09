import type { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { backfillAuditChain } from "@/lib/audit/chain";
import {
  newCorrelationId,
  ok,
  requestContext,
} from "@/app/api/v1/_lib/api";
import { authErrorToFail, requireRole } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/admin/audit-chain/backfill (Task 7-b)
 *
 * Admin-only bootstrap/repair for the audit hash chain: processes every
 * null-hash AuditEvent oldest→newest in batches (100/batch, 2000/request
 * cap), chaining each onto the previous row. The run itself is audited as
 * AUDIT_CHAIN_BACKFILLED — and because hashed rows now exist, that audit
 * event is stamped into the chain automatically by the db extension.
 * Response: { filled, remaining }.
 */
export async function POST(request: Request) {
  try {
    // Phase 19-C (audit AUTHZ-001 sweep): admin-only gate (requireRole
    // replaces resolveAdminActor, whose UNAUTHENTICATED fallback let
    // anonymous callers through).
    let actor: Awaited<ReturnType<typeof requireRole>>;
    try {
      actor = await requireRole(request, "admin");
    } catch (error) {
      const authFail = authErrorToFail(error);
      if (!authFail) throw error;
      return authFail;
    }
    const result = await backfillAuditChain(db as unknown as PrismaClient);

    const correlationId = newCorrelationId("CHAIN");
    await db.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName: actor.name ?? actor.email,
        action: "AUDIT_CHAIN_BACKFILLED",
        resourceType: "AuditEvent",
        resourceLabel: "Audit hash chain",
        result: "SUCCESS",
        correlationId,
        afterJson: JSON.stringify({
          filled: result.filled,
          remaining: result.remaining,
        }),
      },
    });

    return ok({ ...result, audit: { correlationId } }, undefined, 200, requestContext(request));
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (authFail) return authFail;
    throw error;
  }
}
