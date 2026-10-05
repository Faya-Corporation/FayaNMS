/**
 * FayaNMS worker — claim/tick backoff arithmetic (F-6, wave-8).
 *
 * Two problems with the pre-wave-8 backoff (runner.ts claim loop +
 * scheduler.ts tick loop, mirrored shapes):
 *
 *   1. DETERMINISTIC RETRIES — min(3 s × 2^n, 5 min) with no jitter means
 *      a fleet of workers (or one worker's claim + tick loops) that fail
 *      together retry together forever. The retry delay is now jittered
 *      ±20% around the exponential base.
 *
 *   2. UNDIFFERENTIATED FAULTS — a 401/403 from the app plane is a CONFIG
 *      fault (the service identity was rejected — keys rotated/absent),
 *      not a transient outage. Retrying it on the exponential curve hammers
 *      the app with auth attempts that can never succeed. Identity faults
 *      get a FIXED slow cadence and a distinct greppable log line
 *      ("service identity rejected — check keys"); 5xx/timeouts keep the
 *      exponential curve.
 *
 * Pure and dependency-free: no worker-module imports, so the audit suite
 * can exercise the arithmetic directly from the repo root.
 */

/** The fixed slow cadence for a rejected service identity (F-6). */
export const IDENTITY_FAULT_BACKOFF_MS = 60_000;

/**
 * Jitter a backoff base by ±20% (uniform). Sampled bounds: the result is
 * ALWAYS within [0.8 × base, 1.2 × base] — pinned by the audit suite over
 * N samples. `rand` is injectable for deterministic tests.
 */
export function jitterBackoff(baseMs: number, rand: () => number = Math.random): number {
  const factor = 0.8 + 0.4 * rand();
  return Math.round(baseMs * factor);
}

/**
 * Classify an HTTP status as a service-identity config fault (F-6): only
 * 401/403 mean the app REJECTED the worker's credentials — everything else
 * (5xx, timeouts, network errors) stays on the exponential curve.
 */
export function isIdentityFaultStatus(status: number | undefined): boolean {
  return status === 401 || status === 403;
}
