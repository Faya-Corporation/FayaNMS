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
 * POST /api/v1/alerts/[id]/unsuppress — SUPPRESSED → ACTIVE (Task 5-a).
 * Clears suppressReason (parentAlertId is kept for grouping context).
 * Audits ALERT_UNSUPPRESSED.
 */
const unsuppressSchema = z.object({
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
  const parsed = unsuppressSchema.safeParse(body ?? {});
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
      suppressReason: true,
      device: { select: { id: true, hostname: true } },
    },
  });
  if (!alert) {
    return fail("ALERT_NOT_FOUND", "Alert not found", 404);
  }
  if (alert.status !== "SUPPRESSED") {
    return fail(
      "INVALID_STATE",
      `Only SUPPRESSED alerts can be unsuppressed — this alert is ${alert.status}`,
      409
    );
  }

  const actor = await resolveActingUser(parsed.data.actAsUserId);

  const updated = await db.alert.update({
    where: { id },
    data: { status: "ACTIVE", suppressReason: null },
  });

  const correlationId = newCorrelationId("ALR");
  await db.auditEvent.create({
    data: {
      actorId: actor?.id ?? null,
      actorName: actor?.name ?? "unknown",
      action: "ALERT_UNSUPPRESSED",
      resourceType: "Alert",
      resourceId: id,
      resourceLabel: alert.device.hostname,
      result: "SUCCESS",
      correlationId,
      afterJson: JSON.stringify({
        status: "ACTIVE",
        previousReason: alert.suppressReason,
      }),
    },
  });

  return ok({ alert: updated, audit: { correlationId } });
}
