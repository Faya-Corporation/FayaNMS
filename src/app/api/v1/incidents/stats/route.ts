import { db } from "@/lib/db";
import { ok } from "../../_lib/api";
import { INCIDENT_OPEN_STATUSES } from "@/lib/incidents/lifecycle";
import { authErrorToFail, requireSessionRead, sessionScopeFor } from "@/lib/auth/session";
import { scopedIncidentSiteWhere } from "../../_lib/incident-scope";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/incidents/stats — incident dashboard KPIs (Task 5-b).
 *
 *   openBySeverity   open (non-resolved) incidents by SEV1..SEV4
 *   openCount        total open
 *   breachedCount    open incidents past slaDueAt
 *   mttaMinutes      avg(acknowledgedAt - createdAt) over the last 30 days'
 *                    acknowledged incidents (any current status)
 *   mttrMinutes      avg(resolvedAt - createdAt) over the same 30-day window
 *                    (resolved + closed)
 *   slaCompliancePct resolved within slaDueAt / total resolved with an SLA
 *                    (30-day window)
 *   topSites         sites by open incident count (max 5)
 *   trend            incidents created per day over the last 14 days
 *
 * Computation is done over raw rows in JS — the tables are small in the demo
 * and every field is covered by the createdAt/status/slaDueAt indexes.
 *
 * F-031 wave-10 (audit 13-a F-2, read-plane migration): every
 * incident-derived aggregation leg composes the session scope via the
 * incident's own `site` relation (scopedIncidentSiteWhere — the AI-plane
 * predicate), so openBySeverity/openCount, the MTTA/MTTR + SLA window,
 * the trend, topSites AND breachedCount answer only the session's sites
 * (cross-site aggregation — topSites was the audit's sharpest unreported
 * specific — can no longer name out-of-scope sites). Wildcard sessions
 * (no `sites` claim) keep the byte-unchanged where clauses.
 */

const MTTA_MTTR_DAYS = 30;
const TREND_DAYS = 14;

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
  const now = new Date();
  const windowStart = new Date(now.getTime() - MTTA_MTTR_DAYS * 86_400_000);
  const trendStart = new Date(now.getTime() - (TREND_DAYS - 1) * 86_400_000);
  trendStart.setUTCHours(0, 0, 0, 0);

  // ── F-031 wave-10: resolve the session scope once for every leg ──────
  const scopeClaims = await sessionScopeFor(request);

  const [openRows, resolvedWindow, trendRows, topSiteGroups] = await Promise.all([
    db.incident.findMany({
      where: {
        status: { in: [...INCIDENT_OPEN_STATUSES] },
        ...scopedIncidentSiteWhere(scopeClaims),
      },
      select: { severity: true },
    }),
    db.incident.findMany({
      where: {
        resolvedAt: { not: null },
        createdAt: { gte: windowStart },
        ...scopedIncidentSiteWhere(scopeClaims),
      },
      select: {
        createdAt: true,
        acknowledgedAt: true,
        resolvedAt: true,
        slaDueAt: true,
      },
    }),
    db.incident.findMany({
      where: {
        createdAt: { gte: trendStart },
        ...scopedIncidentSiteWhere(scopeClaims),
      },
      select: { createdAt: true },
    }),
    db.incident.groupBy({
      by: ["siteId"],
      where: {
        status: { in: [...INCIDENT_OPEN_STATUSES] },
        ...scopedIncidentSiteWhere(scopeClaims),
      },
      _count: { _all: true },
    }),
  ]);

  const openBySeverity: Record<string, number> = {
    SEV1: 0,
    SEV2: 0,
    SEV3: 0,
    SEV4: 0,
  };
  for (const row of openRows) {
    if (openBySeverity[row.severity] !== undefined) openBySeverity[row.severity] += 1;
  }

  let mttaTotal = 0;
  let mttaSamples = 0;
  let mttrTotal = 0;
  let mttrSamples = 0;
  let slaMet = 0;
  let slaTotal = 0;
  for (const row of resolvedWindow) {
    if (row.acknowledgedAt) {
      mttaTotal += row.acknowledgedAt.getTime() - row.createdAt.getTime();
      mttaSamples += 1;
    }
    if (row.resolvedAt) {
      mttrTotal += row.resolvedAt.getTime() - row.createdAt.getTime();
      mttrSamples += 1;
      if (row.slaDueAt) {
        slaTotal += 1;
        if (row.resolvedAt.getTime() <= new Date(row.slaDueAt).getTime()) {
          slaMet += 1;
        }
      }
    }
  }

  const siteIds = topSiteGroups
    .map((group) => group.siteId)
    .filter((id): id is string => Boolean(id));
  const sites = siteIds.length
    ? await db.site.findMany({
        where: { id: { in: siteIds } },
        select: { id: true, name: true, code: true },
      })
    : [];
  const siteById = new Map(sites.map((site) => [site.id, site]));
  const topSites = topSiteGroups
    .map((group) => ({
      siteId: group.siteId,
      siteName: group.siteId ? siteById.get(group.siteId)?.name ?? null : null,
      siteCode: group.siteId ? siteById.get(group.siteId)?.code ?? null : null,
      openCount: group._count._all,
    }))
    .sort((a, b) => b.openCount - a.openCount)
    .slice(0, 5);

  const trendBuckets = new Map<string, number>();
  for (let day = TREND_DAYS - 1; day >= 0; day -= 1) {
    const key = new Date(now.getTime() - day * 86_400_000).toISOString().slice(0, 10);
    trendBuckets.set(key, 0);
  }
  for (const row of trendRows) {
    const key = row.createdAt.toISOString().slice(0, 10);
    if (trendBuckets.has(key)) trendBuckets.set(key, (trendBuckets.get(key) ?? 0) + 1);
  }

  const minutes = (ms: number) => Math.round((ms / 60_000) * 10) / 10;

  const breachedCount = await db.incident.count({
    where: {
      status: { in: [...INCIDENT_OPEN_STATUSES] },
      slaDueAt: { lt: now },
      // F-031 wave-10: the breach counter rides the same site scope.
      ...scopedIncidentSiteWhere(scopeClaims),
    },
  });

  return ok({
    openBySeverity,
    openCount: openRows.length,
    breachedCount,
    mttaMinutes: mttaSamples > 0 ? minutes(mttaTotal / mttaSamples) : null,
    mttrMinutes: mttrSamples > 0 ? minutes(mttrTotal / mttrSamples) : null,
    mttaSamples,
    mttrSamples,
    slaCompliancePct: slaTotal > 0 ? Math.round((slaMet / slaTotal) * 100) : null,
    slaResolvedTotal: slaTotal,
    slaMetTotal: slaMet,
    topSites,
    trend: [...trendBuckets.entries()].map(([date, created]) => ({ date, created })),
    window: { mttaMttrDays: MTTA_MTTR_DAYS, trendDays: TREND_DAYS },
    generatedAt: now.toISOString(),
  });
}
