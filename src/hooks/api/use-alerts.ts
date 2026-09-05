"use client";

import { useQuery } from "@tanstack/react-query";

import {
  apiRequest,
  buildQueryString,
  type AlertRow,
  type PagedResult,
} from "@/lib/api-client";
import { queryKeys, type ListParams } from "@/lib/query-keys";

export interface AlertListParams extends ListParams {
  status?: string;
  severity?: string;
  page?: number;
  pageSize?: number;
}

export function useAlerts(
  params: AlertListParams = {},
  options: { refetchInterval?: number } = {}
) {
  return useQuery({
    queryKey: queryKeys.alerts(params),
    queryFn: async (): Promise<PagedResult<AlertRow>> => {
      const envelope = await apiRequest<AlertRow[]>(
        `/api/v1/alerts${buildQueryString(params)}`
      );
      const meta = envelope.meta as unknown as PagedResult<AlertRow>["meta"];
      return { data: envelope.data, meta };
    },
    refetchInterval: options.refetchInterval,
  });
}
