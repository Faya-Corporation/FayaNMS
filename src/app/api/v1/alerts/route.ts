import { db } from "@/lib/db";
import {
  csvParam,
  fail,
  firstIssueMessage,
  ok,
  pageMeta,
  paginationSchema,
} from "../_lib/api";
import { authErrorToFail, requireSessionRead, sessionScopeFor } from "@/lib/auth/session";
import { scopedDeviceWhere, sessionSiteScope } from "@/lib/auth/scope";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/alerts — alert stream (Task 5-a upgrade).
 *
 * Filters: status (csv), severity (csv), deviceId, siteCode, ruleId,
 * q (message/hostname contains), parentAlertId (children of a root),
 * includeChildren (default false → children are NOT listed separately;
 * roots carry childCount and the UI expands them on demand).
 * Sort: lastSeen (default, desc) | severity (ranked CRITICAL→INFO, desc).
 *
 * meta: { ...page, counts: { byStatus, bySeverity }, linkedOpenIncidents }
 * — counts computed over the filtered set INCLUDING children (operational
 * reality) regardless of the grouping flag; linkedOpenIncidents = distinct
 * incidents referenced by non-resolved alerts in the filtered set.
 *
 * Rows carry rule name, device hostname + site code and the incident
 * number for display chips.
 *
 * F-008 phase 2 (read-plane defense-in-depth): the handler verifies the
 * human session itself (requireSessionRead) — the proxy matcher stays the
 * coarse gate, not the only check, for the alerts read domain.
 *
 * F-031 wave-10 (audit 13-a F-1, read-plane migration): the session's site
 * scope composes into baseWhere through the Alert→device→site relation
 * (scopedDeviceWhere over the device leg), so a sites-limited session sees
 * only its sites' alerts — on the page query AND both groupBy counts AND
 * the linkedOpenIncidents query (all four consume baseWhere). The caller's
 * ?siteCode= filter rides the SAME relation and therefore INTERSECTS with
 * the scope (never widens it): an out-of-scope siteCode answers 200 with
 * zero rows. Wildcard sessions (no `sites` claim — the single-tenant
 * default) keep the byte-unchanged base where; deny-all scopes answer the
 * empty shape. Alerts whose device has no site are hidden from
 * sites-limited sessions (row-level fail-closed SQL parity — the relation
 * filter cannot match a null site code).
 */

const SEVERITY_RANK: Record<string, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
  INFO: 0,
};

const querySchema = paginationSchema.extend({
  status: z.string().optional(),
  severity: z.string().optional(),
  deviceId: z.string().trim().min(1).max(64).optional(),
  siteCode: z.string().trim().min(1).max(32).optional(),
  ruleId: z.string().trim().min(1).max(64).optional(),
  q: z.string().trim().min(1).max(120).optional(),
  parentAlertId: z.string().trim().min(1).max(64).optional(),
  includeChildren: z
    .enum(["true", "false"])
    .default("false"),
  sort: z.enum(["lastSeen", "severity"]).default("lastSeen"),
});

export async function GET(request: Request) {
  try {
    await requireSessionRead(request);
  } catch (error) {
    const envelope = authErrorToFail(error);
    if (envelope) return envelope;
    throw error;
  }

  const url = new URL(request.url);
  const raw = {
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    severity: url.searchParams.get("severity") ?? undefined,
    deviceId: url.searchParams.get("deviceId") ?? undefined,
    siteCode: url.searchParams.get("siteCode") ?? undefined,
    ruleId: url.searchParams.get("ruleId") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
    parentAlertId: url.searchParams.get("parentAlertId") ?? undefined,
    includeChildren: url.searchParams.get("includeChildren") ?? undefined,
    sort: url.searchParams.get("sort") ?? undefined,
  };
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }

  const {
    page,
    pageSize,
    deviceId,
    siteCode,
    ruleId,
    q,
    parentAlertId,
    sort,
  } = parsed.data;
  const statuses = csvParam(parsed.data.status);
  const severities = csvParam(parsed.data.severity);
  const includeChildren = parsed.data.includeChildren === "true";

  // ── F-031 wave-10: resolve the session scope once for every leg ──────
  const scopeClaims = await sessionScopeFor(request);
  const scope = sessionSiteScope(scopeClaims);
  const isWildcard = scope.mode === "wildcard";

  /** Shared filter conditions (grouping handled separately). */
  const baseWhere = {
    AND: [
      statuses ? { status: { in: statuses } } : {},
      severities ? { severity: { in: severities } } : {},
      deviceId ? { deviceId } : {},
      siteCode ? { device: { site: { code: siteCode } } } : {},
      ruleId ? { ruleId } : {},
      q
        ? {
            OR: [
              { message: { contains: q } },
              { device: { hostname: { contains: q } } },
            ],
          }
        : {},
      // F-031 wave-10: the session's site scope rides the SAME device
      // relation as the ?siteCode= filter above — the two compose as an
      // intersection (a caller-chosen out-of-scope siteCode matches
      // nothing, never the unscoped set). Wildcard keeps the base where
      // byte-identical (no device leg at all — the parity guarantee).
      ...(isWildcard ? [] : [{ device: scopedDeviceWhere(scopeClaims, {}) }]),
    ],
  };

  /** Grouping: explicit children list, everything, or roots only. */
  const groupingWhere = parentAlertId
    ? { parentAlertId }
    : includeChildren
      ? {}
      : { parentAlertId: null };

  const where = { AND: [baseWhere, groupingWhere] };

  const select = {
    id: true,
    deviceId: true,
    severity: true,
    message: true,
    status: true,
    firstSeen: true,
    lastSeen: true,
    count: true,
    dedupKey: true,
    parentAlertId: true,
    suppressReason: true,
    acknowledgedAt: true,
    device: {
      select: {
        id: true,
        hostname: true,
        site: { select: { id: true, name: true, code: true } },
      },
    },
    rule: { select: { id: true, name: true, severity: true } },
    incident: {
      select: { id: true, number: true, severity: true, status: true },
    },
    acknowledgedBy: { select: { id: true, name: true } },
    assignedTo: { select: { id: true, name: true } },
    _count: { select: { childAlerts: true } },
  } as const;

  const [total, byStatus, bySeverity, linked] = await Promise.all([
    db.alert.count({ where }),
    db.alert.groupBy({ by: ["status"], _count: { _all: true }, where: baseWhere }),
    db.alert.groupBy({ by: ["severity"], _count: { _all: true }, where: baseWhere }),
    db.alert.findMany({
      where: {
        AND: [
          baseWhere,
          {
            status: { in: ["ACTIVE", "ACKNOWLEDGED", "SUPPRESSED"] },
            incidentId: { not: null },
          },
        ],
      },
      select: { incidentId: true },
      distinct: ["incidentId"],
    }),
  ]);

  let rows;
  if (sort === "severity") {
    // SQLite has no CASE orderBy in Prisma — small demo volumes allow an
    // in-memory rank (hard cap keeps it bounded).
    const candidates = await db.alert.findMany({
      where,
      orderBy: { lastSeen: "desc" },
      take: 500,
      select,
    });
    candidates.sort((a, b) => {
      const rankDelta =
        (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
      if (rankDelta !== 0) return rankDelta;
      return b.lastSeen.getTime() - a.lastSeen.getTime();
    });
    rows = candidates.slice((page - 1) * pageSize, page * pageSize);
  } else {
    rows = await db.alert.findMany({
      where,
      orderBy: { lastSeen: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select,
    });
  }

  return ok(rows, {
    ...pageMeta(page, pageSize, total),
    counts: {
      byStatus: Object.fromEntries(
        byStatus.map((row) => [row.status, row._count._all])
      ),
      bySeverity: Object.fromEntries(
        bySeverity.map((row) => [row.severity, row._count._all])
      ),
    },
    linkedOpenIncidents: linked.length,
  }, 200);
}
