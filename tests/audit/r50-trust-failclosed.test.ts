import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  resolveHostKeyTrustState,
  trustLookupFailureReason,
  type HostKeyTrustState,
} from "../../src/lib/ssh/host-keys";

/**
 * R50-T003 — SAFE-001 regression guard (roadmap Phase R50.0, priority P0).
 *
 * The P0 (R50-001): the auto-detect route swallowed enrollment-store
 * persistence errors into `pin = null` → `enrollHostKey: !pin` → the audited
 * FIRST-CONTACT capture mode — i.e. a trust-store outage silently re-enabled
 * credential exposure to whatever server answers the endpoint's address.
 *
 * This suite pins the fail-closed contract at BOTH layers:
 *
 *   1. the trust-state RESOLVER (R50-T002 type) distinguishes enrolled /
 *      PROVEN-unenrolled / lookup-failed, and NO persistence failure —
 *      timeout, connection refused, unexpected error, invalid coordinates —
 *      can EVER be classified as "unenrolled" (the roadmap's R50-T001 test
 *      matrix, executed behaviorally against the injectable lookup seam);
 *
 *   2. the ROUTE wiring aborts BEFORE the worker SSH connection on
 *      lookup-failed (typed HOST_KEY_ENROLLMENT_LOOKUP_FAILED + a dedicated
 *      audit event) and opts into capture ONLY on a proven-unenrolled state;
 *      the old fail-open literals are dead and pinned dead.
 *
 * Exit gate (roadmap): no code path may treat unknown trust state as first
 * contact. The worker plane's pre-connection refusal (SSH_HOSTKEY_UNENROLLED
 * unless enrollHostKey === true) is re-pinned as defense in depth.
 */

const ROUTE = readFileSync("src/app/api/v1/devices/auto-detect/route.ts", "utf8");
const WORKER_INDEX = readFileSync("mini-services/worker/index.ts", "utf8");

const VALID_FP = "SHA256:oZFPeF/+vk9aOqGvPbG7rjJwp6PQES9ik1JAknq41uc";
const enrolledRow = {
  fingerprint: VALID_FP,
  keyType: "ssh-ed25519",
  enrolledAt: new Date("2026-09-16T00:00:00Z"),
};

type LookupFailed = Extract<HostKeyTrustState, { state: "lookup-failed" }>;

/* ── R50-T002 — the trust-state resolver is explicit and fail-closed ── */

describe("R50-T002 — trust-state resolver (enrolled / unenrolled / lookup-failed)", () => {
  test("existing enrollment → enrolled with the pinned fingerprint", async () => {
    const state = await resolveHostKeyTrustState("10.20.0.5", 22, async () => enrolledRow);
    expect(state).toEqual({
      state: "enrolled",
      fingerprint: VALID_FP,
      keyType: "ssh-ed25519",
      enrolledAt: enrolledRow.enrolledAt,
    });
  });

  test("genuinely no enrollment → unenrolled (the ONLY capture-eligible state)", async () => {
    const state = await resolveHostKeyTrustState("10.20.0.5", 22, async () => null);
    expect(state).toEqual({ state: "unenrolled" });
  });

  test("DB timeout → lookup-failed, NEVER unenrolled", async () => {
    const state = await resolveHostKeyTrustState("10.20.0.5", 22, async () => {
      throw Object.assign(new Error("Timed out fetching a new connection from the pool"), {
        code: "P2024",
      });
    });
    expect(state).toEqual({ state: "lookup-failed", reason: "P2024" });
    expect((state as LookupFailed).state).not.toBe("unenrolled");
  });

  test("DB connection refused → lookup-failed, NEVER unenrolled", async () => {
    const state = await resolveHostKeyTrustState("10.20.0.5", 22, async () => {
      throw Object.assign(new Error("Can't reach database server"), { code: "P1001" });
    });
    expect(state).toEqual({ state: "lookup-failed", reason: "P1001" });
  });

  test("unexpected persistence error (no code) → lookup-failed TRUST_LOOKUP_UNKNOWN", async () => {
    const state = await resolveHostKeyTrustState("10.20.0.5", 22, async () => {
      throw new Error("relation SshHostKey does not exist");
    });
    expect(state).toEqual({ state: "lookup-failed", reason: "TRUST_LOOKUP_UNKNOWN" });
  });

  test("exotic rejection shapes still classify to lookup-failed (no path reaches unenrolled)", async () => {
    const rejections: unknown[] = [
      "string rejection",
      42,
      { code: "ECONNREFUSED" },
      Object.assign(new Error("x"), { errorCode: "P2023" }),
      new TypeError("cannot read properties of undefined"),
      undefined,
      null,
    ];
    for (const rejection of rejections) {
      const state = await resolveHostKeyTrustState("10.20.0.5", 22, async () => {
        throw rejection;
      });
      expect(state.state).toBe("lookup-failed");
      expect((state as LookupFailed).reason.length).toBeGreaterThan(0);
      expect((state as LookupFailed).reason).not.toContain("password");
    }
  });

  test("invalid endpoint coordinates are NOT proven first contact either", async () => {
    const invalid: Array<[string, number]> = [
      ["", 22],
      ["   ", 22],
      ["10.20.0.5", 0],
      ["10.20.0.5", 70000],
      ["10.20.0.5", 22.5],
    ];
    for (const [host, port] of invalid) {
      // Even a HEALTHY store with a matching row must not enroll an
      // endpoint we cannot normalize into a trustworthy identity.
      const state = await resolveHostKeyTrustState(host, port, async () => enrolledRow);
      expect(state).toEqual({
        state: "lookup-failed",
        reason: "TRUST_LOOKUP_INVALID_ENDPOINT",
      });
    }
  });

  test("the injected lookup seam receives the normalized host (no silent rewrites)", async () => {
    let seenHost = "";
    let seenPort = 0;
    await resolveHostKeyTrustState("  hq-core-01  ", 2222, async (host, port) => {
      seenHost = host;
      seenPort = port;
      return null;
    });
    expect(seenHost).toBe("hq-core-01");
    expect(seenPort).toBe(2222);
  });
});

describe("R50-T002 — trustLookupFailureReason classification (bounded, value-free)", () => {
  test("prefers code, then errorCode, then error class name", () => {
    expect(trustLookupFailureReason(Object.assign(new Error("x"), { code: "P1001" }))).toBe("P1001");
    expect(
      trustLookupFailureReason(Object.assign(new Error("x"), { errorCode: "P2024" }))
    ).toBe("P2024");
    expect(trustLookupFailureReason(new TypeError("boom"))).toBe("TypeError");
    expect(trustLookupFailureReason({ code: "ECONNREFUSED" })).toBe("ECONNREFUSED");
  });

  test("non-object / plain Error rejections degrade to the UNKNOWN marker", () => {
    expect(trustLookupFailureReason("boom")).toBe("TRUST_LOOKUP_UNKNOWN");
    expect(trustLookupFailureReason(42)).toBe("TRUST_LOOKUP_UNKNOWN");
    expect(trustLookupFailureReason(null)).toBe("TRUST_LOOKUP_UNKNOWN");
    expect(trustLookupFailureReason(undefined)).toBe("TRUST_LOOKUP_UNKNOWN");
    expect(trustLookupFailureReason(new Error(""))).toBe("TRUST_LOOKUP_UNKNOWN");
  });
});

/* ── R50-T001 — the route wiring is fail-closed before any connection ── */

describe("R50-T003 — auto-detect route: unknown trust state can never become first contact", () => {
  test("trust resolution happens BEFORE the worker SSH connection", () => {
    const trustIdx = ROUTE.indexOf("resolveHostKeyTrustState(");
    const fetchIdx = ROUTE.indexOf("await fetch(WORKER_URL");
    expect(trustIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(trustIdx);
  });

  test("lookup-failed → typed HOST_KEY_ENROLLMENT_LOOKUP_FAILED abort BEFORE the fetch", () => {
    const guardIdx = ROUTE.indexOf('trust.state === "lookup-failed"');
    const abortIdx = ROUTE.indexOf('"HOST_KEY_ENROLLMENT_LOOKUP_FAILED"');
    const fetchIdx = ROUTE.indexOf("await fetch(WORKER_URL");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(abortIdx).toBeGreaterThan(guardIdx);
    expect(abortIdx).toBeLessThan(fetchIdx);
    // The abort is a full early return, not a detectionError degradation:
    // degraded detection answers 200 with a result — trust-state unknown
    // must answer the typed refusal instead.
    expect(ROUTE.slice(guardIdx, fetchIdx)).toContain("return fail(");
  });

  test("trust-store failure emits a dedicated audit event (HOST_KEY_TRUST_LOOKUP_FAILED)", () => {
    expect(ROUTE).toContain('action: "HOST_KEY_TRUST_LOOKUP_FAILED"');
    // The audit payload records the bounded reason — not raw store errors.
    expect(ROUTE).toContain("reason: trust.reason");
  });

  test("capture mode is opted into ONLY for a PROVEN-unenrolled endpoint", () => {
    expect(ROUTE).toContain('enrollHostKey: trust.state === "unenrolled"');
  });

  test("the R50-001 fail-open literals are dead (pinned dead)", () => {
    // The old contract pin enshrined the defect (`enrollHostKey: !pin`);
    // remediation replaced it and this pin keeps it dead.
    expect(ROUTE).not.toContain("enrollHostKey: !pin");
    // The nullable lookup helper no longer feeds the capture decision.
    expect(ROUTE).not.toContain("getHostKeyPin(");
    // The swallowed-error comment that documented the fail-open is gone.
    expect(ROUTE).not.toContain("enrollment store hiccup");
  });

  test("the pin decision derives from the trust state, never from a bare catch", () => {
    // Between the trust resolution and the worker fetch, the ONLY thing that
    // sets `pin` is the enrolled-state ternary — no catch block assigns it.
    const trustIdx = ROUTE.indexOf("resolveHostKeyTrustState(");
    const fetchIdx = ROUTE.indexOf("await fetch(WORKER_URL");
    const block = ROUTE.slice(trustIdx, fetchIdx);
    expect(block).toContain('const pin = trust.state === "enrolled" ? trust.fingerprint : null;');
    expect(block).not.toMatch(/catch\s*(\([^)]*\))?\s*\{[^}]*pin\s*=/);
  });
});

/* ── defense in depth — the worker plane stays fail-closed ── */

describe("R50-T003 — worker plane invariance (defense in depth)", () => {
  test("/live/detect-vendor refuses unpinned LIVE detection without the explicit capture opt-in", () => {
    // The API route was the only fail-open plane; the worker's pre-connection
    // refusal is re-pinned so a future route regression cannot silently
    // weaken the whole chain.
    expect(WORKER_INDEX).toContain("SSH_HOSTKEY_UNENROLLED");
    expect(WORKER_INDEX).toContain("enrollmentMode = body?.enrollHostKey === true");
    expect(WORKER_INDEX).toContain("if (!hostKeyPin && !enrollmentMode)");
  });
});
