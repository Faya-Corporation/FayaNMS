import { createHash } from "node:crypto";
import type { NetFlowV5Batch } from "./netflow-v5";

export const PROTOCOLS = ["syslog", "snmp-trap", "netflow", "ipfix", "sflow"] as const;
export type ProtocolName = (typeof PROTOCOLS)[number];
export type ProtocolAttribute = string | number | boolean | null;
export type SnmpSecurityLevel = "authPriv" | "community" | "unknown";
export type ProtocolDeviceHint = {
  hostname?: string;
  credentialProfileId?: string;
};

export interface ProtocolIngestInput {
  collectorId: string;
  protocol: ProtocolName;
  sourceIp: string;
  sourcePort: number;
  receivedAt: Date;
  eventType: string;
  severity: string;
  message: string;
  protocolVersion?: string;
  flowBatch?: NetFlowV5Batch;
  securityLevel?: SnmpSecurityLevel;
  deviceHint?: ProtocolDeviceHint;
  attributes?: Record<string, ProtocolAttribute>;
}

export interface ProtocolDeviceCandidate {
  id: string;
  hostname: string;
  mgmtIp: string;
}

export interface ProtocolDeviceAssociation {
  device: ProtocolDeviceCandidate | null;
  method: "hostname" | "management-ip" | "unmatched";
  /**
   * F-036 (batch-11): the caller-supplied hostname hint could NOT be
   * corroborated against the event's source IP — either it named a device
   * whose management IP differs from the source (contradiction: possible
   * spoofed attribution), or no device matched the source at all and the
   * attribution rests solely on the caller's claim. True means "honor the
   * association, but display it as unverified" (queue column
   * `attributionUnverified` + the ingest response's associatedDevice.unverified).
   * Absent/false = the source IP anchored the attribution (or nothing matched).
   */
  attributionUnverified?: boolean;
}

export interface NormalizedProtocolEvent {
  collectorId: string;
  protocol: ProtocolName;
  sourceIp: string;
  sourcePort: number;
  receivedAt: string;
  eventType: string;
  severity: string;
  message: string;
  protocolVersion: string | null;
  securityLevel: SnmpSecurityLevel | null;
  attributes: Record<string, ProtocolAttribute>;
}

const MAX_MESSAGE_LENGTH = 2_048;
const MAX_ATTRIBUTE_COUNT = 32;
const MAX_ATTRIBUTE_KEY_LENGTH = 64;
const MAX_ATTRIBUTE_VALUE_LENGTH = 256;

function boundedText(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function safeAttributes(input: Record<string, ProtocolAttribute> | undefined): Record<string, ProtocolAttribute> {
  const result: Record<string, ProtocolAttribute> = {};
  for (const [rawKey, rawValue] of Object.entries(input ?? {}).slice(0, MAX_ATTRIBUTE_COUNT)) {
    const key = boundedText(rawKey, MAX_ATTRIBUTE_KEY_LENGTH);
    if (!key || key in result) continue;
    if (typeof rawValue === "string") result[key] = boundedText(rawValue, MAX_ATTRIBUTE_VALUE_LENGTH);
    else if (typeof rawValue === "number") result[key] = Number.isFinite(rawValue) ? rawValue : null;
    else result[key] = rawValue;
  }
  return result;
}

export function normalizeProtocolEvent(input: ProtocolIngestInput): NormalizedProtocolEvent {
  return {
    collectorId: boundedText(input.collectorId, 120),
    protocol: input.protocol,
    sourceIp: boundedText(input.sourceIp, 64),
    sourcePort: input.sourcePort,
    receivedAt: input.receivedAt.toISOString(),
    eventType: boundedText(input.eventType, 120),
    severity: boundedText(input.severity, 32).toUpperCase(),
    message: boundedText(input.message, MAX_MESSAGE_LENGTH),
    protocolVersion: input.protocolVersion ? boundedText(input.protocolVersion, 32) : null,
    securityLevel: input.securityLevel ?? null,
    attributes: safeAttributes(input.attributes),
  };
}

export function associateProtocolDevice(
  input: Pick<ProtocolIngestInput, "sourceIp" | "deviceHint">,
  candidates: readonly ProtocolDeviceCandidate[],
): ProtocolDeviceAssociation {
  const hostname = input.deviceHint?.hostname?.trim().toLowerCase();
  const byIp = candidates.find((candidate) => candidate.mgmtIp === input.sourceIp);
  const byHostname = hostname
    ? candidates.find((candidate) => candidate.hostname.toLowerCase() === hostname)
    : undefined;

  // F-036 (batch-11): the SOURCE IP is the trust anchor — a hostname hint
  // arrives from the network and can name ANY device. IP attribution wins
  // outright; a hostname that disagrees with it (or an attribution resting
  // on the hostname alone) is honored only with the unverified marker.
  if (byIp) {
    if (byHostname && byHostname.id !== byIp.id) {
      // Contradicted hostname claim — attribute by source IP and flag the
      // event (a spoof indicator, not a refusal: the source IP is verified).
      return { device: byIp, method: "management-ip", attributionUnverified: true };
    }
    return { device: byIp, method: "management-ip" };
  }
  // No device owns this source IP: a hostname match is honored for the
  // legitimate relay/NAT case, but it is caller-claimed and unverifiable —
  // mark the event attributionUnverified (schema flag + UI badge surface).
  if (byHostname) {
    return { device: byHostname, method: "hostname", attributionUnverified: true };
  }
  return { device: null, method: "unmatched" };
}

/* ── F-048 (batch-18): ingest idempotency ─────────────────────────────────
 * Collector delivery is at-least-once: a relay that retries after a lost
 * 202 must not duplicate queue rows (and through them FlowRecords, which
 * would double-count bytes/talkers in flow analytics). The ingest accepts
 * an optional client `idempotencyKey` and, for NetFlow v5 without one,
 * derives a key from the datagram header — the same datagram (a retry or a
 * duplicate UDP transmission) always decodes to the same header fields, so
 * the derived key is stable across collector retries while every NEW batch
 * differs (exporters increment flowSequence per datagram).
 *
 * The dedupe key maps DETERMINISTICALLY onto the queue row's correlationId
 * (normally a random `NET-XXXXXX` minted per POST). The ingest transaction
 * therefore preflights a live prior attempt (QUEUED/IN_FLIGHT/DELIVERED)
 * by (collectorId, correlationId) — no schema change — and a
 * transaction-scoped Postgres advisory lock makes that check-then-insert
 * race-safe: a concurrent double-submit blocks on the lock until the first
 * transaction commits, then observes the committed row instead of inserting
 * a second one. The dedupe WINDOW is the lifetime of the original queue
 * row: DELIVERED rows are pruned by `protocolQueue.retention` (default 7
 * delivered days), and a DEAD prior attempt releases the key so the retry
 * is re-queued (at-least-once for failures). Outside the window — or with
 * no key and no derivable NetFlow header — behavior is exactly as before.
 */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

export interface ProtocolIdempotencyInput {
  collectorId: string;
  idempotencyKey?: string;
  protocol: string;
  protocolVersion?: string | null;
  sourceIp: string;
  sourcePort: number;
  flowBatch?: NetFlowV5Batch;
}

export type ProtocolIdempotency =
  | { mode: "client"; dedupeKey: string; correlationId: string }
  | { mode: "derived"; dedupeKey: string; correlationId: string }
  | null;

function idempotentCorrelationId(dedupeKey: string): string {
  return "NET-" + createHash("sha256").update(dedupeKey).digest("hex").slice(0, 32);
}

/**
 * Resolve the ingest idempotency identity: an explicit client key wins;
 * otherwise a NetFlow v5 batch derives one from collector + exporter peer
 * + flowSequence + export timestamps (the audit finding's named tuple).
 * JSON encoding keeps the tuple unambiguous (collectorIds may contain ":").
 * Returns null when nothing is derivable — the event keeps today's
 * at-least-once behavior (a fresh random correlation id per POST).
 */
export function resolveProtocolIdempotency(
  input: ProtocolIdempotencyInput,
): ProtocolIdempotency {
  if (input.idempotencyKey) {
    const dedupeKey = JSON.stringify(["client", input.collectorId, input.idempotencyKey]);
    return { mode: "client", dedupeKey, correlationId: idempotentCorrelationId(dedupeKey) };
  }
  if (
    input.protocol === "netflow" &&
    input.protocolVersion === "NETFLOW_V5" &&
    input.flowBatch
  ) {
    const header = input.flowBatch.header;
    const dedupeKey = JSON.stringify([
      "netflow-v5",
      input.collectorId,
      input.sourceIp,
      input.sourcePort,
      header.flowSequence,
      header.unixSeconds,
      header.unixNanoseconds,
    ]);
    return { mode: "derived", dedupeKey, correlationId: idempotentCorrelationId(dedupeKey) };
  }
  return null;
}

export const PROTOCOL_NORMALIZATION_LIMITS = {
  MAX_MESSAGE_LENGTH,
  MAX_ATTRIBUTE_COUNT,
  MAX_ATTRIBUTE_KEY_LENGTH,
  MAX_ATTRIBUTE_VALUE_LENGTH,
} as const;

export interface ProtocolCredentialProfileCandidate {
  id: string;
  type: string;
  deviceId: string;
}

export type ProtocolPolicyResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

/**
 * SNMP trap ingress is fail-closed. The worker's generic BER framing path
 * reports securityLevel=unknown and is therefore not accepted as a trusted
 * production trap. A future decoder may pass authPriv only after verifying
 * USM authentication/privacy with a server-side credential profile that is
 * bound to the associated device.
 */
export function validateProtocolIngestPolicy(
  input: Pick<ProtocolIngestInput, "protocol" | "securityLevel" | "deviceHint">,
  association: ProtocolDeviceAssociation,
  profile: ProtocolCredentialProfileCandidate | null,
): ProtocolPolicyResult {
  if (input.protocol !== "snmp-trap") return { ok: true };
  if (input.securityLevel !== "authPriv") {
    return {
      ok: false,
      code: "SNMP_AUTHPRIV_REQUIRED",
      message: "SNMP traps require verified SNMPv3 authPriv before ingestion.",
    };
  }
  const profileId = input.deviceHint?.credentialProfileId?.trim();
  if (!profileId) {
    return {
      ok: false,
      code: "SNMP_PROFILE_REQUIRED",
      message: "SNMPv3 traps require an explicit device credential profile reference.",
    };
  }
  if (!association.device) {
    return {
      ok: false,
      code: "SNMP_DEVICE_UNMATCHED",
      message: "SNMPv3 traps require an exact associated device before ingestion.",
    };
  }
  if (
    !profile ||
    profile.id !== profileId ||
    profile.type !== "SNMPV3" ||
    profile.deviceId !== association.device.id
  ) {
    return {
      ok: false,
      code: "SNMP_PROFILE_MISMATCH",
      message: "SNMPv3 trap credential profile is not bound to the associated device.",
    };
  }
  return { ok: true };
}
