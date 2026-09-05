"use client";

import { useQuery } from "@tanstack/react-query";

import {
  apiRequest,
  buildQueryString,
  type DeviceRow,
  type PagedResult,
} from "@/lib/api-client";
import { queryKeys, type ListParams } from "@/lib/query-keys";

export interface DeviceListParams extends ListParams {
  search?: string;
  status?: string; // csv multi, e.g. "ONLINE,DEGRADED"
  vendorId?: string;
  siteId?: string;
  criticality?: string;
  sort?: "hostname" | "status" | "criticality" | "lastBackupAt" | "lastSeen";
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export function useDevices(params: DeviceListParams = {}) {
  return useQuery({
    queryKey: queryKeys.devices(params),
    queryFn: async (): Promise<PagedResult<DeviceRow>> => {
      const envelope = await apiRequest<DeviceRow[]>(
        `/api/v1/devices${buildQueryString(params)}`
      );
      const meta = envelope.meta as unknown as PagedResult<DeviceRow>["meta"];
      return { data: envelope.data, meta };
    },
  });
}
