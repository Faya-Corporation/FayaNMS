import { db } from "@/lib/db";
import { fail, newCorrelationId, ok } from "../../_lib/api";
import {
  authErrorToFail,
  requirePermission,
  requireSiteScope,
} from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/v1/baselines/[id] — revoke a baseline approval (Task 3-c).
 *
 * Deletes the ConfigBaseline row; when no other baseline row still
 * references the snapshot, the snapshot is demoted BASELINE→HISTORICAL so
 * the version history shows the truth. Older baseline rows referencing the
 * same snapshot (rare but possible) keep the BASELINE status.
 *
 * Audited BASELINE_REVOKED with the full before-state. Baselines are
 * standalone rows — snapshots, drift records and jobs are untouched
 * (DriftRecords reference the snapshots, not the baseline row).
 *
 * F-031 wave-9 (mutation gate — the wave-7 contract): after the baseline
 * resolves (404 for unknown), the OWNING device's site must be inside the
 * session's scope — a sites-limited session revoking another site's
 * baseline answers 403 SITE_SCOPE_FORBIDDEN (mutations accept existence
 * confirmation; a baseline's device is cascade-linked and always
 * resolves).
 */

const ID_MAX = 64;

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id || id.length > ID_MAX) {
    return fail("INVALID_ID", "Invalid baseline id", 400);
  }

  // Phase 19-C (audit AUTHZ-001 sweep): baseline revocation requires the
  // "config.baseline" permission and the audit row is attributed to the
  // session principal (the seeded-admin fallback actor is removed).
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(_request, "config.baseline");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  const baseline = await db.configBaseline.findUnique({
    where: { id },
    select: {
      id: true,
      deviceId: true,
      snapshotId: true,
      approvedAt: true,
      note: true,
      device: { select: { hostname: true, site: { select: { code: true } } } },
      snapshot: { select: { version: true, status: true } },
    },
  });
  if (!baseline) {
    return fail("BASELINE_NOT_FOUND", "The baseline does not exist", 404);
  }

  // F-031 wave-9 (mutation gate): the owning device's site must be in
  // scope (null site = unscoped resource — the documented bypass).
  try {
    await requireSiteScope(_request, baseline.device?.site?.code ?? null);
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  const correlationId = newCorrelationId("BL");

  await db.$transaction(
    async (tx) => {
      await tx.configBaseline.delete({ where: { id } });

      // Demote only when this was the last baseline row referencing the
      // snapshot, and only from BASELINE (a CURRENT snapshot stays CURRENT).
      const remaining = await tx.configBaseline.count({
        where: { snapshotId: baseline.snapshotId, id: { not: id } },
      });
      let demoted = 0;
      if (remaining === 0) {
        const res = await tx.configSnapshot.updateMany({
          where: { id: baseline.snapshotId, status: "BASELINE" },
          data: { status: "HISTORICAL" },
        });
        demoted = res.count;
      }

      await tx.auditEvent.create({
        data: {
          actorId: actor.id,
          actorName: actor.name ?? "Unknown user",
          action: "BASELINE_REVOKED",
          resourceType: "ConfigBaseline",
          resourceId: id,
          resourceLabel: `${baseline.device.hostname} v${baseline.snapshot.version}`,
          result: "SUCCESS",
          correlationId,
          beforeJson: JSON.stringify({
            deviceId: baseline.deviceId,
            snapshotId: baseline.snapshotId,
            version: baseline.snapshot.version,
            approvedAt: baseline.approvedAt,
            note: baseline.note,
          }),
        },
      });

      return { demoted };
    },
    { maxWait: 5_000, timeout: 20_000 }
  );

  return ok({
    deleted: true,
    id,
    audit: { action: "BASELINE_REVOKED", correlationId },
  });
}
