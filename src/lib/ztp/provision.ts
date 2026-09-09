/**
 * FayaNMS ZTP provisioning helpers (Phase 14-b) — server-side only.
 *
 * Shared between POST /api/v1/ztp/claims (projected management IP for the
 * claim preview/toast) and POST /api/v1/worker/ztp-provision (the actual
 * management IP assigned when the Device row is created).
 *
 * ZERO-TOUCH CONTRACT: the requester never enters an address — the platform
 * reserves the management IP from the target site's existing /24 (data-driven
 * from the devices already in that site). When the site has no devices (or
 * the claim carries no site), the dedicated unassigned pool is used. The last
 * free octet wins; saturated pools fall back to .254 deterministically.
 */

import { db } from "@/lib/db";
import { FIRMWARE_LIFECYCLE } from "@/lib/firmware/lifecycle";

/** OOB pool for claims without a site (documented simulator behaviour). */
export const ZTP_UNASSIGNED_POOL = "10.99.255";

/** Vendor-authentic platform label for a freshly provisioned device. */
export const ZTP_PLATFORM_BY_VENDOR: Record<string, string> = {
  cisco: "IOS XE",
  fortinet: "FortiOS",
  sophos: "SFOS",
  hpe: "AOS-CX",
  juniper: "Junos OS",
  palo: "PAN-OS",
  generic: "Generic",
};

/**
 * Vendor-authentic default firmware for a freshly provisioned device — the
 * stable release of the vendor's first lifecycle family (same matrix the
 * firmware inventory and the seed use, so the new device classifies
 * "current" immediately).
 */
export function defaultFirmwareFor(vendorKey: string): string | null {
  const vendor = FIRMWARE_LIFECYCLE.find(
    (v) => v.vendor === vendorKey.trim().toLowerCase()
  );
  return vendor?.families[0]?.stable ?? null;
}

/** "/24" prefix of a dotted-quad ("10.40.255.3" → "10.40.255"), else null. */
function prefixOf(ip: string): string | null {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  if (parts.some((p) => p === "" || !/^\d{1,3}$/.test(p))) return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

/**
 * Project the next free management address for a site. Reads the site's
 * devices to learn the site's /24 (most-common prefix wins), then scans the
 * fleet for the lowest free last octet. Always returns a usable address.
 */
export async function projectMgmtIp(siteId: string | null): Promise<string> {
  let prefix: string | null = null;

  if (siteId) {
    const siteDevices = await db.device.findMany({
      where: { siteId },
      select: { mgmtIp: true },
    });
    const counts = new Map<string, number>();
    for (const d of siteDevices) {
      const p = prefixOf(d.mgmtIp);
      if (!p) continue;
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    let best = 0;
    for (const [p, n] of counts) {
      if (n > best) {
        best = n;
        prefix = p;
      }
    }
  }

  const effectivePrefix = prefix ?? ZTP_UNASSIGNED_POOL;

  const poolDevices = await db.device.findMany({
    where: { mgmtIp: { startsWith: `${effectivePrefix}.` } },
    select: { mgmtIp: true },
  });
  const used = new Set<number>();
  for (const d of poolDevices) {
    const parts = d.mgmtIp.split(".");
    const last = Number(parts[3]);
    if (parts.length === 4 && Number.isInteger(last) && last >= 1 && last <= 254) {
      used.add(last);
    }
  }
  for (let octet = 1; octet <= 254; octet += 1) {
    if (!used.has(octet)) return `${effectivePrefix}.${octet}`;
  }
  return `${effectivePrefix}.254`;
}
