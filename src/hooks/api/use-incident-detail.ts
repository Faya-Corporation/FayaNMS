"use client";

import { useQuery } from "@tanstack/react-query";

import { apiFetch, type IncidentDetail } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";

/** Incident statuses where the incident is operationally open → 5s polling. */
export const INCIDENT_ACTIVE_STATUSES = [
  "NEW",
  "ACKNOWLEDGED",
  "ASSIGNED",
  "INVESTIGATING",
  "MITIGATING",
  "MONITORING",
  "POST_INCIDENT_REVIEW",
];

/**
 * Full incident detail (Task 5-b) — header + SLA state + devices + events
 * + alerts + linked change. Polls every 5 s while the incident is still
 * active (not RESOLVED/CLOSED) so the timeline and SLA countdown stay live.
 */
export function useIncidentDetail(
  incidentId: string | null | undefined,
  options: { refetchInterval?: number } = {}
) {
  return useQuery({
    queryKey: queryKeys.incidentDetail(incidentId ?? ""),
    queryFn: () => apiFetch<IncidentDetail>(`/api/v1/incidents/${incidentId}`),
    enabled: Boolean(incidentId),
    refetchInterval:
      options.refetchInterval ??
      ((query) => {
        const status = query.state.data?.status;
        return status && INCIDENT_ACTIVE_STATUSES.includes(status) ? 5_000 : false;
      }),
  });
}
