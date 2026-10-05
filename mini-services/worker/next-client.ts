/**
 * FayaNMS worker — outbound HTTP client + logger.
 *
 * ARCHITECTURE (binding, see worklog Task 2-b): the worker NEVER opens the
 * SQLite database. SQLite is single-writer and the Next.js process owns all
 * persistence. Every state change goes through Next.js HTTP on
 * NEXT_BASE_URL (runbook T5 — env-configurable; default
 * http://localhost:3000 preserves the original same-host loopback contract).
 * The gateway's browser-only XTransformPort rule does not apply here.
 *
 * Zero external dependencies: fetch + AbortSignal.timeout are bun built-ins.
 *
 * F-5 (wave-8): the completion plane (complete/RESUMED/progress posts) is
 * RETRIED — bounded attempts, exponential + jittered delay, per-attempt
 * timeout — via nextPost's { retries } option (see nextPostWithRetry).
 * Failures are typed (PostHttpError carries the HTTP status) so the claim/
 * tick backoff can classify 401/403 as identity faults (F-6).
 */

import { appendFile } from "node:fs/promises";
import { renameSync, statSync } from "node:fs";
import { join } from "node:path";

import { serviceAuthHeader } from "./service-token";
import { jitterBackoff } from "./backoff";

/**
 * Resolve a base URL from the environment (runbook T5). Trims whitespace,
 * falls back to the loopback default when unset/blank, and fail-fasts on a
 * malformed value — the same philosophy as the app's siteUrl() guard.
 */
function envBaseUrl(name: string, fallback: string): string {
  const trimmed = process.env[name]?.trim();
  if (!trimmed) return fallback;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      `${name}="${trimmed}" is not a valid absolute http(s) URL — fix the value or remove the variable to fall back to ${fallback} (runbook T5).`
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `${name} must be an http(s) URL — got protocol "${url.protocol}" (runbook T5).`
    );
  }
  const path = url.pathname.replace(/\/+$/, "");
  return path === "" ? url.origin : url.origin + path;
}

export const NEXT_BASE_URL = envBaseUrl("NEXT_BASE_URL", "http://localhost:3000");
export const SELF_BASE_URL = envBaseUrl("SELF_BASE_URL", "http://localhost:3030");

/**
 * Live base-URL read (wave-8 F-5): NEXT_BASE_URL is re-resolved PER REQUEST
 * so a value set after module load — the behavioral-test seam, and a bun
 * --hot env edit — always dials the current value. Validation semantics are
 * identical to the module-load constant (same envBaseUrl guard).
 */
function currentNextBaseUrl(): string {
  return envBaseUrl("NEXT_BASE_URL", "http://localhost:3000");
}

const LOG_FILE = join(import.meta.dir, "worker.log");

/**
 * RT-027 / F-043 — worker.log is BOUNDED: one-generation size-capped
 * rotation. When the file exceeds LOG_MAX_BYTES it is renamed to
 * worker.log.1 (overwriting any previous generation) BEFORE the next
 * append — the live file restarts empty and the old content stays one
 * generation deep. Simple at this scale: no timestamped multi-file
 * rotation (deliberate choice, noted here so nobody "completes" it).
 */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Rotate `path` to `${path}.1` when it exceeds `maxBytes` (best-effort:
 * a missing file or an unwritable dir must never throw — the caller's
 * append path is allowed to fail silently). Exported for the audit
 * suite (temp-file tested).
 */
export function rotateLogIfOversized(path: string, maxBytes = LOG_MAX_BYTES): void {
  try {
    if (statSync(path).size > maxBytes) {
      renameSync(path, `${path}.1`);
    }
  } catch {
    /* rotation is best-effort; logging must never break the worker */
  }
}

/** Console + append-only worker.log line (size-bounded, RT-027). Never throws. */
export async function log(message: string): Promise<void> {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    rotateLogIfOversized(LOG_FILE);
    await appendFile(LOG_FILE, line + "\n");
  } catch {
    /* logging must never break the worker */
  }
}

/**
 * Typed HTTP failure (F-5): carries the response status so the retry
 * wrapper can RETRY transport faults (network/timeout → not a
 * PostHttpError), 5xx and 429, while never retrying other 4xx (a config
 * or validation error replays identically), and so the claim/tick backoff
 * can classify 401/403 as identity faults (F-6). The message keeps the
 * historical `POST <path> -> HTTP <status>[...])` shape.
 */
export class PostHttpError extends Error {
  readonly status: number;

  constructor(path: string, status: number, message: string) {
    super(`POST ${path} -> HTTP ${status}${message ? `: ${message}` : ""}`);
    this.name = "PostHttpError";
    this.status = status;
  }
}

/**
 * Single POST attempt (bounded by AbortSignal.timeout) + envelope unwrap.
 * Never retries — see nextPostWithRetry for the retrying wrapper.
 */
async function postJson(
  base: string,
  path: string,
  body: unknown,
  timeoutMs: number,
  opts: { serviceAuth?: boolean } = {}
): Promise<unknown> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  // Phase 19-C (audit GATEWAY-101/SVC-101): EVERY POST carries the machine
  // principal's service JWT — including loopback self-calls, because the
  // /simulate/* surface now requires a Bearer token with the "simulate"
  // scope even from the worker itself (self-identity iss "fayanms:worker").
  headers.authorization = serviceAuthHeader();
  const res = await fetch(base + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json: Record<string, unknown> | undefined;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
  } catch {
    /* non-JSON response handled below */
  }
  const envelopeOk = !!json && (json.success === true || json.ok === true);
  if (!res.ok || !json || !envelopeOk) {
    const err = json?.error as { message?: string } | string | undefined;
    const msg =
      typeof err === "string" ? err : err?.message ?? text.slice(0, 200);
    throw new PostHttpError(path, res.status, msg);
  }
  // Next.js answers { success: true, data } → unwrap `data`. The worker's own
  // /simulate/connect answers { ok: true, ... } flat → return it verbatim.
  return "data" in json ? json.data : json;
}

/**
 * F-5 — bounded retry for the completion plane (complete / RESUMED /
 * progress posts): `retries` ATTEMPTS total (not extras), exponential
 * delay + ±20% jitter on a ~250 ms → 1 s → 4 s scale, per-attempt
 * AbortSignal.timeout preserved. Only transport faults (network/timeout),
 * HTTP 5xx and HTTP 429 retry — other 4xx answers replay identically and
 * are surfaced immediately. Swallowed-post behavior (the callers' catch +
 * log) happens only AFTER the final attempt, unchanged.
 */
const RETRY_DELAYS_MS = [250, 1_000, 4_000];

export async function nextPostWithRetry(
  path: string,
  body: unknown,
  timeoutMs: number,
  retries: number
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await postJson(currentNextBaseUrl(), path, body, timeoutMs, { serviceAuth: true });
    } catch (e) {
      lastError = e;
      const retryable =
        !(e instanceof PostHttpError) || e.status >= 500 || e.status === 429;
      if (!retryable || attempt === retries) break;
      const delay = jitterBackoff(RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

export function nextPost(
  path: string,
  body: unknown,
  timeoutMs = 10_000,
  opts: { retries?: number } = {}
): Promise<unknown> {
  // F-5: opts.retries = TOTAL attempts for the completion plane (default 1 —
  // single-shot, the historical behavior for every other call site).
  if (opts.retries && opts.retries > 1) {
    return nextPostWithRetry(path, body, timeoutMs, opts.retries);
  }
  return postJson(currentNextBaseUrl(), path, body, timeoutMs, { serviceAuth: true });
}

/** Loopback self-call (runner connect step goes through /simulate/connect). */
export function selfPost(
  path: string,
  body: unknown,
  timeoutMs = 10_000
): Promise<unknown> {
  return postJson(SELF_BASE_URL, path, body, timeoutMs);
}
