"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchZtp,
  requestCreateZtpClaim,
  type ZtpClaimCreated,
} from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";

/**
 * Zero-touch provisioning hooks (Phase 14-b) against /api/v1/ztp/claims.
 *
 * The GET is one bundled read (claims + templates + option lists + counts +
 * ZTP audit history), polled at 15 s so a running ZTP_PROVISION job's
 * progress stays visible without hammering the API. The create mutation
 * invalidates "ztp" (queue + counts), "jobs" (the ZTP_PROVISION row appears
 * in the Job Center immediately), "devices" (the provisioned device lands in
 * the inventory) and "events" (ZTP_* audit trail) together.
 */
export function useZtp() {
  return useQuery({
    queryKey: queryKeys.ztp(),
    queryFn: fetchZtp,
    staleTime: 15_000,
    refetchInterval: 15_000,
  });
}

export function useCreateZtpClaim() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      serial: string;
      hostname: string;
      vendorKey: string;
      model: string;
      templateId: string;
      siteId?: string;
      requestedBy?: string;
    }): Promise<ZtpClaimCreated> => requestCreateZtpClaim(vars),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ztp"] });
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      void queryClient.invalidateQueries({ queryKey: ["devices"] });
      void queryClient.invalidateQueries({ queryKey: ["events"] });
    },
  });
}
