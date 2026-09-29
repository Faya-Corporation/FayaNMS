"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import {
  apiFetch,
  apiRequest,
  buildQueryString,
  type BulkDeviceActionResult,
  type CreateDevicePayload,
  type CreateDeviceResult,
  type CsvImportPayload,
  type DeviceRow,
  type ImportResult,
  type PagedResult,
  type TestConnectionResult,
  type UpdateDevicePayload,
} from "@/lib/api-client";
import { queryKeys, type ListParams } from "@/lib/query-keys";
import { useToast } from "@/hooks/use-toast";

export type DeviceSortField =
  | "hostname"
  | "name"
  | "status"
  | "criticality"
  | "backupCompliance"
  | "lastBackupAt"
  | "lastSeen";

export interface DeviceListParams extends ListParams {
  /** Search across hostname / displayName / mgmtIp. */
  q?: string;
  /** Legacy alias for q (kept for older callers). */
  search?: string;
  /** csv multi, e.g. "ONLINE,DEGRADED" */
  status?: string;
  vendorId?: string;
  siteId?: string;
  /** csv multi */
  criticality?: string;
  /** csv multi */
  backupCompliance?: string;
  sort?: DeviceSortField;
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export function useDevices(params: DeviceListParams = {}) {
  return useQuery({
    queryKey: queryKeys.devices(params),
    queryFn: async (): Promise<PagedResult<DeviceRow>> => {
      const envelope = await apiRequest<DeviceRow[]>(
        `/api/v1/devices${buildQueryString(params)}`
      );
      const meta = envelope.meta as unknown as PagedResult<DeviceRow>["meta"];
      return { data: envelope.data, meta };
    },
  });
}

/* ------------------------------------------------------------------ */
/* Mutations                                                            */
/* ------------------------------------------------------------------ */

function invalidateDeviceCaches(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ["devices"] });
  void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
}

/** Create a device (Add Device flow). Returns the created device. */
export function useCreateDevice() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.devices");

  return useMutation({
    mutationFn: (payload: CreateDevicePayload) =>
      apiFetch<CreateDeviceResult>("/api/v1/devices", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (result) => {
      invalidateDeviceCaches(queryClient);
      toast({
        title: t("createTitle"),
        description: t("createDescription", { hostname: result.device.hostname }),
      });
    },
    onError: (error: Error) => {
      // API error copy (error.message) stays server-sourced — only the fixed
      // titles are translated.
      toast({
        title: t("createFailedTitle"),
        description: error.message,
        variant: "destructive",
      });
    },
  });
}

/** PATCH editable device fields (display name, site, criticality, tags, status…). */
export function useUpdateDevice() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.devices");

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateDevicePayload }) =>
      apiFetch<DeviceDetailResponse>(`/api/v1/devices/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    onSuccess: (device, variables) => {
      invalidateDeviceCaches(queryClient);
      if (variables.data.status) {
        // {status} stays the raw lowercased enum token (technical value).
        toast({
          title: t("updateStatusTitle", {
            status: variables.data.status.toLowerCase(),
          }),
          description: t("updateStatusDescription", { hostname: device.hostname }),
        });
      }
    },
    onError: (error: Error) => {
      toast({
        title: t("updateFailedTitle"),
        description: error.message,
        variant: "destructive",
      });
    },
  });
}

interface DeviceDetailResponse {
  id: string;
  hostname: string;
  status: string;
  [key: string]: unknown;
}

/**
 * Bulk action on devices. action: "backup_now" enqueues one CONFIG_BACKUP
 * job per eligible device.
 */
export function useBulkDeviceAction() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.devices");

  return useMutation({
    mutationFn: (payload: { action: "backup_now"; deviceIds: string[] }) =>
      apiFetch<BulkDeviceActionResult>("/api/v1/devices/bulk", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      const skippedNote =
        result.skipped.length > 0
          ? ` ${t("bulkBackupSkipped", { count: result.skipped.length })}`
          : "";
      toast({
        title: t("bulkBackupTitle", { count: result.queued }),
        description: `${t("bulkBackupDescription")}${skippedNote}`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("bulkBackupFailedTitle"),
        description: error.message,
        variant: "destructive",
      });
    },
  });
}

/**
 * Bulk import devices from client-parsed CSV rows (2-c). Per-row validation
 * issues come back in `skipped`; valid rows are created with status Unknown
 * and audited. Invalidates devices + dashboard.
 */
export function useCsvImportDevices() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.devices");

  return useMutation({
    mutationFn: (payload: CsvImportPayload) =>
      apiFetch<ImportResult>("/api/v1/devices/csv-import", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (result) => {
      invalidateDeviceCaches(queryClient);
      const skippedNote =
        result.skipped.length > 0
          ? ` ${t("csvImportSkipped", { count: result.skipped.length })}`
          : "";
      toast({
        title: t("csvImportTitle", { count: result.created }),
        description: `${t("csvImportDescription")}${skippedNote}`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("csvImportFailedTitle"),
        description: error.message,
        variant: "destructive",
      });
    },
  });
}

/**
 * R50 — auto-detect a device's vendor (read-only SSH fingerprint via the
 * worker) and map its hostname to a management address (DNS), for the
 * Add/Edit device sheet. Returns the raw detection result; the form applies
 * it (vendor select, mgmt IP, model) and toasts here.
 */
export interface AutoDetectPayload {
  host: string;
  credentialProfileId?: string;
  /**
   * R50.6 (R50-T064) — stage-specific retry: run only the named stages.
   * Omitted = both (the historical full run). Unrequested stages come
   * back as `skipped-not-requested` and perform NO device work.
   */
  stages?: Array<"vendor" | "address">;
}

export interface AutoDetectResult {
  // R50.4 (R50-T042) — contract stamp; older servers omit it.
  contractVersion?: number;
  host: string;
  // R50-T011 explicit endpoint identities (the route returns them; optional
  // here so older servers remain assignable).
  requestedHost?: string;
  connectionAddress?: string | null;
  resolvedManagementIp?: string | null;
  mgmtIpResolution: {
    mgmtIp: string | null;
    // R50-T031: the AAAA/IPv6 success modes are gone — the resolver
    // refuses them under the IPv4-only inventory policy
    // (ADR-management-address-policy). R50-T064: a stage the caller did
    // not request reports "skipped-not-requested" (never a failure).
    mode:
      | "ip-literal"
      | "dns-a"
      | "refused-ipv6-literal"
      | "refused-aaaa-only"
      | "failed"
      | "skipped-not-requested";
    error: string | null;
  };
  vendorStage: "skipped-no-credential" | "executed" | "skipped-not-requested";
  hostKeyState?: "not-probed" | "pinned" | "capture-requested";
  detection: {
    vendorKey: string;
    confidence: "high" | "low";
    model: string | null;
    osVersion: string | null;
    evidence: string[];
    // R50.5 (R50-T052/T054) — optional so older servers stay assignable.
    matchReasons?: string[];
    softMatches?: string[];
  } | null;
  detected: boolean;
  probeCommand: string | null;
  latencyMs: number | null;
  hostKeyCaptured: { keyType: string; fingerprint: string } | null;
  error: string | null;
  // ── R50.4 typed contract (all optional so older servers stay assignable)
  // R50-T041: stable registry code for the overall outcome (vendor stage
  // wins, resolution stage fallback); null when there is nothing to report.
  errorCode?: string | null;
  // R50-T040: the two independent stage blocks — partial results are
  // reported per stage, never collapsed into one boolean.
  vendorDetection?: {
    status: "skipped-no-credential" | "executed" | "skipped-not-requested";
    outcome: "matched" | "generic" | "failed" | "not-attempted";
    code: string | null;
    message: string | null;
    detection: AutoDetectResult["detection"];
    probeCommand: string | null;
    latencyMs: number | null;
    hostKeyState?: "not-probed" | "pinned" | "capture-requested";
    hostKeyCaptured: AutoDetectResult["hostKeyCaptured"];
  };
  addressResolution?: {
    status: "resolved" | "refused" | "failed" | "skipped-not-requested";
    code: string | null;
    message: string | null;
    mgmtIp: string | null;
    mode: AutoDetectResult["mgmtIpResolution"]["mode"];
  };
}

/**
 * R50-T041 — operator copy keyed on the STABLE codes (never on transport
 * strings). Each code maps to its `detect.hints.<CODE>` dictionary key
 * (resolved through useTranslations at hook level); when a code has no
 * mapping the raw message is shown unchanged (contract documented in
 * useAutoDetectDevice below).
 */
const DETECTION_CODE_HINT_KEYS: Record<string, string> = {
  HOST_KEY_MISMATCH: "HOST_KEY_MISMATCH",
  HOST_KEY_UNENROLLED: "HOST_KEY_UNENROLLED",
  SSH_AUTH_FAILED: "SSH_AUTH_FAILED",
  SSH_CONNECT_TIMEOUT: "SSH_CONNECT_TIMEOUT",
  SSH_UNREACHABLE: "SSH_UNREACHABLE",
  SSH_COMMAND_REJECTED: "SSH_COMMAND_REJECTED",
  SSH_SESSION_FAILED: "SSH_SESSION_FAILED",
  CREDENTIAL_UNRESOLVED: "CREDENTIAL_UNRESOLVED",
  CREDENTIAL_NOT_AUTHORIZED: "CREDENTIAL_NOT_AUTHORIZED",
  WORKER_UNAVAILABLE: "WORKER_UNAVAILABLE",
  WORKER_REJECTED: "WORKER_REJECTED",
  VENDOR_UNKNOWN: "VENDOR_UNKNOWN",
  PROBE_NOT_AUTHORIZED: "PROBE_NOT_AUTHORIZED",
  DEVICE_PROBE_RATE_LIMITED: "DEVICE_PROBE_RATE_LIMITED",
  TARGET_NOT_ALLOWED: "TARGET_NOT_ALLOWED",
  IPV6_UNSUPPORTED: "IPV6_UNSUPPORTED",
  DNS_NOT_FOUND: "DNS_NOT_FOUND",
  DNS_TIMEOUT: "DNS_TIMEOUT",
  DNS_LOOKUP_FAILED: "DNS_LOOKUP_FAILED",
};

/**
 * Resolve a stable error code to its `detect.hints.*` dictionary key.
 * Returns null for unmapped/missing codes so callers fall back to the raw
 * transport message (R50-T041 fallback contract).
 */
export function detectionHintKey(code: string | null | undefined): string | null {
  if (!code) return null;
  return Object.prototype.hasOwnProperty.call(DETECTION_CODE_HINT_KEYS, code)
    ? DETECTION_CODE_HINT_KEYS[code]
    : null;
}

export function useAutoDetectDevice() {
  const { toast } = useToast();
  const t = useTranslations("toast.devices");
  const th = useTranslations("detect.hints");

  return useMutation({
    mutationFn: (payload: AutoDetectPayload) =>
      apiFetch<AutoDetectResult>("/api/v1/devices/auto-detect", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (result) => {
      if (result.error) {
        // R50-T041: prefer the operator copy keyed on the STABLE code; the
        // raw transport message stays the fallback for unmapped codes.
        const hintKey = detectionHintKey(result.errorCode);
        const hint = hintKey ? th(hintKey) : undefined;
        toast({
          title: t("detectFailedTitle"),
          description: hint ? `${hint} (${result.error})` : result.error,
          variant: "destructive",
        });
        return;
      }
      const parts: string[] = [];
      // R50-T064: a skipped-not-requested stage contributes NOTHING to
      // the summary — an address-only retry must not report a bogus DNS
      // failure, and a vendor-only retry must not report "no signature
      // matched" for a probe that never ran.
      const vendorRan = result.vendorDetection
        ? result.vendorDetection.status !== "skipped-not-requested"
        : true;
      const addressRan = result.addressResolution
        ? result.addressResolution.status !== "skipped-not-requested"
        : true;
      if (vendorRan) {
        if (result.detected && result.detection) {
          parts.push(t("detectVendorSignature", { vendor: result.detection.vendorKey }));
          if (result.detection.model)
            parts.push(t("detectModel", { model: result.detection.model }));
          if (result.detection.osVersion)
            parts.push(t("detectOs", { os: result.detection.osVersion }));
          // R50-T052: the deterministic matched-signature ids — the summary
          // names WHY the vendor was claimed, not just which one won.
          if (result.detection.matchReasons?.length) {
            parts.push(
              t("detectMatched", { reasons: result.detection.matchReasons.join(", ") })
            );
          }
        } else if (result.vendorStage === "executed") {
          parts.push(t("detectNoSignature"));
          // R50-T054: banner/hostname near-misses are surfaced so a generic
          // answer with "cisco.vendor-name" is visibly different from one
          // with nothing informative at all.
          if (result.detection?.softMatches?.length) {
            parts.push(
              t("detectSoftMatches", {
                tokens: result.detection.softMatches.join(", "),
              })
            );
          }
        }
      }
      if (result.mgmtIpResolution.mgmtIp) {
        parts.push(
          t("detectManagementIp", {
            ip: result.mgmtIpResolution.mgmtIp,
            source:
              result.mgmtIpResolution.mode === "ip-literal"
                ? t("detectSourceAsEntered")
                : t("detectSourceDns"),
          }),
        );
      } else if (addressRan && result.addressResolution?.code) {
        // R50-T040/T041: the typed resolution block decides the copy when
        // present; the raw-message fallback is the legacy path.
        const hintKey = detectionHintKey(result.addressResolution.code);
        parts.push(
          hintKey
            ? th(hintKey)
            : t("detectResolveFailed", {
                detail:
                  result.addressResolution.message ?? result.addressResolution.code,
              }),
        );
      } else if (
        addressRan &&
        result.mgmtIpResolution.error === "IPV6_MANAGEMENT_ADDRESS_UNSUPPORTED"
      ) {
        // R50-T031 — the typed IPv6 policy refusal: name the contract, not
        // a generic DNS failure. (ADR-management-address-policy)
        parts.push(th("IPV6_UNSUPPORTED"));
      } else if (addressRan) {
        parts.push(
          t("detectResolveFailed", {
            detail: result.mgmtIpResolution.error ?? t("detectResolveFallback"),
          }),
        );
      }
      if (result.hostKeyCaptured) {
        parts.push(t("detectHostKeyCaptured"));
      }
      // R50-T064: the title names what RAN, not what was skipped.
      const title =
        vendorRan && addressRan
          ? result.vendorStage === "executed"
            ? t("detectTitleAll")
            : t("detectTitleHostnameOnly")
          : vendorRan
            ? t("detectTitleVendorOnly")
            : t("detectTitleAddressOnly");
      toast({
        title,
        description: parts.join(" · "),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("detectFailedTitle"),
        description: error.message,
        variant: "destructive",
      });
    },
  });
}

/**
 * Probe a device through the simulation worker (mini-service, roadmap 2-b).
 * Resolves with reachable:false + "Worker service unreachable" when the
 * worker is not running — surfaced as a warning toast here; callers may
 * also read the result for inline banners.
 */
export function useTestConnection() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const t = useTranslations("toast.devices");

  return useMutation({
    mutationFn: (deviceId: string) =>
      apiFetch<TestConnectionResult>("/api/v1/devices/test-connection", {
        method: "POST",
        body: JSON.stringify({ deviceId }),
      }),
    onSuccess: (result) => {
      invalidateDeviceCaches(queryClient);
      if (!result.reachable) {
        toast({
          title: t("workerTitle"),
          description: t("workerDescription"),
          variant: "destructive",
        });
        return;
      }
      if (result.ok) {
        const latency =
          result.latencyMs !== null ? t("connectionLatency", { ms: result.latencyMs }) : "";
        const status = result.workerStatus
          ? t("connectionStatus", { status: result.workerStatus })
          : "";
        toast({
          title: t("connectionOkTitle", { latency }),
          description: t("connectionOkDescription", {
            hostname: result.device.hostname,
            status,
          }),
        });
      } else {
        // result.message is server copy — kept verbatim when present.
        toast({
          title: t("connectionFailedTitle"),
          description: result.message ?? t("connectionFailedFallback"),
          variant: "destructive",
        });
      }
    },
    onError: (error: Error) => {
      toast({
        title: t("testFailedTitle"),
        description: error.message,
        variant: "destructive",
      });
    },
  });
}
