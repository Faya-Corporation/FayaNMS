"use client";

import { useQuery } from "@tanstack/react-query";

import {
  fetchPerformanceAvailability,
  fetchPerformanceCapacity,
  fetchPerformanceDevices,
  fetchPerformanceInterfaces,
  fetchPerformanceOverview,
  type CapacityParams,
  type PerfDeviceParams,
  type PerfInterfaceParams,
  type PerfRange,
} from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";

/**
 * Performance slice hooks (Task 6-b), against the frozen 6-a contract:
 * range ∈ "1H" | "24H" | "7D" | "30D". The overview refetches every 15 s
 * (live NOC-style surface); the analytical facets (availability, capacity)
 * are cheaper to poll so they use a longer staleTime instead.
 */

export function usePerformanceOverview(range: PerfRange = "24H") {
  return useQuery({
    queryKey: queryKeys.performance("overview", { range }),
    queryFn: () => fetchPerformanceOverview(range),
    staleTime: 30_000,
    refetchInterval: 15_000,
  });
}

export function usePerformanceDevices(params: PerfDeviceParams = {}) {
  return useQuery({
    queryKey: queryKeys.performance("devices", params),
    queryFn: () => fetchPerformanceDevices(params),
    staleTime: 30_000,
  });
}

export function usePerformanceInterfaces(params: PerfInterfaceParams = {}) {
  return useQuery({
    queryKey: queryKeys.performance("interfaces", params),
    queryFn: () => fetchPerformanceInterfaces(params),
    staleTime: 30_000,
  });
}

export function usePerformanceAvailability(range: PerfRange = "24H") {
  return useQuery({
    queryKey: queryKeys.performance("availability", { range }),
    queryFn: () => fetchPerformanceAvailability(range),
    staleTime: 60_000,
  });
}

export function usePerformanceCapacity(params: CapacityParams = {}) {
  return useQuery({
    queryKey: queryKeys.performance("capacity", params),
    queryFn: () => fetchPerformanceCapacity(params),
    staleTime: 60_000,
  });
}
