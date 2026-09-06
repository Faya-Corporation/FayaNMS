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
 * POST /api/v1/alerts/[id]/assign — set the assigned owner (Task 5-a).
 * Body: { assignedToId, actAsUserId? } — assignedToId is a User id (the
 * assignee must exist and be active). Works from any open status; audits
 * ALERT_ASSIGNED.
 */
const assignSchema = z.object({
  assignedToId: z.string().trim().min(1).max(64),
  actAsUserId: z.string().trim().max(64).optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }
  const parsed = assignSchema.safeParse(body);
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
      assignedToId: true,
      device: { select: { id: true, hostname: true } },
    },
  });
  if (!alert) {
    return fail("ALERT_NOT_FOUND", "Alert not found", 404);
  }
  if (alert.status === "RESOLVED") {
    return fail(
      "INVALID_STATE",
      "Resolved alerts cannot be assigned",
      409
    );
  }

  const assignee = await db.user.findFirst({
    where: { id: parsed.data.assignedToId, isActive: true },
    select: { id: true, name: true },
  });
  if (!assignee) {
    return fail(
      "ASSIGNEE_NOT_FOUND",
      "The assigned user does not exist or is inactive",
      404
    );
  }

  const actor = await resolveActingUser(parsed.data.actAsUserId);

  const updated = await db.alert.update({
    where: { id },
    data: { assignedToId: assignee.id },
    include: { assignedTo: { select: { id: true, name: true } } },
  });

  const correlationId = newCorrelationId("ALR");
  await db.auditEvent.create({
    data: {
      actorId: actor?.id ?? null,
      actorName: actor?.name ?? "unknown",
      action: "ALERT_ASSIGNED",
      resourceType: "Alert",
      resourceId: id,
      resourceLabel: alert.device.hostname,
      result: "SUCCESS",
      correlationId,
      beforeJson: JSON.stringify({ assignedToId: alert.assignedToId }),
      afterJson: JSON.stringify({
        assignedToId: assignee.id,
        assignedToName: assignee.name,
        status: alert.status,
      }),
    },
  });

  return ok({ alert: updated, audit: { correlationId } });
}
