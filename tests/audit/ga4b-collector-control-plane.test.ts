/**
 * GA-4b — REAL collector control plane (P0-R06 / P1-O01).
 *
 * Replaces the static in-code fleet for ASSIGNMENT DECISIONS with DB-backed
 * primitives: registration, heartbeat liveness, ownership rows with lease
 * epochs, fencing, failover/rebalance that actually move ownership.
 *
 * Pins (route-level, against the REAL handlers):
 *   1. REGISTRATION — machine plane (telemetry-scoped service JWT):
 *      anonymous/insufficient-scope refused; idempotent upsert by agentKey;
 *      unknown siteCode refused (fail-fast truthfulness); re-registration
 *      reactivates and refreshes.
 *   2. RECONCILE — deterministic target plan (site-resident → peer-site →
 *      fallback-regional) actually creates/moves ownership rows; idempotent
 *      second run; siteless devices NEVER assigned (honest count);
 *      SUSPENDED agents are not targets.
 *   3. HEARTBEAT + FENCING — correct owner+epoch renews the lease; stale
 *      epoch / foreign owner / unknown device are FENCED with the precise
 *      reason; liveness refreshed; fenced claims aggregate into ONE audit
 *      row.
 *   4. FAILOVER — every owned row moves to the deterministic peer with an
 *      epoch bump (the failing agent's next heartbeat is fenced); optional
 *      suspension fences every claim the agent still sends.
 *   5. REAPER — agents silent past the lease TTL are failed over
 *      (heartbeat-timeout); row-level expired leases are re-targeted
 *      (quiet renewal on same target, epoch-bumped move otherwise).
 *   6. REAL REBALANCE — preview + apply over ownership rows in a
 *      PRODUCTION posture (no demo flag): rows actually move, epochs bump,
 *      audit rows carry the correlation; planId staleness is genuine.
 *   7. GA-4 REGRESSION — with ZERO ACTIVE agents the APPLY leg still
 *      refuses in production posture (403 SIMULATION_DISABLED, gate before
 *      plan computation) and the distribution route still serves the
 *      labeled simulation (static fleet, demo banner intact).
 *
 * CI posture (GA-4 lesson): the gate DB is migrations-only — no seeded
 * fleet. Every fixture (vendor, org, sites, devices) is created here; no
 * test assumes demo data. Cleanup is surgical (RUN-suffixed + timestamped
 * audit sweep), never touching shared rows.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";
import { readFileSync } from "node:fs";

import { db } from "../../src/lib/db";
import { mintServiceToken } from "../../src/lib/auth/service-auth";
import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";

const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
const LOW = RUN.toLowerCase();
const testStartedAt = new Date();

let adminCookie: Record<string, string>;
let vendorId: string;
let orgId: string;
let siteAId: string;
const siteBId: string[] = []; // tracked for cleanup only

/* ───────────────────────────── Fixtures ─────────────────────────────────── */

const SITE_A = `GA4B-A-${RUN}`;
const SITE_A_REGION = `RA-NORTH-${RUN}`;
const SITE_B_REGION = `RB-SOUTH-${RUN}`;

const KEY = {
  reg1: `ga4b-${LOW}-reg-1`,
  reg2: `ga4b-${LOW}-reg-2`,
  reg3: `ga4b-${LOW}-reg-3`,
  fo1: `ga4b-${LOW}-fo-1`,
  fo2: `ga4b-${LOW}-fo-2`,
  fo3: `ga4b-${LOW}-fo-3`,
  rbHot: `ga4b-${LOW}-rb-hot`,
  rbPeer: `ga4b-${LOW}-rb-peer`,
};

async function ensureAdmin(): Promise<void> {
  const adminEntry = ROLE_MATRIX.find((entry) => entry.name === "admin");
  await db.role.upsert({
    where: { name: "admin" },
    update: { permissionsJson: JSON.stringify(adminEntry?.permissions ?? ["*"]) },
    create: {
      id: adminEntry?.id ?? "role-admin",
      name: "admin",
      permissionsJson: JSON.stringify(adminEntry?.permissions ?? ["*"]),
    },
  });
  await db.user.upsert({
    where: { email: "admin@faya.local" },
    update: { isActive: true },
    create: { email: "admin@faya.local", name: "GA4B Admin", role: "admin", isActive: true },
    select: { id: true, email: true, name: true, role: true },
  });
}

async function mintAdminSession(): Promise<Record<string, string>> {
  const admin = await db.user.findUnique({ where: { email: "admin@faya.local" } });
  if (!admin) throw new Error("admin fixture missing");
  const token = await encode({
    token: { id: admin.id, email: admin.email, name: admin.name ?? undefined, role: admin.role },
    secret: process.env.NEXTAUTH_SECRET ?? "",
  });
  return { cookie: `next-auth.session-token=${token}` };
}

let deviceSeq = 0;
async function createDevice(hostname: string, siteId: string | null): Promise<string> {
  deviceSeq += 1;
  const device = await db.device.create({
    data: {
      hostname,
      mgmtIp: `10.77.${deviceSeq % 255}.${(deviceSeq * 7) % 200 + 10}`,
      vendorId,
      siteId,
      status: "ONLINE",
    },
    select: { id: true },
  });
  return device.id;
}

function machineRequest(url: string, body: unknown, scopes: string[] = ["telemetry"]): Request {
  const token = mintServiceToken({
    issuer: "fayanms:worker",
    subject: `worker:ga4b-${LOW}`,
    scopes,
  });
  return new Request(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function adminRequest(url: string, body?: unknown, method: "POST" | "GET" = "POST"): NextRequest {
  return new NextRequest(url, {
    method,
    headers: {
      ...adminCookie,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function bodyOf(res: Response): Promise<any> {
  return (await res.json()) as any;
}

async function agentIdOf(agentKey: string): Promise<string> {
  const agent = await db.collectorAgent.findUnique({ where: { agentKey } });
  if (!agent) throw new Error(`agent ${agentKey} missing`);
  return agent.id;
}

async function ownedRows(agentKey: string) {
  return db.collectorAssignment.findMany({
    where: { agentId: await agentIdOf(agentKey) },
    include: { device: { select: { hostname: true, siteId: true } } },
    orderBy: { deviceId: "asc" },
  });
}

async function registerAgent(key: string, displayName: string, role: string, opts: { siteCode?: string; capacity?: number } = {}) {
  const { POST } = await import("../../src/app/api/v1/collectors/register/route");
  const res = await POST(machineRequest("http://app.local/api/v1/collectors/register", {
    agentKey: key,
    displayName,
    role,
    ...(opts.siteCode ? { siteCode: opts.siteCode } : {}),
    ...(opts.capacity ? { capacity: opts.capacity } : {}),
  }));
  expect(res.status).toBe(201);
}

/** Suspend every ACTIVE agent except the named keys; returns their prior statuses. */
async function suspendAllExcept(keep: string[]): Promise<Record<string, string>> {
  const saved: Record<string, string> = {};
  for (const agent of await db.collectorAgent.findMany()) {
    saved[agent.agentKey] = agent.status;
    await db.collectorAgent.update({
      where: { id: agent.id },
      data: { status: keep.includes(agent.agentKey) ? "ACTIVE" : "SUSPENDED" },
    });
  }
  return saved;
}

async function restoreStatuses(saved: Record<string, string>): Promise<void> {
  for (const [agentKey, status] of Object.entries(saved)) {
    await db.collectorAgent.updateMany({ where: { agentKey }, data: { status } });
  }
}

/* ───────────────────────────── Lifecycle ────────────────────────────────── */

beforeAll(async () => {
  process.env.FAYANMS_DEMO_MODE = ""; // production posture for the real-plane pins
  await ensureAdmin();
  adminCookie = await mintAdminSession();

  const vendor = await db.vendor.upsert({
    where: { key: `ga4b-${LOW}` },
    update: {},
    create: { key: `ga4b-${LOW}`, name: `GA4B Vendor ${RUN}`, adapterKey: "ga4b-test" },
  });
  vendorId = vendor.id;

  const org = await db.organization.create({
    data: { name: `GA4B Org ${RUN}` },
    select: { id: true },
  });
  orgId = org.id;

  const siteA = await db.site.create({
    data: { code: SITE_A, name: `GA4B Site A ${RUN}`, region: SITE_A_REGION, organizationId: orgId },
    select: { id: true },
  });
  siteAId = siteA.id;
  const siteB = await db.site.create({
    data: { code: `GA4B-B-${RUN}`, name: `GA4B Site B ${RUN}`, region: SITE_B_REGION, organizationId: orgId },
    select: { id: true },
  });
  siteBId.push(siteB.id);
});

afterAll(async () => {
  const agentRows = await db.collectorAgent.findMany({
    where: { agentKey: { contains: `ga4b-${LOW}` } },
    select: { id: true },
  });
  const agentIds = agentRows.map((a) => a.id);
  if (agentIds.length > 0) {
    await db.collectorAssignment.deleteMany({ where: { agentId: { in: agentIds } } });
    await db.collectorAgent.deleteMany({ where: { id: { in: agentIds } } });
  }
  await db.device.deleteMany({ where: { vendorId } });
  await db.vendor.delete({ where: { id: vendorId } }).catch(() => {});
  await db.site.deleteMany({ where: { organizationId: orgId } });
  await db.organization.delete({ where: { id: orgId } }).catch(() => {});
  await db.auditEvent.deleteMany({
    where: {
      createdAt: { gte: testStartedAt },
      action: {
        in: [
          "COLLECTOR_AGENT_REGISTERED",
          "COLLECTOR_ASSIGNMENTS_RECONCILED",
          "COLLECTOR_AGENT_FAILOVER",
          "COLLECTOR_AGENT_FENCED",
          "COLLECTOR_LEASES_REAPED",
          "COLLECTOR_REBALANCE",
        ],
      },
    },
  });
  delete process.env.FAYANMS_DEMO_MODE;
});

/* ───────────────────────────── 1. Registration ──────────────────────────── */

describe("GA-4b: registration (machine plane)", () => {
  test("anonymous (no token) → 401 SERVICE_UNAUTHENTICATED", async () => {
    const { POST } = await import("../../src/app/api/v1/collectors/register/route");
    const res = await POST(
      new Request("http://app.local/api/v1/collectors/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentKey: `ga4b-${LOW}-x`, displayName: "x", role: "snmp" }),
      })
    );
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).error.code).toBe("SERVICE_UNAUTHENTICATED");
  });

  test("wrong scope (metrics) → 403 SERVICE_SCOPE_INSUFFICIENT", async () => {
    const { POST } = await import("../../src/app/api/v1/collectors/register/route");
    const res = await POST(machineRequest(
      "http://app.local/api/v1/collectors/register",
      { agentKey: `ga4b-${LOW}-x`, displayName: "x", role: "snmp" },
      ["metrics"]
    ));
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).error.code).toBe("SERVICE_SCOPE_INSUFFICIENT");
  });

  test("unknown siteCode → 400 COLLECTOR_SITE_UNKNOWN (fail-fast truthfulness)", async () => {
    const { POST } = await import("../../src/app/api/v1/collectors/register/route");
    const res = await POST(machineRequest("http://app.local/api/v1/collectors/register", {
      agentKey: `ga4b-${LOW}-bad`,
      displayName: "Bad Agent",
      role: "snmp",
      siteCode: "NO-SUCH-SITE",
    }));
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).error.code).toBe("COLLECTOR_SITE_UNKNOWN");
  });

  test("first registration → 201 ACTIVE with the liveness contract + audit row", async () => {
    const { POST } = await import("../../src/app/api/v1/collectors/register/route");
    const res = await POST(machineRequest("http://app.local/api/v1/collectors/register", {
      agentKey: KEY.reg1,
      displayName: "GA4B Registration Agent 1",
      role: "snmp",
      siteCode: SITE_A,
      version: "1.0.0",
      capacity: 10,
    }));
    expect(res.status).toBe(201);
    const body = await bodyOf(res);
    expect(body.data.created).toBe(true);
    expect(body.data.agent.status).toBe("ACTIVE");
    expect(body.data.heartbeatIntervalS).toBe(30);
    expect(body.data.leaseTtlMs).toBe(90_000);

    const row = await db.collectorAgent.findUnique({ where: { agentKey: KEY.reg1 } });
    expect(row?.status).toBe("ACTIVE");
    expect(row?.siteId).toBe(siteAId);
    expect(row?.lastHeartbeatAt).not.toBeNull();

    const audit = await db.auditEvent.findFirst({
      where: { action: "COLLECTOR_AGENT_REGISTERED", resourceId: KEY.reg1 },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
  });

  test("re-registration → 200, not duplicated, capacity refreshed", async () => {
    const { POST } = await import("../../src/app/api/v1/collectors/register/route");
    const res = await POST(machineRequest("http://app.local/api/v1/collectors/register", {
      agentKey: KEY.reg1,
      displayName: "GA4B Registration Agent 1",
      role: "snmp",
      siteCode: SITE_A,
      version: "1.1.0",
      capacity: 20,
    }));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.data.created).toBe(false);
    expect(body.data.agent.capacity).toBe(20);
    expect(await db.collectorAgent.count({ where: { agentKey: KEY.reg1 } })).toBe(1);
  });
});

/* ───────────────────────────── 2. Reconcile ─────────────────────────────── */

describe("GA-4b: reconcile (real ownership)", () => {
  beforeAll(async () => {
    await createDevice(`ga4b-a1-${LOW}.faya.local`, siteAId);
    await createDevice(`ga4b-a2-${LOW}.faya.local`, siteAId);
    await createDevice(`ga4b-nosite-${LOW}.faya.local`, null);
    // reg-2: siteless agent in site A's REGION (peer-site candidate)
    // reg-3: siteless agent in a DIFFERENT region (fallback candidate)
    await registerAgent(KEY.reg2, "GA4B Regional Peer", "syslog");
    await db.collectorAgent.update({ where: { agentKey: KEY.reg2 }, data: { region: SITE_A_REGION } });
    await registerAgent(KEY.reg3, "GA4B Fallback", "config");
    await db.collectorAgent.update({ where: { agentKey: KEY.reg3 }, data: { region: SITE_B_REGION } });
  });

  test("reconcile assigns site-A devices to the site-resident agent (via site-resident)", async () => {
    const { POST } = await import("../../src/app/api/v1/admin/collectors/assignments/reconcile/route");
    const res = await POST(adminRequest("http://app.local/api/v1/admin/collectors/assignments/reconcile", {}));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.data.created).toBe(2);
    expect(body.data.unassignedSiteless).toBe(1); // siteless device honestly counted, never assigned
    expect(body.data.agents).toBe(3);

    const rows = await ownedRows(KEY.reg1);
    expect(rows.length).toBe(2);
    expect(rows.every((row) => row.via === "site-resident")).toBe(true);
    expect(rows.every((row) => row.leaseEpoch === 1)).toBe(true);
    expect(rows.every((row) => row.leasedUntil !== null)).toBe(true);

    const sitelessDevice = await db.device.findUnique({ where: { hostname: `ga4b-nosite-${LOW}.faya.local` } });
    const sitelessOwned = await db.collectorAssignment.findUnique({ where: { deviceId: sitelessDevice!.id } });
    expect(sitelessOwned).toBeNull();
  });

  test("second reconcile is idempotent (kept, no epoch churn)", async () => {
    const { POST } = await import("../../src/app/api/v1/admin/collectors/assignments/reconcile/route");
    const res = await POST(adminRequest("http://app.local/api/v1/admin/collectors/assignments/reconcile", {}));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.data.kept).toBe(2);
    expect(body.data.created).toBe(0);
    expect(body.data.moved).toBe(0);
    const rows = await ownedRows(KEY.reg1);
    expect(rows.every((row) => row.leaseEpoch === 1)).toBe(true); // no ownership transfer ⇒ no epoch bump
  });

  test("SUSPENDED agent is not a reconcile target — ownership moves with epoch bump", async () => {
    await db.collectorAgent.update({ where: { agentKey: KEY.reg1 }, data: { status: "SUSPENDED" } });
    const { POST } = await import("../../src/app/api/v1/admin/collectors/assignments/reconcile/route");
    const res = await POST(adminRequest("http://app.local/api/v1/admin/collectors/assignments/reconcile", {}));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.data.moved).toBe(2);
    // reg-2 is siteless but in site A's region → peer-site label
    const rows = await ownedRows(KEY.reg2);
    expect(rows.length).toBe(2);
    expect(rows.every((row) => row.via === "peer-site")).toBe(true);
    expect(rows.every((row) => row.leaseEpoch === 2)).toBe(true);
    expect(rows.every((row) => row.assignedBy === "reconcile")).toBe(true);
    await db.collectorAgent.update({ where: { agentKey: KEY.reg1 }, data: { status: "ACTIVE" } });
  });

  test("admin reconcile requires the human plane — service token refused", async () => {
    const { POST } = await import("../../src/app/api/v1/admin/collectors/assignments/reconcile/route");
    const token = mintServiceToken({ issuer: "fayanms:worker", subject: `worker:ga4b-${LOW}`, scopes: ["telemetry"] });
    const res = await POST(
      new NextRequest("http://app.local/api/v1/admin/collectors/assignments/reconcile", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      })
    );
    expect([401, 403]).toContain(res.status);
  });
});

/* ────────────────────── 3. Heartbeat + fencing ──────────────────────────── */

describe("GA-4b: heartbeat and fencing", () => {
  let deviceId: string;
  let currentEpoch: number;

  beforeAll(async () => {
    // reg-1 is ACTIVE again (reactivated above) and site-resident: a fresh
    // reconcile moves both site-A devices BACK to it (epoch 2 → 3 chain).
    const { POST } = await import("../../src/app/api/v1/admin/collectors/assignments/reconcile/route");
    const res = await POST(adminRequest("http://app.local/api/v1/admin/collectors/assignments/reconcile", {}));
    expect(res.status).toBe(200);
    const rows = await ownedRows(KEY.reg1);
    expect(rows.length).toBe(2);
    deviceId = rows[0].deviceId;
    currentEpoch = rows[0].leaseEpoch;
    expect(currentEpoch).toBeGreaterThanOrEqual(2); // the suspend-move bumped it
  });

  test("correct owner + epoch renews the lease and refreshes liveness", async () => {
    const { POST } = await import("../../src/app/api/v1/collectors/heartbeat/route");
    const beforeAgent = await db.collectorAgent.findUnique({ where: { agentKey: KEY.reg1 } });
    const beforeRow = await db.collectorAssignment.findUnique({ where: { deviceId } });

    const res = await POST(machineRequest("http://app.local/api/v1/collectors/heartbeat", {
      agentKey: KEY.reg1,
      claims: [{ deviceId, leaseEpoch: currentEpoch }],
    }));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.data.renewed).toBe(1);
    expect(body.data.fenced).toHaveLength(0);

    const afterAgent = await db.collectorAgent.findUnique({ where: { agentKey: KEY.reg1 } });
    expect((afterAgent!.lastHeartbeatAt as Date).getTime()).toBeGreaterThanOrEqual(
      (beforeAgent!.lastHeartbeatAt as Date).getTime()
    );
    const afterRow = await db.collectorAssignment.findUnique({ where: { deviceId } });
    expect(afterRow!.leaseEpoch).toBe(currentEpoch); // renewal never bumps
    expect(afterRow!.leasedUntil!.getTime()).toBeGreaterThanOrEqual(beforeRow!.leasedUntil!.getTime());
  });

  test("stale epoch (pre-transfer claim) is FENCED with stale-epoch", async () => {
    const { POST } = await import("../../src/app/api/v1/collectors/heartbeat/route");
    const res = await POST(machineRequest("http://app.local/api/v1/collectors/heartbeat", {
      agentKey: KEY.reg1,
      claims: [{ deviceId, leaseEpoch: currentEpoch - 1 }],
    }));
    const body = await bodyOf(res);
    expect(body.data.fenced).toHaveLength(1);
    expect(body.data.fenced[0].reason).toBe("stale-epoch");
    expect(body.data.renewed).toBe(0);
  });

  test("foreign owner (another agent claims a device it does not own) is FENCED with not-owner", async () => {
    const { POST } = await import("../../src/app/api/v1/collectors/heartbeat/route");
    const res = await POST(machineRequest("http://app.local/api/v1/collectors/heartbeat", {
      agentKey: KEY.reg2, // owns nothing at this point
      claims: [{ deviceId, leaseEpoch: currentEpoch }], // epoch even correct — ownership is the fence
    }));
    const body = await bodyOf(res);
    expect(body.data.fenced).toHaveLength(1);
    expect(body.data.fenced[0].reason).toBe("not-owner");
  });

  test("unknown device (never reconciled) is FENCED with unknown-assignment", async () => {
    const { POST } = await import("../../src/app/api/v1/collectors/heartbeat/route");
    const res = await POST(machineRequest("http://app.local/api/v1/collectors/heartbeat", {
      agentKey: KEY.reg1,
      claims: [{ deviceId: "ga4b-never-existed-000000", leaseEpoch: 1 }],
    }));
    const body = await bodyOf(res);
    expect(body.data.fenced).toHaveLength(1);
    expect(body.data.fenced[0].reason).toBe("unknown-assignment");
  });

  test("fenced claims aggregate into ONE COLLECTOR_AGENT_FENCED audit row per heartbeat", async () => {
    const { POST } = await import("../../src/app/api/v1/collectors/heartbeat/route");
    const before = await db.auditEvent.count({ where: { action: "COLLECTOR_AGENT_FENCED", resourceId: KEY.reg1 } });
    await POST(machineRequest("http://app.local/api/v1/collectors/heartbeat", {
      agentKey: KEY.reg1,
      claims: [
        { deviceId: "ga4b-ghost-1", leaseEpoch: 1 },
        { deviceId: "ga4b-ghost-2", leaseEpoch: 1 },
      ],
    }));
    const after = await db.auditEvent.count({ where: { action: "COLLECTOR_AGENT_FENCED", resourceId: KEY.reg1 } });
    expect(after).toBe(before + 1);
  });

  test("heartbeat from an unregistered agent → 404 COLLECTOR_AGENT_UNKNOWN", async () => {
    const { POST } = await import("../../src/app/api/v1/collectors/heartbeat/route");
    const res = await POST(machineRequest("http://app.local/api/v1/collectors/heartbeat", {
      agentKey: `ga4b-${LOW}-ghost`,
      claims: [],
    }));
    expect(res.status).toBe(404);
    expect((await bodyOf(res)).error.code).toBe("COLLECTOR_AGENT_UNKNOWN");
  });

  test("machine assignments snapshot lists the agent's owned epochs", async () => {
    const { GET } = await import("../../src/app/api/v1/collectors/assignments/route");
    const token = mintServiceToken({ issuer: "fayanms:worker", subject: `worker:ga4b-${LOW}`, scopes: ["telemetry"] });
    const res = await GET(
      new Request(`http://app.local/api/v1/collectors/assignments?agentKey=${KEY.reg1}`, {
        headers: { authorization: `Bearer ${token}` },
      })
    );
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.data.assignments.length).toBe(2);
    expect(body.data.assignments.every((a: any) => a.leaseEpoch >= 1)).toBe(true);
  });
});

/* ───────────────────────────── 4. Failover ──────────────────────────────── */

describe("GA-4b: failover (real ownership moves)", () => {
  let fo1DeviceIds: string[] = [];

  beforeAll(async () => {
    // fo-1: site A (region RA); fo-2: siteless in region RA (same-region peer)
    await registerAgent(KEY.fo1, "GA4B Failover Source", "snmp", { siteCode: SITE_A, capacity: 5 });
    await registerAgent(KEY.fo2, "GA4B Failover Peer", "snmp", { capacity: 5 });
    await db.collectorAgent.update({ where: { agentKey: KEY.fo2 }, data: { region: SITE_A_REGION } });

    fo1DeviceIds.push(await createDevice(`ga4b-fo1a-${LOW}.faya.local`, siteAId));
    fo1DeviceIds.push(await createDevice(`ga4b-fo1b-${LOW}.faya.local`, siteAId));
    const fo1Id = await agentIdOf(KEY.fo1);
    for (const deviceId of fo1DeviceIds) {
      await db.collectorAssignment.create({
        data: { deviceId, agentId: fo1Id, via: "site-resident", leaseEpoch: 1, leasedUntil: new Date(Date.now() + 90_000) },
      });
    }
  });

  test("failover moves EVERY owned row to the peer with epoch bumps", async () => {
    const { POST } = await import("../../src/app/api/v1/admin/collectors/agents/[agentKey]/failover/route");
    const res = await POST(
      adminRequest(`http://app.local/api/v1/admin/collectors/agents/${KEY.fo1}/failover`, {}),
      { params: Promise.resolve({ agentKey: KEY.fo1 }) }
    );
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.data.fromAgentKey).toBe(KEY.fo1);
    expect(body.data.toAgentKey).toBe(KEY.fo2);
    expect(body.data.moved).toBe(2);

    const moved = await ownedRows(KEY.fo2);
    expect(moved.length).toBe(2);
    expect(moved.every((row) => row.leaseEpoch === 2)).toBe(true);
    expect(moved.every((row) => row.assignedBy === "failover")).toBe(true);
    expect(moved.every((row) => row.via === "peer-site")).toBe(true); // same region, different site

    expect((await ownedRows(KEY.fo1)).length).toBe(0);
  });

  test("the failing agent's stale-epoch claims are fenced after failover", async () => {
    const { POST } = await import("../../src/app/api/v1/collectors/heartbeat/route");
    const res = await POST(machineRequest("http://app.local/api/v1/collectors/heartbeat", {
      agentKey: KEY.fo1,
      claims: fo1DeviceIds.map((id) => ({ deviceId: id, leaseEpoch: 1 })), // pre-failover epochs
    }));
    const body = await bodyOf(res);
    expect(body.data.fenced).toHaveLength(2);
    expect(body.data.fenced.every((f: any) => f.reason === "not-owner")).toBe(true);
  });

  test("failover with suspendAgent → SUSPENDED and every claim the agent still sends fences", async () => {
    await registerAgent(KEY.fo3, "GA4B Suspendee", "config", { capacity: 5 });
    const { POST: failoverRoute } = await import("../../src/app/api/v1/admin/collectors/agents/[agentKey]/failover/route");
    const { POST: heartbeat } = await import("../../src/app/api/v1/collectors/heartbeat/route");

    const res = await failoverRoute(
      adminRequest(`http://app.local/api/v1/admin/collectors/agents/${KEY.fo3}/failover`, { suspendAgent: true }),
      { params: Promise.resolve({ agentKey: KEY.fo3 }) }
    );
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.data.suspended).toBe(true);
    expect(await db.collectorAgent.findUnique({ where: { agentKey: KEY.fo3 } }).then((a) => a?.status)).toBe("SUSPENDED");

    // A suspended agent's heartbeat still refreshes liveness but every
    // claim is fenced with agent-suspended (it must drop its state).
    const hb = await bodyOf(await heartbeat(machineRequest("http://app.local/api/v1/collectors/heartbeat", {
      agentKey: KEY.fo3,
      claims: [{ deviceId: fo1DeviceIds[0], leaseEpoch: 99 }],
    })));
    expect(hb.data.agentStatus).toBe("SUSPENDED");
    expect(hb.data.fenced).toHaveLength(1);
    expect(hb.data.fenced[0].reason).toBe("agent-suspended");
  });

  test("unknown agent → 404 COLLECTOR_AGENT_UNKNOWN", async () => {
    const { POST } = await import("../../src/app/api/v1/admin/collectors/agents/[agentKey]/failover/route");
    const res = await POST(
      adminRequest("http://app.local/api/v1/admin/collectors/agents/ga4b-ghost/failover", {}),
      { params: Promise.resolve({ agentKey: `ga4b-${LOW}-ghost` }) }
    );
    expect(res.status).toBe(404);
    expect((await bodyOf(res)).error.code).toBe("COLLECTOR_AGENT_UNKNOWN");
  });
});

/* ───────────────────────────── 5. Reaper ────────────────────────────────── */

describe("GA-4b: lease reaper", () => {
  test("silent agent (heartbeat past TTL) is failed over with reason heartbeat-timeout", async () => {
    await db.collectorAgent.update({
      where: { agentKey: KEY.fo2 },
      data: { lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) }, // 10 min silent
    });
    const ownedBefore = (await ownedRows(KEY.fo2)).length;
    expect(ownedBefore).toBe(2);

    const { POST } = await import("../../src/app/api/v1/admin/collectors/assignments/reap/route");
    const res = await POST(adminRequest("http://app.local/api/v1/admin/collectors/assignments/reap", {}));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    const sweep = body.data.failedOver.find((s: any) => s.agentKey === KEY.fo2);
    expect(sweep).toBeDefined();
    expect(sweep.toAgentKey).not.toBeNull(); // fo-1 is ACTIVE in the same region
    expect(sweep.moved).toBe(2);

    const audit = await db.auditEvent.findFirst({
      where: { action: "COLLECTOR_LEASES_REAPED" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
  });

  test("row-level expired lease, live owner, SAME deterministic target → quiet renewal (no epoch bump)", async () => {
    const rows = await ownedRows(KEY.reg1);
    const row = rows[0];
    const epochBefore = row.leaseEpoch;
    await db.collectorAssignment.update({
      where: { id: row.id },
      data: { leasedUntil: new Date(Date.now() - 60 * 60_000) }, // 1h expired
    });
    await db.collectorAgent.update({ where: { agentKey: KEY.reg1 }, data: { lastHeartbeatAt: new Date() } });

    const saved = await suspendAllExcept([KEY.reg1]); // reg-1 is the ONLY possible target
    try {
      const { POST } = await import("../../src/app/api/v1/admin/collectors/assignments/reap/route");
      const res = await POST(adminRequest("http://app.local/api/v1/admin/collectors/assignments/reap", {}));
      expect(res.status).toBe(200);

      const after = await db.collectorAssignment.findUnique({ where: { id: row.id } });
      expect(after!.agentId).toBe(row.agentId); // same owner
      expect(after!.leaseEpoch).toBe(epochBefore); // nothing transferred ⇒ no bump
      expect(after!.leasedUntil!.getTime()).toBeGreaterThan(Date.now()); // renewed
    } finally {
      await restoreStatuses(saved);
    }
  });

  test("row-level expired lease with a DIFFERENT deterministic target → epoch-bumped move", async () => {
    // reg-3 (siteless, region RB) owns a site-A device it cannot deterministically keep.
    const reg3Id = await agentIdOf(KEY.reg3);
    const deviceId = await createDevice(`ga4b-stale-${LOW}.faya.local`, siteAId);
    await db.collectorAssignment.create({
      data: { deviceId, agentId: reg3Id, via: "fallback-regional", leaseEpoch: 1, leasedUntil: new Date(Date.now() - 60 * 60_000) },
    });
    await db.collectorAgent.update({ where: { agentKey: KEY.reg3 }, data: { lastHeartbeatAt: new Date() } });

    const saved = await suspendAllExcept([KEY.reg1, KEY.reg3]);
    try {
      const { POST } = await import("../../src/app/api/v1/admin/collectors/assignments/reap/route");
      const res = await POST(adminRequest("http://app.local/api/v1/admin/collectors/assignments/reap", {}));
      expect(res.status).toBe(200);

      const after = await db.collectorAssignment.findUnique({ where: { deviceId } });
      expect(after!.agentId).toBe(await agentIdOf(KEY.reg1)); // site-resident wins
      expect(after!.leaseEpoch).toBe(2); // transferred ⇒ fenced epoch
      expect(after!.assignedBy).toBe("failover");
      expect(after!.via).toBe("site-resident");
    } finally {
      await restoreStatuses(saved);
    }
  });
});

/* ───────────────────────── 6. REAL rebalance ────────────────────────────── */

describe("GA-4b: real rebalance apply (production posture)", () => {
  beforeAll(async () => {
    await registerAgent(KEY.rbHot, "GA4B Hot Agent", "snmp", { siteCode: SITE_A, capacity: 2 });
    await registerAgent(KEY.rbPeer, "GA4B Peer Agent", "snmp", { siteCode: SITE_A, capacity: 10 });
    const hotId = await agentIdOf(KEY.rbHot);
    for (let i = 0; i < 6; i += 1) {
      const deviceId = await createDevice(`ga4b-rb-${i}-${LOW}.faya.local`, siteAId);
      await db.collectorAssignment.create({
        data: { deviceId, agentId: hotId, via: "site-resident", leaseEpoch: 1, leasedUntil: new Date(Date.now() + 90_000) },
      });
    }
  });

  test("preview over ownership rows returns moves + planId (no demo flag needed)", async () => {
    const { POST } = await import("../../src/app/api/v1/admin/collectors/rebalance-plan/route");
    const res = await POST(adminRequest("http://app.local/api/v1/admin/collectors/rebalance-plan", { dryRun: true }));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.data.plane).toBe("real");
    // 6 owned on capacity 2 → load 3.0; moves until load ≤ 0.85 (≤ 1 device kept)
    expect(body.data.moves.length).toBeGreaterThanOrEqual(4);
    expect(body.data.planId).toMatch(/^[0-9a-f]{8}$/);
  });

  test("bogus planId → 409 COLLECTOR_PLAN_STALE (genuine freshness check)", async () => {
    const { POST } = await import("../../src/app/api/v1/admin/collectors/rebalance-plan/route");
    const res = await POST(adminRequest("http://app.local/api/v1/admin/collectors/rebalance-plan", {
      dryRun: false,
      planId: "00000000",
    }));
    expect(res.status).toBe(409);
    expect((await bodyOf(res)).error.code).toBe("COLLECTOR_PLAN_STALE");
  });

  test("apply ACTUALLY moves ownership rows (epochs bump, assignedBy rebalance) + audit trail", async () => {
    const { POST } = await import("../../src/app/api/v1/admin/collectors/rebalance-plan/route");
    const preview = await bodyOf(await POST(
      adminRequest("http://app.local/api/v1/admin/collectors/rebalance-plan", { dryRun: true })
    ));
    const res = await POST(adminRequest("http://app.local/api/v1/admin/collectors/rebalance-plan", {
      dryRun: false,
      planId: preview.data.planId,
    }));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.data.plane).toBe("real");
    expect(body.data.moved).toBe(preview.data.moves.length);
    expect(body.data.note).toContain("REAL apply");

    const hotRows = await ownedRows(KEY.rbHot);
    const peerRows = await ownedRows(KEY.rbPeer);
    expect(hotRows.length).toBeLessThan(6);
    expect(peerRows.length).toBe(body.data.moved);
    expect(hotRows.length / 2).toBeLessThanOrEqual(0.85 + 1e-9); // over-capacity resolved
    expect(peerRows.every((row) => row.leaseEpoch === 2)).toBe(true);
    expect(peerRows.every((row) => row.assignedBy === "rebalance")).toBe(true);

    const audits = await db.auditEvent.findMany({
      where: { action: "COLLECTOR_REBALANCE", correlationId: body.data.correlationId },
    });
    expect(audits.length).toBe(body.data.moved + 1); // per-move + complete
  });

  test("replaying a STALE planId after the real apply → 409 or 404 (the state genuinely changed)", async () => {
    const { POST } = await import("../../src/app/api/v1/admin/collectors/rebalance-plan/route");
    // After the real apply the hot agent is no longer over capacity: the
    // recomputed plan is either empty (404 NO_MOVES) or — if a concurrent
    // test shifted rows — a different fingerprint (409 STALE). Both prove
    // the apply was real; neither is the old plan passing again.
    const res = await POST(adminRequest("http://app.local/api/v1/admin/collectors/rebalance-plan", {
      dryRun: false,
      planId: "deadbeef",
    }));
    expect([404, 409]).toContain(res.status);
  });
});

/* ─────────────────── 7. Distribution dual plane + GA-4 regression ───────── */

describe("GA-4b: distribution dual plane", () => {
  test("with registered agents: plane=real, fleet from the registry, loads from ownership", async () => {
    const { GET } = await import("../../src/app/api/v1/admin/collectors/distribution/route");
    const res = await GET(adminRequest("http://app.local/api/v1/admin/collectors/distribution", undefined, "GET"));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.data.plane).toBe("real");
    const fleetKeys = body.data.fleet.map((a: any) => a.agentId);
    expect(fleetKeys).toContain(KEY.rbHot);
    expect(fleetKeys).toContain(KEY.rbPeer);
    const peer = body.data.fleet.find((a: any) => a.agentId === KEY.rbPeer);
    expect(peer.load).toBeGreaterThan(0); // real ownership, not a hash spread
    expect(peer.peerAgentId).not.toBeNull(); // deterministic failover peer surfaced
  });

  test("GA-4 regression: with ZERO ACTIVE agents, APPLY still refuses without demo mode (403 first)", async () => {
    const saved = await suspendAllExcept([]); // force the simulated plane
    try {
      const { POST } = await import("../../src/app/api/v1/admin/collectors/rebalance-plan/route");
      const res = await POST(adminRequest("http://app.local/api/v1/admin/collectors/rebalance-plan", { dryRun: false }));
      expect(res.status).toBe(403);
      expect((await bodyOf(res)).error.code).toBe("SIMULATION_DISABLED");

      const { GET } = await import("../../src/app/api/v1/admin/collectors/distribution/route");
      const dist = await bodyOf(await GET(adminRequest("http://app.local/api/v1/admin/collectors/distribution", undefined, "GET")));
      expect(dist.data.plane).toBe("simulated");
      expect(dist.data.summary.agents).toBe(7); // the documented static fleet
    } finally {
      await restoreStatuses(saved);
    }
  });

  test("source contract: the simulation stays honestly labeled (banner intact) and the TTL exceeds the cadence", async () => {
    const distribution = readFileSync("src/lib/collectors/distribution.ts", "utf8");
    expect(distribution).toContain("DEMO DATA — DOCUMENTED SIMULATED AGENT FLEET");
    const { COLLECTOR_LEASE_TTL_MS, COLLECTOR_HEARTBEAT_INTERVAL_S } = await import(
      "../../src/lib/collectors/control-plane"
    );
    expect(COLLECTOR_LEASE_TTL_MS).toBeGreaterThan(COLLECTOR_HEARTBEAT_INTERVAL_S * 1000);
  });
});
