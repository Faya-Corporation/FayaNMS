import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  authErrorToFail,
  requireSessionRead,
  sessionScopeFor,
} from "@/lib/auth/session";
import { scopedDeviceWhere, sessionSiteScope } from "@/lib/auth/scope";
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
 *
 * F-031 wave-9 (read-plane migration): snapshots are device-derived rows,
 * so the where clause composes the session scope through the device
 * relation (scopedDeviceWhere) — a sites-limited session no longer reads
 * another site's history via ?deviceId=<out-of-scope-cuid> (which defeated
 * the wave-7 fused-404 gates on the per-device sibling). List semantics:
 * an out-of-scope/unknown deviceId yields the SAME 200 + empty-list shape
 * as any other empty filter result (no existence leak, no 404). Wildcard
 * sessions (no `sites` claim — the single-tenant default) keep the
 * byte-unchanged where shape; deny-all sessions see an empty list.
 */

const querySchema = paginationSchema.extend({
  status: z.string().optional(), // csv multi: CURRENT|HISTORICAL|BASELINE
  source: z.string().optional(), // csv multi: SCHEDULED|MANUAL|PRE_CHANGE|POST_CHANGE|EVENT
  q: z.string().trim().min(1).max(120).optional(),
  // P3 F-9 (wave-9): bound the deviceId filter — it feeds a where clause
  // and must not be an unbounded string.
  deviceId: z.string().trim().min(1).max(64).optional(),
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

  // F-031 wave-9: the scope rides the device relation. Sites-limited
  // sessions get `device: scopedDeviceWhere(...)` merged into the AND
  // (out-of-scope snapshots vanish, including the ?deviceId= bypass);
  // wildcard keeps the exact pre-F-031 where shape (parity guarantee);
  // deny-all (`codes: []`) naturally matches nothing.
  const scopeClaims = await sessionScopeFor(request);
  const scope = sessionSiteScope(scopeClaims);
  const where: Prisma.ConfigSnapshotWhereInput = {
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
      ...(scope.mode === "sites"
        ? [{ device: scopedDeviceWhere(scopeClaims, {}) }]
        : []),
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
