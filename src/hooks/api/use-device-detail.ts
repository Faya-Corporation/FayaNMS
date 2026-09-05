"use client";

import { useQuery } from "@tanstack/react-query";

import {
  apiFetch,
  apiRequest,
  buildQueryString,
  type DeviceAlertRow,
  type DeviceAuditRow,
  type DeviceChangeRow,
  type DeviceDetail,
  type DeviceIncidentRow,
  type DeviceInterfaceRow,
  type DeviceMetricsPayload,
  type DeviceSnapshotRow,
  type PagedResult,
} from "@/lib/api-client";
import { queryKeys, type ListParams } from "@/lib/query-keys";

/**
 * Per-device query hooks — one per device-detail tab. Tabs mount lazily
 * (Radix TabsContent unmounts inactive panels), and each hook further
 * guards with `enabled: Boolean(deviceId)` so the detail view can render
 * before the navigation params settle.
 */

export function useDevice(deviceId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.deviceDetail(deviceId ?? "unknown"),
    queryFn: () => apiFetch<DeviceDetail>(`/api/v1/devices/${deviceId}`),
    enabled: Boolean(deviceId),
  });
}

export type DeviceMetricWindow = "6h" | "24h" | "7d";

export function useDeviceMetrics(
  deviceId: string | null | undefined,
  window: DeviceMetricWindow = "24h"
) {
  return useQuery({
    queryKey: queryKeys.deviceMetrics(deviceId ?? "unknown", window),
    queryFn: async () => {
      // The metrics endpoint answers data: { series: [...] } (plus meta
      // describing window/source) — unwrap the series array here so
      // consumers always see DeviceMetricPoint[].
      const envelope = await apiRequest<DeviceMetricsPayload>(
        `/api/v1/devices/${deviceId}/metrics?window=${window}`
      );
      return { series: envelope.data?.series ?? [], meta: envelope.meta };
    },
    enabled: Boolean(deviceId),
    staleTime: 60_000,
  });
}

export function useDeviceSnapshots(deviceId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.deviceSnapshots(deviceId ?? "unknown"),
    queryFn: async (): Promise<PagedResult<DeviceSnapshotRow>> => {
      const envelope = await apiRequest<DeviceSnapshotRow[]>(
        `/api/v1/devices/${deviceId}/snapshots?pageSize=50`
      );
      const meta = envelope.meta as unknown as PagedResult<DeviceSnapshotRow>["meta"];
      return { data: envelope.data, meta };
    },
    enabled: Boolean(deviceId),
  });
}

export function useDeviceInterfaces(
  deviceId: string | null | undefined,
  params: ListParams = {}
) {
  return useQuery({
    queryKey: queryKeys.deviceInterfaces(deviceId ?? "unknown", params),
    queryFn: async (): Promise<PagedResult<DeviceInterfaceRow>> => {
      const envelope = await apiRequest<DeviceInterfaceRow[]>(
        `/api/v1/devices/${deviceId}/interfaces${buildQueryString({ pageSize: 100, ...params })}`
      );
      const meta = envelope.meta as unknown as PagedResult<DeviceInterfaceRow>["meta"];
      return { data: envelope.data, meta };
    },
    enabled: Boolean(deviceId),
  });
}

export function useDeviceAlerts(
  deviceId: string | null | undefined,
  params: ListParams = {}
) {
  return useQuery({
    queryKey: queryKeys.deviceAlerts(deviceId ?? "unknown", params),
    queryFn: async (): Promise<PagedResult<DeviceAlertRow>> => {
      const envelope = await apiRequest<DeviceAlertRow[]>(
        `/api/v1/devices/${deviceId}/alerts${buildQueryString({ pageSize: 50, ...params })}`
      );
      const meta = envelope.meta as unknown as PagedResult<DeviceAlertRow>["meta"];
      return { data: envelope.data, meta };
    },
    enabled: Boolean(deviceId),
  });
}

export function useDeviceIncidents(deviceId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.deviceIncidents(deviceId ?? "unknown"),
    queryFn: async (): Promise<PagedResult<DeviceIncidentRow>> => {
      const envelope = await apiRequest<DeviceIncidentRow[]>(
        `/api/v1/devices/${deviceId}/incidents?pageSize=50`
      );
      const meta = envelope.meta as unknown as PagedResult<DeviceIncidentRow>["meta"];
      return { data: envelope.data, meta };
    },
    enabled: Boolean(deviceId),
  });
}

export function useDeviceChanges(deviceId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.deviceChanges(deviceId ?? "unknown"),
    queryFn: async (): Promise<PagedResult<DeviceChangeRow>> => {
      const envelope = await apiRequest<DeviceChangeRow[]>(
        `/api/v1/devices/${deviceId}/changes?pageSize=50`
      );
      const meta = envelope.meta as unknown as PagedResult<DeviceChangeRow>["meta"];
      return { data: envelope.data, meta };
    },
    enabled: Boolean(deviceId),
  });
}

export function useDeviceAudit(
  deviceId: string | null | undefined,
  params: ListParams = {}
) {
  return useQuery({
    queryKey: queryKeys.deviceAudit(deviceId ?? "unknown", params),
    queryFn: async (): Promise<PagedResult<DeviceAuditRow>> => {
      const envelope = await apiRequest<DeviceAuditRow[]>(
        `/api/v1/devices/${deviceId}/audit${buildQueryString({ pageSize: 20, ...params })}`
      );
      const meta = envelope.meta as unknown as PagedResult<DeviceAuditRow>["meta"];
      return { data: envelope.data, meta };
    },
    enabled: Boolean(deviceId),
  });
}
