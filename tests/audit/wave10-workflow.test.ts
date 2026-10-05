/**
 * Wave-10 WORKFLOW PLANE — the F-031 site-scope migration of the
 * alerts + incidents surfaces (audit 13-a findings F-1..F-8).
 *
 * Wave 10 composed the same central primitives into the workflow plane the
 * wave-9 read-plane migration had left behind. This suite pins the landed
 * behavior with the certified batch-25/wave-9 rig (REAL next-auth JWTs from
 * the production `encode`, RUN-suffixed fixtures, surgical afterAll cleanup):
 *
 *   ALERTS READ       GET /api/v1/alerts composes the session scope through
 *                     the Alert→device→site relation (scopedDeviceWhere) on
 *                     the page query AND both groupBy counts AND the
 *                     linkedOpenIncidents query; ?siteCode= INTERSECTS the
 *                     scope (out-of-scope site → 200 + zero rows); wildcard
 *                     parity.
 *   ALERT MUTATIONS   all six action routes (acknowledge/assign/resolve/
 *                     suppress/unsuppress/create-incident) gate through
 *                     requireSiteScope BEFORE the state check — scoped
 *                     session on an out-of-scope alert → 403
 *                     SITE_SCOPE_FORBIDDEN with NOTHING written; the same
 *                     request as wildcard succeeds. The P1-012 API-client
 *                     opt-in keeps working (the bearer plane is unscoped by
 *                     documented posture).
 *   INCIDENTS READ    the list + meta aggregates + stats legs compose
 *                     scopedIncidentSiteWhere; the detail and the PIR
 *                     export fuse sessionAllowsSite into the SAME
 *                     INCIDENT_NOT_FOUND envelope a wildcard session gets
 *                     for a missing row (404-not-403, no existence leak);
 *                     correlate scopes its candidate window.
 *   INCIDENT MUTATIONS  [action] gates every action through requireSiteScope
 *                     inside the tx (403 before any transition — scoped
 *                     success on an in-scope incident proves the gate is
 *                     scope-driven); from-change resolves the change's
 *                     EFFECTIVE site (own site, else first device site) and
 *                     FAILS CLOSED for sites-limited sessions on an
 *                     unplaceable change.
 *   EXPORT AUDIT      the PIR export audit row carries the REAL session
 *                     principal (actorId/actorName) — the synthetic
 *                     "system:report-engine" actor is gone.
 *   NUMBER RACE       from-change allocates the number INSIDE the tx via
 *                     the shared nextIncidentNumber helper with the
 *                     P2002 → typed 409 retry (source pins).
 *   CORRELATE BOUND   the correlate candidate query is take-bounded at 500
 *                     (source pin).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { db } from "../../src/lib/db";
import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";

/* ── fixtures (RUN-suffixed — parallel-safe, re-runnable) ─────────────── */

const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
const PREFIX = `w10wf-`;
const ORG_NAME = `${PREFIX}org-${RUN}`;
const SITE_A_CODE = `W10A-${RUN}`; // the scoped session's site
const SITE_B_CODE = `W10B-${RUN}`; // out of scope for the scoped session
const VENDOR_KEY = `${PREFIX}vendor-${RUN}`;
const HOST_A = `${PREFIX}dev-a-${RUN.toLowerCase()}`; // site A
const HOST_B = `${PREFIX}dev-b-${RUN.toLowerCase()}`; // site B
const IP_A = `192.0.2.2${(parseInt(RUN.slice(0, 2), 36) % 40) + 10}`;
const IP_B = `192.0.2.2${(parseInt(RUN.slice(2, 4), 36) % 40) + 60}`;
const ADMIN_EMAIL = `${PREFIX}admin-${RUN.toLowerCase()}@faya.local`;
const ADMIN_NAME = `W10 Workflow Admin ${RUN}`;
const CHANGE_B_NUMBER = `CHG-W10-${RUN}-B`;
const CHANGE_C_NUMBER = `CHG-W10-${RUN}-C`;
// Incident numbers MUST follow INC-<year>-NNNNN (5-digit tail): the
// allocator (nextIncidentNumber) reads the string-desc max and parses its
// last 5 chars — a non-compliant fixture number would poison the
// allocation (NaN → INC-2026-00001 → deterministic P2002). The tail is
// derived from the RUN seed, so parallel suites never collide.
const RUN_SEQ = 70000 + (parseInt(RUN, 36) % 29000);
const INCIDENT_A_NUMBER = `INC-2026-${String(RUN_SEQ).padStart(5, "0")}`;
const INCIDENT_B_NUMBER = `INC-2026-${String(RUN_SEQ + 1).padStart(5, "0")}`;
const CLIENT_NAME = `${PREFIX}client-${RUN.toLowerCase()}`;
const API_CLIENT_TOKEN = `w10wf${RUN.toLowerCase()}abcdefghijkmnopqrstuvwxyz234567ABCDEFGH`;

const testStartedAt = new Date();

let orgId = "";
let siteAId = "";
let siteBId = "";
let vendorId = "";
let deviceAId = "";
let deviceBId = "";
let alertAId = "";
let alertBId = "";
let incidentAId = "";
let incidentBId = "";
let changeBId = "";
let changeCId = "";
let adminId = "";
let apiClientId = "";
let fromChangeIncidentId = "";

type SessionShape = { id: string; email: string; name: string | null; role: string; sites?: unknown };

/** The certified rt012/batch-3 session-mint helper (real next-auth encode). */
async function mintSessionJwt(user: SessionShape): Promise<string> {
  return encode({
    token: {
      id: user.id,
      email: user.email,
      name: user.name ?? undefined,
      role: user.role,
      ...(user.sites !== undefined ? { sites: user.sites } : {}),
    },
    secret: process.env.NEXTAUTH_SECRET ?? "",
  });
}

async function adminJwt(sites?: unknown): Promise<string> {
  const claims: SessionShape = {
    id: adminId,
    email: ADMIN_EMAIL,
    name: ADMIN_NAME,
    role: "admin",
  };
  if (sites !== undefined) claims.sites = sites;
  return mintSessionJwt(claims);
}

function getRequest(url: string, jwt: string): NextRequest {
  return new NextRequest(url, {
    method: "GET",
    headers: { cookie: `next-auth.session-token=${jwt}` },
  });
}

function postRequest(url: string, jwt: string, body: unknown, extraHeaders?: Record<string, string>): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(extraHeaders ?? {}),
      ...(jwt ? { cookie: `next-auth.session-token=${jwt}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

type Envelope = {
  success?: boolean;
  data?: unknown;
  meta?: Record<string, unknown>;
  error?: { code?: string; message?: string };
};

async function importGet(relPath: string) {
  const mod = (await import(relPath)) as {
    GET: (req: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
  };
  return mod.GET;
}

async function importPost(relPath: string) {
  const mod = (await import(relPath)) as {
    POST: (req: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
  };
  return mod.POST;
}

beforeAll(async () => {
  // The CI gate replays ONLY `migrate deploy` (no demo seed): upsert the
  // admin Role from ROLE_MATRIX — the certified batch-25 pattern.
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

  const admin = await db.user.create({
    data: { email: ADMIN_EMAIL, name: ADMIN_NAME, role: "admin", isActive: true },
    select: { id: true },
  });
  adminId = admin.id;

  const org = await db.organization.create({ data: { name: ORG_NAME } });
  orgId = org.id;
  const siteA = await db.site.create({
    data: { name: `W10 Site A ${RUN}`, code: SITE_A_CODE, organizationId: orgId },
  });
  siteAId = siteA.id;
  const siteB = await db.site.create({
    data: { name: `W10 Site B ${RUN}`, code: SITE_B_CODE, organizationId: orgId },
  });
  siteBId = siteB.id;

  const vendor = await db.vendor.create({
    data: { key: VENDOR_KEY, name: `W10 Workflow Vendor ${RUN}`, adapterKey: "generic" },
  });
  vendorId = vendor.id;

  const devA = await db.device.create({
    data: { hostname: HOST_A, mgmtIp: IP_A, vendorId, siteId: siteAId, status: "ONLINE" },
  });
  deviceAId = devA.id;
  const devB = await db.device.create({
    data: { hostname: HOST_B, mgmtIp: IP_B, vendorId, siteId: siteBId, status: "ONLINE" },
  });
  deviceBId = devB.id;

  const alertA = await db.alert.create({
    data: { deviceId: deviceAId, severity: "CRITICAL", message: `${PREFIX} critical condition A` },
  });
  alertAId = alertA.id;
  const alertB = await db.alert.create({
    data: { deviceId: deviceBId, severity: "HIGH", message: `${PREFIX} high condition B` },
  });
  alertBId = alertB.id;

  const incidentA = await db.incident.create({
    data: {
      number: INCIDENT_A_NUMBER,
      title: `${PREFIX} site A incident`,
      severity: "SEV1",
      status: "NEW",
      source: "ALERT",
      siteId: siteAId,
    },
  });
  incidentAId = incidentA.id;
  const incidentB = await db.incident.create({
    data: {
      number: INCIDENT_B_NUMBER,
      title: `${PREFIX} site B incident`,
      severity: "SEV2",
      status: "NEW",
      source: "ALERT",
      siteId: siteBId,
    },
  });
  incidentBId = incidentB.id;

  // Device linkage on the out-of-scope incident — the correlate hostname
  // leak the audit named; a scoped session must never see it.
  await db.incidentDevice.create({
    data: { incidentId: incidentBId, deviceId: deviceBId },
  });

  const changeB = await db.changeRequest.create({
    data: {
      number: CHANGE_B_NUMBER,
      title: `${PREFIX} failed change on site B`,
      status: "FAILED",
      riskLevel: "HIGH",
      riskScore: 75,
      requesterId: adminId,
      siteId: siteBId,
      scheduledStart: new Date(Date.now() - 5 * 60_000),
    },
  });
  changeBId = changeB.id;
  const changeC = await db.changeRequest.create({
    data: {
      number: CHANGE_C_NUMBER,
      title: `${PREFIX} unplaceable failed change`,
      status: "FAILED",
      riskLevel: "MEDIUM",
      riskScore: 40,
      requesterId: adminId,
      siteId: null,
      scheduledStart: new Date(Date.now() - 5 * 60_000),
    },
  });
  changeCId = changeC.id;

  // API-client row for the P1-012 opt-in pin (alerts.write scope).
  const client = await db.apiClient.create({
    data: {
      name: CLIENT_NAME,
      tokenHash: createHash("sha256").update(API_CLIENT_TOKEN, "utf8").digest("hex"),
      tokenPrefix: API_CLIENT_TOKEN.slice(0, 8),
      scopesJson: JSON.stringify(["alerts.write"]),
      isActive: true,
      createdBy: adminId,
    },
  });
  apiClientId = client.id;

  expect(alertBId.length).toBeGreaterThan(0);
  expect(incidentBId.length).toBeGreaterThan(0);
});

afterAll(async () => {
  // Surgical cleanup in FK order — every fixture row this suite created,
  // nothing else. Audit/event rows are reclaimed by their fixture resource
  // ids (all rows this suite could have written reference them).
  const fixtureResourceIds = [alertAId, alertBId, incidentAId, incidentBId, fromChangeIncidentId].filter(Boolean);
  if (fixtureResourceIds.length > 0) {
    await db.auditEvent.deleteMany({
      where: { resourceId: { in: fixtureResourceIds }, createdAt: { gte: testStartedAt } },
    });
  }
  await db.incidentEvent.deleteMany({
    where: { incidentId: { in: [incidentAId, incidentBId, fromChangeIncidentId].filter(Boolean) } },
  });
  // Restore any state the success-path pins mutated, then delete.
  await db.alert.updateMany({
    where: { id: { in: [alertAId, alertBId].filter(Boolean) } },
    data: { status: "ACTIVE", acknowledgedById: null, acknowledgedAt: null, suppressReason: null, incidentId: null },
  });
  await db.incident.deleteMany({
    where: { id: { in: [incidentAId, incidentBId, fromChangeIncidentId].filter(Boolean) } },
  });
  await db.changeRequest.deleteMany({ where: { id: { in: [changeBId, changeCId].filter(Boolean) } } });
  await db.alert.deleteMany({ where: { id: { in: [alertAId, alertBId].filter(Boolean) } } });
  await db.apiClient.deleteMany({ where: { id: apiClientId } });
  await db.device.deleteMany({ where: { id: { in: [deviceAId, deviceBId].filter(Boolean) } } });
  await db.vendor.deleteMany({ where: { id: vendorId } });
  await db.site.deleteMany({ where: { id: { in: [siteAId, siteBId].filter(Boolean) } } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.user.deleteMany({ where: { id: adminId } });
});

/* ── (F-1) alerts list — device-relation scoping + siteCode intersection ─ */

describe("wave10 workflow: GET /api/v1/alerts (F-1)", () => {
  test("sites-limited session sees only its site's alerts — rows AND both groupBy counts AND linkedOpenIncidents", async () => {
    const GET = await importGet("../../src/app/api/v1/alerts/route");
    const res = await GET(
      getRequest("http://app.local/api/v1/alerts?page=1&pageSize=20", await adminJwt([SITE_A_CODE]))
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.success).toBe(true);
    const rows = body.data as Array<{ id: string; device: { hostname: string; site: { code: string | null } } }>;
    expect(rows.some((r) => r.id === alertAId)).toBe(true);
    expect(rows.some((r) => r.id === alertBId)).toBe(false);
    // The meta aggregates ride the same scoped where.
    const counts = (body.meta?.counts ?? {}) as { byStatus: Record<string, number>; bySeverity: Record<string, number> };
    expect(counts.byStatus["ACTIVE"]).toBe(1);
    expect(counts.bySeverity["CRITICAL"]).toBe(1);
    expect(counts.bySeverity["HIGH"]).toBeUndefined();
    expect(body.meta?.linkedOpenIncidents).toBe(0);
  });

  test("?siteCode=<out-of-scope> INTERSECTS the scope: 200 + zero rows (never the unscoped set)", async () => {
    const GET = await importGet("../../src/app/api/v1/alerts/route");
    const res = await GET(
      getRequest(
        `http://app.local/api/v1/alerts?page=1&pageSize=20&siteCode=${encodeURIComponent(SITE_B_CODE)}`,
        await adminJwt([SITE_A_CODE])
      )
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.data).toEqual([]);
    expect(body.meta?.total).toBe(0);
    expect((body.meta?.counts as { byStatus: Record<string, number> }).byStatus).toEqual({});
  });

  test("wildcard parity: the same request sees BOTH fixture alerts (the gate is scope-driven)", async () => {
    const GET = await importGet("../../src/app/api/v1/alerts/route");
    const res = await GET(
      getRequest("http://app.local/api/v1/alerts?page=1&pageSize=50", await adminJwt())
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const rows = body.data as Array<{ id: string }>;
    expect(rows.some((r) => r.id === alertAId)).toBe(true);
    expect(rows.some((r) => r.id === alertBId)).toBe(true);
    const counts = (body.meta?.counts ?? {}) as { bySeverity: Record<string, number> };
    expect(counts.bySeverity["CRITICAL"]).toBeGreaterThanOrEqual(1);
    expect(counts.bySeverity["HIGH"]).toBeGreaterThanOrEqual(1);
  });
});

/* ── (F-3) alert mutation gates — all six action routes ────────────────── */

describe("wave10 workflow: alert mutation gates (F-3)", () => {
  test("scoped session on the OUT-OF-SCOPE alert → 403 SITE_SCOPE_FORBIDDEN on all six actions, nothing written", async () => {
    const jwt = await adminJwt([SITE_A_CODE]);
    const actions: Array<[string, string, unknown]> = [
      ["acknowledge", "alerts/[id]/acknowledge", {}],
      ["assign", "alerts/[id]/assign", { assignedToId: adminId }],
      ["resolve", "alerts/[id]/resolve", {}],
      ["suppress", "alerts/[id]/suppress", { reason: "w10wf should never land" }],
      ["unsuppress", "alerts/[id]/unsuppress", {}],
      ["create-incident", "alerts/[id]/create-incident", {}],
    ];
    for (const [action, relPath, body] of actions) {
      const POST = await importPost(`../../src/app/api/v1/${relPath}/route`);
      const res = await POST(
        postRequest(`http://app.local/api/v1/alerts/${alertBId}/${action}`, jwt, body),
        { params: Promise.resolve({ id: alertBId }) }
      );
      expect(res.status, action).toBe(403);
      const bodyJson = (await res.json()) as Envelope;
      expect(bodyJson.success, action).toBe(false);
      expect(bodyJson.error?.code, action).toBe("SITE_SCOPE_FORBIDDEN");
      expect(bodyJson.error?.message, action).toContain(SITE_B_CODE);
    }
    // Nothing written: the alert is untouched, no audit rows exist.
    const alertB = await db.alert.findUnique({ where: { id: alertBId }, select: { status: true } });
    expect(alertB?.status).toBe("ACTIVE");
    expect(
      await db.auditEvent.count({
        where: { resourceType: "Alert", resourceId: alertBId, createdAt: { gte: testStartedAt } },
      })
    ).toBe(0);
  });

  test("wildcard: the SAME acknowledge request succeeds (200) — the gate is scope-driven, then the row is restored", async () => {
    const POST = await importPost("../../src/app/api/v1/alerts/[id]/acknowledge/route");
    const res = await POST(
      postRequest(`http://app.local/api/v1/alerts/${alertBId}/acknowledge`, await adminJwt(), {}),
      { params: Promise.resolve({ id: alertBId }) }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.success).toBe(true);
    const data = body.data as { alert: { status: string } };
    expect(data.alert.status).toBe("ACKNOWLEDGED");
    expect((await db.alert.findUnique({ where: { id: alertBId }, select: { status: true } }))?.status).toBe(
      "ACKNOWLEDGED"
    );
    // Restore the ACTIVE state so the following P1-012 pin starts clean.
    await db.alert.update({
      where: { id: alertBId },
      data: { status: "ACTIVE", acknowledgedById: null, acknowledgedAt: null },
    });
    await db.auditEvent.deleteMany({
      where: { action: "ALERT_ACKNOWLEDGED", resourceId: alertBId, createdAt: { gte: testStartedAt } },
    });
  });

  test("P1-012 parity: an API-client bearer ack keeps working (unscoped plane) with the client audit attribution", async () => {
    const POST = await importPost("../../src/app/api/v1/alerts/[id]/acknowledge/route");
    const res = await POST(
      postRequest(`http://app.local/api/v1/alerts/${alertBId}/acknowledge`, "", {}, {
        authorization: `Bearer ${API_CLIENT_TOKEN}`,
      }),
      { params: Promise.resolve({ id: alertBId }) }
    );
    expect(res.status).toBe(200);
    const auditRow = await db.auditEvent.findFirst({
      where: { action: "ALERT_ACKNOWLEDGED", resourceId: alertBId, createdAt: { gte: testStartedAt } },
      orderBy: { createdAt: "desc" },
    });
    expect(auditRow).toBeTruthy();
    expect(auditRow?.actorId).toBe(null); // client principals attribute via payload, not the User FK
    expect(auditRow?.actorName).toBe(`api-client: ${CLIENT_NAME}`);
  });
});

/* ── (F-2) incidents list + detail + export + stats + correlate ────────── */

describe("wave10 workflow: incidents read plane (F-2)", () => {
  test("list: scoped session sees only its site's incident; all meta aggregates are scoped", async () => {
    const GET = await importGet("../../src/app/api/v1/incidents/route");
    const res = await GET(
      getRequest("http://app.local/api/v1/incidents?page=1&pageSize=20", await adminJwt([SITE_A_CODE]))
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const rows = body.data as Array<{ id: string; site: { code: string | null } | null }>;
    expect(rows.some((r) => r.id === incidentAId)).toBe(true);
    expect(rows.some((r) => r.id === incidentBId)).toBe(false);
    expect(body.meta?.openCount).toBe(1);
    expect(body.meta?.slaBreachedCount).toBe(0);
    const counts = (body.meta?.counts ?? {}) as { byStatus: Record<string, number>; bySeverity: Record<string, number> };
    expect(counts.byStatus["NEW"]).toBe(1);
    expect(counts.bySeverity["SEV1"]).toBe(1);
    expect(counts.bySeverity["SEV2"]).toBeUndefined();
  });

  test("list: ?siteCode=<out-of-scope> intersects the scope (200 + zero rows); wildcard keeps the caller filter", async () => {
    const GET = await importGet("../../src/app/api/v1/incidents/route");
    const scoped = await GET(
      getRequest(
        `http://app.local/api/v1/incidents?page=1&pageSize=20&siteCode=${encodeURIComponent(SITE_B_CODE)}`,
        await adminJwt([SITE_A_CODE])
      )
    );
    expect(scoped.status).toBe(200);
    const scopedBody = (await scoped.json()) as Envelope;
    expect(scopedBody.data).toEqual([]);
    expect(scopedBody.meta?.total).toBe(0);

    const wildcard = await GET(
      getRequest(
        `http://app.local/api/v1/incidents?page=1&pageSize=20&siteCode=${encodeURIComponent(SITE_B_CODE)}`,
        await adminJwt()
      )
    );
    const wildcardBody = (await wildcard.json()) as Envelope;
    expect((wildcardBody.data as Array<{ id: string }>).some((r) => r.id === incidentBId)).toBe(true);
  });

  test("detail: out-of-scope incident answers the SAME INCIDENT_NOT_FOUND envelope as an unknown id (fused-404)", async () => {
    const GET = await importGet("../../src/app/api/v1/incidents/[id]/route");
    const jwt = await adminJwt([SITE_A_CODE]);

    const outOfScopeRes = await GET(
      getRequest(`http://app.local/api/v1/incidents/${incidentBId}`, jwt),
      { params: Promise.resolve({ id: incidentBId }) }
    );
    expect(outOfScopeRes.status).toBe(404);
    const outOfScope = (await outOfScopeRes.json()) as Envelope;

    const unknownRes = await GET(
      getRequest(`http://app.local/api/v1/incidents/${PREFIX}unknown-${RUN}`, jwt),
      { params: Promise.resolve({ id: `${PREFIX}unknown-${RUN}` }) }
    );
    expect(unknownRes.status).toBe(404);
    const unknown = (await unknownRes.json()) as Envelope;

    expect(outOfScope.success).toBe(false);
    expect(unknown.success).toBe(false);
    expect(outOfScope.error?.code).toBe("INCIDENT_NOT_FOUND");
    expect(unknown.error?.code).toBe("INCIDENT_NOT_FOUND");
    expect(Object.keys(outOfScope).sort()).toEqual(Object.keys(unknown).sort());
    // And the incident exists — the 404 is the scope, not the data.
    expect(await db.incident.count({ where: { id: incidentBId } })).toBe(1);
  });

  test("detail: wildcard session reads the out-of-scope incident (200) — parity", async () => {
    const GET = await importGet("../../src/app/api/v1/incidents/[id]/route");
    const res = await GET(getRequest(`http://app.local/api/v1/incidents/${incidentBId}`, await adminJwt()), {
      params: Promise.resolve({ id: incidentBId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect((body.data as { id: string }).id).toBe(incidentBId);
  });

  test("export: scoped session gets the fused 404 for the out-of-scope PIR; wildcard renders the in-scope one", async () => {
    const GET = await importGet("../../src/app/api/v1/incidents/export/route");
    const scopedRes = await GET(
      getRequest(`http://app.local/api/v1/incidents/export?id=${incidentBId}`, await adminJwt([SITE_A_CODE]))
    );
    expect(scopedRes.status).toBe(404);
    const scopedBody = (await scopedRes.json()) as Envelope;
    expect(scopedBody.error?.code).toBe("INCIDENT_NOT_FOUND");

    const wildcardRes = await GET(
      getRequest(`http://app.local/api/v1/incidents/export?id=${incidentAId}`, await adminJwt())
    );
    expect(wildcardRes.status).toBe(200);
    expect(wildcardRes.headers.get("content-type")).toContain("text/html");
  });

  test("export audit attribution: the PIR export row carries the REAL session principal (F-5)", async () => {
    const auditRow = await db.auditEvent.findFirst({
      where: { action: "INCIDENT_PIR_EXPORTED", resourceId: incidentAId, createdAt: { gte: testStartedAt } },
      orderBy: { createdAt: "desc" },
    });
    expect(auditRow).toBeTruthy();
    expect(auditRow?.actorId).toBe(adminId);
    expect(auditRow?.actorName).toBe(ADMIN_NAME);
    expect(auditRow?.actorName).not.toBe("system:report-engine");
  });

  test("stats: every aggregation leg is scoped (openBySeverity, openCount, breachedCount, topSites)", async () => {
    const GET = await importGet("../../src/app/api/v1/incidents/stats/route");
    const res = await GET(getRequest("http://app.local/api/v1/incidents/stats", await adminJwt([SITE_A_CODE])));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const data = body.data as {
      openBySeverity: Record<string, number>;
      openCount: number;
      breachedCount: number;
      topSites: Array<{ siteCode: string | null; openCount: number }>;
    };
    expect(data.openBySeverity["SEV1"]).toBe(1);
    expect(data.openBySeverity["SEV2"]).toBe(0);
    expect(data.openCount).toBe(1);
    expect(data.breachedCount).toBe(0);
    // Cross-site aggregation can no longer name out-of-scope sites.
    expect(data.topSites).toHaveLength(1);
    expect(data.topSites[0]?.siteCode).toBe(SITE_A_CODE);
    expect(data.topSites[0]?.openCount).toBe(1);
  });

  test("correlate: scoped session gets no cross-scope candidates (hostnames included); wildcard sees the site-B incident", async () => {
    const GET = await importGet("../../src/app/api/v1/incidents/correlate/route");
    const scopedRes = await GET(
      getRequest(
        `http://app.local/api/v1/incidents/correlate?changeId=${changeBId}&window=60`,
        await adminJwt([SITE_A_CODE])
      )
    );
    expect(scopedRes.status).toBe(200);
    const scopedBody = (await scopedRes.json()) as Envelope;
    const scopedMatches = scopedBody.data as Array<{ id: string; deviceHostnames: string[] }>;
    expect(scopedMatches.some((m) => m.id === incidentBId)).toBe(false);
    expect(scopedMatches.some((m) => m.deviceHostnames.includes(HOST_B))).toBe(false);

    const wildcardRes = await GET(
      getRequest(
        `http://app.local/api/v1/incidents/correlate?changeId=${changeBId}&window=60`,
        await adminJwt()
      )
    );
    expect(wildcardRes.status).toBe(200);
    const wildcardBody = (await wildcardRes.json()) as Envelope;
    const wildcardMatches = wildcardBody.data as Array<{ id: string; deviceHostnames: string[] }>;
    expect(wildcardMatches.some((m) => m.id === incidentBId)).toBe(true);
    expect(wildcardMatches.some((m) => m.deviceHostnames.includes(HOST_B))).toBe(true);
  });
});

/* ── (F-4) incident mutation gates — [action] + from-change ────────────── */

describe("wave10 workflow: incident mutation gates (F-4)", () => {
  test("[action]: scoped acknowledge on the OUT-OF-SCOPE incident → 403 SITE_SCOPE_FORBIDDEN, nothing written", async () => {
    const POST = await importPost("../../src/app/api/v1/incidents/[id]/[action]/route");
    const res = await POST(
      postRequest(`http://app.local/api/v1/incidents/${incidentBId}/acknowledge`, await adminJwt([SITE_A_CODE]), {}),
      { params: Promise.resolve({ id: incidentBId, action: "acknowledge" }) }
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as Envelope;
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe("SITE_SCOPE_FORBIDDEN");
    expect(body.error?.message).toContain(SITE_B_CODE);
    // Nothing written: status unchanged, no timeline event, no audit row.
    const incidentB = await db.incident.findUnique({ where: { id: incidentBId }, select: { status: true } });
    expect(incidentB?.status).toBe("NEW");
    expect(await db.incidentEvent.count({ where: { incidentId: incidentBId } })).toBe(0);
    expect(
      await db.auditEvent.count({
        where: { resourceType: "Incident", resourceId: incidentBId, createdAt: { gte: testStartedAt } },
      })
    ).toBe(0);
  });

  test("[action]: scoped acknowledge on the IN-SCOPE incident succeeds (the gate is scope-driven) — restored after", async () => {
    const POST = await importPost("../../src/app/api/v1/incidents/[id]/[action]/route");
    const res = await POST(
      postRequest(`http://app.local/api/v1/incidents/${incidentAId}/acknowledge`, await adminJwt([SITE_A_CODE]), {}),
      { params: Promise.resolve({ id: incidentAId, action: "acknowledge" }) }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const data = body.data as { incident: { id: string; status: string } };
    expect(data.incident.status).toBe("ACKNOWLEDGED");
    expect(await db.incidentEvent.count({ where: { incidentId: incidentAId } })).toBe(1);
    // Restore the fixture state for the remaining assertions/cleanup.
    await db.incident.update({
      where: { id: incidentAId },
      data: { status: "NEW", acknowledgedAt: null },
    });
    await db.incidentEvent.deleteMany({ where: { incidentId: incidentAId } });
  });

  test("from-change: scoped session on an out-of-scope change → 403, nothing minted", async () => {
    const POST = await importPost("../../src/app/api/v1/incidents/from-change/route");
    const res = await POST(
      postRequest("http://app.local/api/v1/incidents/from-change", await adminJwt([SITE_A_CODE]), {
        changeId: changeBId,
      })
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as Envelope;
    expect(body.error?.code).toBe("SITE_SCOPE_FORBIDDEN");
    expect(body.error?.message).toContain(SITE_B_CODE);
    expect(await db.incident.count({ where: { changeId: changeBId } })).toBe(0);
  });

  test("from-change: an UNPLACEABLE change (no site, no device sites) is FAIL-CLOSED for a scoped session, allowed for wildcard", async () => {
    const POST = await importPost("../../src/app/api/v1/incidents/from-change/route");
    const scopedRes = await POST(
      postRequest("http://app.local/api/v1/incidents/from-change", await adminJwt([SITE_A_CODE]), {
        changeId: changeCId,
      })
    );
    expect(scopedRes.status).toBe(403);
    const scopedBody = (await scopedRes.json()) as Envelope;
    expect(scopedBody.error?.code).toBe("SITE_SCOPE_FORBIDDEN");
    expect(scopedBody.error?.message).toContain("no resolvable site");

    // Wildcard parity: the same mint succeeds (201) — the scope, not the
    // state machine, answered the 403 above.
    const wildcardRes = await POST(
      postRequest("http://app.local/api/v1/incidents/from-change", await adminJwt(), { changeId: changeCId })
    );
    const wildcardBody = (await wildcardRes.json()) as Envelope;
    if (wildcardRes.status !== 201) {
      console.error("from-change wildcard mint failed:", JSON.stringify(wildcardBody));
    }
    expect(wildcardRes.status).toBe(201);
    const data = wildcardBody.data as { incident: { id: string; number: string; changeId: string } };
    expect(data.incident.number).toMatch(/^INC-\d{4}-\d{5}$/); // compliant allocation via nextIncidentNumber
    fromChangeIncidentId = data.incident.id;
    expect((await db.incident.findUnique({ where: { id: data.incident.id }, select: { changeId: true } }))?.changeId).toBe(
      changeCId
    );
  });
});

/* ── source-text pins (the wave-9 differential-pin practice) ───────────── */

describe("wave10 workflow: source pins", () => {
  const API_ROOT = "src/app/api/v1";

  test("F-1: alerts list composes sessionScopeFor + scopedDeviceWhere through the shared baseWhere", () => {
    const src = readFileSync(join(API_ROOT, "alerts", "route.ts"), "utf8");
    expect(src).toContain("sessionScopeFor(request)");
    expect(src).toContain("scopedDeviceWhere(scopeClaims, {})");
    // baseWhere feeds the page query, BOTH groupBys and the linked query.
    expect(src.match(/baseWhere/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(src).toContain("const where = { AND: [baseWhere, groupingWhere] }");
  });

  test("F-3: all six alert action routes gate through requireSiteScope", () => {
    for (const rel of [
      "alerts/[id]/acknowledge/route.ts",
      "alerts/[id]/assign/route.ts",
      "alerts/[id]/resolve/route.ts",
      "alerts/[id]/suppress/route.ts",
      "alerts/[id]/unsuppress/route.ts",
      "alerts/[id]/create-incident/route.ts",
    ]) {
      const src = readFileSync(join(API_ROOT, ...rel.split("/")), "utf8");
      expect(src, rel).toContain("requireSiteScope(request");
    }
  });

  test("F-3: the acknowledge route keeps the documented API-client unscoped posture", () => {
    const src = readFileSync(join(API_ROOT, "alerts", "[id]", "acknowledge", "route.ts"), "utf8");
    expect(src).toContain('actor.role !== "api-client"');
  });

  test("F-2: incidents detail + export fuse sessionAllowsSite into the not-found branch", () => {
    for (const rel of ["incidents/[id]/route.ts", "incidents/export/route.ts"]) {
      const src = readFileSync(join(API_ROOT, ...rel.split("/")), "utf8");
      expect(src, rel).toContain("sessionAllowsSite(scopeClaims, incident.site?.code ?? null)");
    }
  });

  test("F-2: incidents list/stats/correlate compose the shared incident-site predicate", () => {
    for (const rel of ["incidents/route.ts", "incidents/stats/route.ts", "incidents/correlate/route.ts"]) {
      const src = readFileSync(join(API_ROOT, ...rel.split("/")), "utf8");
      expect(src, rel).toContain("scopedIncidentSiteWhere(scopeClaims)");
    }
    const lib = readFileSync(join(API_ROOT, "_lib", "incident-scope.ts"), "utf8");
    expect(lib).toContain("sessionSiteScope(scopeClaims)");
  });

  test("F-4: incidents [action] + from-change gate through requireSiteScope", () => {
    const action = readFileSync(join(API_ROOT, "incidents", "[id]", "[action]", "route.ts"), "utf8");
    expect(action).toContain("requireSiteScope(request, incidentRow.site?.code ?? null)");
    const fromChange = readFileSync(join(API_ROOT, "incidents", "from-change", "route.ts"), "utf8");
    expect(fromChange).toContain("requireSiteScope(request, changeSiteCode)");
  });

  test("F-5: the export audit row stamps the real principal — the synthetic engine actor is gone", () => {
    const src = readFileSync(join(API_ROOT, "incidents", "export", "route.ts"), "utf8");
    expect(src).toContain("actorId: actor.id");
    expect(src).toContain("actorName: actor.name ?? actor.email");
    // The synthetic actor is gone from the CODE (the docstring narrates the fix).
    expect(src).not.toContain('actorName: "system:report-engine"');
  });

  test("F-7: from-change allocates the number INSIDE the tx with the P2002 → typed 409 retry", () => {
    const src = readFileSync(join(API_ROOT, "incidents", "from-change", "route.ts"), "utf8");
    expect(src).toContain("nextIncidentNumber(tx, now)");
    expect(src).toContain("IncidentNumberConflictError");
    expect(src).toContain('error.code === "P2002"');
    expect(src).toContain('"INCIDENT_NUMBER_CONFLICT"');
    // The old pre-tx global-client allocation is gone.
    expect(src).not.toContain("db.incident.findFirst(\n      { orderBy: { number: \"desc\" }");
  });

  test("F-8: the correlate candidate query is take-bounded at 500", () => {
    const src = readFileSync(join(API_ROOT, "incidents", "correlate", "route.ts"), "utf8");
    expect(src).toContain("take: 500");
  });
});
