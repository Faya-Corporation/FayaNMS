"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  apiFetch,
  apiRequest,
  buildQueryString,
  type BulkDeviceActionResult,
  type CreateDevicePayload,
  type CreateDeviceResult,
  type CsvImportPayload,
  type DeviceRow,
  type ImportResult,
  type PagedResult,
  type TestConnectionResult,
  type UpdateDevicePayload,
} from "@/lib/api-client";
import { queryKeys, type ListParams } from "@/lib/query-keys";
import { useToast } from "@/hooks/use-toast";

export type DeviceSortField =
  | "hostname"
  | "name"
  | "status"
  | "criticality"
  | "backupCompliance"
  | "lastBackupAt"
  | "lastSeen";

export interface DeviceListParams extends ListParams {
  /** Search across hostname / displayName / mgmtIp. */
  q?: string;
  /** Legacy alias for q (kept for older callers). */
  search?: string;
  /** csv multi, e.g. "ONLINE,DEGRADED" */
  status?: string;
  vendorId?: string;
  siteId?: string;
  /** csv multi */
  criticality?: string;
  /** csv multi */
  backupCompliance?: string;
  sort?: DeviceSortField;
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

/* ------------------------------------------------------------------ */
/* Mutations                                                            */
/* ------------------------------------------------------------------ */

function invalidateDeviceCaches(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ["devices"] });
  void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
}

/** Create a device (Add Device flow). Returns the created device. */
export function useCreateDevice() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: (payload: CreateDevicePayload) =>
      apiFetch<CreateDeviceResult>("/api/v1/devices", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (result) => {
      invalidateDeviceCaches(queryClient);
      toast({
        title: "Device created",
        description: `${result.device.hostname} was added to the inventory with status Unknown.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not create device",
        description: error.message,
        variant: "destructive",
      });
    },
  });
}

/** PATCH editable device fields (display name, site, criticality, tags, status…). */
export function useUpdateDevice() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateDevicePayload }) =>
      apiFetch<DeviceDetailResponse>(`/api/v1/devices/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    onSuccess: (device, variables) => {
      invalidateDeviceCaches(queryClient);
      if (variables.data.status) {
        toast({
          title: `Device marked ${variables.data.status.toLowerCase()}`,
          description: `${device.hostname} — status updated.`,
        });
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Could not update device",
        description: error.message,
        variant: "destructive",
      });
    },
  });
}

interface DeviceDetailResponse {
  id: string;
  hostname: string;
  status: string;
  [key: string]: unknown;
}

/**
 * Bulk action on devices. action: "backup_now" enqueues one CONFIG_BACKUP
 * job per eligible device.
 */
export function useBulkDeviceAction() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: (payload: { action: "backup_now"; deviceIds: string[] }) =>
      apiFetch<BulkDeviceActionResult>("/api/v1/devices/bulk", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      const skippedNote =
        result.skipped.length > 0
          ? ` ${result.skipped.length} skipped (unmanaged or missing).`
          : "";
      toast({
        title: `Queued ${result.queued} backup job${result.queued === 1 ? "" : "s"}`,
        description: `Track progress in the Job Center.${skippedNote}`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Bulk backup failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });
}

/**
 * Bulk import devices from client-parsed CSV rows (2-c). Per-row validation
 * issues come back in `skipped`; valid rows are created with status Unknown
 * and audited. Invalidates devices + dashboard.
 */
export function useCsvImportDevices() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: (payload: CsvImportPayload) =>
      apiFetch<ImportResult>("/api/v1/devices/csv-import", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (result) => {
      invalidateDeviceCaches(queryClient);
      const skippedNote =
        result.skipped.length > 0
          ? ` ${result.skipped.length} row${result.skipped.length === 1 ? "" : "s"} skipped.`
          : "";
      toast({
        title: `Imported ${result.created} device${result.created === 1 ? "" : "s"}`,
        description: `CSV import finished.${skippedNote}`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "CSV import failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });
}

/**
 * Probe a device through the simulation worker (mini-service, roadmap 2-b).
 * Resolves with reachable:false + "Worker service unreachable" when the
 * worker is not running — surfaced as a warning toast here; callers may
 * also read the result for inline banners.
 */
export function useTestConnection() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: (deviceId: string) =>
      apiFetch<TestConnectionResult>("/api/v1/devices/test-connection", {
        method: "POST",
        body: JSON.stringify({ deviceId }),
      }),
    onSuccess: (result) => {
      invalidateDeviceCaches(queryClient);
      if (!result.reachable) {
        toast({
          title: "Worker service unreachable",
          description:
            "The simulation worker is not responding — connection could not be tested.",
          variant: "destructive",
        });
        return;
      }
      if (result.ok) {
        toast({
          title: `Connection OK${result.latencyMs !== null ? ` — ${result.latencyMs} ms` : ""}`,
          description: `${result.device.hostname} responded${result.workerStatus ? ` (status ${result.workerStatus})` : ""}.`,
        });
      } else {
        toast({
          title: "Connection failed",
          description: result.message ?? "The device did not respond.",
          variant: "destructive",
        });
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Test connection failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });
}
