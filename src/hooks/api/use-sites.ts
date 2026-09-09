"use client";

import { useQuery } from "@tanstack/react-query";

import { apiFetch, type SiteSummary } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";

/** Site summaries with status/compliance aggregates for the Sites view. */
export function useSites() {
  return useQuery({
    queryKey: queryKeys.sites(),
    queryFn: () => apiFetch<SiteSummary[]>("/api/v1/sites"),
    staleTime: 60_000,
  });
}
