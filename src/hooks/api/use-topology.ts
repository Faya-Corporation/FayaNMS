"use client";

import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api-client";
import type { TopologyGraph } from "@/lib/topology/graph";

/**
 * API response for GET /api/v1/topology — the deterministic graph plus the
 * generation timestamp (two back-to-back GETs are byte-identical apart from
 * generatedAt).
 */
export type TopologyResponse = TopologyGraph & { generatedAt: string };

/**
 * Network topology map hook (Task 18-b) against /api/v1/topology.
 *
 * The topology is a light read (nodes + derived edges over the real
 * inventory), so a 30 s staleTime + 60 s poll keeps status dots fresh
 * without hammering the API (mirrors the HA topology cadence). Inline
 * array query key per the Task 18-b shard contract ("topo").
 */
export function useTopology() {
  return useQuery({
    queryKey: ["topo"],
    queryFn: () => apiFetch<TopologyResponse>("/api/v1/topology"),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
