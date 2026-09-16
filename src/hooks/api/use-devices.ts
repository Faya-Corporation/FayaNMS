"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

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

  return useMutation({
    mutationFn: (payload: CreateDevicePayload) =>
      apiFetch<CreateDeviceResult>("/api/v1/devices", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (result) => {
      invalidateDeviceCaches(queryClient);
      toast({
        title: "Device created",
        description: `${result.device.hostname} was added to the inventory with status Unknown.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not create device",
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

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateDevicePayload }) =>
      apiFetch<DeviceDetailResponse>(`/api/v1/devices/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    onSuccess: (device, variables) => {
      invalidateDeviceCaches(queryClient);
      if (variables.data.status) {
        toast({
          title: `Device marked ${variables.data.status.toLowerCase()}`,
          description: `${device.hostname} — status updated.`,
        });
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Could not update device",
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
          ? ` ${result.skipped.length} skipped (unmanaged or missing).`
          : "";
      toast({
        title: `Queued ${result.queued} backup job${result.queued === 1 ? "" : "s"}`,
        description: `Track progress in the Job Center.${skippedNote}`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Bulk backup failed",
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
          ? ` ${result.skipped.length} row${result.skipped.length === 1 ? "" : "s"} skipped.`
          : "";
      toast({
        title: `Imported ${result.created} device${result.created === 1 ? "" : "s"}`,
        description: `CSV import finished.${skippedNote}`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "CSV import failed",
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
    // (ADR-management-address-policy).
    mode:
      | "ip-literal"
      | "dns-a"
      | "refused-ipv6-literal"
      | "refused-aaaa-only"
      | "failed";
    error: string | null;
  };
  vendorStage: "skipped-no-credential" | "executed";
  hostKeyState?: "not-probed" | "pinned" | "capture-requested";
  detection: {
    vendorKey: string;
    confidence: "high" | "low";
    model: string | null;
    osVersion: string | null;
    evidence: string[];
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
    status: "skipped-no-credential" | "executed";
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
    status: "resolved" | "refused" | "failed";
    code: string | null;
    message: string | null;
    mgmtIp: string | null;
    mode: AutoDetectResult["mgmtIpResolution"]["mode"];
  };
}

/**
 * R50-T041 — operator copy keyed on the STABLE codes (never on transport
 * strings). Used for the destructive toast and the resolution line; when a
 * code has no hint the raw message is shown unchanged.
 */
const DETECTION_CODE_OPERATOR_HINTS: Record<string, string> = {
  HOST_KEY_MISMATCH:
    "The SSH host key presented by the target does not match the enrolled key — verify it out-of-band before trusting this endpoint",
  HOST_KEY_UNENROLLED:
    "No SSH host key is enrolled for this endpoint — enroll it first from the device page",
  SSH_AUTH_FAILED:
    "SSH authentication failed — check the credential profile's username and password",
  SSH_CONNECT_TIMEOUT:
    "The endpoint did not answer the SSH connection in time — check reachability and firewall rules",
  SSH_UNREACHABLE: "The endpoint is unreachable over the network",
  SSH_COMMAND_REJECTED: "The device rejected the read-only detection command",
  SSH_SESSION_FAILED: "Could not establish an SSH session with the endpoint",
  CREDENTIAL_UNRESOLVED:
    "The credential profile could not be resolved — check that it still exists",
  CREDENTIAL_NOT_AUTHORIZED:
    "This credential profile cannot drive vendor detection — an SSH_PASSWORD profile is required",
  WORKER_UNAVAILABLE: "The detection worker service is not responding",
  WORKER_REJECTED: "The detection worker rejected the request",
  VENDOR_UNKNOWN: "No certified vendor signature matched (generic)",
  PROBE_NOT_AUTHORIZED:
    "Your role does not include the device-detect permission — ask an administrator",
  DEVICE_PROBE_RATE_LIMITED: "Vendor detection rate limit reached — wait a moment and retry",
  TARGET_NOT_ALLOWED:
    "The target address is refused by the network probe policy (loopback / metadata / reserved)",
};

const RESOLUTION_CODE_OPERATOR_HINTS: Record<string, string> = {
  IPV6_UNSUPPORTED:
    "Management IP not mapped: the target advertises IPv6 only — the device inventory requires an IPv4 (A record / IPv4 literal) management address",
  DNS_NOT_FOUND: "Hostname could not be resolved: the name does not exist in DNS",
  DNS_TIMEOUT: "Hostname could not be resolved: the DNS resolver timed out — try again",
  DNS_LOOKUP_FAILED: "Hostname could not be resolved (DNS failure)",
};

export function useAutoDetectDevice() {
  const { toast } = useToast();

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
        const hint = result.errorCode
          ? DETECTION_CODE_OPERATOR_HINTS[result.errorCode]
          : undefined;
        toast({
          title: "Auto-detect failed",
          description: hint ? `${hint} (${result.error})` : result.error,
          variant: "destructive",
        });
        return;
      }
      const parts: string[] = [];
      if (result.detected && result.detection) {
        parts.push(`Vendor signature: ${result.detection.vendorKey}`);
        if (result.detection.model) parts.push(`Model: ${result.detection.model}`);
        if (result.detection.osVersion) parts.push(`OS: ${result.detection.osVersion}`);
      } else if (result.vendorStage === "executed") {
        parts.push("No vendor signature matched (generic)");
      }
      if (result.mgmtIpResolution.mgmtIp) {
        parts.push(
          `Management IP: ${result.mgmtIpResolution.mgmtIp} (${
            result.mgmtIpResolution.mode === "ip-literal" ? "as entered" : "DNS"
          })`,
        );
      } else if (result.addressResolution?.code) {
        // R50-T040/T041: the typed resolution block decides the copy when
        // present; the literal-based branches below are the legacy fallback.
        const hint = RESOLUTION_CODE_OPERATOR_HINTS[result.addressResolution.code];
        parts.push(
          hint ??
            `Hostname could not be resolved (${
              result.addressResolution.message ?? result.addressResolution.code
            })`,
        );
      } else if (
        result.mgmtIpResolution.error === "IPV6_MANAGEMENT_ADDRESS_UNSUPPORTED"
      ) {
        // R50-T031 — the typed IPv6 policy refusal: name the contract, not
        // a generic DNS failure. (ADR-management-address-policy)
        parts.push(
          "Management IP not mapped: the target advertises IPv6 only — the device inventory requires an IPv4 (A record / IPv4 literal) management address",
        );
      } else {
        parts.push(
          `Hostname could not be resolved (${result.mgmtIpResolution.error ?? "DNS failure"})`,
        );
      }
      if (result.hostKeyCaptured) {
        parts.push(
          "New SSH host key captured — verify it out-of-band and enroll it from the device page",
        );
      }
      toast({
        title: result.vendorStage === "executed" ? "Auto-detect complete" : "Hostname resolved",
        description: parts.join(" · "),
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Auto-detect failed",
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
          title: "Worker service unreachable",
          description:
            "The simulation worker is not responding — connection could not be tested.",
          variant: "destructive",
        });
        return;
      }
      if (result.ok) {
        toast({
          title: `Connection OK${result.latencyMs !== null ? ` — ${result.latencyMs} ms` : ""}`,
          description: `${result.device.hostname} responded${result.workerStatus ? ` (status ${result.workerStatus})` : ""}.`,
        });
      } else {
        toast({
          title: "Connection failed",
          description: result.message ?? "The device did not respond.",
          variant: "destructive",
        });
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Test connection failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });
}
