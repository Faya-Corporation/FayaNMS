"use client";

import { useQuery } from "@tanstack/react-query";

import {
  apiRequest,
  buildQueryString,
  type ApprovalQueueMeta,
  type ApprovalQueueRow,
} from "@/lib/api-client";
import { queryKeys, type ListParams } from "@/lib/query-keys";

export interface ApprovalQueueParams extends ListParams {
  /** csv multi over ChangeApproval.status (default PENDING server-side). */
  status?: string;
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
