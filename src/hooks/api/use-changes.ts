"use client";

import { useQuery } from "@tanstack/react-query";

import {
  apiRequest,
  buildQueryString,
  type ChangeRow,
  type PagedResult,
} from "@/lib/api-client";
import { queryKeys, type ListParams } from "@/lib/query-keys";

export interface ChangeListParams extends ListParams {
  status?: string;
  type?: string;
  page?: number;
  pageSize?: number;
}

export function useChanges(params: ChangeListParams = {}) {
  return useQuery({
    queryKey: queryKeys.changes(params),
    queryFn: async (): Promise<PagedResult<ChangeRow>> => {
      const envelope = await apiRequest<ChangeRow[]>(
        `/api/v1/changes${buildQueryString(params)}`
      );
      const meta = envelope.meta as unknown as PagedResult<ChangeRow>["meta"];
      return { data: envelope.data, meta };
    },
  });
}
