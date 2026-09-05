"use client";

import { useQuery } from "@tanstack/react-query";

import { apiFetch, type SearchResults } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";

/** Cross-entity search for the command palette (min 2 chars, debounced upstream). */
export function useSearch(query: string) {
  const trimmed = query.trim();
  return useQuery({
    queryKey: queryKeys.search(trimmed),
    queryFn: () =>
      apiFetch<SearchResults>(
        `/api/v1/search?q=${encodeURIComponent(trimmed)}`
      ),
    enabled: trimmed.length >= 2,
  });
}
