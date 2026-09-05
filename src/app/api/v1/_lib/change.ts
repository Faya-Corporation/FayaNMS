import { db } from "@/lib/db";
import {
  deviceAffectsFirewall,
  isBusinessHours,
  scoreChangeRisk,
  type RiskBreakdown,
  type RiskInput,
} from "@/lib/change/risk";

/**
 * Shared server-side helpers for the /api/v1/changes routes (Task 4-a).
 * Keep these tiny and DB-only — the pure risk math lives in
 * src/lib/change/risk.ts so client preview and server scoring agree.
 */

/** Default 5-step plan when a change is created without explicit steps
 *  (same shape as the guarded-restore steps from Task 3-c). */
export const DEFAULT_CHANGE_STEPS: { name: string; type: string }[] = [
  { name: "Verify device reachable", type: "CHECK" },
  { name: "Pre-change backup", type: "BACKUP" },
  { name: "Apply configuration changes", type: "APPLY" },
  { name: "Post-change validation", type: "VALIDATE" },
  { name: "Post-change backup", type: "BACKUP" },
];

/** Device attributes the risk engine needs (joined for the API routes). */
export interface RiskDeviceContext {
  id: string;
  hostname: string;
  model: string | null;
  role: string | null;
  criticality: string;
  siteId: string | null;
  vendorKey: string | null;
}

/** Load the targeted devices; returns the rows plus any unknown ids. */
export async function fetchRiskDevices(
  deviceIds: string[]
): Promise<{ devices: RiskDeviceContext[]; missing: string[] }> {
  const rows = await db.device.findMany({
    where: { id: { in: deviceIds } },
    select: {
      id: true,
      hostname: true,
      model: true,
      role: true,
      criticality: true,
      siteId: true,
      vendor: { select: { key: true } },
    },
  });
  const found = new Set(rows.map((r) => r.id));
  return {
    devices: rows.map((r) => ({
      id: r.id,
      hostname: r.hostname,
      model: r.model,
      role: r.role,
      criticality: r.criticality,
      siteId: r.siteId,
      vendorKey: r.vendor?.key ?? null,
    })),
    missing: deviceIds.filter((id) => !found.has(id)),
  };
}

/**
 * Build the pure risk input from device rows + form fields. Distinct site
 * buckets count null (unassigned) as ONE bucket so the client preview
 * (site codes) and server (siteIds) agree structurally.
 */
export function buildRiskInput(
  devices: RiskDeviceContext[],
  opts: {
    type: RiskInput["type"];
    hasRollbackPlan: boolean;
    hasValidationPlan: boolean;
    scheduledStart: Date | null;
  }
): RiskInput {
  const siteBuckets = new Set(devices.map((d) => d.siteId ?? "_unassigned"));
  return {
    deviceCriticalities: devices.map((d) => d.criticality),
    deviceCount: devices.length,
    type: opts.type,
    siteCount: siteBuckets.size,
    hasRollbackPlan: opts.hasRollbackPlan,
    hasValidationPlan: opts.hasValidationPlan,
    scheduledBusinessHours: opts.scheduledStart
      ? isBusinessHours(opts.scheduledStart)
      : false,
    affectsFirewall: devices.some((d) => deviceAffectsFirewall(d)),
  };
}

/** Authoritative score used by POST and PATCH (same module the client uses). */
export function scoreChangeServerSide(
  devices: RiskDeviceContext[],
  opts: {
    type: RiskInput["type"];
    hasRollbackPlan: boolean;
    hasValidationPlan: boolean;
    scheduledStart: Date | null;
  }
): RiskBreakdown {
  return scoreChangeRisk(buildRiskInput(devices, opts));
}

/**
 * Next change number CHG-YYYY-NNNNN (max existing + 1, padded 5).
 * Same pattern as the guarded-restore route (Task 3-c).
 */
export async function nextChangeNumber(): Promise<string> {
  const maxChange = await db.changeRequest.findFirst({
    orderBy: { number: "desc" },
    select: { number: true },
  });
  const maxSeq = Number.parseInt(maxChange?.number.slice(-5) ?? "0", 10);
  return `CHG-${new Date().getFullYear()}-${String(
    (Number.isFinite(maxSeq) ? maxSeq : 0) + 1
  ).padStart(5, "0")}`;
}

/** Seeded admin user as the demo requester (same lookup as the restore route). */
export async function demoActor(): Promise<{ id: string; name: string | null } | null> {
  return db.user.findFirst({
    where: { role: "admin", isActive: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });
}
