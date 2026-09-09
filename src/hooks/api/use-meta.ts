"use client";

import { useQuery } from "@tanstack/react-query";

import { apiFetch, type MetaPayload } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";

/** Reference data (vendors + sites) for filter bars and pickers. */
export function useMeta() {
  return useQuery({
    queryKey: queryKeys.meta,
    queryFn: () => apiFetch<MetaPayload>("/api/v1/meta"),
    staleTime: 5 * 60_000,
  });
}
