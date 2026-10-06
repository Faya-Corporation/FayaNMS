/**
 * GA-2 (2026-10-06 re-audit): P1-A01 report data scoping + P2 per-user
 * notification read receipts.
 *
 * P1-A01 — report generation no longer bypasses human site scope:
 *   - generateReport() takes an explicit frozen SiteScope; every generator
 *     with a site dimension intersects it (availability, backup compliance,
 *     capacity: the device leg; incidents: the IncidentDevice join);
 *   - CHANGE_SUMMARY has no site dimension on its rows — a site-limited
 *     artifact carries an explicit scopeNote saying the aggregates remain
 *     fleet-wide (honesty note, never silent);
 *   - POST /api/v1/reports/run freezes the ACTING session's scope;
 *   - POST /api/v1/reports/schedules freezes the creating session's scope
 *     into ReportSchedule.scopeJson (immutable, NOT PATCHable);
 *   - the worker path (POST /api/v1/reports/execute) uses the SCHEDULE's
 *     frozen scope — the worker's global service identity can never widen
 *     it. The service plane authenticates the call; it does not scope it.
 *
 * P2 — broadcast notifications get PER-USER read state via
 * NotificationReceipt: one user marking a broadcast read no longer marks it
 * read for everyone; the broadcast row's own readAt stays null.
 *
 * Certified rig (batch-25/wave-9 discipline): real next-auth JWTs, real
 * HS256 service token for the worker-plane gate, RUN-suffixed fixtures,
 * surgical afterAll cleanup.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";
import { createHmac, randomUUID } from "node:crypto";

import { db } from "../../src/lib/db";
import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";
import {
  generateReport,
  reportScopeFromJson,
  reportScopeJsonForClaims,
} from "../../src/lib/reports/generate";

/* ── fixtures (RUN-suffixed — parallel-safe, re-runnable) ─────────────── */

const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
const PREFIX = `ga2-`;
const SITE_A_CODE = `G2A-${RUN}`; // in scope
const SITE_B_CODE = `G2B-${RUN}`; // out of scope
const HOST_A = `${PREFIX}dev-a-${RUN.toLowerCase()}`;
const HOST_B = `${PREFIX}dev-b-${RUN.toLowerCase()}`;
const USER1_EMAIL = `${PREFIX}u1-${RUN.toLowerCase()}@faya.local`;
const USER2_EMAIL = `${PREFIX}u2-${RUN.toLowerCase()}@faya.local`;

const testStartedAt = new Date();

let orgId = "";
let siteAId = "";
let siteBId = "";
let vendorId = "";
let deviceAId = "";
let deviceBId = "";
let user1Id = ""; // wildcard admin (run/schedule freeze pin: wildcard → null)
let user2Id = ""; // site-limited admin (sites: [A])
let incidentAId = "";
let incidentBId = "";
const createdScheduleIds: string[] = [];
const createdJobIds: string[] = [];
const createdNotificationIds: string[] = [];

type SessionShape = { id: string; email: string; name: string | null; role: string; sites?: unknown };

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

async function user1Jwt(): Promise<string> {
  return mintSessionJwt({ id: user1Id, email: USER1_EMAIL, name: "GA-2 U1", role: "admin" });
}

async function user2Jwt(): Promise<string> {
  return mintSessionJwt({
    id: user2Id,
    email: USER2_EMAIL,
    name: "GA-2 U2",
    role: "admin",
    sites: [SITE_A_CODE],
  });
}

function jsonRequest(method: string, url: string, jwt: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: `next-auth.session-token=${jwt}`,
    },
    body: JSON.stringify(body),
  });
}

/** HS256 service token for the worker-plane gate (iss fayanms:worker). */
function mintServiceJwt(): string {
  const secret = process.env.FAYANMS_SERVICE_SECRET ?? "";
  const nowS = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      iss: "fayanms:worker",
      sub: `ga2-test-${RUN.toLowerCase()}`,
      aud: "fayanms:internal",
      iat: nowS,
      exp: nowS + 300,
      jti: randomUUID(),
      scopes: ["reports"],
    })
  ).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${signature}`;
}

type Envelope = { success?: boolean; data?: unknown; meta?: Record<string, unknown>; error?: { code?: string } };

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

beforeAll(async () => {
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

  const u1 = await db.user.create({
    data: { email: USER1_EMAIL, name: "GA-2 U1", role: "admin", isActive: true },
    select: { id: true },
  });
  user1Id = u1.id;
  const u2 = await db.user.create({
    data: { email: USER2_EMAIL, name: "GA-2 U2", role: "admin", isActive: true },
    select: { id: true },
  });
  user2Id = u2.id;

  const org = await db.organization.create({ data: { name: `${PREFIX}org-${RUN}` } });
  orgId = org.id;
  const siteA = await db.site.create({
    data: { name: `GA-2 Site A ${RUN}`, code: SITE_A_CODE, organizationId: orgId },
  });
  siteAId = siteA.id;
  const siteB = await db.site.create({
    data: { name: `GA-2 Site B ${RUN}`, code: SITE_B_CODE, organizationId: orgId },
  });
  siteBId = siteB.id;

  const vendor = await db.vendor.create({
    data: { key: `${PREFIX}vendor-${RUN}`, name: `GA-2 Vendor ${RUN}`, adapterKey: "generic" },
  });
  vendorId = vendor.id;

  const devA = await db.device.create({
    data: { hostname: HOST_A, mgmtIp: "192.0.2.31", vendorId, siteId: siteAId, status: "ONLINE" },
  });
  deviceAId = devA.id;
  const devB = await db.device.create({
    data: { hostname: HOST_B, mgmtIp: "192.0.2.32", vendorId, siteId: siteBId, status: "ONLINE" },
  });
  deviceBId = devB.id;

  // Rollups so availability/capacity have rows for BOTH devices (the scoping
  // assertion: A appears, B must not).
  const hourBase = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  for (const deviceId of [deviceAId, deviceBId]) {
    for (let k = 1; k <= 4; k += 1) {
      await db.metricRollup.create({
        data: {
          deviceId,
          metric: "AVAILABILITY",
          granularity: "1H",
          periodStart: new Date(hourBase - k * HOUR_MS),
          avg: 99.5,
          max: 100,
          min: 98,
          p95: 99.9,
        },
      });
    }
  }
  const dayBase = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  for (const deviceId of [deviceAId, deviceBId]) {
    for (let k = 1; k <= 6; k += 1) {
      for (const metric of ["CPU", "UTILIZATION_IN", "UTILIZATION_OUT"]) {
        await db.metricRollup.create({
          data: {
            deviceId,
            metric,
            granularity: "1D",
            periodStart: new Date(dayBase - k * DAY_MS),
            avg: 40 + k,
            max: 60,
            min: 20,
            p95: 55,
          },
        });
      }
    }
  }

});

afterAll(async () => {
  await db.jobExecution.deleteMany({ where: { id: { in: createdJobIds } } });
  await db.reportSchedule.deleteMany({ where: { id: { in: createdScheduleIds } } });
  await db.notificationReceipt.deleteMany({
    where: { notificationId: { in: createdNotificationIds } },
  });
  await db.notification.deleteMany({ where: { id: { in: createdNotificationIds } } });
  await db.auditEvent.deleteMany({
    where: {
      createdAt: { gte: testStartedAt },
      OR: [
        { resourceType: "ReportSchedule", resourceId: { in: createdScheduleIds } },
        { action: "REPORT_GENERATED" },
      ],
    },
  });
  await db.incident.deleteMany({ where: { id: { in: [incidentAId, incidentBId].filter(Boolean) } } });
  await db.metricRollup.deleteMany({ where: { deviceId: { in: [deviceAId, deviceBId] } } });
  await db.metricSample.deleteMany({ where: { deviceId: { in: [deviceAId, deviceBId] } } });
  await db.device.deleteMany({ where: { id: { in: [deviceAId, deviceBId].filter(Boolean) } } });
  await db.vendor.deleteMany({ where: { id: vendorId } });
  await db.site.deleteMany({ where: { id: { in: [siteAId, siteBId].filter(Boolean) } } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.user.deleteMany({ where: { id: { in: [user1Id, user2Id].filter(Boolean) } } });
});

/* ── scope freeze/parse helpers ────────────────────────────────────────── */

describe("GA-2: report scope serialization helpers", () => {
  test("reportScopeFromJson: null → wildcard; codes → sites; malformed/[] → deny-all", () => {
    expect(reportScopeFromJson(null)).toEqual({ mode: "wildcard" });
    expect(reportScopeFromJson(undefined)).toEqual({ mode: "wildcard" });
    expect(reportScopeFromJson(JSON.stringify(["A", "B"]))).toEqual({ mode: "sites", codes: ["A", "B"] });
    expect(reportScopeFromJson("[]")).toEqual({ mode: "sites", codes: [] });
    expect(reportScopeFromJson("not-json")).toEqual({ mode: "sites", codes: [] });
    expect(reportScopeFromJson('{"x":1}')).toEqual({ mode: "sites", codes: [] });
  });

  test("reportScopeJsonForClaims: wildcard → null; sites → JSON; deny-all → '[]'; malformed → '[]'", () => {
    expect(reportScopeJsonForClaims(null)).toBeNull();
    expect(reportScopeJsonForClaims(undefined)).toBeNull();
    expect(reportScopeJsonForClaims({})).toBeNull();
    expect(reportScopeJsonForClaims({ sites: ["A"] })).toBe(JSON.stringify(["A"]));
    expect(reportScopeJsonForClaims({ sites: [] })).toBe("[]");
    expect(reportScopeJsonForClaims({ sites: "garbage" })).toBe("[]");
  });
});

/* ── P1-A01: generators intersect the frozen scope ─────────────────────── */

describe("GA-2: generateReport intersects the frozen scope", () => {
  test("AVAILABILITY: site-limited scope keeps only in-scope device rows", async () => {
    const scoped = await generateReport("AVAILABILITY", {
      frequency: "DAILY",
      scope: { mode: "sites", codes: [SITE_A_CODE] },
    });
    const hostnames = scoped.rows.map((r) => r.hostname);
    expect(hostnames).toContain(HOST_A);
    expect(hostnames).not.toContain(HOST_B);

    const wildcard = await generateReport("AVAILABILITY", {
      frequency: "DAILY",
      scope: { mode: "wildcard" },
    });
    const wildcardHosts = wildcard.rows.map((r) => r.hostname);
    expect(wildcardHosts).toContain(HOST_A);
    expect(wildcardHosts).toContain(HOST_B); // wildcard parity
  });

  test("AVAILABILITY: deny-all scope yields an empty artifact", async () => {
    const artifact = await generateReport("AVAILABILITY", {
      frequency: "DAILY",
      scope: { mode: "sites", codes: [] },
    });
    expect(artifact.rows).toHaveLength(0);
  });

  test("BACKUP_COMPLIANCE: site-limited scope keeps only in-scope rows", async () => {
    const scoped = await generateReport("BACKUP_COMPLIANCE", {
      scope: { mode: "sites", codes: [SITE_A_CODE] },
    });
    const hostnames = scoped.rows.map((r) => r.hostname);
    expect(hostnames).toContain(HOST_A);
    expect(hostnames).not.toContain(HOST_B);
  });

  test("CAPACITY: site-limited scope keeps only in-scope rows", async () => {
    const scoped = await generateReport("CAPACITY", {
      frequency: "DAILY",
      scope: { mode: "sites", codes: [SITE_A_CODE] },
    });
    const hostnames = scoped.rows.map((r) => r.hostname);
    if (hostnames.length > 0) {
      expect(hostnames).not.toContain(HOST_B);
    }
    const wildcard = await generateReport("CAPACITY", {
      frequency: "DAILY",
      scope: { mode: "wildcard" },
    });
    expect(wildcard.rows.map((r) => r.hostname)).toContain(HOST_B);
  });

  test("INCIDENT_SUMMARY: incidents outside the device scope are not counted", async () => {
    // Format-conforming numbers (INC-YYYY-NNNNN) — the allocator suites
    // parse the numeric part of EVERY incident row while this suite shares
    // the database, so fixtures must never poison it. Created lazily here
    // and removed at test end to shrink the shared-state window.
    const seq = String((parseInt(RUN, 36) % 80000) + 10000); // 5 digits, RUN-derived
    const incA = await db.incident.create({
      data: {
        number: `INC-2026-${seq}`,
        title: `${PREFIX}inc-a`,
        severity: "SEV3",
        status: "OPEN",
        devices: { create: { deviceId: deviceAId } },
      },
    });
    const incB = await db.incident.create({
      data: {
        number: `INC-2026-${String(Number(seq) + 1).padStart(5, "0")}`,
        title: `${PREFIX}inc-b`,
        severity: "SEV3",
        status: "OPEN",
        devices: { create: { deviceId: deviceBId } },
      },
    });
    incidentAId = incA.id;
    incidentBId = incB.id;
    try {
      await assertIncidentScoping();
    } finally {
      await db.incident.deleteMany({ where: { id: { in: [incA.id, incB.id] } } });
      incidentAId = "";
      incidentBId = "";
    }
  });

  async function assertIncidentScoping(): Promise<void> {
    const scoped = await generateReport("INCIDENT_SUMMARY", {
      frequency: "MONTHLY",
      scope: { mode: "sites", codes: [SITE_A_CODE] },
    });
    const scopedCreated = scoped.rows.reduce((acc, r) => acc + Number(r.created ?? 0), 0);
    expect(scopedCreated).toBe(1); // only the site-A incident

    const wildcard = await generateReport("INCIDENT_SUMMARY", {
      frequency: "MONTHLY",
      scope: { mode: "wildcard" },
    });
    const wildcardCreated = wildcard.rows.reduce((acc, r) => acc + Number(r.created ?? 0), 0);
    expect(wildcardCreated).toBeGreaterThanOrEqual(2); // both fixtures
  }

  test("CHANGE_SUMMARY: fleet-wide rows carry an explicit honesty note under site scope", async () => {
    const scoped = await generateReport("CHANGE_SUMMARY", {
      frequency: "MONTHLY",
      scope: { mode: "sites", codes: [SITE_A_CODE] },
    });
    expect(scoped.scopeNote).toContain("fleet-wide");

    const wildcard = await generateReport("CHANGE_SUMMARY", {
      frequency: "MONTHLY",
      scope: { mode: "wildcard" },
    });
    expect(wildcard.scopeNote).toBeUndefined();
  });
});

/* ── P1-A01: freeze at creation, execute under the frozen scope ────────── */

describe("GA-2: schedule scope freeze + worker-path execution", () => {
  test("POST /reports/schedules freezes the creating session's scope", async () => {
    const POSTmod = await import("../../src/app/api/v1/reports/schedules/route");
    const base = {
      name: `${PREFIX}sched-${RUN}`,
      reportType: "AVAILABILITY" as const,
      frequency: "DAILY" as const,
      format: "CSV" as const,
      recipients: [`ga2-${RUN.toLowerCase()}@faya.local`],
    };

    const asUser2 = await POSTmod.POST(jsonRequest("POST", "http://app.local/api/v1/reports/schedules", await user2Jwt(), base));
    expect(asUser2.status).toBe(201);
    const created2 = ((await asUser2.json()) as Envelope).data as { schedule: { id: string } };
    createdScheduleIds.push(created2.schedule.id);
    const row2 = await db.reportSchedule.findUnique({ where: { id: created2.schedule.id } });
    expect(row2!.scopeJson).toBe(JSON.stringify([SITE_A_CODE])); // frozen at creation

    const asUser1 = await POSTmod.POST(jsonRequest("POST", "http://app.local/api/v1/reports/schedules", await user1Jwt(), {
      ...base,
      name: `${PREFIX}sched-w-${RUN}`,
    }));
    expect(asUser1.status).toBe(201);
    const created1 = ((await asUser1.json()) as Envelope).data as { schedule: { id: string } };
    createdScheduleIds.push(created1.schedule.id);
    const row1 = await db.reportSchedule.findUnique({ where: { id: created1.schedule.id } });
    expect(row1!.scopeJson).toBeNull(); // wildcard freeze = null
  });

  test("worker execute path: artifact is scoped by the SCHEDULE's frozen scope, not the service identity", async () => {
    // Schedule frozen by the site-limited user.
    const schedule = await db.reportSchedule.create({
      data: {
        name: `${PREFIX}exec-${RUN}`,
        reportType: "AVAILABILITY",
        frequency: "DAILY",
        format: "CSV",
        recipientsJson: JSON.stringify([`ga2-${RUN.toLowerCase()}@faya.local`]),
        scopeJson: JSON.stringify([SITE_A_CODE]),
      },
    });
    createdScheduleIds.push(schedule.id);

    // A RUNNING REPORT_RUN job (the state the execute route requires).
    const job = await db.jobExecution.create({
      data: {
        type: "REPORT_RUN",
        status: "RUNNING",
        targetId: schedule.id,
        payloadJson: JSON.stringify({ scheduleId: schedule.id }),
        correlationId: `REP-GA2-${RUN}`,
      },
    });
    createdJobIds.push(job.id);

    const { POST } = await import("../../src/app/api/v1/reports/execute/route");
    const res = await POST(
      new Request("http://localhost:3000/api/v1/reports/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${mintServiceJwt()}`,
        },
        body: JSON.stringify({ jobId: job.id }),
      })
    );
    expect(res.status).toBe(200);

    // The artifact stored on the job must contain ONLY site-A rows.
    const stored = await db.jobExecution.findUnique({ where: { id: job.id }, select: { resultJson: true } });
    const artifact = JSON.parse(stored!.resultJson!) as { rows: Array<{ hostname: string }> };
    const hostnames = artifact.rows.map((r) => r.hostname);
    expect(hostnames).toContain(HOST_A);
    expect(hostnames).not.toContain(HOST_B); // the worker could not widen it
  });
});

/* ── P2: per-user broadcast read receipts ──────────────────────────────── */

describe("GA-2: notifications per-user read receipts", () => {
  async function createBroadcast(title: string): Promise<string> {
    const row = await db.notification.create({
      data: { kind: "SYSTEM", title, body: `${title} body` },
    });
    createdNotificationIds.push(row.id);
    return row.id;
  }

  test("one user marking a broadcast read leaves it unread for the other", async () => {
    const broadcastId = await createBroadcast(`${PREFIX}broadcast-${RUN}`);

    const readMod = await import("../../src/app/api/v1/notifications/read/route");
    const readRes = await readMod.POST(
      jsonRequest("POST", "http://app.local/api/v1/notifications/read", await user1Jwt(), {
        ids: [broadcastId],
      })
    );
    expect(readRes.status).toBe(200);
    const readBody = (await readRes.json()) as Envelope;
    expect(readBody.success).toBe(true);

    // The broadcast ROW keeps readAt null (nobody-read baseline).
    const row = await db.notification.findUnique({ where: { id: broadcastId } });
    expect(row!.readAt).toBeNull();
    // User 1 has a receipt.
    const receipt = await db.notificationReceipt.findUnique({
      where: { notificationId_userId: { notificationId: broadcastId, userId: user1Id } },
    });
    expect(receipt).not.toBeNull();

    // The list for user 2 still shows it UNREAD.
    const listMod = await import("../../src/app/api/v1/notifications/route");
    const listRes = await listMod.GET(
      new NextRequest("http://app.local/api/v1/notifications?unreadOnly=true", {
        headers: { cookie: `next-auth.session-token=${await user2Jwt()}` },
      })
    );
    const listBody = (await listRes.json()) as Envelope;
    const rows = listBody.data as Array<{ id: string; readAt: string | null }>;
    expect(rows.some((r) => r.id === broadcastId)).toBe(true);

    // User 1's unread list does NOT contain it.
    const listRes1 = await listMod.GET(
      new NextRequest("http://app.local/api/v1/notifications?unreadOnly=true", {
        headers: { cookie: `next-auth.session-token=${await user1Jwt()}` },
      })
    );
    const listBody1 = (await listRes1.json()) as Envelope;
    const rows1 = listBody1.data as Array<{ id: string; readAt: string | null }>;
    expect(rows1.some((r) => r.id === broadcastId)).toBe(false);
  });

  test("all:true is per-user and idempotent", async () => {
    const broadcastId = await createBroadcast(`${PREFIX}all-${RUN}`);

    const readMod = await import("../../src/app/api/v1/notifications/read/route");
    const first = await readMod.POST(
      jsonRequest("POST", "http://app.local/api/v1/notifications/read", await user1Jwt(), { all: true })
    );
    const firstBody = (await first.json()) as Envelope;
    expect(firstBody.success).toBe(true);

    const second = await readMod.POST(
      jsonRequest("POST", "http://app.local/api/v1/notifications/read", await user1Jwt(), { all: true })
    );
    const secondBody = (await second.json()) as Envelope;
    // Idempotent: marking everything read again reports zero updates for u1.
    expect((secondBody.data as { updated: number }).updated).toBe(0);

    // User 2 still sees the broadcast unread.
    const row = await db.notification.findUnique({ where: { id: broadcastId } });
    expect(row!.readAt).toBeNull();
    const receipt = await db.notificationReceipt.findUnique({
      where: { notificationId_userId: { notificationId: broadcastId, userId: user2Id } },
    });
    expect(receipt).toBeNull();
  });
});
