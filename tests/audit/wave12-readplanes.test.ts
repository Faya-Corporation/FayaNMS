/**
 * Wave-12 read planes — F-031 scope migration (audit 18-a P2-1/P2-2).
 *
 * The wave-12 audit found two F-031 read-plane members the wave-9/10
 * assignment split silently skipped (neither was in any agent's surface
 * list nor in the matrix's migrated/"Remaining" lists):
 *
 *   FLOWS           GET /api/v1/flows?deviceId=… fetched the device with a
 *                   raw findUnique and gated NOTHING — hostname/mgmtIp/
 *                   status/site of out-of-scope devices leaked to
 *                   sites-limited sessions with an existence oracle
 *                   (unknown id 404 vs out-of-scope 200). Fix = the
 *                   devices/[id] fused-404 recipe: sessionScopeFor +
 *                   sessionAllowsSite → the SAME DEVICE_NOT_FOUND
 *                   envelope for unknown ≡ out-of-scope ≡ site-less.
 *   BACKUP REPORT   GET /api/v1/compliance/backup ran an unscoped
 *                   managed-fleet findMany + a global site catalog scan —
 *                   per-device hostnames (staleDevices top-10), fleet
 *                   KPIs and perSite bands described the WHOLE fleet.
 *                   Fix = the wave-10 drift F-4 recipe: scopedDeviceWhere
 *                   over the single device fetch, rows/KPIs/perSite/
 *                   staleDevices derive from the SCOPED rows, the per-site
 *                   catalog scan intersects the scope codes (cmdb/items
 *                   exemplar), snapshotsLast24h fuses through the
 *                   snapshot's device relation.
 *
 * Pins (certified batch-25/wave-9 rig — REAL next-auth JWTs from the
 * production `encode`, RUN-suffixed fixtures, surgical afterAll cleanup):
 *
 *   BEHAVIORAL   flows: out-of-scope 404 envelope-identical to unknown id
 *                (only the caller-echoed id differs — the message is a
 *                pure function of the request, no extra information);
 *                in-scope 200 with hostname/mgmtIp; site-less device
 *                fused-404 for scoped sessions; wildcard parity (both
 *                fixture devices render with full identity, unknown 404).
 *   BEHAVIORAL   compliance/backup: sites-limited session sees ONLY its
 *                site (perSite exactly 1 row, staleDevices scoped, KPIs =
 *                the DB-counted scoped reality, zero out-of-scope
 *                hostnames/site codes anywhere); deny-all (sites: []) →
 *                200 with zeroed KPIs and empty rows/perSite/staleDevices
 *                (the plane convention); wildcard → the full fleet
 *                (managedDevices = the unscoped DB count, Unassigned row
 *                present, both fixture sites banded).
 *   SOURCE       both routes import + compose sessionScopeFor; flows fuses
 *                the 404 gate in ONE condition; backup's ONLY db.device
 *                call is the scopedDeviceWhere-composed findMany.
 *
 * Fixtures use TEST-NET-1 documentation IPs (192.0.2.x) and w12r- RUN
 * hostnames — no collision with the seeded fleet or other suites.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";

import { db } from "../../src/lib/db";

/* ── fixtures (RUN-suffixed — parallel-safe, re-runnable) ─────────────── */

const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
const PREFIX = `w12r-`;
const ORG_NAME = `${PREFIX}org-${RUN}`;
const SITE_A_CODE = `W12A-${RUN}`; // the scoped session's site
const SITE_B_CODE = `W12B-${RUN}`; // out of scope for the scoped session
const VENDOR_KEY = `${PREFIX}vendor-${RUN}`;
const HOST_A = `${PREFIX}dev-a-${RUN.toLowerCase()}`; // site A (in scope)
const HOST_B = `${PREFIX}dev-b-${RUN.toLowerCase()}`; // site B (out of scope)
const HOST_C = `${PREFIX}dev-c-${RUN.toLowerCase()}`; // site-less
const ADMIN_EMAIL = `${PREFIX}admin-${RUN.toLowerCase()}@faya.local`;
const UNKNOWN_ID = `${PREFIX}unknown-${RUN.toLowerCase()}`;

const testStartedAt = new Date();

let orgId = "";
let siteAId = "";
let siteBId = "";
let vendorId = "";
let deviceAId = "";
let deviceBId = "";
let deviceCId = "";
let adminId = "";

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
    name: "W12 Read Planes Admin",
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

type Envelope = {
  success?: boolean;
  data?: unknown;
  meta?: Record<string, unknown>;
  error?: { code?: string; message?: string };
};

async function importHandler(
  relPath: string,
  verb: "GET"
): Promise<(req: Request, ctx?: unknown) => Promise<Response>> {
  const mod = (await import(relPath)) as Record<
    string,
    (req: Request, ctx?: unknown) => Promise<Response>
  >;
  return mod[verb];
}

beforeAll(async () => {
  const admin = await db.user.create({
    data: { email: ADMIN_EMAIL, name: "W12 Read Planes Admin", role: "admin", isActive: true },
    select: { id: true },
  });
  adminId = admin.id;

  const org = await db.organization.create({ data: { name: ORG_NAME } });
  orgId = org.id;
  const siteA = await db.site.create({
    data: { name: `W12 Site A ${RUN}`, code: SITE_A_CODE, organizationId: orgId },
  });
  siteAId = siteA.id;
  const siteB = await db.site.create({
    data: { name: `W12 Site B ${RUN}`, code: SITE_B_CODE, organizationId: orgId },
  });
  siteBId = siteB.id;

  const vendor = await db.vendor.create({
    data: { key: VENDOR_KEY, name: `W12 Read Planes Vendor ${RUN}`, adapterKey: "generic" },
  });
  vendorId = vendor.id;

  const devA = await db.device.create({
    data: {
      hostname: HOST_A,
      mgmtIp: "192.0.2.121",
      vendorId,
      siteId: siteAId,
      status: "ONLINE",
    },
  });
  deviceAId = devA.id;
  const devB = await db.device.create({
    data: {
      hostname: HOST_B,
      mgmtIp: "192.0.2.122",
      vendorId,
      siteId: siteBId,
      status: "ONLINE",
    },
  });
  deviceBId = devB.id;
  // Site-less managed device: hidden from sites-limited sessions by the
  // row-level relation semantics (fail-closed parity with SQL), visible to
  // wildcard sessions in the "Unassigned" perSite band.
  const devC = await db.device.create({
    data: {
      hostname: HOST_C,
      mgmtIp: "192.0.2.123",
      vendorId,
      status: "ONLINE",
    },
  });
  deviceCId = devC.id;

  expect(adminId.length).toBeGreaterThan(0);
  expect(deviceCId.length).toBeGreaterThan(0);
});

afterAll(async () => {
  // Surgical cleanup in FK order — every fixture row this suite created,
  // nothing else (no snapshots/events/policies were created here).
  await db.device.deleteMany({
    where: { id: { in: [deviceAId, deviceBId, deviceCId].filter(Boolean) } },
  });
  await db.vendor.deleteMany({ where: { id: vendorId } });
  await db.site.deleteMany({ where: { id: { in: [siteAId, siteBId].filter(Boolean) } } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.user.deleteMany({ where: { id: { in: adminId ? [adminId] : [] } } });
});

/* ── (F-1) flows: fused-404 read plane ────────────────────────────────── */

describe("wave12 read planes: GET /api/v1/flows (P2-1 fused-404)", () => {
  /**
   * The route's existing 404 message echoes the caller-supplied id — that
   * echo is a pure function of the REQUEST, not leaked data. Normalize it
   * away so "byte-identical envelope" compares the stable shape: status,
   * success flag, error.code and the message TEMPLATE.
   */
  function fused404Shape(body: Envelope, requestedId: string): string {
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe("DEVICE_NOT_FOUND");
    expect(typeof body.meta?.requestId).toBe("string");
    expect(Object.keys(body).sort()).toEqual(["error", "meta", "success"]);
    return (body.error?.message ?? "").replace(requestedId, "<id>");
  }

  test("sites-limited session: out-of-scope deviceId answers the SAME 404 envelope as an unknown id", async () => {
    const GET = await importHandler("../../src/app/api/v1/flows/route", "GET");
    const jwt = await adminJwt([SITE_A_CODE]);

    const oosRes = await GET(
      getRequest(`http://app.local/api/v1/flows?deviceId=${deviceBId}`, jwt)
    );
    expect(oosRes.status).toBe(404);
    const oosBody = (await oosRes.json()) as Envelope;

    const unknownRes = await GET(
      getRequest(`http://app.local/api/v1/flows?deviceId=${UNKNOWN_ID}`, jwt)
    );
    expect(unknownRes.status).toBe(404);
    const unknownBody = (await unknownRes.json()) as Envelope;

    // Byte-identical modulo the per-request meta.requestId and the echoed
    // caller id — no existence oracle (the device exists; the 404 is scope).
    expect(fused404Shape(oosBody, deviceBId)).toBe(
      fused404Shape(unknownBody, UNKNOWN_ID)
    );
    // And the response leaks none of the out-of-scope device identity.
    const oosText = JSON.stringify(oosBody);
    expect(oosText).not.toContain(HOST_B);
    expect(oosText).not.toContain("192.0.2.");
    expect(await db.device.count({ where: { id: deviceBId } })).toBe(1);
  });

  test("sites-limited session: in-scope device → 200 with hostname/mgmtIp (all fields preserved)", async () => {
    const GET = await importHandler("../../src/app/api/v1/flows/route", "GET");
    const res = await GET(
      getRequest(`http://app.local/api/v1/flows?deviceId=${deviceAId}`, await adminJwt([SITE_A_CODE]))
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.success).toBe(true);
    const device = (body.data as { device: Record<string, unknown> }).device;
    expect(device.id).toBe(deviceAId);
    expect(device.hostname).toBe(HOST_A);
    expect(device.mgmtIp).toBe("192.0.2.121");
    expect(device.status).toBe("ONLINE");
    expect(device.siteCode).toBe(SITE_A_CODE);
    // The simulated analytics legs are intact for in-scope hits.
    expect((body.data as Record<string, unknown>).totals).toBeDefined();
    expect((body.data as Record<string, unknown>).topTalkers).toBeDefined();
  });

  test("sites-limited session: site-less device → the SAME fused 404 (row-level fail-closed)", async () => {
    const GET = await importHandler("../../src/app/api/v1/flows/route", "GET");
    const jwt = await adminJwt([SITE_A_CODE]);

    const sitelessRes = await GET(
      getRequest(`http://app.local/api/v1/flows?deviceId=${deviceCId}`, jwt)
    );
    expect(sitelessRes.status).toBe(404);
    const sitelessBody = (await sitelessRes.json()) as Envelope;

    const unknownRes = await GET(
      getRequest(`http://app.local/api/v1/flows?deviceId=${UNKNOWN_ID}`, jwt)
    );
    const unknownBody = (await unknownRes.json()) as Envelope;

    expect(fused404Shape(sitelessBody, deviceCId)).toBe(
      fused404Shape(unknownBody, UNKNOWN_ID)
    );
  });

  test("wildcard parity: the out-of-scope-for-scoped device renders with full identity; unknown still 404s", async () => {
    const GET = await importHandler("../../src/app/api/v1/flows/route", "GET");
    const jwt = await adminJwt(); // no sites claim → wildcard

    const res = await GET(
      getRequest(`http://app.local/api/v1/flows?deviceId=${deviceBId}`, jwt)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const device = (body.data as { device: Record<string, unknown> }).device;
    expect(device.hostname).toBe(HOST_B);
    expect(device.mgmtIp).toBe("192.0.2.122");
    expect(device.siteCode).toBe(SITE_B_CODE);
    expect(device.siteName).toBe(`W12 Site B ${RUN}`);

    const unknownRes = await GET(
      getRequest(`http://app.local/api/v1/flows?deviceId=${UNKNOWN_ID}`, jwt)
    );
    expect(unknownRes.status).toBe(404);
    const unknownBody = (await unknownRes.json()) as Envelope;
    expect(unknownBody.error?.code).toBe("DEVICE_NOT_FOUND");
  });
});

/* ── (F-2) compliance/backup: scoped fleet report ─────────────────────── */

type BackupData = {
  kpis: {
    managedDevices: number;
    compliant: number;
    atRisk: number;
    nonCompliant: number;
    compliantPct: number;
    snapshotsLast24h: number;
  };
  perSite: Array<{
    siteId: string | null;
    siteName: string;
    siteCode: string | null;
    managed: number;
    compliant: number;
    atRisk: number;
    nonCompliant: number;
    compliantPct: number | null;
  }>;
  staleDevices: Array<{
    deviceId: string;
    hostname: string;
    siteName: string | null;
    siteCode: string | null;
    lastBackupAt: string | null;
    band: string;
  }>;
  bands: { compliantWindowHours: number; atRiskWindowHours: number; note: string };
};

describe("wave12 read planes: GET /api/v1/compliance/backup (P2-2 scoped fleet)", () => {
  test("sites-limited session: report describes ONLY the scoped site — no out-of-scope hostnames or site codes", async () => {
    const GET = await importHandler(
      "../../src/app/api/v1/compliance/backup/route",
      "GET"
    );
    const res = await GET(
      getRequest("http://app.local/api/v1/compliance/backup", await adminJwt([SITE_A_CODE]))
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.success).toBe(true);
    const data = body.data as BackupData;

    // KPIs match the SCOPED DB reality: only deviceA (site A, managed,
    // never backed up) is in scope. deviceB (site B) and the site-less
    // deviceC are both outside the row-level relation filter.
    const scopedCount = await db.device.count({
      where: { status: { not: "UNMANAGED" }, site: { code: SITE_A_CODE } },
    });
    expect(scopedCount).toBe(1);
    expect(data.kpis.managedDevices).toBe(scopedCount);
    expect(data.kpis.compliant).toBe(0);
    expect(data.kpis.atRisk).toBe(0);
    expect(data.kpis.nonCompliant).toBe(1);
    expect(data.kpis.compliantPct).toBe(0);

    // perSite bands: exactly the in-scope site row.
    expect(data.perSite).toHaveLength(1);
    expect(data.perSite[0].siteCode).toBe(SITE_A_CODE);
    expect(data.perSite[0].managed).toBe(1);
    expect(data.perSite[0].nonCompliant).toBe(1);

    // staleDevices top-10: only the in-scope stale device.
    expect(data.staleDevices).toHaveLength(1);
    expect(data.staleDevices[0].hostname).toBe(HOST_A);
    expect(data.staleDevices[0].siteCode).toBe(SITE_A_CODE);
    expect(data.staleDevices[0].band).toBe("NEVER_BACKED_UP");

    // Zero out-of-scope identity anywhere in the payload.
    const text = JSON.stringify(body);
    expect(text).not.toContain(HOST_B);
    expect(text).not.toContain(HOST_C);
    expect(text).not.toContain(SITE_B_CODE);
    expect(text).not.toContain("192.0.2.122");
    expect(text).not.toContain("192.0.2.123");
  });

  test("deny-all (sites: []) → 200 with zeroed KPIs and empty rows/perSite/staleDevices", async () => {
    const GET = await importHandler(
      "../../src/app/api/v1/compliance/backup/route",
      "GET"
    );
    const res = await GET(
      getRequest("http://app.local/api/v1/compliance/backup", await adminJwt([]))
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.success).toBe(true);
    const data = body.data as BackupData;

    expect(data.kpis.managedDevices).toBe(0);
    expect(data.kpis.compliant).toBe(0);
    expect(data.kpis.atRisk).toBe(0);
    expect(data.kpis.nonCompliant).toBe(0);
    expect(data.kpis.compliantPct).toBe(0);
    // snapshotsLast24h is scope-fused through the device relation too —
    // a deny-all scope counts nothing even though recent fleet snapshots
    // (other suites' fixtures) exist in the shared DB.
    expect(data.kpis.snapshotsLast24h).toBe(0);
    expect(data.perSite).toEqual([]);
    expect(data.staleDevices).toEqual([]);
    // The static bands note is shape-stable.
    expect(data.bands.compliantWindowHours).toBe(24);
    expect(data.bands.atRiskWindowHours).toBe(72);
  });

  test("wildcard parity: the FULL fleet — KPIs equal the unscoped DB count, both fixture sites + Unassigned banded", async () => {
    const GET = await importHandler(
      "../../src/app/api/v1/compliance/backup/route",
      "GET"
    );
    // Count the unscoped managed fleet immediately around the call so a
    // concurrent fixture from another suite cannot skew the parity pin.
    const expectedManaged = await db.device.count({
      where: { status: { not: "UNMANAGED" } },
    });
    const res = await GET(
      getRequest("http://app.local/api/v1/compliance/backup", await adminJwt())
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const data = body.data as BackupData;

    expect(data.kpis.managedDevices).toBe(expectedManaged);
    expect(expectedManaged).toBeGreaterThanOrEqual(3);
    // Internal band consistency survives the migration.
    expect(data.kpis.compliant + data.kpis.atRisk + data.kpis.nonCompliant).toBe(
      data.kpis.managedDevices
    );

    // Both fixture sites are banded for wildcard sessions…
    const codes = data.perSite.map((row) => row.siteCode);
    expect(codes).toContain(SITE_A_CODE);
    expect(codes).toContain(SITE_B_CODE);
    // …and the site-less fixture device lands in the Unassigned band.
    const unassigned = data.perSite.find((row) => row.siteId === null);
    expect(unassigned).toBeDefined();
    expect(unassigned?.managed).toBeGreaterThanOrEqual(1);

    expect(Array.isArray(data.staleDevices)).toBe(true);
    expect(data.staleDevices.length).toBeLessThanOrEqual(10);
  });
});

/* ── source-text pins (the wave-12 differential pins) ─────────────────── */

describe("wave12 read planes: source contract (differential pins)", () => {
  test("both migrated routes compose the canonical F-031 primitives; no raw unscoped device reads remain", async () => {
    const { readFileSync } = await import("node:fs");

    // P2-1: flows resolves the session scope and fuses the 404 gate in ONE
    // condition (unknown ≡ out-of-scope ≡ site-less → DEVICE_NOT_FOUND).
    const flows = readFileSync("src/app/api/v1/flows/route.ts", "utf8");
    expect(flows).toContain("sessionScopeFor(request)");
    expect(flows).toContain("sessionAllowsSite(scopeClaims, device.site?.code ?? null)");
    expect(flows).toMatch(/if \(!device \|\| !sessionAllowsSite\(/);

    // P2-2: backup resolves the scope, composes scopedDeviceWhere into the
    // device fetch, intersects the per-site catalog with the scope codes,
    // and fuses the snapshot count through the device relation.
    const backup = readFileSync("src/app/api/v1/compliance/backup/route.ts", "utf8");
    expect(backup).toContain("sessionScopeFor(request)");
    expect(backup).toContain("scopedDeviceWhere(scopeClaims");
    expect(backup).toMatch(/db\.device\.findMany\(\{\s*where:\s*scopedDeviceWhere\(scopeClaims/);
    expect(backup).toContain("code: { in: scope.codes }");
    expect(backup).toContain("{ device: scopedDeviceWhere(scopeClaims, {}) }");

    // The handler body has NO other db.device access — every row/KPI/band
    // derives from the single scoped findMany (no raw unscoped reads).
    const backupDeviceCalls = backup.match(/db\.device\.\w+/g) ?? [];
    expect(backupDeviceCalls).toEqual(["db.device.findMany"]);
  });
});
