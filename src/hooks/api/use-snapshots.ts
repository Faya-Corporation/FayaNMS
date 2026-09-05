"use client";

import { useQuery } from "@tanstack/react-query";

import {
  apiRequest,
  buildQueryString,
  type FleetSnapshotParams,
  type FleetSnapshotRow,
  type PagedResult,
} from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";

/**
 * Fleet-wide snapshot history (Backups view, History tab). Server caps
 * pageSize at 25; the envelope meta drives pagination.
 */
export function useSnapshots(params: FleetSnapshotParams = {}) {
  return useQuery({
    queryKey: queryKeys.snapshots(params),
    queryFn: async (): Promise<PagedResult<FleetSnapshotRow>> => {
      const envelope = await apiRequest<FleetSnapshotRow[]>(
        `/api/v1/snapshots${buildQueryString(params)}`
      );
      const meta = envelope.meta as unknown as PagedResult<FleetSnapshotRow>["meta"];
      return { data: envelope.data, meta };
    },
  });
}
