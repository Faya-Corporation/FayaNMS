import { NextResponse } from "next/server";
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
 * API GOVERNANCE (SAFE-002 — external ULTRA audit P0-002 remediation):
 *   - X-Request-Id header on every response (crypto.randomUUID), also echoed
 *     as `requestId` in the envelope meta.
 *   - Rate limiting does NOT live here anymore. It used to run inside these
 *     response builders — i.e. AFTER a handler had already committed its
 *     side effects (a rate-limited mutation still executed, answered 429,
 *     and invited a duplicate-effect retry) — with a first-entry
 *     X-Forwarded-For client key that callers could rotate freely. The gate
 *     now runs BEFORE handler execution in the proxy plane
 *     (src/proxy.ts → src/lib/api/rate-gate.ts): 300 req/min for GET/HEAD,
 *     120 req/min for mutations, per spoof-resistant client key, with a
 *     VERIFIED service JWT (worker claim/step/progress loops) exempt.
 *     These helpers are therefore synchronous and pure envelope builders.
 */

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/* ───────────────────────── envelope core ───────────────────────── */

/**
 * @deprecated SAFE-002: request context used to feed the response-build
 * rate limiter (method budget + client IP). The gate now runs pre-handler
 * in the proxy plane (src/proxy.ts → src/lib/api/rate-gate.ts), which
 * derives the method from the real request and the client key from the
 * spoof-resistant rightmost-trusted-hop policy. The type and helper are
 * kept ONLY so existing call sites compile; the value is ignored.
 * Mechanical removal of the ~50 call sites is tracked as backlog.
 */
export interface RequestContext {
  method?: string;
  ip?: string;
}

/**
 * @deprecated SAFE-002 — see RequestContext. Returns an empty context;
 * the proxy plane no longer needs any per-call context from routes.
 */
export function requestContext(_request?: Request): RequestContext {
  return {};
}

export function ok<T>(
  data: T,
  meta?: object,
  status = 200,
  /** @deprecated ignored since SAFE-002 (proxy-plane rate gate). */
  _ctx?: RequestContext
): NextResponse {
  const requestId = randomUUID();
  const mergedMeta = { ...(meta ?? {}), requestId };
  return NextResponse.json(
    { success: true as const, data, meta: mergedMeta },
    { status, headers: { "X-Request-Id": requestId } }
  );
}

export function fail(
  code: string,
  message: string,
  status = 400,
  /** @deprecated ignored since SAFE-002 (proxy-plane rate gate). */
  _ctx?: RequestContext
): NextResponse {
  const requestId = randomUUID();
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
export function failWithDetail(
  code: string,
  message: string,
  status = 400,
  detail?: unknown,
  /** @deprecated ignored since SAFE-002 (proxy-plane rate gate). */
  _ctx?: RequestContext
): NextResponse {
  const requestId = randomUUID();
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
