import { db } from "@/lib/db";
import {
  fail,
  firstIssueMessage,
  newCorrelationId,
  ok,
  pageMeta,
  paginationSchema,
} from "../_lib/api";
import { resolveActingUser } from "../_lib/actor";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * Maintenance windows (Task 5-c) — the CRUD surface behind the alert
 * engine's suppression (src/lib/alerts/evaluate.ts reads isActive windows
 * that cover "now" for the device or its site; those semantics are NOT
 * changed here).
 *
 * GET  /api/v1/maintenance — paginated list with a computed per-row status
 *      (ACTIVE = time coverage now, UPCOMING = startsAt in the future,
 *      PAST = endsAt in the past; the isActive flag is independent and
 *      rendered as "suppression paused"). Filters: status, siteId,
 *      deviceId, q (name/reason contains). meta adds the KPI counters:
 *      activeNow (time-covered AND isActive — matches engine suppression),
 *      upcoming24h, past7d, total.
 *
 * POST /api/v1/maintenance — create a window (audited
 *      MAINTENANCE_WINDOW_CREATED). A same-scope overlapping window is a
 *      NON-blocking warning in the response (`overlap`), never an error.
 */

/** Time-derived status. isActive is intentionally orthogonal. */
function windowStatus(startsAt: Date, endsAt: Date, now: Date) {
  if (endsAt < now) return "PAST" as const;
  if (startsAt > now) return "UPCOMING" as const;
  return "ACTIVE" as const;
}

const querySchema = paginationSchema.extend({
  status: z.enum(["ACTIVE", "UPCOMING", "PAST"]).optional(),
  siteId: z.string().trim().max(64).optional(),
  deviceId: z.string().trim().max(64).optional(),
  q: z.string().trim().max(120).optional(),
});

const isoDatetime = z.coerce.date();

const createSchema = z
  .object({
    name: z.string().trim().min(1, "name is required").max(160),
    siteId: z.string().trim().max(64).nullish(),
    deviceId: z.string().trim().max(64).nullish(),
    changeId: z.string().trim().max(64).nullish(),
    startsAt: isoDatetime,
    endsAt: isoDatetime,
    reason: z.string().trim().max(500).nullish(),
    isActive: z.boolean().default(true),
  })
  .refine((data) => data.endsAt > data.startsAt, {
    message: "endsAt must be after startsAt",
    path: ["endsAt"],
  });

/** Non-blocking overlap check against same-scope active windows. */
async function findOverlap(input: {
  deviceId: string | null;
  siteId: string | null;
  startsAt: Date;
  endsAt: Date;
  excludeId?: string;
}) {
  const overlapWhere = {
    isActive: true,
    id: input.excludeId ? { not: input.excludeId } : undefined,
    startsAt: { lt: input.endsAt },
    endsAt: { gt: input.startsAt },
    OR: [
      ...(input.deviceId ? [{ deviceId: input.deviceId }] : []),
      ...(input.deviceId ? [] : [{ deviceId: null }]),
      ...(input.deviceId
        ? []
        : input.siteId
          ? [{ siteId: input.siteId }]
          : [{ siteId: null }]),
    ],
  };

  const rows = await db.maintenanceWindow.findMany({
    where: overlapWhere,
    orderBy: { startsAt: "asc" },
    take: 5,
    select: { id: true, name: true, startsAt: true, endsAt: true, deviceId: true, siteId: true },
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
  }));
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    siteId: url.searchParams.get("siteId") ?? undefined,
    deviceId: url.searchParams.get("deviceId") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }

  const { page, pageSize, status, siteId, deviceId, q } = parsed.data;
  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 3600 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);

  /** Every filter that applies to both the page and the KPI counters. */
  const baseWhere = {
    AND: [
      siteId ? { siteId } : {},
      deviceId ? { deviceId } : {},
      q
        ? {
            OR: [
              { name: { contains: q } },
              { reason: { contains: q } },
            ],
          }
        : {},
    ],
  };

  const listWhere = {
    AND: [
      baseWhere,
      status === "ACTIVE"
        ? { startsAt: { lte: now }, endsAt: { gte: now } }
        : {},
      status === "UPCOMING" ? { startsAt: { gt: now } } : {},
      status === "PAST" ? { endsAt: { lt: now } } : {},
    ],
  };

  const [total, rows, activeNow, upcoming24h, past7d] = await Promise.all([
    db.maintenanceWindow.count({ where: listWhere }),
    db.maintenanceWindow.findMany({
      where: listWhere,
      orderBy: { startsAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        name: true,
        reason: true,
        isActive: true,
        startsAt: true,
        endsAt: true,
        site: { select: { id: true, name: true, code: true } },
        device: { select: { id: true, hostname: true } },
        change: { select: { id: true, number: true, title: true } },
      },
    }),
    db.maintenanceWindow.count({
      where: { ...baseWhere, isActive: true, startsAt: { lte: now }, endsAt: { gte: now } },
    }),
    db.maintenanceWindow.count({
      where: { ...baseWhere, startsAt: { gt: now, lte: in24h } },
    }),
    db.maintenanceWindow.count({
      where: { ...baseWhere, endsAt: { lt: now, gte: sevenDaysAgo } },
    }),
  ]);

  const data = rows.map((row) => ({
    id: row.id,
    name: row.name,
    reason: row.reason,
    isActive: row.isActive,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    status: windowStatus(row.startsAt, row.endsAt, now),
    site: row.site,
    device: row.device,
    change: row.change,
  }));

  return ok(data, {
    ...pageMeta(page, pageSize, total),
    activeNow,
    upcoming24h,
    past7d,
    total,
  });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const data = parsed.data;

  // Referenced records must exist (window rows are joined in the UI).
  if (data.siteId) {
    const site = await db.site.findUnique({ where: { id: data.siteId }, select: { id: true } });
    if (!site) return fail("SITE_INVALID", "The selected site does not exist", 400);
  }
  if (data.deviceId) {
    const device = await db.device.findUnique({ where: { id: data.deviceId }, select: { id: true } });
    if (!device) return fail("DEVICE_INVALID", "The selected device does not exist", 400);
  }
  if (data.changeId) {
    const change = await db.changeRequest.findUnique({ where: { id: data.changeId }, select: { id: true } });
    if (!change) return fail("CHANGE_INVALID", "The selected change does not exist", 400);
  }

  const actor = await resolveActingUser(request);
  if (!actor) {
    return fail("UNAUTHENTICATED", "Sign in required — no valid session was provided.", 401);
  }

  const overlap = await findOverlap({
    deviceId: data.deviceId ?? null,
    siteId: data.siteId ?? null,
    startsAt: data.startsAt,
    endsAt: data.endsAt,
  });

  const correlationId = newCorrelationId("MW");
  const window = await db.maintenanceWindow.create({
    data: {
      name: data.name,
      siteId: data.siteId ?? null,
      deviceId: data.deviceId ?? null,
      changeId: data.changeId ?? null,
      startsAt: data.startsAt,
      endsAt: data.endsAt,
      reason: data.reason ?? null,
      isActive: data.isActive,
    },
    select: {
      id: true,
      name: true,
      startsAt: true,
      endsAt: true,
      reason: true,
      isActive: true,
      siteId: true,
      deviceId: true,
      changeId: true,
    },
  });

  await db.auditEvent.create({
    data: {
      actorId: actor?.id ?? null,
      actorName: actor?.name ?? "unknown",
      action: "MAINTENANCE_WINDOW_CREATED",
      resourceType: "MaintenanceWindow",
      resourceId: window.id,
      resourceLabel: window.name,
      result: "SUCCESS",
      correlationId,
      afterJson: JSON.stringify({
        name: window.name,
        siteId: window.siteId,
        deviceId: window.deviceId,
        changeId: window.changeId,
        startsAt: window.startsAt.toISOString(),
        endsAt: window.endsAt.toISOString(),
        reason: window.reason,
        isActive: window.isActive,
        overlapCount: overlap.length,
      }),
    },
  });

  return ok({ window, overlap, audit: { correlationId } }, { correlationId }, 201);
}
