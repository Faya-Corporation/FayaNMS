import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * R50 Phase R50.4 — Detection API contract (R50-T040..T042).
 *
 * T040 — PARTIAL RESULTS: the auto-detect response reports the vendor stage
 * and the address-resolution stage INDEPENDENTLY (status + typed code per
 * block), so "detection matched, DNS failed" (or the inverse) is never
 * collapsed into one boolean.
 *
 * T041 — STABLE CODES: a closed, registry-governed code set answered
 * verbatim (the roadmap's recommended 15 + documented additions). Transport
 * strings from the worker and raw DNS errnos NEVER leak as codes — the
 * mappers translate them; unmapped worker strings share one honest bucket
 * (WORKER_REJECTED) with the raw text preserved in the stage message.
 *
 * T042 — VERSIONING: every response stamps contractVersion (= 1) in data
 * AND meta; a breaking shape/code change MUST bump
 * DETECTION_CONTRACT_VERSION, never rename a code in place.
 */

import {
  DETECTION_CONTRACT_VERSION,
  DETECTION_ERROR_CODES,
  mapResolutionToContractCode,
  mapWorkerErrorToDetectionCode,
} from "../../src/lib/net/detection-contract";

const ROUTE = readFileSync("src/app/api/v1/devices/auto-detect/route.ts", "utf8");
const CONTRACT = readFileSync("src/lib/net/detection-contract.ts", "utf8");
const HOOK = readFileSync("src/hooks/api/use-devices.ts", "utf8");
const ROADMAP = readFileSync(
  "docs/audits/FayaNMS-R50-Vendor-IP-Autodetect-Remediation-Roadmap-2026-09-16.md",
  "utf8",
);

/** The roadmap's recommended code block (section R50-T041), extracted. */
const RECOMMENDED_15: readonly (typeof DETECTION_ERROR_CODES)[number][] = [
  "PROBE_NOT_AUTHORIZED",
  "CREDENTIAL_NOT_AUTHORIZED",
  "CREDENTIAL_UNRESOLVED",
  "HOST_KEY_ENROLLMENT_LOOKUP_FAILED",
  "HOST_KEY_MISMATCH",
  "HOST_KEY_UNENROLLED",
  "TARGET_NOT_ALLOWED",
  "DNS_NOT_FOUND",
  "DNS_TIMEOUT",
  "IPV6_UNSUPPORTED",
  "SSH_CONNECT_TIMEOUT",
  "SSH_AUTH_FAILED",
  "SSH_COMMAND_REJECTED",
  "VENDOR_UNKNOWN",
  "DEVICE_PROBE_RATE_LIMITED",
];

describe("R50-T041 — the registry answers the recommended 15 verbatim", () => {
  test("every recommended code is registered, spelled exactly as the roadmap", () => {
    for (const code of RECOMMENDED_15) {
      expect(DETECTION_ERROR_CODES).toContain(code);
    }
  });

  test("the roadmap's own recommended list matches the registry (doc ↔ code pin)", () => {
    for (const code of RECOMMENDED_15) {
      expect(ROADMAP).toContain(code);
    }
  });

  test("the registry is CLOSED and registry-governed (breaking change ⇒ version bump)", () => {
    expect(DETECTION_ERROR_CODES).toHaveLength(21); // 15 recommended + 6 documented
    expect(CONTRACT).toContain("bump ONLY on a breaking change");
    expect(CONTRACT).toContain("DETECTION_CONTRACT_VERSION");
  });

  test("the route refuses probes with the registry codes, not ad-hoc strings", () => {
    expect(ROUTE).toContain('"PROBE_NOT_AUTHORIZED"');
    expect(ROUTE).toContain('"CREDENTIAL_UNRESOLVED"');
    expect(ROUTE).toContain('"CREDENTIAL_NOT_AUTHORIZED"');
    expect(ROUTE).toContain('"TARGET_NOT_ALLOWED"');
    expect(ROUTE).toContain('"DEVICE_PROBE_RATE_LIMITED"');
    expect(ROUTE).toContain('"HOST_KEY_ENROLLMENT_LOOKUP_FAILED"');
  });

  test("the renamed literals are gone (no ad-hoc credential codes remain)", () => {
    expect(ROUTE).not.toContain('"CREDENTIAL_PROFILE_NOT_FOUND"');
    expect(ROUTE).not.toContain('"DETECT_CREDENTIAL_TYPE_UNSUPPORTED"');
  });

  test("every mapper output is a registry member (no transport-string codes)", () => {
    const workerErrors = [
      "SSH_AUTH_FAILED: bad password",
      "SSH_TIMEOUT: handshake exceeded 15000ms",
      "SSH_UNREACHABLE: EHOSTUNREACH",
      "SSH_EXEC_FAILED: command rejected",
      "SSH_SESSION_FAILED: channel open failed",
      "SSH_HOSTKEY_MISMATCH: pin mismatch",
      "SSH_HOSTKEY_UNENROLLED: no pin",
      "SSH_HOSTKEY_PIN_INVALID: malformed pin",
      "CREDENTIAL_REF_INVALID: vault://ssh/none",
      "VAULT_PROVIDER_INVALID: bad provider",
      "VAULT_PROVIDER_MISCONFIGURED: env missing",
      "DETECT_NO_OUTPUT: no probe produced output",
      "Worker service unreachable",
      "Worker answered without a detection payload",
      "something entirely unexpected",
    ];
    for (const raw of workerErrors) {
      const code = mapWorkerErrorToDetectionCode(raw);
      expect(DETECTION_ERROR_CODES).toContain(code!);
    }
  });
});

describe("R50-T041 — worker-plane mapper matrix", () => {
  test("SSH transport codes map to their stable contract codes", () => {
    expect(mapWorkerErrorToDetectionCode("SSH_AUTH_FAILED: denied")).toBe("SSH_AUTH_FAILED");
    expect(mapWorkerErrorToDetectionCode("SSH_TIMEOUT: too slow")).toBe("SSH_CONNECT_TIMEOUT");
    expect(mapWorkerErrorToDetectionCode("SSH_UNREACHABLE: refused")).toBe("SSH_UNREACHABLE");
    expect(mapWorkerErrorToDetectionCode("SSH_EXEC_FAILED: no such cmd")).toBe(
      "SSH_COMMAND_REJECTED",
    );
    expect(mapWorkerErrorToDetectionCode("SSH_SESSION_FAILED: channel")).toBe(
      "SSH_SESSION_FAILED",
    );
    expect(mapWorkerErrorToDetectionCode("SSH_HOSTKEY_MISMATCH: pin")).toBe("HOST_KEY_MISMATCH");
    expect(mapWorkerErrorToDetectionCode("SSH_HOSTKEY_UNENROLLED: none")).toBe(
      "HOST_KEY_UNENROLLED",
    );
    expect(mapWorkerErrorToDetectionCode("SSH_HOSTKEY_PIN_INVALID: bad")).toBe(
      "HOST_KEY_MISMATCH",
    );
  });

  test("vault-plane codes map to CREDENTIAL_UNRESOLVED (probe never launched)", () => {
    expect(mapWorkerErrorToDetectionCode("CREDENTIAL_REF_INVALID: no ref")).toBe(
      "CREDENTIAL_UNRESOLVED",
    );
    expect(mapWorkerErrorToDetectionCode("VAULT_PROVIDER_MISCONFIGURED: env")).toBe(
      "CREDENTIAL_UNRESOLVED",
    );
  });

  test("DETECT_NO_OUTPUT → VENDOR_UNKNOWN (endpoint speaks SSH, no CLI matched)", () => {
    expect(mapWorkerErrorToDetectionCode("DETECT_NO_OUTPUT: nothing")).toBe("VENDOR_UNKNOWN");
  });

  test("route fallbacks and unknown strings land in honest buckets", () => {
    expect(mapWorkerErrorToDetectionCode("Worker service unreachable")).toBe(
      "WORKER_UNAVAILABLE",
    );
    expect(mapWorkerErrorToDetectionCode("Worker answered without a detection payload")).toBe(
      "WORKER_REJECTED",
    );
    expect(mapWorkerErrorToDetectionCode("Worker responded with HTTP 500")).toBe(
      "WORKER_REJECTED",
    );
    expect(mapWorkerErrorToDetectionCode("weird: but unmapped")).toBe("WORKER_REJECTED");
  });

  test("null/empty → null (nothing to report, never a fabricated code)", () => {
    expect(mapWorkerErrorToDetectionCode(null)).toBeNull();
    expect(mapWorkerErrorToDetectionCode(undefined)).toBeNull();
    expect(mapWorkerErrorToDetectionCode("")).toBeNull();
  });
});

describe("R50-T041 — DNS-plane mapper matrix", () => {
  test("a produced mapping reports null (nothing to report)", () => {
    expect(mapResolutionToContractCode("ip-literal", null)).toBeNull();
    expect(mapResolutionToContractCode("dns-a", null)).toBeNull();
  });

  test("the IPv4-only policy refusals → IPV6_UNSUPPORTED (resolver literal stays internal)", () => {
    expect(mapResolutionToContractCode("refused-ipv6-literal", "IPV6_MANAGEMENT_ADDRESS_UNSUPPORTED")).toBe(
      "IPV6_UNSUPPORTED",
    );
    expect(mapResolutionToContractCode("refused-aaaa-only", "IPV6_MANAGEMENT_ADDRESS_UNSUPPORTED")).toBe(
      "IPV6_UNSUPPORTED",
    );
  });

  test("DNS errnos split NOT_FOUND vs TIMEOUT; the rest is the honest catch-all", () => {
    expect(mapResolutionToContractCode("failed", "ENOTFOUND")).toBe("DNS_NOT_FOUND");
    expect(mapResolutionToContractCode("failed", "EMPTY_ANSWER")).toBe("DNS_NOT_FOUND");
    expect(mapResolutionToContractCode("failed", "ENODATA")).toBe("DNS_NOT_FOUND");
    expect(mapResolutionToContractCode("failed", "EAI_AGAIN")).toBe("DNS_TIMEOUT");
    expect(mapResolutionToContractCode("failed", "ETIMEOUT")).toBe("DNS_TIMEOUT");
    expect(mapResolutionToContractCode("failed", "ESERVFAIL")).toBe("DNS_LOOKUP_FAILED");
    expect(mapResolutionToContractCode("failed", "EMPTY_HOST")).toBe("DNS_LOOKUP_FAILED");
    expect(DETECTION_ERROR_CODES).toContain("DNS_LOOKUP_FAILED");
  });
});

describe("R50-T040 — partial results: independent stage blocks", () => {
  test("the route emits both blocks with status + code each", () => {
    expect(ROUTE).toContain("vendorDetection: vendorDetectionBlock");
    expect(ROUTE).toContain("addressResolution: addressResolutionBlock");
    expect(ROUTE).toContain("const vendorDetectionBlock = {");
    expect(ROUTE).toContain("const addressResolutionBlock = {");
    // each block carries its own status AND code
    expect(ROUTE).toContain("code: detectionErrorCode");
    expect(ROUTE).toContain("code: resolutionErrorCode");
  });

  test("the vendor block's outcome union names all four terminal states", () => {
    expect(ROUTE).toContain('"matched"');
    expect(ROUTE).toContain('"generic"');
    expect(ROUTE).toContain('"failed"');
    expect(ROUTE).toContain('"not-attempted"');
  });

  test("the resolution block distinguishes resolved / refused / failed", () => {
    expect(ROUTE).toContain('"resolved"');
    expect(ROUTE).toContain('"refused"');
    expect(ROUTE).toContain('"failed"');
  });

  test("the resolution stage runs unconditionally AFTER detection (partial success structure)", () => {
    // The DNS stage is not gated on the detection stage's success: a
    // detection transport failure must still answer the resolution block.
    const detectIdx = ROUTE.indexOf("let detection: WorkerDetection[\"detection\"] | null = null;");
    const resolveIdx = ROUTE.indexOf("const resolution = await resolveHostToIp(requestedHost);");
    expect(detectIdx).toBeGreaterThan(-1);
    expect(resolveIdx).toBeGreaterThan(detectIdx);
  });

  test("a completed detection with no certified family answers VENDOR_UNKNOWN, not failure", () => {
    expect(ROUTE).toContain('detection.vendorKey === "generic"');
    expect(ROUTE).toContain('"VENDOR_UNKNOWN"');
  });
});

describe("R50-T042 — contract versioning", () => {
  test("version is 1 and stamped on every surface", () => {
    expect(DETECTION_CONTRACT_VERSION).toBe(1);
    expect(ROUTE).toContain("contractVersion: DETECTION_CONTRACT_VERSION");
  });

  test("stamped in data AND meta (clients can read it either way)", () => {
    const okCall = ROUTE.slice(ROUTE.indexOf("return ok("));
    expect((okCall.match(/DETECTION_CONTRACT_VERSION/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test("EVERY error envelope of the route is stamped too (failWithMeta contract refusals)", () => {
    // The route answers its refusals through failWithMeta with the stamp.
    expect(ROUTE).toContain("failWithMeta");
    expect(ROUTE).not.toContain('fail("INVALID_BODY"');
    expect(ROUTE).not.toContain('fail("PROBE_NOT_AUTHORIZED"');
    expect(ROUTE).not.toContain('fail("TARGET_NOT_ALLOWED"');
    expect(ROUTE).not.toContain('fail("DEVICE_PROBE_RATE_LIMITED"');
    expect(ROUTE).not.toContain('fail("CREDENTIAL_UNRESOLVED"');
    expect(ROUTE).not.toContain('fail("CREDENTIAL_NOT_AUTHORIZED"');
    expect(ROUTE).not.toContain('fail("HOST_KEY_ENROLLMENT_LOOKUP_FAILED"');
  });

  test("the top-level errorCode is the vendor stage's code with resolution fallback", () => {
    expect(ROUTE).toContain("detectionErrorCode ?? resolutionErrorCode");
  });

  test("the audit trail carries the typed codes + version (R50-070 groundwork)", () => {
    expect(ROUTE).toContain("detectionErrorCode");
    expect(ROUTE).toContain("resolutionErrorCode");
    expect(ROUTE).toContain("contractVersion: DETECTION_CONTRACT_VERSION");
  });
});

describe("R50-T040/T041 — UI compatibility (legacy flat fields stay)", () => {
  test("every pre-R50.4 response field is still emitted", () => {
    for (const field of [
      "host: requestedHost",
      "requestedHost,",
      "connectionAddress: profile ? requestedHost : null",
      "mgmtIpResolution: {",
      "resolvedManagementIp,",
      "vendorStage,",
      "hostKeyState,",
      "detection,",
      "detected,",
      "probeCommand: command,",
      "latencyMs,",
      "hostKeyCaptured: capturedHostKey,",
      "error: detectionError",
    ]) {
      expect(ROUTE).toContain(field);
    }
  });

  test("the client type carries the typed contract (optional for older servers)", () => {
    expect(HOOK).toContain("contractVersion?: number");
    expect(HOOK).toContain("errorCode?: string | null");
    expect(HOOK).toContain("vendorDetection?: {");
    expect(HOOK).toContain("addressResolution?: {");
  });

  test("the client toasts copy keyed on the STABLE codes, not transport strings", () => {
    for (const code of [
      "HOST_KEY_MISMATCH",
      "SSH_AUTH_FAILED",
      "DNS_NOT_FOUND",
      "DNS_TIMEOUT",
      "IPV6_UNSUPPORTED",
      "WORKER_UNAVAILABLE",
    ]) {
      expect(HOOK).toContain(code);
    }
    // The legacy fallbacks stay (older servers / unmapped codes).
    expect(HOOK).toContain("IPV6_MANAGEMENT_ADDRESS_UNSUPPORTED");
  });
});
