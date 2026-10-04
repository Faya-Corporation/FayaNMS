/**
 * F-038 — the discovery egress policy now MIRRORS the SSH/SNMP dial plane.
 *
 * The SSH dial plane refuses governed special-address classes (this-network,
 * loopback, link-local, multicast, reserved) BEFORE any network work
 * (src/lib/net/target-policy.ts, mirrored worker-side by
 * mini-services/worker/target-policy.ts) — but this module accepted ANY
 * /24-/32 CIDR unchecked, so an app-plane actor could aim the worker's
 * TCP-connect scanner at governed address classes the probe plane refuses.
 *
 * The closure: EVERY enumerated discovery target of every policy subnet is
 * classified with the app-plane classifier (evaluateTargetPolicy). A single
 * governed-denied target refuses the WHOLE config (fail-closed — an RRset
 * is one trust decision, not a menu — same doctrine as the worker's dial
 * resolution). FAYANMS_PROBE_ALLOW_SPECIAL=true is the documented lab
 * escape hatch, shared with the probe plane (the decision is never silent:
 * the accepted payload itself is the audited artifact).
 *
 * NOTE — RELATIVE import by deployment contract: this module is COPYed into
 * the self-contained worker image (Dockerfile.worker → /src/lib/discovery/
 * policy.ts) where the "@/" path alias does not exist, and the worker's
 * runner re-validates every job payload through normalizeDiscoveryPolicy
 * Config (the worker never trusts the app plane). The sibling classifier is
 * COPYed next to it (Dockerfile.worker → /src/lib/net/target-policy.ts);
 * tests/audit/open-findings-batch-13.test.ts pins the COPY pair.
 */

import { evaluateTargetPolicy } from "../net/target-policy";

export const DISCOVERY_ALLOWED_PORTS = [22, 80, 443, 830] as const;
export const DISCOVERY_DEFAULT_INTERVAL_MINUTES = 60;
export const DISCOVERY_MAX_SUBNETS_PER_POLICY = 4;
export const DISCOVERY_MAX_TARGETS_PER_JOB = 1_024;

const IPV4_CIDR =
  /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\/(\d|[12]\d|3[0-2])$/;

export interface DiscoveryPolicyConfig {
  subnets: string[];
  ports: number[];
  intervalMinutes: number;
  enabled: boolean;
}

export function discoveryTargetCount(cidr: string): number | null {
  const match = IPV4_CIDR.exec(cidr.trim());
  if (!match) return null;
  const prefix = Number(match[1]);
  if (prefix < 24) return null;
  const size = 2 ** (32 - prefix);
  return prefix >= 31 ? size : Math.max(0, size - 2);
}

/**
 * F-038 — enumerate the probeable host addresses of a /24-/32 block,
 * mirroring the worker's enumerateDiscoveryTargets semantics exactly
 * (mini-services/worker/discovery.ts): host set excludes network +
 * broadcast for prefix ≤ 30, spans the full block for /31-/32. The app
 * policy plane never imports the worker module (the worker is a
 * self-contained image), so the enumeration is mirrored here and pinned
 * for parity by tests/audit/open-findings-batch-13.test.ts. Returns null
 * for anything the worker enumerator would throw on.
 */
export function enumerateDiscoveryPolicyTargets(cidr: string): string[] | null {
  const match = IPV4_CIDR.exec(cidr.trim());
  if (!match) return null;
  // THIS module's regex uses NON-capturing octet groups — the prefix is
  // capture 1 (the worker module's CAPTURING regex indexes match[5]; the
  // copy-paste of that index here produced Number(undefined)=NaN, NaN<24
  // = false, and an EMPTY host set — a fail-OPEN gate, caught by the
  // batch-13 parity pin before it ever shipped).
  const prefix = Number(match[1]);
  if (!Number.isInteger(prefix) || prefix < 24 || prefix > 32) return null;

  const ipPart = match[0].split("/")[0] ?? "";
  const octets = ipPart.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  const base = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const hostBits = 32 - prefix;
  const size = 2 ** hostBits;
  const mask = (0xffffffff << hostBits) >>> 0;
  const network = (base & mask) >>> 0;
  const first = prefix >= 31 ? network : network + 1;
  const last = prefix >= 31 ? network + size - 1 : network + size - 2;
  const targets: string[] = [];
  for (let value = first; value <= last; value += 1) {
    targets.push(
      [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join("."),
    );
  }
  return targets;
}

export interface DiscoveryGovernedRefusal {
  subnet: string;
  addressClass: string;
}

/**
 * F-038 — the first subnet whose enumerated targets include a
 * governed-denied address (the route handlers use this to produce a
 * precise 400 detail instead of a generic policy message). Null when
 * every subnet classifies clean.
 */
export function firstGovernedDiscoverySubnet(
  subnets: string[],
): DiscoveryGovernedRefusal | null {
  for (const subnet of subnets) {
    const targets = enumerateDiscoveryPolicyTargets(subnet);
    if (!targets) continue; // shape errors are the generic INVALID_POLICY path
    for (const target of targets) {
      const decision = evaluateTargetPolicy(target);
      if (!decision.allowed) {
        return { subnet, addressClass: decision.addressClass };
      }
    }
  }
  return null;
}

const allowSpecialTargets = (): boolean =>
  process.env.FAYANMS_PROBE_ALLOW_SPECIAL === "true";

export function normalizeDiscoveryPolicyConfig(input: {
  subnets: unknown;
  ports?: unknown;
  intervalMinutes?: unknown;
  enabled?: unknown;
}): DiscoveryPolicyConfig | null {
  if (!Array.isArray(input.subnets) || input.subnets.length < 1 || input.subnets.length > DISCOVERY_MAX_SUBNETS_PER_POLICY) {
    return null;
  }
  const subnets = input.subnets.map((value) => typeof value === "string" ? value.trim() : "");
  if (subnets.some((subnet) => !subnet || discoveryTargetCount(subnet) === null)) return null;
  const totalTargets = subnets.reduce((sum, subnet) => sum + (discoveryTargetCount(subnet) ?? 0), 0);
  if (totalTargets > DISCOVERY_MAX_TARGETS_PER_JOB) return null;

  // F-038 — classify EVERY enumerated target of every subnet (bounded:
  // ≤ 1,024 targets per job). Per-target classification (not per-block)
  // keeps the gate exact under any future class-table change. Any
  // governed-denied target refuses the whole config unless the documented
  // lab hatch is set — mirroring the SSH/SNMP dial plane.
  if (!allowSpecialTargets()) {
    for (const subnet of subnets) {
      const targets = enumerateDiscoveryPolicyTargets(subnet);
      // Fail-closed: an empty enumeration can never prove a subnet clean.
      if (!targets || targets.length === 0) return null;
      for (const target of targets) {
        if (!evaluateTargetPolicy(target).allowed) return null;
      }
    }
  }

  const rawPorts = input.ports === undefined ? [...DISCOVERY_ALLOWED_PORTS] : input.ports;
  if (!Array.isArray(rawPorts) || rawPorts.length < 1 || rawPorts.length > DISCOVERY_ALLOWED_PORTS.length) {
    return null;
  }
  const ports = Array.from(new Set(rawPorts)).filter(
    (port): port is number =>
      typeof port === "number" &&
      Number.isInteger(port) &&
      DISCOVERY_ALLOWED_PORTS.includes(port as (typeof DISCOVERY_ALLOWED_PORTS)[number]),
  );
  if (ports.length !== rawPorts.length) return null;

  const intervalMinutes = input.intervalMinutes ?? DISCOVERY_DEFAULT_INTERVAL_MINUTES;
  if (
    typeof intervalMinutes !== "number" ||
    !Number.isInteger(intervalMinutes) ||
    intervalMinutes < 5 ||
    intervalMinutes > 1_440
  ) {
    return null;
  }
  const enabled = input.enabled ?? false;
  if (typeof enabled !== "boolean") return null;
  return { subnets, ports, intervalMinutes, enabled };
}

export function parseStoredDiscoveryPolicy(
  subnetsJson: string,
  portsJson: string,
  intervalMinutes: number,
  enabled: boolean,
): DiscoveryPolicyConfig | null {
  try {
    return normalizeDiscoveryPolicyConfig({
      subnets: JSON.parse(subnetsJson),
      ports: JSON.parse(portsJson),
      intervalMinutes,
      enabled,
    });
  } catch {
    return null;
  }
}
