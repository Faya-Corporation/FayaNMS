/**
 * R50.7 — Operational detection metrics (R50-T072).
 *
 * The vendor auto-detection plane's operational counters, named EXACTLY as
 * the roadmap's examples (docs/audits/FayaNMS-R50-Vendor-IP-Autodetect-
 * Remediation-Roadmap-2026-09-16.md §9 R50-T072):
 *
 *   device_detection_requests_total
 *   device_detection_success_total
 *   device_detection_failure_total
 *   device_detection_duration_seconds
 *   device_detection_vendor_unknown_total
 *   device_detection_host_key_mismatch_total
 *
 * SEMANTICS (the honest taxonomy — documented once, here, and pinned by
 * tests/audit/r50-operational-telemetry.test.ts):
 *
 *   - requests_total  — every well-formed POST /api/v1/devices/auto-detect
 *     invocation (i.e. it passed body validation). INVALID_BODY requests are
 *     not detection requests and are not counted.
 *   - success_total   — the vendor probe completed AND attributed a
 *     certified family (`matched`). A completed honest no-attribution
 *     (`generic`) is NOT a success — it has its own counter.
 *   - vendor_unknown_total — the probe completed, output was informative,
 *     but no certified vendor family matched (VENDOR_UNKNOWN). Visible
 *     separately because "the endpoint speaks an unknown CLI" is
 *     operationally different from "the probe worked".
 *   - failure_total   — everything that was neither matched, vendor-unknown,
 *     nor not-attempted: worker/transport failures (timeout, unreachable,
 *     auth rejected, host-key mismatch…) AND pre-probe policy refusals
 *     (authorization, target policy, credential, rate limit, trust-lookup).
 *     `failureReasons` carries the per-code split (registry codes where the
 *     contract defines them, so the breakdown is greppable against
 *     DETECTION_ERROR_CODES).
 *   - not-attempted   — the invocation asked for NO vendor probe (no
 *     credential given, or an address-only stage selection). Counted in
 *     requests_total and in NEITHER success nor failure: "the operator did
 *     not ask to probe" is not an outcome of a probe.
 *   - host_key_mismatch_total — the presented host key did not match the
 *     enrolled pin (HOST_KEY_MISMATCH). A SUBSET of failure_total; also
 *     audited as its own event class (R50-T071).
 *   - duration_seconds — wall-clock route duration observed for every
 *     invocation that passed the pre-probe refusal gates (i.e. it actually
 *     ran at least one stage — probe or DNS). Refusals never enter the
 *     duration distribution: the metric reads as detection-path latency.
 *     Stored internally in ms; snapshot values are SECONDS (the roadmap's
 *     unit). count/sum/min/max/avg are full-lifetime; p50/p95 are computed
 *     over a bounded recent window (the ring below) — bounded memory over
 *     unbounded lifetime, documented, not hidden.
 *
 * INFRASTRUCTURE POSTURE (mirrors SCALE-001-A): in-process, bounded, zero
 * new infra. Values are per-instance (process-lifetime since boot) — the
 * snapshot stamps `since` so operators never read a multi-instance
 * aggregate as one process's numbers. A fleet-wide time series remains
 * the runner/monitoring plane's job (CI-001 / owner-side); this module is
 * the honest in-app surface.
 *
 * Bounds: the duration ring holds DURATION_RING_CAP samples; the
 * failureReasons map holds at most MAX_FAILURE_REASON_KEYS named keys plus
 * the single "_other" collapse bucket (the registry is closed — a flood of
 * unknown labels cannot grow it). Reset is a test/ops affordance, never
 * called by the route.
 */

/** Bounded recent-sample window for the percentile estimate. */
export const DURATION_RING_CAP = 1024;

/** Maximum distinct failure-reason labels (the registry is closed). */
export const MAX_FAILURE_REASON_KEYS = 32;

/** The vendor probe's outcome taxonomy (R50-T070 `outcome` literal). */
export type DetectionOutcome =
  | "matched"
  | "vendor-unknown"
  | "failed"
  | "not-attempted";

export interface DetectionMetricsSnapshot {
  /** Every well-formed detection invocation. */
  device_detection_requests_total: number;
  /** Certified attribution completed. */
  device_detection_success_total: number;
  /** Transport failures AND policy refusals (see failureReasons). */
  device_detection_failure_total: number;
  /** SECONDS. count/sum/min/max/avg lifetime; p50/p95 recent-window. */
  device_detection_duration_seconds: {
    count: number;
    sum: number;
    min: number;
    max: number;
    avg: number;
    p50: number;
    p95: number;
    last: number;
  };
  /** Completed probe, no certified family matched. */
  device_detection_vendor_unknown_total: number;
  /** Presented host key ≠ enrolled pin (subset of failure_total). */
  device_detection_host_key_mismatch_total: number;
  /** Per-code failure split (registry codes; bounded map). */
  failureReasons: Record<string, number>;
  /** Process-lifetime stamp — per-instance counter, never fleet-wide. */
  since: string;
}

interface DurationStats {
  count: number;
  sumMs: number;
  minMs: number | null;
  maxMs: number | null;
  lastMs: number | null;
  ring: number[];
}

const metrics = {
  requests: 0,
  success: 0,
  failure: 0,
  vendorUnknown: 0,
  hostKeyMismatch: 0,
  durations: {
    count: 0,
    sumMs: 0,
    minMs: null,
    maxMs: null,
    lastMs: null,
    ring: [],
  } as DurationStats,
  failureReasons: new Map<string, number>(),
  since: new Date().toISOString(),
};

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/* ───────────────────────── recording API ───────────────────────── */

/** One well-formed detection invocation reached the route. */
export function recordDetectionRequest(): void {
  metrics.requests += 1;
}

/**
 * Record the invocation's outcome. `matched` → success_total;
 * `vendor-unknown` → vendor_unknown_total; `failed` → failure_total;
 * `not-attempted` → none of the three (documented above).
 */
export function recordDetectionOutcome(outcome: DetectionOutcome): void {
  switch (outcome) {
    case "matched":
      metrics.success += 1;
      break;
    case "vendor-unknown":
      metrics.vendorUnknown += 1;
      break;
    case "failed":
      metrics.failure += 1;
      break;
    case "not-attempted":
      // deliberately counted in neither success nor failure
      break;
  }
}

/**
 * Record a failure's reason label (a DETECTION_ERROR_CODES registry code
 * for contract surfaces — PROBE_NOT_AUTHORIZED, TARGET_NOT_ALLOWED,
 * CREDENTIAL_UNRESOLVED, CREDENTIAL_NOT_AUTHORIZED, DEVICE_PROBE_RATE_LIMITED,
 * HOST_KEY_ENROLLMENT_LOOKUP_FAILED, SSH_CONNECT_TIMEOUT, …). Bounded:
 * beyond MAX_FAILURE_REASON_KEYS unknown labels collapse into "_other".
 * ALREADY increments failure_total — call INSTEAD of
 * recordDetectionOutcome("failed"), never in addition.
 */
export function recordDetectionFailure(reason: string): void {
  metrics.failure += 1;
  const label =
    metrics.failureReasons.has(reason) || metrics.failureReasons.size < MAX_FAILURE_REASON_KEYS
      ? reason
      : "_other";
  metrics.failureReasons.set(label, (metrics.failureReasons.get(label) ?? 0) + 1);
}

/** Host-key mismatch (subset of failure; also its own audit class, R50-T071). */
export function recordHostKeyMismatch(): void {
  metrics.hostKeyMismatch += 1;
}

/** Observe the route's wall-clock duration in MILLISECONDS. */
export function observeDetectionDuration(ms: number): void {
  const d = metrics.durations;
  const value = Number.isFinite(ms) && ms >= 0 ? ms : 0;
  d.count += 1;
  d.sumMs += value;
  d.lastMs = value;
  d.minMs = d.minMs === null ? value : Math.min(d.minMs, value);
  d.maxMs = d.maxMs === null ? value : Math.max(d.maxMs, value);
  d.ring.push(value);
  if (d.ring.length > DURATION_RING_CAP) {
    d.ring.shift();
  }
}

/* ───────────────────────── read API ───────────────────────── */

/** Percentile over the recent ring (linear interpolation, sorted copy). */
function percentile(ring: readonly number[], p: number): number {
  if (ring.length === 0) return 0;
  const sorted = [...ring].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const value = lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  return round3(value / 1000); // ms → seconds
}

/** Snapshot the counters (SECONDS for durations; per-instance since boot). */
export function snapshotDetectionMetrics(): DetectionMetricsSnapshot {
  const d = metrics.durations;
  const avg = d.count > 0 ? d.sumMs / d.count : 0;
  return {
    device_detection_requests_total: metrics.requests,
    device_detection_success_total: metrics.success,
    device_detection_failure_total: metrics.failure,
    device_detection_duration_seconds: {
      count: d.count,
      sum: round3(d.sumMs / 1000),
      min: d.minMs === null ? 0 : round3(d.minMs / 1000),
      max: d.maxMs === null ? 0 : round3(d.maxMs / 1000),
      avg: round3(avg / 1000),
      p50: percentile(d.ring, 0.5),
      p95: percentile(d.ring, 0.95),
      last: d.lastMs === null ? 0 : round3(d.lastMs / 1000),
    },
    device_detection_vendor_unknown_total: metrics.vendorUnknown,
    device_detection_host_key_mismatch_total: metrics.hostKeyMismatch,
    failureReasons: Object.fromEntries(
      [...metrics.failureReasons.entries()].sort(([a], [b]) => a.localeCompare(b))
    ),
    since: metrics.since,
  };
}

/** Test/ops affordance — zero every counter and restart the since stamp. */
export function resetDetectionMetrics(): void {
  metrics.requests = 0;
  metrics.success = 0;
  metrics.failure = 0;
  metrics.vendorUnknown = 0;
  metrics.hostKeyMismatch = 0;
  metrics.durations = { count: 0, sumMs: 0, minMs: null, maxMs: null, lastMs: null, ring: [] };
  metrics.failureReasons = new Map();
  metrics.since = new Date().toISOString();
}
