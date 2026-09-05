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
 * GET /api/v1/changes
 * Filters: status (csv multi), type (csv multi).
 * Includes requester name. Ordered newest first.
 */

const querySchema = paginationSchema.extend({
  status: z.string().optional(),
  type: z.string().optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    type: url.searchParams.get("type") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }

  const { page, pageSize } = parsed.data;
  const statuses = csvParam(parsed.data.status);
  const types = csvParam(parsed.data.type);

  const where = {
    AND: [
      statuses ? { status: { in: statuses } } : {},
      types ? { type: { in: types } } : {},
    ],
  };

  const [total, rows] = await Promise.all([
    db.changeRequest.count({ where }),
    db.changeRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        number: true,
        title: true,
        type: true,
        status: true,
        riskScore: true,
        riskLevel: true,
        scheduledStart: true,
        scheduledEnd: true,
        createdAt: true,
        requester: { select: { id: true, name: true, email: true } },
        site: { select: { name: true, code: true } },
        _count: { select: { devices: true, steps: true } },
      },
    }),
  ]);

  return ok(rows, pageMeta(page, pageSize, total));
}
