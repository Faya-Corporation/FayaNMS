import { db } from "@/lib/db";
import {
  csvParam,
  fail,
  firstIssueMessage,
  ok,
  pageMeta,
  paginationSchema,
} from "../_lib/api";
import { computeSlaState, INCIDENT_OPEN_STATUSES } from "@/lib/incidents/lifecycle";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/incidents — incident list (Task 5-b, extends the Phase-1 slice).
 *
 * Filters:
 *   status     csv multi (NEW | ACKNOWLEDGED | … | CLOSED)
 *   severity   csv multi (SEV1..SEV4)
 *   siteCode   exact site code (e.g. HQ)
 *   deviceId   incidents linked to the device (IncidentDevice join)
 *   q          contains on title or number
 *   source     exact (ALERT | FAILED_CHANGE | FAILED_BACKUP | DRIFT | …)
 *   ownerId    exact acting owner id
 *   breached   "1" → open incidents past their slaDueAt only
 *   sort       createdAt (default, desc) | severity (SEV1 first) | slaDueAt
 *              (soonest due first)
 *
 * meta: pagination + counts by status + counts by severity (each over the
 * other filters) + openCount + slaBreachedCount. Rows carry device/alert
 * counts, the linked change number and the owner for the list surface.
 */

const querySchema = paginationSchema.extend({
  status: z.string().optional(),
  severity: z.string().optional(),
  siteCode: z.string().trim().max(32).optional(),
  deviceId: z.string().trim().max(64).optional(),
  q: z.string().trim().max(120).optional(),
  source: z.string().trim().max(32).optional(),
  ownerId: z.string().trim().max(64).optional(),
  breached: z.string().optional(),
  sort: z.enum(["createdAt", "severity", "slaDueAt"]).optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    severity: url.searchParams.get("severity") ?? undefined,
    siteCode: url.searchParams.get("siteCode") ?? undefined,
    deviceId: url.searchParams.get("deviceId") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
    source: url.searchParams.get("source") ?? undefined,
    ownerId: url.searchParams.get("ownerId") ?? undefined,
    breached: url.searchParams.get("breached") ?? undefined,
    sort: url.searchParams.get("sort") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }

  const { page, pageSize } = parsed.data;
  const statuses = csvParam(parsed.data.status);
  const severities = csvParam(parsed.data.severity);
  const wantsBreached = parsed.data.breached === "1" || parsed.data.breached === "true";

  /** Every filter except the two facet fields used for the meta counts. */
  const scopeWhere = {
    AND: [
      parsed.data.siteCode ? { site: { code: parsed.data.siteCode } } : {},
      parsed.data.deviceId
        ? { devices: { some: { deviceId: parsed.data.deviceId } } }
        : {},
      parsed.data.q
        ? {
            OR: [
              { title: { contains: parsed.data.q } },
              { number: { contains: parsed.data.q } },
            ],
          }
        : {},
      parsed.data.source ? { source: parsed.data.source } : {},
      parsed.data.ownerId ? { ownerId: parsed.data.ownerId } : {},
    ],
  };

  const listWhere = {
    AND: [
      scopeWhere,
      statuses ? { status: { in: statuses } } : {},
      severities ? { severity: { in: severities } } : {},
      wantsBreached
        ? {
            status: { in: [...INCIDENT_OPEN_STATUSES] },
            slaDueAt: { lt: new Date() },
          }
        : {},
    ],
  };

  const orderBy =
    parsed.data.sort === "severity"
      ? [{ severity: "asc" as const }, { createdAt: "desc" as const }]
      : parsed.data.sort === "slaDueAt"
        ? [{ slaDueAt: "asc" as const }, { createdAt: "desc" as const }]
        : [{ createdAt: "desc" as const }];

  const [total, rows, byStatus, bySeverity, openCount, slaBreachedCount] =
    await Promise.all([
      db.incident.count({ where: listWhere }),
      db.incident.findMany({
        where: listWhere,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          number: true,
          title: true,
          severity: true,
          priority: true,
          status: true,
          source: true,
          ownerTeam: true,
          ownerId: true,
          owner: { select: { id: true, name: true } },
          createdAt: true,
          acknowledgedAt: true,
          slaDueAt: true,
          resolvedAt: true,
          updatedAt: true,
          site: { select: { name: true, code: true } },
          change: { select: { id: true, number: true, status: true } },
          _count: { select: { devices: true, alerts: true } },
        },
      }),
      db.incident.groupBy({
        by: ["status"],
        where: scopeWhere,
        _count: { _all: true },
      }),
      db.incident.groupBy({
        by: ["severity"],
        where: scopeWhere,
        _count: { _all: true },
      }),
      db.incident.count({
        where: {
          AND: [scopeWhere, { status: { in: [...INCIDENT_OPEN_STATUSES] } }],
        },
      }),
      db.incident.count({
        where: {
          AND: [
            scopeWhere,
            { status: { in: [...INCIDENT_OPEN_STATUSES] } },
            { slaDueAt: { lt: new Date() } },
          ],
        },
      }),
    ]);

  const statusCounts: Record<string, number> = {};
  for (const entry of byStatus) {
    statusCounts[entry.status] = entry._count._all;
  }
  const severityCounts: Record<string, number> = {};
  for (const entry of bySeverity) {
    severityCounts[entry.severity] = entry._count._all;
  }

  const now = new Date();
  const data = rows.map((row) => ({
    ...row,
    sla: computeSlaState({
      severity: row.severity,
      status: row.status,
      createdAt: row.createdAt,
      slaDueAt: row.slaDueAt,
      resolvedAt: row.resolvedAt,
      now,
    }),
  }));

  return ok(data, {
    ...pageMeta(page, pageSize, total),
    counts: { byStatus: statusCounts, bySeverity: severityCounts },
    openCount,
    slaBreachedCount,
  });
}
