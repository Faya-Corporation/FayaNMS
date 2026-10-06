import { db } from "@/lib/db";
import {
  authErrorToFail,
  requireSessionRead,
  sessionScopeFor,
} from "@/lib/auth/session";
import { scopedDeviceWhere, sessionSiteScope } from "@/lib/auth/scope";
import { ok } from "../_lib/api";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/sites — site list with per-site aggregates for the Sites view:
 * device count by status, interface count, criticality mix and backup
 * compliance percentage (managed devices only). All aggregation happens in
 * one device fetch + JS reduce — the fleet is small; swap to groupBy when
 * this outgrows the demo fleet.
 *
 * P1-A02 (GA re-audit 2026-10-06): the catalog itself is SCOPE-AWARE — a
 * sites-limited session sees only its own site rows and aggregates (the
 * response carries operational metadata + addresses, so an unfiltered
 * catalog was a confidentiality leak). The wildcard default (absent claim,
 * API-client bearer plane) composes NO where at all — byte-identical
 * pre-existing behavior. A deny-all scope matches nothing (`in: []`).
 */

const MANAGED_EXCLUDE = ["UNMANAGED"];

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
  // P1-A02: resolve the session scope ONCE (per-request memoized claims)
  // and compose it into BOTH the site rows and the device aggregates.
  const scopeClaims = await sessionScopeFor(request);
  const scope = sessionSiteScope(scopeClaims);
  const [sites, devices] = await Promise.all([
    db.site.findMany({
      ...(scope.mode === "sites"
        ? { where: { code: { in: scope.codes } } }
        : {}),
      orderBy: { name: "asc" },
      select: { id: true, name: true, code: true, region: true, address: true },
    }),
    db.device.findMany({
      where: scopedDeviceWhere(scopeClaims, {}),
      select: {
        id: true,
        siteId: true,
        status: true,
        criticality: true,
        backupCompliance: true,
        _count: { select: { interfaces: true } },
      },
    }),
  ]);

  const round1 = (value: number): number => Math.round(value * 10) / 10;

  const summaries = sites.map((site) => {
    const siteDevices = devices.filter((device) => device.siteId === site.id);
    const managed = siteDevices.filter(
      (device) => !MANAGED_EXCLUDE.includes(device.status)
    );

    const statusCounts: Record<string, number> = {};
    const criticalityMix: Record<string, number> = {};
    const complianceCounts: Record<string, number> = {};
    for (const device of siteDevices) {
      statusCounts[device.status] = (statusCounts[device.status] ?? 0) + 1;
      criticalityMix[device.criticality] = (criticalityMix[device.criticality] ?? 0) + 1;
      complianceCounts[device.backupCompliance] =
        (complianceCounts[device.backupCompliance] ?? 0) + 1;
    }

    const compliant = complianceCounts["COMPLIANT"] ?? 0;
    const compliancePct =
      managed.length > 0 ? round1((compliant / managed.length) * 100) : null;

    return {
      id: site.id,
      name: site.name,
      code: site.code,
      region: site.region,
      address: site.address,
      deviceCount: siteDevices.length,
      managedCount: managed.length,
      statusCounts,
      criticalityMix,
      interfaceCount: siteDevices.reduce(
        (sum, device) => sum + device._count.interfaces,
        0
      ),
      compliance: {
        pct: compliancePct,
        compliant,
        total: managed.length,
      },
    };
  });

  const totals = summaries.reduce(
    (acc, site) => ({
      devices: acc.devices + site.deviceCount,
      interfaces: acc.interfaces + site.interfaceCount,
    }),
    { devices: 0, interfaces: 0 }
  );

  return ok(summaries, { sites: summaries.length, ...totals });
}
