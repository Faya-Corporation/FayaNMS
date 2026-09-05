"use client";

import { useQuery } from "@tanstack/react-query";

import { apiFetch, type ChangeDetail } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";

/** Change statuses the execution engine is actively driving → live polling. */
export const CHANGE_EXECUTION_STATUSES = [
  "PRE_CHECK",
  "EXECUTING",
  "VALIDATING",
  "ROLLBACK",
];

/** Full change detail — header, plans, devices, steps, approvals, links. */
export function useChangeDetail(
  changeId: string | null | undefined,
  options: { refetchInterval?: number } = {}
) {
  return useQuery({
    queryKey: queryKeys.changeDetail(changeId ?? ""),
    queryFn: () => apiFetch<ChangeDetail>(`/api/v1/changes/${changeId}`),
    enabled: Boolean(changeId),
    // Live timeline (Task 4-b): while the engine drives the change, poll
    // every 2 s; the override function stops polling in any other status.
    refetchInterval:
      options.refetchInterval ??
      ((query) => {
        const status = query.state.data?.status;
        return status && CHANGE_EXECUTION_STATUSES.includes(status) ? 2_000 : false;
      }),
  });
}
