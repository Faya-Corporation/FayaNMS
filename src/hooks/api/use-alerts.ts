"use client";

import { useQuery } from "@tanstack/react-query";

import {
  apiRequest,
  buildQueryString,
  type AlertStreamMeta,
  type AlertStreamRow,
  type PagedResult,
} from "@/lib/api-client";
import { queryKeys, type ListParams } from "@/lib/query-keys";

export interface AlertListParams extends ListParams {
  status?: string;
  severity?: string;
  deviceId?: string;
  siteCode?: string;
  ruleId?: string;
  q?: string;
  /** List the children of a root alert (expandable stream groups). */
  parentAlertId?: string;
  /** true lists children inline; default false = roots only. */
  includeChildren?: boolean;
  sort?: "lastSeen" | "severity";
  page?: number;
  pageSize?: number;
}

/**
 * Alert stream (Task 5-a). Children are NOT listed by default — roots
 * carry childCount and the UI fetches them via parentAlertId on expand.
 */
export function useAlerts(
  params: AlertListParams = {},
  options: {
    /** Fixed ms, or a callback receiving the latest page (dynamic intervals). */
    refetchInterval?:
      | number
      | ((
          data: PagedResult<AlertStreamRow, AlertStreamMeta> | undefined
        ) => number);
  } = {}
) {
  return useQuery({
    queryKey: queryKeys.alerts(params),
    queryFn: async (): Promise<PagedResult<AlertStreamRow, AlertStreamMeta>> => {
      const query = buildQueryString({
        ...params,
        includeChildren:
          params.includeChildren === undefined
            ? undefined
            : params.includeChildren
              ? "true"
              : "false",
      });
      const envelope = await apiRequest<AlertStreamRow[]>(
        `/api/v1/alerts${query}`
      );
      const meta = envelope.meta as unknown as AlertStreamMeta;
      return { data: envelope.data, meta };
    },
    refetchInterval: options.refetchInterval
      ? (query) => {
          const data = query.state.data as
            | PagedResult<AlertStreamRow, AlertStreamMeta>
            | undefined;
          return typeof options.refetchInterval === "function"
            ? options.refetchInterval(data)
            : options.refetchInterval;
        }
      : undefined,
  });
}
