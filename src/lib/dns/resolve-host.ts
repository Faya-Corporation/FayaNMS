import { resolve4, resolve6 } from "node:dns/promises";

/**
 * Hostname → management-IP resolution (R50) — "map hostname to management
 * address" half of the auto-detect feature.
 *
 * Typing: never throws — a failed (or refused) resolution is a RESULT
 * carrying the reason, because detection must still be able to reach a
 * target BY HOSTNAME (SSH does not need the IP) even when the inventory
 * mapping cannot be produced. Callers decide whether that blocks their
 * flow.
 *
 * R50-T030/T031 — MANAGEMENT ADDRESS POLICY (ADR-management-address-policy):
 * Device.mgmtIp is IPv4-ONLY. Every validated inventory surface (device
 * create/update, the form sheet, CSV import UI + API) and the IPv4-CIDR
 * discovery scanner enforce IPv4, so a AAAA/IPv6 value here could never be
 * submitted — the old A→AAAA fallback + IPv6-literal passthrough produced a
 * guaranteed submit error fed by the feature's own success path (audit
 * finding R50-004). The resolver now REFUSES both with the typed
 * IPV6_MANAGEMENT_ADDRESS_UNSUPPORTED result instead of a misleading
 * success. Detection itself is unaffected: probes dial the requested
 * endpoint directly and never consult this mapping.
 *
 * R50-T033 — deterministic selection: a multi-address A RRset resolves to
 * the numeric-ASCENDING first address, so the inventory lands on the SAME
 * address on every lookup regardless of resolver RR rotation (a management
 * address is a stable inventory identifier, not a load-balancing handle).
 */

/** Typed refusal code (R50-T031) surfaced in responses, audits, and the UI. */
export const IPV6_MANAGEMENT_ADDRESS_UNSUPPORTED = "IPV6_MANAGEMENT_ADDRESS_UNSUPPORTED";

export type HostResolutionMode =
  /** IPv4 literal, or the deterministic pick of the A RRset. */
  | "ip-literal"
  | "dns-a"
  /** Input was an IPv6 literal — refused by the IPv4-only inventory policy. */
  | "refused-ipv6-literal"
  /** The host publishes ONLY AAAA records — refused by the same policy. */
  | "refused-aaaa-only"
  /** No mapping could be produced (DNS failure / empty answers). */
  | "failed";

export interface HostResolution {
  /** Resolved address, or null when refused/failed. */
  mgmtIp: string | null;
  /** How the address was obtained (or why it was not). */
  mode: HostResolutionMode;
  /** DNS error code (ENOTFOUND, EAI_AGAIN, …), the typed
   *  IPV6_MANAGEMENT_ADDRESS_UNSUPPORTED refusal, or EMPTY_HOST /
   *  EMPTY_ANSWER when mode === "failed" | "refused-*". */
  resolutionError?: string;
}

const IPV4_LITERAL =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** An IPv6 literal (or anything colon-shaped — hostnames never contain ":"). */
const hasColon = (host: string): boolean => host.includes(":");

/** Per-octet numeric compare so "10.0.0.2" sorts before "10.0.0.20". */
const compareIpv4 = (a: string, b: string): number => {
  const ao = a.split(".").map(Number);
  const bo = b.split(".").map(Number);
  for (let i = 0; i < 4; i += 1) {
    if (ao[i] !== bo[i]) return ao[i] - bo[i];
  }
  return 0;
};

/** R50-T033: deterministic pick of the A RRset — numeric-ascending first. */
export const deterministicIpv4Pick = (records: string[]): string | null => {
  const valid = records.filter((r) => IPV4_LITERAL.test(r));
  if (valid.length === 0) return null;
  return [...valid].sort(compareIpv4)[0];
};

/**
 * Structural lookup contracts so tests inject plain fakes without casts:
 * the real node:dns/promises resolve4/resolve6 are assignable (their full
 * overloads accept the narrower call used here).
 */
type Resolve4Fn = (host: string) => Promise<string[]>;
type Resolve6Fn = (host: string) => Promise<string[]>;

/** Drain the DNS error code from a thrown value without ever rethrowing. */
const codeOf = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String((error as { code?: unknown }).code);
  }
  return "DNS_LOOKUP_FAILED";
};

/**
 * Resolve `host` to a management address under the IPv4-only policy:
 *   - IPv4 literal         → passthrough ("ip-literal");
 *   - IPv6 literal         → "refused-ipv6-literal" (typed, pre-DNS);
 *   - hostname             → A RRset → deterministic pick ("dns-a");
 *   - no A answer          → AAAA diagnostic: AAAA-only → typed refusal,
 *                            otherwise "failed" with the A-query error code.
 * `resolve4Fn`/`resolve6Fn` are injectable for tests.
 */
export async function resolveHostToIp(
  host: string,
  resolve4Fn: Resolve4Fn = resolve4,
  resolve6Fn: Resolve6Fn = resolve6,
): Promise<HostResolution> {
  const target = host.trim();
  if (!target) {
    return { mgmtIp: null, mode: "failed", resolutionError: "EMPTY_HOST" };
  }
  if (IPV4_LITERAL.test(target)) {
    return { mgmtIp: target, mode: "ip-literal" };
  }
  if (hasColon(target)) {
    return {
      mgmtIp: null,
      mode: "refused-ipv6-literal",
      resolutionError: IPV6_MANAGEMENT_ADDRESS_UNSUPPORTED,
    };
  }

  let aError = "EMPTY_ANSWER";
  try {
    const records = await resolve4Fn(target);
    const picked = deterministicIpv4Pick(records ?? []);
    if (picked) {
      return { mgmtIp: picked, mode: "dns-a" };
    }
  } catch (error) {
    aError = codeOf(error);
  }

  // Honest diagnostic: distinguish "host exists but is IPv6-only" from
  // "host does not resolve" — the former gets the typed policy refusal.
  try {
    const aaaa = await resolve6Fn(target);
    if (aaaa && aaaa.length > 0) {
      return {
        mgmtIp: null,
        mode: "refused-aaaa-only",
        resolutionError: IPV6_MANAGEMENT_ADDRESS_UNSUPPORTED,
      };
    }
  } catch {
    // The AAAA probe is diagnostic only — the A-query failure is the
    // operator-facing truth when neither family answers.
  }
  return { mgmtIp: null, mode: "failed", resolutionError: aError };
}
