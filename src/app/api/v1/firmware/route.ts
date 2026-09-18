import { db } from "@/lib/db";
import { ok } from "../_lib/api";
import {
  getLifecycle,
  suggestTarget,
  type LifecycleStatus,
} from "@/lib/firmware/lifecycle";
import { z } from "zod";

export const dynamic = "force-dynamic";

/* ─────────────────────────────────────────────────────────────────────────────
 * Firmware inventory (Phase 13-b)
 *
 * GET /api/v1/firmware → one row per device with:
 *   - the current firmware string (Device.firmware, seeded vendor-authentic),
 *   - the lifecycle classification from the static vendor matrix
 *     (src/lib/firmware/lifecycle.ts — documented simulated vendor data),
 *   - lastUpgradeAt: finishedAt of the device's newest SUCCEEDED
 *     FIRMWARE_UPGRADE job (null when the device was never upgraded here),
 *   - openUpgradeJob: true while a FIRMWARE_UPGRADE job for the device is
 *     QUEUED or RUNNING (the upgrade endpoint rejects a second one with 409),
 *   - suggestedTarget: the matrix's stable release for the matched family
 *     (the upgrade dialog pre-fills it).
 *
 * Rows are ranked worst-first (eol → eos → aging → current → unknown), then
 * hostname — the view renders them in that order. meta carries the counts
 * by lifecycle status + total. Read-only GET → no audit event (app
 * convention); the envelope meta carries the stamped requestId (HC-3/R55:
 * the deprecated per-call context trailing arg was removed everywhere).
 * ───────────────────────────────────────────────────────────────────────────── */

/** Lifecycle severity rank — lower sorts first (worst on top). */
const STATUS_RANK: Record<LifecycleStatus | "unknown", number> = {
  eol: 0,
  eos: 1,
  aging: 2,
  current: 3,
  unknown: 4,
};

/* ── output schema (Zod-validated response contract) ── */

const lifecycleSchema = z.object({
  status: z.enum(["current", "aging", "eos", "eol"]),
  detail: z.string(),
  family: z.string(),
});

const rowSchema = z.object({
  deviceId: z.string(),
  hostname: z.string(),
  deviceStatus: z.string(),
  vendorKey: z.string(),
  vendorName: z.string(),
  model: z.string().nullable(),
  platform: z.string().nullable(),
  firmware: z.string().nullable(),
  lifecycle: lifecycleSchema.nullable(),
  suggestedTarget: z.string().nullable(),
  lastUpgradeAt: z.string().nullable(),
  openUpgradeJob: z.boolean(),
});

const countsSchema = z.object({
  total: z.number().int().nonnegative(),
  current: z.number().int().nonnegative(),
  aging: z.number().int().nonnegative(),
  eos: z.number().int().nonnegative(),
  eol: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
});

const payloadSchema = z.object({
  devices: z.array(rowSchema),
  meta: z.object({ counts: countsSchema, computedAt: z.string() }),
});

export type FirmwareInventoryRow = z.infer<typeof rowSchema>;

export async function GET(request: Request) {
  const devices = await db.device.findMany({
    select: {
      id: true,
      hostname: true,
      status: true,
      model: true,
      platform: true,
      firmware: true,
      vendor: { select: { key: true, name: true } },
    },
    orderBy: { hostname: "asc" },
  });

  // Bounded reads: upgrade history (few rows — the feature is new) and the
  // open-jobs set (QUEUED/RUNNING only).
  const [upgradeJobs, openJobs] = await Promise.all([
    db.jobExecution.findMany({
      where: {
        type: "FIRMWARE_UPGRADE",
        status: "SUCCEEDED",
        targetType: "DEVICE",
      },
      select: { targetId: true, finishedAt: true },
      orderBy: { finishedAt: "desc" },
    }),
    db.jobExecution.findMany({
      where: {
        type: "FIRMWARE_UPGRADE",
        status: { in: ["QUEUED", "RUNNING"] },
        targetType: "DEVICE",
      },
      select: { targetId: true },
    }),
  ]);

  const lastUpgradeByDevice = new Map<string, string>();
  for (const job of upgradeJobs) {
    if (!job.targetId) continue;
    const current = lastUpgradeByDevice.get(job.targetId);
    const stamp = job.finishedAt?.toISOString() ?? null;
    if (stamp && (!current || stamp > current)) {
      lastUpgradeByDevice.set(job.targetId, stamp);
    }
  }
  const openJobDevices = new Set(
    openJobs.map((job) => job.targetId).filter((id): id is string => !!id)
  );

  const rows: FirmwareInventoryRow[] = devices.map((device) => {
    const lifecycle = getLifecycle(device.vendor.key, device.firmware);
    return {
      deviceId: device.id,
      hostname: device.hostname,
      deviceStatus: device.status,
      vendorKey: device.vendor.key,
      vendorName: device.vendor.name,
      model: device.model,
      platform: device.platform,
      firmware: device.firmware,
      lifecycle: lifecycle
        ? {
            status: lifecycle.status,
            detail: lifecycle.detail,
            family: lifecycle.family,
          }
        : null,
      suggestedTarget: suggestTarget(device.vendor.key, device.firmware),
      lastUpgradeAt: lastUpgradeByDevice.get(device.id) ?? null,
      openUpgradeJob: openJobDevices.has(device.id),
    };
  });

  // Worst-first ranking for the view; hostname as the deterministic tiebreak.
  rows.sort((a, b) => {
    const rankA = STATUS_RANK[a.lifecycle?.status ?? "unknown"];
    const rankB = STATUS_RANK[b.lifecycle?.status ?? "unknown"];
    if (rankA !== rankB) return rankA - rankB;
    return a.hostname.localeCompare(b.hostname);
  });

  const counts = {
    total: rows.length,
    current: rows.filter((r) => r.lifecycle?.status === "current").length,
    aging: rows.filter((r) => r.lifecycle?.status === "aging").length,
    eos: rows.filter((r) => r.lifecycle?.status === "eos").length,
    eol: rows.filter((r) => r.lifecycle?.status === "eol").length,
    unknown: rows.filter((r) => r.lifecycle === null).length,
  };

  const payload = {
    devices: rows,
    meta: { counts, computedAt: new Date().toISOString() },
  };

  // Defensive: the contract below is what the UI types against.
  const validated = payloadSchema.parse(payload);

  return ok(validated, undefined, 200);
}
