/**
 * Ingest + ZTP wave-9 hardening (audit 9-b fixes, fix agent 10-b-2), pinned
 * with the batch-25 certified rig (REAL next-auth JWTs from the production
 * `encode`, synthetic w9ing-<rand> fixtures only, surgical afterAll cleanup):
 *
 *   P2 (9-b F-2)  GET /api/v1/ztp/claims is SITE-SCOPED (F-031): a
 *                 sites-limited session sees NO out-of-scope claim, device
 *                 enrichment, catalog site or ZTP audit row (history is
 *                 scoped by the claim its rows belong to — all three ZTP
 *                 writers stamp resourceType "ZtpClaim" + claim id);
 *                 wildcard sessions stay byte-identical on the fixtures.
 *   P3 (9-b F-2)  csv-import / ztp/claims / discovery/import no longer
 *                 surface the Device.hostname @unique (ZtpClaim.serial)
 *                 concurrent-race P2002 as raw 500s: csv-import and
 *                 discovery/import replay the batch row-by-row and skip the
 *                 raced row with the route's row-skip vocabulary;
 *                 ztp/claims answers the SAME 409 ZTP_CLAIM_EXISTS envelope
 *                 its duplicate guard produces.
 *   P3 (9-b F-3)  discovery/import re-validates PTR-controlled candidate
 *                 hostnames with csv-import's EXACT hostname policy (regex
 *                 + 63-char cap) and caps modelGuess at 120 — invalid
 *                 candidates skip per-row, valid rows persist.
 *   P3 (9-b F-4)  the devices-view CSV exporter neutralizes formula
 *                 injection (leading = + - @ get the OWASP `'` guard, the
 *                 reports-exporter standard); clean cells byte-identical.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { db } from "../../src/lib/db";
import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";

/* ── fixtures + certified mint rig (batch-25 / site-scope-wave7 pattern) ── */

const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
const P = "w9ing-";
const ORG_NAME = `${P}org-${RUN}`;
const SITE_C_CODE = `W9C-${RUN}`; // the limited session's ONLY site
const SITE_D_CODE = `W9D-${RUN}`; // out of scope for the limited session
const HOST_C = `${P}dev-c-${RUN.toLowerCase()}`; // provisioned device, site C
const HOST_D = `${P}dev-d-${RUN.toLowerCase()}`; // provisioned device, site D
const SERIAL_C = `W9ING-${RUN}-C`; // claim at site C (in scope)
const SERIAL_D = `W9ING-${RUN}-D`; // claim at site D (out of scope)
const SERIAL_SEQ = `W9ING-${RUN}-S`; // sequential duplicate-claim POST
const SERIAL_RACE = `W9ING-${RUN}-R`; // concurrent duplicate-claim POST
const VENDOR_KEY = `w9ing-vg-${RUN.toLowerCase()}`;
const ADMIN_EMAIL = `${P}admin-${RUN.toLowerCase()}@faya.local`;
const HOST_C_LONG = `${P}csv-pre-existing-${RUN.toLowerCase()}`;

const testStartedAt = new Date();

let orgId = "";
let siteCId = "";
let siteDId = "";
let vendorId = "";
let deviceCId = "";
let deviceDId = "";
let adminId = "";
let discoveryJobId = "";
let claimCId = "";
let claimDId = "";
let auditCId = "";
let auditDId = "";
let ciscoVendorOwnedBySuite = false;
const createdClaimIds: string[] = [];
const createdJobIds: string[] = []; // ZTP_PROVISION jobs enqueued by POSTs
const createdDeviceIds: string[] = [];

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
    name: "W9 Ingest Hardening Admin",
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
    data: { email: ADMIN_EMAIL, name: "W9 Ingest Hardening Admin", role: "admin", isActive: true },
    select: { id: true },
  });
  adminId = admin.id;

  const org = await db.organization.create({ data: { name: ORG_NAME } });
  orgId = org.id;
  const siteC = await db.site.create({
    data: { name: `W9 Site C ${RUN}`, code: SITE_C_CODE, organizationId: orgId },
  });
  siteCId = siteC.id;
  const siteD = await db.site.create({
    data: { name: `W9 Site D ${RUN}`, code: SITE_D_CODE, organizationId: orgId },
  });
  siteDId = siteD.id;

  const vendor = await db.vendor.create({
    data: { key: VENDOR_KEY, name: `W9 Ingest Vendor ${RUN}`, adapterKey: "generic" },
  });
  vendorId = vendor.id;

  // POST /ztp/claims validates vendorKey against the in-code template
  // catalog (cisco-ztp provisions the seeded "cisco" vendor). Ensure the
  // row the catalog names exists WITHOUT touching it if the seed already
  // made it (the same ensure-don't-modify pattern batch-25 uses).
  const cisco = await db.vendor.findUnique({ where: { key: "cisco" } });
  if (!cisco) {
    await db.vendor.create({
      data: { key: "cisco", name: `W9 Cisco Placeholder ${RUN}`, adapterKey: "generic" },
    });
    ciscoVendorOwnedBySuite = true;
  }

  const devC = await db.device.create({
    data: { hostname: HOST_C, mgmtIp: "192.0.2.141", vendorId, siteId: siteCId, status: "ONLINE" },
  });
  deviceCId = devC.id;
  const devD = await db.device.create({
    data: { hostname: HOST_D, mgmtIp: "192.0.2.142", vendorId, siteId: siteDId, status: "ONLINE" },
  });
  deviceDId = devD.id;
  // A pre-existing device for the csv-import duplicate-row pin.
  const devPre = await db.device.create({
    data: {
      hostname: HOST_C_LONG,
      mgmtIp: "192.0.2.143",
      vendorId,
      siteId: siteCId,
      status: "ONLINE",
    },
  });
  createdDeviceIds.push(devPre.id);

  // Provisioned claims: site C (in scope) and site D (out of scope).
  const claimC = await db.ztpClaim.create({
    data: {
      serial: SERIAL_C,
      hostname: HOST_C,
      vendorKey: VENDOR_KEY,
      model: "W9 Hardening Model",
      templateId: "w9ing-test",
      siteId: siteCId,
      deviceId: deviceCId,
      status: "provisioned",
    },
  });
  claimCId = claimC.id;
  const claimD = await db.ztpClaim.create({
    data: {
      serial: SERIAL_D,
      hostname: HOST_D,
      vendorKey: VENDOR_KEY,
      model: "W9 Hardening Model",
      templateId: "w9ing-test",
      siteId: siteDId,
      deviceId: deviceDId,
      status: "provisioned",
    },
  });
  claimDId = claimD.id;

  // ZTP audit history rows (the shape every ZTP writer produces:
  // resourceType "ZtpClaim" + resourceId = claim id).
  const auditC = await db.auditEvent.create({
    data: {
      actorId: adminId,
      actorName: "w9ing-suite",
      action: "ZTP_CLAIM_CREATED",
      resourceType: "ZtpClaim",
      resourceId: claimCId,
      resourceLabel: `${HOST_C} (${SERIAL_C})`,
      result: "SUCCESS",
      correlationId: `COR-W9ING-C-${RUN}`,
    },
  });
  auditCId = auditC.id;
  const auditD = await db.auditEvent.create({
    data: {
      actorId: adminId,
      actorName: "w9ing-suite",
      action: "ZTP_CLAIM_CREATED",
      resourceType: "ZtpClaim",
      resourceId: claimDId,
      resourceLabel: `${HOST_D} (${SERIAL_D})`,
      result: "SUCCESS",
      correlationId: `COR-W9ING-D-${RUN}`,
    },
  });
  auditDId = auditD.id;

  // A DISCOVERY job whose candidates carry PTR-controlled hostnames: a
  // 64-char label (over the 63 cap) and a dotted reverse-DNS name, plus
  // one valid candidate (vendorGuess = this suite's vendor key).
  const job = await db.jobExecution.create({
    data: {
      type: "DISCOVERY",
      status: "SUCCEEDED",
      correlationId: `JOB-W9ING-${RUN}`,
      resultJson: JSON.stringify({
        candidates: [
          { ip: "192.0.2.151", hostname: "a".repeat(64), vendorGuess: VENDOR_KEY, modelGuess: "W9 Model" },
          { ip: "192.0.2.152", hostname: `${P}disc-ok-${RUN.toLowerCase()}`, vendorGuess: VENDOR_KEY, modelGuess: "W9 Model" },
          { ip: "192.0.2.153", hostname: "ptr-1-2-3-4.spoke.example.com", vendorGuess: VENDOR_KEY, modelGuess: "W9 Model" },
        ],
      }),
    },
  });
  discoveryJobId = job.id;

  expect(adminId.length).toBeGreaterThan(0);
});

afterAll(async () => {
  // Surgical cleanup in FK order — every fixture row this suite created,
  // nothing else (the shared "cisco" vendor row is deleted ONLY when this
  // suite created it; a seeded row is left exactly as found). The
  // hostname-prefixed device sweep also reclaims any row the live worker
  // provisioned from this suite's ZTP_PROVISION jobs before cleanup ran.
  await db.auditEvent.deleteMany({
    where: {
      OR: [
        { id: { in: [auditCId, auditDId].filter(Boolean) } },
        {
          resourceType: "ZtpClaim",
          resourceId: { in: createdClaimIds.concat(claimCId, claimDId).filter(Boolean) },
          createdAt: { gte: testStartedAt },
        },
        {
          resourceType: "Device",
          resourceId: { in: createdDeviceIds },
          createdAt: { gte: testStartedAt },
        },
      ],
    },
  });
  await db.jobExecution.deleteMany({ where: { id: { in: createdJobIds.concat(discoveryJobId).filter(Boolean) } } });
  await db.device.deleteMany({
    where: { hostname: { startsWith: P }, createdAt: { gte: testStartedAt } },
  });
  await db.ztpClaim.deleteMany({
    where: { id: { in: createdClaimIds.concat(claimCId, claimDId).filter(Boolean) } },
  });
  if (ciscoVendorOwnedBySuite) {
    await db.vendor.deleteMany({ where: { key: "cisco" } });
  }
  await db.vendor.deleteMany({ where: { id: vendorId } });
  await db.site.deleteMany({ where: { id: { in: [siteCId, siteDId].filter(Boolean) } } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.user.deleteMany({ where: { id: adminId } });
});

/* ── part 1 — GET /api/v1/ztp/claims site scoping (P2 F-2) ─────────────── */

async function ztpGet(jwt: string): Promise<Response> {
  const { GET } = (await import("../../src/app/api/v1/ztp/claims/route")) as {
    GET: (req: Request) => Promise<Response>;
  };
  return GET(getRequest("http://app.local/api/v1/ztp/claims", jwt));
}

type ZtpGetBody = {
  data?: {
    claims: {
      serial: string;
      siteCode: string | null;
      deviceHostname: string | null;
      mgmtIp: string | null;
    }[];
    sites: { code: string }[];
    counts: { total: number };
    history: { correlationId: string | null }[];
  };
};

describe("wave9: GET /ztp/claims is site-scoped (F-031)", () => {
  test("a sites-limited session sees NO out-of-scope claim, enrichment, catalog site or audit row", async () => {
    const res = await ztpGet(await adminJwt([SITE_C_CODE]));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ZtpGetBody;
    const data = body.data!;

    // Claims: the in-scope claim with its device enrichment; the
    // out-of-scope claim is indistinguishable from nonexistent.
    const serials = data.claims.map((c) => c.serial);
    expect(serials).toContain(SERIAL_C);
    expect(serials).not.toContain(SERIAL_D);
    const inScope = data.claims.find((c) => c.serial === SERIAL_C)!;
    expect(inScope.deviceHostname).toBe(HOST_C);
    expect(inScope.siteCode).toBe(SITE_C_CODE);
    expect(data.counts.total).toBe(1); // only the in-scope claim survives

    // Catalog: only the session's own sites (order/code-asc preserved).
    const codes = data.sites.map((s) => s.code);
    expect(codes).toContain(SITE_C_CODE);
    expect(codes).not.toContain(SITE_D_CODE);

    // History: the ZTP audit rows of the session's claims only.
    const correlations = data.history.map((h) => h.correlationId);
    expect(correlations).toContain(`COR-W9ING-C-${RUN}`);
    expect(correlations).not.toContain(`COR-W9ING-D-${RUN}`);
  });

  test("wildcard parity: the same fixtures are all visible, enrichment unchanged", async () => {
    const res = await ztpGet(await adminJwt()); // no sites claim → wildcard
    expect(res.status).toBe(200);
    const body = (await res.json()) as ZtpGetBody;
    const data = body.data!;
    const serials = data.claims.map((c) => c.serial);
    expect(serials).toContain(SERIAL_C);
    expect(serials).toContain(SERIAL_D);
    const outScope = data.claims.find((c) => c.serial === SERIAL_D)!;
    expect(outScope.deviceHostname).toBe(HOST_D);
    expect(outScope.siteCode).toBe(SITE_D_CODE);
    const codes = data.sites.map((s) => s.code);
    expect(codes).toContain(SITE_C_CODE);
    expect(codes).toContain(SITE_D_CODE);
    const correlations = data.history.map((h) => h.correlationId);
    expect(correlations).toContain(`COR-W9ING-C-${RUN}`);
    expect(correlations).toContain(`COR-W9ING-D-${RUN}`);
  });

  test("SOURCE PIN: the GET composes the central scope primitives", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../src/app/api/v1/ztp/claims/route.ts"),
      "utf8"
    );
    expect(src).toContain("scopedDeviceWhere(scopeClaims");
    expect(src).toContain("siteScopeAllows(scope, siteCode)");
    expect(src).toContain("siteScopeAllows(scope, s.code)");
    // The session-read posture is kept and its rationale documented.
    expect(src).toContain("requireSessionRead(request)");
    expect(src).toContain('NO "ztp.read"');
  });
});

/* ── part 2 — csv-import duplicate handling (P3 F-2) ───────────────────── */

describe("wave9: csv-import duplicate rows skip per-row (never 500)", () => {
  async function csvImport(jwt: string, rows: unknown[]): Promise<{
    status: number;
    body: { data?: { created: number; devices: { id: string }[]; skipped: { ip: string; reason: string }[] } };
  }> {
    const { POST } = (await import("../../src/app/api/v1/devices/csv-import/route")) as {
      POST: (req: Request) => Promise<Response>;
    };
    const res = await POST(
      postRequest("http://app.local/api/v1/devices/csv-import", jwt, { rows })
    );
    return { status: res.status, body: (await res.json()) as never };
  }

  test("a pre-existing hostname SKIPS with the route's row shape; the clean row still imports", async () => {
    const okHost = `${P}csv-ok-${RUN.toLowerCase()}`;
    const { status, body } = await csvImport(await adminJwt(), [
      { hostname: HOST_C_LONG, vendor: VENDOR_KEY, mgmtIp: "192.0.2.161", siteCode: SITE_C_CODE },
      { hostname: okHost, vendor: VENDOR_KEY, mgmtIp: "192.0.2.162", siteCode: SITE_C_CODE },
    ]);
    expect(status).toBe(200); // per-row semantics — the request did NOT abort
    const data = body.data!;
    expect(data.created).toBe(1);
    expect(data.devices[0]!.id).toBeTruthy();
    createdDeviceIds.push(data.devices[0]!.id);
    expect(data.skipped.length).toBe(1);
    expect(data.skipped[0]!.ip).toBe("192.0.2.161");
    expect(data.skipped[0]!.reason).toBe("duplicate");
  });

  test("concurrent same-hostname imports → exactly one winner; losers skip (no 500)", async () => {
    const raceHost = `${P}csv-race-${RUN.toLowerCase()}`;
    const jwt = await adminJwt();
    const row = [{ hostname: raceHost, vendor: VENDOR_KEY, mgmtIp: "192.0.2.163", siteCode: SITE_C_CODE }];
    const results = await Promise.all([
      csvImport(jwt, row),
      csvImport(jwt, row),
      csvImport(jwt, row),
    ]);
    // Every request answers the normal envelope — a lost race is a skip,
    // never a raw 500.
    for (const { status } of results) expect(status).toBe(200);
    const totalCreated = results.reduce((n, r) => n + (r.body.data?.created ?? 0), 0);
    expect(totalCreated).toBe(1);
    for (const { body } of results) {
      if ((body.data?.created ?? 0) > 0) continue;
      for (const skip of body.data!.skipped) {
        // Either the pre-load caught it ("duplicate") or the P2002 replay
        // path did ("DUPLICATE_HOSTNAME: …") — both are row skips.
        expect(skip.reason === "duplicate" || skip.reason.includes("DUPLICATE_HOSTNAME")).toBe(true);
      }
      expect(body.data!.skipped.length).toBeGreaterThanOrEqual(1);
    }
    expect(await db.device.count({ where: { hostname: raceHost } })).toBe(1);
    const winner = await db.device.findUnique({ where: { hostname: raceHost }, select: { id: true } });
    if (winner) createdDeviceIds.push(winner.id);
  });

  test("SOURCE PIN: the P2002 race replays per-row instead of erroring", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../src/app/api/v1/devices/csv-import/route.ts"),
      "utf8"
    );
    expect(src).toContain("PrismaClientKnownRequestError");
    expect(src).toContain('error.code === "P2002"');
    expect(src).toContain("created.length = 0"); // the replay resets created[]
    expect(src).toContain("DUPLICATE_HOSTNAME:");
  });
});

/* ── part 3 — ztp/claims duplicate envelope (P3 F-2) ───────────────────── */

describe("wave9: duplicate ztp claims answer 409 ZTP_CLAIM_EXISTS (never 500)", () => {
  const URL = "http://app.local/api/v1/ztp/claims";
  const claimBody = (serial: string) => ({
    serial,
    hostname: `${P}ztp-${RUN.toLowerCase()}`,
    vendorKey: "cisco",
    model: "W9 Hardening Model",
    templateId: "cisco-ztp",
    siteId: siteCId,
  });

  async function postClaim(serial: string): Promise<{
    status: number;
    body: {
      success?: boolean;
      data?: { claim: { id: string }; jobId: string };
      error?: { code: string; message: string };
    };
  }> {
    const { POST } = (await import("../../src/app/api/v1/ztp/claims/route")) as {
      POST: (req: Request) => Promise<Response>;
    };
    const res = await POST(postRequest(URL, await adminJwt(), claimBody(serial)));
    return { status: res.status, body: (await res.json()) as never };
  }

  test("repeating a serial: the first POST enqueues, the repeat 409s with the guard's envelope", async () => {
    const first = await postClaim(SERIAL_SEQ);
    expect(first.status).toBe(200);
    createdClaimIds.push(first.body.data!.claim.id);
    createdJobIds.push(first.body.data!.jobId);
    // Deny the live worker the QUEUED job so the claim stays pending for
    // the duplicate probe (the worker would provision it mid-test).
    await db.jobExecution.deleteMany({
      where: { id: first.body.data!.jobId, status: "QUEUED" },
    });

    const second = await postClaim(SERIAL_SEQ);
    expect(second.status).toBe(409);
    expect(second.body.error?.code).toBe("ZTP_CLAIM_EXISTS");
    expect(second.body.error?.message).toContain(SERIAL_SEQ);
    expect(await db.ztpClaim.count({ where: { serial: SERIAL_SEQ } })).toBe(1);
  });

  test("concurrent same-serial POSTs → exactly one 200, one 409 ZTP_CLAIM_EXISTS", async () => {
    const results = await Promise.all([postClaim(SERIAL_RACE), postClaim(SERIAL_RACE)]);
    const statuses = results.map((r) => r.status).sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);
    for (const { body } of results) {
      if (body.success) {
        createdClaimIds.push(body.data!.claim.id);
        createdJobIds.push(body.data!.jobId);
      } else {
        // Whether the loser hit the duplicate guard or the P2002 catch,
        // the envelope is the SAME 409 ZTP_CLAIM_EXISTS.
        expect(body.error?.code).toBe("ZTP_CLAIM_EXISTS");
      }
    }
    expect(await db.ztpClaim.count({ where: { serial: SERIAL_RACE } })).toBe(1);
  });
});

/* ── part 4 — discovery/import hostname re-validation (P3 F-3) ─────────── */

describe("wave9: discovery/import re-validates PTR-controlled hostnames", () => {
  test("over-long and dotted PTR hostnames skip; the valid candidate persists + is flagged", async () => {
    const { POST } = (await import("../../src/app/api/v1/discovery/import/route")) as {
      POST: (req: Request) => Promise<Response>;
    };
    const res = await POST(
      postRequest("http://app.local/api/v1/discovery/import", await adminJwt(), {
        jobId: discoveryJobId,
        ips: ["192.0.2.151", "192.0.2.152", "192.0.2.153"],
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data?: {
        created: number;
        devices: { id: string; hostname: string }[];
        skipped: { ip: string; reason: string }[];
      };
    };
    const data = body.data!;
    // Only the valid candidate became a device.
    expect(data.created).toBe(1);
    expect(data.devices[0]!.hostname).toBe(`${P}disc-ok-${RUN.toLowerCase()}`);
    createdDeviceIds.push(data.devices[0]!.id);

    const reasonByIp = new Map(data.skipped.map((s) => [s.ip, s.reason]));
    expect(reasonByIp.get("192.0.2.151")).toContain("hostname"); // 64 chars
    expect(reasonByIp.get("192.0.2.153")).toContain("hostname"); // dotted PTR
    // DB truth: the hostile hostnames were never persisted.
    expect(await db.device.count({ where: { hostname: "a".repeat(64) } })).toBe(0);
    expect(await db.device.count({ where: { hostname: "ptr-1-2-3-4.spoke.example.com" } })).toBe(0);

    // The job's resultJson flags ONLY what actually persisted.
    const job = await db.jobExecution.findUnique({ where: { id: discoveryJobId } });
    const result = JSON.parse(job!.resultJson!) as {
      candidates: { ip: string; imported?: boolean }[];
      importedIps: string[];
    };
    expect(result.candidates.find((c) => c.ip === "192.0.2.152")?.imported).toBe(true);
    expect(result.candidates.find((c) => c.ip === "192.0.2.151")?.imported).toBeUndefined();
    expect(result.candidates.find((c) => c.ip === "192.0.2.153")?.imported).toBeUndefined();
    expect(result.importedIps).toEqual(["192.0.2.152"]);
  });
});

/* ── part 5 — devices-view csvEscape formula neutralization (P3 F-4) ───── */

describe("wave9: the devices-view csvEscape neutralizes spreadsheet formula injection", () => {
  const viewSrc = readFileSync(
    join(import.meta.dir, "../../src/components/views/devices-view.tsx"),
    "utf8"
  );
  const fnMatch = viewSrc.match(/function csvEscape[\s\S]*?\n\}/);

  test("SOURCE PIN: the exporter carries the reports-exporter formula guard", () => {
    expect(fnMatch).toBeTruthy();
    const fn = fnMatch![0];
    expect(fn).toContain("/^[=+\\-@\\t\\r]/");
    expect(fn).toContain("/^[+-]?\\d+(?:\\.\\d+)?$/"); // pure-number exemption
    expect(fn).toContain("'${text}"); // the leading-' guard template literal
  });

  test("executed function: =,+,-,@ get the leading-' guard; clean cells byte-identical", () => {
    expect(fnMatch).toBeTruthy();
    // The component is a client module (React/zustand imports) — extract
    // the REAL function text, strip its TS annotations, and execute it.
    const transpiled = new Bun.Transpiler({ loader: "ts" }).transformSync(fnMatch![0]);
    const csvEscape = (0, eval)(`(${transpiled.trim()})`) as (
      value: string | number | null | undefined
    ) => string;

    expect(csvEscape).toBeTypeOf("function");
    // Dangerous prefixes neutralized (the OWASP leading-' guard).
    expect(csvEscape("=cmd|' /C calc'!A0")).toBe("'=cmd|' /C calc'!A0");
    expect(csvEscape("+SUM(A1:A2)")).toBe("'+SUM(A1:A2)");
    expect(csvEscape("-h --flag")).toBe("'-h --flag");
    expect(csvEscape("@import_url")).toBe("'@import_url");
    // Pure numbers are exempt (a negative number is data, not a formula).
    expect(csvEscape(-5)).toBe("-5");
    expect(csvEscape("3.14")).toBe("3.14");
    expect(csvEscape(42)).toBe("42");
    // Clean cells byte-identical + RFC-4180 quoting behavior unchanged.
    expect(csvEscape("core-switch-01")).toBe("core-switch-01");
    expect(csvEscape('a,"b"\nc')).toBe('"a,""b""\nc"');
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
  });
});
