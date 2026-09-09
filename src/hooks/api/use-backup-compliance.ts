"use client";

import { useQuery } from "@tanstack/react-query";

import {
  apiFetch,
  type BackupCompliancePayload,
} from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";

/**
 * Fleet backup compliance (Compliance view): KPIs, per-site breakdown and
 * the worst-offender list, computed live from device lastBackupAt.
 */
export function useBackupCompliance() {
  return useQuery({
    queryKey: queryKeys.backupCompliance(),
    queryFn: () => apiFetch<BackupCompliancePayload>("/api/v1/compliance/backup"),
    staleTime: 60_000,
  });
}
