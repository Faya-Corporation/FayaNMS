import { db } from "@/lib/db";
import {
  authErrorToFail,
  requireSessionRead,
  sessionScopeFor,
} from "@/lib/auth/session";
import { scopedDeviceWhere, sessionSiteScope } from "@/lib/auth/scope";
import { ok } from "../_lib/api";
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
 *
 * F-031 wave-9 (read-plane migration): a sites-limited session sees ITS
 * sites + their devices only — the sites backbone is filtered to the scope
 * codes, the device scan composes scopedDeviceWhere, and the 24h discovery
 * evidence (openPorts / osFingerprint / IP) only resolves for in-scope
 * devices (a scope filter rides the observation's device relation).
 * Circuit CIs feed the pure builder, which emits edges only between
 * graph-present (in-scope) devices, so out-of-scope endpoints can never
 * appear as nodes or edge endpoints. Wildcard sessions keep the exact
 * pre-F-031 query shapes (parity guarantee); deny-all sessions get an
 * empty graph. A discovery observation row for an out-of-scope device is
 * dropped whole — no IP/hostname/port evidence survives.
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

const discoveryEvidenceSchema = z.object({
  deviceId: z.string(),
  ip: z.string(),
  hostname: z.string(),
  observedAt: z.string(),
  openPorts: z.array(z.number().int().min(1).max(65_535)),
  protocols: z.array(z.string()),
  confidence: z.number().int().min(0).max(100),
  osFingerprint: z.string(),
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
  discoveryEvidence: z.array(discoveryEvidenceSchema),
  summary: summarySchema,
  generatedAt: z.string(),
});

export type TopologyApiResponse = z.infer<typeof responseSchema>;

export async function GET(request: Request) {
  // F-008 phase 4b (read-plane defense-in-depth): the GET handler verifies
  // the human session itself (requireSessionRead) — the proxy matcher stays
  // the coarse gate, not the only check.
  try {
    await requireSessionRead(request);
  } catch (error) {
    const envelope = authErrorToFail(error);
    if (envelope) return envelope;
    throw error;
  }
  /* 1 — sites (grouping backbone, ordered by code for determinism).
   * F-031 wave-9: sites-limited sessions see only their own sites; wildcard
   * keeps the unfiltered scan. */
  const scopeClaims = await sessionScopeFor(request);
  const scope = sessionSiteScope(scopeClaims);
  const sites = await db.site.findMany({
    ...(scope.mode === "sites" ? { where: { code: { in: scope.codes } } } : {}),
    select: { id: true, code: true, name: true, region: true },
    orderBy: { code: "asc" },
  });

  /* 2 — devices minus UNMANAGED (graph exclusion rule) with site code.
   * F-031 wave-9: the scope composes through scopedDeviceWhere — wildcard
   * keeps the exact pre-F-031 where ({ status: { not: UNMANAGED } }). */
  const devices = await db.device.findMany({
    where: scopedDeviceWhere(scopeClaims, { status: { not: "UNMANAGED" } }),
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

  const recentObservations = await db.discoveryObservation.findMany({
    where: {
      observedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1_000) },
      deviceId: { not: null },
      // F-031 wave-9: evidence only for in-scope devices — sites-limited
      // sessions cannot read another site's open ports / OS fingerprint.
      // Wildcard keeps the where shape unchanged; deny-all matches nothing.
      ...(scope.mode === "sites"
        ? { device: scopedDeviceWhere(scopeClaims, {}) }
        : {}),
    },
    orderBy: { observedAt: "desc" },
    take: 500,
    select: {
      deviceId: true,
      ip: true,
      hostname: true,
      observedAt: true,
      openPortsJson: true,
      protocolsJson: true,
      confidence: true,
      osFingerprint: true,
    },
  });
  const observedDeviceIds = new Set<string>();
  const discoveryEvidence = recentObservations.flatMap((observation) => {
    if (!observation.deviceId || observedDeviceIds.has(observation.deviceId)) return [];
    observedDeviceIds.add(observation.deviceId);
    let openPorts: unknown = [];
    let protocols: unknown = [];
    try {
      openPorts = JSON.parse(observation.openPortsJson);
      protocols = JSON.parse(observation.protocolsJson);
    } catch {
      // Corrupt evidence is omitted from the typed topology response.
    }
    return [{
      deviceId: observation.deviceId,
      ip: observation.ip,
      hostname: observation.hostname,
      observedAt: observation.observedAt.toISOString(),
      openPorts: Array.isArray(openPorts)
        ? openPorts.filter((port): port is number => typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65_535)
        : [],
      protocols: Array.isArray(protocols)
        ? protocols.filter((protocol): protocol is string => typeof protocol === "string").slice(0, 8)
        : [],
      confidence: observation.confidence,
      osFingerprint: observation.osFingerprint,
    }];
  });

  const payload = { ...graph, discoveryEvidence, generatedAt: new Date().toISOString() };

  // Zod-validated response contract — a malformed payload fails loudly
  // instead of shipping a shape the client cannot trust.
  const validated: TopologyApiResponse = responseSchema.parse(payload);

  return ok(validated, { generatedAt: payload.generatedAt }, 200);
}
