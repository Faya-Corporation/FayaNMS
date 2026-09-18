"use client";

import { useQuery } from "@tanstack/react-query";

import {
  apiFetch,
  type MetaPayload,
  type MetaUsersPayload,
} from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";

/** Reference data (vendors + sites) for filter bars and pickers. */
export function useMeta() {
  return useQuery({
    queryKey: queryKeys.meta,
    queryFn: () => apiFetch<MetaPayload>("/api/v1/meta"),
    staleTime: 5 * 60_000,
  });
}

/**
 * HC-2 (R54): the ACTIVE user directory for the alert assign/suppress
 * picker — split out of the session-exempt bootstrap payload and served
 * by the AUTHENTICATED `/api/v1/meta/users` (fetched after hydration;
 * the shell only renders behind the session, so the query fires with a
 * live cookie).
 */
export function useMetaUsers() {
  return useQuery({
    queryKey: queryKeys.metaUsers,
    queryFn: () => apiFetch<MetaUsersPayload>("/api/v1/meta/users"),
    staleTime: 5 * 60_000,
  });
}
