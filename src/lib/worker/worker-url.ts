/**
 * Worker base-URL resolution — runbook T5 (docs/deploy/WINDOWS-SERVER-DOCKER-DESKTOP.md).
 *
 * HISTORY: the app's backend→worker calls were hardcoded to
 * `http://localhost:3030`, which forced the worker to share the app's network
 * namespace (compose `network_mode: "service:app"`, R12's T3 workaround).
 * T5 makes the base URL env-configurable with the loopback default preserved:
 *   - bare-metal dev (`bun dev` + `bun mini-services/worker/index.ts`) needs
 *     NO env var — the default keeps the original loopback contract;
 *   - compose (bridge network) sets `WORKER_BASE_URL=http://worker:3030`
 *     (interpolated from the --env-file, see docs/deploy/env.production.example).
 *
 * A malformed value fails FAST at module load with a human-readable error —
 * the same fail-fast philosophy as `siteUrl()` (B3-029), not a silent
 * fallback that turns into a mysterious connection refusal later.
 *
 * SERVER-ONLY: imported exclusively by API route handlers (mirrors
 * control-client.ts's discipline).
 */

function normalizeBaseUrl(
  raw: string | undefined,
  fallback: string,
  envName: string
): string {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      `${envName}="${trimmed}" is not a valid absolute http(s) URL — fix the value or remove the variable to fall back to ${fallback} (runbook T5).`
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `${envName} must be an http(s) URL — got protocol "${url.protocol}" (runbook T5).`
    );
  }
  // Strip any trailing slash so `BASE + "/path"` concatenation stays
  // well-formed even when an operator configures a trailing "/".
  const path = url.pathname.replace(/\/+$/, "");
  return path === "" ? url.origin : url.origin + path;
}

/**
 * Base URL of the worker mini-service's HTTP surface (/health, /simulate/*,
 * /capabilities). Default preserves the Task 2-b loopback contract.
 */
export const WORKER_BASE_URL = normalizeBaseUrl(
  process.env.WORKER_BASE_URL,
  "http://localhost:3030",
  "WORKER_BASE_URL"
);

/**
 * Display form for registry/UI rows (host[:port] only, no scheme) — used by
 * the collectors registry instead of the former hardcoded "localhost:3030".
 */
export const WORKER_HOST = new URL(WORKER_BASE_URL).host;
