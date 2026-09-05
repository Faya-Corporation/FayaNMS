"use client";

import { useQuery } from "@tanstack/react-query";

import {
  apiFetch,
  apiRequest,
  buildQueryString,
  type ApprovalQueueMeta,
  type ApprovalQueueRow,
  type MetaPayload,
} from "@/lib/api-client";
import { queryKeys, type ListParams } from "@/lib/query-keys";

export interface ApprovalQueueParams extends ListParams {
  /** csv multi over ChangeApproval.status (default PENDING server-side). */
  status?: string;
  /** Demo acting user (id or username key) — feeds the "mine" meta count. */
  actAsUserId?: string;
  /** Change number/title contains. */
  q?: string;
}

export interface ApprovalQueueResult {
  rows: ApprovalQueueRow[];
  meta: ApprovalQueueMeta;
}

/**
 * Approval queue across changes (Task 4-b). meta carries the KPI counts
 * { pending, mine, approvedToday, rejectedToday }.
 */
export function useApprovals(
  params: ApprovalQueueParams = {},
  options: { refetchInterval?: number } = {}
) {
  return useQuery({
    queryKey: queryKeys.approvals(params),
    queryFn: async (): Promise<ApprovalQueueResult> => {
      const envelope = await apiRequest<ApprovalQueueRow[]>(
        `/api/v1/approvals${buildQueryString(params)}`
      );
      const meta = envelope.meta as unknown as ApprovalQueueMeta;
      return { rows: envelope.data, meta };
    },
    refetchInterval: options.refetchInterval,
  });
}

/**
 * Seeded user directory + the resolved acting user for the preferences'
 * username-style key (approvals view header Select + detail panel chip).
 */
export function useActingUser(usernameKey: string | undefined) {
  const meta = useQuery({
    queryKey: queryKeys.meta,
    queryFn: () => apiFetch<MetaPayload>("/api/v1/meta"),
    staleTime: 5 * 60_000,
  });
  const users = meta.data?.users ?? [];
  return {
    users,
    actingUser:
      users.find((user) => user.username === usernameKey) ??
      users.find((user) => user.id === usernameKey) ??
      null,
    isLoading: meta.isLoading,
  };
}
