import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok, pageMeta, paginationSchema } from "../../../_lib/api";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/devices/[id]/snapshots
 *
 * Configuration snapshot version history for a device, newest version
 * first. Includes rawText + normalizedText so the Phase 2 config viewer
 * (search/wrap/mask) works without a second fetch; per-device history is
 * small (3–5 versions). Optional `source` csv filter (used by the Backups
 * tab to list backup-ish runs).
 */

const querySchema = paginationSchema.extend({
  source: z.string().optional(), // csv multi: SCHEDULED|MANUAL|PRE_CHANGE|POST_CHANGE|EVENT
});

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id || id.length > 64) {
    return fail("INVALID_ID", "Invalid device id", 400);
  }

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
    source: url.searchParams.get("source") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }
  const { page, pageSize } = parsed.data;
  const sources = parsed.data.source
    ?.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const device = await db.device.findUnique({
    where: { id },
    select: { id: true, hostname: true },
  });
  if (!device) {
    return fail("DEVICE_NOT_FOUND", "The requested device does not exist", 404);
  }

  const where = {
    deviceId: id,
    ...(sources && sources.length > 0 ? { source: { in: sources } } : {}),
  };

  const [total, rows] = await Promise.all([
    db.configSnapshot.count({ where }),
    db.configSnapshot.findMany({
      where,
      orderBy: { version: "desc" },
      skip: (page - 1) * pageSize,
      take: Math.min(pageSize, 50),
      select: {
        id: true,
        version: true,
        source: true,
        configType: true,
        status: true,
        sha256: true,
        sizeBytes: true,
        rawText: true,
        normalizedText: true,
        createdAt: true,
        change: { select: { number: true, title: true } },
        user: { select: { name: true } },
        job: { select: { correlationId: true } },
      },
    }),
  ]);

  return ok(
    rows.map((row) => ({
      id: row.id,
      version: row.version,
      source: row.source,
      configType: row.configType,
      status: row.status,
      sha256: row.sha256,
      sizeBytes: row.sizeBytes,
      rawText: row.rawText,
      normalizedText: row.normalizedText,
      createdAt: row.createdAt,
      changeNumber: row.change?.number ?? null,
      capturedBy: row.user?.name ?? null,
      correlationId: row.job?.correlationId ?? null,
    })),
    { ...pageMeta(page, Math.min(pageSize, 50), total), hostname: device.hostname }
  );
}
