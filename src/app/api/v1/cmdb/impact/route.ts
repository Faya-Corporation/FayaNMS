import { db } from "@/lib/db";
import { fail, ok, requestContext } from "../../_lib/api";
import {
  CMDB_IMPACT_MAX_DEPTH,
  cmdbBfsImpact,
  type CmdbImpactEdge,
  type CmdbImpactItem,
} from "@/lib/cmdb/impact";
import { resolveCmdbItem } from "@/lib/cmdb/server";
import { z } from "zod";

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
  const ctx = requestContext(request);
  const url = new URL(request.url);

  const itemId = url.searchParams.get("itemId");
  if (!itemId) {
    return fail("INVALID_QUERY", "itemId: configuration item reference is required", 400, ctx);
  }

  const item = await resolveCmdbItem(itemId);
  if (!item) {
    return fail("CMDB_NOT_FOUND", `No configuration item matches "${itemId}"`, 404, ctx);
  }

  // Materialize the whole graph once (bounded: items + edges are small at
  // fleet scale) and hand it to the pure BFS helper twice.
  const [items, edges] = await Promise.all([
    db.cmdbItem.findMany({
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

  return ok(validated, undefined, 200, ctx);
}
