import { db } from "@/lib/db";
import { fail, firstIssueMessage, newCorrelationId, ok } from "../_lib/api";
import { authErrorToFail, requirePermission, requireSessionRead } from "@/lib/auth/session";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET  /api/v1/baselines — approved golden configurations (Task 3-c).
 *
 * ConfigBaseline is the source of truth: the LATEST row per device wins.
 * Rows join device hostname/site, the baseline snapshot (version + sha256 +
 * status), the approver name and the device's OPEN drift count. Also
 * computes the "devices without a baseline" strip data (count + first 5
 * hostnames) so the Baselines view needs no extra request.
 *
 * POST /api/v1/baselines — approve a snapshot as the device's baseline.
 * Body: { deviceId, snapshotId, note? } — the snapshot MUST belong to the
 * device. On approve (one short transaction):
 *   1. the device's previous BASELINE-status snapshot is demoted to
 *      HISTORICAL (if any),
 *   2. the selected snapshot is promoted to BASELINE only when its current
 *      status is HISTORICAL — a CURRENT snapshot keeps its status (the
 *      column is single-valued and CURRENT must stay truthful),
 *   3. a new ConfigBaseline row is created (approvedBy = seeded admin user),
 *   4. a BASELINE_APPROVED audit event is written with the correlation id.
 * Approving the snapshot that is already the device's latest baseline is a
 * no-op conflict → 409 ALREADY_BASELINE.
 */

const postSchema = z.object({
  deviceId: z.string().trim().min(1).max(64),
  snapshotId: z.string().trim().min(1).max(64),
  note: z.string().trim().max(500).optional(),
});

/* ───────────────────────────── GET ───────────────────────────── */

export async function GET(request: Request) {
  // F-008 phase 4b (read-plane defense-in-depth): the GET handler verifies
  // the human session itself (requireSessionRead) — the proxy matcher stays
  // the coarse gate, not the only check.
  try {
    await requireSessionRead(request);
  } catch (error) {
    const envelope = authErrorToFail(error);
    if (envelope) return envelope;
    throw error;
  }
  // Small table — fetch all and resolve "latest per device" in memory.
  const baselineRows = await db.configBaseline.findMany({
    orderBy: { approvedAt: "desc" },
    select: {
      id: true,
      deviceId: true,
      snapshotId: true,
      approvedAt: true,
      note: true,
      approvedBy: { select: { name: true } },
      snapshot: {
        select: {
          id: true,
          version: true,
          sha256: true,
          status: true,
          createdAt: true,
        },
      },
    },
  });

  const latestByDevice = new Map<string, (typeof baselineRows)[number]>();
  for (const row of baselineRows) {
    if (!latestByDevice.has(row.deviceId)) latestByDevice.set(row.deviceId, row);
  }

  const deviceIds = Array.from(latestByDevice.keys());
  if (deviceIds.length === 0) {
    const managed = await db.device.findMany({
      where: { status: { not: "UNMANAGED" } },
      orderBy: { hostname: "asc" },
      select: { id: true, hostname: true },
    });
    return ok([], {
      baselineDevices: 0,
      devicesWithoutBaseline: managed.length,
      withoutBaselineDevices: managed.slice(0, 5).map((d) => ({
        id: d.id,
        hostname: d.hostname,
      })),
    });
  }

  const [openDriftGroups, currentSnaps, baselineDevices] = await Promise.all([
    db.driftRecord.groupBy({
      by: ["deviceId"],
      _count: { _all: true },
      where: { status: "OPEN", deviceId: { in: deviceIds } },
    }),
    // Latest CURRENT snapshot per baseline device — powers the
    // "baseline vs running" diff dialog in the view.
    db.configSnapshot.findMany({
      where: { deviceId: { in: deviceIds }, status: "CURRENT" },
      orderBy: { version: "desc" },
      select: { id: true, deviceId: true, version: true },
    }),
    db.device.findMany({
      where: { id: { in: deviceIds } },
      select: {
        id: true,
        hostname: true,
        site: { select: { name: true, code: true } },
      },
    }),
  ]);

  const openDriftByDevice = new Map(
    openDriftGroups.map((g) => [g.deviceId, g._count._all])
  );
  const currentByDevice = new Map<
    string,
    { snapshotId: string; version: number }
  >();
  for (const snap of currentSnaps) {
    if (!currentByDevice.has(snap.deviceId)) {
      currentByDevice.set(snap.deviceId, {
        snapshotId: snap.id,
        version: snap.version,
      });
    }
  }
  const deviceById = new Map(baselineDevices.map((d) => [d.id, d]));

  const baselines = Array.from(latestByDevice.values())
    .map((row) => {
      const device = deviceById.get(row.deviceId);
      return {
        id: row.id,
        deviceId: row.deviceId,
        hostname: device?.hostname ?? "unknown",
        siteName: device?.site?.name ?? null,
        siteCode: device?.site?.code ?? null,
        snapshotId: row.snapshot.id,
        version: row.snapshot.version,
        sha256: row.snapshot.sha256,
        snapshotStatus: row.snapshot.status,
        snapshotCreatedAt: row.snapshot.createdAt,
        approvedAt: row.approvedAt,
        approvedBy: row.approvedBy?.name ?? null,
        note: row.note,
        openDriftCount: openDriftByDevice.get(row.deviceId) ?? 0,
        current: currentByDevice.get(row.deviceId) ?? null,
      };
    })
    .sort((a, b) => b.approvedAt.getTime() - a.approvedAt.getTime());

  const managedDevices = await db.device.findMany({
    where: { status: { not: "UNMANAGED" } },
    orderBy: { hostname: "asc" },
    select: { id: true, hostname: true },
  });
  const baselineDeviceIdSet = new Set(deviceIds);
  const withoutBaseline = managedDevices.filter(
    (d) => !baselineDeviceIdSet.has(d.id)
  );

  return ok(baselines, {
    baselineDevices: baselines.length,
    devicesWithoutBaseline: withoutBaseline.length,
    withoutBaselineDevices: withoutBaseline.slice(0, 5).map((d) => ({
      id: d.id,
      hostname: d.hostname,
    })),
  });
}

/* ───────────────────────────── POST ───────────────────────────── */

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const { deviceId, snapshotId, note } = parsed.data;

  // Phase 19-C (audit AUTHZ-001 sweep): baseline approval requires the
  // "config.baseline" permission; approver attribution comes from the
  // session principal (the seeded-admin fallback actor is removed).
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "config.baseline");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  const device = await db.device.findUnique({
    where: { id: deviceId },
    select: { id: true, hostname: true },
  });
  if (!device) {
    return fail("DEVICE_NOT_FOUND", "The requested device does not exist", 404);
  }

  // The snapshot MUST belong to the device named in the body.
  const snapshot = await db.configSnapshot.findFirst({
    where: { id: snapshotId, deviceId },
    select: { id: true, version: true, status: true },
  });
  if (!snapshot) {
    return fail(
      "SNAPSHOT_NOT_FOUND",
      "The snapshot does not exist for this device",
      404
    );
  }

  // Guard: the device's latest baseline row must not already reference it.
  const latestBaseline = await db.configBaseline.findFirst({
    where: { deviceId },
    orderBy: { approvedAt: "desc" },
    select: { id: true, snapshotId: true },
  });
  if (latestBaseline && latestBaseline.snapshotId === snapshotId) {
    return fail(
      "ALREADY_BASELINE",
      `v${snapshot.version} is already the approved baseline of ${device.hostname}`,
      409
    );
  }

  const correlationId = newCorrelationId("BL");

  const result = await db.$transaction(
    async (tx) => {
      // 1. Demote the previous BASELINE-status snapshot (if any, different id).
      const demoted = await tx.configSnapshot.updateMany({
        where: { deviceId, status: "BASELINE", id: { not: snapshotId } },
        data: { status: "HISTORICAL" },
      });

      // 2. Promote only from HISTORICAL — CURRENT stays CURRENT.
      const promoted = await tx.configSnapshot.updateMany({
        where: { id: snapshotId, status: "HISTORICAL" },
        data: { status: "BASELINE" },
      });

      const baseline = await tx.configBaseline.create({
        data: {
          deviceId,
          snapshotId,
          approvedById: actor.id,
          note: note ?? null,
        },
      });

      await tx.auditEvent.create({
        data: {
          actorId: actor.id,
          actorName: actor.name ?? "Unknown user",
          action: "BASELINE_APPROVED",
          resourceType: "ConfigBaseline",
          resourceId: baseline.id,
          resourceLabel: `${device.hostname} v${snapshot.version}`,
          result: "SUCCESS",
          correlationId,
          afterJson: JSON.stringify({
            deviceId,
            snapshotId,
            version: snapshot.version,
            note: note ?? null,
          }),
        },
      });

      return {
        baselineId: baseline.id,
        demoted: demoted.count,
        promoted: promoted.count,
      };
    },
    { maxWait: 5_000, timeout: 20_000 }
  );

  // Resulting snapshot status: BASELINE when promoted from HISTORICAL,
  // otherwise the original status (e.g. CURRENT) was left untouched.
  const finalSnapshot = await db.configSnapshot.findUnique({
    where: { id: snapshotId },
    select: { status: true },
  });

  return ok(
    {
      baseline: {
        id: result.baselineId,
        deviceId,
        snapshotId,
      },
      version: snapshot.version,
      snapshotStatus: finalSnapshot?.status ?? snapshot.status,
      audit: { action: "BASELINE_APPROVED", correlationId },
    },
    undefined,
    201
  );
}
