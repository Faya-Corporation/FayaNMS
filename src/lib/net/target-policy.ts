/**
 * R50-T022/T023 — target network policy for ACTIVE device probes.
 *
 * The auto-detect probe (and any future active-probe surface) must not be
 * usable as a network-reconnaissance primitive from an authenticated
 * session: loopback, cloud-metadata link-local, multicast, broadcast and
 * reserved ranges are refused BEFORE any credential, trust-store, or
 * network work happens (route stage 2 — fail-closed, typed
 * TARGET_NOT_ALLOWED).
 *
 * Scope honesty (ADR-host-key-trust-identity §3): this is the LITERAL-form
 * policy — the operator-typed endpoint. A HOSTNAME target resolves on the
 * worker side when it dials, so resolved-address enforcement belongs to the
 * worker plane (roadmap R50-T022 follow-up); DNS health never feeds the
 * app-side trust path.
 *
 * Escape hatch for labs/simulators: FAYANMS_PROBE_ALLOW_SPECIAL=true
 * re-allows the special classes (the decision is still classified and
 * audited — never silent).
 */

export interface TargetPolicyDecision {
  allowed: boolean;
  /** The classification the literal matched (informational, bounded). */
  addressClass: string;
  /** Bounded denial reason (an address class name) when allowed=false. */
  reason?: string;
}

/** Parse a strict dotted-quad IPv4 into its 32-bit integer (null otherwise). */
function v4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** True when (ip & mask) === (network & mask). */
function inCidr4(ipInt: number, network: number, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ipInt & mask) >>> 0) === ((network & mask) >>> 0);
}

const int = (a: number, b: number, c: number, d: number): number =>
  ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;

interface V4Class {
  network: number;
  bits: number;
  cls: string;
  allowed: boolean;
}

/** R50-T023 — the governed special-address classes (IPv4). */
const V4_CLASSES: V4Class[] = [
  { network: int(0, 0, 0, 0), bits: 8, cls: "this-network", allowed: false },
  { network: int(10, 0, 0, 0), bits: 8, cls: "private", allowed: true },
  { network: int(100, 64, 0, 0), bits: 10, cls: "cgnat", allowed: true },
  { network: int(127, 0, 0, 0), bits: 8, cls: "loopback", allowed: false },
  { network: int(169, 254, 0, 0), bits: 16, cls: "link-local", allowed: false },
  { network: int(172, 16, 0, 0), bits: 12, cls: "private", allowed: true },
  { network: int(192, 168, 0, 0), bits: 16, cls: "private", allowed: true },
  { network: int(224, 0, 0, 0), bits: 4, cls: "multicast", allowed: false },
  { network: int(240, 0, 0, 0), bits: 4, cls: "reserved", allowed: false },
];

/** R50-T023 — governed IPv6 special classes (prefix match on the literal). */
const V6_SPECIALS: Array<{ test: (v: string) => boolean; cls: string; allowed: boolean }> = [
  { test: (v) => v === "::", cls: "unspecified", allowed: false },
  { test: (v) => v === "::1", cls: "loopback", allowed: false },
  { test: (v) => /^fe[89ab]/.test(v), cls: "link-local", allowed: false },
  { test: (v) => /^ff/.test(v), cls: "multicast", allowed: false },
];

const allowSpecial = (): boolean => process.env.FAYANMS_PROBE_ALLOW_SPECIAL === "true";

function classifyV4(ip: string): TargetPolicyDecision {
  const ipInt = v4ToInt(ip)!;
  const match = V4_CLASSES.find((c) => inCidr4(ipInt, c.network, c.bits));
  if (!match) {
    return { allowed: true, addressClass: "public" };
  }
  const allowed = match.allowed || allowSpecial();
  return {
    allowed,
    addressClass: match.cls,
    reason: allowed ? undefined : match.cls,
  };
}

/**
 * Evaluate the LITERAL target. Hostnames are allowed here by design
 * (they carry no address semantics; resolved-address policy is enforced
 * on the worker plane). IP literals in governed special classes are
 * refused unless the documented lab escape hatch is set.
 */
export function evaluateTargetPolicy(host: string): TargetPolicyDecision {
  const target = (host ?? "").trim();
  if (!target) {
    return { allowed: false, addressClass: "empty", reason: "empty" };
  }

  if (target.includes(":")) {
    // IPv6-ish literal (the request schema forbids ":" in hostnames).
    const v6 = target.split("%")[0].toLowerCase();
    const special = V6_SPECIALS.find((s) => s.test(v6));
    if (special) {
      return {
        allowed: allowSpecial(),
        addressClass: special.cls,
        reason: special.allowed ? undefined : special.cls,
      };
    }
    const mapped = v6.startsWith("::ffff:") ? v6.slice("::ffff:".length) : null;
    if (mapped && v4ToInt(mapped) !== null) {
      return classifyV4(mapped);
    }
    return { allowed: true, addressClass: "ipv6-global" };
  }

  if (v4ToInt(target) !== null) {
    return classifyV4(target);
  }
  return { allowed: true, addressClass: "hostname" };
}
