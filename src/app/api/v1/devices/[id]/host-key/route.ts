import { db } from "@/lib/db";
import { isLiveWebApiVendor } from "@/lib/devices/live-transport";
import { fail, firstIssueMessage, newJobCorrelationId, ok } from "../../../_lib/api";
import {
  AuthError,
  authErrorToFail,
  requirePermission,
  requireSiteScope,
  sessionScopeFor,
} from "@/lib/auth/session";
import { sessionAllowsSite } from "@/lib/auth/scope";
import {
  getEnrollment,
  isValidHostKeyFingerprint,
  normalizeHostKeyFingerprint,
} from "@/lib/ssh/host-keys";
import { workerControlHeaders } from "@/lib/worker/control-client";
import { WORKER_BASE_URL } from "@/lib/worker/worker-url";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * SAFE-001 (audit P0-001) — SSH host-key enrollment for a device.
 *
 *   GET     → the current enrollment for the device's SSH endpoint
 *             (mgmtIp + credential port), or null when unenrolled.
 *   POST    → ENROLLMENT PROBE: connects to the device over the worker
 *             (enrollHostKey=true) and answers with the PRESENTED host key
 *             { keyType, fingerprint } — nothing is stored. The operator
 *             verifies the fingerprint out-of-band, then confirms.
 *   PUT     → stores/overwrites the enrollment for the endpoint
 *             (fingerprint format-validated; audited SSH_HOSTKEY_ENROLLED).
 *   DELETE  → revokes the enrollment (audited SSH_HOSTKEY_REVOKED) — the
 *             endpoint becomes fail-closed (all live connections refused).
 *
 * Permission: config.backup (the same class the data-plane probes use).
 * Every action is attributed to the session principal and audited.
 *
 * F-031 (site scoping — device-domain wave 7):
 *   - GET is a READ: the enrollment answer includes the endpoint's host
 *     and port, so it is gated by the sessionAllowsSite row predicate with
 *     404-NOT-403 parity — an out-of-scope device gets the SAME
 *     DEVICE_NOT_FOUND envelope a wildcard session gets for a missing one
 *     (a 403 would leak the device's existence).
 *   - POST/PUT/DELETE are MUTATIONS (a probe opens a live connection; a
 *     pin/ revoke rewrites the trust anchor for the endpoint) — after
 *     device resolution they gate the DEVICE'S site through
 *     requireSiteScope → 403 SITE_SCOPE_FORBIDDEN (the documented mutation
 *     contract), BEFORE any credential/vendor validation and before any
 *     worker probe or trust-anchor write. A site-less device is an
 *     unscoped resource and bypasses the gate (assertSiteScope(null)
 *     rule). Wildcard sessions are byte-unchanged.
 *     authorization-matrix.md §5.1.
 */

const probeSchema = z.object({
  action: z.literal("probe"),
});

const enrollSchema = z.object({
  fingerprint: z
    .string()
    .trim()
    .regex(
      /^SHA256:[A-Za-z0-9+/]{43}$/,
      "fingerprint must be an OpenSSH SHA256 fingerprint (\"SHA256:\" + 43 base64 chars)"
    ),
  keyType: z.string().trim().min(1).max(64),
  notes: z.string().trim().max(500).optional(),
});

interface DeviceEndpoint {
  deviceId: string;
  hostname: string;
  host: string;
  port: number;
  vendorKey: string;
  credential: {
    username: string;
    port: number;
    secretRef: string;
  };
}

/** Resolve the device + its SSH endpoint coordinates (fail-closed).
 *
 * F-031 wave-7 (mutation plane): the site-scope gate lives HERE — directly
 * after device resolution and before any credential/vendor endpoint
 * validation — so an out-of-scope device answers 403 SITE_SCOPE_FORBIDDEN
 * no matter what other endpoint state it carries. The gate rides the same
 * AuthError contract the callers already map through `fail`.
 */
async function loadEndpoint(
  request: Request,
  deviceId: string
): Promise<
  { ok: true; endpoint: DeviceEndpoint } | { ok: false; code: string; message: string; status: number }
> {
  const device = await db.device.findUnique({
    where: { id: deviceId },
    select: {
      id: true,
      hostname: true,
      mgmtIp: true,
      dataSource: true,
      vendor: { select: { key: true } },
      site: { select: { code: true } },
      credentialProfile: { select: { username: true, port: true, secretRef: true } },
    },
  });
  if (!device) {
    return { ok: false, code: "DEVICE_NOT_FOUND", message: "The requested device does not exist", status: 404 };
  }
  // F-031 wave-7 (mutation plane): the DEVICE'S site must be inside the
  // session's scope — requireSiteScope answers 403 SITE_SCOPE_FORBIDDEN
  // (no 404 shape on the mutation plane; a site-less device bypasses per
  // the documented unscoped-resource rule).
  try {
    await requireSiteScope(request, device.site?.code ?? null);
  } catch (error) {
    if (error instanceof AuthError) {
      return { ok: false, code: error.code, message: error.message, status: error.status };
    }
    throw error;
  }
  if (!device.credentialProfile) {
    return {
      ok: false,
      code: "CREDENTIAL_REQUIRED",
      message: "Link an SSH credential profile first — enrollment pins the endpoint (host + credential port)",
      status: 400,
    };
  }
  // CERT-006: WebAPI vendors have NO SSH handshake to pin — their live
  // transport rides fail-closed TLS verification (system CA store plus the
  // worker-pinned FAYANMS_WEBAPI_CA_PEM). SSH host-key enrollment is
  // inapplicable by construction; refusing typed beats a probe that could
  // never reach an SSH endpoint.
  if (isLiveWebApiVendor(device.vendor?.key)) {
    return {
      ok: false,
      code: "SSH_HOSTKEY_NOT_APPLICABLE",
      message: `Vendor "${device.vendor?.key}" drives the live plane over the SFOS WebAPI (TLS) — there is no SSH host key to enroll. Trust is the worker's TLS verification policy (FAYANMS_WEBAPI_CA_PEM for private CAs).`,
      status: 400,
    };
  }
  if (!device.mgmtIp) {
    return {
      ok: false,
      code: "MGMT_IP_REQUIRED",
      message: "The device has no management IP — set one before enrolling a host key",
      status: 400,
    };
  }
  return {
    ok: true,
    endpoint: {
      deviceId: device.id,
      hostname: device.hostname,
      host: device.mgmtIp,
      port: device.credentialProfile.port,
      // The enroll probe is a LIVE_SSH connection — it needs the device's
      // vendor code so the worker's live-flavor registry resolves (a
      // FLAVOR_UNSUPPORTED probe would never reach the endpoint).
      vendorKey: device.vendor.key,
      credential: {
        username: device.credentialProfile.username,
        port: device.credentialProfile.port,
        secretRef: device.credentialProfile.secretRef,
      },
    },
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requirePermission(_request, "config.backup");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }
  const { id } = await params;
  const scopeClaims = await sessionScopeFor(_request);
  const device = await db.device.findUnique({
    where: { id },
    select: {
      mgmtIp: true,
      site: { select: { code: true } },
      credentialProfile: { select: { port: true } },
    },
  });
  // F-031 wave-7: the SAME not-found envelope for a missing device AND an
  // out-of-scope device — the enrollment answer exposes the endpoint's
  // host + port, so it must not disclose an out-of-scope device's
  // existence (404-not-403; sessionAllowsSite mirrors the list route's
  // where filter).
  if (!device || !sessionAllowsSite(scopeClaims, device.site?.code ?? null)) {
    return fail("DEVICE_NOT_FOUND", "The requested device does not exist", 404);
  }
  if (!device.mgmtIp || !device.credentialProfile) {
    return ok(null);
  }
  const enrollment = await getEnrollment(device.mgmtIp, device.credentialProfile.port);
  return ok(enrollment);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "config.backup");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }
  const parsed = probeSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }

  const endpoint = await loadEndpoint(request, id);
  if (!endpoint.ok) {
    return fail(endpoint.code, endpoint.message, endpoint.status);
  }

  const correlationId = newJobCorrelationId();
  // The ENROLLMENT probe: enrollHostKey=true — the worker captures the
  // presented key instead of enforcing a pin. Nothing is stored here; the
  // operator confirms the fingerprint (out-of-band verification), then PUTs.
  let presented: { keyType?: string; fingerprint?: string } | null = null;
  let probeError: string | null = null;
  try {
    const response = await fetch(`${WORKER_BASE_URL}/simulate/connect`, {
      method: "POST",
      headers: workerControlHeaders(),
      body: JSON.stringify({
        vendor: endpoint.endpoint.vendorKey,
        host: endpoint.endpoint.host,
        hostname: endpoint.endpoint.hostname,
        deviceId: endpoint.endpoint.deviceId,
        dataSource: "LIVE_SSH",
        credential: endpoint.endpoint.credential,
        enrollHostKey: true,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const json = (await response.json().catch(() => null)) as
      | { ok?: boolean; hostKey?: { keyType?: string; fingerprint?: string }; error?: string }
      | null;
    if (response.ok && json?.ok === true && json.hostKey) {
      presented = json.hostKey;
    } else {
      probeError = json?.error ?? `worker responded HTTP ${response.status}`;
    }
  } catch (error) {
    probeError = `worker unreachable: ${(error as Error).message}`;
  }

  await db.auditEvent.create({
    data: {
      actorId: actor.id,
      actorName: actor.name ?? "Unknown user",
      action: "SSH_HOSTKEY_PROBED",
      resourceType: "Device",
      resourceId: endpoint.endpoint.deviceId,
      resourceLabel: endpoint.endpoint.hostname,
      result: presented ? "SUCCESS" : "FAILURE",
      correlationId,
      afterJson: JSON.stringify({
        host: endpoint.endpoint.host,
        port: endpoint.endpoint.port,
        keyType: presented?.keyType ?? null,
        fingerprint: presented?.fingerprint ?? null,
        error: probeError,
      }),
    },
  });

  if (!presented) {
    return fail("HOSTKEY_PROBE_FAILED", probeError ?? "The host key could not be captured", 502);
  }
  return ok(
    {
      keyType: presented.keyType ?? "unknown",
      fingerprint: presented.fingerprint ?? "",
      host: endpoint.endpoint.host,
      port: endpoint.endpoint.port,
      message:
        "Verify this fingerprint out-of-band (device console), then confirm to pin it. Until pinned, ALL live connections to this endpoint are refused.",
    },
    { correlationId }
  );
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "config.backup");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }
  const parsed = enrollSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }

  const endpoint = await loadEndpoint(request, id);
  if (!endpoint.ok) {
    return fail(endpoint.code, endpoint.message, endpoint.status);
  }

  const fingerprint = normalizeHostKeyFingerprint(parsed.data.fingerprint);
  if (!isValidHostKeyFingerprint(fingerprint)) {
    return fail(
      "HOSTKEY_FINGERPRINT_INVALID",
      "The fingerprint is not a valid OpenSSH SHA256 fingerprint",
      400
    );
  }

  const correlationId = newJobCorrelationId();
  const enrollment = await db.sshHostKey.upsert({
    where: {
      host_port: { host: endpoint.endpoint.host, port: endpoint.endpoint.port },
    },
    update: {
      keyType: parsed.data.keyType,
      fingerprint,
      enrolledAt: new Date(),
      enrolledBy: actor.name ?? "Unknown user",
      lastVerifiedAt: new Date(),
      notes: parsed.data.notes ?? null,
    },
    create: {
      host: endpoint.endpoint.host,
      port: endpoint.endpoint.port,
      keyType: parsed.data.keyType,
      fingerprint,
      // Enforcement uses the FINGERPRINT; the blob column is audit/display
      // material and is filled by the enrollment probe payload when the
      // operator confirms (the probe response carries it today as text).
      hostKeyBase64: "",
      enrolledBy: actor.name ?? "Unknown user",
      notes: parsed.data.notes ?? null,
    },
  });

  await db.auditEvent.create({
    data: {
      actorId: actor.id,
      actorName: actor.name ?? "Unknown user",
      action: "SSH_HOSTKEY_ENROLLED",
      resourceType: "Device",
      resourceId: endpoint.endpoint.deviceId,
      resourceLabel: endpoint.endpoint.hostname,
      result: "SUCCESS",
      correlationId,
      afterJson: JSON.stringify({
        host: endpoint.endpoint.host,
        port: endpoint.endpoint.port,
        keyType: parsed.data.keyType,
        fingerprint,
        replaced: true, // upsert — the previous pin for this endpoint was replaced
      }),
    },
  });

  return ok(
    {
      id: enrollment.id,
      host: enrollment.host,
      port: enrollment.port,
      keyType: enrollment.keyType,
      fingerprint: enrollment.fingerprint,
      enrolledAt: enrollment.enrolledAt,
      message: "Host key pinned — live connections to this endpoint now enforce it (mismatch refuses pre-auth).",
    },
    { correlationId }
  );
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "config.backup");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }
  const { id } = await params;

  const endpoint = await loadEndpoint(request, id);
  if (!endpoint.ok) {
    return fail(endpoint.code, endpoint.message, endpoint.status);
  }

  const existing = await getEnrollment(endpoint.endpoint.host, endpoint.endpoint.port);
  if (!existing) {
    return fail("HOSTKEY_NOT_ENROLLED", "This endpoint has no pinned host key", 404);
  }

  const correlationId = newJobCorrelationId();
  await db.sshHostKey.delete({ where: { id: existing.id } });
  await db.auditEvent.create({
    data: {
      actorId: actor.id,
      actorName: actor.name ?? "Unknown user",
      action: "SSH_HOSTKEY_REVOKED",
      resourceType: "Device",
      resourceId: endpoint.endpoint.deviceId,
      resourceLabel: endpoint.endpoint.hostname,
      result: "SUCCESS",
      correlationId,
      afterJson: JSON.stringify({
        host: endpoint.endpoint.host,
        port: endpoint.endpoint.port,
        keyType: existing.keyType,
        fingerprint: existing.fingerprint,
      }),
    },
  });

  return ok(
    {
      revoked: true,
      message:
        "Host key enrollment revoked — ALL live connections to this endpoint are now refused (fail-closed) until re-enrolled.",
    },
    { correlationId }
  );
}
