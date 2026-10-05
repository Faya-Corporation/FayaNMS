import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import {
  authErrorToFail,
  requireSessionRead,
  sessionScopeFor,
} from "@/lib/auth/session";
import { scopedDeviceWhere, sessionSiteScope } from "@/lib/auth/scope";
import { ok } from "../../_lib/api";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/compliance/backup — fleet backup-compliance report (Task 3-a).
 *
 * Bands are recomputed live from Device.lastBackupAt and aligned with the
 * BACKUP_COMPLIANCE keys in src/lib/domain/status.ts:
 *   COMPLIANT        — last successful backup within 24 h
 *   OVERDUE          — last successful backup within 72 h (at-risk band)
 *   non-compliant    — older than 72 h (stale) or never backed up
 *                      (NEVER_BACKED_UP)
 * Managed fleet = every device except UNMANAGED (same convention as the
 * dashboard). The dashboard's own compliance widget is untouched.
 *
 * The 24 h / 72 h windows are a static policy approximation and must be
 * labeled as such in the UI.
 *
 * F-031 (wave-12, audit 18-a P2-2 — the wave-10 drift F-4 recipe): the
 * fleet read is SCOPE-FUSED — scopedDeviceWhere composes the session's
 * site scope into the single device fetch and every derived artifact
 * (banded rows, KPIs, perSite bands, the staleDevices top-10) describes
 * the SCOPED fleet only. The per-site breakdown's catalog scan intersects
 * the scope codes (the cmdb/items exemplar) so out-of-scope site rows
 * never appear, and snapshotsLast24h joins the same rule through the
 * snapshot's device relation. Wildcard sessions (no `sites` claim — the
 * single-tenant default) keep the byte-unchanged queries and output; a
 * deny-all scope (empty/malformed claim) answers zeroed KPIs with empty
 * rows/perSite/staleDevices (still 200, the plane convention).
 */

const HOURS_MS = 3_600_000;
const COMPLIANT_WINDOW_MS = 24 * HOURS_MS;
const AT_RISK_WINDOW_MS = 72 * HOURS_MS;
const STALE_LIMIT = 10;

const round1 = (value: number): number => Math.round(value * 10) / 10;

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
  const now = Date.now();
  const compliantCutoff = new Date(now - COMPLIANT_WINDOW_MS);
  const atRiskCutoff = new Date(now - AT_RISK_WINDOW_MS);
  const snapshotsSince24h = new Date(now - COMPLIANT_WINDOW_MS);

  // F-031 (wave-12): the session's site scope drives every fetch below
  // (wildcard sessions — absent claims — keep byte-identical behavior).
  const scopeClaims = await sessionScopeFor(request);
  const scope = sessionSiteScope(scopeClaims);

  const [devices, snapshotsLast24h] = await Promise.all([
    db.device.findMany({
      where: scopedDeviceWhere(scopeClaims, {
        // F-031 (wave-12): the managed-fleet base where composed with the
        // session scope — wildcard passes the base where through unchanged
        // (parity), sites-limited scopes restrict to `site.code IN (…)` and
        // a deny-all scope (`in: []`) matches nothing.
        status: { not: "UNMANAGED" },
      }),
      select: {
        id: true,
        hostname: true,
        lastBackupAt: true,
        siteId: true,
        site: { select: { name: true, code: true } },
      },
    }),
    db.configSnapshot.count({
      where: {
        createdAt: { gte: snapshotsSince24h },
        // Scope-fused too (the snapshot's device relation): wildcard keeps
        // the bare createdAt filter, deny-all/scoped counts only in-scope
        // devices' snapshots.
        ...(scope.mode === "wildcard"
          ? {}
          : { device: scopedDeviceWhere(scopeClaims, {}) }),
      },
    }),
  ]);

  type Band = "COMPLIANT" | "OVERDUE" | "NEVER_BACKED_UP" | "STALE";
  interface BandedDevice {
    id: string;
    hostname: string;
    siteId: string | null;
    siteName: string | null;
    siteCode: string | null;
    lastBackupAt: Date | null;
    band: Band;
  }

  const banded: BandedDevice[] = devices.map((device) => {
    const last = device.lastBackupAt;
    let band: Band;
    if (!last) band = "NEVER_BACKED_UP";
    else if (last >= compliantCutoff) band = "COMPLIANT";
    else if (last >= atRiskCutoff) band = "OVERDUE";
    else band = "STALE";
    return {
      id: device.id,
      hostname: device.hostname,
      siteId: device.siteId,
      siteName: device.site?.name ?? null,
      siteCode: device.site?.code ?? null,
      lastBackupAt: last,
      band,
    };
  });

  const managedDevices = banded.length;
  const compliant = banded.filter((d) => d.band === "COMPLIANT").length;
  const atRisk = banded.filter((d) => d.band === "OVERDUE").length;
  const nonCompliant = managedDevices - compliant - atRisk;

  // Per-site breakdown (devices without a site land in an "Unassigned" row).
  const siteRows = await db.site.findMany({
    // F-031 (wave-12): the per-site bands only include IN-SCOPE sites —
    // the catalog scan intersects the scope codes (cmdb/items exemplar);
    // wildcard keeps the full scan. A deny-all scope matches no site rows,
    // so perSite collapses to [] with the scoped device rows.
    ...(scope.mode === "wildcard" ? {} : { where: { code: { in: scope.codes } } }),
    orderBy: { name: "asc" },
    select: { id: true, name: true, code: true },
  });
  const bySite = new Map<
    string,
    {
      siteId: string | null;
      siteName: string;
      siteCode: string | null;
      managed: number;
      compliant: number;
      atRisk: number;
      nonCompliant: number;
    }
  >();
  for (const site of siteRows) {
    bySite.set(site.id, {
      siteId: site.id,
      siteName: site.name,
      siteCode: site.code,
      managed: 0,
      compliant: 0,
      atRisk: 0,
      nonCompliant: 0,
    });
  }
  bySite.set("__unassigned", {
    siteId: null,
    siteName: "Unassigned",
    siteCode: null,
    managed: 0,
    compliant: 0,
    atRisk: 0,
    nonCompliant: 0,
  });
  for (const device of banded) {
    const key = device.siteId ?? "__unassigned";
    const row = bySite.get(key);
    if (!row) continue;
    row.managed += 1;
    if (device.band === "COMPLIANT") row.compliant += 1;
    else if (device.band === "OVERDUE") row.atRisk += 1;
    else row.nonCompliant += 1;
  }
  const perSite = Array.from(bySite.values())
    .filter((row) => row.managed > 0)
    .map((row) => ({
      ...row,
      compliantPct:
        row.managed > 0 ? round1((row.compliant / row.managed) * 100) : null,
    }))
    .sort((a, b) => (b.compliantPct ?? 0) - (a.compliantPct ?? 0));

  // Stale devices — worst first: never backed up, then oldest lastBackupAt.
  const staleDevices = banded
    .filter((d) => d.band !== "COMPLIANT")
    .sort((a, b) => {
      if (!a.lastBackupAt && !b.lastBackupAt) {
        return a.hostname.localeCompare(b.hostname);
      }
      if (!a.lastBackupAt) return -1;
      if (!b.lastBackupAt) return 1;
      return a.lastBackupAt.getTime() - b.lastBackupAt.getTime();
    })
    .slice(0, STALE_LIMIT)
    .map((device) => ({
      deviceId: device.id,
      hostname: device.hostname,
      siteName: device.siteName,
      siteCode: device.siteCode,
      lastBackupAt: device.lastBackupAt?.toISOString() ?? null,
      // Badge key from the BACKUP_COMPLIANCE map; a stale (older than 72 h)
      // device renders as OVERDUE — the relative-time column shows the age.
      band: device.band === "STALE" ? "OVERDUE" : device.band,
    }));

  return ok({
    kpis: {
      managedDevices,
      compliant,
      atRisk,
      nonCompliant,
      compliantPct:
        managedDevices > 0 ? round1((compliant / managedDevices) * 100) : 0,
      snapshotsLast24h,
    },
    perSite,
    staleDevices,
    bands: {
      compliantWindowHours: 24,
      atRiskWindowHours: 72,
      note: "COMPLIANT ≤ 24h · OVERDUE (at risk) 24–72h · non-compliant > 72h or never",
    },
  });
}
