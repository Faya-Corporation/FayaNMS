import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  fail,
  firstIssueMessage,
  newCorrelationId,
  ok,
  requestContext,
} from "../../_lib/api";
import { resolveActingUser } from "../../_lib/actor";
import {
  cmdbCiTypeSchema,
  cmdbCriticalitySchema,
  cmdbEnvironmentSchema,
  cmdbServiceTierSchema,
  cmdbStatusSchema,
  nextCmdbCiId,
} from "@/lib/cmdb/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

/* ─────────────────────────────────────────────────────────────────────────────
 * CMDB — configuration items (Phase 15-a)
 *
 * GET /api/v1/cmdb/items
 *   One bundled read for the CMDB view: the (filterable) CI list with the
 *   linked inventory device + owner resolved, GLOBAL KPI counts (independent
 *   of the filters so polling does not move the tiles while filtering), the
 *   real site option list (create dialog + filters) and the recent CMDB_*
 *   audit trail (history section). Read-only → no audit event (app
 *   convention). List ordering is ciId asc — deterministic across polls.
 *
 *   Filters: ciType, status, criticality, environment, siteId (site CODE),
 *   q (name/ciId/description contains), limit (1..500, default 200).
 *
 * POST /api/v1/cmdb/items
 *   Create a CI. The CI-000NNN identifier is auto-assigned (next free
 *   number after the highest existing value; one retry on a unique race).
 *   Guards:
 *     409 CMDB_DUPLICATE_NAME        — name already in use (unique column)
 *     409 CMDB_DEVICE_ALREADY_MAPPED — another CI already links the device
 *     422 UNKNOWN_DEVICE             — deviceId does not resolve
 *     422 SITE_NOT_FOUND             — siteId is not a real Site.code
 *   Audit: CMDB_CI_CREATED with a lean afterJson (identity + classification
 *   only — no free-text echo).
 * ───────────────────────────────────────────────────────────────────────────── */

const listQuerySchema = z.object({
  ciType: cmdbCiTypeSchema.optional(),
  status: cmdbStatusSchema.optional(),
  criticality: cmdbCriticalitySchema.optional(),
  environment: cmdbEnvironmentSchema.optional(),
  siteId: z.string().trim().min(1).max(32).optional(),
  q: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const createItemSchema = z.object({
  name: z.string().trim().min(2).max(120),
  ciType: cmdbCiTypeSchema,
  status: cmdbStatusSchema.default("active"),
  criticality: cmdbCriticalitySchema.default("medium"),
  environment: cmdbEnvironmentSchema.default("production"),
  serviceTier: cmdbServiceTierSchema.default("tier-2"),
  description: z.string().trim().min(1).max(500).optional(),
  deviceId: z.string().trim().min(1).max(64).optional(),
  siteId: z.string().trim().min(1).max(32).optional(),
  ownerId: z.string().trim().min(1).max(64).optional(),
});

export async function GET(request: Request) {
  const ctx = requestContext(request);
  const url = new URL(request.url);

  const parsedQuery = listQuerySchema.safeParse({
    ciType: url.searchParams.get("ciType") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    criticality: url.searchParams.get("criticality") ?? undefined,
    environment: url.searchParams.get("environment") ?? undefined,
    siteId: url.searchParams.get("siteId") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsedQuery.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsedQuery.error), 400, ctx);
  }
  const { ciType, status, criticality, environment, siteId, q, limit } =
    parsedQuery.data;

  const where: Prisma.CmdbItemWhereInput = {
    ...(ciType ? { ciType } : {}),
    ...(status ? { status } : {}),
    ...(criticality ? { criticality } : {}),
    ...(environment ? { environment } : {}),
    ...(siteId ? { siteId } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q } },
            { ciId: { contains: q } },
            { description: { contains: q } },
          ],
        }
      : {}),
  };

  const [items, ownerRows, deviceRows, siteRows, counts, relationsCount, audits] =
    await Promise.all([
      db.cmdbItem.findMany({
        where,
        orderBy: { ciId: "asc" },
        take: limit,
      }),
      db.user.findMany({ select: { id: true, name: true, email: true } }),
      db.device.findMany({
        select: { id: true, hostname: true, status: true },
      }),
      db.site.findMany({
        orderBy: { code: "asc" },
        select: { code: true, name: true },
      }),
      // GLOBAL KPI counts — deliberately unfiltered so the KPI row stays
      // stable while the user narrows the table.
      db.cmdbItem.groupBy({ by: ["status"], _count: { _all: true } }),
      db.cmdbRelation.count(),
      db.auditEvent.findMany({
        where: { action: { startsWith: "CMDB_" } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 12,
        select: {
          action: true,
          result: true,
          actorName: true,
          resourceLabel: true,
          correlationId: true,
          createdAt: true,
        },
      }),
    ]);

  const total = counts.reduce((sum, row) => sum + row._count._all, 0);
  const active =
    counts.find((row) => row.status === "active")?._count._all ?? 0;
  // Critical-tier: critical CIs plus every tier-1 service anchor. Computed
  // from a dedicated indexed query instead of re-scanning the list rows.
  const criticalTier = await db.cmdbItem.count({
    where: { OR: [{ criticality: "critical" }, { serviceTier: "tier-1" }] },
  });

  const ownerById = new Map(
    ownerRows.map((u) => [u.id, u.name ?? u.email ?? u.id])
  );
  const deviceById = new Map(deviceRows.map((d) => [d.id, d]));

  const rows = items.map((item) => {
    const device = item.deviceId ? deviceById.get(item.deviceId) ?? null : null;
    return {
      id: item.id,
      ciId: item.ciId,
      name: item.name,
      ciType: item.ciType,
      status: item.status,
      criticality: item.criticality,
      environment: item.environment,
      serviceTier: item.serviceTier,
      description: item.description,
      siteId: item.siteId,
      deviceId: item.deviceId,
      deviceHostname: device?.hostname ?? null,
      deviceStatus: device?.status ?? null,
      ownerId: item.ownerId,
      ownerName: item.ownerId ? ownerById.get(item.ownerId) ?? item.ownerId : null,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    };
  });

  return ok(
    {
      items: rows,
      counts: {
        total,
        active,
        criticalTier,
        relations: relationsCount,
      },
      sites: siteRows,
      history: audits.map((a) => ({
        action: a.action,
        result: a.result,
        actorName: a.actorName,
        resourceLabel: a.resourceLabel,
        correlationId: a.correlationId,
        createdAt: a.createdAt.toISOString(),
      })),
      meta: { computedAt: new Date().toISOString() },
    },
    undefined,
    200,
    ctx
  );
}

export async function POST(request: Request) {
  const ctx = requestContext(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400, ctx);
  }

  const parsed = createItemSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400, ctx);
  }
  const data = parsed.data;

  // ── Domain validation (device ↔ site ↔ uniqueness) ──
  if (data.deviceId) {
    const device = await db.device.findUnique({
      where: { id: data.deviceId },
      select: { id: true, hostname: true },
    });
    if (!device) {
      return fail("UNKNOWN_DEVICE", "The referenced device does not exist", 422, ctx);
    }
    const mapped = await db.cmdbItem.findUnique({
      where: { deviceId: data.deviceId },
      select: { id: true, ciId: true },
    });
    if (mapped) {
      return fail(
        "CMDB_DEVICE_ALREADY_MAPPED",
        `Device already linked to ${mapped.ciId} — one CI per device`,
        409,
        ctx
      );
    }
  }
  if (data.siteId) {
    const site = await db.site.findUnique({ where: { code: data.siteId } });
    if (!site) {
      return fail(
        "SITE_NOT_FOUND",
        `Site code "${data.siteId}" does not exist`,
        422,
        ctx
      );
    }
  }

  const duplicateName = await db.cmdbItem.findUnique({
    where: { name: data.name },
    select: { id: true, ciId: true },
  });
  if (duplicateName) {
    return fail(
      "CMDB_DUPLICATE_NAME",
      `A CI named "${data.name}" already exists (${duplicateName.ciId})`,
      409,
      ctx
    );
  }

  const actor = await resolveActingUser(request);
  if (!actor) {
    return fail("UNAUTHENTICATED", "Sign in required — no valid session was provided.", 401);
  }
  const actorName = actor?.name ?? "Admin";
  const correlationId = newCorrelationId("CI");

  // Auto-assigned CI-000NNN with a single retry on a unique-id race.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ciId = await nextCmdbCiId();
    try {
      const created = await db.$transaction(async (tx) => {
        const item = await tx.cmdbItem.create({
          data: {
            ciId,
            name: data.name,
            ciType: data.ciType,
            status: data.status,
            criticality: data.criticality,
            environment: data.environment,
            serviceTier: data.serviceTier,
            description: data.description ?? null,
            deviceId: data.deviceId ?? null,
            siteId: data.siteId ?? null,
            ownerId: data.ownerId ?? null,
          },
        });
        await tx.auditEvent.create({
          data: {
            actorId: actor?.id,
            actorName,
            action: "CMDB_CI_CREATED",
            resourceType: "CmdbItem",
            resourceId: item.id,
            resourceLabel: `${item.ciId} — ${item.name}`,
            result: "SUCCESS",
            correlationId,
            afterJson: JSON.stringify({
              ciId: item.ciId,
              name: item.name,
              ciType: item.ciType,
              status: item.status,
              criticality: item.criticality,
              environment: item.environment,
              serviceTier: item.serviceTier,
              siteId: item.siteId,
              deviceId: item.deviceId,
            }),
          },
        });
        return item;
      });

      return ok(
        {
          item: {
            id: created.id,
            ciId: created.ciId,
            name: created.name,
            ciType: created.ciType,
            status: created.status,
            criticality: created.criticality,
            environment: created.environment,
            serviceTier: created.serviceTier,
            siteId: created.siteId,
            deviceId: created.deviceId,
          },
          correlationId,
        },
        { actor: actorName },
        200,
        ctx
      );
    } catch (error) {
      // Unique violation on ciId → another create took the number: retry once.
      // Unique violation on name → the pre-check missed a concurrent create.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const target = error.meta?.target;
        const targetText = Array.isArray(target) ? target.join(",") : String(target ?? "");
        if (targetText.includes("name")) {
          return fail(
            "CMDB_DUPLICATE_NAME",
            `A CI named "${data.name}" already exists`,
            409,
            ctx
          );
        }
        if (attempt === 0) continue;
      }
      throw error;
    }
  }

  // Unreachable in practice — defensive fall-through keeps the type checker happy.
  return fail("CMDB_ID_EXHAUSTED", "Could not allocate a CI identifier", 500, ctx);
}
