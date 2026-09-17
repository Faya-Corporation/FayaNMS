import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  DURATION_RING_CAP,
  MAX_FAILURE_REASON_KEYS,
  observeDetectionDuration,
  recordDetectionFailure,
  recordDetectionOutcome,
  recordDetectionRequest,
  recordHostKeyMismatch,
  resetDetectionMetrics,
  snapshotDetectionMetrics,
} from "../../src/lib/metrics/detection-metrics";

/**
 * R50.7 — audit + operational telemetry (R50-T070 / R50-T071 / R50-T072).
 *
 * Pinned here (and kept honest forever):
 *
 *   R50-T072 (the METRICS module — behavioral):
 *     - the snapshot answers the roadmap's six named metrics VERBATIM
 *       (bidirectional: every roadmap example name is a snapshot key, and
 *       every snapshot key appears in the roadmap §9 R50-T072 block);
 *     - the outcome taxonomy: matched → success, generic → vendor-unknown,
 *       transport/policy failures → failure_total (WITH the per-code
 *       failureReasons split), not-attempted → counted in NEITHER success
 *       nor failure;
 *     - recordDetectionFailure is the ONLY failure_total writer (calling it
 *       in addition to recordDetectionOutcome("failed") would double-count —
 *       the contract is pinned);
 *     - host_key_mismatch is a SUBSET of failure_total (independent counter);
 *     - duration is observed in ms, reported in SECONDS, bounded ring for
 *       the recent-window percentiles, full-lifetime count/sum/min/max;
 *     - every structure is BOUNDED (ring cap; failureReasons key cap with
 *       "_other" collapse) — an unbounded metric is a DoS vector;
 *     - reset is total (test/ops affordance).
 *
 *   R50-T070/T071 (the ROUTE wiring — source pins, the established pattern
 *   for route-level contracts in this repo):
 *     - the main event's afterJson carries the full structured non-secret
 *       evidence: actorId, correlationId, tenant (null BY DESIGN), outcome,
 *       durationMs, requestedHost/connectionAddress/resolvedManagementIp,
 *       credentialProfileId, hostKeyState, vendor/model/osVersion, codes;
 *     - EVERY failure class is audited: DEVICE_PROBE_AUTH_REFUSED (with the
 *       null-actor design), DEVICE_PROBE_TARGET_REFUSED,
 *       DEVICE_PROBE_CREDENTIAL_REFUSED, HOST_KEY_TRUST_LOOKUP_FAILED,
 *       DEVICE_PROBE_HOST_KEY_MISMATCH — plus timeout/unreachable/unknown
 *       via the main event's typed codes;
 *     - refusal emissions are best-effort (the shared helper) — a refusal
 *       must never become a 500 because the audit plane hiccuped;
 *     - rate-limit refusals are counted, NOT audited per-hit (the documented
 *       anti-flooding decision);
 *     - the response contract is UNCHANGED (R50.7 touched the audit +
 *       metrics planes only — DETECTION_CONTRACT_VERSION stays 1).
 *
 *   The metrics READ SURFACE (endpoint):
 *     - GET /api/v1/metrics/detection exists, gated by metrics.read,
 *       answers snapshotDetectionMetrics() and nothing else (aggregates
 *       only — no hostnames, no credential ids, no fingerprints).
 */

const ROUTE = readFileSync("src/app/api/v1/devices/auto-detect/route.ts", "utf8");
const ENDPOINT = readFileSync("src/app/api/v1/metrics/detection/route.ts", "utf8");
const ROADMAP = readFileSync(
  "docs/audits/FayaNMS-R50-Vendor-IP-Autodetect-Remediation-Roadmap-2026-09-16.md",
  "utf8",
);

/* ───────────── R50-T072 — the roadmap-named metrics, verbatim ───────────── */

describe("R50-T072 — the six roadmap metric names exist verbatim (bidirectional)", () => {
  const ROADMAP_NAMES = [
    "device_detection_requests_total",
    "device_detection_success_total",
    "device_detection_failure_total",
    "device_detection_duration_seconds",
    "device_detection_vendor_unknown_total",
    "device_detection_host_key_mismatch_total",
  ];

  test("every roadmap example name is a snapshot key", () => {
    resetDetectionMetrics();
    const snapshot = snapshotDetectionMetrics();
    for (const name of ROADMAP_NAMES) {
      expect(name in snapshot).toBe(true);
    }
  });

  test("every snapshot metric key appears in the roadmap §9 R50-T072 block", () => {
    const section = ROADMAP.slice(ROADMAP.indexOf("## R50-T072"));
    const keys = Object.keys(snapshotDetectionMetrics()).filter((k) =>
      k.startsWith("device_detection_")
    );
    expect(keys.length).toBeGreaterThanOrEqual(ROADMAP_NAMES.length);
    for (const key of keys) {
      expect(section).toContain(key);
    }
  });
});

/* ───────────── R50-T072 — the outcome taxonomy (behavioral) ───────────── */

describe("R50-T072 — outcome taxonomy and counters", () => {
  test("matched → success_total; not-attempted counts in neither", () => {
    resetDetectionMetrics();
    recordDetectionRequest();
    recordDetectionOutcome("matched");
    recordDetectionRequest();
    recordDetectionOutcome("not-attempted");
    const s = snapshotDetectionMetrics();
    expect(s.device_detection_requests_total).toBe(2);
    expect(s.device_detection_success_total).toBe(1);
    expect(s.device_detection_failure_total).toBe(0);
    expect(s.device_detection_vendor_unknown_total).toBe(0);
  });

  test("generic completion → vendor_unknown_total, NOT success, NOT failure", () => {
    resetDetectionMetrics();
    recordDetectionRequest();
    recordDetectionOutcome("vendor-unknown");
    const s = snapshotDetectionMetrics();
    expect(s.device_detection_vendor_unknown_total).toBe(1);
    expect(s.device_detection_success_total).toBe(0);
    expect(s.device_detection_failure_total).toBe(0);
  });

  test("failures carry their registry reason; refusals are failures too", () => {
    resetDetectionMetrics();
    recordDetectionRequest();
    recordDetectionFailure("SSH_CONNECT_TIMEOUT");
    recordDetectionRequest();
    recordDetectionFailure("TARGET_NOT_ALLOWED");
    const s = snapshotDetectionMetrics();
    expect(s.device_detection_failure_total).toBe(2);
    expect(s.device_detection_success_total).toBe(0);
    expect(s.failureReasons["SSH_CONNECT_TIMEOUT"]).toBe(1);
    expect(s.failureReasons["TARGET_NOT_ALLOWED"]).toBe(1);
  });

  test("recordDetectionFailure is the ONLY failure_total writer — the double-count contract", () => {
    // The route's switch uses recordDetectionOutcome ONLY for matched /
    // vendor-unknown (via the outcome variable), and recordDetectionFailure
    // for failed. These pins make both halves of that contract explicit.
    expect(ROUTE).toContain('case "failed":\n      recordDetectionFailure(');
    expect(ROUTE).toContain("recordDetectionOutcome(outcome)");
    expect(ROUTE).not.toContain('recordDetectionOutcome("failed");');
    // ...and the module docblock states the rule.
    const MODULE = readFileSync("src/lib/metrics/detection-metrics.ts", "utf8");
    expect(MODULE).toContain("INSTEAD of");
  });

  test("host-key mismatch is a SUBSET counter, independent of failure_total", () => {
    resetDetectionMetrics();
    recordHostKeyMismatch();
    const s = snapshotDetectionMetrics();
    expect(s.device_detection_host_key_mismatch_total).toBe(1);
    expect(s.device_detection_failure_total).toBe(0); // failure_total rides recordDetectionFailure
    // The route ticks BOTH at the mismatch site: the subset counter inline,
    // failure_total at the end path with the same code.
    expect(ROUTE).toContain('action: "DEVICE_PROBE_HOST_KEY_MISMATCH"');
    expect(ROUTE).toContain("recordHostKeyMismatch();");
    expect(ROUTE).toContain('recordDetectionFailure(detectionErrorCode ?? resolutionErrorCode');
  });
});

/* ───────────── R50-T072 — duration: units, bounds, percentiles ───────────── */

describe("R50-T072 — device_detection_duration_seconds semantics", () => {
  test("observed in ms, reported in SECONDS; lifetime stats are exact", () => {
    resetDetectionMetrics();
    observeDetectionDuration(1500); // 1.5 s
    observeDetectionDuration(500); // 0.5 s
    const s = snapshotDetectionMetrics();
    expect(s.device_detection_duration_seconds.count).toBe(2);
    expect(s.device_detection_duration_seconds.sum).toBe(2);
    expect(s.device_detection_duration_seconds.min).toBe(0.5);
    expect(s.device_detection_duration_seconds.max).toBe(1.5);
    expect(s.device_detection_duration_seconds.avg).toBe(1);
    expect(s.device_detection_duration_seconds.last).toBe(0.5);
  });

  test("p50/p95 are computed over the bounded recent window", () => {
    resetDetectionMetrics();
    // 100 samples 1..100 ms in the ring (cap is 1024 — all fit).
    for (let i = 1; i <= 100; i++) observeDetectionDuration(i);
    const s = snapshotDetectionMetrics();
    expect(s.device_detection_duration_seconds.p50).toBeCloseTo(0.05, 2); // ~50 ms
    expect(s.device_detection_duration_seconds.p95).toBeCloseTo(0.095, 2); // ~95 ms
  });

  test("the ring is BOUNDED — samples beyond the cap fall out of the window", () => {
    resetDetectionMetrics();
    for (let i = 0; i < DURATION_RING_CAP + 200; i++) observeDetectionDuration(1);
    const s = snapshotDetectionMetrics();
    // lifetime count is complete; the window cannot exceed the cap
    expect(s.device_detection_duration_seconds.count).toBe(DURATION_RING_CAP + 200);
    const MODULE = readFileSync("src/lib/metrics/detection-metrics.ts", "utf8");
    expect(MODULE).toContain("d.ring.length > DURATION_RING_CAP");
  });

  test("non-finite / negative observations are clamped, never poison the stats", () => {
    resetDetectionMetrics();
    observeDetectionDuration(Number.NaN);
    observeDetectionDuration(-5);
    const s = snapshotDetectionMetrics();
    expect(s.device_detection_duration_seconds.count).toBe(2);
    expect(s.device_detection_duration_seconds.min).toBe(0);
    expect(s.device_detection_duration_seconds.sum).toBe(0);
  });
});

/* ───────────── R50-T072 — bounded failure labels + reset ───────────── */

describe("R50-T072 — failureReasons is bounded; reset is total", () => {
  test("a flood of unknown labels collapses into _other at the key cap", () => {
    resetDetectionMetrics();
    for (let i = 0; i < MAX_FAILURE_REASON_KEYS + 30; i++) {
      recordDetectionFailure(`NOT_A_REGISTRY_CODE_${i}`);
    }
    const s = snapshotDetectionMetrics();
    // MAX named labels + the one _other collapse bucket — bounded either way.
    const labelCount = Object.keys(s.failureReasons).length;
    expect(labelCount).toBe(MAX_FAILURE_REASON_KEYS + 1);
    expect(s.failureReasons["_other"]).toBe(30);
    // ...while the aggregate never lies about the total.
    expect(s.device_detection_failure_total).toBe(MAX_FAILURE_REASON_KEYS + 30);
  });

  test("known labels already in the map keep incrementing past the cap window", () => {
    resetDetectionMetrics();
    for (let i = 0; i < MAX_FAILURE_REASON_KEYS; i++) recordDetectionFailure(`X_${i}`);
    // the map is full — but an EXISTING label still updates in place
    recordDetectionFailure("X_0");
    const s = snapshotDetectionMetrics();
    expect(s.failureReasons["X_0"]).toBe(2);
    expect(Object.keys(s.failureReasons).length).toBe(MAX_FAILURE_REASON_KEYS);
  });

  test("resetDetectionMetrics zeroes every counter and restarts the window", () => {
    recordDetectionRequest();
    recordDetectionOutcome("matched");
    recordDetectionFailure("SSH_CONNECT_TIMEOUT");
    recordHostKeyMismatch();
    observeDetectionDuration(1234);
    resetDetectionMetrics();
    const s = snapshotDetectionMetrics();
    expect(s.device_detection_requests_total).toBe(0);
    expect(s.device_detection_success_total).toBe(0);
    expect(s.device_detection_failure_total).toBe(0);
    expect(s.device_detection_vendor_unknown_total).toBe(0);
    expect(s.device_detection_host_key_mismatch_total).toBe(0);
    expect(s.device_detection_duration_seconds.count).toBe(0);
    expect(Object.keys(s.failureReasons).length).toBe(0);
  });

  test("the snapshot stamps `since` (per-instance honesty) and the endpoint surfaces it", () => {
    resetDetectionMetrics();
    const s = snapshotDetectionMetrics();
    expect(new Date(s.since).getTime()).not.toBeNaN();
    expect(ENDPOINT).toContain("Per-instance counters since process boot");
  });
});

/* ───────────── R50-T070 — the structured audit evidence (route wiring) ───────────── */

describe("R50-T070 — DEVICE_VENDOR_AUTODETECTED carries the structured non-secret evidence", () => {
  test("the outcome literal is derived and recorded (matched / vendor-unknown / failed / not-attempted)", () => {
    expect(ROUTE).toContain("const outcome: DetectionOutcome =");
    expect(ROUTE).toContain('"vendor-unknown"');
    expect(ROUTE).toContain('"not-attempted"');
    expect(ROUTE).toContain("outcome,");
  });

  test("the evidence keys are present: actor, correlation, tenant, duration", () => {
    // actor + correlationId mirrored for self-contained exports
    expect(ROUTE).toContain("actorId: actor.id,");
    expect(ROUTE).toContain("correlationId,");
    // tenant: null BY DESIGN (single-tenant schema — reserved, never omitted)
    expect(ROUTE).toContain("tenant: null,");
    expect(ROUTE).toContain("single-tenant schema");
    // total route duration (the worker's latencyMs is only the probe leg)
    expect(ROUTE).toContain("durationMs,");
    expect(ROUTE).toContain("observeDetectionDuration(durationMs)");
  });

  test("the pre-existing evidence fields survive (non-regression)", () => {
    for (const key of [
      "requestedHost,",
      "resolvedManagementIp,",
      "credentialProfileId: profile?.id ?? null,",
      "hostKeyState,",
      "vendorKey: detection?.vendorKey ?? null,",
      "model: detection?.model ?? null,",
      "osVersion: detection?.osVersion ?? null,",
      "matchReasons: detection?.matchReasons ?? null,",
      "detectionErrorCode,",
      "resolutionErrorCode,",
      "contractVersion: DETECTION_CONTRACT_VERSION,",
    ]) {
      expect(ROUTE).toContain(key);
    }
  });

  test("the response contract is UNCHANGED by R50.7 (audit+metrics planes only)", () => {
    const CONTRACT = readFileSync("src/lib/net/detection-contract.ts", "utf8");
    expect(CONTRACT).toContain("export const DETECTION_CONTRACT_VERSION = 1 as const;");
  });
});

/* ───────────── R50-T071 — every failure class is audited ───────────── */

describe("R50-T071 — refusal audit events (route wiring)", () => {
  test("all five dedicated failure classes are emitted", () => {
    for (const action of [
      "DEVICE_PROBE_AUTH_REFUSED",
      "DEVICE_PROBE_TARGET_REFUSED",
      "DEVICE_PROBE_CREDENTIAL_REFUSED",
      "HOST_KEY_TRUST_LOOKUP_FAILED",
      "DEVICE_PROBE_HOST_KEY_MISMATCH",
    ]) {
      expect(ROUTE).toContain(`action: "${action}"`);
    }
  });

  test("emissions are best-effort via the shared helper (never a 500, never a success)", () => {
    expect(ROUTE).toContain("async function auditProbeFailureBestEffort");
    expect(ROUTE).toContain('console.error(`[auto-detect] ${entry.action} audit emission failed`');
    // every call site awaits the helper
    const callSites = ROUTE.split("await auditProbeFailureBestEffort(").length - 1;
    expect(callSites).toBe(6); // auth, target, credential×3 (not-found, type-unsupported, R50-T021 allowlist), mismatch
  });

  test("the unauthenticated authorization refusal audits a NULL actor BY DESIGN", () => {
    expect(ROUTE).toContain('let refusalActorName = "Anonymous"');
    expect(ROUTE).toContain("refusalActorId = sessionUser.id;");
    expect(ROUTE).toContain("the null-actor row is the truth");
  });

  test("the credential refusal records WHY (not-found vs type-unsupported)", () => {
    expect(ROUTE).toContain('reason: "not-found"');
    expect(ROUTE).toContain('reason: "type-unsupported"');
    expect(ROUTE).toContain("profileType: profile.type,");
  });

  test("rate-limit refusals are counted, NOT audited per-hit (anti-flooding, documented)", () => {
    expect(ROUTE).toContain('recordDetectionFailure("DEVICE_PROBE_RATE_LIMITED")');
    expect(ROUTE).toContain("NOT audited per-hit BY DESIGN");
  });

  test("timeout / unreachable / VENDOR_UNKNOWN ride the main event's typed codes (non-regression)", () => {
    expect(ROUTE).toContain('detectionErrorCode = "VENDOR_UNKNOWN"');
    expect(ROUTE).toContain('detectionError = "Worker service unreachable"');
    expect(ROUTE).toContain("result: detectionError ? \"FAILURE\" : \"SUCCESS\"");
  });
});

/* ───────────── the metrics read surface ───────────── */

describe("GET /api/v1/metrics/detection — the operational read surface", () => {
  test("exists, is gated by metrics.read, and answers the snapshot only", () => {
    expect(ENDPOINT).toContain('requirePermission(request, "metrics.read")');
    // the data payload is EXACTLY the snapshot — structurally incapable of
    // echoing per-invocation detail (hostnames, credential ids, fingerprints)
    expect(ENDPOINT).toContain("{ metrics: snapshotDetectionMetrics() }");
  });

  test("authErrorToFail mapping keeps the standard error envelope", () => {
    expect(ENDPOINT).toContain("authErrorToFail(error)");
  });

  test("metrics.read is a real matrix permission (operator/engineer/manager)", () => {
    const MATRIX = readFileSync("src/lib/auth/role-matrix.ts", "utf8");
    expect(MATRIX).toContain('"metrics.read"');
  });
});
