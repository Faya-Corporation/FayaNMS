/**
 * F-031 device-domain migration (site-scope wave 2) — behavioral pins.
 *
 * The F-031 reference migration (batch 25) wired site scoping on
 * GET /api/v1/devices (list) and GET /api/v1/devices/[id] (detail,
 * 404-not-403). The authorization-matrix §5.1 "Migration note" names the
 * next plane: the remaining device-domain routes must compose the SAME
 * two primitives so a device hidden from the list cannot leak through its
 * sub-resource or mutation surfaces. This suite pins that migration:
 *
 *   READ PLANE (404-NOT-403, sessionAllowsSite row predicate):
 *     GET /api/v1/devices/[id]/alerts | audit | changes | incidents |
 *          interfaces | metrics
 *     → an out-of-scope device answers the SAME DEVICE_NOT_FOUND envelope
 *       a wildcard session gets for a missing device (no existence leak);
 *       in-scope and wildcard sessions are byte-unchanged.
 *
 *   READ PLANE (list composition, scopedDeviceWhere):
 *     GET /api/v1/interfaces (fleet inventory)
 *     → sites mode composes `site.code IN (…)` over the device relation
 *       filter — out-of-scope interfaces vanish from rows AND summary;
 *       wildcard sessions keep the byte-unchanged where shape.
 *
 *   MUTATION PLANE (requireSiteScope → 403 SITE_SCOPE_FORBIDDEN):
 *     PATCH /api/v1/devices/[id]  — the device's CURRENT site must be in
 *     scope, AND a siteId repoint target must also be in scope (moving an
 *     in-scope device out of the operator's own visibility is refused);
 *     POST /api/v1/devices — the target siteId must be in scope.
 *
 *   WAVE-7 EXTENSIONS (this suite keeps owning the shared-rig pins):
 *     - fleet summary exactness (deny-all → total 0; site-A → exact count,
 *       never vacuous `>= 0`);
 *     - a MALFORMED claim (`sites: "BAD"`) is deny-all on BOTH planes
 *       (sub-resource read → 404; PATCH → 403);
 *     - PATCH `siteId: null` (detach) → 403 from sites-limited/deny-all
 *       sessions, byte-unchanged write for wildcard sessions;
 *     - site-less devices (siteId null): hidden on reads, mutable on the
 *       mutation plane (assertSiteScope(null) bypass), creatable without
 *       a site (201, row carries null siteId).
 *
 * Harness: the certified batch-25 pattern — REAL next-auth JWTs minted
 * with the production encoder (no mock.module), migrate-deploy-safe
 * upserts, surgical FK-order cleanup bounded to this suite's fixtures.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";
import { db } from "../../src/lib/db";
import { AuthError } from "../../src/lib/auth/session";
import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";

/* ── fixtures (RUN-suffixed — parallel-safe, re-runnable) ─────────────── */

const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
const ORG_NAME = `b25w2-org-${RUN}`;
const SITE_A_CODE = `W2A-${RUN}`;
const SITE_B_CODE = `W2B-${RUN}`;
const VENDOR_KEY = `b25w2-vendor-${RUN}`;
const HOST_A = `b25w2-dev-a-${RUN.toLowerCase()}`;
const HOST_B = `b25w2-dev-b-${RUN.toLowerCase()}`;
const HOST_C = `b25w2-dev-c-${RUN.toLowerCase()}`; // site-less fixture (siteId null)
const IF_NAME_A = `Gi0/1-w2a-${RUN}`;
const IF_NAME_B = `Gi0/1-w2b-${RUN}`;
const ADMIN_EMAIL = "admin@faya.local";
const POST_HOST = `b25w2-post-${RUN.toLowerCase()}`;

const testStartedAt = new Date();

let orgId = "";
let siteAId = "";
let siteBId = "";
let vendorId = "";
let deviceAId = "";
let deviceBId = "";
let deviceCId = ""; // site-less (siteId null)
let postCreatedDeviceId = "";
let postNoSiteDeviceId = ""; // created WITHOUT siteId (null site edge)

type SessionShape = { id: string; email: string; name: string | null; role: string; sites?: unknown };

/** Real next-auth JWT from the production encoder (batch-25 pattern). */
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
  const admin = await db.user.findUnique({
    where: { email: ADMIN_EMAIL },
    select: { id: true, email: true, name: true, role: true },
  });
  expect(admin).toBeTruthy();
  return mintSessionJwt({ ...admin!, ...(sites !== undefined ? { sites } : {}) });
}

/* ── live-handler request helpers ─────────────────────────────────────── */

type RouteModule = {
  GET: (req: Request, ctx?: { params: Promise<{ id: string }> }) => Promise<Response>;
};

function detailRequest(
  sub: string,
  jwt: string,
  id: string
): Promise<Response> {
  return import(`../../src/app/api/v1/devices/[id]/${sub}/route`).then(
    ({ GET }: RouteModule) =>
      GET(
        new NextRequest(`http://app.local/api/v1/devices/${id}/${sub}`, {
          method: "GET",
          headers: { cookie: `next-auth.session-token=${jwt}` },
        }),
        { params: Promise.resolve({ id }) }
      )
  );
}

async function deviceDetailRequest(jwt: string, id: string): Promise<Response> {
  const { GET } = (await import("../../src/app/api/v1/devices/[id]/route")) as RouteModule;
  return GET(
    new NextRequest(`http://app.local/api/v1/devices/${id}`, {
      method: "GET",
      headers: { cookie: `next-auth.session-token=${jwt}` },
    }),
    { params: Promise.resolve({ id }) }
  );
}

async function interfacesListRequest(jwt: string): Promise<Response> {
  const { GET } = (await import("../../src/app/api/v1/interfaces/route")) as RouteModule;
  return GET(
    new NextRequest("http://app.local/api/v1/interfaces?pageSize=200", {
      method: "GET",
      headers: { cookie: `next-auth.session-token=${jwt}` },
    })
  );
}

async function patchDeviceRequest(jwt: string, id: string, body: unknown): Promise<Response> {
  const { PATCH } = (await import("../../src/app/api/v1/devices/[id]/route")) as {
    PATCH: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  };
  return PATCH(
    new NextRequest(`http://app.local/api/v1/devices/${id}`, {
      method: "PATCH",
      headers: { cookie: `next-auth.session-token=${jwt}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
}

async function postDeviceRequest(jwt: string, body: unknown): Promise<Response> {
  const { POST } = (await import("../../src/app/api/v1/devices/route")) as {
    POST: (req: Request) => Promise<Response>;
  };
  return POST(
    new NextRequest("http://app.local/api/v1/devices", {
      method: "POST",
      headers: { cookie: `next-auth.session-token=${jwt}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

interface Envelope {
  success?: boolean;
  data?: unknown;
  error?: { code?: string };
}

async function envelope(res: Response): Promise<Envelope> {
  return (await res.json()) as Envelope;
}

/** The six device-scoped sub-resource read routes migrated by this wave. */
const SUB_RESOURCE_ROUTES = [
  "alerts",
  "audit",
  "changes",
  "incidents",
  "interfaces",
  "metrics",
] as const;

beforeAll(async () => {
  // CI replays ONLY `migrate deploy` (no demo seed): upsert the admin
  // Role + identity from ROLE_MATRIX (certified rt012/batch-3 pattern).
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
  await db.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: { isActive: true },
    create: { email: ADMIN_EMAIL, name: "B25W2 Admin", role: "admin", isActive: true },
  });

  const org = await db.organization.create({ data: { name: ORG_NAME } });
  orgId = org.id;
  const siteA = await db.site.create({
    data: { name: `B25W2 Site A ${RUN}`, code: SITE_A_CODE, organizationId: orgId },
  });
  siteAId = siteA.id;
  const siteB = await db.site.create({
    data: { name: `B25W2 Site B ${RUN}`, code: SITE_B_CODE, organizationId: orgId },
  });
  siteBId = siteB.id;

  const vendor = await db.vendor.create({
    data: { key: VENDOR_KEY, name: `B25W2 Vendor ${RUN}`, adapterKey: "generic" },
  });
  vendorId = vendor.id;

  const devA = await db.device.create({
    data: { hostname: HOST_A, mgmtIp: "192.0.2.43", vendorId, siteId: siteAId, status: "ONLINE" },
  });
  deviceAId = devA.id;
  const devB = await db.device.create({
    data: { hostname: HOST_B, mgmtIp: "192.0.2.44", vendorId, siteId: siteBId, status: "ONLINE" },
  });
  deviceBId = devB.id;
  // Site-less fixture (wave-7): siteId null — the unscoped-resource edge.
  const devC = await db.device.create({
    data: { hostname: HOST_C, mgmtIp: "192.0.2.48", vendorId, siteId: null, status: "ONLINE" },
  });
  deviceCId = devC.id;

  // One interface per fixture device — the fleet-list parity probes.
  await db.deviceInterface.create({
    data: { deviceId: deviceAId, name: IF_NAME_A, adminStatus: "UP", operStatus: "UP", speedMbps: 1000 },
  });
  await db.deviceInterface.create({
    data: { deviceId: deviceBId, name: IF_NAME_B, adminStatus: "UP", operStatus: "DOWN", speedMbps: 1000 },
  });

  expect(deviceAId).not.toBe(deviceBId);
});

afterAll(async () => {
  // Surgical FK-order cleanup — every fixture row this suite created,
  // nothing else. Audit rows (PATCH/POST writes) are reclaimed with the
  // established createdAt-gte bound (batch-22/25 pattern).
  await db.auditEvent.deleteMany({
    where: {
      resourceType: "Device",
      resourceId: {
        in: [deviceAId, deviceBId, deviceCId, postCreatedDeviceId, postNoSiteDeviceId].filter(Boolean),
      },
      createdAt: { gte: testStartedAt },
    },
  });
  await db.deviceInterface.deleteMany({ where: { deviceId: { in: [deviceAId, deviceBId].filter(Boolean) } } });
  await db.device.deleteMany({
    where: { id: { in: [deviceAId, deviceBId, deviceCId, postCreatedDeviceId, postNoSiteDeviceId].filter(Boolean) } },
  });
  await db.vendor.deleteMany({ where: { id: vendorId } });
  await db.site.deleteMany({ where: { id: { in: [siteAId, siteBId].filter(Boolean) } } });
  await db.organization.deleteMany({ where: { id: orgId } });
});

/* ── read plane — the six device-scoped sub-resource routes ───────────── */

describe("F-031 device domain — sub-resource reads (404-not-403 parity)", () => {
  test("wildcard session: every sub-resource route answers 200 for both fixture devices (byte-unchanged)", async () => {
    const jwt = await adminJwt();
    for (const sub of SUB_RESOURCE_ROUTES) {
      for (const deviceId of [deviceAId, deviceBId]) {
        const res = await detailRequest(sub, jwt, deviceId);
        expect(res.status).toBe(200);
        expect((await envelope(res)).success).toBe(true);
      }
    }
  });

  test("sites-limited session (site A): in-scope 200 — out-of-scope 404 with the SAME envelope code", async () => {
    const jwt = await adminJwt([SITE_A_CODE]);
    for (const sub of SUB_RESOURCE_ROUTES) {
      const inScope = await detailRequest(sub, jwt, deviceAId);
      expect(inScope.status).toBe(200);

      const hidden = await detailRequest(sub, jwt, deviceBId);
      expect(hidden.status).toBe(404);

      const missing = await detailRequest(sub, jwt, "device-b25w2-does-not-exist");
      expect(missing.status).toBe(404);

      // The anti-existence-leak contract: out-of-scope and missing share
      // the exact DEVICE_NOT_FOUND envelope code (batch-25 pin shape).
      const hiddenBody = await envelope(hidden);
      const missingBody = await envelope(missing);
      expect(hiddenBody.error?.code).toBe("DEVICE_NOT_FOUND");
      expect(missingBody.error?.code).toBe(hiddenBody.error?.code);
    }
  });

  test("deny-all scope (sites: []): NEITHER fixture device leaks through any sub-resource route", async () => {
    const jwt = await adminJwt([]);
    for (const sub of SUB_RESOURCE_ROUTES) {
      for (const deviceId of [deviceAId, deviceBId]) {
        const res = await detailRequest(sub, jwt, deviceId);
        expect(res.status).toBe(404);
        expect((await envelope(res)).error?.code).toBe("DEVICE_NOT_FOUND");
      }
    }
  });
});

/* ── read plane — the fleet interfaces inventory list ─────────────────── */

describe("F-031 device domain — GET /api/v1/interfaces list composition", () => {
  async function fixtureRows(jwt: string): Promise<string[]> {
    const res = await interfacesListRequest(jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data?: { rows?: Array<{ deviceId: string; name: string }> };
    };
    return (body.data?.rows ?? [])
      .filter((r) => r.deviceId === deviceAId || r.deviceId === deviceBId)
      .map((r) => r.name)
      .sort();
  }

  test("wildcard session sees BOTH fixture interfaces (byte-unchanged where shape)", async () => {
    expect(await fixtureRows(await adminJwt())).toEqual([IF_NAME_A, IF_NAME_B].sort());
  });

  test("sites-limited session (site A) sees ONLY site A's interface — row AND summary agree", async () => {
    expect(await fixtureRows(await adminJwt([SITE_A_CODE]))).toEqual([IF_NAME_A]);

    // Wave-7 summary exactness: the summary block shares the scoped where,
    // so its total is determinable from the fixtures — the RUN-suffixed
    // site code is unique to this run and only deviceA carries it, so
    // site A has EXACTLY one interface (the previously unasserted total is
    // now pinned) and it can never be smaller than the visible rows.
    const scoped = await interfacesListRequest(await adminJwt([SITE_A_CODE]));
    expect(scoped.status).toBe(200);
    const scopedBody = (await scoped.json()) as {
      data?: { rows?: Array<{ deviceId: string }>; summary?: { total: number } };
    };
    expect(scopedBody.data?.summary?.total).toBeGreaterThanOrEqual((scopedBody.data?.rows ?? []).length);
    expect(scopedBody.data?.summary?.total).toBe(1);

    // The summary block shares the scoped where — its total counts only
    // in-scope rows for a deny-all scope (bounded assertion: the fixture
    // interfaces never appear).
    const denyAll = await interfacesListRequest(await adminJwt([]));
    expect(denyAll.status).toBe(200);
    const body = (await denyAll.json()) as {
      data?: { rows?: Array<{ deviceId: string }>; summary?: { total: number } };
    };
    expect(
      (body.data?.rows ?? []).filter((r) => r.deviceId === deviceAId || r.deviceId === deviceBId).length
    ).toBe(0);
    // Wave-7: the summary rides the SAME scoped where — for a deny-all
    // scope (`site.code IN ()`) it matches NOTHING, so the previously
    // vacuous `>= 0` pin is upgraded to the exact zero.
    expect(body.data?.summary?.total).toBe(0);
  });

  test("deny-all scope sees NEITHER fixture interface", async () => {
    expect(await fixtureRows(await adminJwt([]))).toEqual([]);
  });
});

/* ── mutation plane — PATCH device detail ─────────────────────────────── */

describe("F-031 device domain — PATCH /api/v1/devices/[id] scope gates", () => {
  test("wildcard admin PATCH still succeeds (byte-unchanged mutation path)", async () => {
    const res = await patchDeviceRequest(await adminJwt(), deviceAId, { notes: `b25w2 wildcard probe ${RUN}` });
    expect(res.status).toBe(200);
    const body = (await envelope(res)) as { data?: { hostname?: string } };
    expect(body.data?.hostname).toBe(HOST_A);
  });

  test("sites-limited session: in-scope PATCH succeeds", async () => {
    const res = await patchDeviceRequest(await adminJwt([SITE_A_CODE]), deviceAId, {
      notes: `b25w2 in-scope probe ${RUN}`,
    });
    expect(res.status).toBe(200);
  });

  test("sites-limited session PATCHing an out-of-scope device → 403 SITE_SCOPE_FORBIDDEN", async () => {
    const res = await patchDeviceRequest(await adminJwt([SITE_A_CODE]), deviceBId, {
      notes: "should never land",
    });
    expect(res.status).toBe(403);
    expect((await envelope(res)).error?.code).toBe("SITE_SCOPE_FORBIDDEN");
    // Nothing was written.
    const after = await db.device.findUnique({ where: { id: deviceBId }, select: { notes: true } });
    expect(after?.notes).toBeNull();
  });

  test("repointing a device at an out-of-scope site → 403 (the target-site gate)", async () => {
    const res = await patchDeviceRequest(await adminJwt([SITE_A_CODE]), deviceAId, { siteId: siteBId });
    expect(res.status).toBe(403);
    expect((await envelope(res)).error?.code).toBe("SITE_SCOPE_FORBIDDEN");
    // The device did not move.
    const after = await db.device.findUnique({ where: { id: deviceAId }, select: { siteId: true } });
    expect(after?.siteId).toBe(siteAId);
  });

  test("deny-all scope cannot PATCH even the in-scope-fixture device (fail-closed)", async () => {
    const res = await patchDeviceRequest(await adminJwt([]), deviceAId, { notes: "deny-all probe" });
    expect(res.status).toBe(403);
    expect((await envelope(res)).error?.code).toBe("SITE_SCOPE_FORBIDDEN");
  });
});

/* ── mutation plane — POST device create ──────────────────────────────── */

describe("F-031 device domain — POST /api/v1/devices scope gate", () => {
  test("sites-limited session creating IN scope succeeds (201) and the device is real", async () => {
    const res = await postDeviceRequest(await adminJwt([SITE_A_CODE]), {
      hostname: POST_HOST,
      vendorId,
      mgmtIp: "192.0.2.45",
      siteId: siteAId,
    });
    expect(res.status).toBe(201);
    const body = (await envelope(res)) as { data?: { device?: { id?: string; site?: { code?: string } } } };
    const createdId = body.data?.device?.id ?? "";
    expect(createdId.length).toBeGreaterThan(0);
    postCreatedDeviceId = createdId;
    const row = await db.device.findUnique({ where: { id: createdId }, select: { siteId: true } });
    expect(row?.siteId).toBe(siteAId);
  });

  test("sites-limited session creating OUT of scope → 403 SITE_SCOPE_FORBIDDEN, nothing written", async () => {
    const res = await postDeviceRequest(await adminJwt([SITE_A_CODE]), {
      hostname: `${POST_HOST}-x`,
      vendorId,
      mgmtIp: "192.0.2.46",
      siteId: siteBId,
    });
    expect(res.status).toBe(403);
    expect((await envelope(res)).error?.code).toBe("SITE_SCOPE_FORBIDDEN");
    const row = await db.device.findUnique({ where: { hostname: `${POST_HOST}-x` }, select: { id: true } });
    expect(row).toBeNull();
  });

  test("deny-all scope cannot create a device anywhere (fail-closed)", async () => {
    const res = await postDeviceRequest(await adminJwt([]), {
      hostname: `${POST_HOST}-y`,
      vendorId,
      mgmtIp: "192.0.2.47",
      siteId: siteAId,
    });
    expect(res.status).toBe(403);
    expect((await envelope(res)).error?.code).toBe("SITE_SCOPE_FORBIDDEN");
  });
});

/* ── wave-7 — malformed claim is deny-all on BOTH planes ─────────────── */

describe("F-031 wave-7 — malformed site-scope claim is deny-all on BOTH planes", () => {
  test("malformed claim (sites: string) hides the device on the READ plane (alerts → 404 DEVICE_NOT_FOUND)", async () => {
    const res = await detailRequest("alerts", await adminJwt("BAD"), deviceAId);
    expect(res.status).toBe(404);
    expect((await envelope(res)).error?.code).toBe("DEVICE_NOT_FOUND");
  });

  test("malformed claim (sites: string) refuses the MUTATION plane (PATCH → 403 SITE_SCOPE_FORBIDDEN)", async () => {
    const res = await patchDeviceRequest(await adminJwt("BAD"), deviceAId, {
      notes: "malformed claim probe",
    });
    expect(res.status).toBe(403);
    expect((await envelope(res)).error?.code).toBe("SITE_SCOPE_FORBIDDEN");
    const after = await db.device.findUnique({ where: { id: deviceAId }, select: { notes: true } });
    expect(after?.notes).not.toBe("malformed claim probe");
  });
});

/* ── wave-7 — PATCH siteId:null (detach) gate ─────────────────────────── */

describe("F-031 wave-7 — PATCH siteId:null (detach) gate", () => {
  test("sites-limited session cannot detach (403 SITE_SCOPE_FORBIDDEN, siteId unchanged)", async () => {
    const res = await patchDeviceRequest(await adminJwt([SITE_A_CODE]), deviceAId, { siteId: null });
    expect(res.status).toBe(403);
    expect((await envelope(res)).error?.code).toBe("SITE_SCOPE_FORBIDDEN");
    const after = await db.device.findUnique({ where: { id: deviceAId }, select: { siteId: true } });
    expect(after?.siteId).toBe(siteAId);
  });

  test("deny-all scope cannot detach either (fail-closed)", async () => {
    const res = await patchDeviceRequest(await adminJwt([]), deviceAId, { siteId: null });
    expect(res.status).toBe(403);
    expect((await envelope(res)).error?.code).toBe("SITE_SCOPE_FORBIDDEN");
    const after = await db.device.findUnique({ where: { id: deviceAId }, select: { siteId: true } });
    expect(after?.siteId).toBe(siteAId);
  });

  test("wildcard session detaches and re-attaches (byte-unchanged behavior)", async () => {
    const detach = await patchDeviceRequest(await adminJwt(), deviceAId, { siteId: null });
    expect(detach.status).toBe(200);
    const after = await db.device.findUnique({ where: { id: deviceAId }, select: { siteId: true } });
    expect(after?.siteId).toBeNull();

    // Restore the fixture binding (the earlier tests pin deviceA at site A).
    const reattach = await patchDeviceRequest(await adminJwt(), deviceAId, { siteId: siteAId });
    expect(reattach.status).toBe(200);
    const restored = await db.device.findUnique({ where: { id: deviceAId }, select: { siteId: true } });
    expect(restored?.siteId).toBe(siteAId);
  });
});

/* ── wave-7 — site-less devices (the unscoped-resource rules) ─────────── */

describe("F-031 wave-7 — site-less devices (unscoped-resource rules)", () => {
  test("sites-limited session: GET detail of a site-less device → 404 (row-level hidden); wildcard still 200", async () => {
    const scoped = await deviceDetailRequest(await adminJwt([SITE_A_CODE]), deviceCId);
    expect(scoped.status).toBe(404);
    expect((await envelope(scoped)).error?.code).toBe("DEVICE_NOT_FOUND");

    const wildcard = await deviceDetailRequest(await adminJwt(), deviceCId);
    expect(wildcard.status).toBe(200);
    expect((await envelope(wildcard)).success).toBe(true);
  });

  test("sites-limited session: PATCH without siteId on a site-less device → 2xx (unscoped-resource mutation bypass)", async () => {
    const res = await patchDeviceRequest(await adminJwt([SITE_A_CODE]), deviceCId, {
      displayName: `b25w2 siteless patch ${RUN}`,
    });
    expect(res.status).toBe(200);
    const body = (await envelope(res)) as { data?: { displayName?: string } };
    expect(body.data?.displayName).toBe(`b25w2 siteless patch ${RUN}`);
  });

  test("sites-limited session: POST /api/v1/devices WITHOUT siteId → 201 and the row carries a null site", async () => {
    const hostname = `${POST_HOST}-nosite`;
    const res = await postDeviceRequest(await adminJwt([SITE_A_CODE]), {
      hostname,
      vendorId,
      mgmtIp: "192.0.2.49",
    });
    expect(res.status).toBe(201);
    const body = (await envelope(res)) as { data?: { device?: { id?: string } } };
    const createdId = body.data?.device?.id ?? "";
    expect(createdId.length).toBeGreaterThan(0);
    postNoSiteDeviceId = createdId;
    const row = await db.device.findUnique({ where: { id: createdId }, select: { siteId: true } });
    expect(row?.siteId).toBeNull();
  });
});

/* ── source pins — the migration is structural, not incidental ────────── */

describe("F-031 device domain — source pins (single-sourced primitives)", () => {
  test("every migrated sub-resource route composes sessionAllowsSite over the device row", async () => {
    const { readFileSync } = await import("node:fs");
    for (const sub of SUB_RESOURCE_ROUTES) {
      const src = readFileSync(
        new URL(`../../src/app/api/v1/devices/[id]/${sub}/route.ts`, import.meta.url),
        "utf8"
      );
      expect(src).toContain('from "@/lib/auth/scope"');
      expect(src).toContain("sessionScopeFor(request)");
      expect(src).toContain("sessionAllowsSite(scopeClaims, device.site?.code ?? null)");
      // The gate is fused with the not-found branch — no unguarded path.
      expect(src).toContain("!device || !sessionAllowsSite");
    }
  });

  test("the fleet interfaces list composes scopedDeviceWhere (no hand-rolled scope filter)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../src/app/api/v1/interfaces/route.ts", import.meta.url), "utf8");
    expect(src).toContain("scopedDeviceWhere(scopeClaims, deviceWhere)");
    expect(src).toContain("sessionSiteScope(scopeClaims)");
  });

  test("both device mutation routes gate through requireSiteScope", async () => {
    const { readFileSync } = await import("node:fs");
    const detail = readFileSync(new URL("../../src/app/api/v1/devices/[id]/route.ts", import.meta.url), "utf8");
    const root = readFileSync(new URL("../../src/app/api/v1/devices/route.ts", import.meta.url), "utf8");
    expect(detail).toContain("requireSiteScope(request, current.site?.code ?? null)");
    // The PATCH repoint target is gated too.
    expect(detail).toContain("requireSiteScope(request, site.code)");
    expect(root).toContain("requireSiteScope(request, site.code)");
  });
});
