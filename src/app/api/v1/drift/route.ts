import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { authErrorToFail, requireSessionRead, sessionScopeFor } from "@/lib/auth/session";
import { scopedDeviceWhere, sessionSiteScope } from "@/lib/auth/scope";
import {
  csvParam,
  fail,
  firstIssueMessage,
  ok,
  pageMeta,
  paginationSchema,
} from "../_lib/api";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/drift — drift records list (Task 3-c).
 *
 * Filters: status (csv multi, e.g. "OPEN"), deviceId (optional — powers the
 * per-device drift counts in the restore dialog). Ordering: OPEN records
 * first, then detectedAt desc. Drift records are low-volume (an upsert per
 * device keeps the count flat), so rows are fetched (cap 500), sorted and
 * paginated in memory to get the "OPEN first" ordering right on SQLite.
 *
 * meta: { open, accepted, resolvedToday, lastCheckedAt, devicesAffected,
 *         hasBaselines } + the standard page fields. lastCheckedAt is the
 * latest finishedAt of any DRIFT_CHECK job; hasBaselines tells the view
 * whether the "Run drift check" action can do anything.
 *
 * GET is side-effect free (no audit).
 *
 * F-031 wave-10 (audit 13-c F-4): drift rows carry hostnames, sites,
 * snapshot sha256s and the diffSummary CONFIG CONTENT — the list where and
 * the device-derivable meta aggregates (open/accepted/resolvedToday,
 * devicesAffected, hasBaselines) compose the session scope through the
 * device relation (wildcard keeps the byte-unchanged shapes). One aggregate
 * residual stays GLOBAL by the documented dashboard posture: lastCheckedAt
 * (JobExecution carries no site linkage; a bare timestamp — no resource
 * identity).
 */

const querySchema = paginationSchema.extend({
  status: z.string().optional(),
  deviceId: z.string().trim().min(1).max(64).optional(),
});

const ROW_CAP = 500;

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
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    deviceId: url.searchParams.get("deviceId") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }

  const { page, pageSize, deviceId } = parsed.data;
  const statuses = csvParam(parsed.data.status);

  // F-031 wave-10: one device-relation scope composition feeds the rows AND
  // the device-derivable meta aggregates. Wildcard keeps the exact
  // pre-wave-10 query shapes (the parity guarantee).
  const scopeClaims = await sessionScopeFor(request);
  const scope = sessionSiteScope(scopeClaims);
  const deviceScope: Prisma.DriftRecordWhereInput =
    scope.mode === "wildcard"
      ? {}
      : { device: scopedDeviceWhere(scopeClaims, {}) };

  const where: Prisma.DriftRecordWhereInput = {
    AND: [
      statuses ? { status: { in: statuses } } : {},
      deviceId ? { deviceId } : {},
      deviceScope,
    ],
  };

  const [rows, open, accepted, resolvedToday, lastJob, devicesAffectedGroups, baselineDevices] =
    await Promise.all([
      db.driftRecord.findMany({
        where,
        orderBy: { detectedAt: "desc" },
        take: ROW_CAP,
        select: {
          id: true,
          deviceId: true,
          baselineSnapshotId: true,
          currentSnapshotId: true,
          detectedAt: true,
          diffSummary: true,
          status: true,
          resolvedAt: true,
          device: {
            select: {
              hostname: true,
              site: { select: { name: true, code: true } },
            },
          },
          baselineSnapshot: {
            select: { version: true, sha256: true },
          },
          currentSnapshot: {
            select: { version: true, sha256: true, createdAt: true },
          },
        },
      }),
      db.driftRecord.count({ where: { status: "OPEN", ...deviceScope } }),
      db.driftRecord.count({ where: { status: "ACCEPTED", ...deviceScope } }),
      db.driftRecord.count({
        where: {
          status: "RESOLVED",
          resolvedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
          ...deviceScope,
        },
      }),
      db.jobExecution.findFirst({
        where: { type: "DRIFT_CHECK", finishedAt: { not: null } },
        orderBy: { finishedAt: "desc" },
        select: { finishedAt: true },
      }),
      db.driftRecord.groupBy({
        by: ["deviceId"],
        _count: { _all: true },
        where: { status: "OPEN", ...deviceScope },
      }),
      db.configBaseline.findMany({
        // Scope-intersected for sites-limited sessions (hasBaselines = can
        // the SESSION's devices run a drift check at all).
        where: scope.mode === "wildcard" ? undefined : { device: scopedDeviceWhere(scopeClaims, {}) },
        select: { deviceId: true },
        distinct: ["deviceId"],
      }),
    ]);

  // OPEN records first, then detectedAt desc.
  const sorted = [...rows].sort((a, b) => {
    if (a.status === b.status) {
      return b.detectedAt.getTime() - a.detectedAt.getTime();
    }
    return a.status === "OPEN" ? -1 : b.status === "OPEN" ? 1 : 0;
  });

  const total = sorted.length;
  const pageRows = sorted.slice((page - 1) * pageSize, page * pageSize);

  return ok(
    pageRows.map((row) => ({
      id: row.id,
      deviceId: row.deviceId,
      hostname: row.device.hostname,
      siteName: row.device.site?.name ?? null,
      siteCode: row.device.site?.code ?? null,
      baselineSnapshotId: row.baselineSnapshotId,
      baselineVersion: row.baselineSnapshot.version,
      baselineSha256: row.baselineSnapshot.sha256,
      currentSnapshotId: row.currentSnapshotId,
      currentVersion: row.currentSnapshot.version,
      currentSha256: row.currentSnapshot.sha256,
      currentCreatedAt: row.currentSnapshot.createdAt,
      detectedAt: row.detectedAt,
      diffSummary: row.diffSummary,
      status: row.status,
      resolvedAt: row.resolvedAt,
    })),
    {
      ...pageMeta(page, pageSize, total),
      open,
      accepted,
      resolvedToday,
      lastCheckedAt: lastJob?.finishedAt ?? null,
      devicesAffected: devicesAffectedGroups.length,
      hasBaselines: baselineDevices.length > 0,
    }
  );
}
