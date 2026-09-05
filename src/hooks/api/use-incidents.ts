"use client";

import { useQuery } from "@tanstack/react-query";

import {
  apiRequest,
  buildQueryString,
  type IncidentRow,
  type PagedResult,
} from "@/lib/api-client";
import { queryKeys, type ListParams } from "@/lib/query-keys";

export interface IncidentListParams extends ListParams {
  status?: string;
  severity?: string;
  page?: number;
  pageSize?: number;
}

export function useIncidents(params: IncidentListParams = {}) {
  return useQuery({
    queryKey: queryKeys.incidents(params),
    queryFn: async (): Promise<PagedResult<IncidentRow>> => {
      const envelope = await apiRequest<IncidentRow[]>(
        `/api/v1/incidents${buildQueryString(params)}`
      );
      const meta = envelope.meta as unknown as PagedResult<IncidentRow>["meta"];
      return { data: envelope.data, meta };
    },
  });
}
