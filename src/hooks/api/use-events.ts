"use client";

import { useQuery } from "@tanstack/react-query";

import {
  apiRequest,
  buildQueryString,
  type AuditEventRow,
  type EventListMeta,
  type PagedResult,
} from "@/lib/api-client";
import { queryKeys, type ListParams } from "@/lib/query-keys";

/**
 * Audit-event stream (Task 5-c). Live-polled (5–10 s recommended) so the
 * timeline keeps moving while the platform works (worker jobs, alert
 * engine, user actions).
 */
export interface EventListParams extends ListParams {
  /** Exact actorId OR actorName ("system:alert-engine", "usr-noc1"). */
  actor?: string;
  /** Action family PREFIX, e.g. "INCIDENT_". */
  action?: string;
  /** resourceType exact, e.g. "Device". */
  entityType?: string;
  correlationId?: string;
  /** Device-scoped events (resourceId === deviceId). */
  deviceId?: string;
  /** ISO lower bound on createdAt. */
  from?: string;
  /** ISO upper bound on createdAt. */
  to?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

export function useEvents(
  params: EventListParams = {},
  options: { refetchInterval?: number } = {}
) {
  return useQuery({
    queryKey: queryKeys.events(params),
    queryFn: async (): Promise<PagedResult<AuditEventRow, EventListMeta>> => {
      const envelope = await apiRequest<AuditEventRow[]>(
        `/api/v1/events${buildQueryString(params)}`
      );
      const meta = envelope.meta as unknown as EventListMeta;
      return { data: envelope.data, meta };
    },
    refetchInterval: options.refetchInterval,
  });
}
