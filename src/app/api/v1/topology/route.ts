import { db } from "@/lib/db";
import { ok, requestContext } from "../_lib/api";
import { z } from "zod";
import {
  buildTopologyGraph,
  type TopologyCircuitEdgeInput,
} from "@/lib/topology/graph";

export const dynamic = "force-dynamic";

/* ─────────────────────────────────────────────────────────────────────────────
 * Network topology map — GET /api/v1/topology (Task 18-b)
 *
 * Deterministic composition over REAL inventory + a DOCUMENTED SIMULATED
 * link design (src/lib/topology/graph.ts — see its honesty banner):
 *
 *   sites    — real Site rows (id/code/name/region, ordered by code) — the
 *              grouping backbone of the map.
 *   devices  — real Device rows minus UNMANAGED (the graph's exclusion rule
 *              is enforced here AND in the pure builder) with their site
 *              code included for grouping.
 *   circuits — CMDB circuit CIs joined through connects_to CmdbRelations to
 *              device CIs (deviceId unique link) → circuitEdges input rows.
 *              The seed ships one circuit ("ISP-A WAN Circuit — HQ") wired
 *              to HQ-WAN-SRX-01 and DC-Core-RTR-01.
 *
 * The pure builder then derives: nodes grouped under siteCode (unassigned
 * group for orphans), HA edges from the static redundancy matrix
 * (src/lib/ha/topology.ts — REAL seed hostnames), circuit edges from the
 * CMDB relations, and SIMULATED uplink edges for sites with zero ha/circuit
 * evidence (documented derivation, simulated: true on the edge).
 *
 * Bounded queries: all sites, one ≤30-row device scan, one small CI scan
 * (circuit+device CIs only) and one connects_to relation scan. Read-only
 * GET → no audit event (app convention). Identical data always yields a
 * byte-identical graph — two back-to-back GETs differ only in generatedAt
 * (deterministic-composition contract, verified in Task 18-b).
 * ───────────────────────────────────────────────────────────────────────────── */

/* ── response schema (Zod-validated response contract) ── */

const nodeSchema = z.object({
  id: z.string(),
  hostname: z.string(),
  label: z.string(),
  role: z.string().nullable(),
  status: z.string(),
  siteCode: z.string().nullable(),
  model: z.string().nullable(),
});

const edgeSchema = z.object({
  id: z.string(),
  type: z.enum(["ha", "circuit", "uplink"]),
  sourceHostname: z.string(),
  sourceDeviceId: z.string(),
  targetHostname: z.string(),
  targetDeviceId: z.string(),
  label: z.string(),
  simulated: z.boolean(),
});

const summarySchema = z.object({
  siteCount: z.number().int().min(0),
  deviceCount: z.number().int().min(0),
  edgeCount: z.number().int().min(0),
  byType: z.object({
    ha: z.number().int().min(0),
    circuit: z.number().int().min(0),
    uplink: z.number().int().min(0),
  }),
  simulatedEdgeCount: z.number().int().min(0),
});

const responseSchema = z.object({
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
  summary: summarySchema,
  generatedAt: z.string(),
});

export type TopologyApiResponse = z.infer<typeof responseSchema>;

export async function GET(request: Request) {
  const ctx = requestContext(request);

  /* 1 — sites (grouping backbone, ordered by code for determinism). */
  const sites = await db.site.findMany({
    select: { id: true, code: true, name: true, region: true },
    orderBy: { code: "asc" },
  });

  /* 2 — devices minus UNMANAGED (graph exclusion rule) with site code. */
  const devices = await db.device.findMany({
    where: { status: { not: "UNMANAGED" } },
    select: {
      id: true,
      hostname: true,
      displayName: true,
      role: true,
      status: true,
      siteId: true,
      model: true,
      site: { select: { code: true } },
    },
    orderBy: { hostname: "asc" },
  });

  /* 3 — CMDB circuit CIs + connects_to relations (two bounded queries). */
  const [cmdbItems, connectsTo] = await Promise.all([
    db.cmdbItem.findMany({
      where: { ciType: { in: ["circuit", "device"] } },
      select: { id: true, ciId: true, name: true, ciType: true, deviceId: true },
    }),
    db.cmdbRelation.findMany({
      where: { relationType: "connects_to" },
      select: { sourceId: true, targetId: true },
    }),
  ]);

  /* 4 — resolve circuit CI → device CI(s) → device ids.
   *     A connects_to relation may point either way (circuit↔device). */
  const circuitCis = cmdbItems.filter((ci) => ci.ciType === "circuit");
  const circuitIds = new Set(circuitCis.map((ci) => ci.id));
  const deviceIdByDeviceCiId = new Map(
    cmdbItems
      .filter((ci) => ci.ciType === "device" && ci.deviceId !== null)
      .map((ci) => [ci.id, ci.deviceId as string])
  );

  const deviceIdsByCircuitId = new Map<string, Set<string>>();
  for (const relation of connectsTo) {
    let circuitId: string | null = null;
    let otherId: string | null = null;
    if (circuitIds.has(relation.sourceId)) {
      circuitId = relation.sourceId;
      otherId = relation.targetId;
    } else if (circuitIds.has(relation.targetId)) {
      circuitId = relation.targetId;
      otherId = relation.sourceId;
    }
    if (!circuitId || !otherId) continue;
    const deviceId = deviceIdByDeviceCiId.get(otherId);
    if (!deviceId) continue; // the other end is not a device CI
    const bucket = deviceIdsByCircuitId.get(circuitId);
    if (bucket) bucket.add(deviceId);
    else deviceIdsByCircuitId.set(circuitId, new Set([deviceId]));
  }

  const circuitEdges: TopologyCircuitEdgeInput[] = circuitCis
    .filter((ci) => (deviceIdsByCircuitId.get(ci.id)?.size ?? 0) > 0)
    .map((ci) => ({
      ciId: ci.ciId,
      name: ci.name,
      deviceIds: [...(deviceIdsByCircuitId.get(ci.id) ?? new Set<string>())],
    }))
    .sort((a, b) => (a.ciId < b.ciId ? -1 : a.ciId > b.ciId ? 1 : 0));

  /* 5 — pure, deterministic composition (byte-stable for identical data). */
  const graph = buildTopologyGraph({
    sites,
    devices: devices.map((device) => ({
      id: device.id,
      hostname: device.hostname,
      displayName: device.displayName,
      role: device.role,
      status: device.status,
      siteId: device.siteId,
      model: device.model,
    })),
    circuitEdges,
  });

  const payload = { ...graph, generatedAt: new Date().toISOString() };

  // Zod-validated response contract — a malformed payload fails loudly
  // instead of shipping a shape the client cannot trust.
  const validated: TopologyApiResponse = responseSchema.parse(payload);

  return ok(validated, { generatedAt: payload.generatedAt }, 200, ctx);
}
