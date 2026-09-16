import { lookup } from "node:dns/promises";

/**
 * Hostname → management-IP resolution (R50) — "map hostname to management
 * address" half of the auto-detect feature.
 *
 * Typing: never throws — a failed resolution is a RESULT ("failed") carrying
 * the DNS error code, because detection must still be able to reach a target
 * BY HOSTNAME (SSH does not need the IP) even when the resolver cannot map
 * it. Callers decide whether a failed mapping blocks their flow.
 */

export type HostResolutionMode = "ip-literal" | "dns-a" | "dns-aaaa" | "failed";

export interface HostResolution {
  /** Resolved address, or null when resolution failed. */
  mgmtIp: string | null;
  /** How the address was obtained (or why it was not). */
  mode: HostResolutionMode;
  /** DNS error code (ENOTFOUND, EAI_AGAIN, …) when mode === "failed". */
  resolutionError?: string;
}

const IPV4_LITERAL =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** An IPv6 literal (or anything colon-shaped — hostnames never contain ":"). */
const hasColon = (host: string): boolean => host.includes(":");

/**
 * Structural lookup contract so tests inject plain fakes without casts:
 * the real node:dns/promises lookup is assignable to this (it accepts the
 * wider LookupOptions and returns LookupAddress, both supersets).
 */
type LookupFn = (
  host: string,
  options: { family: number },
) => Promise<{ address: string; family: number }>;

/**
 * Resolve `host` to a management address:
 *   - IPv4/IPv6 literal  → passthrough ("ip-literal");
 *   - hostname           → DNS A record, falling back to AAAA;
 *   - resolver failure   → "failed" + the DNS error code.
 * `lookupFn` is injectable for tests.
 */
export async function resolveHostToIp(
  host: string,
  lookupFn: LookupFn = lookup,
): Promise<HostResolution> {
  const target = host.trim();
  if (!target) {
    return { mgmtIp: null, mode: "failed", resolutionError: "EMPTY_HOST" };
  }
  if (IPV4_LITERAL.test(target)) {
    return { mgmtIp: target, mode: "ip-literal" };
  }
  if (hasColon(target)) {
    return { mgmtIp: target, mode: "ip-literal" };
  }
  try {
    const result = await lookupFn(target, { family: 4 });
    if (result?.address) {
      return { mgmtIp: result.address, mode: "dns-a" };
    }
  } catch {
    // fall through to AAAA
  }
  try {
    const result = await lookupFn(target, { family: 6 });
    if (result?.address) {
      return { mgmtIp: result.address, mode: "dns-aaaa" };
    }
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "DNS_LOOKUP_FAILED";
    return { mgmtIp: null, mode: "failed", resolutionError: code };
  }
  // A successful-but-empty AAAA answer is still a failure to map.
  return { mgmtIp: null, mode: "failed", resolutionError: "EMPTY_ANSWER" };
}
