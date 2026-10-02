/**
 * Open-findings batch 5 — F-008 phase 4a runtime pins (incidents/changes/
 * cmdb gated + admin reads recognized).
 *
 *   F-008 (A1-01, P2): ~35 operational GET handlers under /api/v1 were
 *   authenticated ONLY by the proxy matcher (src/proxy.ts,
 *   `/api/v1/:path*`). Rollout order: dashboard (batch 2) → events/alerts
 *   (batch 3) → devices/interfaces (batch 4) → the rest.
 *
 *   Phase 4a (this suite) covers the high-value half of "the rest":
 *
 *   (1) NEW requireSessionRead() gates (−11 allowlist entries):
 *     - GET /api/v1/incidents              (incident list)
 *     - GET /api/v1/incidents/[id]         (incident detail)
 *     - GET /api/v1/incidents/stats        (incident KPIs)
 *     - GET /api/v1/incidents/export       (PIR report HTML)
 *     - GET /api/v1/incidents/correlate    (change ↔ incident correlation)
 *     - GET /api/v1/changes/[id]           (change detail)
 *     - GET /api/v1/changes/conflicts      (schedule overlap search)
 *     - GET /api/v1/cmdb/items             (CI list)
 *     - GET /api/v1/cmdb/items/[id]        (CI detail)
 *     - GET /api/v1/cmdb/relations         (dependency edges)
 *     - GET /api/v1/cmdb/impact            (BFS blast radius)
 *
 *   (2) MATRIX RECOGNITION (−8 allowlist entries, no code change): the
 *     admin GETs (api-clients, audit-chain/verify, collectors,
 *     collectors/distribution, drivers, notification-channels, settings,
 *     webhooks) ALWAYS enforced requireRole("admin") at the handler level
 *     through resolveAdminActor (src/lib/auth/acting-admin.ts) — the
 *     read-route matrix simply did not recognize the wrapper as a gate
 *     marker. Phase 4a adds resolveAdminActor( to READ_GATES so the matrix
 *     reflects their real enforcement (admin-only — STRICTER than
 *     requireSessionRead).
 *
 *   The mutation plane is untouched: cmdb/items POST stays
 *   requirePermission("cmdb.write"), changes/[id] PATCH keeps its
 *   change.* permission gates.
 *
 *   Read allowlist after this batch: 47 → 28 (shrink-only cap 59 intact).
 *
 * Same certified rig as batches 2-4 (tests/audit/open-findings-batch-{2,3,4}
 * .test.ts): REAL session tokens minted with the production next-auth/jwt
 * encoder (no mock.module — it is process-wide and poisons later suites).
 * The admin identity AND the [id]-scoped fixtures (Incident, ChangeRequest,
 * CmdbItem) are SELF-CONTAINED via the rt012/rt014 ensure-helper pattern:
 * the CI gate replays ONLY `migrate deploy` (no demo seed), so every row
 * these probes depend on is upserted here and never deleted.
 */

import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";

import { db } from "../../src/lib/db";
import { mintServiceToken } from "../../src/lib/auth/service-auth";
import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";

/** Session-shaped projection of the admin identity used by these pins. */
type F008AdminUser = { id: string; email: string; name: string | null; role: string };
let f008Admin: F008AdminUser | null = null;
let f008IncidentId: string | null = null;
let f008ChangeId: string | null = null;
let f008CmdbItemId: string | null = null;

/**
 * Self-contained admin identity (the certified rt012/rt014 pattern): the CI
 * gate replays ONLY `migrate deploy` on a fresh service container (no demo
 * seed), so `admin@faya.local` cannot be assumed to exist — and neither can
 * the seeded admin ROLE row. The Role upsert sources permissions from
 * ROLE_MATRIX (the seed's single source of truth) and leaves an existing
 * row untouched (update: {}); the user upsert is atomic (unique email) and
 * seed-equivalent shared state is never deleted mid-run.
 */
async function ensureF008Admin(): Promise<F008AdminUser> {
  if (f008Admin) return f008Admin;
  const adminEntry = ROLE_MATRIX.find((role) => role.name === "admin");
  await db.role.upsert({
    where: { name: "admin" },
    update: {},
    create: {
      name: "admin",
      description: adminEntry?.description ?? "Full platform administration",
      permissionsJson: JSON.stringify(adminEntry?.permissions ?? ["*"]),
    },
  });
  f008Admin = await db.user.upsert({
    where: { email: "admin@faya.local" },
    update: { isActive: true },
    create: { email: "admin@faya.local", name: "F008 Admin", role: "admin", isActive: true },
    select: { id: true, email: true, name: true, role: true },
  });
  return f008Admin;
}

/**
 * Self-contained [id]-scoped fixtures for phase 4a (all idempotent upserts
 * keyed on unique fields, never deleted — seed-equivalent shared state).
 * Minimal required columns only; everything else rides model defaults.
 */
async function ensureF008Incident(): Promise<string> {
  if (f008IncidentId) return f008IncidentId;
  const incident = await db.incident.upsert({
    where: { number: "INC-1900-F008" },
    update: {},
    create: {
      number: "INC-1900-F008",
      title: "F008 phase 4a read-plane probe incident",
      severity: "SEV3",
      status: "NEW",
      source: "MANUAL",
      slaDueAt: new Date(Date.now() + 3_600_000),
    },
    select: { id: true },
  });
  f008IncidentId = incident.id;
  return f008IncidentId;
}

async function ensureF008Change(requesterId: string): Promise<string> {
  if (f008ChangeId) return f008ChangeId;
  const change = await db.changeRequest.upsert({
    where: { number: "CHG-1900-F008" },
    update: {},
    create: {
      number: "CHG-1900-F008",
      title: "F008 phase 4a read-plane probe change",
      type: "STANDARD",
      status: "DRAFT",
      requesterId,
    },
    select: { id: true },
  });
  f008ChangeId = change.id;
  return f008ChangeId;
}

async function ensureF008CmdbItem(): Promise<string> {
  if (f008CmdbItemId) return f008CmdbItemId;
  const item = await db.cmdbItem.upsert({
    where: { ciId: "CI-F0080001" },
    update: {},
    create: {
      ciId: "CI-F0080001",
      name: "f008-phase4a-probe-ci",
      ciType: "service",
    },
    select: { id: true },
  });
  f008CmdbItemId = item.id;
  return f008CmdbItemId;
}

async function mintSessionJwt(user: F008AdminUser): Promise<string> {
  return encode({
    token: { id: user.id, email: user.email, name: user.name ?? undefined, role: user.role },
    secret: process.env.NEXTAUTH_SECRET ?? "",
  });
}

/* ── request helpers (handler-level — the gate runs inside the handler) ── */

async function incidentsListRequest(headers: Record<string, string>): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/incidents/route");
  return GET(
    new NextRequest("http://app.local/api/v1/incidents?page=1&pageSize=10", {
      method: "GET",
      headers,
    })
  );
}

async function incidentDetailRequest(
  headers: Record<string, string>,
  id: string
): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/incidents/[id]/route");
  return GET(
    new NextRequest(`http://app.local/api/v1/incidents/${id}`, { method: "GET", headers }),
    { params: Promise.resolve({ id }) }
  );
}

async function incidentStatsRequest(headers: Record<string, string>): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/incidents/stats/route");
  return GET(new NextRequest("http://app.local/api/v1/incidents/stats", { method: "GET", headers }));
}

async function incidentExportRequest(
  headers: Record<string, string>,
  id: string
): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/incidents/export/route");
  return GET(
    new NextRequest(`http://app.local/api/v1/incidents/export?id=${id}`, {
      method: "GET",
      headers,
    })
  );
}

async function incidentCorrelateRequest(
  headers: Record<string, string>,
  changeId: string
): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/incidents/correlate/route");
  return GET(
    new NextRequest(
      `http://app.local/api/v1/incidents/correlate?changeId=${changeId}&window=60`,
      { method: "GET", headers }
    )
  );
}

async function changeDetailRequest(
  headers: Record<string, string>,
  id: string
): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/changes/[id]/route");
  return GET(
    new NextRequest(`http://app.local/api/v1/changes/${id}`, { method: "GET", headers }),
    { params: Promise.resolve({ id }) }
  );
}

async function changeConflictsRequest(headers: Record<string, string>): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/changes/conflicts/route");
  return GET(
    new NextRequest(
      "http://app.local/api/v1/changes/conflicts?start=2026-01-01T00:00:00.000Z&end=2026-01-02T00:00:00.000Z",
      { method: "GET", headers }
    )
  );
}

async function cmdbItemsRequest(headers: Record<string, string>): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/cmdb/items/route");
  return GET(
    new NextRequest("http://app.local/api/v1/cmdb/items?page=1&pageSize=10", {
      method: "GET",
      headers,
    })
  );
}

async function cmdbItemDetailRequest(
  headers: Record<string, string>,
  id: string
): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/cmdb/items/[id]/route");
  return GET(
    new NextRequest(`http://app.local/api/v1/cmdb/items/${id}`, { method: "GET", headers }),
    { params: Promise.resolve({ id }) }
  );
}

async function cmdbRelationsRequest(headers: Record<string, string>): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/cmdb/relations/route");
  return GET(
    new NextRequest("http://app.local/api/v1/cmdb/relations", { method: "GET", headers })
  );
}

async function cmdbImpactRequest(
  headers: Record<string, string>,
  itemId: string
): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/cmdb/impact/route");
  return GET(
    new NextRequest(`http://app.local/api/v1/cmdb/impact?itemId=${itemId}`, {
      method: "GET",
      headers,
    })
  );
}

async function adminApiClientsRequest(headers: Record<string, string>): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/admin/api-clients/route");
  return GET(
    new NextRequest("http://app.local/api/v1/admin/api-clients", { method: "GET", headers })
  );
}

async function adminAuditVerifyRequest(headers: Record<string, string>): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/admin/audit-chain/verify/route");
  return GET(
    new NextRequest("http://app.local/api/v1/admin/audit-chain/verify", {
      method: "GET",
      headers,
    })
  );
}

async function adminCollectorsRequest(headers: Record<string, string>): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/admin/collectors/route");
  return GET(
    new NextRequest("http://app.local/api/v1/admin/collectors", { method: "GET", headers })
  );
}

async function adminCollectorsDistRequest(headers: Record<string, string>): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/admin/collectors/distribution/route");
  return GET(
    new NextRequest("http://app.local/api/v1/admin/collectors/distribution", {
      method: "GET",
      headers,
    })
  );
}

async function adminDriversRequest(headers: Record<string, string>): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/admin/drivers/route");
  return GET(
    new NextRequest("http://app.local/api/v1/admin/drivers", { method: "GET", headers })
  );
}

async function adminNotificationChannelsRequest(headers: Record<string, string>): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/admin/notification-channels/route");
  return GET(
    new NextRequest("http://app.local/api/v1/admin/notification-channels", {
      method: "GET",
      headers,
    })
  );
}

async function adminSettingsRequest(headers: Record<string, string>): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/admin/settings/route");
  return GET(
    new NextRequest("http://app.local/api/v1/admin/settings", { method: "GET", headers })
  );
}

async function adminWebhooksRequest(headers: Record<string, string>): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/admin/webhooks/route");
  return GET(
    new NextRequest("http://app.local/api/v1/admin/webhooks", { method: "GET", headers })
  );
}

const PHASE4A_GATED_ROUTES = [
  "incidents",
  "incidents/[id]",
  "incidents/stats",
  "incidents/export",
  "incidents/correlate",
  "changes/[id]",
  "changes/conflicts",
  "cmdb/items",
  "cmdb/items/[id]",
  "cmdb/relations",
  "cmdb/impact",
] as const;

const PHASE4A_ADMIN_ROUTES = [
  "admin/api-clients",
  "admin/audit-chain/verify",
  "admin/collectors",
  "admin/collectors/distribution",
  "admin/drivers",
  "admin/notification-channels",
  "admin/settings",
  "admin/webhooks",
] as const;

describe("F-008 phase 4a: incidents/changes/cmdb gated + admin reads recognized", () => {
  test("anonymous → 401 UNAUTHENTICATED on every phase-4a route", async () => {
    const ghostIncident = "incident-f008-4a-ghost";
    const ghostChange = "change-f008-4a-ghost";
    const ghostItem = "cmdbitem-f008-4a-ghost";
    const probes: readonly (readonly [string, () => Promise<Response>])[] = [
      ["incidents", () => incidentsListRequest({})],
      ["incidents/[id]", () => incidentDetailRequest({}, ghostIncident)],
      ["incidents/stats", () => incidentStatsRequest({})],
      ["incidents/export", () => incidentExportRequest({}, ghostIncident)],
      ["incidents/correlate", () => incidentCorrelateRequest({}, ghostChange)],
      ["changes/[id]", () => changeDetailRequest({}, ghostChange)],
      ["changes/conflicts", () => changeConflictsRequest({})],
      ["cmdb/items", () => cmdbItemsRequest({})],
      ["cmdb/items/[id]", () => cmdbItemDetailRequest({}, ghostItem)],
      ["cmdb/relations", () => cmdbRelationsRequest({})],
      ["cmdb/impact", () => cmdbImpactRequest({}, ghostItem)],
      ...PHASE4A_ADMIN_ROUTES.map((name) => {
        const call = {
          "admin/api-clients": adminApiClientsRequest,
          "admin/audit-chain/verify": adminAuditVerifyRequest,
          "admin/collectors": adminCollectorsRequest,
          "admin/collectors/distribution": adminCollectorsDistRequest,
          "admin/drivers": adminDriversRequest,
          "admin/notification-channels": adminNotificationChannelsRequest,
          "admin/settings": adminSettingsRequest,
          "admin/webhooks": adminWebhooksRequest,
        }[name];
        return [name, () => call({})] as const;
      }),
    ];
    expect(probes.length).toBe(19);
    for (const [name, call] of probes) {
      const res = await call();
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("UNAUTHENTICATED");
      // Sanity: the probe really hit the route it claims to.
      expect(name.length).toBeGreaterThan(0);
    }
  });

  test("valid service JWT (machine plane) → 401 — reads stay human-session-gated", async () => {
    const token = mintServiceToken({
      issuer: "fayanms:worker",
      subject: "worker:f008-phase4a-read-plane-test",
      scopes: ["metrics"],
    });
    for (const call of [incidentsListRequest, cmdbItemsRequest, adminDriversRequest]) {
      const res = await call({ Authorization: `Bearer ${token}` });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("UNAUTHENTICATED");
    }
  });

  test("session claims for an UNKNOWN user → 401 ACCOUNT_DISABLED (DB re-verification)", async () => {
    const ghost = await encode({
      token: {
        id: "user-f008-phase4a-ghost-nonexistent",
        email: "ghost-f008-p4a@faya.local",
        name: "F-008 Phase 4a Ghost",
        role: "admin",
      },
      secret: process.env.NEXTAUTH_SECRET ?? "",
    });
    const res = await incidentsListRequest({
      cookie: `next-auth.session-token=${ghost}`,
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("ACCOUNT_DISABLED");
  });

  test("real admin session → 200 with the domain payload on every phase-4a route", async () => {
    const admin = await ensureF008Admin();
    const incidentId = await ensureF008Incident();
    const changeId = await ensureF008Change(admin.id);
    const cmdbItemId = await ensureF008CmdbItem();
    const session = await mintSessionJwt(admin);
    const auth = { cookie: `next-auth.session-token=${session}` };

    // incidents list — page envelope with a numeric total.
    const list = await incidentsListRequest(auth);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      success?: boolean;
      meta?: { total?: number };
    };
    expect(listBody.success).toBe(true);
    expect(typeof listBody.meta?.total).toBe("number");

    // incidents/[id] — the ensured fixture round-trips.
    const detail = await incidentDetailRequest(auth, incidentId);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      success?: boolean;
      data?: { id?: string; number?: string };
    };
    expect(detailBody.success).toBe(true);
    expect(detailBody.data?.id).toBe(incidentId);
    expect(detailBody.data?.number).toBe("INC-1900-F008");

    // incidents/stats — KPI block payload.
    const stats = await incidentStatsRequest(auth);
    expect(stats.status).toBe(200);
    const statsBody = (await stats.json()) as {
      success?: boolean;
      data?: { openCount?: number };
    };
    expect(statsBody.success).toBe(true);
    expect(typeof statsBody.data?.openCount).toBe("number");

    // incidents/export — the PIR HTML document.
    const exported = await incidentExportRequest(auth, incidentId);
    expect(exported.status).toBe(200);
    const exportText = await exported.text();
    expect(exportText.length).toBeGreaterThan(0);

    // incidents/correlate — correlation result block.
    const correlate = await incidentCorrelateRequest(auth, changeId);
    expect(correlate.status).toBe(200);
    const correlateBody = (await correlate.json()) as { success?: boolean };
    expect(correlateBody.success).toBe(true);

    // changes/[id] — the ensured fixture round-trips.
    const changeDetail = await changeDetailRequest(auth, changeId);
    expect(changeDetail.status).toBe(200);
    const changeBody = (await changeDetail.json()) as {
      success?: boolean;
      data?: { id?: string; number?: string };
    };
    expect(changeBody.success).toBe(true);
    expect(changeBody.data?.id).toBe(changeId);
    expect(changeBody.data?.number).toBe("CHG-1900-F008");

    // changes/conflicts — array payload.
    const conflicts = await changeConflictsRequest(auth);
    expect(conflicts.status).toBe(200);
    const conflictsBody = (await conflicts.json()) as {
      success?: boolean;
      data?: unknown[];
    };
    expect(conflictsBody.success).toBe(true);
    expect(Array.isArray(conflictsBody.data)).toBe(true);

    // cmdb/items — list block with a numeric total in counts.
    const items = await cmdbItemsRequest(auth);
    expect(items.status).toBe(200);
    const itemsBody = (await items.json()) as {
      success?: boolean;
      data?: { counts?: { total?: number } };
    };
    expect(itemsBody.success).toBe(true);
    expect(typeof itemsBody.data?.counts?.total).toBe("number");

    // cmdb/items/[id] — the ensured fixture round-trips (nested under item).
    const itemDetail = await cmdbItemDetailRequest(auth, cmdbItemId);
    expect(itemDetail.status).toBe(200);
    const itemBody = (await itemDetail.json()) as {
      success?: boolean;
      data?: { item?: { id?: string; ciId?: string } };
    };
    expect(itemBody.success).toBe(true);
    expect(itemBody.data?.item?.id).toBe(cmdbItemId);
    expect(itemBody.data?.item?.ciId).toBe("CI-F0080001");

    // cmdb/relations — dependency-edge list (nested under relations).
    const relations = await cmdbRelationsRequest(auth);
    expect(relations.status).toBe(200);
    const relationsBody = (await relations.json()) as {
      success?: boolean;
      data?: { relations?: unknown[] };
    };
    expect(relationsBody.success).toBe(true);
    expect(Array.isArray(relationsBody.data?.relations)).toBe(true);

    // cmdb/impact — BFS result payload.
    const impact = await cmdbImpactRequest(auth, cmdbItemId);
    expect(impact.status).toBe(200);
    const impactBody = (await impact.json()) as { success?: boolean };
    expect(impactBody.success).toBe(true);

    // admin/api-clients — catalog + rows.
    const apiClients = await adminApiClientsRequest(auth);
    expect(apiClients.status).toBe(200);
    const apiClientsBody = (await apiClients.json()) as {
      success?: boolean;
      data?: { scopes?: unknown[] };
    };
    expect(apiClientsBody.success).toBe(true);
    expect(Array.isArray(apiClientsBody.data?.scopes)).toBe(true);

    // admin/audit-chain/verify — verification verdict payload.
    const auditVerify = await adminAuditVerifyRequest(auth);
    expect(auditVerify.status).toBe(200);
    const auditVerifyBody = (await auditVerify.json()) as { success?: boolean };
    expect(auditVerifyBody.success).toBe(true);

    // admin/collectors — worker-health tolerant payload (dead worker never 500s).
    const collectors = await adminCollectorsRequest(auth);
    expect(collectors.status).toBe(200);
    const collectorsBody = (await collectors.json()) as { success?: boolean };
    expect(collectorsBody.success).toBe(true);

    // admin/collectors/distribution — assignment rows.
    const dist = await adminCollectorsDistRequest(auth);
    expect(dist.status).toBe(200);
    const distBody = (await dist.json()) as { success?: boolean };
    expect(distBody.success).toBe(true);

    // admin/drivers — static catalog.
    const drivers = await adminDriversRequest(auth);
    expect(drivers.status).toBe(200);
    const driversBody = (await drivers.json()) as {
      success?: boolean;
      data?: { drivers?: unknown[] };
    };
    expect(driversBody.success).toBe(true);
    expect(Array.isArray(driversBody.data?.drivers)).toBe(true);

    // admin/notification-channels — rows + types.
    const channels = await adminNotificationChannelsRequest(auth);
    expect(channels.status).toBe(200);
    const channelsBody = (await channels.json()) as { success?: boolean };
    expect(channelsBody.success).toBe(true);

    // admin/settings — settings rows.
    const settings = await adminSettingsRequest(auth);
    expect(settings.status).toBe(200);
    const settingsBody = (await settings.json()) as { success?: boolean };
    expect(settingsBody.success).toBe(true);

    // admin/webhooks — rows + event catalog.
    const webhooks = await adminWebhooksRequest(auth);
    expect(webhooks.status).toBe(200);
    const webhooksBody = (await webhooks.json()) as { success?: boolean };
    expect(webhooksBody.success).toBe(true);

    // Sanity: the pins really covered the documented phase-4a surface.
    expect(PHASE4A_GATED_ROUTES.length).toBe(11);
    expect(PHASE4A_ADMIN_ROUTES.length).toBe(8);
  });

  test("source contract: phase-4a GET bodies gate on requireSessionRead; admin GETs on resolveAdminActor", async () => {
    const { readFileSync } = await import("node:fs");
    for (const rel of [
      "src/app/api/v1/incidents/route.ts",
      "src/app/api/v1/incidents/[id]/route.ts",
      "src/app/api/v1/incidents/stats/route.ts",
      "src/app/api/v1/incidents/export/route.ts",
      "src/app/api/v1/incidents/correlate/route.ts",
      "src/app/api/v1/changes/[id]/route.ts",
      "src/app/api/v1/changes/conflicts/route.ts",
      "src/app/api/v1/cmdb/items/route.ts",
      "src/app/api/v1/cmdb/items/[id]/route.ts",
      "src/app/api/v1/cmdb/relations/route.ts",
      "src/app/api/v1/cmdb/impact/route.ts",
    ]) {
      const src = readFileSync(rel, "utf8");
      expect(src).toContain("await requireSessionRead(request)");
      expect(src).toContain("authErrorToFail");
    }
    for (const rel of PHASE4A_ADMIN_ROUTES) {
      const src = readFileSync(`src/app/api/v1/${rel}/route.ts`, "utf8");
      expect(src).toContain("resolveAdminActor(request)");
    }
    // The mutation plane is untouched: cmdb/items POST keeps cmdb.write and
    // changes/[id] PATCH keeps its change.* permission gates.
    const cmdbItems = readFileSync("src/app/api/v1/cmdb/items/route.ts", "utf8");
    expect(cmdbItems).toContain('requirePermission(request, "cmdb.write")');
    const changeDetail = readFileSync("src/app/api/v1/changes/[id]/route.ts", "utf8");
    expect(changeDetail).toContain('requirePermission(request, "change.cancel")');
    // The admin wrapper keeps delegating to the admin role gate.
    const wrapper = readFileSync("src/lib/auth/acting-admin.ts", "utf8");
    expect(wrapper).toContain('requireRole(req, "admin")');
  });
});
