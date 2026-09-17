/**
 * R50-T022 follow-up — worker-plane RESOLVED-ADDRESS target policy.
 *
 * The app-side policy (src/lib/net/target-policy.ts) classifies the
 * operator-typed LITERAL only — a HOSTNAME carries no address semantics
 * there BY DESIGN, so a name like `metadata.google.internal` would
 * otherwise dial a governed address class with no policy ever seeing the
 * address. The worker owns the dial (LIVE_SSH plane), so the worker owns
 * the resolved-address check:
 *
 *   IP literal      → classified directly (defense in depth: the worker
 *                     never trusts the app plane), then dialed verbatim;
 *   hostname        → bounded DNS resolution (R50-T025 budget) → EVERY
 *                     candidate address classified → ANY governed-denied
 *                     candidate refuses the WHOLE target (fail-closed —
 *                     no partial allowlists across an RRset) → the probe
 *                     dials the deterministic pick (A RRset numeric-
 *                     ascending first, mirroring the inventory's R50-T033
 *                     rule; AAAA-only targets dial the sorted first AAAA).
 *
 * Dialing the RESOLVED ADDRESS (not the name) also removes the classic
 * resolve-then-dial TOCTOU window: DNS rebinding between the policy check
 * and the connect is structurally impossible because no second lookup
 * happens — the address the policy validated is the address the SSH
 * client opens.
 *
 * SELF-CONTAINED by deployment contract: the worker image (Dockerfile.worker)
 * COPYs ONLY mini-services/worker/ — this module must not import from
 * src/. The classification tables therefore mirror the app module, and
 * tests/audit pins PARITY between the two over a shared corpus (drift
 * between the planes fails the build).
 *
 * Typed worker-plane error codes (mapped to contract codes in
 * src/lib/net/detection-contract.ts — WORKER_CODE_MAP):
 *   SSH_TARGET_POLICY_REFUSED    → TARGET_NOT_ALLOWED
 *   SSH_TARGET_UNRESOLVED        → DNS_NOT_FOUND
 *   SSH_TARGET_RESOLVE_TIMEOUT   → DNS_TIMEOUT
 */

import { resolve4, resolve6 } from "node:dns/promises";

export interface TargetPolicyDecision {
  allowed: boolean;
  /** The classification the address matched (informational, bounded). */
  addressClass: string;
}

/* ── classification tables (parity-pinned against the app module) ──────── */

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
  return { allowed, addressClass: match.cls };
}

/**
 * Classify ONE address literal. This is the worker-plane mirror of the
 * app module's evaluateTargetPolicy for literal inputs — the parity test
 * pins both over a shared corpus.
 */
export function classifyTargetAddress(address: string): TargetPolicyDecision {
  const target = (address ?? "").trim();
  if (target.includes(":")) {
    const v6 = target.split("%")[0].toLowerCase();
    const special = V6_SPECIALS.find((s) => s.test(v6));
    if (special) {
      const allowed = special.allowed || allowSpecial();
      return { allowed, addressClass: special.cls };
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
  // Not an address literal — callers never pass names here (the entry
  // point routes names to resolution first); classify honestly anyway.
  return { allowed: true, addressClass: "hostname" };
}

/* ── resolution + dial-target decision ─────────────────────────────────── */

const IPV4_LITERAL =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** Per-octet numeric compare so "10.0.0.2" sorts before "10.0.0.20". */
const compareIpv4 = (a: string, b: string): number => {
  const ao = a.split(".").map(Number);
  const bo = b.split(".").map(Number);
  for (let i = 0; i < 4; i += 1) {
    if (ao[i] !== bo[i]) return ao[i] - bo[i];
  }
  return 0;
};

/** Deterministic pick of an address RRset (numeric-ascending first). */
export const deterministicAddressPick = (records: string[]): string | null => {
  if (records.length === 0) return null;
  return [...records].sort(compareIpv4)[0];
};

export type WorkerResolveErrorCode =
  | "SSH_TARGET_POLICY_REFUSED"
  | "SSH_TARGET_UNRESOLVED"
  | "SSH_TARGET_RESOLVE_TIMEOUT";

export interface DialTargetAllowed {
  ok: true;
  /** The address the probe MUST dial (validated; no further DNS). */
  dialedAddress: string;
  /** "literal" (typed as an address) or "resolved" (name → address). */
  checked: "literal" | "resolved";
  /** The classification of the dialed address. */
  addressClass: string;
}

export interface DialTargetRefused {
  ok: false;
  /** Worker-plane typed code — mapped to a contract code app-side. */
  code: WorkerResolveErrorCode;
  /** Bounded human detail (class name or DNS error code — never raw). */
  detail: string;
}

export interface DialTarget {
  /** The worker policy decision for this target. */
  decision: DialTargetAllowed | DialTargetRefused;
  /** Audit evidence: every resolved candidate + its class (bounded). */
  candidates: Array<{ address: string; addressClass: string }>;
}

type ResolveFn = (host: string) => Promise<string[]>;

/** Default worker-side DNS budget (ms) — FAYANMS_WORKER_RESOLVE_TIMEOUT_MS. */
export const DEFAULT_WORKER_RESOLVE_BUDGET_MS = 5_000;

async function boundedResolve(
  lookup: ResolveFn,
  host: string,
  budgetMs: number,
): Promise<{ timedOut: boolean; errorCode: string | null; records: string[] }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<{ timedOut: boolean; errorCode: null; records: string[] }>(
    (resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true, errorCode: null, records: [] }), budgetMs);
    },
  );
  const lookupPromise = lookup(host)
    .then(
      (records): { timedOut: boolean; errorCode: null; records: string[] } =>
        ({ timedOut: false, errorCode: null, records: records ?? [] }),
    )
    .catch(
      (error: unknown): { timedOut: boolean; errorCode: string; records: string[] } => ({
        timedOut: false,
        errorCode:
          typeof error === "object" && error !== null && "code" in error
            ? String((error as { code?: unknown }).code)
            : "DNS_LOOKUP_FAILED",
        records: [],
      }),
    );
  try {
    return await Promise.race([lookupPromise, budget]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Decide WHAT the worker may dial for `host` (R50-T022 follow-up +
 * R50-T025 resolution budget). Literals classify with no I/O; names
 * resolve under the budget and are governed per-candidate (ANY denied
 * candidate refuses the whole name). `resolve4Fn`/`resolve6Fn` are
 * injectable for tests.
 */
export async function resolveTargetForDial(
  host: string,
  resolve4Fn: ResolveFn = resolve4,
  resolve6Fn: ResolveFn = resolve6,
  budgetMs: number = Number(process.env.FAYANMS_WORKER_RESOLVE_TIMEOUT_MS) > 0
    ? Number(process.env.FAYANMS_WORKER_RESOLVE_TIMEOUT_MS)
    : DEFAULT_WORKER_RESOLVE_BUDGET_MS,
): Promise<DialTarget> {
  const target = (host ?? "").trim();

  // IP literal (v4 or v6-shaped): classify directly, no DNS, dial verbatim.
  if (target.includes(":") || IPV4_LITERAL.test(target)) {
    const decision = classifyTargetAddress(target);
    return {
      decision: decision.allowed
        ? { ok: true, dialedAddress: target, checked: "literal", addressClass: decision.addressClass }
        : { ok: false, code: "SSH_TARGET_POLICY_REFUSED", detail: decision.addressClass },
      candidates: [{ address: target, addressClass: decision.addressClass }],
    };
  }

  // Hostname: bounded resolution of BOTH families; classify every
  // candidate — ANY governed-denied candidate refuses the whole name
  // (fail-closed; an RRset is one trust decision, not a menu).
  const candidates: DialTarget["candidates"] = [];
  const aResult = await boundedResolve(resolve4Fn, target, budgetMs);
  if (aResult.timedOut) {
    return {
      decision: { ok: false, code: "SSH_TARGET_RESOLVE_TIMEOUT", detail: "DNS_TIMEOUT" },
      candidates,
    };
  }
  const aRecords = aResult.errorCode === null ? aResult.records : [];
  for (const address of aRecords.slice(0, 16)) {
    if (!IPV4_LITERAL.test(address)) continue; // resolve4 answers are literals; guard anyway
    const cls = classifyTargetAddress(address);
    candidates.push({ address, addressClass: cls.addressClass });
    if (!cls.allowed) {
      return {
        decision: { ok: false, code: "SSH_TARGET_POLICY_REFUSED", detail: cls.addressClass },
        candidates,
      };
    }
  }
  const aPick = deterministicAddressPick(aRecords.filter((r) => IPV4_LITERAL.test(r)));
  if (aPick) {
    const pickClass =
      candidates.find((c) => c.address === aPick)?.addressClass ?? "public";
    return {
      decision: {
        ok: true,
        dialedAddress: aPick,
        checked: "resolved",
        addressClass: pickClass,
      },
      candidates,
    };
  }

  // No A answer: the AAAA set is the remaining dial family (the probe
  // plane is not the IPv4-only INVENTORY contract — but every candidate
  // is still policy-governed before any dial).
  const aaaaResult = await boundedResolve(resolve6Fn, target, budgetMs);
  if (aaaaResult.timedOut) {
    return {
      decision: { ok: false, code: "SSH_TARGET_RESOLVE_TIMEOUT", detail: "DNS_TIMEOUT" },
      candidates,
    };
  }
  const aaaaRecords = aaaaResult.errorCode === null ? aaaaResult.records : [];
  for (const address of aaaaRecords.slice(0, 16)) {
    const cls = classifyTargetAddress(address);
    candidates.push({ address, addressClass: cls.addressClass });
    if (!cls.allowed) {
      return {
        decision: { ok: false, code: "SSH_TARGET_POLICY_REFUSED", detail: cls.addressClass },
        candidates,
      };
    }
  }
  // AAAA dial pick: the FIRST record in resolver order (a per-octet
  // numeric sort is an IPv4 rule; v6 has no equivalent here — the honest
  // statement is resolver order, policy-governed like every candidate).
  const aaaaPick = aaaaRecords[0] ?? null;
  if (aaaaPick) {
    const cls = classifyTargetAddress(aaaaPick);
    return {
      decision: {
        ok: true,
        dialedAddress: aaaaPick,
        checked: "resolved",
        addressClass: cls.addressClass,
      },
      candidates,
    };
  }

  return {
    decision: {
      ok: false,
      code: "SSH_TARGET_UNRESOLVED",
      detail: aResult.errorCode ?? "EMPTY_ANSWER",
    },
    candidates,
  };
}
