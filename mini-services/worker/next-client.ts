/**
 * FayaNMS worker — outbound HTTP client + logger.
 *
 * ARCHITECTURE (binding, see worklog Task 2-b): the worker NEVER opens the
 * SQLite database. SQLite is single-writer and the Next.js process owns all
 * persistence. Every state change goes through Next.js HTTP on
 * http://localhost:3000 (backend-to-backend, same host). The gateway's
 * browser-only XTransformPort rule does not apply here.
 *
 * Zero external dependencies: fetch + AbortSignal.timeout are bun built-ins.
 */

import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import { serviceAuthHeader } from "./service-token";

export const NEXT_BASE_URL = "http://localhost:3000";
export const SELF_BASE_URL = "http://localhost:3030";

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
  // P19 SEC-002: calls to the Next.js job engine carry the machine-principal
  // service JWT. Self-calls (simulate/*) stay unauthenticated loopback.
  if (opts.serviceAuth) {
    headers.authorization = serviceAuthHeader();
  }
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
