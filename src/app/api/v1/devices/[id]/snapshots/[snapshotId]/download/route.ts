import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fail, newCorrelationId } from "../../../../../_lib/api";
import { requirePermission, authErrorToFail } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/devices/[id]/snapshots/[snapshotId]/download
 *
 * Audited privileged download of the RAW configuration text (Task 3-a).
 * Masking is a viewer-layer concern — the raw export is intentionally
 * gated behind an audit trail entry (F-12): every successful download
 * writes a CONFIG_DOWNLOAD AuditEvent with the snapshot id, version,
 * sha256 and hostname before the body is returned.
 *
 * AUTHORIZATION (P19 / audit SEC-005): the caller must hold the explicit
 * "config.download" permission (seeded to engineer + admin via "*"; the
 * middleware session check alone is NOT sufficient — a bare read-oriented
 * role must not gain raw-configuration export). The audit actor is the
 * authenticated principal (never a hardcoded name), and rejected attempts
 * are audited as CONFIG_DOWNLOAD_DENIED. Response is no-store.
 *
 * Response: text/plain attachment
 *   Content-Disposition: attachment; filename="<hostname>-v<version>.cfg"
 */

const ID_MAX = 64;

function safeFilenamePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "device";
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; snapshotId: string }> }
) {
  const { id, snapshotId } = await params;
  if (!id || id.length > ID_MAX || !snapshotId || snapshotId.length > ID_MAX) {
    return fail("INVALID_ID", "Invalid device or snapshot id", 400);
  }

  // Permission gate FIRST — raw configuration export is a privileged act
  // (401 UNAUTHENTICATED / 403 RBAC_FORBIDDEN without it).
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "config.download");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    // Audit the rejected attempt (best-effort — the denial response wins).
    try {
      await db.auditEvent.create({
        data: {
          actorName: "unknown",
          action: "CONFIG_DOWNLOAD_DENIED",
          resourceType: "ConfigSnapshot",
          resourceId: snapshotId,
          resourceLabel: `device ${id}`,
          result: "DENIED",
          correlationId: newCorrelationId("DL"),
          afterJson: JSON.stringify({
            reason: error instanceof Error ? error.message : "auth failure",
          }),
        },
      });
    } catch {
      /* audit best-effort */
    }
    return authFail;
  }

  const device = await db.device.findUnique({
    where: { id },
    select: { id: true, hostname: true },
  });
  if (!device) {
    return fail("DEVICE_NOT_FOUND", "The requested device does not exist", 404);
  }

  // The snapshot MUST belong to the device in the URL — never serve a
  // cross-device snapshot even when the caller knows both ids.
  const snapshot = await db.configSnapshot.findFirst({
    where: { id: snapshotId, deviceId: device.id },
    select: {
      id: true,
      version: true,
      sha256: true,
      rawText: true,
      status: true,
    },
  });
  if (!snapshot) {
    return fail(
      "SNAPSHOT_NOT_FOUND",
      "The requested configuration snapshot does not exist for this device",
      404
    );
  }

  const correlationId = newCorrelationId("DL");
  await db.auditEvent.create({
    data: {
      actorId: actor.id,
      actorName: actor.name ?? actor.email,
      action: "CONFIG_DOWNLOAD",
      resourceType: "ConfigSnapshot",
      resourceId: snapshot.id,
      resourceLabel: `${device.hostname} v${snapshot.version}`,
      result: "SUCCESS",
      correlationId,
      afterJson: JSON.stringify({
        snapshotId: snapshot.id,
        version: snapshot.version,
        sha256: snapshot.sha256,
        hostname: device.hostname,
      }),
    },
  });

  const filename = `${safeFilenamePart(device.hostname)}-v${snapshot.version}.cfg`;

  return new NextResponse(snapshot.rawText, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Correlation-Id": correlationId,
      "Cache-Control": "no-store",
    },
  });
}
