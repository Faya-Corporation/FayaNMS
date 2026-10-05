import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fail, newCorrelationId } from "../../../../../_lib/api";
import { decryptSnapshotTexts } from "@/lib/config/crypto";
import { requirePermission, authErrorToFail, sessionScopeFor } from "@/lib/auth/session";
import { sessionAllowsSite } from "@/lib/auth/scope";

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
 *
 * F-031 (site scoping — device-domain wave 7): the answer is gated by the
 * sessionAllowsSite row predicate with 404-NOT-403 parity — this endpoint
 * exports the DECRYPTED raw configuration, so an out-of-scope device gets
 * the SAME DEVICE_NOT_FOUND envelope a wildcard session gets for a missing
 * device (a 403 would confirm existence). Wildcard sessions (no `sites`
 * claim — the single-tenant default) are byte-unchanged.
 * authorization-matrix.md §5.1.
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

  const scopeClaims = await sessionScopeFor(request);
  const device = await db.device.findUnique({
    where: { id },
    select: { id: true, hostname: true, site: { select: { code: true } } },
  });
  // F-031 wave-7: the SAME not-found envelope for a missing device AND an
  // out-of-scope device — the decrypted-config export must not disclose
  // the existence of a device hidden from the caller's site scope
  // (sessionAllowsSite mirrors the list route's where filter; site-less
  // devices stay hidden from sites-limited sessions — fail-closed parity
  // with SQL).
  if (!device || !sessionAllowsSite(scopeClaims, device.site?.code ?? null)) {
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
      encKeyId: true,
      encIv: true,
      encTag: true,
      normIv: true,
      normTag: true,
      wrappedDek: true,
      encAad: true, // AAD binding (CRYPTO-101) — required by decryptSnapshotTexts
      wrapIv: true,
      wrapTag: true,
    },
  });
  if (!snapshot) {
    return fail(
      "SNAPSHOT_NOT_FOUND",
      "The requested configuration snapshot does not exist for this device",
      404
    );
  }

  // P19 SEC-003: the stored row holds AES-256-GCM ciphertext — decrypt for
  // this privileged, permission-checked, audited export (legacy rows with
  // encKeyId=null pass through as plaintext).
  const { rawText } = decryptSnapshotTexts(snapshot);

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

  return new NextResponse(rawText, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Correlation-Id": correlationId,
      "Cache-Control": "no-store",
    },
  });
}
