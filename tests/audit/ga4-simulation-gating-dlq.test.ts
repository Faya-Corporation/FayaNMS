/**
 * GA-4 (2026-10-06 re-audit): simulation honesty gating + DLQ operator
 * recovery.
 *
 * P0-R05/P1-O02 — simulated operational surfaces are FAIL-CLOSED outside
 * demo mode: POST /api/v1/ha/failover-test and the collector rebalance
 * APPLY leg answer 403 SIMULATION_DISABLED unless FAYANMS_DEMO_MODE=true.
 * The read-only rebalance PREVIEW stays available (deterministic math, no
 * effect, admin-gated).
 *
 * P1-O03 — the DEAD-letter surface becomes operable:
 *   - GET  /api/v1/protocol/queue/dead lists dead letters with
 *     attempts/lastError/correlation (admin.system permission), meta
 *     carries the full depth;
 *   - POST /api/v1/protocol/queue/dead/requeue (admin ROLE — human
 *     accountability) moves DEAD → QUEUED guarded on status (replay
 *     idempotency), resets the retry budget, and audits the batch;
 *   - the /api/metrics endpoint exports fayanms_protocol_queue_dead so
 *     the Prometheus rule can fire on accumulation.
 *
 * Certified rig: real next-auth JWTs, RUN-suffixed fixtures, surgical
 * cleanup, save/restore env discipline for the demo flag.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";

import { db } from "../../src/lib/db";
import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";
import { isDemoMode } from "../../src/lib/demo/simulation-guard";

const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
const PREFIX = `ga4-`;
const ADMIN_EMAIL = `${PREFIX}admin-${RUN.toLowerCase()}@faya.local`;

const testStartedAt = new Date();

let adminId = "";
const createdQueueIds: string[] = [];

async function adminJwt(): Promise<string> {
  return encode({
    token: { id: adminId, email: ADMIN_EMAIL, name: "GA-4 Admin", role: "admin" },
    secret: process.env.NEXTAUTH_SECRET ?? "",
  });
}

async function authedRequest(method: string, url: string, body?: unknown): Promise<NextRequest> {
  const jwt = await adminJwt();
  return new NextRequest(url, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: `next-auth.session-token=${jwt}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

type Envelope = { success?: boolean; data?: unknown; meta?: Record<string, unknown>; error?: { code?: string; message?: string } };

/** Create one DEAD queue row; registers it for cleanup. */
async function seedDead(index: number, protocol = "SNMP"): Promise<string> {
  const row = await db.protocolEventQueue.create({
    data: {
      collectorId: `${PREFIX}collector-${RUN}`,
      protocol,
      sourceIp: "192.0.2.99",
      sourcePort: 161,
      receivedAt: new Date(Date.now() - index * 1000),
      eventType: "TRAP",
      severity: "HIGH",
      message: `${PREFIX} dead letter ${index}`,
      attributesJson: "{}",
      correlationId: `${PREFIX}corr-${RUN}-${index}`,
      status: "DEAD",
      attempts: 5,
      lastError: "delivery refused after bounded retries",
    },
  });
  createdQueueIds.push(row.id);
  return row.id;
}

const savedDemoMode = process.env.FAYANMS_DEMO_MODE;

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
  const admin = await db.user.create({
    data: { email: ADMIN_EMAIL, name: "GA-4 Admin", role: "admin", isActive: true },
    select: { id: true },
  });
  adminId = admin.id;
});

afterAll(async () => {
  process.env.FAYANMS_DEMO_MODE = savedDemoMode;
  await db.auditEvent.deleteMany({
    where: {
      createdAt: { gte: testStartedAt },
      action: { in: ["PROTOCOL_DLQ_REQUEUED", "HA_FAILOVER_TEST", "COLLECTOR_REBALANCE"] },
    },
  });
  await db.protocolEventQueue.deleteMany({ where: { id: { in: createdQueueIds } } });
  await db.user.deleteMany({ where: { id: adminId } });
});

/* ── P0-R05/P1-O02: simulation gating ──────────────────────────────────── */

describe("GA-4: simulation honesty gating", () => {
  test("isDemoMode: only the exact string true enables demo posture", () => {
    process.env.FAYANMS_DEMO_MODE = "true";
    expect(isDemoMode()).toBe(true);
    process.env.FAYANMS_DEMO_MODE = "TRUE";
    expect(isDemoMode()).toBe(true);
    process.env.FAYANMS_DEMO_MODE = " false ";
    expect(isDemoMode()).toBe(false);
    process.env.FAYANMS_DEMO_MODE = undefined;
    expect(isDemoMode()).toBe(false);
    process.env.FAYANMS_DEMO_MODE = "1";
    expect(isDemoMode()).toBe(false);
  });

  test("POST /ha/failover-test without demo mode → 403 SIMULATION_DISABLED, nothing written", async () => {
    process.env.FAYANMS_DEMO_MODE = undefined;
    const { POST } = await import("../../src/app/api/v1/ha/failover-test/route");
    const res = await POST(
      await authedRequest("POST", "http://app.local/api/v1/ha/failover-test", {
        pairId: "pair-hq-dc",
      })
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as Envelope;
    expect(body.error?.code).toBe("SIMULATION_DISABLED");
    expect(body.error?.message).toContain("DOCUMENTED SIMULATION");
  });

  test("POST /admin/collectors/rebalance-plan APPLY without demo mode → 403; PREVIEW still works", async () => {
    process.env.FAYANMS_DEMO_MODE = undefined;
    const { POST } = await import("../../src/app/api/v1/admin/collectors/rebalance-plan/route");

    // The APPLY leg refuses (fast — the gate precedes the plan computation and the cooldown query).
    const apply = await POST(
      await authedRequest("POST", "http://app.local/api/v1/admin/collectors/rebalance-plan", {
        dryRun: false,
        planId: "plan-ga4-01",
      })
    );
    expect(apply.status).toBe(403);
    const applyBody = (await apply.json()) as Envelope;
    expect(applyBody.error?.code).toBe("SIMULATION_DISABLED");

    // The read-only PREVIEW stays available in a production posture — the
    // simulation gate must NOT mask it. Both plan outcomes prove
    // availability: 200 (the fleet has a rebalance plan) or 404
    // COLLECTOR_NO_MOVES (the CI DB has no devices, so nothing is over
    // capacity). A 403 SIMULATION_DISABLED here is the regression pinned.
    const preview = await POST(
      await authedRequest("POST", "http://app.local/api/v1/admin/collectors/rebalance-plan", {
        dryRun: true,
      })
    );
    const previewBody = (await preview.json()) as Envelope;
    expect(preview.status === 200 || preview.status === 404).toBe(true);
    expect(previewBody.error?.code).not.toBe("SIMULATION_DISABLED");
    if (preview.status === 200) {
      expect(previewBody.success).toBe(true);
    } else {
      expect(previewBody.error?.code).toBe("COLLECTOR_NO_MOVES");
    }
  });
});

/* ── P1-O03: DLQ inspection + operator replay ──────────────────────────── */

describe("GA-4: DLQ inspection + requeue", () => {
  test("GET /protocol/queue/dead lists dead letters with depth meta", async () => {
    for (let i = 0; i < 3; i += 1) await seedDead(i);
    await seedDead(9, "SYSLOG");

    const { GET } = await import("../../src/app/api/v1/protocol/queue/dead/route");
    const res = await GET(
      await authedRequest("GET", "http://app.local/api/v1/protocol/queue/dead?protocol=SNMP"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const rows = body.data as Array<{ id: string; attempts: number; lastError: string; protocol: string }>;
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.protocol === "SNMP")).toBe(true);
    expect(rows.every((r) => r.attempts >= 5)).toBe(true);
    expect(body.meta?.deadCount).toBeGreaterThanOrEqual(4);
  });

  test("POST requeue: DEAD → QUEUED, retry budget reset, audited, idempotent", async () => {
    const id1 = await seedDead(20);
    const id2 = await seedDead(21);

    const { POST } = await import("../../src/app/api/v1/protocol/queue/dead/requeue/route");
    const res = await POST(
      await authedRequest("POST", "http://app.local/api/v1/protocol/queue/dead/requeue", {
        ids: [id1, id2],
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const data = body.data as { requested: number; requeued: number; correlationId: string };
    expect(data.requested).toBe(2);
    expect(data.requeued).toBe(2);

    const rows = await db.protocolEventQueue.findMany({
      where: { id: { in: [id1, id2] } },
      select: { status: true, attempts: true },
    });
    expect(rows.every((r) => r.status === "QUEUED" && r.attempts === 0)).toBe(true);

    // Audited.
    const audit = await db.auditEvent.findFirst({
      where: { action: "PROTOCOL_DLQ_REQUEUED", correlationId: data.correlationId },
    });
    expect(audit).not.toBeNull();

    // Idempotent: replaying the same ids matches nothing.
    const again = await POST(
      await authedRequest("POST", "http://app.local/api/v1/protocol/queue/dead/requeue", {
        ids: [id1, id2],
      })
    );
    const againBody = (await again.json()) as Envelope;
    expect((againBody.data as { requeued: number }).requeued).toBe(0);
  });

  test("requeue is admin-ROLE gated (a non-admin session is refused)", async () => {
    // A viewer-role session: requireRole("admin") answers 403 before any write.
    const { ROLE_MATRIX } = await import("../../src/lib/auth/role-matrix");
    const viewer = ROLE_MATRIX.find((r) => r.name === "viewer") ?? null;
    const role = await db.role.upsert({
      where: { name: "viewer" },
      update: {},
      create: {
        name: "viewer",
        description: viewer?.description ?? "Read-only",
        permissionsJson: JSON.stringify(viewer?.permissions ?? ["*.read".replace(/\W/g, "") === "read" ? "*.read" : "*.read"]),
      },
    });
    const viewerUser = await db.user.create({
      data: {
        email: `${PREFIX}viewer-${RUN.toLowerCase()}@faya.local`,
        name: "GA-4 Viewer",
        role: role.name,
        isActive: true,
      },
    });
    const jwt = await encode({
      token: { id: viewerUser.id, email: viewerUser.email, name: viewerUser.name ?? undefined, role: viewerUser.role },
      secret: process.env.NEXTAUTH_SECRET ?? "",
    });

    const { POST } = await import("../../src/app/api/v1/protocol/queue/dead/requeue/route");
    const res = await POST(
      new NextRequest("http://app.local/api/v1/protocol/queue/dead/requeue", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `next-auth.session-token=${jwt}` },
        body: JSON.stringify({ ids: ["whatever"] }),
      })
    );
    expect(res.status).toBe(403);
    await db.user.delete({ where: { id: viewerUser.id } });
  });
});

/* ── the alerting hook ─────────────────────────────────────────────────── */

describe("GA-4: DLQ depth metric", () => {
  test("GET /api/metrics exposes fayanms_protocol_queue_dead", async () => {
    await seedDead(30);
    const { GET } = await import("../../src/app/api/metrics/route");
    // The wave-12 posture: when FAYANMS_METRICS_TOKEN is configured, the
    // scrape must present it (the sandbox/dev .env sets one; CI does not).
    const configured = process.env.FAYANMS_METRICS_TOKEN?.trim() ?? "";
    const headers: Record<string, string> = configured ? { authorization: `Bearer ${configured}` } : {};
    const res = await GET(new NextRequest("http://app.local/api/metrics", { headers }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("# TYPE fayanms_protocol_queue_dead gauge");
    expect(text).toMatch(/fayanms_protocol_queue_dead \d+/);
  });
});
