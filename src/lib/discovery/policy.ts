export const DISCOVERY_ALLOWED_PORTS = [22, 80, 443, 830] as const;
export const DISCOVERY_DEFAULT_INTERVAL_MINUTES = 60;
export const DISCOVERY_MAX_SUBNETS_PER_POLICY = 4;
export const DISCOVERY_MAX_TARGETS_PER_JOB = 1_024;

const IPV4_CIDR =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\/(\d|[12]\d|3[0-2])$/;

export interface DiscoveryPolicyConfig {
  subnets: string[];
  ports: number[];
  intervalMinutes: number;
  enabled: boolean;
}

export function discoveryTargetCount(cidr: string): number | null {
  const match = IPV4_CIDR.exec(cidr.trim());
  if (!match) return null;
  const prefix = Number(match[5]);
  if (prefix < 24) return null;
  const size = 2 ** (32 - prefix);
  return prefix >= 31 ? size : Math.max(0, size - 2);
}

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
