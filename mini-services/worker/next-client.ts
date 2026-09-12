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
 */

import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import { serviceAuthHeader } from "./service-token";

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

const LOG_FILE = join(import.meta.dir, "worker.log");

/** Console + append-only worker.log line. Never throws. */
export async function log(message: string): Promise<void> {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    await appendFile(LOG_FILE, line + "\n");
  } catch {
    /* logging must never break the worker */
  }
}

/**
 * POST JSON and unwrap the FayaNMS envelope ({ success: true, data }).
 * The /simulate/connect self-endpoint answers { ok: true, ... } instead —
 * both shapes are accepted. Always bounded by AbortSignal.timeout.
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
    throw new Error(
      `POST ${path} -> HTTP ${res.status}${msg ? `: ${msg}` : ""}`
    );
  }
  // Next.js answers { success: true, data } → unwrap `data`. The worker's own
  // /simulate/connect answers { ok: true, ... } flat → return it verbatim.
  return "data" in json ? json.data : json;
}

export function nextPost(
  path: string,
  body: unknown,
  timeoutMs = 10_000
): Promise<unknown> {
  return postJson(NEXT_BASE_URL, path, body, timeoutMs, { serviceAuth: true });
}

/** Loopback self-call (runner connect step goes through /simulate/connect). */
export function selfPost(
  path: string,
  body: unknown,
  timeoutMs = 10_000
): Promise<unknown> {
  return postJson(SELF_BASE_URL, path, body, timeoutMs);
}
