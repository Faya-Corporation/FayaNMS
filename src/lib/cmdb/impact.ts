/**
 * CMDB impact analysis (Phase 15-a) — deterministic BFS over the relation
 * graph. No DB access here: routes materialize the edge list, this module
 * walks it. Two back-to-back runs over the same edges are byte-identical
 * (same hop counts, same paths, same ordering) — the deterministic-
 * composition contract the polling UI relies on.
 *
 * SEMANTICS (documented edge direction, mirrored in prisma/schema.prisma):
 *   an edge source → target of type T reads as
 *     depends_on    — the source requires the target to function
 *     runs_on       — the source is hosted on the target
 *     part_of       — the source is a component of the target
 *     connects_to   — the source is physically/logically linked to the target
 *     monitored_by  — the target watches the source's health
 *
 *   upstream   = follow OUTGOING edges (what this CI depends on / runs on /
 *                connects to / is monitored by) — the supporting dependency
 *                chain. If a node here fails, the selected CI is at risk.
 *   downstream = follow INCOMING edges reversed (what depends on / runs on /
 *                is part of / connects to this CI) — the dependents chain.
 *                If the selected CI fails, nodes here are impacted.
 *
 * Cycle safety: a global visited set per direction — each node appears once
 * at its minimum hop count (BFS discovery order). Max depth 4 hops.
 */

export const CMDB_IMPACT_MAX_DEPTH = 4;

/** Minimal item summary the BFS result carries for rendering. */
export interface CmdbImpactItem {
  id: string;
  ciId: string;
  name: string;
  ciType: string;
  status: string;
  criticality: string;
}

/** One edge of the materialized graph (ids only — summaries live on nodes). */
export interface CmdbImpactEdge {
  sourceId: string;
  targetId: string;
  relationType: string;
}

/** One impacted CI with its hop distance and the concrete relation path. */
export interface CmdbImpactedNode extends CmdbImpactItem {
  /** 1-based hop distance from the analyzed CI (min hops — BFS). */
  hop: number;
  /** ciIds from the analyzed CI to this node, inclusive on both ends. */
  path: string[];
  /** Relation types traversed along `path` (length = path.length - 1). */
  via: string[];
}

export type CmdbImpactDirection = "upstream" | "downstream";

/**
 * Deterministic breadth-first walk. `items` must contain every endpoint of
 * `edges`; nodes are discovered in ciId order so identical inputs always
 * yield identical paths and ordering (hop asc, then ciId asc).
 */
export function cmdbBfsImpact(
  startId: string,
  items: CmdbImpactItem[],
  edges: CmdbImpactEdge[],
  direction: CmdbImpactDirection,
  maxDepth: number = CMDB_IMPACT_MAX_DEPTH
): CmdbImpactedNode[] {
  const itemById = new Map(items.map((item) => [item.id, item]));

  // Adjacency: current node → candidate neighbors (edge + direction).
  // Each neighbor entry keeps the edge so the path can record `via`.
  interface Adjacent {
    neighborId: string;
    relationType: string;
  }
  const adjacency = new Map<string, Adjacent[]>();
  for (const edge of edges) {
    const from = direction === "upstream" ? edge.sourceId : edge.targetId;
    const to = direction === "upstream" ? edge.targetId : edge.sourceId;
    const bucket = adjacency.get(from);
    const entry = { neighborId: to, relationType: edge.relationType };
    if (bucket) bucket.push(entry);
    else adjacency.set(from, [entry]);
  }

  // Deterministic neighbor order: by counterpart ciId, then relationType.
  const ciIdOf = (id: string): string => itemById.get(id)?.ciId ?? id;
  for (const bucket of adjacency.values()) {
    bucket.sort(
      (a, b) =>
        ciIdOf(a.neighborId).localeCompare(ciIdOf(b.neighborId)) ||
        a.relationType.localeCompare(b.relationType)
    );
  }

  const visited = new Set<string>([startId]);
  const impacted: CmdbImpactedNode[] = [];

  type FrontierNode = {
    id: string;
    hop: number;
    path: string[]; // ciIds
    via: string[]; // relationTypes
  };

  let frontier: FrontierNode[] = [
    { id: startId, hop: 0, path: [ciIdOf(startId)], via: [] },
  ];

  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (frontier.length === 0) break;
    const next: FrontierNode[] = [];

    // Frontier is already in discovery (ciId) order by construction.
    for (const node of frontier) {
      const neighbors = adjacency.get(node.id) ?? [];
      for (const { neighborId, relationType } of neighbors) {
        if (visited.has(neighborId)) continue; // cycle-safe + min-hop guarantee
        visited.add(neighborId);
        const item = itemById.get(neighborId);
        if (!item) continue; // dangling edge — defensive, cannot happen via FK
        impacted.push({
          id: item.id,
          ciId: item.ciId,
          name: item.name,
          ciType: item.ciType,
          status: item.status,
          criticality: item.criticality,
          hop: node.hop + 1,
          path: [...node.path, item.ciId],
          via: [...node.via, relationType],
        });
        next.push({
          id: neighborId,
          hop: node.hop + 1,
          path: [...node.path, item.ciId],
          via: [...node.via, relationType],
        });
      }
    }

    // Keep the next frontier deterministic (discovered this level, ciId asc).
    next.sort(
      (a, b) =>
        a.path[a.path.length - 1].localeCompare(b.path[b.path.length - 1])
    );
    frontier = next;
  }

  return impacted;
}
