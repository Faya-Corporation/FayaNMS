import { db } from "@/lib/db";
import { fail, firstIssueMessage, newJobCorrelationId, ok, requestContext } from "../../_lib/api";
import { authErrorToFail, requirePermission } from "@/lib/auth/session";
import { getHostKeyPin } from "@/lib/ssh/host-keys";
import { resolveHostToIp } from "@/lib/dns/resolve-host";
import { workerControlHeaders } from "@/lib/worker/control-client";
import { WORKER_BASE_URL } from "@/lib/worker/worker-url";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/devices/auto-detect — R50 vendor auto-detection + hostname →
 * management-IP mapping, for the Add/Edit device sheet ("Detect vendor & IP").
 *
 * Order of operations mirrors the user-facing promise: FIRST attribute the
 * device's vendor (when reachable + credential available), THEN map the
 * hostname to its management address:
 *
 *   1. DNS stage (always): resolve `host` to a management address
 *      (IP literals pass through; hostnames go through DNS A → AAAA).
 *   2. Vendor stage (when credentialProfileId is provided): the worker
 *      execs ONLY the read-only DETECT_COMMANDS ("show version", "show
 *      system info", "get system status") over the real SSH transport and
 *      attributes the output to a certified vendor family
 *      (mini-services/worker/vendor-fingerprint.ts). SAFE-001: the enrolled
 *      host-key pin rides along when present; a first-contact target
 *      (unpinned) runs in audited capture mode and the presented host key is
 *      returned for out-of-band verification + enrollment.
 *
 * The endpoint NEVER mutates the device inventory — it is a form helper;
 * applying the result is the operator's submit action. Every invocation is
 * audited (DEVICE_VENDOR_AUTODETECTED).
 *
 * Graceful degradation (mirrors test-connection): a missing worker answers
 * 200 with detection=null + a human-readable error, never a 500.
 */

const WORKER_URL = `${WORKER_BASE_URL}/live/detect-vendor`;

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

  // Data-plane probe: same permission class as test-connection (operator +
  // engineer seeded), attributed to the session principal.
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "config.backup");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  const correlationId = newJobCorrelationId();
  const { host, credentialProfileId } = parsed.data;

  /* ── Stage 1: hostname → management address ─────────────────────────── */
  const resolution = await resolveHostToIp(host);

  /* ── Stage 2: vendor fingerprint over the real SSH transport ────────── */
  let detection: WorkerDetection["detection"] | null = null;
  let detectionError: string | null = null;
  let command: string | null = null;
  let latencyMs: number | null = null;
  let capturedHostKey: { keyType: string; fingerprint: string } | null = null;
  let vendorStage: "skipped-no-credential" | "executed" = "skipped-no-credential";

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

  if (profile) {
    vendorStage = "executed";
    // SAFE-001: the enrolled pin (host+port known_hosts model) rides on the
    // probe when the endpoint was already enrolled; a first-contact target
    // runs in audited capture mode (enrollHostKey=true) — the worker answers
    // with the presented key for out-of-band verification.
    const probeTarget = resolution.mgmtIp ?? host;
    let pin: string | null = null;
    try {
      const hostKeyPin = await getHostKeyPin(probeTarget, profile.port);
      pin = hostKeyPin?.fingerprint ?? null;
    } catch {
      pin = null; // enrollment store hiccup → first-contact capture path
    }

    try {
      const response = await fetch(WORKER_URL, {
        method: "POST",
        headers: workerControlHeaders(),
        body: JSON.stringify({
          host: probeTarget,
          credential: {
            username: profile.username,
            port: profile.port,
            secretRef: profile.secretRef,
          },
          sshHostKeyPin: pin ?? undefined,
          enrollHostKey: !pin,
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
      resourceLabel: host,
      result: detectionError ? "FAILURE" : "SUCCESS",
      correlationId,
      afterJson: JSON.stringify({
        host,
        mgmtIp: resolution.mgmtIp,
        resolutionMode: resolution.mode,
        resolutionError: resolution.resolutionError ?? null,
        vendorStage,
        vendorKey: detection?.vendorKey ?? null,
        confidence: detection?.confidence ?? null,
        model: detection?.model ?? null,
        osVersion: detection?.osVersion ?? null,
        probeCommand: command,
        error: detectionError,
      }),
    },
  });

  return ok(
    {
      host,
      mgmtIpResolution: {
        mgmtIp: resolution.mgmtIp,
        mode: resolution.mode,
        error: resolution.resolutionError ?? null,
      },
      vendorStage,
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
