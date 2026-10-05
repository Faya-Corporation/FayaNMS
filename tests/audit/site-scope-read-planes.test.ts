/**
 * F-031 site-scope wave 9 — the READ-PLANE migration (the derivative planes
 * outside the device domain, which waves 2+7 had left behind).
 *
 * Wave 9 composed the same two central primitives into every fleet-wide read
 * surface the wave-9 audit (Task 9-c) flagged. This suite pins the landed
 * behavior with the certified batch-25/wave-7 rig (REAL next-auth JWTs from
 * the production `encode`, RUN-suffixed fixtures, surgical afterAll cleanup):
 *
 *   GLOBAL SNAPSHOTS  GET /api/v1/snapshots composes scopedDeviceWhere through
 *                     the device relation — ?deviceId=<out-of-scope> yields the
 *                     SAME 200 + empty-list envelope as ?deviceId=<unknown>
 *                     (no existence leak; the fleet-level bypass that defeated
 *                     the wave-7 fused-404 gates is closed). Wildcard parity.
 *   SEARCH            GET /api/v1/search scopes the device leg (hostname/
 *                     displayName/mgmtIp) — no mgmtIp leak across scope.
 *   PERFORMANCE       GET /api/v1/performance/devices — the caller's
 *                     ?siteCode= INTERSECTS the session scope instead of
 *                     overriding it (out-of-scope site → 200 + zero rows;
 *                     wildcard keeps the plain site filter).
 *   CMDB              GET /api/v1/cmdb/items — CI visibility rides the
 *                     LINKAGE (linked device's site, else the siteId tag,
 *                     else global), and the owner fallback label is the
 *                     email LOCAL-PART (R69/F-029 discipline — never the
 *                     full address, even for a name-less owner).
 *   MUTATION GATES    POST /api/v1/baselines and POST /api/v1/maintenance
 *                     resolve the referenced device and answer 403
 *                     SITE_SCOPE_FORBIDDEN for out-of-scope targets before
 *                     any write; the same request as wildcard succeeds.
 *   EXPORT HYGIENE    artifactToCsv neutralizes spreadsheet formula
 *                     prefixes (=, +, -, @, tab) with the OWASP leading-'
 *                     guard while plain numbers and clean cells stay
 *                     byte-unchanged.
 *   PAGE CAP          paginationSchema refuses page > 1000 (deep-pagination
 *                     abuse bound) with the shared INVALID_QUERY envelope.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";
import { createHash } from "node:crypto";

import { db } from "../../src/lib/db";
import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";
import { paginationSchema } from "../../src/app/api/v1/_lib/api";
import { artifactToCsv } from "../../src/lib/reports/generate";

/* ── fixtures (RUN-suffixed — parallel-safe, re-runnable) ─────────────── */

const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
const PREFIX = `w9rp-`;
const ORG_NAME = `${PREFIX}org-${RUN}`;
const SITE_A_CODE = `W9A-${RUN}`; // the scoped session's site
const SITE_B_CODE = `W9B-${RUN}`; // out of scope for the scoped session
const VENDOR_KEY = `${PREFIX}vendor-${RUN}`;
const HOST_A = `${PREFIX}dev-a-${RUN.toLowerCase()}`; // site A
const HOST_B = `${PREFIX}dev-b-${RUN.toLowerCase()}`; // site B
const IP_A = `192.0.2.1${(parseInt(RUN.slice(0, 2), 36) % 40) + 30}`;
const IP_B = `192.0.2.1${(parseInt(RUN.slice(2, 4), 36) % 40) + 70}`;
const UNKNOWN_DEVICE_ID = `${PREFIX}unknown-${RUN.toLowerCase()}`;
const ADMIN_EMAIL = `${PREFIX}admin-${RUN.toLowerCase()}@faya.local`;
const OWNER_EMAIL = `${PREFIX}owner-${RUN.toLowerCase()}@faya.local`;
const CI_LINKED_B_NAME = `${PREFIX}ci-linked-b-${RUN.toLowerCase()}`;
const CI_GLOBAL_NAME = `${PREFIX}ci-global-${RUN.toLowerCase()}`;
const MW_NAME = `${PREFIX}mw-${RUN.toLowerCase()}`;

const RAW_A = `hostname ${HOST_A}\ninterface Gi0/1\n switchport mode access\n`;
const SHA_A = createHash("sha256").update(RAW_A).digest("hex");
const RAW_B = `hostname ${HOST_B}\ninterface Gi0/2\n switchport mode trunk\n`;
const SHA_B = createHash("sha256").update(RAW_B).digest("hex");

const testStartedAt = new Date();

let orgId = "";
let siteAId = "";
let siteBId = "";
let vendorId = "";
let deviceAId = "";
let deviceBId = "";
let snapAId = "";
let snapBId = "";
let adminId = "";
let ownerId = "";
let ciLinkedBId = "";
let ciGlobalId = "";
const createdBaselineIds: string[] = [];

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
    name: "W9 Read-Plane Admin",
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

function postRequest(url: string, jwt: string, body: unknown): NextRequest {
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
  const mod = (await import(relPath)) as { GET: (req: Request) => Promise<Response> };
  return mod.GET;
}

async function importPost(relPath: string) {
  const mod = (await import(relPath)) as { POST: (req: Request) => Promise<Response> };
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
    data: { email: ADMIN_EMAIL, name: "W9 Read-Plane Admin", role: "admin", isActive: true },
    select: { id: true },
  });
  adminId = admin.id;

  // The name-less owner fixture (cmdb owner-label pin): the fallback must be
  // the email LOCAL-PART, not the full address.
  const owner = await db.user.create({
    data: { email: OWNER_EMAIL, name: null, role: "viewer", isActive: true },
    select: { id: true },
  });
  ownerId = owner.id;

  const org = await db.organization.create({ data: { name: ORG_NAME } });
  orgId = org.id;
  const siteA = await db.site.create({
    data: { name: `W9 Site A ${RUN}`, code: SITE_A_CODE, organizationId: orgId },
  });
  siteAId = siteA.id;
  const siteB = await db.site.create({
    data: { name: `W9 Site B ${RUN}`, code: SITE_B_CODE, organizationId: orgId },
  });
  siteBId = siteB.id;

  const vendor = await db.vendor.create({
    data: { key: VENDOR_KEY, name: `W9 Read-Plane Vendor ${RUN}`, adapterKey: "generic" },
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

  // Legacy plaintext snapshots (encKeyId=null rows need no crypto env) —
  // one per device so the global snapshots list and the baselines POST have
  // real rows to (not) see.
  const snapA = await db.configSnapshot.create({
    data: {
      deviceId: deviceAId,
      version: 1,
      rawText: RAW_A,
      sha256: SHA_A,
      sizeBytes: RAW_A.length,
      status: "HISTORICAL",
    },
  });
  snapAId = snapA.id;
  const snapB = await db.configSnapshot.create({
    data: {
      deviceId: deviceBId,
      version: 1,
      rawText: RAW_B,
      sha256: SHA_B,
      sizeBytes: RAW_B.length,
      status: "HISTORICAL",
    },
  });
  snapBId = snapB.id;

  // 1H CPU rollups inside the 24H window so performance/devices renders a
  // row per device (rows without rollup coverage are skipped by the route).
  const hourMs = 3_600_000;
  const base = Math.floor(Date.now() / hourMs) * hourMs;
  for (const [deviceId, value] of [
    [deviceAId, 11.5],
    [deviceBId, 42.5],
  ] as const) {
    for (let k = 1; k <= 3; k += 1) {
      await db.metricRollup.create({
        data: {
          deviceId,
          metric: "CPU",
          granularity: "1H",
          periodStart: new Date(base - k * hourMs),
          avg: value + k,
          max: value + k + 5,
          min: value - 1,
          p95: value + k + 3,
        },
      });
    }
  }

  // CmdbItem fixtures: one device-linked CI (linkage = site B → hidden from
  // the scoped session) and one linkage-less CI (a GLOBAL resource — visible
  // to every session — owned by the name-less user for the label pin).
  const ciLinkedB = await db.cmdbItem.create({
    data: {
      ciId: `CI-9${RUN.slice(0, 5)}`,
      name: CI_LINKED_B_NAME,
      ciType: "device",
      deviceId: deviceBId,
    },
  });
  ciLinkedBId = ciLinkedB.id;
  const ciGlobal = await db.cmdbItem.create({
    data: {
      ciId: `CI-8${RUN.slice(0, 5)}`,
      name: CI_GLOBAL_NAME,
      ciType: "service",
      ownerId,
    },
  });
  ciGlobalId = ciGlobal.id;

  expect(adminId.length).toBeGreaterThan(0);
  expect(snapAId.length).toBeGreaterThan(0);
});

afterAll(async () => {
  // Surgical cleanup in FK order — every fixture row this suite created,
  // nothing else.
  if (createdBaselineIds.length > 0) {
    await db.auditEvent.deleteMany({
      where: {
        action: "BASELINE_APPROVED",
        resourceType: "ConfigBaseline",
        resourceId: { in: createdBaselineIds },
        createdAt: { gte: testStartedAt },
      },
    });
    await db.configBaseline.deleteMany({ where: { id: { in: createdBaselineIds } } });
  }
  // The 403 gates must have written nothing — defensively sweep this run's
  // unique names anyway (the RUN prefix makes the rows unambiguous).
  await db.maintenanceWindow.deleteMany({ where: { name: MW_NAME } });
  await db.cmdbItem.deleteMany({ where: { id: { in: [ciLinkedBId, ciGlobalId].filter(Boolean) } } });
  await db.device.deleteMany({ where: { id: { in: [deviceAId, deviceBId].filter(Boolean) } } });
  await db.vendor.deleteMany({ where: { id: vendorId } });
  await db.site.deleteMany({ where: { id: { in: [siteAId, siteBId].filter(Boolean) } } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.user.deleteMany({ where: { id: { in: [adminId, ownerId].filter(Boolean) } } });
});

/* ── (a) global snapshots list — the fleet-level bypass is closed ─────── */

describe("wave9 read planes: GET /api/v1/snapshots (global list)", () => {
  test("sites-limited session: ?deviceId=<out-of-scope> and ?deviceId=<unknown> get the SAME empty envelope", async () => {
    const GET = await importGet("../../src/app/api/v1/snapshots/route");
    const jwt = await adminJwt([SITE_A_CODE]);

    const outOfScopeRes = await GET(
      getRequest(`http://app.local/api/v1/snapshots?deviceId=${deviceBId}`, jwt)
    );
    expect(outOfScopeRes.status).toBe(200);
    const outOfScope = (await outOfScopeRes.json()) as Envelope;

    const unknownRes = await GET(
      getRequest(`http://app.local/api/v1/snapshots?deviceId=${UNKNOWN_DEVICE_ID}`, jwt)
    );
    expect(unknownRes.status).toBe(200);
    const unknown = (await unknownRes.json()) as Envelope;

    // Identical envelope SHAPE (byte-different only in the random requestId):
    // no existence leak — an out-of-scope id is indistinguishable from a
    // missing one on the fleet list.
    expect(outOfScope.success).toBe(true);
    expect(unknown.success).toBe(true);
    expect(outOfScope.data).toEqual([]);
    expect(unknown.data).toEqual([]);
    expect(outOfScope.meta?.total).toBe(0);
    expect(unknown.meta?.total).toBe(0);
    expect(Object.keys(outOfScope).sort()).toEqual(Object.keys(unknown).sort());
    expect(Object.keys(outOfScope.meta ?? {}).sort()).toEqual(
      Object.keys(unknown.meta ?? {}).sort()
    );
    // And the snapshot exists — the emptiness is the scope, not the data.
    expect(await db.configSnapshot.count({ where: { deviceId: deviceBId } })).toBe(1);
  });

  test("wildcard parity: the same ?deviceId= filter sees the real fixture (200, one row)", async () => {
    const GET = await importGet("../../src/app/api/v1/snapshots/route");
    const res = await GET(
      getRequest(`http://app.local/api/v1/snapshots?deviceId=${deviceBId}`, await adminJwt())
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.success).toBe(true);
    const rows = body.data as Array<{ deviceId: string; hostname: string; siteCode: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deviceId).toBe(deviceBId);
    expect(rows[0]?.hostname).toBe(HOST_B);
    expect(rows[0]?.siteCode).toBe(SITE_B_CODE);
  });
});

/* ── (b) search — no cross-scope device hit (mgmtIp included) ─────────── */

describe("wave9 read planes: GET /api/v1/search (device leg)", () => {
  test("sites-limited session: the out-of-scope device is absent by hostname AND by mgmtIp", async () => {
    const GET = await importGet("../../src/app/api/v1/search/route");
    const jwt = await adminJwt([SITE_A_CODE]);

    const byHost = (await (
      await GET(getRequest(`http://app.local/api/v1/search?q=${HOST_B}`, jwt))
    ).json()) as Envelope;
    let devices = (byHost.data as { devices: Array<{ id: string }> }).devices;
    expect(devices.some((d) => d.id === deviceBId)).toBe(false);

    // The mgmtIp leg must not leak either (audit 9-c F-2's sharpest detail).
    const byIp = (await (
      await GET(getRequest(`http://app.local/api/v1/search?q=${IP_B}`, jwt))
    ).json()) as Envelope;
    devices = (byIp.data as { devices: Array<{ id: string }> }).devices;
    expect(devices.some((d) => d.id === deviceBId)).toBe(false);

    // Sanity: the same session still finds its OWN device.
    const own = (await (
      await GET(getRequest(`http://app.local/api/v1/search?q=${HOST_A}`, jwt))
    ).json()) as Envelope;
    expect((own.data as { devices: Array<{ id: string }> }).devices.some((d) => d.id === deviceAId)).toBe(true);
  });

  test("wildcard parity: the same queries DO hit the out-of-scope device (the gate is scope-driven)", async () => {
    const GET = await importGet("../../src/app/api/v1/search/route");
    const jwt = await adminJwt();

    const byHost = (await (
      await GET(getRequest(`http://app.local/api/v1/search?q=${HOST_B}`, jwt))
    ).json()) as Envelope;
    const devices = (byHost.data as { devices: Array<{ id: string; mgmtIp: string }> }).devices;
    const hit = devices.find((d) => d.id === deviceBId);
    expect(hit).toBeTruthy();
    expect(hit?.mgmtIp).toBe(IP_B);
  });
});

/* ── (c) performance/devices — siteCode ∩ session scope ───────────────── */

describe("wave9 read planes: GET /api/v1/performance/devices (?siteCode=)", () => {
  test("sites-limited session + ?siteCode=<out-of-scope> → 200 with zero rows (intersection, not override)", async () => {
    const GET = await importGet("../../src/app/api/v1/performance/devices/route");
    const res = await GET(
      getRequest(
        `http://app.local/api/v1/performance/devices?metric=CPU&range=24H&siteCode=${encodeURIComponent(SITE_B_CODE)}`,
        await adminJwt([SITE_A_CODE])
      )
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.success).toBe(true);
    expect((body.data as { rows: unknown[] }).rows).toEqual([]);
    expect((body.meta as { total: number }).total).toBe(0);
  });

  test("wildcard + the same ?siteCode= → the fixture device's row (parity: the caller filter still works)", async () => {
    const GET = await importGet("../../src/app/api/v1/performance/devices/route");
    const res = await GET(
      getRequest(
        `http://app.local/api/v1/performance/devices?metric=CPU&range=24H&siteCode=${encodeURIComponent(SITE_B_CODE)}`,
        await adminJwt()
      )
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const rows = (body.data as { rows: Array<{ deviceId: string; hostname: string; siteCode: string | null; latest: { value: number; ts: string } }> }).rows;
    const row = rows.find((r) => r.deviceId === deviceBId);
    expect(row).toBeTruthy();
    expect(row?.hostname).toBe(HOST_B);
    expect(row?.siteCode).toBe(SITE_B_CODE);
    expect((row?.latest as { value: number }).value).toBeGreaterThan(0);
  });
});

/* ── (d) cmdb items — linkage scoping + local-part owner label ────────── */

describe("wave9 read planes: GET /api/v1/cmdb/items (linkage + owner label)", () => {
  test("owner with a null name renders as the email LOCAL-PART only (never the full address)", async () => {
    const GET = await importGet("../../src/app/api/v1/cmdb/items/route");
    const res = await GET(
      getRequest("http://app.local/api/v1/cmdb/items", await adminJwt())
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const items = (body.data as { items: Array<{ id: string; ownerId: string | null; ownerName: string | null }> }).items;
    const mine = items.find((i) => i.id === ciGlobalId);
    expect(mine).toBeTruthy();
    expect(mine?.ownerId).toBe(ownerId);
    expect(mine?.ownerName).toBe(OWNER_EMAIL.split("@")[0]);
    expect(mine?.ownerName).not.toContain("@");
  });

  test("sites-limited session: the site-B-linked CI is hidden, the linkage-less CI stays visible (global edge); wildcard sees both", async () => {
    const GET = await importGet("../../src/app/api/v1/cmdb/items/route");
    const scoped = (await (
      await GET(getRequest(`http://app.local/api/v1/cmdb/items?q=${PREFIX}`, await adminJwt([SITE_A_CODE])))
    ).json()) as Envelope;
    const scopedIds = (scoped.data as { items: Array<{ id: string }> }).items.map((i) => i.id);
    expect(scopedIds).toContain(ciGlobalId); // no linkage → global resource
    expect(scopedIds).not.toContain(ciLinkedBId); // linked device out of scope

    const wildcard = (await (
      await GET(getRequest(`http://app.local/api/v1/cmdb/items?q=${PREFIX}`, await adminJwt()))
    ).json()) as Envelope;
    const wildcardIds = (wildcard.data as { items: Array<{ id: string }> }).items.map((i) => i.id);
    expect(wildcardIds).toContain(ciGlobalId);
    expect(wildcardIds).toContain(ciLinkedBId);
  });
});

/* ── (e) mutation gates — baselines/maintenance POST on out-of-scope ──── */

describe("wave9 read planes: the baselines/maintenance POST scope gates", () => {
  test("sites-limited session: POST /api/v1/baselines for an out-of-scope device → 403 SITE_SCOPE_FORBIDDEN, nothing written", async () => {
    const POST = await importPost("../../src/app/api/v1/baselines/route");
    const res = await POST(
      postRequest("http://app.local/api/v1/baselines", await adminJwt([SITE_A_CODE]), {
        deviceId: deviceBId,
        snapshotId: snapBId,
        note: "w9rp should never land",
      })
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as Envelope;
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe("SITE_SCOPE_FORBIDDEN");
    expect(body.error?.message).toContain(SITE_B_CODE);
    // Nothing was written: no baseline row, no snapshot promotion.
    expect(await db.configBaseline.count({ where: { deviceId: deviceBId } })).toBe(0);
    expect((await db.configSnapshot.findUnique({ where: { id: snapBId } }))?.status).toBe("HISTORICAL");
  });

  test("wildcard: the SAME baselines request succeeds (201 + BASELINE_APPROVED audit contract)", async () => {
    const POST = await importPost("../../src/app/api/v1/baselines/route");
    const res = await POST(
      postRequest("http://app.local/api/v1/baselines", await adminJwt(), {
        deviceId: deviceBId,
        snapshotId: snapBId,
      })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Envelope;
    const data = body.data as {
      baseline: { id: string; deviceId: string; snapshotId: string };
      version: number;
      snapshotStatus: string;
      audit: { action: string; correlationId: string };
    };
    expect(data.baseline.deviceId).toBe(deviceBId);
    expect(data.baseline.snapshotId).toBe(snapBId);
    expect(data.version).toBe(1);
    expect(data.snapshotStatus).toBe("BASELINE"); // promoted from HISTORICAL
    expect(data.audit.action).toBe("BASELINE_APPROVED");
    createdBaselineIds.push(data.baseline.id);
  });

  test("sites-limited session: POST /api/v1/maintenance for an out-of-scope device → 403, no window row", async () => {
    const POST = await importPost("../../src/app/api/v1/maintenance/route");
    const startsAt = new Date(Date.now() + 3600_000).toISOString();
    const endsAt = new Date(Date.now() + 7200_000).toISOString();
    const res = await POST(
      postRequest("http://app.local/api/v1/maintenance", await adminJwt([SITE_A_CODE]), {
        name: MW_NAME,
        deviceId: deviceBId,
        startsAt,
        endsAt,
        reason: "w9rp should never land",
      })
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as Envelope;
    expect(body.error?.code).toBe("SITE_SCOPE_FORBIDDEN");
    expect(await db.maintenanceWindow.count({ where: { name: MW_NAME } })).toBe(0);
  });
});

/* ── (e2) cmdb-create device-reference scope gate (orchestrator add) ──── */

describe("wave9 read planes: the cmdb-create device-reference scope gate", () => {
  test("sites-limited session: POST /api/v1/cmdb/items referencing an out-of-scope device → 422 UNKNOWN_DEVICE, nothing written", async () => {
    const POST = await importPost("../../src/app/api/v1/cmdb/items/route");
    const res = await POST(
      postRequest("http://app.local/api/v1/cmdb/items", await adminJwt([SITE_A_CODE]), {
        name: `W9RP-CMDB-GATE-${RUN}`,
        ciType: "device",
        deviceId: deviceBId,
      })
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as Envelope;
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe("UNKNOWN_DEVICE");
    expect(body.error?.message).toContain("does not exist");
    // Nothing written: the gated reference never becomes a CI.
    expect(
      await db.cmdbItem.count({ where: { name: `W9RP-CMDB-GATE-${RUN}` } })
    ).toBe(0);
  });

  test("wildcard: the SAME reference resolves (409 already-mapped — deviceB carries ciLinkedB; existence visible, gate is scope-only)", async () => {
    const POST = await importPost("../../src/app/api/v1/cmdb/items/route");
    const res = await POST(
      postRequest("http://app.local/api/v1/cmdb/items", await adminJwt(), {
        name: `W9RP-CMDB-GATE-WC-${RUN}`,
        ciType: "device",
        deviceId: deviceBId,
      })
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as Envelope;
    expect(body.error?.code).toBe("CMDB_DEVICE_ALREADY_MAPPED");
    expect(
      await db.cmdbItem.count({ where: { name: `W9RP-CMDB-GATE-WC-${RUN}` } })
    ).toBe(0);
  });
});

/* ── (f) artifactToCsv — formula-injection neutralization ─────────────── */

describe("wave9 read planes: artifactToCsv formula neutralization", () => {
  const csvFor = (cells: Array<string | number | null>): string =>
    artifactToCsv({
      reportType: "TEST",
      generatedAt: new Date().toISOString(),
      range: "24H",
      format: "CSV",
      columns: [{ key: "c", label: "Cell" }],
      rows: cells.map((c) => ({ c })),
    });
  const csvLines = (csv: string): string[] =>
    csv.replace(/\r\n$/, "").split("\r\n");

  test("formula-prefixed cells get the leading-' guard (…=HYPERLINK, +cmd, @x, tab); cells never start with a formula", () => {
    const csv = csvFor([
      "=HYPERLINK(\"http://evil.example\",\"click\")",
      "+cmd",
      "@x",
      "\tpayload",
      "-2abc",
    ]);
    const lines = csvLines(csv);
    // Header + one single-column line per cell (data rows carry no label).
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe("Cell");
    expect(lines[1]).toContain("'=HYPERLINK");
    expect(lines[1]).toContain("http://evil.example"); // CSV-quoted, still the guarded text
    expect(lines[2]).toBe("'+cmd");
    expect(lines[3]).toBe("'@x");
    expect(lines[4]).toBe("'\tpayload");
    expect(lines[5]).toBe("'-2abc"); // '-' prefix but NOT a plain number
    // No data cell begins with a spreadsheet-dangerous character any more.
    for (const line of lines.slice(1)) {
      expect(/^[=+\-@\t]/.test(line)).toBe(false);
    }
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  test("clean cells and PLAIN NUMBERS are byte-unchanged (the guard must not corrupt legit exports)", () => {
    const csv = csvFor(["plain", "-2", "-2.5", "+42", "1.5", "", null]);
    const lines = csvLines(csv);
    expect(lines).toHaveLength(8);
    expect(lines[1]).toBe("plain");
    expect(lines[2]).toBe("-2"); // signed number exempt
    expect(lines[3]).toBe("-2.5"); // signed decimal exempt
    expect(lines[4]).toBe("+42"); // signed number exempt
    expect(lines[5]).toBe("1.5");
    expect(lines[6]).toBe(""); // empty cell → empty value
    expect(lines[7]).toBe(""); // null cell → empty value
    expect(csv).not.toContain("'");
  });
});

/* ── (g) pagination page cap — the shared schema's refusal ────────────── */

describe("wave9 read planes: pagination page cap", () => {
  test("unit: paginationSchema refuses page=1001 and still accepts page=1000", () => {
    expect(paginationSchema.shape.page.safeParse("1001").success).toBe(false);
    expect(paginationSchema.shape.page.safeParse("1000").success).toBe(true);
    expect(paginationSchema.shape.page.safeParse("1").success).toBe(true);
    expect(paginationSchema.shape.page.safeParse("0").success).toBe(false);
    expect(paginationSchema.safeParse({}).success).toBe(true); // defaults intact
  });

  test("behavioral: a paginated route answers the shared INVALID_QUERY 400 for ?page=1001", async () => {
    const GET = await importGet("../../src/app/api/v1/snapshots/route");
    const res = await GET(
      getRequest("http://app.local/api/v1/snapshots?page=1001", await adminJwt())
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Envelope;
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe("INVALID_QUERY");
    expect(body.error?.message).toContain("page");
  });
});
