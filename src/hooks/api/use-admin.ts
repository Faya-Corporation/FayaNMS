"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

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
  const t = useTranslations("toast.admin");
  return useMutation({
    mutationFn: (payload: ApiClientCreatePayload): Promise<ApiClientCreateResult> =>
      createApiClient(payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: queryKeys.events() });
      toast({
        title: t("apiClients.createdTitle"),
        description: t("apiClients.createdDescription"),
      });
    },
    onError: (e: Error) =>
      toast({ title: t("failures.create"), description: e.message, variant: "destructive" }),
  });
}

export function useUpdateApiClient() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.admin");
  return useMutation({
    mutationFn: ({
      id,
      ...payload
    }: { id: string } & Parameters<typeof updateApiClient>[1]) =>
      updateApiClient(id, payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: queryKeys.events() });
      toast({ title: t("apiClients.updatedTitle") });
    },
    onError: (e: Error) =>
      toast({ title: t("failures.update"), description: e.message, variant: "destructive" }),
  });
}

export function useRotateApiClient() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.admin");
  return useMutation({
    mutationFn: (id: string): Promise<ApiClientRotateResult> => rotateApiClient(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: queryKeys.events() });
      toast({
        title: t("apiClients.rotateTitle"),
        description: t("apiClients.rotateDescription"),
      });
    },
    onError: (e: Error) =>
      toast({ title: t("failures.rotate"), description: e.message, variant: "destructive" }),
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
  const t = useTranslations("toast.admin");
  return useMutation({
    mutationFn: (payload: WebhookCreatePayload): Promise<WebhookCreateResult> =>
      createWebhook(payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: queryKeys.events() });
      toast({
        title: t("webhooks.createdTitle"),
        description: t("webhooks.createdDescription"),
      });
    },
    onError: (e: Error) =>
      toast({ title: t("failures.create"), description: e.message, variant: "destructive" }),
  });
}

export function useUpdateWebhook() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.admin");
  return useMutation({
    mutationFn: ({
      id,
      ...payload
    }: { id: string } & Parameters<typeof updateWebhook>[1]) => updateWebhook(id, payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: queryKeys.events() });
      toast({ title: t("webhooks.updatedTitle") });
    },
    onError: (e: Error) =>
      toast({ title: t("failures.update"), description: e.message, variant: "destructive" }),
  });
}

export function useDeleteWebhook() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.admin");
  return useMutation({
    mutationFn: (id: string) => deleteWebhook(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: queryKeys.events() });
      toast({ title: t("webhooks.deletedTitle") });
    },
    onError: (e: Error) =>
      toast({ title: t("failures.delete"), description: e.message, variant: "destructive" }),
  });
}

export function useTestWebhook() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.admin");
  return useMutation({
    mutationFn: (id: string): Promise<WebhookTestResult> => testWebhook(id),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: queryKeys.events() });
      toast({
        title: result.delivered ? t("webhooks.testOkTitle") : t("webhooks.testFailedTitle"),
        description: result.delivered
          ? t("webhooks.testOkDescription", {
              // String(): template-interpolation parity even for null.
              status: String(result.statusCode),
              duration: String(result.durationMs),
            })
          : (result.error ?? t("webhooks.unknownError")),
        variant: result.delivered ? "default" : "destructive",
      });
    },
    onError: (e: Error) =>
      toast({ title: t("failures.test"), description: e.message, variant: "destructive" }),
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
  const t = useTranslations("toast.admin");
  return useMutation({
    mutationFn: (
      payload: ChannelCreatePayload
    ): Promise<{ channel: { id: string }; audit: { correlationId: string } }> =>
      createNotificationChannel(payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: queryKeys.events() });
      toast({ title: t("channels.createdTitle") });
    },
    onError: (e: Error) =>
      toast({ title: t("failures.create"), description: e.message, variant: "destructive" }),
  });
}

export function useUpdateNotificationChannel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.admin");
  return useMutation({
    mutationFn: ({
      id,
      ...payload
    }: { id: string } & Parameters<typeof updateNotificationChannel>[1]) =>
      updateNotificationChannel(id, payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: queryKeys.events() });
      toast({ title: t("channels.updatedTitle") });
    },
    onError: (e: Error) =>
      toast({ title: t("failures.update"), description: e.message, variant: "destructive" }),
  });
}

export function useDeleteNotificationChannel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.admin");
  return useMutation({
    mutationFn: (id: string) => deleteNotificationChannel(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: queryKeys.events() });
      toast({ title: t("channels.deletedTitle") });
    },
    onError: (e: Error) =>
      toast({ title: t("failures.delete"), description: e.message, variant: "destructive" }),
  });
}

export function useTestNotificationChannel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.admin");
  return useMutation({
    mutationFn: (id: string): Promise<ChannelTestResult> => testNotificationChannel(id),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: queryKeys.events() });
      // result.result is server copy — kept verbatim.
      toast({ title: t("channels.testTitle"), description: result.result });
    },
    onError: (e: Error) =>
      toast({ title: t("failures.test"), description: e.message, variant: "destructive" }),
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
  const t = useTranslations("toast.admin");
  return useMutation({
    mutationFn: (
      payload: Parameters<typeof updateAdminSettings>[0]
    ): Promise<SettingsUpdateResult> => updateAdminSettings(payload),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: queryKeys.events() });
      void qc.invalidateQueries({ queryKey: queryKeys.meta });
      toast({
        title: t("settings.savedTitle"),
        description: t("settings.savedDescription", { fields: result.updated.join(", ") }),
      });
    },
    onError: (e: Error) =>
      toast({ title: t("settings.saveFailedTitle"), description: e.message, variant: "destructive" }),
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
  const t = useTranslations("toast.admin");
  return useMutation({
    mutationFn: backfillAuditChainApi,
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: queryKeys.events() });
      toast({
        title: t("audit.backfilledTitle"),
        description: t("audit.backfilledDescription", {
          filled: result.filled,
          remaining: result.remaining,
        }),
      });
    },
    onError: (e: Error) =>
      toast({ title: t("audit.backfillFailedTitle"), description: e.message, variant: "destructive" }),
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
  const t = useTranslations("toast.admin");
  return useMutation({
    mutationFn: (planId: string): Promise<RebalanceApplyResult> =>
      applyRebalancePlan(planId),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: queryKeys.events() });
      toast({
        title: t("rebalance.appliedTitle"),
        description: t("rebalance.appliedDescription", {
          moved: result.moved,
          correlation: result.correlationId,
        }),
      });
    },
    onError: (e: Error) =>
      toast({
        title: t("rebalance.failedTitle"),
        description: e.message,
        variant: "destructive",
      }),
  });
}
