import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok } from "../../_lib/api";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/incidents/correlate — change ↔ incident correlation search
 * (Task 5-b, design-doc requirement).
 *
 *   ?changeId=chg-…   the change to correlate around (required)
 *   ?window=60        ± minutes around the change's reference timestamp
 *                     (default 60, clamped 5–1440)
 *
 * Reference time ("executedAt"): the earliest started/reran execution step —
 * first PASSED/RUNNING/FAILED step's startedAt — falling back to
 * scheduledStart, then updatedAt. An incident correlates when its createdAt
 * OR resolvedAt falls inside [ref − window, ref + window]; incidents already
 * linked to the change are always included. Each hit is annotated with
 * matchedOn (created | resolved), deltaMinutes and deviceOverlap (the
 * incident and the change share at least one device) so the UI can rank it.
 */
const querySchema = z.object({
  changeId: z.string().trim().min(1).max(64),
  window: z.coerce.number().int().min(5).max(1440).default(60),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    changeId: url.searchParams.get("changeId") ?? undefined,
    window: url.searchParams.get("window") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }

  const change = await db.changeRequest.findUnique({
    where: { id: parsed.data.changeId },
    select: {
      id: true,
      number: true,
      title: true,
      status: true,
      scheduledStart: true,
      scheduledEnd: true,
      updatedAt: true,
      steps: { select: { startedAt: true, status: true }, orderBy: { order: "asc" } },
      devices: { select: { deviceId: true } },
    },
  });
  if (!change) {
    return fail("CHANGE_NOT_FOUND", "The referenced change does not exist", 404);
  }

  const executedStep = change.steps.find(
    (step) => step.startedAt && ["PASSED", "RUNNING", "FAILED"].includes(step.status)
  );
  const refAt =
    executedStep?.startedAt ?? change.scheduledStart ?? change.updatedAt;
  const windowMs = parsed.data.window * 60_000;
  const from = new Date(refAt.getTime() - windowMs);
  const to = new Date(refAt.getTime() + windowMs);
  const changeDeviceIds = change.devices.map((link) => link.deviceId);

  const candidates = await db.incident.findMany({
    where: {
      OR: [{ createdAt: { gte: from, lte: to } }, { resolvedAt: { gte: from, lte: to } }],
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      number: true,
      title: true,
      severity: true,
      status: true,
      createdAt: true,
      resolvedAt: true,
      changeId: true,
      site: { select: { name: true, code: true } },
      devices: { select: { deviceId: true, device: { select: { hostname: true } } } },
      _count: { select: { devices: true, alerts: true } },
    },
  });

  const linked = await db.incident.findMany({
    where: { changeId: change.id },
    select: { id: true },
  });
  const linkedIds = new Set(linked.map((row) => row.id));

  const matches = candidates
    .filter(
      (incident) =>
        linkedIds.has(incident.id) ||
        (incident.createdAt >= from && incident.createdAt <= to) ||
        (incident.resolvedAt !== null && incident.resolvedAt >= from && incident.resolvedAt <= to)
    )
    .map((incident) => {
      const matchedOn: string[] = [];
      if (incident.createdAt >= from && incident.createdAt <= to) {
        matchedOn.push("created");
      }
      if (
        incident.resolvedAt &&
        incident.resolvedAt >= from &&
        incident.resolvedAt <= to
      ) {
        matchedOn.push("resolved");
      }
      const deviceOverlap = incident.devices.some((link) =>
        changeDeviceIds.includes(link.deviceId)
      );
      const nearest = Math.min(
        ...[
          Math.abs(incident.createdAt.getTime() - refAt.getTime()),
          incident.resolvedAt
            ? Math.abs(incident.resolvedAt.getTime() - refAt.getTime())
            : Number.POSITIVE_INFINITY,
        ]
      );
      return {
        id: incident.id,
        number: incident.number,
        title: incident.title,
        severity: incident.severity,
        status: incident.status,
        createdAt: incident.createdAt.toISOString(),
        resolvedAt: incident.resolvedAt?.toISOString() ?? null,
        site: incident.site,
        deviceCount: incident._count.devices,
        alertCount: incident._count.alerts,
        deviceHostnames: incident.devices.map((link) => link.device.hostname),
        linked: linkedIds.has(incident.id),
        changeId: incident.changeId,
        matchedOn,
        deltaMinutes: Math.round(nearest / 60_000),
        deviceOverlap,
      };
    })
    .sort((a, b) => {
      if (a.linked !== b.linked) return a.linked ? -1 : 1;
      if (a.deviceOverlap !== b.deviceOverlap) return a.deviceOverlap ? -1 : 1;
      return a.deltaMinutes - b.deltaMinutes;
    });

  return ok(matches, {
    changeId: change.id,
    changeNumber: change.number,
    changeStatus: change.status,
    refAt: refAt.toISOString(),
    refSource: executedStep?.startedAt
      ? "executionStep"
      : change.scheduledStart
        ? "scheduledStart"
        : "updatedAt",
    windowMinutes: parsed.data.window,
  });
}
