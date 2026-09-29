import { db } from "@/lib/db";
import { newCorrelationId } from "@/app/api/v1/_lib/api";
import {
  parsePolicyScope,
  scopeDeviceWhere,
  type ParsedPolicyScope,
} from "@/app/api/v1/_lib/scope";

/**
 * ConfigSnapshot retention prune engine (Task 3-a; engine-in-lib since
 * RT-011 so the tick route keeps only scheduling concerns — same shape as
 * src/lib/protocol/queue-retention.ts).
 *
 * Prune HISTORICAL snapshots older than each scoped device's retention
 * window. Per-device retention windows come from BackupPolicy rows; a device
 * covered by several policies keeps the LONGEST window (most generous
 * retention wins — one policy can never destroy another's history). Safety
 * caps, in order:
 *   - CURRENT and BASELINE snapshots are never touched;
 *   - a device's newest HISTORICAL version is never deleted;
 *   - at least 2 snapshots per device always remain;
 *   - max 50 deletes per tick (batch keeps transactions short).
 *
 * RT-011 / F-013 — FK-CASCADE PROTECTION (code-level guard; the schema-level
 * SetNull alternative is BACKLOG hardening). A HISTORICAL snapshot can still
 * be referenced by LIVE config-management rows whose onDelete: Cascade would
 * silently destroy them along with the snapshot:
 *   1. OPEN DriftRecord.currentSnapshotId / .baselineSnapshotId — an open
 *      drift finding must never vanish on a timer. drift-evaluate pins the
 *      OPEN record's currentSnapshotId to the device's latest snapshot; the
 *      next backup demotes that snapshot to HISTORICAL, so WITHOUT this
 *      guard the next retention pass would cascade the open finding away
 *      and the device would read compliant again. Retention therefore WAITS
 *      for the record to be RESOLVED/ACCEPTED — that is intended semantics,
 *      not a retention deadlock (the excluded ids simply are not deleted
 *      this tick; the per-tick delete budget is spent on genuinely
 *      prunable rows).
 *   2. ConfigBaseline.snapshotId — an approved baseline (superseded or not)
 *      keeps its snapshot; cascading it would destroy the baseline and the
 *      drift history computed against it.
 * Both protection counts are reported in the CONFIG_RETENTION_PRUNED audit
 * afterJson (protectedByOpenDrift / protectedByBaseline) so operators can
 * see why rows were retained — including on zero-delete runs that protected
 * rows (a summary audit with count 0 is written in that case).
 */

/** Max snapshots deleted per prune run (tick budget). */
export const PRUNE_MAX_DELETES_PER_TICK = 50;

/** Snapshots always kept per device (hard floor). */
export const PRUNE_MIN_SNAPSHOTS_PER_DEVICE = 2;

/** Minimal policy projection the pruner needs (BackupPolicy row subset). */
export interface PrunePolicyRef {
  id: string;
  retentionDays: number;
  scopeJson: string;
}

export interface PruneOutcome {
  pruned: number;
  prunedDevices: number;
  /** Snapshot ids removed from the delete set: referenced by OPEN drift records. */
  protectedByOpenDrift: number;
  /** Snapshot ids removed from the delete set: referenced by ConfigBaseline rows. */
  protectedByBaseline: number;
}

/**
 * Prune HISTORICAL snapshots older than each scoped device's retention
 * window. See the module header for the safety caps and the RT-011
 * FK-cascade protection rules. Returns the number of rows deleted (0 when
 * nothing was prunable) plus the applied protection counts.
 */
export async function pruneRetention(
  policies: PrunePolicyRef[],
  now: Date
): Promise<PruneOutcome> {
  if (policies.length === 0) {
    return { pruned: 0, prunedDevices: 0, protectedByOpenDrift: 0, protectedByBaseline: 0 };
  }

  // Per-device retention window. Devices scoped by several policies keep
  // the longest window (most generous retention wins).
  const cutoffs = new Map<string, Date>();
  for (const policy of policies) {
    const scope: ParsedPolicyScope = parsePolicyScope(policy.scopeJson);
    const scoped = await db.device.findMany({
      where: scopeDeviceWhere(scope),
      select: { id: true },
    });
    const cutoff = new Date(
      now.getTime() - policy.retentionDays * 24 * 60 * 60 * 1000
    );
    for (const device of scoped) {
      const existing = cutoffs.get(device.id);
      if (!existing || cutoff < existing) {
        cutoffs.set(device.id, cutoff);
      }
    }
  }
  if (cutoffs.size === 0) {
    return { pruned: 0, prunedDevices: 0, protectedByOpenDrift: 0, protectedByBaseline: 0 };
  }

  // Cheap per-device totals in one grouped query (deviceId index).
  const totals = await db.configSnapshot.groupBy({
    by: ["deviceId"],
    _count: { _all: true },
    where: { deviceId: { in: Array.from(cutoffs.keys()) } },
  });
  const totalByDevice = new Map<string, number>(
    totals.map((row) => [row.deviceId, row._count._all])
  );

  const deleteIds: string[] = [];
  const touchedDevices = new Set<string>();

  for (const [deviceId, cutoff] of cutoffs) {
    if (deleteIds.length >= PRUNE_MAX_DELETES_PER_TICK) break;
    const total = totalByDevice.get(deviceId) ?? 0;
    // Hard safety cap: always keep at least 2 snapshots on the device.
    const maxDeletable = total - PRUNE_MIN_SNAPSHOTS_PER_DEVICE;
    if (maxDeletable <= 0) continue;

    const budget = Math.min(
      PRUNE_MAX_DELETES_PER_TICK - deleteIds.length,
      maxDeletable
    );
    const candidates = await db.configSnapshot.findMany({
      where: {
        deviceId,
        status: "HISTORICAL",
        createdAt: { lt: cutoff },
      },
      orderBy: { createdAt: "desc" },
      take: budget + 1,
      select: { id: true, createdAt: true },
    });
    if (candidates.length === 0) continue;

    // Never delete the device's newest HISTORICAL version: when a newer
    // HISTORICAL row exists above the cutoff the global newest is outside
    // this candidate list; otherwise candidates[0] IS the newest HISTORICAL.
    const hasRecentHistorical =
      (await db.configSnapshot.count({
        where: {
          deviceId,
          status: "HISTORICAL",
          createdAt: { gte: cutoff },
        },
      })) > 0;
    const deletable = hasRecentHistorical ? candidates : candidates.slice(1);

    for (const row of deletable) {
      if (deleteIds.length >= PRUNE_MAX_DELETES_PER_TICK) break;
      deleteIds.push(row.id);
      touchedDevices.add(deviceId);
    }
  }

  if (deleteIds.length === 0) {
    return { pruned: 0, prunedDevices: 0, protectedByOpenDrift: 0, protectedByBaseline: 0 };
  }

  // ── RT-011 FK-cascade guard ────────────────────────────────────────────
  // Remove snapshot ids that live config-management rows still reference
  // (onDelete: Cascade would destroy those rows along with the snapshot).
  const protectedByOpenDrift = new Set<string>();
  const openDrift = await db.driftRecord.findMany({
    where: {
      status: "OPEN",
      OR: [
        { currentSnapshotId: { in: deleteIds } },
        { baselineSnapshotId: { in: deleteIds } },
      ],
    },
    select: { currentSnapshotId: true, baselineSnapshotId: true },
  });
  for (const row of openDrift) {
    if (row.currentSnapshotId && deleteIds.includes(row.currentSnapshotId)) {
      protectedByOpenDrift.add(row.currentSnapshotId);
    }
    if (row.baselineSnapshotId && deleteIds.includes(row.baselineSnapshotId)) {
      protectedByOpenDrift.add(row.baselineSnapshotId);
    }
  }
  const protectedByBaseline = new Set<string>();
  const baselines = await db.configBaseline.findMany({
    where: { snapshotId: { in: deleteIds } },
    select: { snapshotId: true },
  });
  for (const row of baselines) {
    if (deleteIds.includes(row.snapshotId)) {
      protectedByBaseline.add(row.snapshotId);
    }
  }
  const finalDeleteIds = deleteIds.filter(
    (id) => !protectedByOpenDrift.has(id) && !protectedByBaseline.has(id)
  );

  if (finalDeleteIds.length === 0) {
    // Nothing deletable left — but if rows were PROTECTED, still write the
    // summary audit so operators can see why the rows were retained.
    if (protectedByOpenDrift.size > 0 || protectedByBaseline.size > 0) {
      await db.auditEvent.create({
        data: {
          actorName: "system:backup-worker",
          action: "CONFIG_RETENTION_PRUNED",
          resourceType: "ConfigSnapshot",
          result: "SUCCESS",
          correlationId: newCorrelationId("RET"),
          afterJson: JSON.stringify({
            count: 0,
            devices: 0,
            policies: policies.length,
            protectedByOpenDrift: protectedByOpenDrift.size,
            protectedByBaseline: protectedByBaseline.size,
          }),
        },
      });
    }
    return {
      pruned: 0,
      prunedDevices: 0,
      protectedByOpenDrift: protectedByOpenDrift.size,
      protectedByBaseline: protectedByBaseline.size,
    };
  }

  // One short interactive transaction: the delete is guarded by
  // status = HISTORICAL so a snapshot promoted to BASELINE mid-flight
  // (e.g. baseline approval) is never destroyed. The RT-011 exclusions are
  // applied above the transaction (the guard reads have their own snapshot;
  // a reference created after the read is caught on the NEXT prune run —
  // drift-evaluate re-pins OPEN records on every scheduled drift check).
  const result = await db.$transaction(
    async (tx) => {
      const deleted = await tx.configSnapshot.deleteMany({
        where: { id: { in: finalDeleteIds }, status: "HISTORICAL" },
      });
      await tx.auditEvent.create({
        data: {
          actorName: "system:backup-worker",
          action: "CONFIG_RETENTION_PRUNED",
          resourceType: "ConfigSnapshot",
          result: "SUCCESS",
          correlationId: newCorrelationId("RET"),
          afterJson: JSON.stringify({
            count: deleted.count,
            devices: touchedDevices.size,
            policies: policies.length,
            protectedByOpenDrift: protectedByOpenDrift.size,
            protectedByBaseline: protectedByBaseline.size,
          }),
        },
      });
      return deleted;
    },
    { maxWait: 5_000, timeout: 20_000 }
  );

  return {
    pruned: result.count,
    prunedDevices: touchedDevices.size,
    protectedByOpenDrift: protectedByOpenDrift.size,
    protectedByBaseline: protectedByBaseline.size,
  };
}
