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
 * POST /api/v1/alerts/[id]/suppress — ACTIVE|ACKNOWLEDGED → SUPPRESSED
 * (Task 5-a). Body: { reason?, actAsUserId? } — the reason is stored on
 * suppressReason (default "Manually suppressed"). Audits ALERT_SUPPRESSED.
 */
const suppressSchema = z.object({
  reason: z.string().trim().max(240).optional(),
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
  const parsed = suppressSchema.safeParse(body ?? {});
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
  if (alert.status !== "ACTIVE" && alert.status !== "ACKNOWLEDGED") {
    return fail(
      "INVALID_STATE",
      `Only ACTIVE or ACKNOWLEDGED alerts can be suppressed — this alert is ${alert.status}`,
      409
    );
  }

  const actor = await resolveActingUser(parsed.data.actAsUserId);
  const reason = parsed.data.reason?.trim() || "Manually suppressed";

  const updated = await db.alert.update({
    where: { id },
    data: { status: "SUPPRESSED", suppressReason: reason },
  });

  const correlationId = newCorrelationId("ALR");
  await db.auditEvent.create({
    data: {
      actorId: actor?.id ?? null,
      actorName: actor?.name ?? "unknown",
      action: "ALERT_SUPPRESSED",
      resourceType: "Alert",
      resourceId: id,
      resourceLabel: alert.device.hostname,
      result: "SUCCESS",
      correlationId,
      afterJson: JSON.stringify({
        status: "SUPPRESSED",
        reason,
        previousStatus: alert.status,
      }),
    },
  });

  return ok({ alert: updated, audit: { correlationId } });
}
