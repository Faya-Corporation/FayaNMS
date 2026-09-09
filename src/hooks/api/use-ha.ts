"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchHaTopology,
  requestFailoverTest,
  type HaFailoverTestResult,
} from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";

/**
 * HA/DR hooks (Phase 14-c) against /api/v1/ha.
 *
 * The topology is a light read (5 pairs + 4 DR mappings), so a 30 s
 * staleTime + 60 s poll keeps member status dots and failover state lines
 * fresh without hammering the API. The failover-test mutation runs the
 * server-side staged simulation (~4.2s — the POST resolves after the final
 * "complete" audit row) and invalidates "ha" (pair state lines) and
 * "events" (the staged HA_FAILOVER_TEST audit rows appear in the Event
 * Stream immediately).
 */
export function useHaTopology() {
  return useQuery({
    queryKey: queryKeys.ha(),
    queryFn: fetchHaTopology,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useFailoverTest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { pairId: string }): Promise<HaFailoverTestResult> =>
      requestFailoverTest(vars),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ha"] });
      void queryClient.invalidateQueries({ queryKey: ["events"] });
    },
  });
}
