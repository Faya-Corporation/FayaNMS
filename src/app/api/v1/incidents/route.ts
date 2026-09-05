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
 * GET /api/v1/incidents
 * Filters: status (csv multi), severity (csv multi).
 * Includes site name + device count. Ordered newest first.
 */

const querySchema = paginationSchema.extend({
  status: z.string().optional(),
  severity: z.string().optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    severity: url.searchParams.get("severity") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }

  const { page, pageSize } = parsed.data;
  const statuses = csvParam(parsed.data.status);
  const severities = csvParam(parsed.data.severity);

  const where = {
    AND: [
      statuses ? { status: { in: statuses } } : {},
      severities ? { severity: { in: severities } } : {},
    ],
  };

  const [total, rows] = await Promise.all([
    db.incident.count({ where }),
    db.incident.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        number: true,
        title: true,
        severity: true,
        priority: true,
        status: true,
        source: true,
        createdAt: true,
        slaDueAt: true,
        resolvedAt: true,
        site: { select: { name: true, code: true } },
        _count: { select: { devices: true } },
      },
    }),
  ]);

  return ok(rows, pageMeta(page, pageSize, total));
}
