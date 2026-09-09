import { db } from "@/lib/db";
import { fail, firstIssueMessage, newJobCorrelationId, ok } from "../../_lib/api";
import { authErrorToFail, requirePermission } from "@/lib/auth/session";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/devices/csv-import — bulk device creation from parsed CSV rows
 * (client-side parsing; see the Devices view Import CSV dialog for the header
 * contract: hostname,vendor,model,mgmtIp,siteCode,criticality,tags with `|`
 * separating tags inside the tags cell).
 *
 * Body: { rows: [...], siteIdFallback? } (cap 200 rows)
 *   - vendor: vendor key or display name, matched case-insensitively
 *   - siteCode: site code string (e.g. HQ-SAN); when missing, siteIdFallback
 *     applies to rows without a siteCode
 *
 * Semantics mirror /api/v1/discovery/import: status "UNKNOWN", one
 * DEVICE_CREATED AuditEvent per created device (shared correlationId,
 * resourceLabel = hostname). Rows are validated individually — a bad row is
 * collected in `skipped` with a reason (validation issue, unknown vendor or
 * site code, duplicate hostname/mgmtIp in the DB or within the batch) while
 * valid rows still get created. Returns { created, devices, skipped }.
 */

const IPV4_PATTERN =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

const rowSchema = z.object({
  hostname: z
    .string()
    .trim()
    .min(1, "hostname is required")
    .max(63)
    .regex(HOSTNAME_PATTERN, "hostname may contain letters, digits and hyphens"),
  vendor: z.string().trim().min(1, "vendor is required").max(60),
  model: z.string().trim().max(120).optional(),
  mgmtIp: z.string().trim().regex(IPV4_PATTERN, "mgmtIp must be a valid IPv4 address"),
  siteCode: z.string().trim().max(40).optional(),
  // criticality: LOW | MEDIUM | HIGH | CRITICAL
  criticality: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
});

const csvImportSchema = z.object({
  rows: z.array(z.unknown()).min(1, "at least one row is required").max(200),
  siteIdFallback: z.string().trim().min(1).optional(),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = csvImportSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const { rows, siteIdFallback } = parsed.data;

  // Phase 19-C (audit AUTHZ-001 sweep): CSV import creates devices — it
  // requires the "device.write" permission and the audit rows are
  // attributed to the session principal (hardcoded "Admin" removed).
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "device.write");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  if (siteIdFallback) {
    const site = await db.site.findUnique({
      where: { id: siteIdFallback },
      select: { id: true },
    });
    if (!site) {
      return fail("SITE_NOT_FOUND", "siteIdFallback does not reference an existing site", 400);
    }
  }

  // Per-row validation: a bad row is skipped with a reason, not fatal.
  const validRows: {
    hostname: string;
    vendor: string;
    mgmtIp: string;
    model?: string;
    siteCode?: string;
    criticality: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    tags?: string[];
  }[] = [];
  const skipped: { ip: string; reason: string }[] = [];

  rows.forEach((row, index) => {
    const result = rowSchema.safeParse(row);
    if (!result.success) {
      const issue = result.error.issues[0];
      const field = issue?.path?.length > 0 ? `${issue.path.join(".")}: ` : "";
      skipped.push({
        ip: typeof (row as { mgmtIp?: unknown })?.mgmtIp === "string"
          ? String((row as { mgmtIp: string }).mgmtIp)
          : `-`,
        reason: `row ${index + 1}: ${field}${issue?.message ?? "invalid row"}`,
      });
      return;
    }
    validRows.push(result.data);
  });

  // Reference data for the whole batch.
  const [vendors, sites] = await Promise.all([
    db.vendor.findMany({ select: { id: true, key: true, name: true } }),
    db.site.findMany({ select: { id: true, code: true } }),
  ]);
  const vendorByToken = new Map<string, string>();
  for (const v of vendors) {
    vendorByToken.set(v.key.toLowerCase(), v.id);
    vendorByToken.set(v.name.toLowerCase(), v.id);
  }
  const siteByCode = new Map(sites.map((s) => [s.code.toLowerCase(), s.id]));

  // Pre-load conflicting hostnames / mgmt IPs for the whole batch.
  const [existingHostnames, existingIps] = await Promise.all([
    db.device.findMany({
      where: { hostname: { in: validRows.map((r) => r.hostname) } },
      select: { hostname: true },
    }),
    db.device.findMany({
      where: { mgmtIp: { in: validRows.map((r) => r.mgmtIp) } },
      select: { mgmtIp: true },
    }),
  ]);
  const takenHostnames = new Set(existingHostnames.map((d) => d.hostname));
  const takenIps = new Set(existingIps.map((d) => d.mgmtIp));

  const pending: {
    hostname: string;
    mgmtIp: string;
    vendorId: string;
    model: string | null;
    siteId: string | null;
    criticality: string;
    tags: string[];
  }[] = [];

  for (const row of validRows) {
    const vendorId = vendorByToken.get(row.vendor.toLowerCase());
    if (!vendorId) {
      skipped.push({ ip: row.mgmtIp, reason: `unknown vendor "${row.vendor}"` });
      continue;
    }
    let siteId: string | null = null;
    if (row.siteCode) {
      siteId = siteByCode.get(row.siteCode.toLowerCase()) ?? null;
      if (!siteId) {
        skipped.push({ ip: row.mgmtIp, reason: `unknown site code "${row.siteCode}"` });
        continue;
      }
    } else if (siteIdFallback) {
      siteId = siteIdFallback;
    }
    if (takenHostnames.has(row.hostname) || takenIps.has(row.mgmtIp)) {
      skipped.push({ ip: row.mgmtIp, reason: "duplicate" });
      continue;
    }
    takenHostnames.add(row.hostname);
    takenIps.add(row.mgmtIp);
    pending.push({
      hostname: row.hostname,
      mgmtIp: row.mgmtIp,
      vendorId,
      model: row.model ?? null,
      siteId,
      criticality: row.criticality,
      tags: row.tags ?? [],
    });
  }

  const created: { id: string; hostname: string; ip: string }[] = [];
  const correlationId = newJobCorrelationId();

  if (pending.length > 0) {
    await db.$transaction(async (tx) => {
      for (const entry of pending) {
        const device = await tx.device.create({
          data: {
            hostname: entry.hostname,
            displayName: entry.hostname,
            mgmtIp: entry.mgmtIp,
            vendorId: entry.vendorId,
            model: entry.model,
            siteId: entry.siteId,
            status: "UNKNOWN",
            criticality: entry.criticality,
            healthScore: 0,
            backupCompliance: "UNKNOWN",
            tagsJson: entry.tags.length > 0 ? JSON.stringify(entry.tags) : null,
          },
          select: { id: true, hostname: true, mgmtIp: true },
        });
        created.push({
          id: device.id,
          hostname: device.hostname,
          ip: device.mgmtIp,
        });

        await tx.auditEvent.create({
          data: {
            actorId: actor.id,
            actorName: actor.name ?? "Unknown user",
            action: "DEVICE_CREATED",
            resourceType: "Device",
            resourceId: device.id,
            resourceLabel: device.hostname,
            result: "SUCCESS",
            correlationId,
            afterJson: JSON.stringify({
              hostname: device.hostname,
              mgmtIp: device.mgmtIp,
              siteId: entry.siteId,
              criticality: entry.criticality,
              status: "UNKNOWN",
              source: "CSV_IMPORT",
            }),
          },
        });
      }
    });
  }

  return ok({ created: created.length, devices: created, skipped }, { correlationId });
}
