import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { fail, ok } from "../../_lib/api";
import {
  CMDB_IMPACT_MAX_DEPTH,
  cmdbBfsImpact,
  type CmdbImpactEdge,
  type CmdbImpactItem,
} from "@/lib/cmdb/impact";
import { resolveCmdbItem } from "@/lib/cmdb/server";
import { z } from "zod";
import {
  authErrorToFail,
  requireSessionRead,
  sessionScopeFor,
} from "@/lib/auth/session";
import { sessionAllowsSite, sessionSiteScope } from "@/lib/auth/scope";

export const dynamic = "force-dynamic";

/* ─────────────────────────────────────────────────────────────────────────────
 * CMDB — impact analysis (Phase 15-a)
 *
 * GET /api/v1/cmdb/impact?itemId=…
 *   Deterministic breadth-first walk of the relation graph from the given
 *   CI in BOTH directions (see src/lib/cmdb/impact.ts for the edge
 *   semantics and the upstream/downstream contract):
 *
 *     upstream   — hop 1..4 over OUTGOING edges: what this CI depends on /
 *                  runs on / connects to / is monitored by. If one of these
 *                  fails, the analyzed CI is at risk.
 *     downstream — hop 1..4 over INCOMING edges reversed: the dependents —
 *                  services that depend_on it, consumers that run_on it,
 *                  members of it, endpoints connected to it. If the analyzed
 *                  CI fails, these are impacted.
 *
 *   Cycle-safe (visited set — every node appears once at its minimum hop
 *   count), max depth 4, ordering (hop asc, then ciId asc) is fully
 *   deterministic so polling/refreshes never reshuffle rows. 404 when the
 *   item is unknown. Read-only → no audit event (app convention).
 *
 *   F-031 wave-9 (read-plane migration): the analyzed graph is scoped —
 *   the BFS materializes only the CIs a sites-limited session can see (the
 *   cmdb/items visibility predicate) and only edges whose BOTH endpoints
 *   are visible, so impact paths never traverse out-of-scope CIs. An
 *   out-of-scope start item answers the SAME `CMDB_NOT_FOUND` 404 envelope
 *   a wildcard session gets for a missing item (404-not-403). Wildcard
 *   sessions keep the byte-unchanged unfiltered materialization; a
 *   deny-all session still walks the linkage-less CIs (documented global
 *   resource edge).
 * ───────────────────────────────────────────────────────────────────────────── */

const impactedNodeSchema = z.object({
  id: z.string(),
  ciId: z.string(),
  name: z.string(),
  ciType: z.string(),
  status: z.string(),
  criticality: z.string(),
  hop: z.number().int().min(1).max(CMDB_IMPACT_MAX_DEPTH),
  path: z.array(z.string()).min(2),
  via: z.array(z.string()).min(1),
});

const responseSchema = z.object({
  item: z.object({
    id: z.string(),
    ciId: z.string(),
    name: z.string(),
    ciType: z.string(),
    status: z.string(),
    criticality: z.string(),
  }),
  upstream: z.array(impactedNodeSchema),
  downstream: z.array(impactedNodeSchema),
  meta: z.object({
    maxDepth: z.number().int(),
    generatedAt: z.string(),
  }),
});

export type CmdbImpactResponse = z.infer<typeof responseSchema>;

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

  const itemId = url.searchParams.get("itemId");
  if (!itemId) {
    return fail("INVALID_QUERY", "itemId: configuration item reference is required", 400);
  }

  const item = await resolveCmdbItem(itemId);
  if (!item) {
    return fail("CMDB_NOT_FOUND", `No configuration item matches "${itemId}"`, 404);
  }

  // F-031 wave-9: out-of-scope start item → the SAME 404 as a missing one.
  const scopeClaims = await sessionScopeFor(request);
  const scope = sessionSiteScope(scopeClaims);
  const isWildcard = scope.mode === "wildcard";
  if (
    !isWildcard &&
    !sessionAllowsSite(scopeClaims, await cmdbItemSiteCode(item))
  ) {
    return fail("CMDB_NOT_FOUND", `No configuration item matches "${itemId}"`, 404);
  }
  // Sites-limited sessions materialize the VISIBLE subgraph only; the
  // wildcard path never consumes ciScopeWhere (every use is guarded).
  const scopedCodes = scope.mode === "sites" ? scope.codes : [];
  const ciScopeWhere: Prisma.CmdbItemWhereInput = {
    OR: [
      { device: { site: { code: { in: scopedCodes } } } },
      { AND: [{ deviceId: null }, { siteId: { in: scopedCodes } }] },
      { AND: [{ deviceId: null }, { siteId: null }] },
    ],
  };

  // Materialize the graph once (bounded: items + edges are small at
  // fleet scale) and hand it to the pure BFS helper twice. F-031 wave-9:
  // sites-limited sessions materialize the VISIBLE subgraph only.
  const [items, edges] = await Promise.all([
    db.cmdbItem.findMany({
      ...(isWildcard
        ? {}
        : {
            where: ciScopeWhere,
          }),
      select: {
        id: true,
        ciId: true,
        name: true,
        ciType: true,
        status: true,
        criticality: true,
      },
    }),
    db.cmdbRelation.findMany({
      ...(isWildcard
        ? {}
        : {
            where: {
              AND: [{ source: ciScopeWhere }, { target: ciScopeWhere }],
            },
          }),
      select: { sourceId: true, targetId: true, relationType: true },
    }),
  ]);

  const start: CmdbImpactItem = {
    id: item.id,
    ciId: item.ciId,
    name: item.name,
    ciType: item.ciType,
    status: item.status,
    criticality: item.criticality,
  };
  const impactEdges: CmdbImpactEdge[] = edges.map((edge) => ({
    sourceId: edge.sourceId,
    targetId: edge.targetId,
    relationType: edge.relationType,
  }));

  const payload = {
    item: start,
    upstream: cmdbBfsImpact(item.id, items, impactEdges, "upstream"),
    downstream: cmdbBfsImpact(item.id, items, impactEdges, "downstream"),
    meta: {
      maxDepth: CMDB_IMPACT_MAX_DEPTH,
      generatedAt: new Date().toISOString(),
    },
  };

  // Zod-validated response contract (HA precedent) — deterministic payload,
  // validated shape.
  const validated = responseSchema.parse(payload);

  return ok(validated, undefined, 200);
}

/* ───────────────────────── F-031 wave-9 helper ───────────────────────── */

/**
 * Resolve the CI's governing site code (the cmdb/items list predicate's
 * linkage): the LINKED DEVICE's site when device-linked (a site-less
 * linked device yields null, which HIDES the CI from sites-limited
 * sessions); otherwise the CI's own siteId tag; null when the CI has no
 * site linkage (global resource — the assertSiteScope(null) bypass).
 *
 * KEPT IN SYNC with the twin helpers in cmdb/items/route.ts,
 * cmdb/items/[id]/route.ts and cmdb/relations/route.ts.
 */
async function cmdbItemSiteCode(item: {
  deviceId: string | null;
  siteId: string | null;
}): Promise<string | null> {
  if (item.deviceId) {
    const device = await db.device.findUnique({
      where: { id: item.deviceId },
      select: { site: { select: { code: true } } },
    });
    return device?.site?.code ?? null;
  }
  return item.siteId;
}
