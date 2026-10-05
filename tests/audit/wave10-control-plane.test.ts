/**
 * Wave 10 control-plane pins (audit 13-b — changes/approvals/jobs).
 *
 * The wave-10 fix batch migrated the change-management + job planes onto
 * the F-031 scoping primitives and closed the P1 opaque-bearer auth gap.
 * This suite pins the landed behavior with the certified batch-25/wave-9
 * rig (REAL next-auth JWTs from the production `encode`, RUN-suffixed
 * fixtures, surgical afterAll cleanup):
 *
 *   FORGED BEARER     GET /api/v1/changes and GET /api/v1/approvals with a
 *                     garbage opaque bearer (the shape the proxy's step-3b
 *                     branch admits) answer 401 UNAUTHENTICATED — the
 *                     handlers now validate credentials themselves
 *                     (requireSessionRead; valid API-client tokens keep
 *                     their wired change.read fallthrough).
 *   CHANGE READS      The changes list, the conflicts calendar and the
 *                     change detail compose the session's site scope
 *                     (site leg OR device-linked in-scope change); an
 *                     out-of-scope detail id answers the SAME
 *                     CHANGE_NOT_FOUND envelope as a missing id.
 *   CHANGE MUTATIONS  POST /changes refuses a device set that is not fully
 *                     inside the scope with the ordinary DEVICE_NOT_FOUND
 *                     shape and WITHOUT echoing ids (no out-of-scope
 *                     existence oracle); PATCH cancel on an out-of-scope
 *                     change answers 403 SITE_SCOPE_FORBIDDEN.
 *   APPROVAL DECISION A sites-limited approver cannot decide an
 *                     out-of-scope change (403 SITE_SCOPE_FORBIDDEN); the
 *                     same decision as wildcard succeeds.
 *   JOBS              The list is DEVICE-keyed scoped (in-scope device
 *                     jobs only; wildcard byte-parity); POST answers 403
 *                     SITE_SCOPE_FORBIDDEN for an out-of-scope target;
 *                     cancel/retry of an out-of-scope job answer 403
 *                     before any state change.
 *   EMAIL DISCIPLINE  Non-admin/auditor readers see the requester email
 *                     LOCAL-PART (F-029/R69); admin keeps the full address.
 *   SOURCE PINS       The gate markers the suite relies on are pinned
 *                     against the source text (wave-9 differential-pin
 *                     style) and the F-6 enum honesty pin (no REPORT_RUN).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";

import { db } from "../../src/lib/db";
import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";

/* ── fixtures (RUN-suffixed — parallel-safe, re-runnable) ─────────────── */

const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
const PREFIX = `w10cp-`;
const ORG_NAME = `${PREFIX}org-${RUN}`;
const SITE_A_CODE = `W10A-${RUN}`; // the scoped session's site
const SITE_B_CODE = `W10B-${RUN}`; // out of scope for the scoped session
const VENDOR_KEY = `${PREFIX}vendor-${RUN}`;
const HOST_A = `${PREFIX}dev-a-${RUN.toLowerCase()}`; // site A
const HOST_B = `${PREFIX}dev-b-${RUN.toLowerCase()}`; // site B
const IP_A = `192.0.2.2${(parseInt(RUN.slice(0, 2), 36) % 40) + 30}`;
const IP_B = `192.0.2.2${(parseInt(RUN.slice(2, 4), 36) % 40) + 70}`;
const ADMIN_EMAIL = `${PREFIX}admin-${RUN.toLowerCase()}@faya.local`;
const MANAGER_EMAIL = `${PREFIX}manager-${RUN.toLowerCase()}@faya.local`;
/** The exact forged-opaque-bearer shape from the audit (40 base64url chars). */
const FORGED_BEARER = `Bearer ${"A".repeat(40)}`;

let orgId = "";
let siteAId = "";
let siteBId = "";
let vendorId = "";
let deviceAId = "";
let deviceBId = "";
let adminId = "";
let managerId = "";
let changeSiteBId = ""; // site leg out of scope
let changeSitelessAId = ""; // site-less; device A leg (in scope)
let changeSitelessBId = ""; // site-less; device B leg (out of scope)
let changeApproveId = ""; // AWAITING_APPROVAL on site B (decision probe)
const createdJobIds: string[] = [];
const jobCorrelationIds: string[] = [];
const createdChangeIds: string[] = [];
const auditCorrelationIds: string[] = [];
const testStartedAt = new Date();

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
    name: "W10 Control-Plane Admin",
    role: "admin",
  };
  if (sites !== undefined) claims.sites = sites;
  return mintSessionJwt(claims);
}

async function managerJwt(): Promise<string> {
  return mintSessionJwt({
    id: managerId,
    email: MANAGER_EMAIL,
    name: "W10 Control-Plane Manager",
    role: "manager",
  });
}

function getReq(url: string, jwt: string): NextRequest {
  return new NextRequest(url, {
    method: "GET",
    headers: { cookie: `next-auth.session-token=${jwt}` },
  });
}

function forgedReq(url: string): NextRequest {
  return new NextRequest(url, {
    method: "GET",
    headers: { authorization: FORGED_BEARER },
  });
}

function postReq(url: string, jwt: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `next-auth.session-token=${jwt}`,
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
    GET: (req: Request, ctx?: unknown) => Promise<Response>;
  };
  return mod.GET;
}

async function importPost(relPath: string) {
  const mod = (await import(relPath)) as {
    POST: (req: Request, ctx?: unknown) => Promise<Response>;
  };
  return mod.POST;
}

beforeAll(async () => {
  // The CI gate replays ONLY `migrate deploy` (no demo seed): upsert the
  // roles the probes act through from ROLE_MATRIX — the certified batch-25
  // pattern.
  for (const roleName of ["admin", "manager"] as const) {
    const entry = ROLE_MATRIX.find((role) => role.name === roleName);
    await db.role.upsert({
      where: { name: roleName },
      update: {},
      create: {
        name: roleName,
        description: entry?.description ?? roleName,
        permissionsJson: JSON.stringify(entry?.permissions ?? (roleName === "admin" ? ["*"] : [])),
      },
    });
  }

  const admin = await db.user.create({
    data: { email: ADMIN_EMAIL, name: "W10 Control-Plane Admin", role: "admin", isActive: true },
    select: { id: true },
  });
  adminId = admin.id;
  const manager = await db.user.create({
    data: { email: MANAGER_EMAIL, name: "W10 Control-Plane Manager", role: "manager", isActive: true },
    select: { id: true },
  });
  managerId = manager.id;

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
    data: { key: VENDOR_KEY, name: `W10 Control-Plane Vendor ${RUN}`, adapterKey: "generic" },
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

  const window = {
    scheduledStart: new Date(Date.now() + 24 * 3_600_000),
    scheduledEnd: new Date(Date.now() + 26 * 3_600_000),
  };
  const changeSiteB = await db.changeRequest.create({
    data: {
      number: `CHG-W10${RUN}B`,
      title: `W10 out-of-scope change ${RUN}`,
      type: "NORMAL",
      status: "DRAFT",
      requesterId: adminId,
      siteId: siteBId,
      ...window,
    },
  });
  changeSiteBId = changeSiteB.id;
  createdChangeIds.push(changeSiteB.id);
  const changeSitelessA = await db.changeRequest.create({
    data: {
      number: `CHG-W10${RUN}A`,
      title: `W10 site-less in-scope change ${RUN}`,
      type: "NORMAL",
      status: "DRAFT",
      requesterId: adminId,
    },
  });
  changeSitelessAId = changeSitelessA.id;
  createdChangeIds.push(changeSitelessA.id);
  await db.changeDevice.create({
    data: { changeId: changeSitelessA.id, deviceId: deviceAId, result: "PENDING" },
  });
  const changeSitelessB = await db.changeRequest.create({
    data: {
      number: `CHG-W10${RUN}C`,
      title: `W10 site-less out-of-scope change ${RUN}`,
      type: "NORMAL",
      status: "DRAFT",
      requesterId: adminId,
    },
  });
  changeSitelessBId = changeSitelessB.id;
  createdChangeIds.push(changeSitelessB.id);
  await db.changeDevice.create({
    data: { changeId: changeSitelessB.id, deviceId: deviceBId, result: "PENDING" },
  });
  const changeApprove = await db.changeRequest.create({
    data: {
      number: `CHG-W10${RUN}D`,
      title: `W10 approval decision probe ${RUN}`,
      type: "NORMAL",
      status: "AWAITING_APPROVAL",
      riskLevel: "LOW",
      requesterId: adminId,
      siteId: siteBId,
    },
  });
  changeApproveId = changeApprove.id;
  createdChangeIds.push(changeApprove.id);
  await db.changeApproval.create({
    data: {
      changeId: changeApprove.id,
      level: "TECHNICAL",
      status: "PENDING",
      quorumRequired: 1,
    },
  });

  for (const [key, targetType, targetId, status] of [
    ["A", "DEVICE", deviceAId, "QUEUED"],
    ["B", "DEVICE", deviceBId, "QUEUED"],
    ["R", "DEVICE", deviceBId, "FAILED"],
    ["S", "SYSTEM", null, "QUEUED"],
  ] as const) {
    const correlationId = `JOB-W10${RUN}${key}`;
    const job = await db.jobExecution.create({
      data: {
        type: key === "S" ? "REPORT_GENERATION" : "CONFIG_BACKUP",
        targetType,
        targetId,
        status,
        progress: 0,
        correlationId,
        error: status === "FAILED" ? "w10 fixture failure" : null,
      },
    });
    createdJobIds.push(job.id);
    jobCorrelationIds.push(correlationId);
  }

  expect(changeApproveId.length).toBeGreaterThan(0);
  expect(createdJobIds.length).toBe(4);
});

afterAll(async () => {
  // Surgical cleanup in FK order — every fixture row this suite created,
  // nothing else.
  await db.changeApprovalDecision.deleteMany({
    where: { approval: { changeId: { in: createdChangeIds.filter(Boolean) } } },
  });
  await db.changeApproval.deleteMany({
    where: { changeId: { in: createdChangeIds.filter(Boolean) } },
  });
  await db.changeDevice.deleteMany({
    where: { changeId: { in: createdChangeIds.filter(Boolean) } },
  });
  await db.changeStep.deleteMany({
    where: { changeId: { in: createdChangeIds.filter(Boolean) } },
  });
  await db.changeExecutionLease.deleteMany({
    where: { changeId: { in: createdChangeIds.filter(Boolean) } },
  });
  await db.changeRequest.deleteMany({
    where: { id: { in: createdChangeIds.filter(Boolean) } },
  });
  await db.jobExecution.deleteMany({
    where: { correlationId: { in: jobCorrelationIds.filter(Boolean) } },
  });
  await db.auditEvent.deleteMany({
    where: {
      createdAt: { gte: testStartedAt },
      OR: [
        { resourceType: "ChangeRequest", resourceId: { in: createdChangeIds.filter(Boolean) } },
        { correlationId: { in: [...jobCorrelationIds, ...auditCorrelationIds].filter(Boolean) } },
      ],
    },
  });
  await db.device.deleteMany({ where: { id: { in: [deviceAId, deviceBId].filter(Boolean) } } });
  await db.vendor.deleteMany({ where: { id: vendorId } });
  await db.site.deleteMany({ where: { id: { in: [siteAId, siteBId].filter(Boolean) } } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.user.deleteMany({ where: { id: { in: [adminId, managerId].filter(Boolean) } } });
});

/* ── (a) F-1: the forged opaque bearer is refused on both F-1 routes ──── */

describe("wave10 control plane: forged opaque bearer (F-1)", () => {
  test("GET /api/v1/changes with a garbage opaque bearer → 401 UNAUTHENTICATED", async () => {
    const GET = await importGet("../../src/app/api/v1/changes/route");
    const res = await GET(forgedReq("http://app.local/api/v1/changes"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as Envelope;
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe("UNAUTHENTICATED");
  });

  test("GET /api/v1/approvals with a garbage opaque bearer → 401 UNAUTHENTICATED", async () => {
    const GET = await importGet("../../src/app/api/v1/approvals/route");
    const res = await GET(forgedReq("http://app.local/api/v1/approvals"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as Envelope;
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe("UNAUTHENTICATED");
  });
});

/* ── (b) F-3: change reads are site-scoped (list + detail + conflicts) ── */

describe("wave10 control plane: change read scoping (F-3)", () => {
  test("changes list (sites-limited): only the device-linked in-scope change is visible", async () => {
    const GET = await importGet("../../src/app/api/v1/changes/route");
    const res = await GET(getReq("http://app.local/api/v1/changes", await adminJwt([SITE_A_CODE])));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.success).toBe(true);
    const rows = body.data as Array<{ id: string }>;
    expect(rows.some((row) => row.id === changeSitelessAId)).toBe(true);
    expect(rows.some((row) => row.id === changeSiteBId)).toBe(false);
    expect(rows.some((row) => row.id === changeSitelessBId)).toBe(false);
  });

  test("changes list (wildcard): all three fixture changes stay visible (parity)", async () => {
    const GET = await importGet("../../src/app/api/v1/changes/route");
    const res = await GET(getReq("http://app.local/api/v1/changes", await adminJwt()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const rows = body.data as Array<{ id: string }>;
    const ids = new Set(rows.map((row) => row.id));
    expect(ids.has(changeSiteBId)).toBe(true);
    expect(ids.has(changeSitelessAId)).toBe(true);
    expect(ids.has(changeSitelessBId)).toBe(true);
  });

  test("change detail (sites-limited): the out-of-scope id answers the ordinary CHANGE_NOT_FOUND envelope", async () => {
    const GET = await importGet("../../src/app/api/v1/changes/[id]/route");
    const res = await GET(
      getReq(`http://app.local/api/v1/changes/${changeSiteBId}`, await adminJwt([SITE_A_CODE])),
      { params: Promise.resolve({ id: changeSiteBId }) }
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as Envelope;
    expect(body.error?.code).toBe("CHANGE_NOT_FOUND");
  });

  test("change detail (wildcard): the same id resolves (the 404 is scope-driven)", async () => {
    const GET = await importGet("../../src/app/api/v1/changes/[id]/route");
    const res = await GET(
      getReq(`http://app.local/api/v1/changes/${changeSiteBId}`, await adminJwt()),
      { params: Promise.resolve({ id: changeSiteBId }) }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.success).toBe(true);
  });

  test("conflicts calendar (sites-limited): the out-of-scope window is invisible", async () => {
    const GET = await importGet("../../src/app/api/v1/changes/conflicts/route");
    const start = encodeURIComponent(new Date(Date.now() + 23 * 3_600_000).toISOString());
    const end = encodeURIComponent(new Date(Date.now() + 27 * 3_600_000).toISOString());
    const scoped = await GET(
      getReq(
        `http://app.local/api/v1/changes/conflicts?start=${start}&end=${end}`,
        await adminJwt([SITE_A_CODE])
      )
    );
    expect(scoped.status).toBe(200);
    const scopedRows = ((await scoped.json()) as Envelope).data as Array<{ id: string }>;
    expect(scopedRows.some((row) => row.id === changeSiteBId)).toBe(false);

    const wildcard = await GET(
      getReq(
        `http://app.local/api/v1/changes/conflicts?start=${start}&end=${end}`,
        await adminJwt()
      )
    );
    expect(wildcard.status).toBe(200);
    const wildcardRows = ((await wildcard.json()) as Envelope).data as Array<{ id: string }>;
    expect(wildcardRows.some((row) => row.id === changeSiteBId)).toBe(true);
  });

  test("approvals queue (sites-limited): the out-of-scope change's approval row is invisible", async () => {
    const GET = await importGet("../../src/app/api/v1/approvals/route");
    const scoped = await GET(
      getReq(
        "http://app.local/api/v1/approvals?status=PENDING,APPROVED,REJECTED",
        await adminJwt([SITE_A_CODE])
      )
    );
    expect(scoped.status).toBe(200);
    const scopedRows = ((await scoped.json()) as Envelope).data as Array<{ changeId: string }>;
    expect(scopedRows.some((row) => row.changeId === changeApproveId)).toBe(false);

    const wildcard = await GET(
      getReq(
        "http://app.local/api/v1/approvals?status=PENDING,APPROVED,REJECTED",
        await adminJwt()
      )
    );
    expect(wildcard.status).toBe(200);
    const wildcardRows = ((await wildcard.json()) as Envelope).data as Array<{
      changeId: string;
    }>;
    expect(wildcardRows.some((row) => row.changeId === changeApproveId)).toBe(true);
  });
});

/* ── (c) F-2: change mutations refuse out-of-scope resources ──────────── */

describe("wave10 control plane: change mutation scoping (F-2)", () => {
  test("POST /changes (sites-limited) with an out-of-scope device → 400 DEVICE_NOT_FOUND without echoing the id", async () => {
    const POST = await importPost("../../src/app/api/v1/changes/route");
    const res = await POST(
      postReq("http://app.local/api/v1/changes", await adminJwt([SITE_A_CODE]), {
        title: "W10 scoped create probe change",
        type: "NORMAL",
        deviceIds: [deviceBId],
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Envelope;
    expect(body.error?.code).toBe("DEVICE_NOT_FOUND");
    // No existence enumeration: the refusal must NOT name the out-of-scope id.
    expect(body.error?.message ?? "").not.toContain(deviceBId);
  });

  test("POST /changes (wildcard) with the same body → 201 (the refusal is scope-driven)", async () => {
    const POST = await importPost("../../src/app/api/v1/changes/route");
    const res = await POST(
      postReq("http://app.local/api/v1/changes", await adminJwt(), {
        title: "W10 wildcard create probe change",
        type: "NORMAL",
        deviceIds: [deviceBId],
      })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Envelope;
    const created = (body.data as { change?: { id?: string }; audit?: { correlationId?: string } });
    if (created.change?.id) createdChangeIds.push(created.change.id);
    if (created.audit?.correlationId) auditCorrelationIds.push(created.audit.correlationId);
  });

  test("PATCH cancel on an out-of-scope change (sites-limited) → 403 SITE_SCOPE_FORBIDDEN, no state change", async () => {
    const PATCH = (await import("../../src/app/api/v1/changes/[id]/route")).PATCH;
    const res = await PATCH(
      postReq(
        `http://app.local/api/v1/changes/${changeSiteBId}`,
        await adminJwt([SITE_A_CODE]),
        { action: "CANCEL" }
      ),
      { params: Promise.resolve({ id: changeSiteBId }) }
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as Envelope;
    expect(body.error?.code).toBe("SITE_SCOPE_FORBIDDEN");
    // Nothing mutated — the change is still a cancellable DRAFT.
    const row = await db.changeRequest.findUnique({ where: { id: changeSiteBId } });
    expect(row?.status).toBe("DRAFT");
  });

  test("the same cancel as wildcard → 200 CANCELLED (the gate is scope-driven)", async () => {
    const PATCH = (await import("../../src/app/api/v1/changes/[id]/route")).PATCH;
    const res = await PATCH(
      postReq(`http://app.local/api/v1/changes/${changeSiteBId}`, await adminJwt(), {
        action: "CANCEL",
      }),
      { params: Promise.resolve({ id: changeSiteBId }) }
    );
    expect(res.status).toBe(200);
    const row = await db.changeRequest.findUnique({ where: { id: changeSiteBId } });
    expect(row?.status).toBe("CANCELLED");
  });

  test("an approval decision on an out-of-scope change (sites-limited manager) → 403 before any decision is recorded", async () => {
    const POST = await importPost("../../src/app/api/v1/changes/[id]/approvals/route");
    const res = await POST(
      postReq(
        `http://app.local/api/v1/changes/${changeApproveId}/approvals`,
        await adminJwt([SITE_A_CODE]),
        { level: "TECHNICAL", decision: "APPROVED" }
      ),
      { params: Promise.resolve({ id: changeApproveId }) }
    );
    // The admin session is the requester of the probe change but the scope
    // gate sits BEFORE the SoD/state checks: the out-of-scope site is the
    // refusal, not anything about the approval state.
    expect(res.status).toBe(403);
    const body = (await res.json()) as Envelope;
    expect(body.error?.code).toBe("SITE_SCOPE_FORBIDDEN");
    const decisions = await db.changeApprovalDecision.count({
      where: { approval: { changeId: changeApproveId } },
    });
    expect(decisions).toBe(0);
  });

  test("the same decision as wildcard admin → recorded (gate is scope-driven)", async () => {
    const POST = await importPost("../../src/app/api/v1/changes/[id]/approvals/route");
    const res = await POST(
      postReq(
        `http://app.local/api/v1/changes/${changeApproveId}/approvals`,
        await adminJwt(),
        { level: "TECHNICAL", decision: "APPROVED" }
      ),
      { params: Promise.resolve({ id: changeApproveId }) }
    );
    expect(res.status).toBe(200);
    const decisions = await db.changeApprovalDecision.count({
      where: { approval: { changeId: changeApproveId } },
    });
    expect(decisions).toBe(1);
  });
});

/* ── (d) F-4: jobs list + queueing + cancel/retry are site-scoped ─────── */

describe("wave10 control plane: jobs scoping (F-4)", () => {
  test("jobs list (sites-limited): only the in-scope DEVICE-targeted job is visible", async () => {
    const GET = await importGet("../../src/app/api/v1/jobs/route");
    const res = await GET(getReq("http://app.local/api/v1/jobs", await adminJwt([SITE_A_CODE])));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const rows = body.data as Array<{ id: string; targetType: string | null }>;
    expect(rows.some((row) => row.id === createdJobIds[0])).toBe(true);
    expect(rows.some((row) => row.id === createdJobIds[1])).toBe(false);
    expect(rows.some((row) => row.id === createdJobIds[2])).toBe(false);
    // Non-device targets are hidden fail-closed for scoped sessions.
    expect(rows.some((row) => row.id === createdJobIds[3])).toBe(false);
  });

  test("jobs list (wildcard): all four fixture jobs stay visible (parity)", async () => {
    const GET = await importGet("../../src/app/api/v1/jobs/route");
    const res = await GET(getReq("http://app.local/api/v1/jobs", await adminJwt()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const rows = body.data as Array<{ id: string }>;
    const ids = new Set(rows.map((row) => row.id));
    for (const jobId of createdJobIds) expect(ids.has(jobId)).toBe(true);
  });

  test("POST /jobs (sites-limited) targeting an out-of-scope device → 403 SITE_SCOPE_FORBIDDEN, nothing queued", async () => {
    const POST = await importPost("../../src/app/api/v1/jobs/route");
    const jobsBefore = await db.jobExecution.count({ where: { targetId: deviceBId } });
    const res = await POST(
      postReq("http://app.local/api/v1/jobs", await adminJwt([SITE_A_CODE]), {
        type: "CONFIG_BACKUP",
        deviceId: deviceBId,
      })
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as Envelope;
    expect(body.error?.code).toBe("SITE_SCOPE_FORBIDDEN");
    // Nothing was queued — the out-of-scope device's job count is unchanged.
    expect(await db.jobExecution.count({ where: { targetId: deviceBId } })).toBe(
      jobsBefore
    );
  });

  test("POST /jobs (wildcard) with the same body → 201 (the gate is scope-driven)", async () => {
    const POST = await importPost("../../src/app/api/v1/jobs/route");
    const res = await POST(
      postReq("http://app.local/api/v1/jobs", await adminJwt(), {
        type: "CONFIG_BACKUP",
        deviceId: deviceBId,
      })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Envelope;
    const data = body.data as { job?: { id?: string }; audit?: { correlationId?: string } };
    const meta = body.meta as { correlationId?: string } | undefined;
    if (data.job?.id) createdJobIds.push(data.job.id);
    const correlation = data.audit?.correlationId ?? meta?.correlationId;
    if (correlation) jobCorrelationIds.push(correlation);
  });

  test("cancel of an out-of-scope job (sites-limited) → 403, the job stays QUEUED", async () => {
    const POST = await importPost("../../src/app/api/v1/jobs/[id]/cancel/route");
    const res = await POST(
      postReq(
        `http://app.local/api/v1/jobs/${createdJobIds[1]}/cancel`,
        await adminJwt([SITE_A_CODE]),
        {}
      ),
      { params: Promise.resolve({ id: createdJobIds[1] }) }
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as Envelope;
    expect(body.error?.code).toBe("SITE_SCOPE_FORBIDDEN");
    // Nothing was cancelled by THIS route (the worker may legally have
    // advanced the fixture job's own lifecycle — the only state change the
    // cancel route performs is → CANCELLED).
    const job = await db.jobExecution.findUnique({ where: { id: createdJobIds[1] } });
    expect(job?.status).not.toBe("CANCELLED");
  });

  test("retry of an out-of-scope job (sites-limited) → 403 before the retryability check", async () => {
    const POST = await importPost("../../src/app/api/v1/jobs/[id]/retry/route");
    const res = await POST(
      postReq(
        `http://app.local/api/v1/jobs/${createdJobIds[2]}/retry`,
        await adminJwt([SITE_A_CODE]),
        {}
      ),
      { params: Promise.resolve({ id: createdJobIds[2] }) }
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as Envelope;
    expect(body.error?.code).toBe("SITE_SCOPE_FORBIDDEN");
  });

  test("retry of the FAILED out-of-scope job as wildcard → 201 clone (byte-parity path)", async () => {
    const POST = await importPost("../../src/app/api/v1/jobs/[id]/retry/route");
    const res = await POST(
      postReq(`http://app.local/api/v1/jobs/${createdJobIds[2]}/retry`, await adminJwt(), {}),
      { params: Promise.resolve({ id: createdJobIds[2] }) }
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Envelope;
    const data = body.data as { job?: { id?: string }; audit?: { correlationId?: string } };
    const meta = body.meta as { correlationId?: string } | undefined;
    if (data.job?.id) createdJobIds.push(data.job.id);
    const correlation = data.audit?.correlationId ?? meta?.correlationId;
    if (correlation) jobCorrelationIds.push(correlation);
  });
});

/* ── (e) F-029/R69: email discipline on engineer-visible lists ────────── */

describe("wave10 control plane: email discipline (F-029/R69)", () => {
  test("changes list for a non-admin/auditor principal shows the email LOCAL-PART", async () => {
    const GET = await importGet("../../src/app/api/v1/changes/route");
    const res = await GET(getReq("http://app.local/api/v1/changes", await managerJwt()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const rows = body.data as Array<{
      id: string;
      requester: { id: string; name: string | null; email: string };
    }>;
    const row = rows.find((entry) => entry.id === changeSitelessAId);
    expect(row).toBeTruthy();
    expect(row?.requester.email).toBe(ADMIN_EMAIL.split("@")[0]);
    expect(row?.requester.email).not.toContain("@");
  });

  test("changes list for an admin principal keeps the full address (byte-parity)", async () => {
    const GET = await importGet("../../src/app/api/v1/changes/route");
    const res = await GET(getReq("http://app.local/api/v1/changes", await adminJwt()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const rows = body.data as Array<{ id: string; requester: { email: string } }>;
    const row = rows.find((entry) => entry.id === changeSitelessAId);
    expect(row?.requester.email).toBe(ADMIN_EMAIL);
  });
});

/* ── (f) source-text pins (wave-9 differential-pin style) ─────────────── */

describe("wave10 control plane: source pins", () => {
  const readSource = (rel: string) => readFileSync(rel, "utf8");

  test("changes GET + approvals GET bodies gate on requireSessionRead (F-1)", () => {
    for (const rel of [
      "src/app/api/v1/changes/route.ts",
      "src/app/api/v1/approvals/route.ts",
    ]) {
      expect(readSource(rel)).toContain("await requireSessionRead(request)");
    }
  });

  test("execute/cancel/close bodies contain requireSiteScope (F-2)", () => {
    for (const rel of [
      "src/app/api/v1/changes/[id]/execute/route.ts",
      "src/app/api/v1/changes/[id]/route.ts",
      "src/app/api/v1/changes/[id]/approvals/route.ts",
    ]) {
      // The literal requireSiteScope(request, siteCode) mutation gate (the
      // devices/test-connection pattern); the site-less device leg rides
      // requireDeviceLegScope in the same bodies.
      expect(readSource(rel)).toContain("requireSiteScope(");
      expect(readSource(rel)).toContain("requireDeviceLegScope");
    }
  });

  test("jobs POST/cancel/retry bodies contain requireSiteScope (F-4)", () => {
    for (const rel of [
      "src/app/api/v1/jobs/route.ts",
      "src/app/api/v1/jobs/[id]/cancel/route.ts",
      "src/app/api/v1/jobs/[id]/retry/route.ts",
    ]) {
      expect(readSource(rel)).toContain("requireSiteScope(");
    }
  });

  test("the jobs create enum is honest (F-6: no REPORT_RUN)", () => {
    const source = readSource("src/app/api/v1/jobs/route.ts");
    expect(source).toContain('z.enum(["CONFIG_BACKUP"])');
    expect(source).not.toContain('"REPORT_RUN"');
  });
});
