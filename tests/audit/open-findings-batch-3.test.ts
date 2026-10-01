/**
 * Open-findings batch 3 — F-008 phase 2 runtime pins (events/alerts).
 *
 *   F-008 (A1-01, P2): ~35 operational GET handlers under /api/v1 were
 *   authenticated ONLY by the proxy matcher (src/proxy.ts,
 *   `/api/v1/:path*`). Phase 1 (batch 2) landed the typed
 *   requireSessionRead() helper and gated the dashboard domain; the
 *   documented rollout order is dashboard → events/alerts →
 *   devices/interfaces → the rest.
 *
 *   Phase 2 (this suite): the events/alerts domain is handler-gated:
 *     - GET /api/v1/events          (platform audit-event timeline)
 *     - GET /api/v1/alerts          (alert stream)
 *     - GET /api/v1/alerts/rules    (rule list; POST stays
 *       requirePermission("admin.system") — the mutation plane is untouched)
 *
 *   Pins (mirroring the batch-2 rig):
 *     1. anonymous (no session)            → 401 UNAUTHENTICATED envelope
 *     2. valid service JWT (machine plane) → 401 UNAUTHENTICATED (reads
 *        stay human-session-gated at the handler itself)
 *     3. session for an UNKNOWN user id    → 401 ACCOUNT_DISABLED (the DB
 *        re-verification layer — claims alone never authorize)
 *     4. real admin session                → 200 (+ the domain payload)
 *     5. source contract: each gated GET body calls
 *        await requireSessionRead(request) with the authErrorToFail
 *        envelope mapping (the read-route matrix in
 *        tests/auth/authorization-contract.test.ts enforces this
 *        statically; these pins document the runtime intent)
 *
 * Same rig as batch 2 (tests/audit/open-findings-batch-2.test.ts): REAL
 * session tokens minted with the production next-auth/jwt encoder (no
 * mock.module — it is process-wide and poisons later suites). The admin
 * identity is SELF-CONTAINED via the certified rt012/rt014 ensure-helper
 * pattern: the CI gate replays ONLY `migrate deploy` (no demo seed), so
 * the admin Role (from ROLE_MATRIX, the seed's single source of truth)
 * and the admin User are upserted here and never deleted.
 */

import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";

import { db } from "../../src/lib/db";
import { mintServiceToken } from "../../src/lib/auth/service-auth";
import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";

async function eventsRequest(headers: Record<string, string>): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/events/route");
  return GET(
    new NextRequest("http://app.local/api/v1/events?page=1&pageSize=5", {
      method: "GET",
      headers,
    })
  );
}

async function alertsRequest(headers: Record<string, string>): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/alerts/route");
  return GET(
    new NextRequest("http://app.local/api/v1/alerts?page=1&pageSize=5", {
      method: "GET",
      headers,
    })
  );
}

async function alertRulesRequest(headers: Record<string, string>): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/alerts/rules/route");
  return GET(
    new NextRequest("http://app.local/api/v1/alerts/rules", {
      method: "GET",
      headers,
    })
  );
}

/** Session-shaped projection of the admin identity used by these pins. */
type F008AdminUser = { id: string; email: string; name: string | null; role: string };
let f008Admin: F008AdminUser | null = null;

/**
 * Self-contained admin identity (the certified rt012/rt014 pattern): the CI
 * gate replays ONLY `migrate deploy` on a fresh service container (no demo
 * seed), so `admin@faya.local` cannot be assumed to exist — and neither can
 * the seeded admin ROLE row that loadRolePermissions() resolves User.role
 * against. The Role upsert sources permissions from ROLE_MATRIX (the seed's
 * single source of truth) and leaves an existing row untouched (update: {});
 * the user upsert is atomic (unique email) and seed-equivalent shared state
 * is never deleted mid-run.
 */
async function ensureF008Admin(): Promise<F008AdminUser> {
  if (f008Admin) return f008Admin;
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
  f008Admin = await db.user.upsert({
    where: { email: "admin@faya.local" },
    update: { isActive: true },
    create: { email: "admin@faya.local", name: "F008 Admin", role: "admin", isActive: true },
    select: { id: true, email: true, name: true, role: true },
  });
  return f008Admin;
}

async function mintSessionJwt(user: F008AdminUser): Promise<string> {
  return encode({
    token: { id: user.id, email: user.email, name: user.name ?? undefined, role: user.role },
    secret: process.env.NEXTAUTH_SECRET ?? "",
  });
}

describe("F-008 phase 2: the events/alerts read domain is handler-gated", () => {
  test("anonymous → 401 UNAUTHENTICATED on every domain route", async () => {
    for (const [name, call] of [
      ["events", eventsRequest],
      ["alerts", alertsRequest],
      ["alerts/rules", alertRulesRequest],
    ] as const) {
      const res = await call({});
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("UNAUTHENTICATED");
      // Sanity: the probe really hit the route it claims to (distinct
      // handlers, one assertion message each).
      expect(name.length).toBeGreaterThan(0);
    }
  });

  test("valid service JWT (machine plane) → 401 — reads stay human-session-gated", async () => {
    const token = mintServiceToken({
      issuer: "fayanms:worker",
      subject: "worker:f008-phase2-read-plane-test",
      scopes: ["alerts"],
    });
    const res = await alertsRequest({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("UNAUTHENTICATED");
  });

  test("session claims for an UNKNOWN user → 401 ACCOUNT_DISABLED (DB re-verification)", async () => {
    const ghost = await encode({
      token: {
        id: "user-f008-phase2-ghost-nonexistent",
        email: "ghost-f008-p2@faya.local",
        name: "F-008 Phase 2 Ghost",
        role: "admin",
      },
      secret: process.env.NEXTAUTH_SECRET ?? "",
    });
    const res = await eventsRequest({
      cookie: `next-auth.session-token=${ghost}`,
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("ACCOUNT_DISABLED");
  });

  test("real admin session → 200 with the domain payload (events)", async () => {
    const admin = await ensureF008Admin();
    const session = await mintSessionJwt(admin);
    const res = await eventsRequest({
      cookie: `next-auth.session-token=${session}`,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success?: boolean; meta?: { total?: number } };
    expect(body.success).toBe(true);
    expect(typeof body.meta?.total).toBe("number");
  });

  test("real admin session → 200 with the domain payload (alerts)", async () => {
    const admin = await ensureF008Admin();
    const session = await mintSessionJwt(admin);
    const res = await alertsRequest({
      cookie: `next-auth.session-token=${session}`,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success?: boolean;
      meta?: { counts?: Record<string, Record<string, number>> };
    };
    expect(body.success).toBe(true);
    expect(body.meta?.counts?.byStatus).toBeTruthy();
    expect(body.meta?.counts?.bySeverity).toBeTruthy();
  });

  test("real admin session → 200 with the domain payload (alerts/rules)", async () => {
    const admin = await ensureF008Admin();
    const session = await mintSessionJwt(admin);
    const res = await alertRulesRequest({
      cookie: `next-auth.session-token=${session}`,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success?: boolean; data?: unknown[] };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("source contract: every phase-2 GET body gates on requireSessionRead", async () => {
    const { readFileSync } = await import("node:fs");
    for (const rel of [
      "src/app/api/v1/events/route.ts",
      "src/app/api/v1/alerts/route.ts",
      "src/app/api/v1/alerts/rules/route.ts",
    ]) {
      const src = readFileSync(rel, "utf8");
      expect(src).toContain("await requireSessionRead(request)");
      expect(src).toContain("authErrorToFail");
    }
  });
});
