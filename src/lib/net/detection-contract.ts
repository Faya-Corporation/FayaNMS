/**
 * R50.4 — Detection API contract (R50-T040 / R50-T041 / R50-T042).
 *
 * Single source of truth for the vendor auto-detection contract:
 *   - the STABLE, CLOSED error-code registry (R50-T041) — clients may switch
 *     on these literals; a code is only ever repurposed via a contract
 *     version bump (R50-T042), never renamed in place;
 *   - the pure mappers that translate worker-plane and DNS-plane failures
 *     into registry codes (transport error strings never leak as codes);
 *   - the contract version (R50-T042) stamped on every auto-detect
 *     response (data + meta) so clients can detect the shape they got.
 *
 * Partial results (R50-T040): the auto-detect response carries TWO
 * independent stage blocks — `vendorDetection` and `addressResolution` —
 * each with its own status + typed code, so a detection that succeeded but
 * a DNS that failed (or vice versa) is reported as what it is, never
 * collapsed into one boolean.
 *
 * This module is CLIENT-SAFE (no node/browser APIs): the same literals are
 * imported by the route, the React Query hook, and the contract tests.
 */

/** R50-T042 — bump ONLY on a breaking change to the response shape or codes. */
export const DETECTION_CONTRACT_VERSION = 1 as const;

/**
 * R50-T041 — the stable per-stage error codes (closed registry).
 *
 * The 15 codes recommended by the R50 roadmap verbatim, plus the honest
 * extras the two planes actually produce (worker transport codes, the DNS
 * catch-all, and the request-shape refusal). Registry-governed: ADDING a
 * code is additive; renaming or removing one is a breaking change and MUST
 * bump DETECTION_CONTRACT_VERSION.
 */
export const DETECTION_ERROR_CODES = [
  // ── the roadmap-recommended 15 ─────────────────────────────────────────
  /** Actor lacks the dedicated device.detect permission (or no session). */
  "PROBE_NOT_AUTHORIZED",
  /** The referenced credential profile cannot be used for probing (type/scope). */
  "CREDENTIAL_NOT_AUTHORIZED",
  /** The referenced credential profile does not exist / cannot be resolved. */
  "CREDENTIAL_UNRESOLVED",
  /** Trust-store lookup failed — probe aborted BEFORE any connection (fail-closed). */
  "HOST_KEY_ENROLLMENT_LOOKUP_FAILED",
  /** The presented SSH host key does not match the enrolled pin. */
  "HOST_KEY_MISMATCH",
  /** The endpoint has no enrolled host key and capture was not allowed. */
  "HOST_KEY_UNENROLLED",
  /** Target refused by the network target policy (loopback/metadata/…). */
  "TARGET_NOT_ALLOWED",
  /** DNS: the name does not resolve (ENOTFOUND / no usable answer). */
  "DNS_NOT_FOUND",
  /** DNS: the resolver timed out / temporary failure (EAI_AGAIN, ETIMEOUT). */
  "DNS_TIMEOUT",
  /** The target advertises IPv6 only — the inventory contract is IPv4-only. */
  "IPV6_UNSUPPORTED",
  /** SSH connect timeout against the endpoint. */
  "SSH_CONNECT_TIMEOUT",
  /** SSH authentication failed (credentials rejected). */
  "SSH_AUTH_FAILED",
  /** The SSH exec channel rejected the read-only probe command. */
  "SSH_COMMAND_REJECTED",
  /** Detection ran but no certified vendor family matched. */
  "VENDOR_UNKNOWN",
  /** Detection budget exhausted (per actor or per target). */
  "DEVICE_PROBE_RATE_LIMITED",
  // ── documented registry additions (worker transport + DNS + request) ──
  /** SSH layer could not reach the endpoint (network unreachable/refused). */
  "SSH_UNREACHABLE",
  /** SSH transport/session establishment failed (not auth, not timeout). */
  "SSH_SESSION_FAILED",
  /** DNS catch-all: resolver failure that is neither not-found nor timeout. */
  "DNS_LOOKUP_FAILED",
  /** The worker mini-service is down/unreachable — graceful degradation. */
  "WORKER_UNAVAILABLE",
  /** The worker rejected the request or answered an unusable payload. */
  "WORKER_REJECTED",
  /** Request body failed validation. */
  "INVALID_BODY",
] as const;

export type DetectionErrorCode = (typeof DETECTION_ERROR_CODES)[number];

/* ───────────────── worker-plane mapping ───────────────── */

/**
 * Worker SSH transport codes (mini-services/worker/ssh-transport.ts) →
 * stable contract codes. The worker's own wire codes are transport
 * reality; this mapping is what makes them CONTRACT.
 */
const WORKER_CODE_MAP: Record<string, DetectionErrorCode> = {
  SSH_AUTH_FAILED: "SSH_AUTH_FAILED",
  SSH_TIMEOUT: "SSH_CONNECT_TIMEOUT",
  SSH_UNREACHABLE: "SSH_UNREACHABLE",
  SSH_EXEC_FAILED: "SSH_COMMAND_REJECTED",
  SSH_SESSION_FAILED: "SSH_SESSION_FAILED",
  SSH_HOSTKEY_MISMATCH: "HOST_KEY_MISMATCH",
  SSH_HOSTKEY_UNENROLLED: "HOST_KEY_UNENROLLED",
  SSH_HOSTKEY_PIN_INVALID: "HOST_KEY_MISMATCH",
  // Vault plane: the probe was never launched because the credential
  // reference could not be resolved into a secret. (The worker's own
  // CREDENTIAL_UNRESOLVED is the same stable code — identity mapping.)
  CREDENTIAL_REF_INVALID: "CREDENTIAL_UNRESOLVED",
  CREDENTIAL_UNRESOLVED: "CREDENTIAL_UNRESOLVED",
  VAULT_PROVIDER_INVALID: "CREDENTIAL_UNRESOLVED",
  VAULT_PROVIDER_MISCONFIGURED: "CREDENTIAL_UNRESOLVED",
  // No read-only probe produced output: the endpoint speaks SSH but no
  // known CLI answered — no vendor could be attributed.
  DETECT_NO_OUTPUT: "VENDOR_UNKNOWN",
  // R50-T022 follow-up (worker-plane target policy): the worker refuses a
  // target whose RESOLVED address lands in a governed class, and a target
  // hostname that does not resolve (or blows its resolution budget) never
  // reaches a dial. These are the worker-side mirrors of the app-plane
  // literal policy — the codes are the SAME registry entries.
  SSH_TARGET_POLICY_REFUSED: "TARGET_NOT_ALLOWED",
  SSH_TARGET_UNRESOLVED: "DNS_NOT_FOUND",
  SSH_TARGET_RESOLVE_TIMEOUT: "DNS_TIMEOUT",
};

/**
 * Translate a worker error string ("CODE: human message" per the worker's
 * failure contract, or a bare fallback message) into a stable contract
 * code. Unknown prefixes → WORKER_REJECTED (the raw text stays in the
 * stage `message`; it NEVER becomes a code).
 */
export function mapWorkerErrorToDetectionCode(
  workerError: string | null | undefined
): DetectionErrorCode | null {
  if (!workerError) return null;
  const prefix = workerError.split(":")[0].trim();
  if (prefix in WORKER_CODE_MAP) return WORKER_CODE_MAP[prefix];
  // The route's own fetch-failure fallbacks (worker down / unusable body)
  // and every unrecognized worker string share one honest bucket.
  if (workerError === "Worker service unreachable") return "WORKER_UNAVAILABLE";
  return "WORKER_REJECTED";
}

/* ───────────────── DNS-plane mapping ───────────────── */

/**
 * Resolver plane (src/lib/dns/resolve-host.ts) → stable contract codes.
 *
 * `mode` decides the policy refusals (R50-T030/T031:
 * refused-ipv6-literal / refused-aaaa-only → IPV6_UNSUPPORTED — the
 * resolver's internal IPV6_MANAGEMENT_ADDRESS_UNSUPPORTED literal stays
 * resolver-internal and UI-pinned; the CONTRACT code is the registry's
 * IPV6_UNSUPPORTED). The DNS errno decides NOT_FOUND vs TIMEOUT;
 * everything else is the honest DNS_LOOKUP_FAILED. A produced mapping
 * (ip-literal / dns-a) reports null — nothing to report.
 */
export function mapResolutionToContractCode(
  mode: "ip-literal" | "dns-a" | "refused-ipv6-literal" | "refused-aaaa-only" | "failed",
  resolutionError: string | null | undefined
): DetectionErrorCode | null {
  if (mode === "ip-literal" || mode === "dns-a") return null;
  if (mode === "refused-ipv6-literal" || mode === "refused-aaaa-only") {
    return "IPV6_UNSUPPORTED";
  }
  switch (resolutionError) {
    case "ENOTFOUND":
    case "EMPTY_ANSWER":
    case "ENODATA":
      return "DNS_NOT_FOUND";
    case "EAI_AGAIN":
    case "ETIMEOUT":
    // R50-T025: the bounded resolver's budget-exceeded marker (the wait
    // raced past FAYANMS_RESOLVE_TIMEOUT_MS) shares the timeout code.
    case "DNS_TIMEOUT":
      return "DNS_TIMEOUT";
    default:
      return "DNS_LOOKUP_FAILED";
  }
}

/* ───────────────── Stage selection (R50.6 / R50-T064) ───────────────── */

/**
 * The two independent detection stages, named for stage-specific retry.
 * "vendor" = credential → host-key trust → worker SSH fingerprint probe;
 * "address" = the informational hostname → IPv4 management-address DNS
 * mapping. A retry MUST be able to re-run ONE stage without re-probing
 * the device over SSH (an address-only retry that redials the device is
 * not a retry — it is a second probe).
 */
export const DETECTION_STAGES = ["vendor", "address"] as const;
export type DetectionStage = (typeof DETECTION_STAGES)[number];

/**
 * R50-T064 — normalize the caller's optional stage selection into the two
 * execution booleans. Omitted/undefined selection = BOTH stages (the
 * historical full run); an explicit selection runs exactly the named
 * stages and reports the others as `skipped-not-requested` — never as a
 * failure, so a partial retry cannot masquerade as a partial outage.
 * Pure + total: unknown stage names cannot reach this function (the route
 * schema validates the enum first).
 */
export function resolveRequestedStages(
  requested?: readonly DetectionStage[],
): { vendor: boolean; address: boolean } {
  if (!requested || requested.length === 0) {
    return { vendor: true, address: true };
  }
  return {
    vendor: requested.includes("vendor"),
    address: requested.includes("address"),
  };
}
