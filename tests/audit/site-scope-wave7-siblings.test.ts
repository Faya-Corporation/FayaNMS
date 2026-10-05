/**
 * F-031 site-scope wave 7 — the nine SIBLING device-domain route handlers.
 *
 * Wave 2 migrated the six device sub-resource reads, the fleet interfaces
 * list and the two device mutation routes. The wave-7 audit (Task 3, F-1/F-2)
 * found the remaining device-domain surfaces still trusting the role gate
 * alone: the snapshots family (list / download / diff / restore), host-key
 * enrollment (GET/POST/PUT/DELETE), the SNMPv3 on-demand poll, the
 * body-addressed reachability probe and the per-id bulk action. This suite
 * pins their migration onto the SAME two central primitives:
 *
 *   READ PLANE (404-NOT-403, sessionAllowsSite row predicate):
 *     GET devices/[id]/snapshots · snapshots/[snapshotId]/download ·
 *         snapshots/diff · host-key
 *     → an out-of-scope device answers the SAME DEVICE_NOT_FOUND envelope a
 *       wildcard session gets for a missing device (no existence leak — the
 *       download/diff routes export DECRYPTED configuration text and the
 *       host-key GET exposes the endpoint's host/port).
 *
 *   MUTATION PLANE (requireSiteScope → 403 SITE_SCOPE_FORBIDDEN):
 *     POST snapshots/[snapshotId]/restore · host-key POST/PUT/DELETE ·
 *     POST snmp/poll · POST devices/test-connection (device resolved from
 *     the request BODY)
 *     → existence confirmation is accepted on the mutation plane; the gate
 *       runs after device resolution and BEFORE any probe, job row, change
 *       request or trust-anchor write.
 *
 *   BULK (per-id composition through scopedDeviceWhere):
 *     POST devices/bulk — the ONE target findMany is composed through the
 *     scope, so an out-of-scope id lands in the SAME notFound bucket as a
 *     missing id (identical { deviceId, reason: "NOT_FOUND" } shape, no
 *     hostname) and never reaches the job-enqueue loop.
 *
 * Harness: the certified batch-25/wave-2 pattern — REAL next-auth JWTs
 * minted with the production encoder (no mock.module), RUN-suffixed
 * fixtures, surgical FK-order cleanup bounded to this suite's rows.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";
import { createHash } from "node:crypto";
import { db } from "../../src/lib/db";
import { invalidateAuditHead } from "../../src/lib/audit/chain";
import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";

/* ── fixtures (RUN-suffixed — parallel-safe, re-runnable) ─────────────── */

const RUN = `W7${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const ORG_NAME = `w7-org-${RUN}`;
const SITE_A_CODE = `W7A-${RUN}`;
const SITE_B_CODE = `W7B-${RUN}`;
const VENDOR_KEY = `w7-vendor-${RUN}`;
const HOST_A = `w7-dev-a-${RUN.toLowerCase()}`;
const HOST_B = `w7-dev-b-${RUN.toLowerCase()}`;
const IP_A = "192.0.2.52";
const IP_B = "192.0.2.53";
const MISSING_ID = "device-w7-does-not-exist";
const ADMIN_EMAIL = "admin@faya.local";
// Legacy plaintext snapshot body (encKeyId=null rows pass decrypt through).
// The stored sha256 MUST be the real plaintext digest — decryptSnapshotTexts
// enforces the CRYPTO-101 integrity check (CONFIG_INTEGRITY_FAIL otherwise).
const RAW_A = "hostname device-a\ninterface Gi0/1\n switchport mode access\n";
const SHA_A = createHash("sha256").update(RAW_A).digest("hex");

const testStartedAt = new Date();

let orgId = "";
let siteAId = "";
let siteBId = "";
let vendorId = "";
let deviceAId = "";
let deviceBId = "";
let snap1Id = "";
let snap2Id = "";
const changeIds: string[] = [];

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

function cookieHeaders(jwt: string, withBody: boolean): Record<string, string> {
  return withBody
    ? { cookie: `next-auth.session-token=${jwt}`, "content-type": "application/json" }
    : { cookie: `next-auth.session-token=${jwt}` };
}

type IdRoute = {
  GET?: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  POST?: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  PUT?: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  DELETE?: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
};
type SnapshotRoute = {
  GET?: (req: Request, ctx: { params: Promise<{ id: string; snapshotId: string }> }) => Promise<Response>;
  POST?: (req: Request, ctx: { params: Promise<{ id: string; snapshotId: string }> }) => Promise<Response>;
};
type PlainRoute = {
  POST?: (req: Request) => Promise<Response>;
};

async function snapshotsListRequest(jwt: string, id: string): Promise<Response> {
  const { GET } = (await import("../../src/app/api/v1/devices/[id]/snapshots/route")) as IdRoute;
  return GET!(
    new NextRequest(`http://app.local/api/v1/devices/${id}/snapshots`, {
      method: "GET",
      headers: cookieHeaders(jwt, false),
    }),
    { params: Promise.resolve({ id }) }
  );
}

async function snapshotDownloadRequest(jwt: string, id: string, snapshotId: string): Promise<Response> {
  const { GET } = (await import(
    "../../src/app/api/v1/devices/[id]/snapshots/[snapshotId]/download/route"
  )) as SnapshotRoute;
  return GET!(
    new NextRequest(`http://app.local/api/v1/devices/${id}/snapshots/${snapshotId}/download`, {
      method: "GET",
      headers: cookieHeaders(jwt, false),
    }),
    { params: Promise.resolve({ id, snapshotId }) }
  );
}

async function snapshotDiffRequest(jwt: string, id: string): Promise<Response> {
  const { GET } = (await import("../../src/app/api/v1/devices/[id]/snapshots/diff/route")) as IdRoute;
  return GET!(
    new NextRequest(`http://app.local/api/v1/devices/${id}/snapshots/diff?from=1&to=2`, {
      method: "GET",
      headers: cookieHeaders(jwt, false),
    }),
    { params: Promise.resolve({ id }) }
  );
}

async function snapshotRestoreRequest(
  jwt: string,
  id: string,
  snapshotId: string,
  body: unknown
): Promise<Response> {
  const { POST } = (await import(
    "../../src/app/api/v1/devices/[id]/snapshots/[snapshotId]/restore/route"
  )) as SnapshotRoute;
  return POST!(
    new NextRequest(`http://app.local/api/v1/devices/${id}/snapshots/${snapshotId}/restore`, {
      method: "POST",
      headers: cookieHeaders(jwt, true),
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id, snapshotId }) }
  );
}

async function hostKeyRequest(
  method: "GET" | "POST" | "PUT" | "DELETE",
  jwt: string,
  id: string,
  body?: unknown
): Promise<Response> {
  const route = (await import("../../src/app/api/v1/devices/[id]/host-key/route")) as IdRoute;
  const handler = method === "GET" ? route.GET! : method === "POST" ? route.POST! : method === "PUT" ? route.PUT! : route.DELETE!;
  return handler(
    new NextRequest(`http://app.local/api/v1/devices/${id}/host-key`, {
      method,
      headers: cookieHeaders(jwt, body !== undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve({ id }) }
  );
}

async function snmpPollRequest(jwt: string, id: string, body: unknown): Promise<Response> {
  const { POST } = (await import("../../src/app/api/v1/devices/[id]/snmp/poll/route")) as IdRoute;
  return POST!(
    new NextRequest(`http://app.local/api/v1/devices/${id}/snmp/poll`, {
      method: "POST",
      headers: cookieHeaders(jwt, true),
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
}

async function testConnectionRequest(jwt: string, deviceId: string): Promise<Response> {
  const { POST } = (await import("../../src/app/api/v1/devices/test-connection/route")) as PlainRoute;
  return POST!(
    new NextRequest("http://app.local/api/v1/devices/test-connection", {
      method: "POST",
      headers: cookieHeaders(jwt, true),
      body: JSON.stringify({ deviceId }),
    })
  );
}

async function bulkRequest(jwt: string, deviceIds: string[]): Promise<Response> {
  const { POST } = (await import("../../src/app/api/v1/devices/bulk/route")) as PlainRoute;
  return POST!(
    new NextRequest("http://app.local/api/v1/devices/bulk", {
      method: "POST",
      headers: cookieHeaders(jwt, true),
      body: JSON.stringify({ action: "backup_now", deviceIds }),
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
    create: { email: ADMIN_EMAIL, name: "W7 Admin", role: "admin", isActive: true },
  });

  const org = await db.organization.create({ data: { name: ORG_NAME } });
  orgId = org.id;
  const siteA = await db.site.create({
    data: { name: `W7 Site A ${RUN}`, code: SITE_A_CODE, organizationId: orgId },
  });
  siteAId = siteA.id;
  const siteB = await db.site.create({
    data: { name: `W7 Site B ${RUN}`, code: SITE_B_CODE, organizationId: orgId },
  });
  siteBId = siteB.id;

  const vendor = await db.vendor.create({
    data: { key: VENDOR_KEY, name: `W7 Vendor ${RUN}`, adapterKey: "generic" },
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

  // Two PLAINTEXT snapshot rows for deviceA (encKeyId=null → decrypt passes
  // through) with the SAME sha256 — enough for the download export, the
  // identical-diff short-circuit and the restore 201, with no crypto setup.
  const snap1 = await db.configSnapshot.create({
    data: { deviceId: deviceAId, version: 1, rawText: RAW_A, sha256: SHA_A, sizeBytes: RAW_A.length },
  });
  snap1Id = snap1.id;
  const snap2 = await db.configSnapshot.create({
    data: { deviceId: deviceAId, version: 2, rawText: RAW_A, sha256: SHA_A, sizeBytes: RAW_A.length },
  });
  snap2Id = snap2.id;

  expect(deviceAId).not.toBe(deviceBId);
});

afterAll(async () => {
  // Surgical FK-order cleanup — every fixture row this suite created,
  // nothing else (createdAt-gte bound on jobs/audits, per rt012 pattern).
  await db.auditEvent.deleteMany({
    where: {
      createdAt: { gte: testStartedAt },
      OR: [
        { resourceType: "Device", resourceId: { in: [deviceAId, deviceBId].filter(Boolean) } },
        { resourceType: "ConfigSnapshot", resourceId: { in: [snap1Id, snap2Id].filter(Boolean) } },
        { resourceType: "ChangeRequest", resourceId: { in: changeIds } },
      ],
    },
  });
  await db.changeRequest.deleteMany({ where: { id: { in: changeIds } } });
  await db.jobExecution.deleteMany({
    where: { type: "CONFIG_BACKUP", targetId: { in: [deviceAId, deviceBId].filter(Boolean) }, createdAt: { gte: testStartedAt } },
  });
  await db.configSnapshot.deleteMany({ where: { deviceId: { in: [deviceAId, deviceBId].filter(Boolean) } } });
  await db.device.deleteMany({ where: { id: { in: [deviceAId, deviceBId].filter(Boolean) } } });
  await db.vendor.deleteMany({ where: { id: vendorId } });
  await db.site.deleteMany({ where: { id: { in: [siteAId, siteBId].filter(Boolean) } } });
  await db.organization.deleteMany({ where: { id: orgId } });
  // The deleted rows were hash-chained (CONFIG_BACKUP_QUEUED etc.) — reset
  // the cached chain head so a later verification re-reads from storage.
  invalidateAuditHead();
});

/* ── read plane — fused 404 on the four sibling reads ─────────────────── */

describe("F-031 wave-7 sibling reads (404-not-403, sessionAllowsSite)", () => {
  test("sites-limited session (site A): out-of-scope AND missing devices share the SAME DEVICE_NOT_FOUND envelope", async () => {
    const jwt = await adminJwt([SITE_A_CODE]);

    const snapshotsOutOfScope = await snapshotsListRequest(jwt, deviceBId);
    const snapshotsMissing = await snapshotsListRequest(jwt, MISSING_ID);
    expect(snapshotsOutOfScope.status).toBe(404);
    expect(snapshotsMissing.status).toBe(404);
    expect((await envelope(snapshotsOutOfScope)).error?.code).toBe("DEVICE_NOT_FOUND");
    expect((await envelope(snapshotsMissing)).error?.code).toBe("DEVICE_NOT_FOUND");

    const downloadOutOfScope = await snapshotDownloadRequest(jwt, deviceBId, snap1Id);
    const downloadMissing = await snapshotDownloadRequest(jwt, MISSING_ID, snap1Id);
    expect(downloadOutOfScope.status).toBe(404);
    expect(downloadMissing.status).toBe(404);
    expect((await envelope(downloadOutOfScope)).error?.code).toBe("DEVICE_NOT_FOUND");
    expect((await envelope(downloadMissing)).error?.code).toBe("DEVICE_NOT_FOUND");

    const diffOutOfScope = await snapshotDiffRequest(jwt, deviceBId);
    const diffMissing = await snapshotDiffRequest(jwt, MISSING_ID);
    expect(diffOutOfScope.status).toBe(404);
    expect(diffMissing.status).toBe(404);
    expect((await envelope(diffOutOfScope)).error?.code).toBe("DEVICE_NOT_FOUND");
    expect((await envelope(diffMissing)).error?.code).toBe("DEVICE_NOT_FOUND");

    const hostKeyOutOfScope = await hostKeyRequest("GET", jwt, deviceBId);
    const hostKeyMissing = await hostKeyRequest("GET", jwt, MISSING_ID);
    expect(hostKeyOutOfScope.status).toBe(404);
    expect(hostKeyMissing.status).toBe(404);
    expect((await envelope(hostKeyOutOfScope)).error?.code).toBe("DEVICE_NOT_FOUND");
    expect((await envelope(hostKeyMissing)).error?.code).toBe("DEVICE_NOT_FOUND");
  });

  test("deny-all scope: NEITHER fixture device leaks through any sibling read", async () => {
    const jwt = await adminJwt([]);
    for (const deviceId of [deviceAId, deviceBId]) {
      expect((await snapshotsListRequest(jwt, deviceId)).status).toBe(404);
      expect((await snapshotDownloadRequest(jwt, deviceId, snap1Id)).status).toBe(404);
      expect((await snapshotDiffRequest(jwt, deviceId)).status).toBe(404);
      expect((await hostKeyRequest("GET", jwt, deviceId)).status).toBe(404);
    }
  });

  test("sites-limited session (site A): in-scope reads answer 200 with the REAL payloads", async () => {
    const jwt = await adminJwt([SITE_A_CODE]);

    const list = await snapshotsListRequest(jwt, deviceAId);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      data?: unknown[];
      meta?: { hostname?: string };
    };
    expect(listBody.data).toHaveLength(2);
    expect(listBody.meta?.hostname).toBe(HOST_A);

    const download = await snapshotDownloadRequest(jwt, deviceAId, snap1Id);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toContain("text/plain");
    expect(await download.text()).toBe(RAW_A);

    const diff = await snapshotDiffRequest(jwt, deviceAId);
    expect(diff.status).toBe(200);
    const diffBody = (await diff.json()) as { data?: { identical?: boolean } };
    expect(diffBody.data?.identical).toBe(true);

    const hostKey = await hostKeyRequest("GET", jwt, deviceAId);
    expect(hostKey.status).toBe(200);
    expect((await envelope(hostKey)).data).toBeNull(); // no credential linked → unenrolled endpoint
  });

  test("wildcard session: the same four reads stay byte-unchanged (the gate is scope-driven)", async () => {
    const jwt = await adminJwt();
    expect((await snapshotsListRequest(jwt, deviceBId)).status).toBe(200);
    expect((await snapshotDownloadRequest(jwt, deviceAId, snap2Id)).status).toBe(200);
    expect((await snapshotDiffRequest(jwt, deviceBId)).status).toBe(404); // snapshot missing on B — business answer, not scope
    expect((await envelope(await snapshotDiffRequest(jwt, deviceAId))).success).toBe(true);
    expect((await hostKeyRequest("GET", jwt, deviceBId)).status).toBe(200);
  });
});

/* ── mutation plane — requireSiteScope 403 on the sibling mutations ───── */

describe("F-031 wave-7 sibling mutations (403 SITE_SCOPE_FORBIDDEN)", () => {
  test("sites-limited session (site A): EVERY sibling mutation on an out-of-scope device → 403, nothing written", async () => {
    const jwt = await adminJwt([SITE_A_CODE]);

    const restore = await snapshotRestoreRequest(jwt, deviceBId, snap1Id, {
      confirmHostname: HOST_B,
    });
    expect(restore.status).toBe(403);
    expect((await envelope(restore)).error?.code).toBe("SITE_SCOPE_FORBIDDEN");

    const hostKeyProbe = await hostKeyRequest("POST", jwt, deviceBId, { action: "probe" });
    expect(hostKeyProbe.status).toBe(403);
    expect((await envelope(hostKeyProbe)).error?.code).toBe("SITE_SCOPE_FORBIDDEN");

    const hostKeyPin = await hostKeyRequest("PUT", jwt, deviceBId, {
      fingerprint: `SHA256:${"A".repeat(43)}`,
      keyType: "ssh-ed25519",
    });
    expect(hostKeyPin.status).toBe(403);
    expect((await envelope(hostKeyPin)).error?.code).toBe("SITE_SCOPE_FORBIDDEN");

    const hostKeyRevoke = await hostKeyRequest("DELETE", jwt, deviceBId);
    expect(hostKeyRevoke.status).toBe(403);
    expect((await envelope(hostKeyRevoke)).error?.code).toBe("SITE_SCOPE_FORBIDDEN");

    const poll = await snmpPollRequest(jwt, deviceBId, {});
    expect(poll.status).toBe(403);
    expect((await envelope(poll)).error?.code).toBe("SITE_SCOPE_FORBIDDEN");

    const probe = await testConnectionRequest(jwt, deviceBId);
    expect(probe.status).toBe(403);
    expect((await envelope(probe)).error?.code).toBe("SITE_SCOPE_FORBIDDEN");

    // Nothing-written checks (the rig's DB-state pattern):
    expect(
      await db.changeDevice.count({ where: { deviceId: deviceBId } })
    ).toBe(0); // no restore change touched the out-of-scope device
    expect(
      await db.jobExecution.count({
        where: { type: "SNMP_POLL", targetId: deviceBId, createdAt: { gte: testStartedAt } },
      })
    ).toBe(0); // no poll job queued
    expect(
      await db.auditEvent.count({
        where: { action: "DEVICE_CONNECTION_TESTED", resourceId: deviceBId, createdAt: { gte: testStartedAt } },
      })
    ).toBe(0); // no probe ran, none audited
    expect(
      await db.sshHostKey.count({ where: { host: IP_B } })
    ).toBe(0); // no trust anchor written
  });

  test("deny-all scope: the same six mutations are refused on the in-scope-fixture device too (fail-closed)", async () => {
    const jwt = await adminJwt([]);
    const restore = await snapshotRestoreRequest(jwt, deviceAId, snap1Id, { confirmHostname: HOST_A });
    expect(restore.status).toBe(403);
    expect((await envelope(restore)).error?.code).toBe("SITE_SCOPE_FORBIDDEN");
    expect((await hostKeyRequest("POST", jwt, deviceAId, { action: "probe" })).status).toBe(403);
    expect((await hostKeyRequest("PUT", jwt, deviceAId, { fingerprint: `SHA256:${"A".repeat(43)}`, keyType: "ssh-ed25519" })).status).toBe(403);
    expect((await hostKeyRequest("DELETE", jwt, deviceAId)).status).toBe(403);
    expect((await snmpPollRequest(jwt, deviceAId, {})).status).toBe(403);
    expect((await testConnectionRequest(jwt, deviceAId)).status).toBe(403);
  });
});

/* ── in-scope contrast — the 403s are scope-driven, not shape-driven ──── */

describe("F-031 wave-7 in-scope contrast (the same requests pass the scope gate)", () => {
  test("sites-limited session (site A): in-scope mutations proceed to the routes' business answers", async () => {
    const jwt = await adminJwt([SITE_A_CODE]);

    // Device A has no credential profile / no engine enrollment — the scope
    // gate PASSES and the route's own validation answers:
    const hostKeyProbe = await hostKeyRequest("POST", jwt, deviceAId, { action: "probe" });
    expect(hostKeyProbe.status).toBe(400);
    expect((await envelope(hostKeyProbe)).error?.code).toBe("CREDENTIAL_REQUIRED");

    const hostKeyPin = await hostKeyRequest("PUT", jwt, deviceAId, {
      fingerprint: `SHA256:${"A".repeat(43)}`,
      keyType: "ssh-ed25519",
    });
    expect(hostKeyPin.status).toBe(400);
    expect((await envelope(hostKeyPin)).error?.code).toBe("CREDENTIAL_REQUIRED");

    const hostKeyRevoke = await hostKeyRequest("DELETE", jwt, deviceAId);
    expect(hostKeyRevoke.status).toBe(400);
    expect((await envelope(hostKeyRevoke)).error?.code).toBe("CREDENTIAL_REQUIRED");

    const poll = await snmpPollRequest(jwt, deviceAId, {});
    expect(poll.status).toBe(409);
    expect((await envelope(poll)).error?.code).toBe("SNMP_ENGINE_UNENROLLED");

    // The guarded restore flow with a REAL snapshot: 201 AWAITING_APPROVAL.
    const restore = await snapshotRestoreRequest(jwt, deviceAId, snap1Id, {
      confirmHostname: HOST_A,
    });
    expect(restore.status).toBe(201);
    const restoreBody = (await envelope(restore)) as {
      data?: { change?: { id?: string; status?: string } };
    };
    expect(restoreBody.data?.change?.status).toBe("AWAITING_APPROVAL");
    const changeId = restoreBody.data?.change?.id ?? "";
    expect(changeId.length).toBeGreaterThan(0);
    changeIds.push(changeId);
  });
});

/* ── bulk — per-id notFound bucket (leak-free composition) ────────────── */

describe("F-031 wave-7 bulk (scopedDeviceWhere composition, per-id notFound bucket)", () => {
  test("sites-limited session (site A): out-of-scope and missing ids share the identical NOT_FOUND bucket entry; only the in-scope id is queued", async () => {
    const res = await bulkRequest(await adminJwt([SITE_A_CODE]), [deviceAId, deviceBId, MISSING_ID]);
    expect(res.status).toBe(200);
    const body = (await envelope(res)) as {
      data?: {
        queued?: number;
        jobs?: Array<{ deviceId?: string; status?: string }>;
        skipped?: Array<Record<string, unknown>>;
      };
    };

    // The in-scope id is eligible and queued.
    expect(body.data?.queued).toBe(1);
    expect(body.data?.jobs).toHaveLength(1);
    expect(body.data?.jobs?.[0]?.deviceId).toBe(deviceAId);
    expect(body.data?.jobs?.[0]?.status).toBe("QUEUED");

    // The out-of-scope id and the missing id land in the SAME bucket with
    // the IDENTICAL shape — no hostname, no out-of-scope distinguishing
    // detail (toEqual pins the exact { deviceId, reason } shape).
    const skipped = body.data?.skipped ?? [];
    const notFound = skipped.filter((entry) => entry.reason === "NOT_FOUND");
    expect(notFound).toHaveLength(2);
    const byId = new Map(notFound.map((entry) => [entry.deviceId, entry]));
    expect(byId.get(deviceBId)).toEqual({ deviceId: deviceBId, reason: "NOT_FOUND" });
    expect(byId.get(MISSING_ID)).toEqual({ deviceId: MISSING_ID, reason: "NOT_FOUND" });
    expect(Object.keys(byId.get(deviceBId) ?? {}).sort()).toEqual(
      Object.keys(byId.get(MISSING_ID) ?? {}).sort()
    );

    // DB state (the rig's nothing-written pattern): zero JobExecution rows
    // and zero CONFIG_BACKUP_QUEUED audit rows for the out-of-scope id;
    // exactly one queued job for the in-scope id.
    expect(
      await db.jobExecution.count({
        where: { type: "CONFIG_BACKUP", targetId: deviceBId, createdAt: { gte: testStartedAt } },
      })
    ).toBe(0);
    expect(
      await db.auditEvent.count({
        where: { action: "CONFIG_BACKUP_QUEUED", resourceId: deviceBId, createdAt: { gte: testStartedAt } },
      })
    ).toBe(0);
    expect(
      await db.jobExecution.count({
        where: { type: "CONFIG_BACKUP", targetId: deviceAId, createdAt: { gte: testStartedAt } },
      })
    ).toBe(1);
  });

  test("wildcard session: the same batch queues BOTH devices with an empty skip report (suppression is scope-driven, not shape-driven)", async () => {
    const res = await bulkRequest(await adminJwt(), [deviceAId, deviceBId]);
    expect(res.status).toBe(200);
    const body = (await envelope(res)) as {
      data?: { queued?: number; jobs?: Array<{ deviceId?: string }>; skipped?: unknown[] };
    };
    expect(body.data?.queued).toBe(2);
    expect(body.data?.jobs?.map((job) => job.deviceId).sort()).toEqual([deviceAId, deviceBId].sort());
    expect(body.data?.skipped).toEqual([]);
  });
});
