"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useToast } from "@/hooks/use-toast";
import {
  backfillAuditChainApi,
  buildQueryString,
  createApiClient,
  createNotificationChannel,
  createWebhook,
  deleteNotificationChannel,
  deleteWebhook,
  applyRebalancePlan,
  fetchAdminSettings,
  fetchApiClients,
  fetchCollectorDistribution,
  fetchCollectors,
  fetchDrivers,
  fetchNotificationChannels,
  fetchWebhooks,
  previewRebalancePlan,
  rotateApiClient,
  testNotificationChannel,
  testWebhook,
  updateApiClient,
  updateAdminSettings,
  updateNotificationChannel,
  updateWebhook,
  verifyAuditChain,
  type ApiClientCreatePayload,
  type ApiClientCreateResult,
  type ApiClientRotateResult,
  type ChannelCreatePayload,
  type ChannelTestResult,
  type CollectorDistributionResult,
  type CollectorsResult,
  type DriversResult,
  type RebalanceApplyResult,
  type RebalancePreviewResult,
  type SettingsResult,
  type SettingsUpdateResult,
  type WebhookCreatePayload,
  type WebhookCreateResult,
  type WebhookTestResult,
} from "@/lib/api-client";
import { queryKeys, type ListParams } from "@/lib/query-keys";

/**
 * Administration: governance & integrations (Task 7-b).
 *
 * Every admin mutation invalidates the whole ["admin"] tree (shared with
 * users/roles from Task 7-a) plus the "events" stream — each admin action
 * is audited with a correlation id and should appear live in Event Stream.
 */

/* ───────────────────────── API clients ───────────────────────── */

export function useApiClients(params: ListParams = {}) {
  return useQuery({
    queryKey: queryKeys.apiClients(params),
    queryFn: () => fetchApiClients(),
  });
}

export function useCreateApiClient() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (payload: ApiClientCreatePayload): Promise<ApiClientCreateResult> =>
      createApiClient(payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: queryKeys.events() });
      toast({ title: "API client created", description: "Copy the token now — it is shown only once." });
    },
    onError: (e: Error) =>
      toast({ title: "Create failed", description: e.message, variant: "destructive" }),
  });
}

export function useUpdateApiClient() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({
      id,
      ...payload
    }: { id: string } & Parameters<typeof updateApiClient>[1]) =>
      updateApiClient(id, payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: queryKeys.events() });
      toast({ title: "API client updated" });
    },
    onError: (e: Error) =>
      toast({ title: "Update failed", description: e.message, variant: "destructive" }),
  });
}

export function useRotateApiClient() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (id: string): Promise<ApiClientRotateResult> => rotateApiClient(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: queryKeys.events() });
      toast({ title: "Token rotated", description: "The new token is shown once." });
    },
    onError: (e: Error) =>
      toast({ title: "Rotate failed", description: e.message, variant: "destructive" }),
  });
}

/* ───────────────────────── Webhooks ───────────────────────── */

export function useWebhooks(params: ListParams = {}) {
  return useQuery({
    queryKey: queryKeys.webhooks(params),
    queryFn: () => fetchWebhooks(),
  });
}

export function useCreateWebhook() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (payload: WebhookCreatePayload): Promise<WebhookCreateResult> =>
      createWebhook(payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: queryKeys.events() });
      toast({ title: "Webhook created", description: "Store the signing secret — it is shown only once." });
    },
    onError: (e: Error) =>
      toast({ title: "Create failed", description: e.message, variant: "destructive" }),
  });
}

export function useUpdateWebhook() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({
      id,
      ...payload
    }: { id: string } & Parameters<typeof updateWebhook>[1]) => updateWebhook(id, payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: queryKeys.events() });
      toast({ title: "Webhook updated" });
    },
    onError: (e: Error) =>
      toast({ title: "Update failed", description: e.message, variant: "destructive" }),
  });
}

export function useDeleteWebhook() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (id: string) => deleteWebhook(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: queryKeys.events() });
      toast({ title: "Webhook deleted" });
    },
    onError: (e: Error) =>
      toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });
}

export function useTestWebhook() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (id: string): Promise<WebhookTestResult> => testWebhook(id),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: queryKeys.events() });
      toast({
        title: result.delivered ? "Test delivery succeeded" : "Test delivery failed (recorded)",
        description: result.delivered
          ? `HTTP ${result.statusCode} in ${result.durationMs} ms`
          : (result.error ?? "Unknown error"),
        variant: result.delivered ? "default" : "destructive",
      });
    },
    onError: (e: Error) =>
      toast({ title: "Test failed", description: e.message, variant: "destructive" }),
  });
}

/* ─────────────────── Notification channels ─────────────────── */

export function useNotificationChannels(params: ListParams = {}) {
  return useQuery({
    queryKey: queryKeys.notificationChannels(params),
    queryFn: () => fetchNotificationChannels(),
  });
}

export function useCreateNotificationChannel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (
      payload: ChannelCreatePayload
    ): Promise<{ channel: { id: string }; audit: { correlationId: string } }> =>
      createNotificationChannel(payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: queryKeys.events() });
      toast({ title: "Channel created" });
    },
    onError: (e: Error) =>
      toast({ title: "Create failed", description: e.message, variant: "destructive" }),
  });
}

export function useUpdateNotificationChannel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({
      id,
      ...payload
    }: { id: string } & Parameters<typeof updateNotificationChannel>[1]) =>
      updateNotificationChannel(id, payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: queryKeys.events() });
      toast({ title: "Channel updated" });
    },
    onError: (e: Error) =>
      toast({ title: "Update failed", description: e.message, variant: "destructive" }),
  });
}

export function useDeleteNotificationChannel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (id: string) => deleteNotificationChannel(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: queryKeys.events() });
      toast({ title: "Channel deleted" });
    },
    onError: (e: Error) =>
      toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });
}

export function useTestNotificationChannel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (id: string): Promise<ChannelTestResult> => testNotificationChannel(id),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: queryKeys.events() });
      toast({ title: "Test sent", description: result.result });
    },
    onError: (e: Error) =>
      toast({ title: "Test failed", description: e.message, variant: "destructive" }),
  });
}

/* ───────────────────── Collectors / drivers ───────────────────── */

export function useCollectors(params: ListParams = {}) {
  return useQuery({
    queryKey: queryKeys.collectors(),
    queryFn: (): Promise<CollectorsResult> => fetchCollectors(),
    refetchInterval: 10_000,
  });
}

export function useDrivers() {
  return useQuery({
    queryKey: queryKeys.drivers(),
    queryFn: (): Promise<DriversResult> => fetchDrivers(),
  });
}

/* ─────────────────────── System settings ─────────────────────── */

export function useAdminSettings() {
  return useQuery({
    queryKey: queryKeys.adminSettings(),
    queryFn: () => fetchAdminSettings(),
  });
}

export function useUpdateAdminSettings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (
      payload: Parameters<typeof updateAdminSettings>[0]
    ): Promise<SettingsUpdateResult> => updateAdminSettings(payload),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: queryKeys.events() });
      void qc.invalidateQueries({ queryKey: queryKeys.meta });
      toast({
        title: "Settings saved",
        description: `Updated: ${result.updated.join(", ")}`,
      });
    },
    onError: (e: Error) =>
      toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });
}

/* ─────────────────────── Audit hash chain ─────────────────────── */

export function useAuditChain() {
  return useQuery({
    queryKey: queryKeys.auditChain(),
    queryFn: verifyAuditChain,
    staleTime: 5_000,
  });
}

export function useBackfillAuditChain() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: backfillAuditChainApi,
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: queryKeys.events() });
      toast({
        title: "Chain backfilled",
        description: `${result.filled} events hashed, ${result.remaining} remaining`,
      });
    },
    onError: (e: Error) =>
      toast({ title: "Backfill failed", description: e.message, variant: "destructive" }),
  });
}

/* ───────────────── Collector agent distribution (Phase 15-b) ───────────────── */

export function useCollectorDistribution() {
  return useQuery({
    queryKey: queryKeys.collectorDistribution(),
    queryFn: (): Promise<CollectorDistributionResult> =>
      fetchCollectorDistribution(),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/** Step 1 of the guarded flow — plan preview (no audits written). */
export function usePreviewRebalancePlan() {
  return useMutation({
    mutationFn: (): Promise<RebalancePreviewResult> => previewRebalancePlan(),
  });
}

/** Step 2 — apply a fresh planId (staged COLLECTOR_REBALANCE audits). */
export function useApplyRebalancePlan() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (planId: string): Promise<RebalanceApplyResult> =>
      applyRebalancePlan(planId),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: queryKeys.events() });
      toast({
        title: "Rebalance applied",
        description: `${result.moved} move(s) staged · ${result.correlationId}`,
      });
    },
    onError: (e: Error) =>
      toast({
        title: "Rebalance failed",
        description: e.message,
        variant: "destructive",
      }),
  });
}
