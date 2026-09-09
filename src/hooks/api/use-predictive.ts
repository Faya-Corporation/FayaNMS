"use client";

import { useQuery } from "@tanstack/react-query";

import {
  fetchPredictiveHealth,
  type PredictiveParams,
} from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";

/**
 * Predictive health hooks (Phase 12-c) against /api/v1/predictive.
 *
 * The score is a deterministic derived metric (no randomness, bounded
 * queries), so a slow refresh cadence is enough: 30 s staleTime + a 30 s
 * poll keeps the ranking fresh without hammering the rollup reads. The
 * dashboard "Predictive risks" widget reuses the same hook, so both
 * surfaces share one cached payload per site scope.
 */
export function usePredictiveHealth(params: PredictiveParams = {}) {
  return useQuery({
    queryKey: queryKeys.predictive(params),
    queryFn: () => fetchPredictiveHealth(params),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}
