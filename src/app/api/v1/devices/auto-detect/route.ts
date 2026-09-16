import { db } from "@/lib/db";
import { fail, firstIssueMessage, newJobCorrelationId, ok, requestContext } from "../../_lib/api";
import { authErrorToFail, requirePermission } from "@/lib/auth/session";
import { resolveHostKeyTrustState } from "@/lib/ssh/host-keys";
import { resolveHostToIp } from "@/lib/dns/resolve-host";
import { evaluateTargetPolicy } from "@/lib/net/target-policy";
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
 *      SSH_PASSWORD (actor→profile→scope enrichment is R50-T021). Resolved
 *      BEFORE any network activity.
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
 *      connection does not use DNS at all).
 *   8. Preview response — requestedHost / connectionAddress /
 *      resolvedManagementIp named explicitly (R50-T011), plus the original
 *      fields (UI compatibility).
 *
 * The endpoint NEVER mutates the device inventory — it is a form helper;
 * applying the result is the operator's submit action. Every invocation is
 * audited (DEVICE_VENDOR_AUTODETECTED, with the credential profile id and
 * the host-key state).
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
});

interface WorkerDetection {
  ok: boolean;
  host?: string;
  command?: string | null;
  latencyMs?: number;
  detection?: {
    vendorKey: string;
    confidence: "high" | "low";
    model: string | null;
    osVersion: string | null;
    evidence: string[];
  };
  hostKey?: { keyType: string; fingerprint: string };
  error?: string;
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400, requestContext(request));
  }

  /* ── Stage 1: authorization (R50-T020 dedicated probe permission) ───── */
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "device.detect");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  const correlationId = newJobCorrelationId();
  // R50-T011: the three endpoint identities are kept apart. requestedHost is
  // the operator-typed string; connectionAddress is what the worker actually
  // dials; resolvedManagementIp is the informational DNS mapping (stage 7).
  const requestedHost = parsed.data.host;
  const { credentialProfileId } = parsed.data;

  /* ── Stage 2: target policy (R50-T022/T023 — refuse special classes) ── */
  const targetPolicy = evaluateTargetPolicy(requestedHost);
  if (!targetPolicy.allowed) {
    await db.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName: actor.name ?? "Unknown user",
        action: "DEVICE_PROBE_TARGET_REFUSED",
        resourceType: "Device",
        resourceId: null,
        resourceLabel: requestedHost,
        result: "FAILURE",
        correlationId,
        afterJson: JSON.stringify({
          requestedHost,
          addressClass: targetPolicy.addressClass,
        }),
      },
    });
    return fail(
      "TARGET_NOT_ALLOWED",
      `Probe target refused by the target network policy (${targetPolicy.addressClass})`,
      403,
      requestContext(request),
    );
  }

  /* ── Stage 3: abuse control (R50-T024 — shared-store detection budgets) */
  for (const [dimension, key, limit] of [
    ["actor", `device-detect:actor:${actor.id}`, DETECT_RATE_PER_ACTOR],
    ["target", `device-detect:target:${requestedHost}`, DETECT_RATE_PER_TARGET],
  ] as const) {
    const slot = await getRateStore().hit(key, limit, DETECT_RATE_WINDOW_MS);
    if (!slot.allowed) {
      const refusal = fail(
        "DEVICE_PROBE_RATE_LIMITED",
        `Vendor detection ${dimension} budget exhausted — retry in ${slot.retryAfterSec}s`,
        429,
        requestContext(request),
      );
      refusal.headers.set("Retry-After", String(slot.retryAfterSec));
      return refusal;
    }
  }

  /* ── Stage 4: credential authorization ──────────────────────────────── */
  let profile: {
    id: string;
    type: string;
    username: string;
    port: number;
    secretRef: string;
  } | null = null;

  if (credentialProfileId) {
    profile = await db.credentialProfile.findUnique({
      where: { id: credentialProfileId },
      select: { id: true, type: true, username: true, port: true, secretRef: true },
    });
    if (!profile) {
      return fail(
        "CREDENTIAL_PROFILE_NOT_FOUND",
        "The selected credential profile does not exist",
        404,
        requestContext(request),
      );
    }
    if (profile.type !== "SSH_PASSWORD") {
      // Detection rides the SSH exec transport — API_TOKEN/SNMPV3/HTTPS
      // profiles cannot answer the read-only CLI probes.
      return fail(
        "DETECT_CREDENTIAL_TYPE_UNSUPPORTED",
        `Vendor detection over SSH requires an SSH_PASSWORD credential profile (got ${profile.type})`,
        400,
        requestContext(request),
      );
    }
  }

  /* ── Stages 5+6: host-key policy, then vendor detection ─────────────── */
  let detection: WorkerDetection["detection"] | null = null;
  let detectionError: string | null = null;
  let command: string | null = null;
  let latencyMs: number | null = null;
  let capturedHostKey: { keyType: string; fingerprint: string } | null = null;
  let vendorStage: "skipped-no-credential" | "executed" = "skipped-no-credential";
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
      return fail(
        "HOST_KEY_ENROLLMENT_LOOKUP_FAILED",
        "Host-key enrollment lookup failed — probe aborted before any connection (trust state unknown; fail-closed)",
        503,
        requestContext(request),
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
        } else {
          detection = payload.detection ?? null;
          command = payload.command ?? null;
          latencyMs = typeof payload.latencyMs === "number" ? Math.round(payload.latencyMs) : null;
          capturedHostKey = payload.hostKey ?? null;
          if (!detection) {
            detectionError = "Worker answered without a detection payload";
          }
        }
      }
    } catch {
      // Worker down / timeout — graceful degradation, never a 500.
      detectionError = "Worker service unreachable";
    }
  }

  /* ── Stage 6: hostname → management address (ONCE, informational) ───── */
  // R50-T013: resolved exactly once, AFTER detection; the result never
  // retargets the probe (the connection was already bound in stage 5).
  const resolution = await resolveHostToIp(requestedHost);
  const resolvedManagementIp = resolution.mgmtIp;

  /* ── Stage 7: preview response ──────────────────────────────────────── */
  // Audit every invocation (SUCCESS = the vendor stage produced a result,
  // whether high-confidence or honest generic; FAILURE = transport error).
  const detected = detection !== null && detection.vendorKey !== "generic";
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
        requestedHost,
        connectionAddress: profile ? requestedHost : null,
        resolvedManagementIp,
        resolutionMode: resolution.mode,
        resolutionError: resolution.resolutionError ?? null,
        vendorStage,
        vendorKey: detection?.vendorKey ?? null,
        confidence: detection?.confidence ?? null,
        model: detection?.model ?? null,
        osVersion: detection?.osVersion ?? null,
        probeCommand: command,
        credentialProfileId: profile?.id ?? null,
        hostKeyState,
        error: detectionError,
      }),
    },
  });

  return ok(
    {
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
    { correlationId },
  );
}
