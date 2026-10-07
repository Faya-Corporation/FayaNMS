/**
 * Wave-10 peripheral plane — F-031 scope migration + hygiene (audit 13-c).
 *
 * The wave-10 audit found the F-031 migration stopped at the wave-9 plane
 * list: the peripheral READ plane (firmware / predictive / drift / ha /
 * events) and the peripheral MUTATION plane (cmdb items PATCH + relations,
 * firmware/upgrade, drift check + triage) never composed the two central
 * primitives, and backup-policies showed a list/detail twin regression on
 * the wave-9 count-intersection fix. This suite pins the landed behavior
 * with the certified batch-25/wave-9 rig (REAL next-auth JWTs from the
 * production `encode`, RUN-suffixed fixtures, surgical afterAll cleanup):
 *
 *   FIRMWARE READ     GET /api/v1/firmware composes scopedDeviceWhere —
 *                     out-of-scope devices vanish from the inventory;
 *                     wildcard parity.
 *   FIRMWARE TRIGGER  POST /api/v1/firmware/upgrade answers 403
 *                     SITE_SCOPE_FORBIDDEN for out-of-scope targets BEFORE
 *                     the eligibility ladder; wildcard keeps the ladder.
 *   PREDICTIVE READ   GET /api/v1/predictive intersects the caller's
 *                     ?siteId= with the session scope (out-of-scope site →
 *                     200 + zero rows) and scopes the no-param pool.
 *   DRIFT READ        GET /api/v1/drift scopes the rows AND the meta
 *                     aggregates through the device relation.
 *   DRIFT TRIGGER     POST /api/v1/drift/check: single-device mode answers
 *                     403 before the NO_BASELINE 409 (no out-of-scope
 *                     baseline-existence oracle); fleet mode intersects the
 *                     candidate pool.
 *   DRIFT TRIAGE      PATCH /api/v1/drift/[id] gates the record's device
 *                     site before the transition check.
 *   CMDB MUTATIONS    PATCH /api/v1/cmdb/items/[id] + relations POST/DELETE
 *                     gate the CI linkage sites (the file-local
 *                     cmdbItemSiteCode helper) — 403 SITE_SCOPE_FORBIDDEN.
 *   EVENTS STRIP      GET /api/v1/events: for sites-limited sessions the
 *                     free-text identity fields of rows whose resource
 *                     cannot be PROVEN in-scope are stripped fail-closed
 *                     (own-actor rows keep labels); wildcard verbatim.
 *   BACKUP-POLICIES   [id] GET composes sessionScopeFor into the device
 *                     count (twin divergence with the list route closed);
 *                     create/update/delete wrap mutation + audit in one
 *                     $transaction.
 *   INTERFACES CAP    page > 1000 → the shared INVALID_QUERY 400 envelope
 *                     (deep-pagination bound, F-12).
 *   HA READ           GET /api/v1/ha drops pairs whose static site code is
 *                     out of scope and scope-intersects the DR readiness
 *                     device scan; wildcard keeps the full topology.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";

import { db } from "../../src/lib/db";
import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";

/* ── fixtures (RUN-suffixed — parallel-safe, re-runnable) ─────────────── */

const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
// Digit-only CI numbers (CI-\d{6} wire format).
const CI_NUM_A = 700000 + (parseInt(RUN, 36) % 100000);
const CI_NUM_B = 800000 + (parseInt(RUN, 36) % 100000);
const PREFIX = `w10p-`;
const ORG_NAME = `${PREFIX}org-${RUN}`;
const SITE_A_CODE = `W10A-${RUN}`; // the scoped session's site
const SITE_B_CODE = `W10B-${RUN}`; // out of scope for the scoped session
const VENDOR_KEY = `${PREFIX}vendor-${RUN}`;
const HOST_A = `${PREFIX}dev-a-${RUN.toLowerCase()}`; // site A (in scope)
const HOST_B = `${PREFIX}dev-b-${RUN.toLowerCase()}`; // site B (out of scope)
const ADMIN_EMAIL = `${PREFIX}admin-${RUN.toLowerCase()}@faya.local`;
const OTHER_EMAIL = `${PREFIX}other-${RUN.toLowerCase()}@faya.local`;
const POLICY_NAME = `${PREFIX}policy-${RUN.toLowerCase()}`;
const CI_A_NAME = `${PREFIX}ci-a-${RUN.toLowerCase()}`;
const CI_B_NAME = `${PREFIX}ci-b-${RUN.toLowerCase()}`;
const EVENT_CORRELATION = `w10-${RUN}`;

const testStartedAt = new Date();

let orgId = "";
let siteAId = "";
let siteBId = "";
let vendorId = "";
let deviceAId = "";
let deviceBId = "";
let adminId = "";
let otherId = "";
let snapAId = "";
let snapBId = "";
let recordAId = "";
let recordBOpenId = "";
let recordBAcceptedId = "";
let ciAId = "";
let ciBId = "";
let policyId = "";
const relationCorrelations: string[] = [];

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
    name: "W10 Peripheral Admin",
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

function jsonRequest(
  url: string,
  jwt: string,
  method: "POST" | "PATCH",
  body: unknown
): NextRequest {
  return new NextRequest(url, {
    method,
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

async function importHandler(
  relPath: string,
  verb: "GET" | "POST" | "PATCH" | "DELETE"
): Promise<(req: Request, ctx?: unknown) => Promise<Response>> {
  const mod = (await import(relPath)) as Record<
    string,
    (req: Request, ctx?: unknown) => Promise<Response>
  >;
  return mod[verb];
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
    data: { email: ADMIN_EMAIL, name: "W10 Peripheral Admin", role: "admin", isActive: true },
    select: { id: true },
  });
  adminId = admin.id;
  // A second actor for the events strip pin (rows that are NOT the session
  // actor's own actions must strip unless the resource proves in-scope).
  const other = await db.user.create({
    data: { email: OTHER_EMAIL, name: "W10 Other Actor", role: "viewer", isActive: true },
    select: { id: true },
  });
  otherId = other.id;

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
    data: { key: VENDOR_KEY, name: `W10 Peripheral Vendor ${RUN}`, adapterKey: "generic" },
  });
  vendorId = vendor.id;

  const devA = await db.device.create({
    data: {
      hostname: HOST_A,
      mgmtIp: "192.0.2.81",
      vendorId,
      siteId: siteAId,
      status: "ONLINE",
      firmware: "1.0.0",
    },
  });
  deviceAId = devA.id;
  const devB = await db.device.create({
    data: {
      hostname: HOST_B,
      mgmtIp: "192.0.2.82",
      vendorId,
      siteId: siteBId,
      status: "ONLINE",
      firmware: "1.0.0",
    },
  });
  deviceBId = devB.id;

  // Snapshots for the drift records (one per device; a drift record needs a
  // baseline and a current snapshot id).
  const snapA = await db.configSnapshot.create({
    data: {
      deviceId: deviceAId,
      version: 1,
      rawText: `hostname ${HOST_A}\n`,
      sha256: `w10a-${RUN}`,
      sizeBytes: 20,
      status: "HISTORICAL",
    },
  });
  snapAId = snapA.id;
  const snapB = await db.configSnapshot.create({
    data: {
      deviceId: deviceBId,
      version: 1,
      rawText: `hostname ${HOST_B}\n`,
      sha256: `w10b-${RUN}`,
      sizeBytes: 20,
      status: "HISTORICAL",
    },
  });
  snapBId = snapB.id;

  // Drift records: A (OPEN, in scope), B-open (OPEN, out of scope — the
  // triage 403 probe), B-accepted (ACCEPTED, out of scope — the wildcard
  // parity probe that must NOT answer 403).
  const recordA = await db.driftRecord.create({
    data: {
      deviceId: deviceAId,
      baselineSnapshotId: snapAId,
      currentSnapshotId: snapAId,
      diffSummary: `- line1\n+ line2`,
      status: "OPEN",
    },
  });
  recordAId = recordA.id;
  const recordBOpen = await db.driftRecord.create({
    data: {
      deviceId: deviceBId,
      baselineSnapshotId: snapBId,
      currentSnapshotId: snapBId,
      status: "OPEN",
    },
  });
  recordBOpenId = recordBOpen.id;
  const recordBAccepted = await db.driftRecord.create({
    data: {
      deviceId: deviceBId,
      baselineSnapshotId: snapBId,
      currentSnapshotId: snapBId,
      status: "ACCEPTED",
      resolvedAt: new Date(),
    },
  });
  recordBAcceptedId = recordBAccepted.id;

  // CMDB CIs: device-linked to A (in scope) and B (out of scope).
  const ciA = await db.cmdbItem.create({
    data: { ciId: `CI-${CI_NUM_A}`, name: CI_A_NAME, ciType: "device", deviceId: deviceAId },
  });
  ciAId = ciA.id;
  const ciB = await db.cmdbItem.create({
    data: { ciId: `CI-${CI_NUM_B}`, name: CI_B_NAME, ciType: "device", deviceId: deviceBId },
  });
  ciBId = ciB.id;

  // Backup policy targeting BOTH sites — the detail count must intersect
  // the session scope (1 for the [SITE_A] session, 2 for wildcard).
  const policy = await db.backupPolicy.create({
    data: {
      name: POLICY_NAME,
      cronExpr: "0 2 * * *",
      scopeJson: JSON.stringify({ siteCodes: [SITE_A_CODE, SITE_B_CODE] }),
      retentionDays: 90,
      isActive: true,
    },
  });
  policyId = policy.id;

  // Events fixtures: three rows sharing one correlation id (the q-free
  // correlationId filter isolates them deterministically). Per-row create —
  // the RT-012/F-014 chain-stamping guard forbids auditEvent.createMany.
  const eventRows = [
    {
      actorId: otherId,
      actorName: "W10 Other Actor",
      action: "W10_TEST_EVENT",
      resourceType: "Device",
      resourceId: deviceAId,
      resourceLabel: HOST_A,
      result: "SUCCESS",
      ip: "192.0.2.91",
      userAgent: "w10-peripheral-agent",
      correlationId: EVENT_CORRELATION,
      beforeJson: JSON.stringify({ w10: "a-before" }),
      afterJson: JSON.stringify({ w10: "a-after" }),
    },
    {
      actorId: otherId,
      actorName: "W10 Other Actor",
      action: "W10_TEST_EVENT",
      resourceType: "Device",
      resourceId: deviceBId,
      resourceLabel: HOST_B,
      result: "SUCCESS",
      ip: "192.0.2.92",
      userAgent: "w10-peripheral-agent",
      correlationId: EVENT_CORRELATION,
      beforeJson: JSON.stringify({ w10: "b-before" }),
      afterJson: JSON.stringify({ w10: "b-after" }),
    },
    {
      actorId: adminId,
      actorName: "W10 Peripheral Admin",
      action: "W10_TEST_EVENT",
      resourceType: "Device",
      resourceId: deviceBId,
      resourceLabel: HOST_B,
      result: "SUCCESS",
      ip: "192.0.2.93",
      userAgent: "w10-peripheral-agent",
      correlationId: EVENT_CORRELATION,
      beforeJson: JSON.stringify({ w10: "own-before" }),
      afterJson: JSON.stringify({ w10: "own-after" }),
    },
  ];
  for (const row of eventRows) {
    await db.auditEvent.create({ data: row });
  }

  expect(adminId.length).toBeGreaterThan(0);
  expect(policyId.length).toBeGreaterThan(0);
});

afterAll(async () => {
  // Surgical cleanup in FK order — every fixture row this suite created,
  // nothing else. Drift records reference snapshots (Cascade) but are
  // deleted explicitly first for determinism.
  await db.driftRecord.deleteMany({
    where: { id: { in: [recordAId, recordBOpenId, recordBAcceptedId].filter(Boolean) } },
  });
  await db.configSnapshot.deleteMany({
    where: { id: { in: [snapAId, snapBId].filter(Boolean) } },
  });
  await db.cmdbItem.deleteMany({ where: { id: { in: [ciAId, ciBId].filter(Boolean) } } });
  // The relation edge (created + removed via the wildcard probes) is gone;
  // sweep its audit rows by the captured correlation ids.
  if (relationCorrelations.length > 0) {
    await db.auditEvent.deleteMany({
      where: { correlationId: { in: relationCorrelations } },
    });
  }
  await db.backupPolicy.deleteMany({ where: { id: { in: policyId ? [policyId] : [] } } });
  await db.auditEvent.deleteMany({
    where: {
      action: "W10_TEST_EVENT",
      correlationId: EVENT_CORRELATION,
      createdAt: { gte: testStartedAt },
    },
  });
  await db.device.deleteMany({ where: { id: { in: [deviceAId, deviceBId].filter(Boolean) } } });
  await db.vendor.deleteMany({ where: { id: vendorId } });
  await db.site.deleteMany({ where: { id: { in: [siteAId, siteBId].filter(Boolean) } } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.user.deleteMany({ where: { id: { in: [adminId, otherId].filter(Boolean) } } });
});

/* ── (F-2) firmware inventory read ────────────────────────────────────── */

describe("wave10 peripheral: GET /api/v1/firmware (F-2 scopedDeviceWhere)", () => {
  test("sites-limited session: the out-of-scope device is absent from the inventory", async () => {
    const GET = await importHandler("../../src/app/api/v1/firmware/route", "GET");
    const res = await GET(
      getRequest("http://app.local/api/v1/firmware", await adminJwt([SITE_A_CODE]))
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.success).toBe(true);
    const rows = body.data as { devices: Array<{ hostname: string }>; meta: { counts: { total: number } } };
    const hostnames = rows.devices.map((d) => d.hostname);
    expect(hostnames).toContain(HOST_A);
    expect(hostnames).not.toContain(HOST_B);
    expect(rows.meta.counts.total).toBe(hostnames.length);
  });

  test("wildcard parity: both fixture devices are present", async () => {
    const GET = await importHandler("../../src/app/api/v1/firmware/route", "GET");
    const res = await GET(
      getRequest("http://app.local/api/v1/firmware", await adminJwt())
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const hostnames = (body.data as { devices: Array<{ hostname: string }> }).devices.map(
      (d) => d.hostname
    );
    expect(hostnames).toContain(HOST_A);
    expect(hostnames).toContain(HOST_B);
  });
});

/* ── (F-5) firmware upgrade trigger ───────────────────────────────────── */

describe("wave10 peripheral: POST /api/v1/firmware/upgrade (F-5 scope gate)", () => {
  test("sites-limited session: out-of-scope target → 403 SITE_SCOPE_FORBIDDEN before any 409", async () => {
    const POST = await importHandler("../../src/app/api/v1/firmware/upgrade/route", "POST");
    const res = await POST(
      jsonRequest("http://app.local/api/v1/firmware/upgrade", await adminJwt([SITE_A_CODE]), "POST", {
        deviceId: deviceBId,
        targetVersion: "2.0.0",
      })
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as Envelope;
    expect(body.error?.code).toBe("SITE_SCOPE_FORBIDDEN");
  });

  test("wildcard parity: the ladder proceeds (in-scope semantics — ALREADY_AT_TARGET 409)", async () => {
    const POST = await importHandler("../../src/app/api/v1/firmware/upgrade/route", "POST");
    // Device B runs firmware 1.0.0 and the request asks for 1.0.0 — the
    // wildcard session passes the scope gate and reaches the eligibility
    // ladder (proving the gate does not disturb in-scope/wildcard flows
    // without enqueuing a real job).
    const res = await POST(
      jsonRequest("http://app.local/api/v1/firmware/upgrade", await adminJwt(), "POST", {
        deviceId: deviceBId,
        targetVersion: "1.0.0",
      })
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as Envelope;
    expect(body.error?.code).toBe("ALREADY_AT_TARGET");
  });
});

/* ── (F-3) predictive read ────────────────────────────────────────────── */

describe("wave10 peripheral: GET /api/v1/predictive (F-3 siteId ∩ scope)", () => {
  test("sites-limited session: ?siteId=<out-of-scope> → 200 with zero rows (never global)", async () => {
    const GET = await importHandler("../../src/app/api/v1/predictive/route", "GET");
    const res = await GET(
      getRequest(
        `http://app.local/api/v1/predictive?siteId=${siteBId}`,
        await adminJwt([SITE_A_CODE])
      )
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const payload = body.data as { devices: unknown[]; meta: { deviceCount: number } };
    expect(payload.devices).toEqual([]);
    expect(payload.meta.deviceCount).toBe(0);
  });

  test("sites-limited session: no param → scope-intersected pool only", async () => {
    const GET = await importHandler("../../src/app/api/v1/predictive/route", "GET");
    const res = await GET(
      getRequest("http://app.local/api/v1/predictive", await adminJwt([SITE_A_CODE]))
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const payload = body.data as {
      devices: Array<{ deviceId: string }>;
      meta: { deviceCount: number };
    };
    expect(payload.devices.map((d) => d.deviceId)).toEqual([deviceAId]);
    expect(payload.meta.deviceCount).toBe(1);
  });

  test("wildcard parity: ?siteId=<B> sees site B's device; no param sees both", async () => {
    const GET = await importHandler("../../src/app/api/v1/predictive/route", "GET");
    const filtered = await (
      await GET(
        getRequest(`http://app.local/api/v1/predictive?siteId=${siteBId}`, await adminJwt())
      )
    ).json();
    expect(
      ((filtered as Envelope).data as { devices: Array<{ deviceId: string }> }).devices.map(
        (d) => d.deviceId
      )
    ).toEqual([deviceBId]);

    const unfiltered = await (
      await GET(getRequest("http://app.local/api/v1/predictive", await adminJwt()))
    ).json();
    const ids = (
      (unfiltered as Envelope).data as { devices: Array<{ deviceId: string }> }
    ).devices.map((d) => d.deviceId);
    expect(ids).toContain(deviceAId);
    expect(ids).toContain(deviceBId);
  });
});

/* ── (F-4) drift read ─────────────────────────────────────────────────── */

describe("wave10 peripheral: GET /api/v1/drift (F-4 rows + meta aggregates)", () => {
  test("sites-limited session: ?deviceId=<out-of-scope> → total 0 even though the record exists", async () => {
    const GET = await importHandler("../../src/app/api/v1/drift/route", "GET");
    const res = await GET(
      getRequest(
        `http://app.local/api/v1/drift?deviceId=${deviceBId}`,
        await adminJwt([SITE_A_CODE])
      )
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.data).toEqual([]);
    expect(body.meta?.total).toBe(0);
  });

  test("sites-limited session: the list shows only the in-scope row and the meta counts follow", async () => {
    const GET = await importHandler("../../src/app/api/v1/drift/route", "GET");
    const res = await GET(
      getRequest("http://app.local/api/v1/drift", await adminJwt([SITE_A_CODE]))
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const rows = body.data as Array<{ deviceId: string; diffSummary: string | null }>;
    expect(rows.some((r) => r.deviceId === deviceAId)).toBe(true);
    expect(rows.some((r) => r.deviceId === deviceBId)).toBe(false);
    // The config-diff content of the in-scope row survives verbatim.
    expect(rows.find((r) => r.deviceId === deviceAId)?.diffSummary).toContain("+ line2");
    expect(body.meta?.open).toBe(1);
  });

  test("wildcard parity: both rows visible, meta.open counts both fixtures", async () => {
    const GET = await importHandler("../../src/app/api/v1/drift/route", "GET");
    const res = await GET(
      getRequest("http://app.local/api/v1/drift", await adminJwt())
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const rows = body.data as Array<{ deviceId: string }>;
    expect(rows.some((r) => r.deviceId === deviceAId)).toBe(true);
    expect(rows.some((r) => r.deviceId === deviceBId)).toBe(true);
    expect(body.meta?.open).toBeGreaterThanOrEqual(2);
  });
});

/* ── (F-8) drift check trigger + triage ───────────────────────────────── */

describe("wave10 peripheral: POST /api/v1/drift/check (F-8)", () => {
  test("single-device mode: out-of-scope target → 403 BEFORE the NO_BASELINE 409", async () => {
    const POST = await importHandler("../../src/app/api/v1/drift/check/route", "POST");
    // Device B has NO approved baseline: if the gate ran after the baseline
    // probe this would answer 409 NO_BASELINE (the audited existence
    // oracle). It must answer 403.
    const res = await POST(
      jsonRequest("http://app.local/api/v1/drift/check", await adminJwt([SITE_A_CODE]), "POST", {
        deviceId: deviceBId,
      })
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as Envelope;
    expect(body.error?.code).toBe("SITE_SCOPE_FORBIDDEN");
  });

  test("wildcard parity: same request passes the gate and reaches NO_BASELINE 409", async () => {
    const POST = await importHandler("../../src/app/api/v1/drift/check/route", "POST");
    const res = await POST(
      jsonRequest("http://app.local/api/v1/drift/check", await adminJwt(), "POST", {
        deviceId: deviceBId,
      })
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as Envelope;
    expect(body.error?.code).toBe("NO_BASELINE");
  });
});

describe("wave10 peripheral: PATCH /api/v1/drift/[id] (F-8 triage gate)", () => {
  test("sites-limited session: out-of-scope OPEN record → 403 (before the transition check)", async () => {
    const PATCH = await importHandler("../../src/app/api/v1/drift/[id]/route", "PATCH");
    const res = await PATCH(
      jsonRequest(
        `http://app.local/api/v1/drift/${recordBOpenId}`,
        await adminJwt([SITE_A_CODE]),
        "PATCH",
        { action: "ACCEPT" }
      ),
      { params: Promise.resolve({ id: recordBOpenId }) }
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as Envelope;
    expect(body.error?.code).toBe("SITE_SCOPE_FORBIDDEN");
    // Nothing transitioned.
    const row = await db.driftRecord.findUnique({ where: { id: recordBOpenId } });
    expect(row?.status).toBe("OPEN");
  });

  test("wildcard parity: the gate passes; the state machine still answers (409 on non-OPEN)", async () => {
    const PATCH = await importHandler("../../src/app/api/v1/drift/[id]/route", "PATCH");
    const res = await PATCH(
      jsonRequest(
        `http://app.local/api/v1/drift/${recordBAcceptedId}`,
        await adminJwt(),
        "PATCH",
        { action: "ACCEPT" }
      ),
      { params: Promise.resolve({ id: recordBAcceptedId }) }
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as Envelope;
    expect(body.error?.code).toBe("INVALID_TRANSITION");
  });
});

/* ── (F-6) cmdb mutation plane ────────────────────────────────────────── */

describe("wave10 peripheral: cmdb mutations (F-6 linkage site gates)", () => {
  test("PATCH /api/v1/cmdb/items/[id]: out-of-scope CI → 403 SITE_SCOPE_FORBIDDEN", async () => {
    const PATCH = await importHandler("../../src/app/api/v1/cmdb/items/[id]/route", "PATCH");
    const res = await PATCH(
      jsonRequest(
        `http://app.local/api/v1/cmdb/items/${ciBId}`,
        await adminJwt([SITE_A_CODE]),
        "PATCH",
        { description: `w10-attempt-${RUN}` }
      ),
      { params: Promise.resolve({ id: ciBId }) }
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as Envelope;
    expect(body.error?.code).toBe("SITE_SCOPE_FORBIDDEN");
    // Nothing written.
    const row = await db.cmdbItem.findUnique({ where: { id: ciBId } });
    expect(row?.description).toBeNull();
  });

  test("PATCH wildcard parity: unchanged no-op reaches the handler (200 unchanged, no audit)", async () => {
    const PATCH = await importHandler("../../src/app/api/v1/cmdb/items/[id]/route", "PATCH");
    const res = await PATCH(
      jsonRequest(`http://app.local/api/v1/cmdb/items/${ciBId}`, await adminJwt(), "PATCH", {
        description: null,
      }),
      { params: Promise.resolve({ id: ciBId }) }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.meta?.unchanged).toBe(true);
  });

  test("POST /api/v1/cmdb/relations: one out-of-scope endpoint → 403 (both endpoints gated)", async () => {
    const POST = await importHandler("../../src/app/api/v1/cmdb/relations/route", "POST");
    const res = await POST(
      jsonRequest("http://app.local/api/v1/cmdb/relations", await adminJwt([SITE_A_CODE]), "POST", {
        sourceId: ciAId, // in scope
        targetId: ciBId, // out of scope
        relationType: "connects_to",
      })
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as Envelope;
    expect(body.error?.code).toBe("SITE_SCOPE_FORBIDDEN");
    const edge = await db.cmdbRelation.findFirst({
      where: { sourceId: ciAId, targetId: ciBId },
    });
    expect(edge).toBeNull();
  });

  test("DELETE /api/v1/cmdb/relations: an edge with an out-of-scope endpoint → 403", async () => {
    const POST = await importHandler("../../src/app/api/v1/cmdb/relations/route", "POST");
    const DELETE = await importHandler("../../src/app/api/v1/cmdb/relations/route", "DELETE");

    // Wildcard session creates the edge (valid operation for wildcard).
    const created = await POST(
      jsonRequest("http://app.local/api/v1/cmdb/relations", await adminJwt(), "POST", {
        sourceId: ciAId,
        targetId: ciBId,
        relationType: "connects_to",
      })
    );
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as Envelope;
    const relationId = (createdBody.data as { relation: { id: string } }).relation.id;
    const postCorrelation = (createdBody.meta as { correlationId?: string }).correlationId;
    if (postCorrelation) relationCorrelations.push(postCorrelation);

    // The scoped session may NOT remove it (one endpoint is out of scope).
    const denied = await DELETE(
      new NextRequest(`http://app.local/api/v1/cmdb/relations?id=${relationId}`, {
        method: "DELETE",
        headers: { cookie: `next-auth.session-token=${await adminJwt([SITE_A_CODE])}` },
      })
    );
    expect(denied.status).toBe(403);
    const deniedBody = (await denied.json()) as Envelope;
    expect(deniedBody.error?.code).toBe("SITE_SCOPE_FORBIDDEN");
    expect(await db.cmdbRelation.findUnique({ where: { id: relationId } })).not.toBeNull();

    // Wildcard removes it (cleanup + parity proof).
    const removed = await DELETE(
      new NextRequest(`http://app.local/api/v1/cmdb/relations?id=${relationId}`, {
        method: "DELETE",
        headers: { cookie: `next-auth.session-token=${await adminJwt()}` },
      })
    );
    expect(removed.status).toBe(200);
    const removedBody = (await removed.json()) as Envelope;
    const removedCorrelation = (removedBody.meta as { correlationId?: string }).correlationId;
    if (removedCorrelation) relationCorrelations.push(removedCorrelation);
    expect(await db.cmdbRelation.findUnique({ where: { id: relationId } })).toBeNull();
  });
});

/* ── (F-1) events strip mitigation ────────────────────────────────────── */

describe("wave10 peripheral: GET /api/v1/events (F-1 minimum strip)", () => {
  type EventRow = {
    id: string;
    actorId: string | null;
    resourceId: string | null;
    resourceLabel: string | null;
    ip: string | null;
    userAgent: string | null;
    beforeJson: unknown;
    afterJson: unknown;
  };

  test("sites-limited session: out-of-scope rows strip identity; in-scope and own rows keep it", async () => {
    const GET = await importHandler("../../src/app/api/v1/events/route", "GET");
    const res = await GET(
      getRequest(
        `http://app.local/api/v1/events?correlationId=${EVENT_CORRELATION}&pageSize=10`,
        await adminJwt([SITE_A_CODE])
      )
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const rows = body.data as EventRow[];
    expect(rows).toHaveLength(3);

    // Order-independent row resolution: two rows share resourceId=deviceB
    // (the other actor's row and the session's own carve-out row) and the
    // route's createdAt ordering can legitimately tie within the same
    // microsecond on fast runners — so select by PREDICATE, never by array
    // position or last-write-wins Map semantics.
    const rowA = rows.find((r) => r.resourceId === deviceAId);
    expect(rowA?.resourceLabel).toBe(HOST_A);
    expect(rowA?.ip).toBe("192.0.2.91");
    expect(rowA?.userAgent).toBe("w10-peripheral-agent");
    expect(rowA?.beforeJson).toEqual({ w10: "a-before" });
    expect(rowA?.afterJson).toEqual({ w10: "a-after" });

    // Out-of-scope device row (another actor): FAIL-CLOSED strip.
    const rowB = rows.find((r) => r.resourceId === deviceBId && r.actorId !== adminId);
    const ownRow = rows.find((r) => r.actorId === adminId);
    expect(ownRow?.id).toBeDefined();
    expect(rowB?.id).toBeDefined();
    expect(rowB?.actorId).not.toBe(adminId);
    expect(rowB?.resourceLabel).toBeNull();
    expect(rowB?.ip).toBeNull();
    expect(rowB?.userAgent).toBeNull();
    expect(rowB?.beforeJson).toBeNull();
    expect(rowB?.afterJson).toBeNull();

    // The session actor's OWN event on the same out-of-scope device keeps
    // its labels (the documented actor-own carve-out).
    expect(ownRow?.resourceId).toBe(deviceBId);
    expect(ownRow?.resourceLabel).toBe(HOST_B);
    expect(ownRow?.ip).toBe("192.0.2.93");
  });

  test("wildcard parity: every row keeps its verbatim identity fields", async () => {
    const GET = await importHandler("../../src/app/api/v1/events/route", "GET");
    const res = await GET(
      getRequest(
        `http://app.local/api/v1/events?correlationId=${EVENT_CORRELATION}&pageSize=10`,
        await adminJwt()
      )
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const rows = body.data as EventRow[];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.resourceLabel).not.toBeNull();
      expect(row.ip).not.toBeNull();
      expect(row.beforeJson).not.toBeNull();
    }
  });
});

/* ── (F-9 + F-11) backup-policies detail count + transactions ─────────── */

describe("wave10 peripheral: backup-policies (F-9 twin count + F-11 transactions)", () => {
  test("[id] GET: the device count intersects the SESSION scope exactly like the list route", async () => {
    const GET = await importHandler("../../src/app/api/v1/backup-policies/[id]/route", "GET");

    const scopedRes = await GET(
      getRequest(`http://app.local/api/v1/backup-policies/${policyId}`, await adminJwt([SITE_A_CODE])),
      { params: Promise.resolve({ id: policyId }) }
    );
    expect(scopedRes.status).toBe(200);
    const scoped = (await scopedRes.json()) as Envelope;
    expect((scoped.data as { scopedDeviceCount: number }).scopedDeviceCount).toBe(1);

    const wildcardRes = await GET(
      getRequest(`http://app.local/api/v1/backup-policies/${policyId}`, await adminJwt()),
      { params: Promise.resolve({ id: policyId }) }
    );
    expect(wildcardRes.status).toBe(200);
    const wildcard = (await wildcardRes.json()) as Envelope;
    expect((wildcard.data as { scopedDeviceCount: number }).scopedDeviceCount).toBe(2);
  });

  test("source contract: policy create/update/delete wrap mutation + audit in ONE transaction", async () => {
    const { readFileSync } = await import("node:fs");
    for (const rel of [
      "src/app/api/v1/backup-policies/route.ts",
      "src/app/api/v1/backup-policies/[id]/route.ts",
    ]) {
      const src = readFileSync(rel, "utf8");
      expect(src).toContain("db.$transaction(async (tx) =>");
      // Every policy audit row is written through the tx client.
      expect(src.includes("db.auditEvent.create")).toBe(false);
      expect(src).toContain("tx.auditEvent.create");
    }
  });
});

/* ── (F-12) interfaces page cap ───────────────────────────────────────── */

describe("wave10 peripheral: GET /api/v1/interfaces (F-12 page cap)", () => {
  test("page > 1000 → the shared INVALID_QUERY 400 envelope", async () => {
    const GET = await importHandler("../../src/app/api/v1/interfaces/route", "GET");
    const res = await GET(
      getRequest("http://app.local/api/v1/interfaces?page=1001&pageSize=10", await adminJwt())
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Envelope;
    expect(body.error?.code).toBe("INVALID_QUERY");
  });

  test("page = 1000 is accepted (the bound, not below it)", async () => {
    const GET = await importHandler("../../src/app/api/v1/interfaces/route", "GET");
    const res = await GET(
      getRequest("http://app.local/api/v1/interfaces?page=1000&pageSize=10", await adminJwt())
    );
    expect(res.status).toBe(200);
  });
});

/* ── (F-7) ha read ────────────────────────────────────────────────────── */

describe("wave10 peripheral: GET /api/v1/ha (F-7 pair drop + DR readiness scope)", () => {
  test("sites-limited session: pairs whose static site code is out of scope are dropped", async () => {
    const GET = await importHandler("../../src/app/api/v1/ha/route", "GET");
    // The static HA_PAIRS site codes (HQ-SAN / DC-ADN) never match the
    // RUN-suffixed fixture scope → every pair is out of scope → dropped.
    const res = await GET(
      getRequest("http://app.local/api/v1/ha", await adminJwt([SITE_A_CODE]))
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const payload = body.data as { pairs: unknown[]; drSites: unknown[] };
    expect(payload.pairs).toEqual([]);
    // The static DR topology rows stay (aggregate-only readiness).
    expect(payload.drSites.length).toBeGreaterThan(0);
  });

  test("wildcard parity: the full static pair topology renders", async () => {
    const GET = await importHandler("../../src/app/api/v1/ha/route", "GET");
    const res = await GET(getRequest("http://app.local/api/v1/ha", await adminJwt()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const payload = body.data as { pairs: Array<{ siteCode: string }>; drSites: unknown[] };
    expect(payload.pairs.length).toBeGreaterThan(0);
    expect(payload.drSites.length).toBeGreaterThan(0);
  });
});

/* ── source-text pins (the wave-10 differential pins) ─────────────────── */

describe("wave10 peripheral: source contract (differential pins)", () => {
  test("every migrated route composes the canonical F-031 primitives", async () => {
    const { readFileSync } = await import("node:fs");

    // F-2: firmware GET composes the scope into the device findMany.
    const firmware = readFileSync("src/app/api/v1/firmware/route.ts", "utf8");
    expect(firmware).toContain("scopedDeviceWhere(scopeClaims, {})");
    expect(firmware).toContain("sessionScopeFor(request)");

    // F-5: firmware/upgrade carries the requireSiteScope mutation gate.
    const upgrade = readFileSync("src/app/api/v1/firmware/upgrade/route.ts", "utf8");
    expect(upgrade).toContain("requireSiteScope(request, device.site?.code ?? null)");

    // F-6: cmdb items/[id] PATCH + relations POST/DELETE gate the CI
    // linkage sites through the file-local cmdbItemSiteCode helper.
    const cmdbDetail = readFileSync("src/app/api/v1/cmdb/items/[id]/route.ts", "utf8");
    expect(cmdbDetail).toContain("requireSiteScope(request, await cmdbItemSiteCode(item))");
    const relations = readFileSync("src/app/api/v1/cmdb/relations/route.ts", "utf8");
    expect(relations).toContain("await requireSiteScope(request, await cmdbItemSiteCode(source))");
    expect(relations).toContain("await requireSiteScope(request, await cmdbItemSiteCode(target))");
    expect(relations).toContain(
      "await requireSiteScope(request, await cmdbItemSiteCode(relation.source))"
    );
    expect(relations).toContain(
      "await requireSiteScope(request, await cmdbItemSiteCode(relation.target))"
    );

    // F-8: drift/check single-device + drift/[id] triage carry the gate.
    const driftCheck = readFileSync("src/app/api/v1/drift/check/route.ts", "utf8");
    expect(driftCheck).toContain("requireSiteScope(request, device.site?.code ?? null)");
    expect(driftCheck).toContain("scopedDeviceWhere(scopeClaims, { id: { in: candidates } })");
    const driftDetail = readFileSync("src/app/api/v1/drift/[id]/route.ts", "utf8");
    expect(driftDetail).toContain("requireSiteScope(request, record.device.site?.code ?? null)");

    // F-9: backup-policies/[id] composes sessionScopeFor (twin parity).
    const policyDetail = readFileSync("src/app/api/v1/backup-policies/[id]/route.ts", "utf8");
    expect(policyDetail).toContain("scopedDeviceWhere(await sessionScopeFor(request)");

    // F-1: events contains the strip mitigation (fail-closed, minimum).
    const events = readFileSync("src/app/api/v1/events/route.ts", "utf8");
    expect(events).toContain("MINIMUM MITIGATION ONLY");
    expect(events).toContain("siteScopeAllows(scope, d.site?.code ?? null)");
    expect(events).toContain("resourceLabel: null");

    // F-12: interfaces page is capped (the shared paginationSchema bound).
    const interfaces = readFileSync("src/app/api/v1/interfaces/route.ts", "utf8");
    expect(interfaces).toContain("page: z.coerce.number().int().min(1).max(1000).default(1)");

    // F-3/F-4/F-7: the read planes compose the scope (predictive, drift
    // meta, ha pairs + DR readiness).
    const predictive = readFileSync("src/app/api/v1/predictive/route.ts", "utf8");
    expect(predictive).toContain("scopedDeviceWhere(scopeClaims, siteId ? { siteId } : {})");
    const driftList = readFileSync("src/app/api/v1/drift/route.ts", "utf8");
    expect(driftList).toContain("{ device: scopedDeviceWhere(scopeClaims, {}) }");
    const ha = readFileSync("src/app/api/v1/ha/route.ts", "utf8");
    expect(ha).toContain("sessionAllowsSite(scopeClaims, pair.siteCode)");
    expect(ha).toContain("scopedDeviceWhere(scopeClaims, { siteId: { in: drSiteIds } })");
  });
});
