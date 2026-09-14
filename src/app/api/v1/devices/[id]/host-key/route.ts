import { db } from "@/lib/db";
import { isLiveWebApiVendor } from "@/lib/devices/live-transport";
import { fail, firstIssueMessage, newJobCorrelationId, ok } from "../../../_lib/api";
import { authErrorToFail, requirePermission } from "@/lib/auth/session";
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

/** Resolve the device + its SSH endpoint coordinates (fail-closed). */
async function loadEndpoint(deviceId: string): Promise<
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
      credentialProfile: { select: { username: true, port: true, secretRef: true } },
    },
  });
  if (!device) {
    return { ok: false, code: "DEVICE_NOT_FOUND", message: "The requested device does not exist", status: 404 };
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
  const device = await db.device.findUnique({
    where: { id },
    select: { mgmtIp: true, credentialProfile: { select: { port: true } } },
  });
  if (!device) {
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

  const endpoint = await loadEndpoint(id);
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

  const endpoint = await loadEndpoint(id);
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

  const endpoint = await loadEndpoint(id);
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
