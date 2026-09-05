import { db } from "@/lib/db";
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
 * GET /api/v1/devices
 * Filters: search (hostname/displayName/mgmtIp contains), status (csv multi),
 * vendorId, siteId, criticality. Sort whitelist + server pagination.
 */

const querySchema = paginationSchema.extend({
  search: z.string().trim().min(1).max(120).optional(),
  status: z.string().optional(), // csv multi, validated as free strings
  vendorId: z.string().trim().min(1).optional(),
  siteId: z.string().trim().min(1).optional(),
  criticality: z.string().trim().min(1).optional(),
  sort: z
    .enum(["hostname", "status", "criticality", "lastBackupAt", "lastSeen"])
    .default("hostname"),
  dir: z.enum(["asc", "desc"]).default("asc"),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
    search: url.searchParams.get("search") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    vendorId: url.searchParams.get("vendorId") ?? undefined,
    siteId: url.searchParams.get("siteId") ?? undefined,
    criticality: url.searchParams.get("criticality") ?? undefined,
    sort: url.searchParams.get("sort") ?? undefined,
    dir: url.searchParams.get("dir") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }

  const { page, pageSize, search, vendorId, siteId, criticality, sort, dir } =
    parsed.data;
  const statuses = csvParam(parsed.data.status);

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
      vendorId ? { vendorId } : {},
      siteId ? { siteId } : {},
      criticality ? { criticality } : {},
    ],
  };

  const [total, rows] = await Promise.all([
    db.device.count({ where }),
    db.device.findMany({
      where,
      orderBy: { [sort]: dir },
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
      },
    }),
  ]);

  return ok(rows, { ...pageMeta(page, pageSize, total), sort, dir });
}
