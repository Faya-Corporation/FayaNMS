"use client";

import { useQuery } from "@tanstack/react-query";

import {
  apiRequest,
  buildQueryString,
  type IncidentListMeta,
  type IncidentRow,
  type IncidentStatsPayload,
  type PagedResult,
} from "@/lib/api-client";
import { queryKeys, type ListParams } from "@/lib/query-keys";

/**
 * Incident list + stats hooks (Task 5-b). The list calls the extended
 * GET /api/v1/incidents (facet counts + SLA/open totals in meta); stats
 * powers the KPI row. Detail lives in use-incident-detail.ts.
 */
export interface IncidentListParams extends ListParams {
  status?: string;
  severity?: string;
  siteCode?: string;
  deviceId?: string;
  q?: string;
  source?: string;
  ownerId?: string;
  breached?: string;
  sort?: "createdAt" | "severity" | "slaDueAt";
  page?: number;
  pageSize?: number;
}

export function useIncidents(params: IncidentListParams = {}) {
  return useQuery({
    queryKey: queryKeys.incidents(params),
    queryFn: async (): Promise<PagedResult<IncidentRow, IncidentListMeta>> => {
      const envelope = await apiRequest<IncidentRow[]>(
        `/api/v1/incidents${buildQueryString(params)}`
      );
      const meta = envelope.meta as unknown as IncidentListMeta;
      return { data: envelope.data, meta };
    },
  });
}

export function useIncidentStats(options: { refetchInterval?: number } = {}) {
  return useQuery({
    queryKey: queryKeys.incidentStats(),
    queryFn: () => apiFetchStats(),
    refetchInterval: options.refetchInterval ?? 15_000,
  });
}

async function apiFetchStats(): Promise<IncidentStatsPayload> {
  const envelope = await apiRequest<IncidentStatsPayload>("/api/v1/incidents/stats");
  return envelope.data;
}
