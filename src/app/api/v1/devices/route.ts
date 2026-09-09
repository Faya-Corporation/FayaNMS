import { db } from "@/lib/db";
import {
  csvParam,
  fail,
  firstIssueMessage,
  newJobCorrelationId,
  ok,
  pageMeta,
  paginationSchema,
  requestContext,
} from "../_lib/api";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/devices — device inventory list.
 *
 * Filters: q|search (hostname/displayName/mgmtIp contains), status (csv multi),
 * vendorId, siteId, criticality (csv multi), backupCompliance (csv multi).
 * Sort whitelist: hostname | name | status | criticality | backupCompliance |
 * lastBackupAt | lastSeen (+ dir asc/desc). Server-side pagination with
 * PageMeta; rows include joined vendor/site names and cheap relation counts.
 */
const querySchema = paginationSchema.extend({
  q: z.string().trim().min(1).max(120).optional(),
  // legacy alias kept for existing callers (search box used `search` before 2-a)
  search: z.string().trim().min(1).max(120).optional(),
  status: z.string().optional(), // csv multi
  vendorId: z.string().trim().min(1).optional(),
  siteId: z.string().trim().min(1).optional(),
  criticality: z.string().optional(), // csv multi
  backupCompliance: z.string().optional(), // csv multi
  sort: z
    .enum([
      "hostname",
      "name",
      "status",
      "criticality",
      "backupCompliance",
      "lastBackupAt",
      "lastSeen",
    ])
    .default("hostname"),
  dir: z.enum(["asc", "desc"]).default("asc"),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
    search: url.searchParams.get("search") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    vendorId: url.searchParams.get("vendorId") ?? undefined,
    siteId: url.searchParams.get("siteId") ?? undefined,
    criticality: url.searchParams.get("criticality") ?? undefined,
    backupCompliance: url.searchParams.get("backupCompliance") ?? undefined,
    sort: url.searchParams.get("sort") ?? undefined,
    dir: url.searchParams.get("dir") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400, requestContext(request));
  }

  const {
    page,
    pageSize,
    sort,
    dir,
    vendorId,
    siteId,
  } = parsed.data;
  const search = parsed.data.q ?? parsed.data.search;
  const statuses = csvParam(parsed.data.status);
  const criticalities = csvParam(parsed.data.criticality);
  const compliances = csvParam(parsed.data.backupCompliance);

  const where = {
    AND: [
      search
        ? {
            OR: [
              { hostname: { contains: search } },
              { displayName: { contains: search } },
              { mgmtIp: { contains: search } },
            ],
          }
        : {},
      statuses ? { status: { in: statuses } } : {},
      criticalities ? { criticality: { in: criticalities } } : {},
      compliances ? { backupCompliance: { in: compliances } } : {},
      vendorId ? { vendorId } : {},
      siteId ? { siteId } : {},
    ],
  };

  // "name" sorts by the display name (sortable whitelist per Phase 2 spec).
  const orderBy =
    sort === "name" ? { displayName: dir } : { [sort]: dir };

  const [total, rows] = await Promise.all([
    db.device.count({ where }),
    db.device.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        hostname: true,
        displayName: true,
        mgmtIp: true,
        model: true,
        role: true,
        status: true,
        criticality: true,
        healthScore: true,
        lastBackupAt: true,
        lastSeen: true,
        backupCompliance: true,
        site: { select: { name: true, code: true } },
        vendor: { select: { key: true, name: true } },
        _count: {
          select: { interfaces: true, snapshots: true, alerts: true },
        },
      },
    }),
  ]);

  return ok(rows, { ...pageMeta(page, pageSize, total), sort, dir }, 200, requestContext(request));
}

/* ------------------------------------------------------------------ */
/* POST — create a device (Add Device flow, Phase 2)                    */
/* ------------------------------------------------------------------ */

const IPV4_PATTERN =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

const createSchema = z.object({
  hostname: z
    .string()
    .trim()
    .min(1, "hostname is required")
    .max(63)
    .regex(HOSTNAME_PATTERN, "hostname may contain letters, digits and hyphens"),
  displayName: z.string().trim().max(120).optional(),
  vendorId: z.string().trim().min(1, "vendor is required"),
  model: z.string().trim().max(120).optional(),
  mgmtIp: z.string().trim().regex(IPV4_PATTERN, "mgmtIp must be a valid IPv4 address"),
  siteId: z.string().trim().min(1).optional(),
  // criticality: LOW | MEDIUM | HIGH | CRITICAL
  criticality: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
  // Accepted for the credential-assignment flow (2-c). The Device model has
  // no credential column yet — validated here, recorded on the audit trail.
  credentialProfileId: z.string().trim().min(1).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400, requestContext(request));
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400, requestContext(request));
  }
  const data = parsed.data;

  const vendor = await db.vendor.findUnique({
    where: { id: data.vendorId },
    select: { id: true, key: true, name: true },
  });
  if (!vendor) {
    return fail("VENDOR_NOT_FOUND", "The selected vendor does not exist", 400, requestContext(request));
  }

  if (data.siteId) {
    const site = await db.site.findUnique({ where: { id: data.siteId }, select: { id: true } });
    if (!site) {
      return fail("SITE_NOT_FOUND", "The selected site does not exist", 400, requestContext(request));
    }
  }

  if (data.credentialProfileId) {
    const profile = await db.credentialProfile.findUnique({
      where: { id: data.credentialProfileId },
      select: { id: true },
    });
    if (!profile) {
      return fail("CREDENTIAL_PROFILE_NOT_FOUND", "The selected credential profile does not exist", 400, requestContext(request));
    }
  }

  const existing = await db.device.findUnique({
    where: { hostname: data.hostname },
    select: { id: true },
  });
  if (existing) {
    return fail("HOSTNAME_TAKEN", `A device with hostname "${data.hostname}" already exists`, 409, requestContext(request));
  }

  const correlationId = newJobCorrelationId();

  try {
    const device = await db.device.create({
      data: {
        hostname: data.hostname,
        displayName: data.displayName || data.hostname,
        vendorId: data.vendorId,
        model: data.model,
        mgmtIp: data.mgmtIp,
        siteId: data.siteId,
        status: "UNKNOWN",
        criticality: data.criticality,
        backupCompliance: "UNKNOWN",
        tagsJson: data.tags && data.tags.length > 0 ? JSON.stringify(data.tags) : null,
        notes: data.notes,
      },
      select: {
        id: true,
        hostname: true,
        displayName: true,
        mgmtIp: true,
        model: true,
        role: true,
        status: true,
        criticality: true,
        healthScore: true,
        lastBackupAt: true,
        lastSeen: true,
        backupCompliance: true,
        site: { select: { name: true, code: true } },
        vendor: { select: { key: true, name: true } },
        _count: { select: { interfaces: true, snapshots: true, alerts: true } },
      },
    });

    const audit = await db.auditEvent.create({
      data: {
        actorName: "Admin",
        action: "DEVICE_CREATED",
        resourceType: "Device",
        resourceId: device.id,
        resourceLabel: device.hostname,
        result: "SUCCESS",
        correlationId,
        afterJson: JSON.stringify({
          hostname: device.hostname,
          mgmtIp: device.mgmtIp,
          vendor: vendor.key,
          siteId: data.siteId ?? null,
          credentialProfileId: data.credentialProfileId ?? null,
          criticality: device.criticality,
          status: device.status,
        }),
      },
    });

    return ok({ device, audit }, { correlationId }, 201, requestContext(request));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (message.includes("Unique constraint")) {
      return fail("HOSTNAME_TAKEN", `A device with hostname "${data.hostname}" already exists`, 409, requestContext(request));
    }
    return fail("CREATE_FAILED", "The device could not be created", 500, requestContext(request));
  }
}
