import { db } from "@/lib/db";
import { fail, firstIssueMessage, newJobCorrelationId, ok } from "../../_lib/api";
import { authErrorToFail, requirePermission } from "@/lib/auth/session";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET   /api/v1/devices/[id] — full device record (vendor/site joined,
 *         relation counts, BigInt uptime serialized as string, tags parsed).
 * PATCH /api/v1/devices/[id] — editable fields: displayName (name), notes
 *         (description), criticality, siteId, tags, status (MAINTENANCE
 *         toggling), credentialProfileId, dataSource (Phase 22 slice 2 —
 *         both PERSISTED with fail-closed invariants: a LIVE_SSH device
 *         always carries a linked SSH_PASSWORD CredentialProfile).
 */

const OPEN_INCIDENT_STATUSES = [
  "NEW",
  "ACKNOWLEDGED",
  "ASSIGNED",
  "INVESTIGATING",
  "MITIGATING",
  "MONITORING",
];

function parseTags(tagsJson: string | null): string[] {
  if (!tagsJson) return [];
  try {
    const parsed: unknown = JSON.parse(tagsJson);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

async function loadDevice(id: string) {
  const [device, interfaces, snapshots, openAlerts, openIncidents, changes, backupJobs] =
    await Promise.all([
      db.device.findUnique({
        where: { id },
        include: {
          vendor: { select: { id: true, key: true, name: true, adapterKey: true } },
          site: { select: { id: true, name: true, code: true, region: true } },
          credentialProfile: { select: { id: true, name: true, type: true, port: true } },
        },
      }),
      db.deviceInterface.count({ where: { deviceId: id } }),
      db.configSnapshot.count({ where: { deviceId: id } }),
      db.alert.count({ where: { deviceId: id, status: "ACTIVE" } }),
      db.incident.count({
        where: { devices: { some: { deviceId: id } }, status: { in: OPEN_INCIDENT_STATUSES } },
      }),
      db.changeRequest.count({ where: { devices: { some: { deviceId: id } } } }),
      db.jobExecution.count({ where: { targetId: id, targetType: "DEVICE", type: "CONFIG_BACKUP" } }),
    ]);
  if (!device) return null;
  return {
    id: device.id,
    hostname: device.hostname,
    displayName: device.displayName,
    mgmtIp: device.mgmtIp,
    model: device.model,
    platform: device.platform,
    serialNumber: device.serialNumber,
    firmware: device.firmware,
    role: device.role,
    status: device.status,
    criticality: device.criticality,
    healthScore: device.healthScore,
    backupCompliance: device.backupCompliance,
    tags: parseTags(device.tagsJson),
    notes: device.notes,
    // BigInt columns must be stringified before JSON serialization.
    uptimeSeconds: device.uptimeSeconds === null ? null : device.uptimeSeconds.toString(),
    lastSeen: device.lastSeen,
    lastBackupAt: device.lastBackupAt,
    lastConfigChangeAt: device.lastConfigChangeAt,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
    vendor: device.vendor,
    site: device.site,
    dataSource: device.dataSource,
    credentialProfile: device.credentialProfile,
    counts: {
      interfaces,
      snapshots,
      openAlerts,
      openIncidents,
      changes,
      backupJobs,
    },
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id || id.length > 64) {
    return fail("INVALID_ID", "Invalid device id", 400);
  }

  const device = await loadDevice(id);
  if (!device) {
    return fail("DEVICE_NOT_FOUND", "The requested device does not exist", 404);
  }

  return ok(device);
}

/* ------------------------------------------------------------------ */
/* PATCH — editable fields                                              */
/* ------------------------------------------------------------------ */

const patchSchema = z.object({
  displayName: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  // criticality: LOW | MEDIUM | HIGH | CRITICAL
  criticality: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  // Management address is editable so LIVE_SSH devices can be repointed at
  // their real host (Phase 22 slice 2 — was previously accepted by the form
  // but silently dropped).
  mgmtIp: z
    .string()
    .trim()
    .regex(
      /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/,
      "mgmtIp must be a valid IPv4 address",
    )
    .optional(),
  siteId: z.string().trim().min(1).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  // status: UI uses PATCH for MAINTENANCE toggling; the full set is accepted
  // so the poller/worker can move devices through the same contract later.
  status: z
    .enum(["ONLINE", "OFFLINE", "DEGRADED", "MAINTENANCE", "UNKNOWN", "UNMANAGED"])
    .optional(),
  // Data plane (Phase 22 slice 2) — persisted; invariants enforced below
  // against the EFFECTIVE (patched) device state.
  dataSource: z.enum(["SIMULATOR", "LIVE_SSH"]).optional(),
  credentialProfileId: z.string().trim().min(1).nullable().optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id || id.length > 64) {
    return fail("INVALID_ID", "Invalid device id", 400);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const data = parsed.data;

  // Phase 19-C (audit AUTHZ-001 sweep): editing a device requires the
  // "device.write" permission and the audit row is attributed to the
  // session principal (the legacy hardcoded actorName "Admin" is removed).
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "device.write");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  const current = await db.device.findUnique({ where: { id } });
  if (!current) {
    return fail("DEVICE_NOT_FOUND", "The requested device does not exist", 404);
  }

  if (data.siteId) {
    const site = await db.site.findUnique({ where: { id: data.siteId }, select: { id: true } });
    if (!site) {
      return fail("SITE_NOT_FOUND", "The selected site does not exist", 400);
    }
  }
  if (data.credentialProfileId) {
    const profile = await db.credentialProfile.findUnique({
      where: { id: data.credentialProfileId },
      select: { id: true, type: true },
    });
    if (!profile) {
      return fail(
        "CREDENTIAL_PROFILE_NOT_FOUND",
        "The selected credential profile does not exist",
        400
      );
    }
  }

  // Phase 22 slice 2 — data-plane invariants, evaluated against the
  // EFFECTIVE (patched) device state so partial updates cannot create an
  // illegal state:
  //   LIVE_SSH ⇒ a credential profile is linked (fail-closed) and its type
  //   is SSH_PASSWORD (the live transport is password-auth SSH exec).
  const effectiveDataSource =
    data.dataSource ?? current.dataSource ?? "SIMULATOR";
  const effectiveCredentialId =
    data.credentialProfileId === undefined
      ? current.credentialProfileId
      : data.credentialProfileId;
  if (effectiveDataSource === "LIVE_SSH") {
    if (!effectiveCredentialId) {
      return fail(
        "CREDENTIAL_REQUIRED_FOR_LIVE",
        "LIVE_SSH devices require a linked credential profile (username/port/secretRef) — link one before switching to the live plane",
        400
      );
    }
    const profile = await db.credentialProfile.findUnique({
      where: { id: effectiveCredentialId },
      select: { type: true },
    });
    if (profile && profile.type !== "SSH_PASSWORD") {
      return fail(
        "CREDENTIAL_TYPE_UNSUPPORTED",
        `LIVE_SSH currently supports SSH_PASSWORD credential profiles only (got ${profile.type})`,
        400
      );
    }
  }

  const updateData: Record<string, unknown> = {};
  if (data.displayName !== undefined) updateData.displayName = data.displayName || current.hostname;
  if (data.notes !== undefined) updateData.notes = data.notes;
  if (data.criticality !== undefined) updateData.criticality = data.criticality;
  if (data.siteId !== undefined) updateData.siteId = data.siteId;
  if (data.tags !== undefined) {
    updateData.tagsJson = data.tags.length > 0 ? JSON.stringify(data.tags) : null;
  }
  if (data.status !== undefined) updateData.status = data.status;
  if (data.mgmtIp !== undefined) updateData.mgmtIp = data.mgmtIp;
  if (data.dataSource !== undefined) updateData.dataSource = data.dataSource;
  // credentialProfileId is validated above and PERSISTED here (the secret
  // itself never travels — profiles store a vault secretRef pointer).
  if (data.credentialProfileId !== undefined) {
    updateData.credentialProfileId = data.credentialProfileId;
  }

  const changedKeys = Object.keys(updateData).filter((key) => {
    const before = (current as unknown as Record<string, unknown>)[key];
    const after = updateData[key];
    return JSON.stringify(before ?? null) !== JSON.stringify(after ?? null);
  });

  if (changedKeys.length === 0 && data.credentialProfileId === undefined && data.dataSource === undefined) {
    const device = await loadDevice(id);
    return ok(device);
  }

  const correlationId = newJobCorrelationId();

  try {
    await db.device.update({ where: { id }, data: updateData });
  } catch {
    return fail("UPDATE_FAILED", "The device could not be updated", 500);
  }

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const key of changedKeys) {
    before[key] = (current as unknown as Record<string, unknown>)[key] ?? null;
    after[key] = updateData[key] ?? null;
  }

  await db.auditEvent.create({
    data: {
      actorId: actor.id,
      actorName: actor.name ?? "Unknown user",
      action: "DEVICE_UPDATED",
      resourceType: "Device",
      resourceId: id,
      resourceLabel: current.hostname,
      result: "SUCCESS",
      correlationId,
      beforeJson: JSON.stringify(before),
      afterJson: JSON.stringify(after),
    },
  });

  const device = await loadDevice(id);
  return ok(device, { correlationId });
}
