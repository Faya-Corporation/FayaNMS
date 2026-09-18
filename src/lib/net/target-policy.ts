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
 * R61 P0 — canonicalization-safe IPv6 classification. The previous
 * TEXTUAL rules (`v === "::1"`, `v.startsWith("::ffff:")`) missed
 * equivalent EXPANDED forms (`0:0:0:0:0:0:0:1`, `0:0:0:0:0:ffff:a01:101`),
 * letting them fall through as allowed `ipv6-global` (independent
 * re-verification 2026-09-19, P0). The rules now parse the literal into
 * its eight 16-bit groups (handling `::` compression, uppercase, and the
 * embedded dotted-quad tail) and classify on the GROUP VALUES — every
 * textual representation of the same address collapses to the same
 * decision. Unparsable IPv6-ish literals fail CLOSED (refused as
 * malformed) instead of silently riding the global allow.
 */
function ipv6ToGroups(text: string): number[] | null {
  let head = text;
  let tail: [number, number] | null = null;
  // Embedded IPv4 dotted-quad tail (::ffff:1.2.3.4 and friends) → two groups.
  const v4Tail = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (v4Tail) {
    const v4 = v4ToInt(v4Tail[2]);
    if (v4 === null) return null;
    tail = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    // The captured head keeps its trailing ":" (the tail's separator) —
    // strip it so the group split below sees clean groups ("::ffff:" →
    // "::ffff" → halves ["", "ffff"]).
    head = v4Tail[1].replace(/:$/, "");
  }
  const halves = head.split("::");
  if (halves.length > 2) return null; // more than one "::"
  const parseGroup = (s: string): number | null =>
    /^[0-9a-f]{1,4}$/.test(s) ? parseInt(s, 16) : null;
  const left = halves[0] === "" ? [] : halves[0].split(":");
  const right = halves.length === 2 ? (halves[1] === "" ? [] : halves[1].split(":")) : [];
  const groups: number[] = [];
  for (const part of left) {
    const g = parseGroup(part);
    if (g === null) return null;
    groups.push(g);
  }
  if (halves.length === 2) {
    const rightGroups: number[] = [];
    for (const part of right) {
      const g = parseGroup(part);
      if (g === null) return null;
      rightGroups.push(g);
    }
    const fill = 8 - groups.length - rightGroups.length - (tail ? 2 : 0);
    if (fill < 0) return null;
    for (let i = 0; i < fill; i += 1) groups.push(0);
    groups.push(...rightGroups);
  } else {
    for (const part of right) {
      const g = parseGroup(part);
      if (g === null) return null;
      groups.push(g);
    }
  }
  if (tail) {
    groups.push(tail[0], tail[1]);
  }
  return groups.length === 8 ? groups : null;
}

function classifyV6Canonical(v6: string): TargetPolicyDecision {
  const groups = ipv6ToGroups(v6);
  if (!groups) {
    // Unparsable IPv6-ish literal → fail closed (never ride the global allow).
    return { allowed: false, addressClass: "malformed", reason: "malformed" };
  }
  const allZero = groups.every((g) => g === 0);
  if (allZero) {
    return { allowed: allowSpecial(), addressClass: "unspecified", reason: allowSpecial() ? undefined : "unspecified" };
  }
  // ::1 loopback — every textual form (compressed, expanded, leading zeros).
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) {
    return { allowed: allowSpecial(), addressClass: "loopback", reason: allowSpecial() ? undefined : "loopback" };
  }
  // IPv4-mapped ::ffff:0:0/96 — the EMBEDDED v4 address classifies under
  // the v4 rules (both dotted-tail and hex forms reach here identically).
  if (
    groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff
  ) {
    return classifyV4(`${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`);
  }
  // fe80::/10 link-local (canonical group math, not a textual prefix).
  if ((groups[0] & 0xffc0) === 0xfe80) {
    return { allowed: allowSpecial(), addressClass: "link-local", reason: allowSpecial() ? undefined : "link-local" };
  }
  // ff00::/8 multicast.
  if ((groups[0] & 0xff00) === 0xff00) {
    return { allowed: allowSpecial(), addressClass: "multicast", reason: allowSpecial() ? undefined : "multicast" };
  }
  return { allowed: true, addressClass: "ipv6-global" };
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
    return classifyV6Canonical(v6);
  }

  if (v4ToInt(target) !== null) {
    return classifyV4(target);
  }
  return { allowed: true, addressClass: "hostname" };
}
