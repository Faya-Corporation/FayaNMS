"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchFirmwareInventory,
  requestFirmwareUpgrade,
  type FirmwareUpgradeResult,
} from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";

/**
 * Firmware lifecycle hooks (Phase 13-b) against /api/v1/firmware.
 *
 * The inventory is a light read (30 devices + lifecycle classification), so
 * a 30 s staleTime + 30 s poll keeps the openUpgradeJob flags honest while
 * an upgrade job runs without hammering the API. The upgrade mutation
 * invalidates "firmware" (rows + counts + open-job flags), "jobs" (the
 * FIRMWARE_UPGRADE row appears in the Job Center immediately) and
 * "devices" (the device-detail firmware chip) together.
 */
export function useFirmwareInventory() {
  return useQuery({
    queryKey: queryKeys.firmware(),
    queryFn: fetchFirmwareInventory,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}

export function useFirmwareUpgrade() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { deviceId: string; targetVersion: string }): Promise<FirmwareUpgradeResult> =>
      requestFirmwareUpgrade(vars),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["firmware"] });
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      void queryClient.invalidateQueries({ queryKey: ["devices"] });
    },
  });
}
