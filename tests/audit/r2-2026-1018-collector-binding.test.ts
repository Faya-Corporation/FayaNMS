import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { encode } from "next-auth/jwt";
import { NextRequest } from "next/server";

import { db } from "../../src/lib/db";

/**
 * FNM-2026-106 (2026-10-18 independent re-audit, Wave R2) — collector
 * machine-principal identity binding. A telemetry/enroll service token is
 * bound to EXACTLY ONE agentKey (the verified JWT subject); registration
 * additionally requires the one-shot "enroll" scope (separate from
 * steady-state "telemetry"); a SUSPENDED agent cannot resurrect itself
 * through re-registration — only the admin reinstate route lifts it.
 */

const RUN = randomUUID().slice(0, 8);
const KEY_A = `r2-${RUN}-agent-a`;
const KEY_B = `r2-${RUN}-agent-b`;

const mint = (subject: string, scopes: string[]) => {
  const secret = process.env.FAYANMS_SERVICE_SECRET ?? "";
  const nowS = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      iss: "fayanms:worker",
      sub: subject,
      aud: "fayanms:internal",
      iat: nowS,
      exp: nowS + 300,
      jti: randomUUID(),
      scopes,
    })
  ).toString("base64url");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHmac } = require("node:crypto") as typeof import("node:crypto");
  const signature = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${signature}`;
};

function bearer(url: string, subject: string, scopes: string[], body?: unknown): Request {
  return new Request(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${mint(subject, scopes)}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function adminJwt(): Promise<string> {
  return encode({
    token: { id: adminId, email: adminEmail, name: "R2 admin", role: "admin" },
    secret: process.env.NEXTAUTH_SECRET ?? "",
  });
}
async function operatorJwt(): Promise<string> {
  return encode({
    token: { id: operatorId, email: operatorEmail, name: "R2 operator", role: "operator" },
    secret: process.env.NEXTAUTH_SECRET ?? "",
  });
}

const adminEmail = `${RUN}-admin@faya.local`;
const operatorEmail = `${RUN}-operator@faya.local`;
let adminId = "";
let operatorId = "";
const cleanupUsers: string[] = [];
const cleanupAgents: string[] = [];

beforeAll(async () => {
  const admin = await db.user.create({
    data: { email: adminEmail, name: `R2 admin ${RUN}`, role: "admin", isActive: true },
    select: { id: true },
  });
  adminId = admin.id;
  cleanupUsers.push(admin.id);
  const operator = await db.user.create({
    data: { email: operatorEmail, name: `R2 operator ${RUN}`, role: "operator", isActive: true },
    select: { id: true },
  });
  operatorId = operator.id;
  cleanupUsers.push(operator.id);
});

afterAll(async () => {
  await db.collectorAssignment.deleteMany({ where: { agent: { agentKey: { in: [KEY_A, KEY_B] } } } });
  await db.collectorAgent.deleteMany({ where: { agentKey: { in: [KEY_A, KEY_B] } } });
  await db.user.deleteMany({ where: { id: { in: cleanupUsers } } });
});

const REGISTER = "http://app.local/api/v1/collectors/register";
const HEARTBEAT = "http://app.local/api/v1/collectors/heartbeat";

type Envelope = { success?: boolean; data?: unknown; error?: { code?: string } };
async function bodyOf(res: Response): Promise<Envelope> {
  return (await res.json()) as Envelope;
}

describe("FNM-2026-106 — registration requires enroll scope + subject binding", () => {
  test("telemetry-only token on register → 403 SERVICE_SCOPE_INSUFFICIENT (enrollment is separate)", async () => {
    const { POST } = await import("../../src/app/api/v1/collectors/register/route");
    const res = await POST(bearer(REGISTER, KEY_A, ["telemetry"], {
      agentKey: KEY_A, displayName: "A", role: "snmp",
    }));
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).error?.code).toBe("SERVICE_SCOPE_INSUFFICIENT");
  });

  test("enroll token whose subject ≠ agentKey → 403 COLLECTOR_IDENTITY_MISMATCH", async () => {
    const { POST } = await import("../../src/app/api/v1/collectors/register/route");
    const res = await POST(bearer(REGISTER, KEY_B, ["enroll", "telemetry"], {
      agentKey: KEY_A, displayName: "A", role: "snmp",
    }));
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).error?.code).toBe("COLLECTOR_IDENTITY_MISMATCH");
    const row = await db.collectorAgent.findUnique({ where: { agentKey: KEY_A } });
    expect(row).toBeNull();
  });

  test("bound enroll token registers its OWN agentKey → 201", async () => {
    const { POST } = await import("../../src/app/api/v1/collectors/register/route");
    const res = await POST(bearer(REGISTER, KEY_A, ["enroll", "telemetry"], {
      agentKey: KEY_A, displayName: "Agent A", role: "snmp",
    }));
    expect(res.status).toBe(201);
    const row = await db.collectorAgent.findUnique({ where: { agentKey: KEY_A } });
    expect(row?.status).toBe("ACTIVE");
  });
});

describe("FNM-2026-106 — heartbeat and assignments are bound to their own agent", () => {
  test("heartbeat for another agent's key → 403 COLLECTOR_IDENTITY_MISMATCH", async () => {
    const { POST } = await import("../../src/app/api/v1/collectors/heartbeat/route");
    const res = await POST(bearer(HEARTBEAT, KEY_A, ["telemetry"], {
      agentKey: KEY_B, claims: [],
    }));
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).error?.code).toBe("COLLECTOR_IDENTITY_MISMATCH");
  });

  test("heartbeat for its own key passes the binding gate (liveness flows)", async () => {
    const { POST } = await import("../../src/app/api/v1/collectors/heartbeat/route");
    const res = await POST(bearer(HEARTBEAT, KEY_A, ["telemetry"], {
      agentKey: KEY_A, claims: [],
    }));
    expect(res.status).toBe(200);
  });

  test("assignments snapshot for another agent's key → 403 even before existence checks", async () => {
    const { GET } = await import("../../src/app/api/v1/collectors/assignments/route");
    const res = await GET(bearer(`http://app.local/api/v1/collectors/assignments?agentKey=${KEY_B}`, KEY_A, ["telemetry"]));
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).error?.code).toBe("COLLECTOR_IDENTITY_MISMATCH");
  });
});

describe("FNM-2026-106 — suspension is operator-owned (no self-resurrection)", () => {
  test("a SUSPENDED agent cannot reactivate itself by re-registering → 403, row stays SUSPENDED", async () => {
    await db.collectorAgent.update({ where: { agentKey: KEY_A }, data: { status: "SUSPENDED" } });
    const { POST } = await import("../../src/app/api/v1/collectors/register/route");
    const res = await POST(bearer(REGISTER, KEY_A, ["enroll", "telemetry"], {
      agentKey: KEY_A, displayName: "Agent A", role: "snmp",
    }));
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).error?.code).toBe("COLLECTOR_AGENT_SUSPENDED");
    const row = await db.collectorAgent.findUnique({ where: { agentKey: KEY_A }, select: { status: true } });
    expect(row?.status).toBe("SUSPENDED");
  });

  test("only the admin plane reinstates (operator → 403; admin → 200 + audit; repeat → 409)", async () => {
    const { POST } = await import("../../src/app/api/v1/admin/collectors/agents/[agentKey]/reinstate/route");
    const url = `http://app.local/api/v1/admin/collectors/agents/${KEY_A}/reinstate`;
    const params = { params: Promise.resolve({ agentKey: KEY_A }) } as never;

    const asOperator = await POST(
      new NextRequest(url, {
        method: "POST",
        headers: { cookie: `next-auth.session-token=${await operatorJwt()}` },
      }),
      params
    );
    expect(asOperator.status).toBe(403);

    const asAdmin = await POST(
      new NextRequest(url, {
        method: "POST",
        headers: { cookie: `next-auth.session-token=${await adminJwt()}` },
      }),
      params
    );
    expect(asAdmin.status).toBe(200);
    const row = await db.collectorAgent.findUnique({ where: { agentKey: KEY_A }, select: { status: true } });
    expect(row?.status).toBe("ACTIVE");
    const audit = await db.auditEvent.findFirst({
      where: { action: "COLLECTOR_AGENT_REINSTATED", resourceId: KEY_A },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();

    const again = await POST(
      new NextRequest(url, {
        method: "POST",
        headers: { cookie: `next-auth.session-token=${await adminJwt()}` },
      }),
      params
    );
    expect(again.status).toBe(409);
    expect((await bodyOf(again)).error?.code).toBe("COLLECTOR_AGENT_NOT_SUSPENDED");
  });
});
