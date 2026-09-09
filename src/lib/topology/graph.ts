/**
 * FayaNMS — Network topology graph builder (Task 18-b).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ ⚠ DEMO DATA — DOCUMENTED SIMULATED LINK DESIGN                          │
 * │ The links below are a DOCUMENTED SIMULATION over the REAL inventory:    │
 * │   • "ha" edges mirror the static in-code redundancy matrix in           │
 * │     src/lib/ha/topology.ts — pair members are REAL seeded hostnames;    │
 * │   • "circuit" edges are REAL CMDB connects_to relations between circuit │
 * │     CIs and device CIs (prisma/seed.ts);                                │
 * │   • "uplink" edges are INVENTED (simulated: true) to give sites with no │
 * │     circuit/HA evidence a deterministic WAN anchor back to HQ.          │
 * │ This is NOT a discovered/live topology and MUST NOT be used for real     │
 * │ capacity or outage planning. The view surfaces the same disclaimer.     │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Everything in this module is pure, deterministic and dependency-free (no
 * db, no React, no Date.now, no Math.random):
 *   - buildTopologyGraph() takes plain data (sites, devices, resolved
 *     circuit→device edges) and returns { nodes, edges, summary } — the API
 *     route does the queries and passes plain rows in;
 *   - identical input ALWAYS produces byte-identical output (every sort is
 *     total, every tiebreak is hashed, edges are deduped on a canonical key)
 *     so two back-to-back GETs are byte-stable apart from generatedAt;
 *   - endpoint order is canonicalized (lexicographically smaller hostname
 *     first) so the graph is direction-stable regardless of discovery order.
 *
 * Derivation rules (documented contract):
 *   1. Nodes — one per device minus UNMANAGED (excluded from the graph).
 *      label = displayName ?? hostname. Nodes are grouped under siteCode;
 *      devices whose siteId is missing (or points at an unknown site) land
 *      in the explicit "unassigned" group (siteCode: null).
 *   2. "ha" edges — for every HA_PAIRS pair (src/lib/ha/topology.ts) both
 *      members are resolved to devices by hostname; the edge is emitted only
 *      when BOTH members exist as graph nodes. Label = pair name (English
 *      technical string — the view localizes edge types).
 *   3. "circuit" edges — one entry per CMDB circuit CI: devices behind that
 *      circuit (via device CIs linked with connects_to) are sorted by
 *      hostname and chained pairwise between CONSECUTIVE hostnames, so a
 *      circuit with N ≥ 2 devices yields N−1 edges and one with < 2 yields
 *      none. Label = circuit CI name (e.g. "ISP-A WAN Circuit — HQ").
 *   4. "uplink" edges (SIMULATED) — ONLY for sites with zero ha/circuit
 *      edges touching any of their devices: the site's anchor device is
 *      picked by role priority WAN_GATEWAY > EDGE_ROUTER > BRANCH_ROUTER >
 *      CORE_ROUTER > CORE_SWITCH > any (ties broken by FNV-1a of hostname,
 *      smallest wins — mirrors src/lib/collectors/distribution.ts) and linked
 *      to the deterministic HQ anchor (same selection among HQ-SAN devices).
 *      The edge carries simulated: true.
 *   5. Dedupe — edges are deduped by source|target|type (first occurrence
 *      wins in HA → circuit → uplink order).
 */

import { HA_PAIRS } from "@/lib/ha/topology";

/* ───────────────────────── input row shapes ───────────────────────── */

export interface TopologySiteInput {
  id: string;
  code: string;
  name: string;
  region: string | null;
}

export interface TopologyDeviceInput {
  id: string;
  hostname: string;
  displayName: string | null;
  role: string | null;
  status: string;
  siteId: string | null;
  model: string | null;
}

/**
 * One CMDB circuit CI with the device ids resolved behind it by the API
 * route (circuit CI —connects_to→ device CI —deviceId→ Device). The ≥2
 * chain rule is applied here, not in the route.
 */
export interface TopologyCircuitEdgeInput {
  /** CI-000NNN business identifier of the circuit CI. */
  ciId: string;
  /** Circuit CI display name — becomes the edge label. */
  name: string;
  /** Device ids of the device CIs connected to this circuit. */
  deviceIds: string[];
}

/* ───────────────────────── output shapes ───────────────────────── */

export type TopologyEdgeType = "ha" | "circuit" | "uplink";

export interface TopologyNode {
  id: string;
  hostname: string;
  /** displayName ?? hostname. */
  label: string;
  role: string | null;
  status: string;
  /** Site code group; null = the explicit "unassigned" group. */
  siteCode: string | null;
  model: string | null;
}

export interface TopologyEdge {
  /** Deterministic id: `${type}:${sourceHostname}|${targetHostname}`. */
  id: string;
  type: TopologyEdgeType;
  /** Canonical order — lexicographically smaller hostname first. */
  sourceHostname: string;
  sourceDeviceId: string;
  targetHostname: string;
  targetDeviceId: string;
  /** English technical label (pair name / circuit CI name / uplink note). */
  label: string;
  /** true only for the simulated uplink design (see the banner above). */
  simulated: boolean;
}

export interface TopologyGraphSummary {
  siteCount: number;
  deviceCount: number;
  edgeCount: number;
  byType: { ha: number; circuit: number; uplink: number };
  simulatedEdgeCount: number;
}

export interface TopologyGraph {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  summary: TopologyGraphSummary;
}

/* ───────────────────────── deterministic helpers ───────────────────────── */

/** The uplink anchor site (seed-stable HQ campus code). */
export const TOPOLOGY_HQ_SITE_CODE = "HQ-SAN";

/**
 * FNV-1a 32-bit hash — mirrors the implementation in
 * src/lib/collectors/distribution.ts (plain string hashing, stable across
 * processes: no Math.random, no Date.now). Duplicated rather than imported
 * so this module stays dependency-free per its contract.
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Anchor role priority — lower wins; unknown/missing roles fall to "any". */
const ANCHOR_ROLE_PRIORITY: readonly string[] = [
  "WAN_GATEWAY",
  "EDGE_ROUTER",
  "BRANCH_ROUTER",
  "CORE_ROUTER",
  "CORE_SWITCH",
];

function anchorRank(role: string | null): number {
  if (!role) return ANCHOR_ROLE_PRIORITY.length;
  const idx = ANCHOR_ROLE_PRIORITY.indexOf(role.trim().toUpperCase());
  return idx === -1 ? ANCHOR_ROLE_PRIORITY.length : idx;
}

function normalizeStatus(status: string | null | undefined): string {
  const normalized = (status ?? "UNKNOWN").trim().toUpperCase();
  return normalized.length > 0 ? normalized : "UNKNOWN";
}

/** Total order over nodes: siteCode asc (unassigned last), then hostname. */
function compareNodes(a: TopologyNode, b: TopologyNode): number {
  if (a.siteCode === null && b.siteCode !== null) return 1;
  if (a.siteCode !== null && b.siteCode === null) return -1;
  if (a.siteCode !== null && b.siteCode !== null && a.siteCode !== b.siteCode) {
    return a.siteCode < b.siteCode ? -1 : 1;
  }
  if (a.hostname !== b.hostname) {
    return a.hostname < b.hostname ? -1 : 1;
  }
  return 0;
}

/**
 * Anchor selection (pure + deterministic): among the given nodes, the
 * winner is the one with the best (lowest) anchor role rank; ties are
 * broken by FNV-1a of the hostname, smallest wins.
 */
function pickAnchor(nodes: readonly TopologyNode[]): TopologyNode | null {
  let best: TopologyNode | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  let bestHash = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    const rank = anchorRank(node.role);
    const hash = fnv1a(node.hostname);
    if (best === null || rank < bestRank || (rank === bestRank && hash < bestHash)) {
      best = node;
      bestRank = rank;
      bestHash = hash;
    }
  }
  return best;
}

/** Canonical (direction-stable) endpoint order — smaller hostname first. */
function canonicalPair(
  a: TopologyNode,
  b: TopologyNode
): { source: TopologyNode; target: TopologyNode } | null {
  if (a.id === b.id) return null; // never emit self-edges
  return a.hostname <= b.hostname
    ? { source: a, target: b }
    : { source: b, target: a };
}

/* ───────────────────────── graph builder ───────────────────────── */

/**
 * Build the topology graph from plain data (pure — see the derivation
 * rules in the module header). Byte-identical output for identical input.
 */
export function buildTopologyGraph(input: {
  sites: readonly TopologySiteInput[];
  devices: readonly TopologyDeviceInput[];
  circuitEdges: readonly TopologyCircuitEdgeInput[];
}): TopologyGraph {
  /* 1 — nodes: UNMANAGED devices are excluded from the graph entirely;
   *     devices without a resolvable site fall into the "unassigned" group. */
  const siteCodeById = new Map(input.sites.map((site) => [site.id, site.code]));

  const nodes: TopologyNode[] = input.devices
    .filter((device) => normalizeStatus(device.status) !== "UNMANAGED")
    .map((device) => ({
      id: device.id,
      hostname: device.hostname,
      label:
        device.displayName && device.displayName.trim().length > 0
          ? device.displayName
          : device.hostname,
      role: device.role,
      status: normalizeStatus(device.status),
      siteCode: device.siteId ? (siteCodeById.get(device.siteId) ?? null) : null,
      model: device.model,
    }))
    .sort(compareNodes);

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const nodeByHostname = new Map(nodes.map((node) => [node.hostname, node]));

  /* 2 — HA edges: both members must resolve to graph nodes. */
  const edges: TopologyEdge[] = [];
  const seen = new Set<string>();

  const pushEdge = (
    type: TopologyEdgeType,
    source: TopologyNode,
    target: TopologyNode,
    label: string,
    simulated: boolean
  ) => {
    const pair = canonicalPair(source, target);
    if (!pair) return;
    const key = `${pair.source.hostname}|${pair.target.hostname}|${type}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({
      id: `${type}:${key}`,
      type,
      sourceHostname: pair.source.hostname,
      sourceDeviceId: pair.source.id,
      targetHostname: pair.target.hostname,
      targetDeviceId: pair.target.id,
      label,
      simulated,
    });
  };

  for (const pair of HA_PAIRS) {
    const [memberA, memberB] = pair.members;
    const a = nodeByHostname.get(memberA);
    const b = nodeByHostname.get(memberB);
    if (!a || !b) continue; // only emit when BOTH members exist
    pushEdge("ha", a, b, pair.name, false);
  }

  /* 3 — circuit edges: chain the circuit's devices pairwise between
   *     consecutive hostnames (deterministic order). Circuits resolving to
   *     < 2 graph nodes yield nothing. */
  const circuits = [...input.circuitEdges].sort((a, b) =>
    a.ciId < b.ciId ? -1 : a.ciId > b.ciId ? 1 : 0
  );
  for (const circuit of circuits) {
    const resolved = [...new Set(circuit.deviceIds)]
      .map((deviceId) => nodeById.get(deviceId))
      .filter((node): node is TopologyNode => node !== undefined)
      .sort((a, b) =>
        a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : 0
      );
    for (let i = 0; i + 1 < resolved.length; i += 1) {
      pushEdge("circuit", resolved[i], resolved[i + 1], circuit.name, false);
    }
  }

  /* 4 — uplink edges (SIMULATED): only for sites with zero ha/circuit
   *     edges touching any of their devices. */
  const sitesWithEdges = new Set<string>();
  for (const edge of edges) {
    for (const nodeId of [edge.sourceDeviceId, edge.targetDeviceId]) {
      const node = nodeById.get(nodeId);
      if (node?.siteCode) sitesWithEdges.add(node.siteCode);
    }
  }

  const nodesBySite = new Map<string, TopologyNode[]>();
  for (const node of nodes) {
    if (!node.siteCode) continue;
    const bucket = nodesBySite.get(node.siteCode);
    if (bucket) bucket.push(node);
    else nodesBySite.set(node.siteCode, [node]);
  }

  const hasHqSite = input.sites.some(
    (site) => site.code === TOPOLOGY_HQ_SITE_CODE
  );
  const hqAnchor = hasHqSite
    ? pickAnchor(nodesBySite.get(TOPOLOGY_HQ_SITE_CODE) ?? [])
    : null;

  const candidateSites = input.sites
    .filter(
      (site) =>
        (nodesBySite.get(site.code)?.length ?? 0) > 0 &&
        !sitesWithEdges.has(site.code)
    )
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  for (const site of candidateSites) {
    const anchor = pickAnchor(nodesBySite.get(site.code) ?? []);
    if (!anchor || !hqAnchor || anchor.id === hqAnchor.id) continue;
    pushEdge(
      "uplink",
      anchor,
      hqAnchor,
      `Uplink to ${TOPOLOGY_HQ_SITE_CODE}`,
      true
    );
  }

  /* 5 — summary over the deduped edge list. */
  const byType = { ha: 0, circuit: 0, uplink: 0 };
  for (const edge of edges) byType[edge.type] += 1;

  const siteCodes = new Set<string>();
  for (const node of nodes) {
    if (node.siteCode) siteCodes.add(node.siteCode);
  }

  return {
    nodes,
    edges,
    summary: {
      siteCount: siteCodes.size,
      deviceCount: nodes.length,
      edgeCount: edges.length,
      byType,
      simulatedEdgeCount: edges.filter((edge) => edge.simulated).length,
    },
  };
}
