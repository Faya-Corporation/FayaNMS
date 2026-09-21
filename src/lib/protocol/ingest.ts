export const PROTOCOLS = ["syslog", "snmp-trap", "netflow", "ipfix", "sflow"] as const;
export type ProtocolName = (typeof PROTOCOLS)[number];
export type ProtocolAttribute = string | number | boolean | null;

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
  deviceHint?: { hostname?: string };
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
    attributes: safeAttributes(input.attributes),
  };
}

export function associateProtocolDevice(
  input: Pick<ProtocolIngestInput, "sourceIp" | "deviceHint">,
  candidates: readonly ProtocolDeviceCandidate[],
): ProtocolDeviceAssociation {
  const hostname = input.deviceHint?.hostname?.trim().toLowerCase();
  if (hostname) {
    const byHostname = candidates.find((candidate) => candidate.hostname.toLowerCase() === hostname);
    if (byHostname) return { device: byHostname, method: "hostname" };
  }
  const byIp = candidates.find((candidate) => candidate.mgmtIp === input.sourceIp);
  if (byIp) return { device: byIp, method: "management-ip" };
  return { device: null, method: "unmatched" };
}

export const PROTOCOL_NORMALIZATION_LIMITS = {
  MAX_MESSAGE_LENGTH,
  MAX_ATTRIBUTE_COUNT,
  MAX_ATTRIBUTE_KEY_LENGTH,
  MAX_ATTRIBUTE_VALUE_LENGTH,
} as const;
