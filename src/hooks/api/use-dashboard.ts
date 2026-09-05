"use client";

import { useQuery } from "@tanstack/react-query";

import {
  apiFetch,
  type DashboardPayload,
} from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";

/** Dashboard aggregate. range: "24h" | "7d" (other values clamp server-side). */
export function useDashboard(range: string = "24h") {
  return useQuery({
    queryKey: queryKeys.dashboard(range),
    queryFn: () => apiFetch<DashboardPayload>(`/api/v1/dashboard?range=${range}`),
  });
}
