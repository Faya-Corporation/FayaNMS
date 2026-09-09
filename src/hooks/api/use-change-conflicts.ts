"use client";

import { useQuery } from "@tanstack/react-query";

import {
  buildQueryString,
  apiFetch,
  type ChangeConflict,
} from "@/lib/api-client";
import { queryKeys, type ListParams } from "@/lib/query-keys";

export interface ChangeConflictParams extends ListParams {
  /** ISO start of the queried window. */
  start?: string;
  /** ISO end of the queried window. */
  end?: string;
  /** Change id to exclude (edit mode — the change's own window). */
  excludeId?: string;
  /** Optional status csv filter (defaults to "anything not dead" server-side). */
  status?: string;
}

/**
 * Conflicting changes overlapping the [start, end] window. Enabled only
 * when BOTH bounds are present — the wizard debounces the inputs before
 * they reach this hook.
 */
export function useChangeConflicts(params: ChangeConflictParams = {}) {
  const enabled = Boolean(params.start && params.end);
  return useQuery({
    queryKey: queryKeys.changeConflicts(params),
    queryFn: () =>
      apiFetch<ChangeConflict[]>(
        `/api/v1/changes/conflicts${buildQueryString(params)}`
      ),
    enabled,
    staleTime: 15_000,
  });
}
