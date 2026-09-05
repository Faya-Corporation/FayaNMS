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
 * GET /api/v1/alerts
 * Filters: status (csv multi), severity (csv multi).
 * Includes device hostname. Ordered by lastSeen desc (live-style stream).
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
    db.alert.count({ where }),
    db.alert.findMany({
      where,
      orderBy: { lastSeen: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        severity: true,
        message: true,
        status: true,
        firstSeen: true,
        lastSeen: true,
        count: true,
        device: { select: { id: true, hostname: true } },
        acknowledgedAt: true,
      },
    }),
  ]);

  return ok(rows, pageMeta(page, pageSize, total));
}
