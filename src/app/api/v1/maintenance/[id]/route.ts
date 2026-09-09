import { db } from "@/lib/db";
import {
  fail,
  firstIssueMessage,
  newCorrelationId,
  ok,
} from "../../_lib/api";
import { resolveActingUser } from "../../_lib/actor";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * PATCH  /api/v1/maintenance/[id] — partial update (Task 5-c): name, scope
 *        (siteId/deviceId/changeId, explicit null clears), startsAt/endsAt,
 *        reason and the isActive suppression toggle. Audited
 *        MAINTENANCE_WINDOW_UPDATED. The same-scope overlap warning is
 *        recomputed and returned (non-blocking).
 * DELETE /api/v1/maintenance/[id] — delete the window. Audited
 *        MAINTENANCE_WINDOW_DELETED (beforeJson snapshot). Deleting a
 *        window never touches alerts/incidents — suppression simply ends.
 *
 * Both: 404 MAINTENANCE_NOT_FOUND.
 */

const isoDatetime = z.coerce.date();

const patchSchema = z
  .object({
    name: z.string().trim().min(1, "name cannot be empty").max(160).optional(),
    siteId: z.string().trim().max(64).nullable().optional(),
    deviceId: z.string().trim().max(64).nullable().optional(),
    changeId: z.string().trim().max(64).nullable().optional(),
    startsAt: isoDatetime.optional(),
    endsAt: isoDatetime.optional(),
    reason: z.string().trim().max(500).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (data) =>
      !(data.startsAt && data.endsAt && data.endsAt <= data.startsAt),
    { message: "endsAt must be after startsAt", path: ["endsAt"] }
  );

export async function PATCH(
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

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const data = parsed.data;

  const existing = await db.maintenanceWindow.findUnique({ where: { id } });
  if (!existing) {
    return fail("MAINTENANCE_NOT_FOUND", "Maintenance window not found", 404);
  }

  // Validate referenced records (null clears the link and is always fine).
  if (data.siteId) {
    const site = await db.site.findUnique({ where: { id: data.siteId }, select: { id: true } });
    if (!site) return fail("SITE_INVALID", "The selected site does not exist", 400);
  }
  if (data.deviceId) {
    const device = await db.device.findUnique({ where: { id: data.deviceId }, select: { id: true } });
    if (!device) return fail("DEVICE_INVALID", "The selected device does not exist", 400);
  }
  if (data.changeId) {
    const change = await db.changeRequest.findUnique({ where: { id: data.changeId }, select: { id: true } });
    if (!change) return fail("CHANGE_INVALID", "The selected change does not exist", 400);
  }

  // Effective time range (merged with the current values) must stay ordered.
  const nextStartsAt = data.startsAt ?? existing.startsAt;
  const nextEndsAt = data.endsAt ?? existing.endsAt;
  if (nextEndsAt <= nextStartsAt) {
    return fail(
      "INVALID_BODY",
      "endsAt must be after startsAt",
      400
    );
  }

  const actor = await resolveActingUser(request);
  if (!actor) {
    return fail("UNAUTHENTICATED", "Sign in required — no valid session was provided.", 401);
  }

  const before = {
    name: existing.name,
    siteId: existing.siteId,
    deviceId: existing.deviceId,
    changeId: existing.changeId,
    startsAt: existing.startsAt.toISOString(),
    endsAt: existing.endsAt.toISOString(),
    reason: existing.reason,
    isActive: existing.isActive,
  };

  const updated = await db.maintenanceWindow.update({
    where: { id },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.siteId !== undefined ? { siteId: data.siteId } : {}),
      ...(data.deviceId !== undefined ? { deviceId: data.deviceId } : {}),
      ...(data.changeId !== undefined ? { changeId: data.changeId } : {}),
      ...(data.startsAt !== undefined ? { startsAt: data.startsAt } : {}),
      ...(data.endsAt !== undefined ? { endsAt: data.endsAt } : {}),
      ...(data.reason !== undefined ? { reason: data.reason } : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    },
  });

  const overlap = await findOverlapSafe({
    deviceId: updated.deviceId,
    siteId: updated.siteId,
    startsAt: updated.startsAt,
    endsAt: updated.endsAt,
    excludeId: updated.id,
  });

  const correlationId = newCorrelationId("MW");
  await db.auditEvent.create({
    data: {
      actorId: actor?.id ?? null,
      actorName: actor?.name ?? "unknown",
      action: "MAINTENANCE_WINDOW_UPDATED",
      resourceType: "MaintenanceWindow",
      resourceId: id,
      resourceLabel: updated.name,
      result: "SUCCESS",
      correlationId,
      beforeJson: JSON.stringify(before),
      afterJson: JSON.stringify({
        name: updated.name,
        siteId: updated.siteId,
        deviceId: updated.deviceId,
        changeId: updated.changeId,
        startsAt: updated.startsAt.toISOString(),
        endsAt: updated.endsAt.toISOString(),
        reason: updated.reason,
        isActive: updated.isActive,
      }),
    },
  });

  return ok({
    window: {
      id: updated.id,
      name: updated.name,
      startsAt: updated.startsAt.toISOString(),
      endsAt: updated.endsAt.toISOString(),
      reason: updated.reason,
      isActive: updated.isActive,
      siteId: updated.siteId,
      deviceId: updated.deviceId,
      changeId: updated.changeId,
    },
    overlap,
    audit: { correlationId },
  });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const existing = await db.maintenanceWindow.findUnique({ where: { id } });
  if (!existing) {
    return fail("MAINTENANCE_NOT_FOUND", "Maintenance window not found", 404);
  }

  await db.maintenanceWindow.delete({ where: { id } });

  const correlationId = newCorrelationId("MW");
  await db.auditEvent.create({
    data: {
      actorName: "Admin",
      action: "MAINTENANCE_WINDOW_DELETED",
      resourceType: "MaintenanceWindow",
      resourceId: id,
      resourceLabel: existing.name,
      result: "SUCCESS",
      correlationId,
      beforeJson: JSON.stringify({
        name: existing.name,
        siteId: existing.siteId,
        deviceId: existing.deviceId,
        changeId: existing.changeId,
        startsAt: existing.startsAt.toISOString(),
        endsAt: existing.endsAt.toISOString(),
        reason: existing.reason,
        isActive: existing.isActive,
      }),
    },
  });

  return ok({ deleted: true, audit: { correlationId } });
}

/** Overlap helper shared with the create route (kept local to avoid cycles). */
async function findOverlapSafe(input: {
  deviceId: string | null;
  siteId: string | null;
  startsAt: Date;
  endsAt: Date;
  excludeId: string;
}) {
  const rows = await db.maintenanceWindow.findMany({
    where: {
      isActive: true,
      id: { not: input.excludeId },
      startsAt: { lt: input.endsAt },
      endsAt: { gt: input.startsAt },
      OR: [
        ...(input.deviceId ? [{ deviceId: input.deviceId }] : []),
        ...(input.deviceId ? [] : [{ deviceId: null }]),
        ...(input.deviceId
          ? []
          : input.siteId
            ? [{ siteId: input.siteId }]
            : [{ siteId: null }]),
      ],
    },
    orderBy: { startsAt: "asc" },
    take: 5,
    select: { id: true, name: true, startsAt: true, endsAt: true },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
  }));
}
