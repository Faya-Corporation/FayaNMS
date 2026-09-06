import { db } from "@/lib/db";
import {
  fail,
  firstIssueMessage,
  newCorrelationId,
  ok,
} from "../../../_lib/api";
import { resolveActingUser } from "../../../_lib/actor";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/alerts/[id]/resolve — open statuses → RESOLVED (Task 5-a).
 * Works from ACTIVE | ACKNOWLEDGED | SUPPRESSED; audits ALERT_RESOLVED.
 * (Auto-resolution by the engine uses the same action name — the audit
 * actor distinguishes system:alert-engine from a human.)
 */
const resolveSchema = z.object({
  actAsUserId: z.string().trim().max(64).optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: unknown = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }
  const parsed = resolveSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }

  const alert = await db.alert.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      severity: true,
      message: true,
      device: { select: { id: true, hostname: true } },
    },
  });
  if (!alert) {
    return fail("ALERT_NOT_FOUND", "Alert not found", 404);
  }
  if (alert.status === "RESOLVED") {
    return fail("INVALID_STATE", "This alert is already resolved", 409);
  }

  const actor = await resolveActingUser(parsed.data.actAsUserId);
  const previousStatus = alert.status;

  const updated = await db.alert.update({
    where: { id },
    data: { status: "RESOLVED", suppressReason: null },
  });

  const correlationId = newCorrelationId("ALR");
  await db.auditEvent.create({
    data: {
      actorId: actor?.id ?? null,
      actorName: actor?.name ?? "unknown",
      action: "ALERT_RESOLVED",
      resourceType: "Alert",
      resourceId: id,
      resourceLabel: alert.device.hostname,
      result: "SUCCESS",
      correlationId,
      afterJson: JSON.stringify({
        status: "RESOLVED",
        previousStatus,
        severity: alert.severity,
      }),
    },
  });

  return ok({ alert: updated, audit: { correlationId } });
}
