import { db } from "@/lib/db";
import {
  fail,
  firstIssueMessage,
  ok,
  pageMeta,
  paginationSchema,
} from "../_lib/api";
import { authErrorToFail, requireSessionRead } from "@/lib/auth/session";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/events — platform audit-event timeline (Task 5-c, the
 * AuditEvent table). Newest first, paginated.
 *
 * Filters:
 *   actor         exact actorId OR actorName (e.g. "system:alert-engine",
 *                 "usr-noc1") — the UI select feeds either form
 *   action        PREFIX match (e.g. "INCIDENT_" → the incident family)
 *   entityType    resourceType exact ("Device", "ConfigSnapshot", …)
 *   correlationId exact
 *   deviceId      device-scoped events (resourceId === deviceId — the
 *                 convention used by the DEVICE_* / CONFIG_BACKUP /
 *                 CONFIG_DOWNLOAD audit rows)
 *   from / to     ISO timestamps on createdAt
 *   q             contains across actorName/action/resourceType/resourceLabel/
 *                 resourceId/correlationId (SQLite LIKE is case-insensitive)
 *
 * meta: pagination + total + last24h (events in the trailing 24 h over the
 * same filters minus the time range) + distinctActors + topActions (top-8
 * action facet with counts, computed over the filtered set WITHOUT the
 * action filter so the facet stays navigable) + entityTypes (top-8
 * resourceType facet, same convention).
 *
 * F-008 phase 2 (read-plane defense-in-depth): the handler verifies the
 * human session itself (requireSessionRead) — the proxy matcher stays the
 * coarse gate, not the only check, for the events read domain.
 */

const querySchema = paginationSchema.extend({
  actor: z.string().trim().max(120).optional(),
  action: z.string().trim().max(64).optional(),
  entityType: z.string().trim().max(64).optional(),
  correlationId: z.string().trim().max(120).optional(),
  deviceId: z.string().trim().max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  q: z.string().trim().max(120).optional(),
});

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export async function GET(request: Request) {
  try {
    await requireSessionRead(request);
  } catch (error) {
    const envelope = authErrorToFail(error);
    if (envelope) return envelope;
    throw error;
  }

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
    actor: url.searchParams.get("actor") ?? undefined,
    action: url.searchParams.get("action") ?? undefined,
    entityType: url.searchParams.get("entityType") ?? undefined,
    correlationId: url.searchParams.get("correlationId") ?? undefined,
    deviceId: url.searchParams.get("deviceId") ?? undefined,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }

  const {
    page,
    pageSize,
    actor,
    action,
    entityType,
    correlationId,
    deviceId,
    from,
    to,
    q,
  } = parsed.data;

  /** All filters — used for the page itself. */
  const listWhere = {
    AND: [
      actor
        ? { OR: [{ actorId: actor }, { actorName: actor }] }
        : {},
      action ? { action: { startsWith: action } } : {},
      entityType ? { resourceType: entityType } : {},
      correlationId ? { correlationId } : {},
      deviceId ? { resourceId: deviceId } : {},
      from ? { createdAt: { gte: from } } : {},
      to ? { createdAt: { lte: to } } : {},
      q
        ? {
            OR: [
              { actorName: { contains: q } },
              { action: { contains: q } },
              { resourceType: { contains: q } },
              { resourceLabel: { contains: q } },
              { resourceId: { contains: q } },
              { correlationId: { contains: q } },
            ],
          }
        : {},
    ],
  };

  /** Filters minus the facet's own dimension — facets stay navigable. */
  const scopeWhere = {
    AND: [
      actor ? { OR: [{ actorId: actor }, { actorName: actor }] } : {},
      entityType ? { resourceType: entityType } : {},
      correlationId ? { correlationId } : {},
      deviceId ? { resourceId: deviceId } : {},
      from ? { createdAt: { gte: from } } : {},
      to ? { createdAt: { lte: to } } : {},
      q
        ? {
            OR: [
              { actorName: { contains: q } },
              { action: { contains: q } },
              { resourceType: { contains: q } },
              { resourceLabel: { contains: q } },
              { resourceId: { contains: q } },
              { correlationId: { contains: q } },
            ],
          }
        : {},
    ],
  };

  const last24hFloor = new Date(Date.now() - 24 * 3600 * 1000);

  const [total, rows, last24h, actionGroups, entityTypeGroups, actorGroups] =
    await Promise.all([
      db.auditEvent.count({ where: listWhere }),
      db.auditEvent.findMany({
        where: listWhere,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.auditEvent.count({
        where: { AND: [...scopeWhere.AND, { createdAt: { gte: last24hFloor } }] },
      }),
      db.auditEvent.groupBy({
        by: ["action"],
        where: scopeWhere,
        _count: { _all: true },
        orderBy: { _count: { action: "desc" } },
        take: 8,
      }),
      db.auditEvent.groupBy({
        by: ["resourceType"],
        where: scopeWhere,
        _count: { _all: true },
        orderBy: { _count: { resourceType: "desc" } },
        take: 8,
      }),
      db.auditEvent.groupBy({
        by: ["actorName"],
        where: {
          AND: [
            action ? { action: { startsWith: action } } : {},
            entityType ? { resourceType: entityType } : {},
            correlationId ? { correlationId } : {},
            deviceId ? { resourceId: deviceId } : {},
            from ? { createdAt: { gte: from } } : {},
            to ? { createdAt: { lte: to } } : {},
            q
              ? {
                  OR: [
                    { action: { contains: q } },
                    { resourceType: { contains: q } },
                    { resourceLabel: { contains: q } },
                    { resourceId: { contains: q } },
                    { correlationId: { contains: q } },
                  ],
                }
              : {},
          ],
        },
        _count: { _all: true },
        orderBy: { _count: { actorName: "desc" } },
      }),
    ]);

  const topActions = actionGroups.map((group) => ({
    action: group.action,
    count: group._count._all,
  }));
  const entityTypes = entityTypeGroups.map((group) => ({
    entityType: group.resourceType,
    count: group._count._all,
  }));
  const topActors = actorGroups.map((group) => ({
    actor: group.actorName,
    count: group._count._all,
  }));

  const data = rows.map((row) => ({
    id: row.id,
    actorId: row.actorId,
    actorName: row.actorName,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    resourceLabel: row.resourceLabel,
    result: row.result,
    ip: row.ip,
    userAgent: row.userAgent,
    correlationId: row.correlationId,
    beforeJson: parseJson(row.beforeJson),
    afterJson: parseJson(row.afterJson),
    createdAt: row.createdAt.toISOString(),
  }));

  return ok(data, {
    ...pageMeta(page, pageSize, total),
    total,
    last24h,
    distinctActors: topActors.length,
    topActors,
    topActions,
    entityTypes,
  }, 200);
}
