"use client";

import { useQuery } from "@tanstack/react-query";

import { apiFetch, buildQueryString } from "@/lib/api-client";

/* ─────────────────────────────────────────────────────────────────────────────
 * Interfaces inventory hooks (network.interfaces view) — /api/v1/interfaces.
 *
 * Inline ["netif", filters] query key (no query-keys.ts entry — this shard
 * does not own that file); structural hashing keeps identical filter sets
 * sharing one cache entry. 30 s staleTime + 60 s poll mirrors the other
 * inventory surfaces (devices/ha): counters and flap states stay fresh
 * without hammering the API.
 * ───────────────────────────────────────────────────────────────────────────── */

export type InterfaceOperStatus =
  | "UP"
  | "DOWN"
  | "TESTING"
  | "UNKNOWN"
  | "DORMANT"
  | "NOT_PRESENT"
  | "LOWER_LAYER_DOWN";

export type InterfaceAdminStatus = "UP" | "DOWN" | "TESTING";

export type InterfaceSortField = "device" | "name" | "speed" | "utilization";

export interface InterfacesFilters {
  /** Substring over name / macAddress / description. */
  q?: string;
  /** Exact Site.code match. */
  site?: string;
  /** Substring over Device.hostname. */
  hostnameLike?: string;
  operStatus?: InterfaceOperStatus;
  adminStatus?: InterfaceAdminStatus;
  vlan?: number;
  sort?: InterfaceSortField;
  order?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

/** One inventory row (BigInt bps counters already serialized to numbers). */
export interface InterfaceRow {
  id: string;
  deviceId: string;
  deviceHostname: string;
  deviceStatus: string;
  siteCode: string | null;
  vendorName: string;
  name: string;
  adminStatus: string;
  operStatus: string;
  speedMbps: number | null;
  macAddress: string | null;
  description: string | null;
  vlan: number | null;
  mtu: number | null;
  inBps: number | null;
  outBps: number | null;
  /** max(in,out)/speed · 100, 1dp — null when speed or counters are unknown. */
  utilizationPct: number | null;
  /** ISO timestamp or null when the interface never flapped. */
  lastFlapAt: string | null;
}

export interface InterfacesSummary {
  total: number;
  /** operStatus UP. */
  up: number;
  /** operStatus DOWN. */
  down: number;
  /** adminStatus DOWN. */
  adminDown: number;
  /** lastFlapAt within the last 24 hours. */
  flapping24h: number;
}

export interface InterfacesPageInfo {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface InterfacesPayload {
  summary: InterfacesSummary;
  rows: InterfaceRow[];
  page: InterfacesPageInfo;
}

/** GET /api/v1/interfaces — returns the envelope's `data`. */
export function fetchInterfaces(
  filters: InterfacesFilters
): Promise<InterfacesPayload> {
  return apiFetch<InterfacesPayload>(
    `/api/v1/interfaces${buildQueryString({ ...filters })}`
  );
}

export function useInterfaces(filters: InterfacesFilters) {
  return useQuery({
    queryKey: ["netif", filters],
    queryFn: () => fetchInterfaces(filters),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
