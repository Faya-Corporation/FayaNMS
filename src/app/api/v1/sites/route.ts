import { db } from "@/lib/db";
import { ok } from "../_lib/api";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/sites — site list with per-site aggregates for the Sites view:
 * device count by status, interface count, criticality mix and backup
 * compliance percentage (managed devices only). All aggregation happens in
 * one device fetch + JS reduce — the fleet is small; swap to groupBy when
 * this outgrows SQLite.
 */

const MANAGED_EXCLUDE = ["UNMANAGED"];

export async function GET() {
  const [sites, devices] = await Promise.all([
    db.site.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, code: true, region: true, address: true },
    }),
    db.device.findMany({
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
