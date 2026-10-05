/**
 * Authenticated SNMPv3 polling for the worker data plane.
 *
 * The worker resolves the vault reference locally, builds authPriv requests,
 * verifies each response with the shared protocol harness, and returns only
 * bounded telemetry. Secrets and raw packets never leave this module.
 */

import { createSocket } from "node:dgram";
import { isIP } from "node:net";
import { resolveVaultSecret } from "./vault";
import { resolveTargetForDial } from "./target-policy";
import {
  buildSnmpV3GetRequest,
  decodeSnmpV3GetResponse,
  readSnmpV3UsmIdentity,
} from "../../scripts/protocol-lab/snmpv3";
import { normalizeEngineIdHex } from "../../src/lib/protocol/snmpv3-policy";

export const SNMP_POLL_OIDS = {
  sysDescr: "1.3.6.1.2.1.1.1.0",
  sysUpTime: "1.3.6.1.2.1.1.3.0",
  sysName: "1.3.6.1.2.1.1.5.0",
  ifNumber: "1.3.6.1.2.1.2.1.0",
  ifDescr: "1.3.6.1.2.1.2.2.1.2",
  ifOperStatus: "1.3.6.1.2.1.2.2.1.8",
  ifHCInOctets: "1.3.6.1.2.1.31.1.1.1.6",
  ifHCOutOctets: "1.3.6.1.2.1.31.1.1.1.10",
} as const;

const DEFAULT_TIMEOUT_MS = 1_500;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BACKOFF_MS = 150;
const DEFAULT_JITTER_MS = 100;
const DEFAULT_MAX_INTERFACES = 8;
const MAX_INTERFACES = 32;
const MAX_COUNTER64 = "18446744073709551615";

/**
 * Wave-8 (8-c F-2) — typed SNMP dial-plane failure. SNMP_POLL dials
 * profile.mgmtIp directly over UDP, so the resolved-address target policy
 * (R51-A1 parity with the SSH/WebAPI dial planes — the original sweep
 * covered those two only) refuses governed address classes with a typed
 * error BEFORE any vault/credential resolution or datagram. The message
 * discipline mirrors the target-policy refusals (code, class detail, the
 * "before any credential or connection work" clause).
 */
export class SnmpPollError extends Error {
  constructor(
    public readonly code:
      | "SNMP_TARGET_FORBIDDEN"
      | "SNMP_TARGET_UNRESOLVED"
      | "SNMP_TARGET_RESOLVE_TIMEOUT",
    message: string,
  ) {
    super(message);
    this.name = "SnmpPollError";
  }
}

export interface SnmpV3PollProfileReference {
  deviceId: string;
  hostname: string;
  mgmtIp: string;
  port: number;
  credentialProfileId: string;
  username: string;
  secretRef: string;
  engineIdHex: string;
  engineBoots: number | null;
  engineTime: number | null;
}

export type SnmpV3Transport = (
  host: string,
  port: number,
  packet: Uint8Array,
  timeoutMs: number,
) => Promise<Uint8Array>;

export interface SnmpV3PollOptions {
  timeoutMs?: number;
  retries?: number;
  retryBackoffMs?: number;
  jitterMs?: number;
  maxInterfaces?: number;
  interfaceIndexes?: number[];
  requestIdStart?: number;
  transport?: SnmpV3Transport;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface SnmpV3PollResult {
  polledAt: string;
  durationMs: number;
  requests: number;
  attempts: number;
  optionalFailures: number;
  engine: { engineIdHex: string; boots: number; time: number };
  system: {
    sysName: string | null;
    sysDescr: string | null;
    uptimeSeconds: number | null;
    uptimeTicks: number | null;
    interfaceCount: number | null;
  };
  interfaces: Array<{
    index: number;
    name: string;
    operStatus: "UP" | "DOWN" | "TESTING" | "DORMANT" | "NOT_PRESENT" | "LOWER_LAYER_DOWN" | "UNKNOWN";
    inOctets: string | null;
    outOctets: string | null;
  }>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function integerOption(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value)) throw new Error("SNMPv3 polling option must be an integer");
  return Math.min(max, Math.max(min, value));
}

function hexBytes(value: string): Uint8Array {
  const normalized = normalizeEngineIdHex(value);
  const output = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

function textValue(value: string | number | null, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function numberValue(value: string | number | null): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function counterValue(value: string | number | null): string | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    if (parsed < BigInt(0) || parsed > BigInt(MAX_COUNTER64)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function statusValue(value: string | number | null): SnmpV3PollResult["interfaces"][number]["operStatus"] {
  switch (numberValue(value)) {
    case 1: return "UP";
    case 2: return "DOWN";
    case 3: return "TESTING";
    case 5: return "DORMANT";
    case 6: return "NOT_PRESENT";
    case 7: return "LOWER_LAYER_DOWN";
    default: return "UNKNOWN";
  }
}

function indexesValue(input: number[] | undefined, max: number): number[] | null {
  if (input === undefined) return null;
  const seen = new Set<number>();
  const result: number[] = [];
  for (const index of input) {
    if (!Number.isSafeInteger(index) || index < 1 || index > 1_000_000) {
      throw new Error("SNMPv3 interface indexes must be integers from 1 to 1000000");
    }
    if (!seen.has(index)) {
      seen.add(index);
      result.push(index);
    }
    if (result.length >= max) break;
  }
  return result;
}

function udpRequest(host: string, port: number, packet: Uint8Array, timeoutMs: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const close = () => {
      if (timer) clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      close();
      callback();
    };
    socket.once("error", (error) => finish(() => reject(error)));
    socket.once("message", (message) => finish(() => resolve(new Uint8Array(message))));
    timer = setTimeout(() => finish(() => reject(new Error("SNMPv3 UDP response timeout"))), timeoutMs);
    socket.send(packet, port, host, (error) => {
      if (error) finish(() => reject(error));
    });
  });
}

async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    retries: number;
    retryBackoffMs: number;
    jitterMs: number;
    sleep: (ms: number) => Promise<void>;
    random: () => number;
  },
): Promise<{ value: T; attempts: number }> {
  let attempts = 0;
  let lastError: unknown;
  for (let retry = 0; retry <= options.retries; retry += 1) {
    attempts += 1;
    try {
      return { value: await operation(), attempts };
    } catch (error) {
      lastError = error;
      if (retry >= options.retries) break;
      const jitter = Math.floor(Math.min(1, Math.max(0, options.random())) * options.jitterMs);
      const backoff = Math.min(5_000, options.retryBackoffMs * 2 ** retry);
      await options.sleep(backoff + jitter);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("SNMPv3 request failed");
}

export function counterDelta(
  previous: string | number | null,
  current: string | number | null,
  bits = 64,
): { delta: string | null; reset: boolean } {
  if (!Number.isSafeInteger(bits) || bits < 8 || bits > 64) {
    throw new Error("counter width must be between 8 and 64 bits");
  }
  const parse = (value: string | number | null): bigint | null => {
    if (value === null) return null;
    if (typeof value === "number") {
      return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
    }
    if (!/^\d+$/.test(value)) return null;
    try { return BigInt(value); } catch { return null; }
  };
  const before = parse(previous);
  const after = parse(current);
  if (before === null || after === null) return { delta: null, reset: false };
  const modulus = BigInt(2) ** BigInt(bits);
  if (after >= before) return { delta: (after - before).toString(), reset: false };
  const high = (modulus * BigInt(3)) / BigInt(4);
  const low = modulus / BigInt(4);
  if (before >= high && after <= low) {
    return { delta: (modulus - before + after).toString(), reset: false };
  }
  return { delta: after.toString(), reset: true };
}

export async function pollSnmpV3(
  profile: SnmpV3PollProfileReference,
  options: SnmpV3PollOptions = {},
): Promise<SnmpV3PollResult> {
  if (isIP(profile.mgmtIp) !== 4) throw new Error("SNMPv3 polling requires an IPv4 management address");
  if (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65_535) {
    throw new Error("SNMPv3 polling port is outside 1..65535");
  }
  // Wave-8 (8-c F-2): the SNMP dial plane enforces the SAME resolved-address
  // target policy as every other live dial plane (guardDialTarget's policy
  // core, R51-A1). mgmtIp is a validated IPv4 literal, so the decision needs
  // no DNS I/O; loopback / link-local / multicast / reserved refuse
  // fail-closed BEFORE any vault resolution or socket activity, and the
  // documented FAYANMS_PROBE_ALLOW_SPECIAL lab hatch is honored unchanged.
  const dial = await resolveTargetForDial(profile.mgmtIp);
  if (!dial.decision.ok) {
    const code =
      dial.decision.code === "SSH_TARGET_POLICY_REFUSED"
        ? "SNMP_TARGET_FORBIDDEN"
        : dial.decision.code === "SSH_TARGET_UNRESOLVED"
          ? "SNMP_TARGET_UNRESOLVED"
          : "SNMP_TARGET_RESOLVE_TIMEOUT";
    throw new SnmpPollError(
      code,
      `${code}: ${dial.decision.detail} — the target network policy refuses this address class before any credential or connection work`,
    );
  }
  // The poll dials the VALIDATED address (identical to mgmtIp for a literal,
  // but the invariant stays structural: no dial of an unvalidated target).
  const dialHost: string = dial.decision.dialedAddress;
  const engineId = hexBytes(profile.engineIdHex);
  const secret = await resolveVaultSecret(profile.secretRef);
  const timeoutMs = integerOption(options.timeoutMs, DEFAULT_TIMEOUT_MS, 200, 10_000);
  const retries = integerOption(options.retries, DEFAULT_RETRIES, 0, 5);
  const retryBackoffMs = integerOption(options.retryBackoffMs, DEFAULT_RETRY_BACKOFF_MS, 0, 5_000);
  const jitterMs = integerOption(options.jitterMs, DEFAULT_JITTER_MS, 0, 2_000);
  const maxInterfaces = integerOption(options.maxInterfaces, DEFAULT_MAX_INTERFACES, 1, MAX_INTERFACES);
  const explicitIndexes = indexesValue(options.interfaceIndexes, maxInterfaces);
  const transport = options.transport ?? udpRequest;
  const sleepFn = options.sleep ?? delay;
  const randomFn = options.random ?? Math.random;
  const config = {
    engineId,
    username: profile.username,
    secret,
    boots: profile.engineBoots ?? 1,
    time: profile.engineTime ?? 1,
  };
  let nextRequestId = integerOption(options.requestIdStart, 1, 1, 2_000_000_000);
  let requestCount = 0;
  let attemptsTotal = 0;
  let optionalFailures = 0;
  let observed: { engineIdHex: string; boots: number; time: number } | null = null;

  const get = async (requestedOid: string): Promise<string | number | null> => {
    const requestId = nextRequestId;
    nextRequestId = nextRequestId >= 2_000_000_000 ? 1 : nextRequestId + 1;
    requestCount += 1;
    const packet = buildSnmpV3GetRequest({
      ...config,
      requestId,
      messageId: requestId,
      requestedOid,
    });
    const result = await withRetry(
      async () => {
        const responsePacket = await transport(dialHost, profile.port, packet, timeoutMs);
        const response = decodeSnmpV3GetResponse(responsePacket, config);
        if (response.requestId !== requestId || response.oid !== requestedOid) {
          throw new Error("SNMPv3 response did not match the request");
        }
        const identity = readSnmpV3UsmIdentity(responsePacket);
        const engineIdHex = normalizeEngineIdHex(identity.engineId);
        if (identity.username !== profile.username || engineIdHex !== profile.engineIdHex.toLowerCase()) {
          throw new Error("SNMPv3 response identity did not match the enrolled profile");
        }
        observed = { engineIdHex, boots: identity.boots, time: identity.time };
        return response.value;
      },
      { retries, retryBackoffMs, jitterMs, sleep: sleepFn, random: randomFn },
    );
    attemptsTotal += result.attempts;
    return result.value;
  };

  const optional = async (oid: string): Promise<string | number | null> => {
    try { return await get(oid); } catch { optionalFailures += 1; return null; }
  };

  const startedAt = Date.now();
  const sysDescr = textValue(await get(SNMP_POLL_OIDS.sysDescr), 512);
  const sysName = textValue(await get(SNMP_POLL_OIDS.sysName), 255);
  const uptimeTicks = numberValue(await get(SNMP_POLL_OIDS.sysUpTime));
  const interfaceCount = explicitIndexes === null ? numberValue(await get(SNMP_POLL_OIDS.ifNumber)) : null;
  const interfaceIndexes = explicitIndexes ??
    Array.from({ length: Math.min(Math.max(interfaceCount ?? 0, 0), maxInterfaces) }, (_, index) => index + 1);

  const interfaces: SnmpV3PollResult["interfaces"] = [];
  for (let offset = 0; offset < interfaceIndexes.length; offset += 4) {
    const batch = interfaceIndexes.slice(offset, offset + 4);
    const rows = await Promise.all(batch.map(async (index) => {
      const [description, status, inOctets, outOctets] = await Promise.all([
        optional(SNMP_POLL_OIDS.ifDescr + "." + index),
        optional(SNMP_POLL_OIDS.ifOperStatus + "." + index),
        optional(SNMP_POLL_OIDS.ifHCInOctets + "." + index),
        optional(SNMP_POLL_OIDS.ifHCOutOctets + "." + index),
      ]);
      const baseName = textValue(description, 255) ?? "if" + index;
      const name = interfaces.some((row) => row.name === baseName)
        ? baseName.slice(0, 240) + "#" + index
        : baseName;
      return {
        index,
        name,
        operStatus: statusValue(status),
        inOctets: counterValue(inOctets),
        outOctets: counterValue(outOctets),
      };
    }));
    interfaces.push(...rows);
  }

  if (!observed) throw new Error("SNMPv3 poll completed without a verified response identity");
  return {
    polledAt: new Date(startedAt).toISOString(),
    durationMs: Math.max(0, Date.now() - startedAt),
    requests: requestCount,
    attempts: attemptsTotal,
    optionalFailures,
    engine: observed,
    system: {
      sysName,
      sysDescr,
      uptimeSeconds: uptimeTicks === null ? null : Math.floor(uptimeTicks / 100),
      uptimeTicks,
      interfaceCount,
    },
    interfaces,
  };
}
