/**
 * API rate gate (SAFE-002 — external ULTRA audit P0-002 remediation).
 *
 * HISTORY OF THE DEFECT: rate limiting used to run inside the response
 * builders (ok()/fail()/failWithDetail()) — i.e. AFTER a handler had
 * already committed its side effects. A rate-limited mutation therefore
 * still executed, answered 429, and invited a retry that duplicated the
 * committed effect. The client-IP also came from the FIRST entry of
 * X-Forwarded-For, a header fully controlled by the caller, so rotating
 * that header minted a fresh budget per request (complete bypass).
 *
 * THE FIX: gating moved BEFORE handler execution. The proxy gate
 * (src/proxy.ts) consults this module for every /api/v1 request before
 * any route handler runs, and the response builders no longer consume
 * slots at all. Client-IP resolution uses a rightmost-trusted-hop policy:
 * the deployment's own reverse proxy APPENDS the real client address to
 * X-Forwarded-For, so the entry N hops from the RIGHT is the attacker-
 * resistant value; leftmost entries are attacker-controlled garbage.
 *
 * Client-IP policy (resolveClientIp):
 *   1. Split X-Forwarded-For on commas, trim, drop empties.
 *   2. trustedHops = clamp(FAYANMS_TRUST_PROXY_HOPS, 0..8), default 1
 *      (compose/sandbox: exactly one proxy — Caddy — in front of the app).
 *   3. trustedHops = 0 → trust nothing: both XFF and X-Real-IP are then
 *      forgeable, so every caller shares the conservative "local" bucket
 *      (an attacker can annoy other users of the same bucket but can
 *      never bypass the budget). Deployments MUST set the value to their
 *      real proxy depth.
 *   4. Otherwise client = xff[xff.length - trustedHops] (leftmost when
 *      the chain is shorter than configured). Fallback X-Real-IP.
 *   5. The chosen token is sanitized (length cap + charset) so absurd
 *      header values cannot inflate bucket keys; unparseable values are
 *      collapsed to a stable "opaque:<sha256[:16]>" key.
 *
 * The store is a bounded in-memory sliding window (dependency-free).
 * Known, documented limitation: per-process — a horizontally scaled app
 * needs a shared store (Redis) before the budgets mean anything fleet-
 * wide. This is a hardening gate, not an abuse-proof quota.
 */

import { createHash } from "node:crypto";

export const RATE_WINDOW_MS = 60_000;
export const RATE_LIMIT_GET = 300;
export const RATE_LIMIT_MUTATION = 120;
export const MAX_RATE_BUCKETS = 5_000;
const MAX_KEY_TOKEN_LENGTH = 64;
const KEY_TOKEN_PATTERN = /^[0-9A-Za-z:.[\]\-_]+$/;

export type RateKind = "get" | "mutation";

/** Sliding-window store: `${ip}:${kind}` → recent hit timestamps. */
const rateBuckets = new Map<string, number[]>();

/** Clamp-parse FAYANMS_TRUST_PROXY_HOPS (default 1, range 0..8). */
export function getTrustedProxyHops(): number {
  const raw = process.env.FAYANMS_TRUST_PROXY_HOPS?.trim();
  if (raw === undefined || raw === "") return 1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(8, Math.max(0, Math.floor(parsed)));
}

/** GET/HEAD share the read budget; everything else (and unknown) mutates. */
export function rateKind(method: string): RateKind {
  const normalized = method.toUpperCase();
  if (normalized === "GET" || normalized === "HEAD") return "get";
  // Fail closed: any method that could not be stated gets the stricter
  // mutation budget.
  return "mutation";
}

function sanitizeKeyToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length === 0) return "local";
  if (trimmed.length <= MAX_KEY_TOKEN_LENGTH && KEY_TOKEN_PATTERN.test(trimmed)) {
    return trimmed;
  }
  const digest = createHash("sha256").update(trimmed).digest("hex").slice(0, 16);
  return `opaque:${digest}`;
}

/**
 * Spoof-resistant client key from request headers (the proxy's own view —
 * never trust the leftmost XFF entry; see the module contract above).
 */
export function resolveClientIp(headers: Headers): string {
  const hops = getTrustedProxyHops();
  if (hops === 0) return "local";

  const xff = headers.get("x-forwarded-for");
  if (xff !== null && xff.trim() !== "") {
    const entries = xff
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (entries.length > 0) {
      const index = Math.max(0, entries.length - hops);
      return sanitizeKeyToken(entries[index]);
    }
  }

  const realIp = headers.get("x-real-ip");
  if (realIp !== null && realIp.trim() !== "") {
    return sanitizeKeyToken(realIp);
  }

  // No proxy headers at all — direct access (dev, health checks, loopback).
  return "local";
}

export interface RateDecision {
  limited: boolean;
  retryAfterSec: number;
}

/**
 * Consume one slot for `${ip}:${kind}`. Returns the retry window when the
 * budget for the current sliding window is exhausted. `nowMs` is injectable
 * for deterministic tests; production callers omit it (Date.now()).
 */
export function takeRateSlot(
  ip: string,
  kind: RateKind,
  nowMs: number = Date.now()
): RateDecision {
  const now = nowMs;
  const key = `${ip}:${kind}`;
  const limit = kind === "get" ? RATE_LIMIT_GET : RATE_LIMIT_MUTATION;

  // Bounded map: sweep stale keys once the bucket count grows past the cap.
  if (rateBuckets.size > MAX_RATE_BUCKETS) {
    for (const [bucketKey, stamps] of rateBuckets) {
      const newest = stamps[stamps.length - 1];
      if (newest === undefined || now - newest > RATE_WINDOW_MS) {
        rateBuckets.delete(bucketKey);
      }
      if (rateBuckets.size <= MAX_RATE_BUCKETS / 2) break;
    }
  }

  const stamps = (rateBuckets.get(key) ?? []).filter(
    (stamp) => now - stamp < RATE_WINDOW_MS
  );

  if (stamps.length >= limit) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((stamps[0] + RATE_WINDOW_MS - now) / 1000)
    );
    rateBuckets.set(key, stamps);
    return { limited: true, retryAfterSec };
  }

  stamps.push(now);
  rateBuckets.set(key, stamps);
  return { limited: false, retryAfterSec: 0 };
}

/** Test seam — drop every bucket (never used in request paths). */
export function resetRateStoreForTests(): void {
  rateBuckets.clear();
}

/** Test seam — live bucket count (for the bounded-map sweep assertion). */
export function storeSizeForTests(): number {
  return rateBuckets.size;
}

/** 429 envelope body — identical shape to the app's standard error envelope. */
export function rateLimitedBody(retryAfterSec: number, requestId: string): {
  success: false;
  error: { code: "RATE_LIMITED"; message: string };
  meta: { requestId: string };
} {
  return {
    success: false as const,
    error: {
      code: "RATE_LIMITED" as const,
      message: `Too many requests — retry in ${retryAfterSec}s.`,
    },
    meta: { requestId },
  };
}

/** Headers for the 429 envelope response. */
export function rateLimitedHeaders(
  retryAfterSec: number,
  requestId: string
): Record<string, string> {
  return {
    "X-Request-Id": requestId,
    "Retry-After": String(retryAfterSec),
  };
}
