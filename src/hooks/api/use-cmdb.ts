"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchCmdb,
  fetchCmdbImpact,
  fetchCmdbItemDetail,
  requestCreateCmdbItem,
  requestCreateCmdbRelation,
  requestDeleteCmdbRelation,
  requestUpdateCmdbItem,
  type CmdbCriticality,
  type CmdbImpactResult,
  type CmdbItemCreated,
  type CmdbItemDetailPayload,
  type CmdbItemStatus,
  type CmdbItemUpdated,
  type CmdbPayload,
  type CmdbRelationCreated,
  type CmdbRelationType,
} from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";

/**
 * CMDB hooks (Phase 15-a) against /api/v1/cmdb/*.
 *
 * The list read bundles items + global counts + site options + the CMDB
 * audit history; a 30 s staleTime + 60 s poll keeps the KPI row and queue
 * fresh without hammering the API. Every payload the server emits is
 * deterministically ordered (items ciId asc, history newest-first) so
 * polling never reshuffles or flickers rows. Mutations invalidate the whole
 * "cmdb" tree (list + details + impact caches) plus "events" (CMDB_* audit
 * trail) and "devices" is NOT touched (CI creation never mutates devices).
 */
export function useCmdb(params: Record<string, string | number | undefined> = {}) {
  return useQuery({
    queryKey: queryKeys.cmdb(params),
    queryFn: () => fetchCmdb(params),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useCmdbItemDetail(id: string | null) {
  return useQuery({
    queryKey: queryKeys.cmdbItemDetail(id ?? "none"),
    queryFn: () => fetchCmdbItemDetail(id as string),
    enabled: Boolean(id),
    staleTime: 15_000,
  });
}

/**
 * Impact BFS result for the selected CI. Deliberately an on-demand
 * (enabled: false) query — the view fires refetch() when the operator
 * clicks the impact-lookup button, and the deterministic BFS keeps the
 * result stable across refetches.
 */
export function useCmdbImpact(itemId: string | null) {
  return useQuery({
    queryKey: queryKeys.cmdbImpact(itemId ?? "none"),
    queryFn: () => fetchCmdbImpact(itemId as string),
    enabled: false,
  });
}

function invalidateCmdbCaches(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ["cmdb"] });
  void queryClient.invalidateQueries({ queryKey: ["events"] });
}

export function useCreateCmdbItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: Parameters<typeof requestCreateCmdbItem>[0]): Promise<CmdbItemCreated> =>
      requestCreateCmdbItem(vars),
    onSuccess: () => invalidateCmdbCaches(queryClient),
  });
}

export function useUpdateCmdbItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      status?: CmdbItemStatus;
      criticality?: CmdbCriticality;
      ownerId?: string | null;
      description?: string | null;
    }): Promise<CmdbItemUpdated> => requestUpdateCmdbItem(vars),
    onSuccess: () => invalidateCmdbCaches(queryClient),
  });
}

export function useCreateCmdbRelation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      sourceId: string;
      targetId: string;
      relationType: CmdbRelationType;
    }): Promise<CmdbRelationCreated> => requestCreateCmdbRelation(vars),
    onSuccess: () => invalidateCmdbCaches(queryClient),
  });
}

export function useDeleteCmdbRelation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => requestDeleteCmdbRelation(id),
    onSuccess: () => invalidateCmdbCaches(queryClient),
  });
}

/** Re-exported for convenience so the view can type its impact state. */
export type { CmdbImpactResult, CmdbItemDetailPayload, CmdbPayload };
