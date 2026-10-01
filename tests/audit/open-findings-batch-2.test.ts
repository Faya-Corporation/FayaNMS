/**
 * Open-findings batch 2 — F-008 phase 1 runtime pins.
 *
 *   F-008 (A1-01, P2): ~35 operational GET handlers under /api/v1 were
 *   authenticated ONLY by the proxy matcher (src/proxy.ts,
 *   `/api/v1/:path*`) — a matcher regression, proxy bypass, or any future
 *   route outside /api/v1 would silently publish operational reads.
 *   BACKLOG plan: a typed requireSessionRead() helper, then a per-domain
 *   rollout (dashboard → events/alerts → devices/interfaces → the rest).
 *
 *   Phase 1 (this suite): the helper landed in src/lib/auth/session.ts and
 *   the dashboard domain is handler-gated. Pins:
 *
 *     1. anonymous (no session)            → 401 UNAUTHENTICATED envelope
 *     2. valid service JWT (machine plane) → 401 UNAUTHENTICATED (the
 *        handler does not recognize machine credentials — the proxy
 *        refuses the machine plane before any human read surface in
 *        production; here the handler layer alone must still fail closed)
 *     3. session for an UNKNOWN user id    → 401 ACCOUNT_DISABLED (the DB
 *        re-verification layer — claims alone never authorize)
 *     4. real admin session                → 200 + live KPI aggregate
 *     5. per-request cache: repeated calls with the SAME Request return
 *        the identical promise (WeakMap keyed by the request object)
 *     6. source contract: the dashboard GET body gates on
 *        requireSessionRead (the read-route matrix in
 *        tests/auth/authorization-contract.test.ts enforces this
 *        statically; this pin documents the runtime intent)
 *
 * Same rig as tests/auth/csrf-origin-proxy.test.ts: REAL session tokens
 * minted with the production next-auth/jwt encoder (no mock.module — it is
 * process-wide and poisons later suites). The admin identity is
 * SELF-CONTAINED via the certified rt012/rt014 ensure-helper pattern: the
 * CI gate replays ONLY `migrate deploy` (no demo seed), so the admin Role
 * (from ROLE_MATRIX, the seed's single source of truth) and the admin User
 * are upserted here and never deleted (seed-equivalent shared state).
 */

import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";

import { db } from "../../src/lib/db";
import { mintServiceToken } from "../../src/lib/auth/service-auth";
import { requireSessionRead } from "../../src/lib/auth/session";
import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";

async function dashboardRequest(headers: Record<string, string>): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/dashboard/route");
  return GET(
    new NextRequest("http://app.local/api/v1/dashboard?range=24h", {
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

describe("F-008 phase 1: GET /api/v1/dashboard is handler-gated", () => {
  test("anonymous (no session, no bearer) → 401 UNAUTHENTICATED envelope", async () => {
    const res = await dashboardRequest({});
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("UNAUTHENTICATED");
  });

  test("valid service JWT (machine plane) → 401 — reads stay human-session-gated", async () => {
    const token = mintServiceToken({
      issuer: "fayanms:worker",
      subject: "worker:f008-read-plane-test",
      scopes: ["jobs"],
    });
    const res = await dashboardRequest({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("UNAUTHENTICATED");
  });

  test("session claims for an UNKNOWN user → 401 ACCOUNT_DISABLED (DB re-verification)", async () => {
    const ghost = await encode({
      token: {
        id: "user-f008-ghost-nonexistent",
        email: "ghost-f008@faya.local",
        name: "F-008 Ghost",
        role: "admin",
      },
      secret: process.env.NEXTAUTH_SECRET ?? "",
    });
    const res = await dashboardRequest({
      cookie: `next-auth.session-token=${ghost}`,
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("ACCOUNT_DISABLED");
  });

  test("real admin session → 200 with the live KPI aggregate", async () => {
    const admin = await ensureF008Admin();
    const session = await mintSessionJwt(admin);
    const res = await dashboardRequest({
      cookie: `next-auth.session-token=${session}`,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success?: boolean;
      data?: { kpis?: Record<string, number> };
    };
    expect(body.success).toBe(true);
    expect(body.data?.kpis).toBeTruthy();
    expect(typeof body.data?.kpis?.managedDevices).toBe("number");
  });
});

describe("F-008 phase 1: requireSessionRead helper contract", () => {
  test("per-request cache: repeated calls with the SAME Request return the identical promise", async () => {
    const admin = await ensureF008Admin();
    const session = await mintSessionJwt(admin);
    const req = new NextRequest("http://app.local/api/v1/dashboard", {
      headers: { cookie: `next-auth.session-token=${session}` },
    });
    const p1 = requireSessionRead(req);
    const p2 = requireSessionRead(req);
    expect(p2).toBe(p1); // WeakMap hit — one getToken + one DB check per request
    expect((await p1).id).toBe(admin.id); // the cached promise resolves to the actor
  });

  test("different Requests get independent cache slots", async () => {
    const admin = await ensureF008Admin();
    const session = await mintSessionJwt(admin);
    const a = new NextRequest("http://app.local/api/v1/dashboard", {
      headers: { cookie: `next-auth.session-token=${session}` },
    });
    const b = new NextRequest("http://app.local/api/v1/dashboard", {
      headers: { cookie: `next-auth.session-token=${session}` },
    });
    const [pa, pb] = [requireSessionRead(a), requireSessionRead(b)];
    expect(pb).not.toBe(pa); // no cross-request dedupe
    expect((await pa).id).toBe(admin.id);
    expect((await pb).id).toBe(admin.id);
  });

  test("source contract: the dashboard GET body gates on requireSessionRead", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/app/api/v1/dashboard/route.ts", "utf8");
    expect(src).toContain("await requireSessionRead(request)");
    expect(src).toContain("authErrorToFail");
  });
});
