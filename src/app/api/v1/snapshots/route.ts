import { db } from "@/lib/db";
import { authErrorToFail, requireSessionRead } from "@/lib/auth/session";
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
 * GET /api/v1/snapshots — fleet-wide configuration snapshot history
 * (Task 3-a Backups view, History tab). Newest first, joined device
 * hostname + site. Filters: status (csv multi), source (csv multi),
 * q (hostname / mgmtIp contains). pageSize is hard-capped at 25 —
 * rows are metadata only (rawText lives on the per-device endpoint
 * and the audited download route).
 */

const querySchema = paginationSchema.extend({
  status: z.string().optional(), // csv multi: CURRENT|HISTORICAL|BASELINE
  source: z.string().optional(), // csv multi: SCHEDULED|MANUAL|PRE_CHANGE|POST_CHANGE|EVENT
  q: z.string().trim().min(1).max(120).optional(),
  deviceId: z.string().trim().min(1).optional(),
});

const PAGE_SIZE_CAP = 25;

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
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    source: url.searchParams.get("source") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
    deviceId: url.searchParams.get("deviceId") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }

  const page = parsed.data.page;
  const pageSize = Math.min(parsed.data.pageSize, PAGE_SIZE_CAP);
  const statuses = csvParam(parsed.data.status);
  const sources = csvParam(parsed.data.source);
  const q = parsed.data.q;

  const where = {
    AND: [
      statuses && statuses.length > 0 ? { status: { in: statuses } } : {},
      sources && sources.length > 0 ? { source: { in: sources } } : {},
      parsed.data.deviceId ? { deviceId: parsed.data.deviceId } : {},
      q
        ? {
            device: {
              OR: [
                { hostname: { contains: q } },
                { mgmtIp: { contains: q } },
              ],
            },
          }
        : {},
    ],
  };

  const [total, rows] = await Promise.all([
    db.configSnapshot.count({ where }),
    db.configSnapshot.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        deviceId: true,
        version: true,
        source: true,
        configType: true,
        status: true,
        sha256: true,
        sizeBytes: true,
        createdAt: true,
        device: {
          select: {
            hostname: true,
            mgmtIp: true,
            site: { select: { name: true, code: true } },
          },
        },
        job: { select: { correlationId: true } },
      },
    }),
  ]);

  return ok(
    rows.map((row) => ({
      id: row.id,
      deviceId: row.deviceId,
      hostname: row.device.hostname,
      siteName: row.device.site?.name ?? null,
      siteCode: row.device.site?.code ?? null,
      version: row.version,
      source: row.source,
      configType: row.configType,
      status: row.status,
      sha256: row.sha256,
      sizeBytes: row.sizeBytes,
      createdAt: row.createdAt,
      correlationId: row.job?.correlationId ?? null,
    })),
    pageMeta(page, pageSize, total)
  );
}
