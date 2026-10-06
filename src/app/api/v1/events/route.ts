import { db } from "@/lib/db";
import { Prisma, type User } from "@prisma/client";
import {
  fail,
  firstIssueMessage,
  ok,
  pageMeta,
  paginationSchema,
} from "../_lib/api";
import { authErrorToFail, requireSessionRead, sessionScopeFor } from "@/lib/auth/session";
import { siteScopeAllows, sessionSiteScope } from "@/lib/auth/scope";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/events — platform audit-event timeline (Task 5-c, the
 * AuditEvent table). Newest first, paginated.
 *
 * Filters:
 *   actor         exact actorId OR actorName (e.g. "system:alert-engine",
 *                 "usr-noc1") — the UI select feeds either form
 *   action        PREFIX match (e.g. "INCIDENT_" → the incident family)
 *   entityType    resourceType exact ("Device", "ConfigSnapshot", …)
 *   correlationId exact
 *   deviceId      device-scoped events (resourceId === deviceId — the
 *                 convention used by the DEVICE_* / CONFIG_BACKUP /
 *                 CONFIG_DOWNLOAD audit rows)
 *   from / to     ISO timestamps on createdAt
 *   q             contains across actorName/action/resourceType/resourceLabel/
 *                 resourceId/correlationId — CASE-INSENSITIVE substring match.
 *                 F-047: the documented contract is case-insensitivity (the
 *                 pre-Phase-21 SQLite LIKE behavior); on Postgres each filter
 *                 passes Prisma `mode: "insensitive"` (compiles to ILIKE).
 *                 Cost honesty: ILIKE cannot use a plain btree index, so a
 *                 q filter is a 6-column scan — heavier than a case-sensitive
 *                 LIKE. The bounded page size (pageSize hard-capped at 100 in
 *                 paginationSchema) and the 120-char q cap keep per-load cost
 *                 acceptable; if AuditEvent volume demands more, the named
 *                 follow-up is a dedicated normalized search column or a
 *                 pg_trgm GIN index — see docs/adr/ADR-events-search-contract.md.
 *
 * meta: pagination + total + last24h (events in the trailing 24 h over the
 * same filters minus the time range) + distinctActors + topActions (top-8
 * action facet with counts, computed over the filtered set WITHOUT the
 * action filter so the facet stays navigable) + entityTypes (top-8
 * resourceType facet, same convention).
 *
 * F-008 phase 2 (read-plane defense-in-depth): the handler verifies the
 * human session itself (requireSessionRead) — the proxy matcher stays the
 * coarse gate, not the only check, for the events read domain.
 *
 * F-031 wave-10 (audit 13-c F-1 — MINIMUM MITIGATION, see the strip block
 * in the handler): AuditEvent rows carry no site dimension (the deep fix is
 * the documented owner decision), so sites-limited sessions receive the
 * stream with the free-text identity fields of UNPROVABLE rows stripped
 * fail-closed. Wildcard HUMAN sessions keep byte-identical rows.
 *
 * F-2 wave-11 (audit 15-c P3-3): a BEARER principal (an API-client token —
 * no human session) resolves null scope claims → wildcard, which used to
 * skip the strip branch entirely and hand the UNSTRIPPED global audit
 * stream (ips/userAgents/labels/payloads) to a non-expiring alerts.read
 * token. Bearer principals are now ALWAYS in the strip class regardless of
 * the resolved scope mode — the bearer plane is unscoped by design, so it
 * can never prove a row in-scope. Wildcard HUMAN sessions keep the
 * documented unstripped posture.
 */

const querySchema = paginationSchema.extend({
  actor: z.string().trim().max(120).optional(),
  action: z.string().trim().max(64).optional(),
  entityType: z.string().trim().max(64).optional(),
  correlationId: z.string().trim().max(120).optional(),
  deviceId: z.string().trim().max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  q: z.string().trim().max(120).optional(),
});

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export async function GET(request: Request) {
  let principal: User;
  try {
    principal = await requireSessionRead(request);
  } catch (error) {
    const envelope = authErrorToFail(error);
    if (envelope) return envelope;
    throw error;
  }

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
    actor: url.searchParams.get("actor") ?? undefined,
    action: url.searchParams.get("action") ?? undefined,
    entityType: url.searchParams.get("entityType") ?? undefined,
    correlationId: url.searchParams.get("correlationId") ?? undefined,
    deviceId: url.searchParams.get("deviceId") ?? undefined,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }

  const {
    page,
    pageSize,
    actor,
    action,
    entityType,
    correlationId,
    deviceId,
    from,
    to,
    q,
  } = parsed.data;

  // F-031 wave-10: resolve the session scope once (wildcard = absent claim,
  // the single-tenant default — byte-identical output for every row).
  // F-2 wave-11: requireSessionRead succeeded but the claims lookup is
  // null ⇒ the request authenticated on the NON-session plane (the
  // API-client opaque-bearer read plane — a human session always resolves
  // its claims, and an anonymous request never got past the read gate).
  // That principal is unscoped by design (no sites claim exists for it),
  // so its id — the ApiClient row id — keys the bearer strip class below.
  const scopeClaims = await sessionScopeFor(request);
  const scope = sessionSiteScope(scopeClaims);
  const isWildcard = scope.mode === "wildcard";
  // P1-A05 (GA re-audit 2026-10-06): claims are now ALSO resolved for the
  // API-client bearer plane (its resource scope) — but the bearer STRIP
  // class still keys on "not a human session": a human session's claims
  // carry the User id; client claims carry only the site list. Strip when
  // the authenticated principal is NOT a human (client or anonymous).
  const claimsAreHuman =
    typeof (scopeClaims as { id?: unknown } | null)?.id === "string";
  const bearerPrincipalId = claimsAreHuman ? null : principal.id;

  /** All filters — used for the page itself. (Contextually typed so the
   *  `mode: "insensitive"` literals stay narrow for Prisma's Exact<>.) */
  const listWhere: Prisma.AuditEventWhereInput = {
    AND: [
      actor
        ? { OR: [{ actorId: actor }, { actorName: actor }] }
        : {},
      action ? { action: { startsWith: action } } : {},
      entityType ? { resourceType: entityType } : {},
      correlationId ? { correlationId } : {},
      deviceId ? { resourceId: deviceId } : {},
      from ? { createdAt: { gte: from } } : {},
      to ? { createdAt: { lte: to } } : {},
      q
        ? {
            OR: [
              { actorName: { contains: q, mode: "insensitive" } },
              { action: { contains: q, mode: "insensitive" } },
              { resourceType: { contains: q, mode: "insensitive" } },
              { resourceLabel: { contains: q, mode: "insensitive" } },
              { resourceId: { contains: q, mode: "insensitive" } },
              { correlationId: { contains: q, mode: "insensitive" } },
            ],
          }
        : {},
    ],
  };

  /** Filters minus the facet's own dimension — facets stay navigable. */
  const scopeWhere: Prisma.AuditEventWhereInput = {
    AND: [
      actor ? { OR: [{ actorId: actor }, { actorName: actor }] } : {},
      entityType ? { resourceType: entityType } : {},
      correlationId ? { correlationId } : {},
      deviceId ? { resourceId: deviceId } : {},
      from ? { createdAt: { gte: from } } : {},
      to ? { createdAt: { lte: to } } : {},
      q
        ? {
            OR: [
              { actorName: { contains: q, mode: "insensitive" } },
              { action: { contains: q, mode: "insensitive" } },
              { resourceType: { contains: q, mode: "insensitive" } },
              { resourceLabel: { contains: q, mode: "insensitive" } },
              { resourceId: { contains: q, mode: "insensitive" } },
              { correlationId: { contains: q, mode: "insensitive" } },
            ],
          }
        : {},
    ],
  };

  const last24hFloor = new Date(Date.now() - 24 * 3600 * 1000);

  const [total, rows, last24h, actionGroups, entityTypeGroups, actorGroups] =
    await Promise.all([
      db.auditEvent.count({ where: listWhere }),
      db.auditEvent.findMany({
        where: listWhere,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.auditEvent.count({
        // AND-of-AND ≡ flat AND — no spread needed (AND is Input|Input[]).
        where: { AND: [scopeWhere, { createdAt: { gte: last24hFloor } }] },
      }),
      db.auditEvent.groupBy({
        by: ["action"],
        where: scopeWhere,
        _count: { _all: true },
        orderBy: { _count: { action: "desc" } },
        take: 8,
      }),
      db.auditEvent.groupBy({
        by: ["resourceType"],
        where: scopeWhere,
        _count: { _all: true },
        orderBy: { _count: { resourceType: "desc" } },
        take: 8,
      }),
      db.auditEvent.groupBy({
        by: ["actorName"],
        where: {
          AND: [
            action ? { action: { startsWith: action } } : {},
            entityType ? { resourceType: entityType } : {},
            correlationId ? { correlationId } : {},
            deviceId ? { resourceId: deviceId } : {},
            from ? { createdAt: { gte: from } } : {},
            to ? { createdAt: { lte: to } } : {},
            q
              ? {
                  OR: [
                    { action: { contains: q, mode: "insensitive" } },
                    { resourceType: { contains: q, mode: "insensitive" } },
                    { resourceLabel: { contains: q, mode: "insensitive" } },
                    { resourceId: { contains: q, mode: "insensitive" } },
                    { correlationId: { contains: q, mode: "insensitive" } },
                  ],
                }
              : {},
          ],
        },
        _count: { _all: true },
        orderBy: { _count: { actorName: "desc" } },
      }),
    ]);

  const topActions = actionGroups.map((group) => ({
    action: group.action,
    count: group._count._all,
  }));
  const entityTypes = entityTypeGroups.map((group) => ({
    entityType: group.resourceType,
    count: group._count._all,
  }));
  const topActors = actorGroups.map((group) => ({
    actor: group.actorName,
    count: group._count._all,
  }));

  const data = rows.map((row) => ({
    id: row.id,
    actorId: row.actorId,
    actorName: row.actorName,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    resourceLabel: row.resourceLabel,
    result: row.result,
    ip: row.ip,
    userAgent: row.userAgent,
    correlationId: row.correlationId,
    beforeJson: parseJson(row.beforeJson),
    afterJson: parseJson(row.afterJson),
    createdAt: row.createdAt.toISOString(),
  }));

  /* ── F-031 wave-10 (audit 13-c F-1) — MINIMUM MITIGATION ONLY ──────────
   * AuditEvent rows carry NO site dimension (the deep fix — a site column —
   * is the documented owner decision, authorization-matrix §5.1). For
   * sites-limited sessions the free-text identity fields of rows whose
   * resource cannot be PROVEN in-scope are stripped FAIL-CLOSED:
   *   resourceLabel (device hostnames, user emails, CI labels), ip,
   *   userAgent and the before/after JSON payloads.
   * A row keeps its identity fields only when:
   *   (a) it is the session actor's own action (actorId === session user),
   *   (b) its resource resolves in-scope through device/site linkage —
   *       resourceType "Device" whose site code is in scope, or
   *       resourceType "Site" whose code is in scope.
   * Everything else strips — stale/unresolvable references fail closed.
   * Meta facets stay counts + action/type names (no resource identity).
   * Cost: one batched query per candidate resource type — no N+1.
   * Wildcard HUMAN sessions never enter this branch (byte-identical rows).
   *
   * F-2 wave-11 (audit 15-c P3-3) — BEARER STRIP CLASS: a request that
   * authenticated on the API-client bearer plane (bearerPrincipalId set —
   * scope mode irrelevant) is ALWAYS stripped: the bearer plane resolves
   * wildcard WITHOUT a sites claim, so no resource can ever be proven
   * in-scope for it, and a leaked non-expiring alerts.read token must not
   * buy the unstripped global stream. Same own-actor carve-out keyed by
   * the principal id for symmetry; note it is structurally vacuous today
   * (auditAttribution writes actorId = null for client principals —
   * AuditEvent.actorId is a User FK) but stays correct if attribution
   * ever carries the client id.
   * ──────────────────────────────────────────────────────────────────── */
  if (bearerPrincipalId !== null) {
    for (let i = 0; i < data.length; i += 1) {
      const row = data[i]!;
      if (row.actorId !== null && row.actorId === bearerPrincipalId) continue;
      data[i] = {
        ...row,
        resourceLabel: null,
        ip: null,
        userAgent: null,
        beforeJson: null,
        afterJson: null,
      };
    }
  } else if (!isWildcard) {
    const deviceIds = [
      ...new Set(
        rows
          .filter((r) => r.resourceType === "Device" && r.resourceId)
          .map((r) => r.resourceId as string)
      ),
    ];
    const siteIds = [
      ...new Set(
        rows
          .filter((r) => r.resourceType === "Site" && r.resourceId)
          .map((r) => r.resourceId as string)
      ),
    ];
    const [devices, sites] = await Promise.all([
      deviceIds.length
        ? db.device.findMany({
            where: { id: { in: deviceIds } },
            select: { id: true, site: { select: { code: true } } },
          })
        : Promise.resolve([] as Array<{ id: string; site: { code: string } | null }>),
      siteIds.length
        ? db.site.findMany({
            where: { id: { in: siteIds } },
            select: { id: true, code: true },
          })
        : Promise.resolve([] as Array<{ id: string; code: string }>),
    ]);
    const inScopeDeviceIds = new Set(
      devices
        .filter((d) => siteScopeAllows(scope, d.site?.code ?? null))
        .map((d) => d.id)
    );
    const inScopeSiteIds = new Set(
      sites.filter((s) => siteScopeAllows(scope, s.code)).map((s) => s.id)
    );
    // P1-A05: the claims may now also be an API-client resource scope
    // (no id — clients never self-identify as a User row), so the
    // self-actor visibility exception only exists for HUMAN sessions.
    const sessionActorId =
      (scopeClaims as { id?: string } | null)?.id ?? null;
    for (let i = 0; i < data.length; i += 1) {
      const row = data[i]!;
      if (sessionActorId !== null && row.actorId === sessionActorId) continue;
      const provenInScope =
        (row.resourceType === "Device" &&
          row.resourceId !== null &&
          inScopeDeviceIds.has(row.resourceId)) ||
        (row.resourceType === "Site" &&
          row.resourceId !== null &&
          inScopeSiteIds.has(row.resourceId));
      if (!provenInScope) {
        data[i] = {
          ...row,
          resourceLabel: null,
          ip: null,
          userAgent: null,
          beforeJson: null,
          afterJson: null,
        };
      }
    }
  }

  return ok(data, {
    ...pageMeta(page, pageSize, total),
    total,
    last24h,
    distinctActors: topActors.length,
    topActors,
    topActions,
    entityTypes,
  }, 200);
}
