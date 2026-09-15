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
 * The store is resolved ONCE per process via the SCALE-001-A shared-rate
 * store abstraction (src/lib/api/rate-store.ts):
 *   - DEFAULT: bounded in-memory sliding window (dependency-free,
 *     zero-infra single-host). Known, documented limitation: per-process —
 *     a horizontally scaled app needs the shared store before the budgets
 *     mean anything fleet-wide.
 *   - OPT-IN (FAYANMS_RATE_STORE=postgres): PostgreSQL-backed shared store
 *     (per-key advisory-lock-serialized transactions) so horizontally scaled
 *     instances draw from ONE budget; an unreachable store fails CLOSED
 *     (documented decision — it is the same DB the app already needs).
 * This remains a hardening gate, not an abuse-proof quota.
 */

import { createHash } from "node:crypto";

import { getRateStore } from "@/lib/api/rate-store";

export const RATE_WINDOW_MS = 60_000;
export const RATE_LIMIT_GET = 300;
export const RATE_LIMIT_MUTATION = 120;
export const MAX_RATE_BUCKETS = 5_000;
const MAX_KEY_TOKEN_LENGTH = 64;
const KEY_TOKEN_PATTERN = /^[0-9A-Za-z:.[\]\-_]+$/;

export type RateKind = "get" | "mutation";

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
 * Consume one slot for `${ip}:${kind}` against the ACTIVE store (in-memory
 * default; PostgreSQL when FAYANMS_RATE_STORE=postgres — see rate-store.ts).
 * Returns the retry window when the budget for the current sliding window is
 * exhausted. `nowMs` is injectable for deterministic tests; production
 * callers omit it (Date.now()).
 */
export async function takeRateSlot(
  ip: string,
  kind: RateKind,
  nowMs: number = Date.now()
): Promise<RateDecision> {
  const limit = kind === "get" ? RATE_LIMIT_GET : RATE_LIMIT_MUTATION;
  const hit = await getRateStore().hit(`${ip}:${kind}`, limit, RATE_WINDOW_MS, nowMs);
  return { limited: !hit.allowed, retryAfterSec: hit.retryAfterSec };
}

/** Test seam — drop every recorded hit on the active store. */
export async function resetRateStoreForTests(): Promise<void> {
  await getRateStore().resetForTests?.();
}

/** Test seam — live bucket count (bounded-sweep pins; in-memory store only). */
export function storeSizeForTests(): number {
  const store = getRateStore() as unknown as { sizeForTests?: number };
  return store.sizeForTests ?? 0;
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
