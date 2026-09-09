import { db } from "@/lib/db";
import { fail, newCorrelationId, ok } from "../../_lib/api";

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

  const baseline = await db.configBaseline.findUnique({
    where: { id },
    select: {
      id: true,
      deviceId: true,
      snapshotId: true,
      approvedAt: true,
      note: true,
      device: { select: { hostname: true } },
      snapshot: { select: { version: true, status: true } },
    },
  });
  if (!baseline) {
    return fail("BASELINE_NOT_FOUND", "The baseline does not exist", 404);
  }

  // Approver for the audit trail: the seeded admin account (ADR-04).
  const admin = await db.user.findFirst({
    where: { role: "admin", isActive: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });

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
          actorId: admin?.id ?? null,
          actorName: admin?.name ?? "Admin",
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
