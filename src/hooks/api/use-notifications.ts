"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  apiFetch,
  apiRequest,
  type NotificationRow,
  type NotificationsPayload,
} from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { useToast } from "@/hooks/use-toast";

/**
 * Notifications center (Task 5-a; design §74 — a separate surface from the
 * operational alert stream). Lightweight feed: latest 30 rows, unread
 * badge count, mark-read (single/all).
 */

export function useNotifications(
  options: { refetchInterval?: number; limit?: number } = {}
) {
  return useQuery({
    queryKey: queryKeys.notifications({ limit: options.limit ?? 30 }),
    queryFn: async (): Promise<NotificationsPayload> => {
      const envelope = await apiRequest<NotificationRow[]>(
        `/api/v1/notifications?limit=${options.limit ?? 30}`
      );
      return {
        data: envelope.data.map((row) => ({ ...row, mine: row.userId !== null })),
        meta: envelope.meta as NotificationsPayload["meta"],
      };
    },
    refetchInterval: options.refetchInterval,
    staleTime: 5_000,
  });
}

export function useMarkNotificationsRead() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (input: { ids?: string[]; all?: boolean }) =>
      apiFetch<{ updated: number; unreadCount: number }>(
        "/api/v1/notifications/read",
        { method: "POST", body: JSON.stringify(input) }
      ),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["notifications"] });
      if (result.updated > 0) {
        toast({
          title:
            result.updated === 1
              ? "1 notification marked read"
              : `${result.updated} notifications marked read`,
        });
      }
    },
    onError: (error: Error) =>
      toast({
        title: "Could not update notifications",
        description: error.message,
        variant: "destructive",
      }),
  });
}
