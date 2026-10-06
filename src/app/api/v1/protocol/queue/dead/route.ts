import { db } from "@/lib/db";
import { fail, ok, paginationSchema, pageMeta, firstIssueMessage } from "../../../_lib/api";
import { authErrorToFail, requirePermission } from "@/lib/auth/session";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/protocol/queue/dead — the DEAD-letter inspection surface
 * (P1-O03, GA re-audit 2026-10-06).
 *
 * Until this route the protocol queue's DEAD state was a write-only void:
 * bounded retries existed (src/lib/protocol/queue.ts), retention pruning
 * existed, but an operator had NO way to SEE what died or why. This lists
 * the dead letters newest-first with the fields an operator needs to
 * decide a replay: protocol, event type, source, receivedAt, attempts,
 * lastError, correlationId (ties the delivery attempts together).
 *
 * Payload-adjacent columns (attributesJson / flowBatchJson) are
 * deliberately NOT returned here — the queue stores normalized event data,
 * but the DLQ view is an OPERATIONS surface; the ingest pipeline remains
 * the authority for content. meta.deadCount carries the full depth for
 * dashboards/alerting.
 */

const querySchema = paginationSchema.extend({
  protocol: z.string().trim().min(1).max(32).optional(),
});

export async function GET(request: Request) {
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "admin.system");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (authFail) return authFail;
    throw error;
  }

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
    protocol: url.searchParams.get("protocol") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }
  const { page, pageSize, protocol } = parsed.data;

  const where = {
    status: "DEAD" as const,
    ...(protocol ? { protocol } : {}),
  };

  const [rows, deadCount] = await Promise.all([
    db.protocolEventQueue.findMany({
      where,
      orderBy: { receivedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        collectorId: true,
        protocol: true,
        sourceIp: true,
        sourcePort: true,
        receivedAt: true,
        eventType: true,
        severity: true,
        message: true,
        correlationId: true,
        attempts: true,
        lastError: true,
      },
    }),
    db.protocolEventQueue.count({ where: { status: "DEAD" } }),
  ]);

  return ok(rows, { ...pageMeta(page, pageSize, deadCount), total: deadCount, deadCount }, 200);
}
