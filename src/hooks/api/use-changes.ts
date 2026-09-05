"use client";

import { useQuery } from "@tanstack/react-query";

import {
  apiRequest,
  buildQueryString,
  type ChangeListMeta,
  type ChangeRow,
  type PagedResult,
} from "@/lib/api-client";
import { queryKeys, type ListParams } from "@/lib/query-keys";

export interface ChangeListParams extends ListParams {
  status?: string;
  type?: string;
  /** csv multi, e.g. "HIGH,CRITICAL" (Task 4-a). */
  riskLevel?: string;
  /** Number/title contains (Task 4-a). */
  q?: string;
  /** User id; "me" resolves server-side to the seeded admin (demo identity). */
  requesterId?: string;
  /** ISO — calendar overlap fetch lower bound (Task 4-a). */
  scheduledFrom?: string;
  /** ISO — calendar overlap fetch upper bound (Task 4-a). */
  scheduledTo?: string;
  page?: number;
  pageSize?: number;
}

export function useChanges(params: ChangeListParams = {}) {
  return useQuery({
    queryKey: queryKeys.changes(params),
    queryFn: async (): Promise<PagedResult<ChangeRow> & { meta: ChangeListMeta }> => {
      const envelope = await apiRequest<ChangeRow[]>(
        `/api/v1/changes${buildQueryString(params)}`
      );
      const meta = envelope.meta as unknown as ChangeListMeta;
      return { data: envelope.data, meta };
    },
  });
}
