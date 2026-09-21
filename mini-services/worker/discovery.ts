/**
 * Bounded, unauthenticated discovery probes.
 *
 * This module deliberately reports only wire-derived reachability evidence:
 * approved TCP management ports and reverse-DNS names. It never guesses a
 * vendor, reads a credential, opens a listener, or treats a timeout as a
 * device. SNMP identity and vendor claims require a separate authenticated
 * workflow.
 */

import { reverse } from "node:dns/promises";
import { createConnection } from "node:net";

export const MAX_DISCOVERY_TARGETS_PER_SUBNET = 256;
export const MAX_DISCOVERY_TARGETS = 1024;
export const DEFAULT_DISCOVERY_PORTS = [22, 80, 443, 830] as const;

const IPV4_CIDR =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\/(\d|[12]\d|3[0-2])$/;

export interface DiscoveryProbeResult {
  ip: string;
  hostname: string;
  reachable: boolean;
  openPorts: number[];
}

export interface DiscoveryCandidate {
  ip: string;
  hostname: string;
  vendorGuess: "generic";
  mgmtPort?: number;
  protocols: string[];
  confidence: number;
  osFingerprint: "Unauthenticated TCP reachability";
  discoveredAt: string;
}

export interface DiscoveryScanResult {
  subnet: string;
  targetsScanned: number;
  candidates: DiscoveryCandidate[];
}

export interface DiscoveryScanOptions {
  ports?: readonly number[];
  timeoutMs?: number;
  concurrency?: number;
  onProgress?: (completed: number, total: number) => void | Promise<void>;
}

function ipv4ToInt(octets: readonly number[]): number {
  return (
    ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>>
    0
  );
}

function intToIpv4(value: number): string {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join(".");
}

export function enumerateDiscoveryTargets(
  cidr: string,
  maxTargets = MAX_DISCOVERY_TARGETS_PER_SUBNET,
): string[] {
  const match = IPV4_CIDR.exec(cidr.trim());
  if (!match) {
    throw new Error("Invalid subnet \"" + cidr + "\" — expected IPv4 CIDR");
  }

  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (prefix < 24) {
    throw new Error("Discovery requires a /24-/32 subnet; received " + cidr);
  }

  const base = ipv4ToInt(octets);
  const hostBits = 32 - prefix;
  const size = 2 ** hostBits;
  if (size > maxTargets) {
    throw new Error("Discovery target limit exceeded for " + cidr);
  }

  const mask = prefix === 0 ? 0 : (0xffffffff << hostBits) >>> 0;
  const network = base & mask;
  const first = prefix >= 31 ? network : network + 1;
  const last = prefix >= 31 ? network + size - 1 : network + size - 2;
  const targets: string[] = [];
  for (let value = first; value <= last; value += 1) {
    targets.push(intToIpv4(value >>> 0));
  }
  return targets;
}

function probeTcpPort(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let socket: ReturnType<typeof createConnection>;
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };

    try {
      socket = createConnection({ host: ip, port });
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(timeoutMs, () => finish(false));
    } catch {
      resolve(false);
    }
  });
}

async function reverseDns(ip: string, timeoutMs: number): Promise<string | null> {
  try {
    const names = await Promise.race([
      reverse(ip),
      new Promise<string[]>((resolve) => setTimeout(() => resolve([]), timeoutMs)),
    ]);
    return names[0]?.slice(0, 255) ?? null;
  } catch {
    return null;
  }
}

function protocolForPort(port: number): string {
  switch (port) {
    case 22:
      return "ssh";
    case 80:
      return "http";
    case 443:
      return "https";
    case 830:
      return "netconf";
    default:
      return "tcp/" + port;
  }
}

export async function probeDiscoveryTarget(
  ip: string,
  options: DiscoveryScanOptions = {},
): Promise<DiscoveryProbeResult> {
  const ports = Array.from(
    new Set(options.ports ?? DEFAULT_DISCOVERY_PORTS),
  ).filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535);
  if (ports.length === 0) throw new Error("Discovery requires at least one TCP port");
  const timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? 350, 2_000));
  const statuses = await Promise.all(
    ports.map((port) => probeTcpPort(ip, port, timeoutMs)),
  );
  const openPorts: number[] = [];
  for (const [index, isOpen] of statuses.entries()) {
    if (isOpen) openPorts.push(ports[index]);
  }
  const hostname = openPorts.length > 0
    ? (await reverseDns(ip, timeoutMs)) ?? ip
    : ip;
  return {
    ip,
    hostname,
    reachable: openPorts.length > 0,
    openPorts,
  };
}

export async function scanDiscoverySubnet(
  cidr: string,
  options: DiscoveryScanOptions = {},
): Promise<DiscoveryScanResult> {
  const targets = enumerateDiscoveryTargets(cidr);
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? 64, targets.length || 1, 128),
  );
  const candidates: DiscoveryCandidate[] = [];
  let nextIndex = 0;
  let completed = 0;

  const worker = async () => {
    while (nextIndex < targets.length) {
      const targetIndex = nextIndex;
      nextIndex += 1;
      const result = await probeDiscoveryTarget(targets[targetIndex], options);
      if (result.reachable) {
        candidates.push({
          ip: result.ip,
          hostname: result.hostname,
          vendorGuess: "generic",
          mgmtPort: result.openPorts[0],
          protocols: result.openPorts.map(protocolForPort),
          confidence: Math.min(90, 35 + result.openPorts.length * 12),
          osFingerprint: "Unauthenticated TCP reachability",
          discoveredAt: new Date().toISOString(),
        });
      }
      completed += 1;
      if (
        options.onProgress &&
        (completed === targets.length || completed % 16 === 0)
      ) {
        await options.onProgress(completed, targets.length);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  candidates.sort((a, b) => {
    const left = a.ip.split(".").map(Number);
    const right = b.ip.split(".").map(Number);
    return ipv4ToInt(left) - ipv4ToInt(right);
  });
  return { subnet: cidr, targetsScanned: targets.length, candidates };
}
