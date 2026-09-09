"use client";

import { useQuery } from "@tanstack/react-query";

import { fetchFlows, type FlowWindow } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";

/**
 * Flow analytics hook (Phase 13-c) against /api/v1/flows.
 *
 * The payload is deterministic per 15-minute bucket, so polling never
 * changes numbers mid-bucket (no flicker): a 30 s refetchInterval keeps
 * the "computed" stamp fresh while the aggregates stay byte-identical
 * until a new bucket completes. Disabled until a device is picked — the
 * view renders its own EmptyState instead of firing a request.
 */
export function useFlows(deviceId: string | null, window: FlowWindow) {
  return useQuery({
    queryKey: queryKeys.flows(deviceId ?? "none", window),
    queryFn: () => fetchFlows(deviceId as string, window),
    enabled: Boolean(deviceId),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}
