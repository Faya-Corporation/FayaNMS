import { db } from "@/lib/db";
import { csvParam, fail, firstIssueMessage, ok } from "../../_lib/api";
import { changeScopeListWhere } from "../../_lib/change-scope";
import { z } from "zod";
import { authErrorToFail, requireSessionRead, sessionScopeFor } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/changes/conflicts?start=ISO&end=ISO&excludeId=&status=csv
 *
 * Returns changes whose [scheduledStart, scheduledEnd] window OVERLAPS the
 * queried window (overlap = start < other.end && end > other.start). Used
 * by (a) the wizard's schedule step for advisory/blocking conflict panels
 * and (b) the calendar's conflict-day highlighting.
 *
 * Dead statuses (CANCELLED / REJECTED / EXPIRED) and closed-out execution
 * outcomes (SUCCESSFUL / CLOSED / FAILED / ROLLBACK / ROLLBACK_FAILED /
 * POST_REVIEW) never conflict. DRAFTs and AWAITING_APPROVAL with a
 * proposed window DO count — planning should know about them.
 *
 * Wave 10 (F-031, audit 13-b F-3): the overlap search composes the
 * session's site scope (site leg OR device-linked in-scope change — the
 * shared change-plane predicate), so planning cannot see cross-site
 * windows; wildcard sessions keep the pre-wave-10 where shape.
 */

const querySchema = z.object({
  start: z.coerce.date(),
  end: z.coerce.date(),
  excludeId: z.string().trim().max(64).optional(),
  status: z.string().optional(),
});

export async function GET(request: Request) {
  // F-008 phase 4a (read-plane defense-in-depth): the GET handler verifies
  // the human session itself (requireSessionRead) — the proxy matcher stays
  // the coarse gate, not the only check.
  try {
    await requireSessionRead(request);
  } catch (error) {
    const envelope = authErrorToFail(error);
    if (envelope) return envelope;
    throw error;
  }
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    start: url.searchParams.get("start") ?? undefined,
    end: url.searchParams.get("end") ?? undefined,
    excludeId: url.searchParams.get("excludeId") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }
  const { start, end, excludeId } = parsed.data;
  if (end <= start) {
    return fail("INVALID_QUERY", "end must be after start", 400);
  }

  const statuses = csvParam(parsed.data.status);
  // F-031 (wave 10): the session's site scope for the change legs.
  const scopeLeg = changeScopeListWhere(await sessionScopeFor(request));
  const deadStatuses = [
    "CANCELLED",
    "REJECTED",
    "EXPIRED",
    "SUCCESSFUL",
    "CLOSED",
    "FAILED",
    "ROLLBACK",
    "ROLLBACK_FAILED",
    "POST_REVIEW",
  ];

  const rows = await db.changeRequest.findMany({
    where: {
      AND: [
        // Overlap: existing window starts before our end AND ends after our start.
        { scheduledStart: { lt: end, not: null } },
        { scheduledEnd: { gt: start, not: null } },
        {
          status: statuses
            ? { in: statuses, notIn: deadStatuses }
            : { notIn: deadStatuses },
        },
        excludeId ? { id: { not: excludeId } } : {},
        // F-031 (wave 10): site leg OR device-linked in-scope change.
        scopeLeg,
      ],
    },
    orderBy: { scheduledStart: "asc" },
    select: {
      id: true,
      number: true,
      title: true,
      status: true,
      riskLevel: true,
      type: true,
      scheduledStart: true,
      scheduledEnd: true,
      site: { select: { code: true, name: true } },
      devices: { select: { deviceId: true } },
    },
    take: 50,
  });

  return ok(
    rows.map((row) => ({
      id: row.id,
      number: row.number,
      title: row.title,
      status: row.status,
      riskLevel: row.riskLevel,
      type: row.type,
      scheduledStart: row.scheduledStart,
      scheduledEnd: row.scheduledEnd,
      siteCode: row.site?.code ?? null,
      deviceIds: row.devices.map((d) => d.deviceId),
    }))
  );
}
