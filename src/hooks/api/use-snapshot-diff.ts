"use client";

import { useQuery } from "@tanstack/react-query";

import {
  apiFetch,
  type SnapshotDiffResult,
} from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";

/**
 * Snapshot diff (Task 3-b). `from`/`to` are version numbers or snapshot ids
 * on the given device; rows/stats arrive precomputed from the API — client
 * components never import the diff/normalize libraries.
 */
export function useSnapshotDiff(
  deviceId: string | null | undefined,
  from: string | number | null,
  to: string | number | null,
  mode: "raw" | "normalized" = "normalized"
) {
  const fromKey = from === null || from === undefined ? "" : String(from);
  const toKey = to === null || to === undefined ? "" : String(to);
  const ready = Boolean(deviceId && fromKey && toKey);

  return useQuery({
    queryKey: queryKeys.deviceSnapshotDiff(deviceId ?? "unknown", fromKey, toKey, mode),
    queryFn: () =>
      apiFetch<SnapshotDiffResult>(
        `/api/v1/devices/${deviceId}/snapshots/diff?from=${encodeURIComponent(fromKey)}&to=${encodeURIComponent(toKey)}&mode=${mode}`
      ),
    enabled: ready,
  });
}
