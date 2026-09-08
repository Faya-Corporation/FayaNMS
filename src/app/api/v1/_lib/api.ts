import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { randomUUID } from "node:crypto";
import { z } from "zod";

/**
 * Shared helpers for /api/v1 route handlers.
 *
 * Every endpoint answers with the standard JSON envelope:
 *   success: { success: true, data: T, meta?: {...} }
 *   error:   { success: false, error: { code, message } }
 *
 * List endpoints use server-side pagination and return
 * meta: { page, pageSize, total, totalPages }.
 *
 * API GOVERNANCE (Task 7-b — inherited by every route through ok()/fail()):
 *   - X-Request-Id header on every response (crypto.randomUUID), also echoed
 *     as `requestId` in the envelope meta.
 *   - In-memory sliding-window rate limiting per request-IP
 *     (Map<string, number[]>): 300 req/min for GET/HEAD, 120 req/min for
 *     mutations (unknown method → the stricter mutation budget). When the
 *     window is exceeded the response becomes
 *     429 { error: { code: "RATE_LIMITED" } } with a Retry-After header.
 *     The window Map is bounded (stale-key sweep) and dependency-free.
 *
 * Routes that hold the Request object should pass `{ method }` via
 * `requestContext(request)` as the last ok()/fail() argument so the correct
 * budget applies (legacy call sites fall back to headers()-derived IP and
 * the stricter budget).
 */

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/* ───────────────────────── governance core ───────────────────────── */

/** Optional per-call request context — lets a route state its HTTP method. */
export interface RequestContext {
  method?: string;
  ip?: string;
}

/** Build the context from the handler's Request (sync — no await needed). */
export function requestContext(request: Request): RequestContext {
  const ip =
    (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() ||
    request.headers.get("x-real-ip") ||
    undefined;
  return { method: request.method, ip };
}

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_GET = 300;
const RATE_LIMIT_MUTATION = 120;
const MAX_RATE_BUCKETS = 5_000;

type RateKind = "get" | "mutation";

const rateBuckets = new Map<string, number[]>();

function rateKind(method?: string): RateKind {
  const normalized = (method ?? "").toUpperCase();
  if (normalized === "GET" || normalized === "HEAD") return "get";
  // Mutations — and any call site that could not state its method — get the
  // stricter budget (fail closed).
  return "mutation";
}

function takeRateSlot(
  ip: string,
  kind: RateKind
): { limited: boolean; retryAfterSec: number } {
  const now = Date.now();

  // Bounded map: sweep stale keys when the bucket count grows past the cap.
  if (rateBuckets.size > MAX_RATE_BUCKETS) {
    for (const [key, stamps] of rateBuckets) {
      const newest = stamps[stamps.length - 1];
      if (newest === undefined || now - newest > RATE_WINDOW_MS) {
        rateBuckets.delete(key);
      }
      if (rateBuckets.size <= MAX_RATE_BUCKETS / 2) break;
    }
  }

  const key = `${ip}:${kind}`;
  const limit = kind === "get" ? RATE_LIMIT_GET : RATE_LIMIT_MUTATION;
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

/** Best-effort client IP from the request-scoped headers (null outside). */
async function resolveIp(fallback?: string): Promise<string | null> {
  if (fallback) return fallback;
  try {
    const h = await headers();
    const forwarded = (h.get("x-forwarded-for") ?? "").split(",")[0].trim();
    if (forwarded) return forwarded;
    return h.get("x-real-ip") ?? "local";
  } catch {
    // No request scope (e.g. helper called from a non-HTTP context) —
    // skip counting entirely rather than polluting a shared bucket.
    return null;
  }
}

interface Governance {
  requestId: string;
  /** false = allowed; number = Retry-After seconds. */
  limited: false | number;
}

async function govern(ctx?: RequestContext): Promise<Governance> {
  const requestId = randomUUID();
  const ip = await resolveIp(ctx?.ip);
  if (ip === null) return { requestId, limited: false };
  const { limited, retryAfterSec } = takeRateSlot(ip, rateKind(ctx?.method));
  return { requestId, limited: limited ? retryAfterSec : false };
}

function rateLimitedResponse(requestId: string, retryAfterSec: number): NextResponse {
  return NextResponse.json(
    {
      success: false as const,
      error: {
        code: "RATE_LIMITED",
        message: `Too many requests — retry in ${retryAfterSec}s.`,
      },
      meta: { requestId },
    },
    {
      status: 429,
      headers: {
        "X-Request-Id": requestId,
        "Retry-After": String(retryAfterSec),
      },
    }
  );
}

/* ───────────────────────── envelope helpers ───────────────────────── */

export async function ok<T>(
  data: T,
  meta?: object,
  status = 200,
  ctx?: RequestContext
): Promise<NextResponse> {
  const { requestId, limited } = await govern(ctx);
  if (limited) return rateLimitedResponse(requestId, limited);
  const mergedMeta = { ...(meta ?? {}), requestId };
  return NextResponse.json(
    { success: true as const, data, meta: mergedMeta },
    { status, headers: { "X-Request-Id": requestId } }
  );
}

export async function fail(
  code: string,
  message: string,
  status = 400,
  ctx?: RequestContext
): Promise<NextResponse> {
  const { requestId, limited } = await govern(ctx);
  if (limited) return rateLimitedResponse(requestId, limited);
  return NextResponse.json(
    { success: false as const, error: { code, message }, meta: { requestId } },
    { status, headers: { "X-Request-Id": requestId } }
  );
}

/**
 * fail() variant with an extra `detail` field inside error{} (Phase 12-a).
 * Used by the AI endpoints to surface diagnostics such as the raw
 * unparseable LLM output alongside the AI_BAD_RESPONSE code. Callers that
 * need no detail keep using fail().
 */
export async function failWithDetail(
  code: string,
  message: string,
  status = 400,
  detail?: unknown,
  ctx?: RequestContext
): Promise<NextResponse> {
  const { requestId, limited } = await govern(ctx);
  if (limited) return rateLimitedResponse(requestId, limited);
  return NextResponse.json(
    {
      success: false as const,
      error: {
        code,
        message,
        ...(detail !== undefined ? { detail } : {}),
      },
      meta: { requestId },
    },
    { status, headers: { "X-Request-Id": requestId } }
  );
}

export function pageMeta(
  page: number,
  pageSize: number,
  total: number
): PageMeta {
  return {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** Shared pagination query params (pageSize hard-capped at 100). */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * Parse a comma-separated multi-value query param ("ACTIVE,ACKNOWLEDGED")
 * into a trimmed, non-empty string array. Returns undefined when absent/empty.
 */
export function csvParam(
  value: string | null | undefined
): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts : undefined;
}

/** Human-readable message from the first Zod issue. */
export function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid request";
  const path = issue.path.length > 0 ? issue.path.join(".") : "query";
  return `${path}: ${issue.message}`;
}

/** XXXXXX suffix (6 unambiguous uppercase alphanumerics). */
function correlationSuffix(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let suffix = "";
  for (let i = 0; i < 6; i += 1) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return suffix;
}

/** JOB-XXXXXX correlation id (job queue actions). */
export function newJobCorrelationId(): string {
  return `JOB-${correlationSuffix()}`;
}

/** Prefixed correlation id for non-job audits, e.g. POL-… (policies), DL-… (downloads). */
export function newCorrelationId(prefix: string): string {
  const safe = prefix.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return `${safe || "OP"}-${correlationSuffix()}`;
}
