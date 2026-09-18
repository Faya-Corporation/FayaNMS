import { db } from "@/lib/db";
import {
  fail,
  failWithMeta,
  firstIssueMessage,
  newJobCorrelationId,
  ok,
} from "../../_lib/api";
import { AuthError, requirePermission, requireUser } from "@/lib/auth/session";
import {
  observeDetectionDuration,
  recordDetectionFailure,
  recordDetectionOutcome,
  recordDetectionRequest,
  recordHostKeyMismatch,
  type DetectionOutcome,
} from "@/lib/metrics/detection-metrics";
import { resolveHostKeyTrustState } from "@/lib/ssh/host-keys";
import { resolveHostToIp, type HostResolutionMode } from "@/lib/dns/resolve-host";
import {
  DETECTION_CONTRACT_VERSION,
  mapResolutionToContractCode,
  mapWorkerErrorToDetectionCode,
  resolveRequestedStages,
  type DetectionErrorCode,
} from "@/lib/net/detection-contract";
import { evaluateTargetPolicy } from "@/lib/net/target-policy";
import {
  authorizeProbeCredential,
  parseProbeCredentialAllowlist,
} from "@/lib/security/probe-credential";
import { getRateStore } from "@/lib/api/rate-store";
import { workerControlHeaders } from "@/lib/worker/control-client";
import { WORKER_BASE_URL } from "@/lib/worker/worker-url";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/devices/auto-detect — R50 vendor auto-detection + hostname →
 * management-IP mapping, for the Add/Edit device sheet ("Detect vendor & IP").
 *
 * VENDOR-FIRST orchestration (R50-T010) — the stages run in the order the
 * user-facing promise states: FIRST attribute the device's vendor (when
 * reachable + credential available), THEN map the hostname to its
 * management address:
 *
 *   1. Authorization — requirePermission("device.detect") (R50-T020: the
 *      DEDICATED active-probe permission — operator + engineer + admin
 *      wildcard; no longer the broad config.backup class).
 *   2. Target policy — R50-T022/T023: the literal target is classified
 *      (loopback, cloud-metadata link-local, multicast, reserved → typed
 *      TARGET_NOT_ALLOWED refusal BEFORE any credential/trust/network
 *      work; FAYANMS_PROBE_ALLOW_SPECIAL=true is the documented lab
 *      escape hatch). Hostname targets resolve worker-side; the
 *      resolved-address policy check is a worker-plane follow-up.
 *   3. Abuse control — R50-T024: detection-specific budgets over the
 *      SHARED rate store (fleet-wide when FAYANMS_RATE_STORE=postgres),
 *      keyed per actor and per target; exhausted → typed
 *      DEVICE_PROBE_RATE_LIMITED 429 + Retry-After.
 *   4. Credential authorization — the referenced profile must exist and be
 *      SSH_PASSWORD, and (R50-T021) be authorized for ACTIVE PROBING: the
 *      actor → profile link is requirePermission("device.detect") + the
 *      optional FAYANMS_PROBE_CREDENTIAL_ALLOWLIST (csv of profile ids or
 *      names; unset = every profile usable — the documented single-tenant
 *      posture; set = fail-closed). The profile → tenant link passes
 *      structurally (single-tenant schema) and is RECORDED as such; the
 *      profile → target link is the two-plane target policy (stage 2
 *      literal class + the worker's resolved-address class, R50-T022
 *      follow-up). The FULL chain is audited on every invocation.
 *   5. Host-key policy — SAFE-001 (R50-T001): resolveHostKeyTrustState runs
 *      against the REQUESTED ENDPOINT (R50-T012 ADR: a detection probe's
 *      trust identity is the operator-typed host + credential port — never
 *      a DNS-derived address, so DNS health cannot flip trust semantics,
 *      which was finding R50-003). enrolled → the pin rides along;
 *      PROVEN-unenrolled → audited capture mode; lookup-FAILED → abort
 *      BEFORE any connection with the typed HOST_KEY_ENROLLMENT_LOOKUP_FAILED
 *      error + a dedicated audit event — unknown trust state is never first
 *      contact (fail-closed).
 *   6. Vendor detection — the worker dials connectionAddress (== the
 *      requested endpoint exactly as typed; NO DNS indirection, R50-T013)
 *      and execs ONLY the read-only DETECT_COMMANDS ("show version", "show
 *      system info", "get system status") over the real SSH transport,
 *      attributing the output to a certified vendor family
 *      (mini-services/worker/vendor-fingerprint.ts).
 *   7. Hostname resolution — resolveHostToIp(requestedHost) runs ONCE,
 *      AFTER detection, and is purely informational for the form
 *      (resolvedManagementIp). It NEVER retargets the probe (R50-T013:
 *      resolve once, bind the connection before any DNS is consulted —
 *      silent re-resolution is structurally impossible here because the
 *      connection does not use DNS at all). R50-T030/T031
 *      (ADR-management-address-policy): the mapping enforces the IPv4-only
 *      inventory contract — IPv6 literals and AAAA-only hostnames answer a
 *      typed IPV6_MANAGEMENT_ADDRESS_UNSUPPORTED result instead of a
 *      misleading success the form would reject on submit (R50-004); the
 *      A RRset pick is deterministic (R50-T033).
 *   8. Preview response — requestedHost / connectionAddress /
 *      resolvedManagementIp named explicitly (R50-T011), plus the original
 *      fields (UI compatibility).
 *
 * The endpoint NEVER mutates the device inventory — it is a form helper;
 * applying the result is the operator's submit action. Every invocation is
 * audited (DEVICE_VENDOR_AUTODETECTED, with the credential profile id and
 * the host-key state).
 *
 * R50.7 — Audit + telemetry (R50-T070/T071/T072):
 *   - T070: the DEVICE_VENDOR_AUTODETECTED evidence is STRUCTURED and
 *     non-secret — actor + correlationId (mirrored from the audit columns
 *     for self-contained exports), tenant (null BY DESIGN: single-tenant
 *     schema — reserved for the roadmap's shape, never silently omitted),
 *     requested host, connection address, resolved address, credential
 *     profile id, host-key state, vendor/model/version, the outcome literal
 *     (matched / vendor-unknown / failed / not-attempted), the typed error
 *     codes, the total route duration, and the match reasons.
 *   - T071: EVERY failure class is audited — authorization refusal
 *     (DEVICE_PROBE_AUTH_REFUSED, null actor when unauthenticated BY
 *     DESIGN), target-policy refusal (DEVICE_PROBE_TARGET_REFUSED),
 *     credential failure (DEVICE_PROBE_CREDENTIAL_REFUSED), trust-lookup
 *     failure (HOST_KEY_TRUST_LOOKUP_FAILED), host-key mismatch
 *     (DEVICE_PROBE_HOST_KEY_MISMATCH), timeout/unreachable/VENDOR_UNKNOWN
 *     (the main event with the typed codes). Refusal emissions are
 *     best-effort (a probe refusal must never become a 500 because the
 *     audit plane hiccuped — and never a success either).
 *   - T072: the operational counters (src/lib/metrics/detection-metrics.ts)
 *     tick on this route; readable at GET /api/v1/metrics/detection
 *     (metrics.read). Rate-limit refusals are counted but NOT audited
 *     per-hit BY DESIGN — the budget itself is the abuse control, and
 *     per-hit rows would let an attacker flood the audit plane.
 *
 * R50.4 — Detection API contract (R50-T040/T041/T042):
 *   - PARTIAL RESULTS: the success envelope carries TWO independent stage
 *     blocks — `vendorDetection` and `addressResolution` — each with its
 *     own status + typed code, so "detection succeeded, DNS failed" (or
 *     the inverse) is reported as what it is. All pre-R50.4 flat fields
 *     stay (UI compatibility; the flat `error` keeps its vendor-stage
 *     semantics).
 *   - STABLE CODES: every failure surface answers a registry code from
 *     src/lib/net/detection-contract.ts (DETECTION_ERROR_CODES) — in the
 *     error envelope (`error.code`) or in the stage blocks / top-level
 *     `errorCode` on a partial-success envelope. Transport strings from
 *     the worker are mapped through mapWorkerErrorToDetectionCode; DNS
 *     errnos through mapResolutionToContractCode. The recommended-15
 *     registry literals (PROBE_NOT_AUTHORIZED … DEVICE_PROBE_RATE_LIMITED)
 *     are answered verbatim.
 *   - VERSIONING: every response stamps `contractVersion` (= 1) in data
 *     AND meta; a breaking shape/code change MUST bump
 *     DETECTION_CONTRACT_VERSION, never rename a code in place.
 *
 * Graceful degradation (mirrors test-connection): a missing worker answers
 * 200 with detection=null + a human-readable error, never a 500.
 */

const WORKER_URL = `${WORKER_BASE_URL}/live/detect-vendor`;

/** R50-T024 — detection-specific budgets (per actor and per target / min). */
const DETECT_RATE_WINDOW_MS = 60_000;
const DETECT_RATE_PER_ACTOR = Number(process.env.FAYANMS_DETECT_RATE_LIMIT ?? 20);
const DETECT_RATE_PER_TARGET = Number(process.env.FAYANMS_DETECT_TARGET_RATE_LIMIT ?? 10);

const bodySchema = z.object({
  /** Hostname or management address of the target (no scheme, no path). */
  host: z
    .string()
    .trim()
    .min(1, "host is required")
    .max(253, "host is limited to 253 characters")
    .regex(
      /^[a-zA-Z0-9.:-]+$/,
      "Enter a hostname or IP address (letters, digits, dots, colons, hyphens)",
    ),
  /** Optional SSH credential profile (SSH_PASSWORD) for the live probe. */
  credentialProfileId: z.string().trim().max(64).optional(),
  /**
   * R50-T064 — stage-specific retry: name the stages to execute. Omitted
   * = both (the historical full run). A stage NOT named is reported as
   * `skipped-not-requested` (never a failure) and performs NO work — an
   * address-only retry must not re-probe the device over SSH.
   */
  stages: z
    .array(z.enum(["vendor", "address"]))
    .min(1, "stages must name at least one stage")
    .max(2)
    .optional(),
});

/**
 * R50-T071 — best-effort FAILURE audit emission for probe refusals.
 *
 * A refusal must never become a 500 because the audit plane hiccuped — and
 * must never become a success either: the typed refusal response IS the
 * contract, this emission is the evidence trail, and its failure is logged
 * (the same posture the trust-lookup path established in R50-T001).
 */
async function auditProbeFailureBestEffort(entry: {
  actorId: string | null;
  actorName: string;
  action: string;
  resourceLabel: string;
  correlationId: string;
  detail: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.auditEvent.create({
      data: {
        actorId: entry.actorId,
        actorName: entry.actorName,
        action: entry.action,
        resourceType: "Device",
        resourceId: null,
        resourceLabel: entry.resourceLabel,
        result: "FAILURE",
        correlationId: entry.correlationId,
        afterJson: JSON.stringify(entry.detail),
      },
    });
  } catch (auditError) {
    console.error(`[auto-detect] ${entry.action} audit emission failed`, auditError);
  }
}

/** The resolver result widened with the R50-T064 not-requested marker. */
interface RouteResolution {
  mgmtIp: string | null;
  mode: HostResolutionMode | "skipped-not-requested";
  resolutionError?: string;
}

interface WorkerDetection {
  ok: boolean;
  host?: string;
  command?: string | null;
  latencyMs?: number;
  // R50-T022 follow-up evidence (additive — older workers omit them): the
  // validated address the worker actually dialed + the policy decision.
  dialedAddress?: string;
  targetPolicy?: { checked: "literal" | "resolved"; addressClass: string };
  detection?: {
    vendorKey: string;
    confidence: "high" | "low";
    model: string | null;
    osVersion: string | null;
    evidence: string[];
    // R50.5 (R50-T052/T054): deterministic match reasons + banner
    // near-misses (optional so older worker payloads stay assignable).
    matchReasons?: string[];
    softMatches?: string[];
  };
  hostKey?: { keyType: string; fingerprint: string };
  /**
   * R61 P0 — first-contact capture is credential-free and DEFERS vendor
   * detection: the worker answers ok:true with the presented hostKey and
   * this flag, without running any credentialed probe. The operator pins
   * the key and re-runs detection (two-stage flow).
   */
  detectionDeferred?: boolean;
  error?: string;
}

export async function POST(request: Request) {
  // R50-T072: wall-clock start. Refusal paths return BEFORE the duration
  // observation — the duration distribution covers stage-running invocations
  // only (documented semantics in detection-metrics.ts).
  const startedAt = Date.now();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return failWithMeta("INVALID_BODY", "Request body must be valid JSON", 400, {
      contractVersion: DETECTION_CONTRACT_VERSION,
    });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return failWithMeta("INVALID_BODY", firstIssueMessage(parsed.error), 400, {
      contractVersion: DETECTION_CONTRACT_VERSION,
    });
  }

  // R50-T072: a WELL-FORMED detection request — counted from here on
  // (INVALID_BODY never enters the counters).
  recordDetectionRequest();
  // The correlation id exists from the first post-validation step so EVERY
  // refusal audit row (R50-T071) carries the same correlation surface as
  // the success rows.
  const correlationId = newJobCorrelationId();

  /* ── Stage 1: authorization (R50-T020 dedicated probe permission) ───── */
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "device.detect");
  } catch (error) {
    // R50-T041: the probe-permission refusal carries the stable
    // PROBE_NOT_AUTHORIZED code (status preserved from the AuthError).
    if (error instanceof AuthError) {
      // R50-T071: authorization refusals leave an audit trail. The actor is
      // identified when the session itself was valid (RBAC refusal); an
      // unauthenticated hit audits a NULL actor BY DESIGN (actorId is
      // nullable — no identity is fabricated).
      let refusalActorId: string | null = null;
      let refusalActorName = "Anonymous";
      try {
        const sessionUser = await requireUser(request);
        refusalActorId = sessionUser.id;
        refusalActorName = sessionUser.name ?? "Unknown user";
      } catch {
        /* unauthenticated / disabled — the null-actor row is the truth */
      }
      await auditProbeFailureBestEffort({
        actorId: refusalActorId,
        actorName: refusalActorName,
        action: "DEVICE_PROBE_AUTH_REFUSED",
        resourceLabel: parsed.data.host,
        correlationId,
        detail: {
          requestedHost: parsed.data.host,
          permission: "device.detect",
          reason: error.code,
        },
      });
      // R50-T072: refusal → failure_total with the registry reason.
      recordDetectionFailure("PROBE_NOT_AUTHORIZED");
      return failWithMeta(
        "PROBE_NOT_AUTHORIZED",
        error.message,
        error.status,
        { contractVersion: DETECTION_CONTRACT_VERSION }
      );
    }
    throw error;
  }

  // R50-T011: the three endpoint identities are kept apart. requestedHost is
  // the operator-typed string; connectionAddress is what the worker actually
  // dials; resolvedManagementIp is the informational DNS mapping (stage 7).
  const requestedHost = parsed.data.host;
  const { credentialProfileId } = parsed.data;
  // R50-T064: which of the two stages this invocation actually executes.
  const runStages = resolveRequestedStages(parsed.data.stages);

  /* ── Stage 2: target policy (R50-T022/T023 — refuse special classes) ── */
  const targetPolicy = evaluateTargetPolicy(requestedHost);
  if (!targetPolicy.allowed) {
    // R50-T071: refusal emissions are best-effort (the helper) — a probe
    // refusal must never become a 500 because the audit plane hiccuped.
    await auditProbeFailureBestEffort({
      actorId: actor.id,
      actorName: actor.name ?? "Unknown user",
      action: "DEVICE_PROBE_TARGET_REFUSED",
      resourceLabel: requestedHost,
      correlationId,
      detail: {
        requestedHost,
        addressClass: targetPolicy.addressClass,
      },
    });
    recordDetectionFailure("TARGET_NOT_ALLOWED");
    return failWithMeta(
      "TARGET_NOT_ALLOWED",
      `Probe target refused by the target network policy (${targetPolicy.addressClass})`,
      403,
      { contractVersion: DETECTION_CONTRACT_VERSION }
    );
  }

  /* ── Stage 3: abuse control (R50-T024 — shared-store detection budgets) */
  for (const [dimension, key, limit] of [
    ["actor", `device-detect:actor:${actor.id}`, DETECT_RATE_PER_ACTOR],
    ["target", `device-detect:target:${requestedHost}`, DETECT_RATE_PER_TARGET],
  ] as const) {
    const slot = await getRateStore().hit(key, limit, DETECT_RATE_WINDOW_MS);
    if (!slot.allowed) {
      const refusal = failWithMeta(
        "DEVICE_PROBE_RATE_LIMITED",
        `Vendor detection ${dimension} budget exhausted — retry in ${slot.retryAfterSec}s`,
        429,
        { contractVersion: DETECTION_CONTRACT_VERSION }
      );
      refusal.headers.set("Retry-After", String(slot.retryAfterSec));
      // R50-T072: counted, NOT audited per-hit BY DESIGN — the budget is
      // the abuse control, per-hit rows would let an attacker flood the
      // audit plane (see the route docstring).
      recordDetectionFailure("DEVICE_PROBE_RATE_LIMITED");
      return refusal;
    }
  }

  /* ── Stage 4: credential authorization (R50-T021 chain) ────────────── */
  // The optional probe-credential allowlist is read AT REQUEST TIME (the
  // same posture as the target-policy escape hatch) so operators can
  // tighten probing without a redeploy. null = not enforced (documented
  // single-tenant default posture — the RBAC gate still bounds who).
  const probeAllowlist = parseProbeCredentialAllowlist(
    process.env.FAYANMS_PROBE_CREDENTIAL_ALLOWLIST,
  );
  // R50-T021: the actor → profile → tenant → target chain as EVIDENCE —
  // attached to every audit row this invocation produces (null profileId
  // = no credential requested / vendor stage not requested).
  const credentialAuthorization: Record<string, unknown> = {
    profileId: credentialProfileId ?? null,
    profileName: null as string | null,
    profileType: null as string | null,
    decision: null as string | null,
    allowlistEnforced: probeAllowlist !== null,
    tenantScope: "single-tenant",
    actorPermission: "device.detect",
    targetPolicyClass: targetPolicy.addressClass,
    resolvedAddressPolicy: null as unknown,
  };

  let profile: {
    id: string;
    name: string;
    type: string;
    username: string;
    port: number;
    secretRef: string;
  } | null = null;

  if (credentialProfileId && runStages.vendor) {
    // (R50-T064: the credential plane exists ONLY for the vendor probe —
    // an address-only retry is not asked to validate it.)
    profile = await db.credentialProfile.findUnique({
      where: { id: credentialProfileId },
      select: { id: true, name: true, type: true, username: true, port: true, secretRef: true },
    });
    if (!profile) {
      credentialAuthorization.decision = "not-found";
      // R50-T041: stable registry code (was CREDENTIAL_PROFILE_NOT_FOUND).
      // R50-T071: the credential failure is audited.
      await auditProbeFailureBestEffort({
        actorId: actor.id,
        actorName: actor.name ?? "Unknown user",
        action: "DEVICE_PROBE_CREDENTIAL_REFUSED",
        resourceLabel: requestedHost,
        correlationId,
        detail: {
          requestedHost,
          credentialProfileId,
          reason: "not-found",
          credentialAuthorization,
        },
      });
      recordDetectionFailure("CREDENTIAL_UNRESOLVED");
      return failWithMeta(
        "CREDENTIAL_UNRESOLVED",
        "The selected credential profile does not exist",
        404,
        { contractVersion: DETECTION_CONTRACT_VERSION }
      );
    }
    if (profile.type !== "SSH_PASSWORD") {
      credentialAuthorization.decision = "type-unsupported";
      credentialAuthorization.profileType = profile.type;
      // Detection rides the SSH exec transport — API_TOKEN/SNMPV3/HTTPS
      // profiles cannot answer the read-only CLI probes.
      // R50-T041: stable registry code (was DETECT_CREDENTIAL_TYPE_UNSUPPORTED).
      // R50-T071: the credential failure is audited (profile type recorded).
      await auditProbeFailureBestEffort({
        actorId: actor.id,
        actorName: actor.name ?? "Unknown user",
        action: "DEVICE_PROBE_CREDENTIAL_REFUSED",
        resourceLabel: requestedHost,
        correlationId,
        detail: {
          requestedHost,
          credentialProfileId,
          reason: "type-unsupported",
          profileType: profile.type,
          credentialAuthorization,
        },
      });
      recordDetectionFailure("CREDENTIAL_NOT_AUTHORIZED");
      return failWithMeta(
        "CREDENTIAL_NOT_AUTHORIZED",
        `Vendor detection over SSH requires an SSH_PASSWORD credential profile (got ${profile.type})`,
        403,
        { contractVersion: DETECTION_CONTRACT_VERSION }
      );
    }
    // R50-T021: the profile is existent + type-supported — the remaining
    // link is the PROBE-USE authorization (allowlist; fail-closed when
    // enforced). Refusal = stable CREDENTIAL_NOT_AUTHORIZED + audit.
    const authorization = authorizeProbeCredential({
      profileId: profile.id,
      profileName: profile.name,
      allowlist: probeAllowlist,
    });
    credentialAuthorization.profileName = profile.name;
    credentialAuthorization.profileType = profile.type;
    credentialAuthorization.decision = authorization.decision;
    if (authorization.decision === "refused-not-allowlisted") {
      await auditProbeFailureBestEffort({
        actorId: actor.id,
        actorName: actor.name ?? "Unknown user",
        action: "DEVICE_PROBE_CREDENTIAL_REFUSED",
        resourceLabel: requestedHost,
        correlationId,
        detail: {
          requestedHost,
          credentialProfileId,
          reason: "profile-not-allowlisted",
          credentialAuthorization,
        },
      });
      recordDetectionFailure("CREDENTIAL_NOT_AUTHORIZED");
      return failWithMeta(
        "CREDENTIAL_NOT_AUTHORIZED",
        "The selected credential profile is not authorized for active probing",
        403,
        { contractVersion: DETECTION_CONTRACT_VERSION }
      );
    }
  }

  /* ── Stages 5+6: host-key policy, then vendor detection ─────────────── */
  let detection: WorkerDetection["detection"] | null = null;
  let detectionError: string | null = null;
  // R50-T041: the vendor stage's stable code — mapped from the worker's
  // transport error string, the route's own fallbacks, or VENDOR_UNKNOWN
  // when detection completed but no certified family matched (generic).
  let detectionErrorCode: DetectionErrorCode | null = null;
  let command: string | null = null;
  let latencyMs: number | null = null;
  let capturedHostKey: { keyType: string; fingerprint: string } | null = null;
  let vendorStage: "skipped-no-credential" | "executed" | "skipped-not-requested" =
    runStages.vendor ? "skipped-no-credential" : "skipped-not-requested";
  // R50-T070 groundwork: the audit records which trust path the probe took.
  let hostKeyState: "not-probed" | "pinned" | "capture-requested" = "not-probed";

  if (profile) {
    vendorStage = "executed";
    // R50-T012 (ADR-host-key-trust-identity): the trust identity of a
    // DETECTION probe is the requested endpoint — the exact string the
    // worker will dial — plus the credential port. It is deliberately NOT
    // a DNS-derived address: a DNS failure must never silently switch the
    // trust identity (the R50-003 finding).
    const connectionAddress = requestedHost;

    // SAFE-001 / R50-T001: the trust state is resolved EXPLICITLY —
    // enrolled, PROVEN-unenrolled, or lookup-failed. The R50-001 P0
    // fail-open (a persistence error swallowed into a null pin, which the
    // capture decision then read as first contact) is structurally
    // impossible here: a lookup failure returns the typed
    // HOST_KEY_ENROLLMENT_LOOKUP_FAILED error BEFORE the worker SSH
    // connection is attempted, with a dedicated audit event.
    const trust = await resolveHostKeyTrustState(connectionAddress, profile.port);
    if (trust.state === "lookup-failed") {
      try {
        await db.auditEvent.create({
          data: {
            actorId: actor.id,
            actorName: actor.name ?? "Unknown user",
            action: "HOST_KEY_TRUST_LOOKUP_FAILED",
            resourceType: "Device",
            resourceId: null,
            resourceLabel: requestedHost,
            result: "FAILURE",
            correlationId,
            afterJson: JSON.stringify({
              requestedHost,
              connectionAddress,
              port: profile.port,
              reason: trust.reason,
            }),
          },
        });
      } catch (auditError) {
        // The trust store is already unusable; the audit plane may share its
        // fate. The typed refusal below is the operator-facing contract —
        // this emission is best-effort and its failure is logged, never
        // converted into a success path.
        console.error("[auto-detect] trust-lookup audit emission failed", auditError);
      }
      recordDetectionFailure("HOST_KEY_ENROLLMENT_LOOKUP_FAILED");
      return failWithMeta(
        "HOST_KEY_ENROLLMENT_LOOKUP_FAILED",
        "Host-key enrollment lookup failed — probe aborted before any connection (trust state unknown; fail-closed)",
        503,
        { contractVersion: DETECTION_CONTRACT_VERSION }
      );
    }
    // enrolled → the pin rides on the probe (verified pre-auth by the
    // worker); PROVEN-unenrolled → the audited first-contact capture, with
    // the presented key returned for out-of-band verification.
    const pin = trust.state === "enrolled" ? trust.fingerprint : null;
    hostKeyState = trust.state === "enrolled" ? "pinned" : "capture-requested";

    try {
      const response = await fetch(WORKER_URL, {
        method: "POST",
        headers: workerControlHeaders(),
        body: JSON.stringify({
          // R50-T013: the connection target is bound to the requested
          // endpoint BEFORE any DNS is consulted — DNS cannot retarget the
          // probe during this request.
          host: connectionAddress,
          credential: {
            username: profile.username,
            port: profile.port,
            secretRef: profile.secretRef,
          },
          sshHostKeyPin: pin ?? undefined,
          // R50-T001: capture mode ONLY for a PROVEN-unenrolled endpoint —
          // never for an unknown trust state (the resolver aborts above).
          enrollHostKey: trust.state === "unenrolled",
        }),
        // Up to three read-only probes, each a full SSH handshake.
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        let rejectionMessage = `Worker responded with HTTP ${response.status}`;
        try {
          const errBody = (await response.json()) as { error?: string } | null;
          if (errBody && typeof errBody.error === "string" && errBody.error.trim()) {
            rejectionMessage = errBody.error.trim();
          }
        } catch {
          /* keep the generic status message */
        }
        detectionError = rejectionMessage;
        detectionErrorCode = mapWorkerErrorToDetectionCode(rejectionMessage);
      } else {
        let payload: WorkerDetection | null = null;
        try {
          payload = (await response.json()) as WorkerDetection;
        } catch {
          payload = null;
        }
        if (!payload || typeof payload !== "object" || payload.ok !== true) {
          detectionError =
            payload && typeof payload === "object" && typeof payload.error === "string"
              ? payload.error
              : "Worker answered without a detection result";
          detectionErrorCode = mapWorkerErrorToDetectionCode(detectionError);
        } else {
          detection = payload.detection ?? null;
          command = payload.command ?? null;
          latencyMs = typeof payload.latencyMs === "number" ? Math.round(payload.latencyMs) : null;
          capturedHostKey = payload.hostKey ?? null;
          // R50-T021/T022-fu: the worker's resolved-address policy decision
          // completes the profile → target link of the authorization chain.
          credentialAuthorization.resolvedAddressPolicy = payload.targetPolicy ?? null;
          if (payload.detectionDeferred === true) {
            // R61 P0 — the credential-free first-contact capture succeeded.
            // This is a SUCCESS of the capture stage, NOT a detection
            // failure: no detectionError, no failure metric. The UI's
            // hostKeyState is already "capture-requested" and the presented
            // key rides the response (hostKeyCaptured) — the operator pins
            // it and re-runs detection over the pinned path.
            if (!capturedHostKey) {
              detectionError = "Worker deferred detection without a captured host key";
              detectionErrorCode = mapWorkerErrorToDetectionCode(detectionError);
            }
          } else if (!detection) {
            detectionError = "Worker answered without a detection payload";
            detectionErrorCode = mapWorkerErrorToDetectionCode(detectionError);
          } else if (detection.vendorKey === "generic") {
            // R50-T041: a completed detection that matched no certified
            // family is a stable, non-failure situation — VENDOR_UNKNOWN.
            detectionErrorCode = "VENDOR_UNKNOWN";
          }
        }
      }
    } catch {
      // Worker down / timeout — graceful degradation, never a 500.
      detectionError = "Worker service unreachable";
      detectionErrorCode = mapWorkerErrorToDetectionCode(detectionError);
    }

    // R50-T071: a PRESENTED key that fails the enrolled pin is its own
    // audit class — the credential was never the problem, the ENDPOINT's
    // identity was. The worker rejects pre-auth (SAFE-001), so this row
    // records a possible first-contact substitution attempt against a
    // pinned coordinate. host_key_mismatch_total ticks alongside (R50-T072;
    // failure_total ticks once at the end path with the same code).
    if (detectionErrorCode === "HOST_KEY_MISMATCH") {
      await auditProbeFailureBestEffort({
        actorId: actor.id,
        actorName: actor.name ?? "Unknown user",
        action: "DEVICE_PROBE_HOST_KEY_MISMATCH",
        resourceLabel: requestedHost,
        correlationId,
        detail: {
          requestedHost,
          connectionAddress,
          port: profile.port,
          credentialProfileId: profile.id,
          workerMessage: detectionError,
        },
      });
      recordHostKeyMismatch();
    }
  }

  /* ── Stage 6: hostname → management address (ONCE, informational) ───── */
  // R50-T013: resolved exactly once, AFTER detection; the result never
  // retargets the probe (the connection was already bound in stage 5).
  // R50-T064: an address-only selection skips the probe above; a
  // vendor-only selection skips THIS — the stub is reported as
  // skipped-not-requested, never as a DNS failure.
  let resolution: RouteResolution;
  let resolutionErrorCode: DetectionErrorCode | null;
  if (runStages.address) {
    const resolved = await resolveHostToIp(requestedHost);
    resolution = resolved;
    // R50-T041: the resolution stage's stable code (IPV6_UNSUPPORTED for
    // the IPv4-only policy refusals, DNS_NOT_FOUND / DNS_TIMEOUT / …).
    resolutionErrorCode = mapResolutionToContractCode(
      resolved.mode,
      resolved.resolutionError ?? null,
    );
  } else {
    resolution = { mgmtIp: null, mode: "skipped-not-requested" };
    resolutionErrorCode = null;
  }
  const resolvedManagementIp = resolution.mgmtIp;

  /* ── Stage 7: preview response ──────────────────────────────────────── */
  // Audit every invocation (SUCCESS = the vendor stage produced a result,
  // whether high-confidence or honest generic; FAILURE = transport error).
  const detected = detection !== null && detection.vendorKey !== "generic";
  // R61 P0: a credential-free first-contact capture DEFERS vendor detection
  // by design — the invocation's action (the capture) SUCCEEDED, so it must
  // not tick the failure metric nor audit as FAILURE. Outcome is
  // "not-attempted" (no vendor attempt was made), the audit row is SUCCESS,
  // and the presented key rides hostKeyCaptured for the pin-then-rerun flow.
  const captureDeferred =
    vendorStage === "executed" && detection === null && detectionError === null && capturedHostKey !== null;
  // R50-T070: one explicit OUTCOME literal per invocation — the vendor
  // stage is the primary action; a skipped vendor stage is `not-attempted`
  // even when the address stage failed (THAT failure still reaches the
  // operational metrics below, with its resolution code as the reason).
  const outcome: DetectionOutcome =
    vendorStage === "executed"
      ? detected
        ? "matched"
        : captureDeferred
          ? "not-attempted"
          : detection !== null
            ? "vendor-unknown"
            : "failed"
      : "not-attempted";
  // R50-T072: route wall-clock duration (the worker's latencyMs is the
  // probe leg only; this is the whole handler). Refusal paths return
  // before this line — the distribution covers stage-running invocations
  // only (documented semantics in detection-metrics.ts).
  const durationMs = Date.now() - startedAt;
  observeDetectionDuration(durationMs);
  // R50-T072: the operational counters (semantics in detection-metrics.ts;
  // recordDetectionFailure increments failure_total — never combine it with
  // recordDetectionOutcome("failed")).
  switch (outcome) {
    case "matched":
    case "vendor-unknown":
      recordDetectionOutcome(outcome);
      break;
    case "failed":
      recordDetectionFailure(detectionErrorCode ?? resolutionErrorCode ?? "WORKER_REJECTED");
      break;
    case "not-attempted":
      // No probe was asked for; the invocation still FAILED operationally
      // when the REQUESTED address stage failed (e.g. DNS_NOT_FOUND).
      if (resolutionErrorCode) {
        recordDetectionFailure(resolutionErrorCode);
      }
      break;
  }
  await db.auditEvent.create({
    data: {
      actorId: actor.id,
      actorName: actor.name ?? "Unknown user",
      action: "DEVICE_VENDOR_AUTODETECTED",
      resourceType: "Device",
      resourceId: null,
      resourceLabel: requestedHost,
      result: detectionError ? "FAILURE" : "SUCCESS",
      correlationId,
      afterJson: JSON.stringify({
        // R50-T070: the structured NON-SECRET evidence. actor + correlation
        // mirror the audit columns so exports are self-contained; tenant is
        // null BY DESIGN (single-tenant schema — the field is reserved for
        // the roadmap's shape, never silently omitted); outcome + durationMs
        // make the row comparable without replaying the request.
        actorId: actor.id,
        correlationId,
        tenant: null,
        outcome,
        durationMs,
        requestedHost,
        connectionAddress: profile ? requestedHost : null,
        resolvedManagementIp,
        resolutionMode: resolution.mode,
        resolutionError: resolution.resolutionError ?? null,
        vendorStage,
        // R50-T064 groundwork: record what the invocation ASKED to run.
        requestedStages: parsed.data.stages ?? null,
        vendorKey: detection?.vendorKey ?? null,
        confidence: detection?.confidence ?? null,
        model: detection?.model ?? null,
        osVersion: detection?.osVersion ?? null,
        // R50-T052: the deterministic matched-signature ids (audit trail
        // records WHY the vendor was claimed, not just that it was).
        matchReasons: detection?.matchReasons ?? null,
        softMatches: detection?.softMatches ?? null,
        probeCommand: command,
        credentialProfileId: profile?.id ?? null,
        hostKeyState,
        // R50-T021: the actor → profile → tenant → target authorization
        // chain (decision, allowlist enforcement state, both policy
        // classes) — the probe's full authorization evidence.
        credentialAuthorization,
        // R50-T041/T042: the typed stage codes + the contract version ride
        // in the audit trail next to the human-readable error.
        detectionErrorCode,
        resolutionErrorCode,
        contractVersion: DETECTION_CONTRACT_VERSION,
        error: detectionError,
      }),
    },
  });

  // R50-T040: the two stages are reported INDEPENDENTLY — each block owns
  // its status + typed code, so a partial outcome (vendor matched, DNS
  // failed; or detection failed, IP resolved) is never collapsed into one
  // boolean. Both blocks are additive; the flat legacy fields below stay.
  const vendorDetectionBlock = {
    // R50-T064: "skipped-not-requested" joins the status union — a stage
    // the caller did not request is a no-op, not a failure.
    status: vendorStage,
    outcome:
      detection !== null && detection.vendorKey !== "generic"
        ? ("matched" as const)
        : detection !== null
          ? ("generic" as const)
          : vendorStage === "executed"
            ? ("failed" as const)
            : ("not-attempted" as const),
    code: detectionErrorCode,
    message: detectionError,
    detection,
    probeCommand: command,
    latencyMs,
    hostKeyState,
    hostKeyCaptured: capturedHostKey,
  };
  const addressResolutionBlock = {
    status: resolution.mode === "skipped-not-requested"
      ? ("skipped-not-requested" as const)
      : resolvedManagementIp
        ? ("resolved" as const)
        : resolution.mode === "refused-ipv6-literal" || resolution.mode === "refused-aaaa-only"
          ? ("refused" as const)
          : ("failed" as const),
    code: resolutionErrorCode,
    // Raw plane detail (DNS errno / the resolver's typed refusal) — the
    // contract code above is the stable surface, this is the diagnostic.
    message: resolution.resolutionError ?? null,
    mgmtIp: resolvedManagementIp,
    mode: resolution.mode,
  };
  // Top-level typed outcome: the vendor stage is the primary action; its
  // code wins, the resolution stage's code is the fallback.
  const errorCode: DetectionErrorCode | null = detectionErrorCode ?? resolutionErrorCode;

  return ok(
    {
      // R50.4 contract stamp (R50-T042) + the two independent stage blocks
      // (R50-T040) + the stable top-level code (R50-T041).
      contractVersion: DETECTION_CONTRACT_VERSION,
      vendorDetection: vendorDetectionBlock,
      addressResolution: addressResolutionBlock,
      errorCode,
      // R50-T011 naming + the original fields (UI compatibility).
      host: requestedHost,
      requestedHost,
      connectionAddress: profile ? requestedHost : null,
      mgmtIpResolution: {
        mgmtIp: resolvedManagementIp,
        mode: resolution.mode,
        error: resolution.resolutionError ?? null,
      },
      resolvedManagementIp,
      vendorStage,
      hostKeyState,
      detection,
      detected,
      probeCommand: command,
      latencyMs,
      hostKeyCaptured: capturedHostKey,
      error: detectionError,
    },
    { correlationId, contractVersion: DETECTION_CONTRACT_VERSION },
  );
}
