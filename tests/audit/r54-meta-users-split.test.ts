import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * HC-2 (R54) — authenticated bootstrap split for /api/v1/meta.
 *
 * The session-exempt bootstrap surface used to carry the active-user
 * directory (id/name/role + email local-part) for the alert assign/
 * suppress picker. Fine for the demo lab; wrong for production (F-N3).
 * The split:
 *   - GET /api/v1/meta      → ONLY pre-auth-needed reference data
 *                             (vendors, sites, credential profiles);
 *                             ZERO user records (wire-pinned here).
 *   - GET /api/v1/meta/users → the user directory, behind the session
 *                             plane (proxy matcher + exact-match
 *                             exemption) AND a handler-level actor gate
 *                             resolved BEFORE the DB read (R52-F-N1
 *                             ordering discipline).
 *
 * These pins make the split machine-enforced: the users segment cannot
 * silently migrate back onto the pre-auth surface.
 */

const REPO = join(import.meta.dir, "..", "..");

function readRepo(rel: string): string {
  return readFileSync(join(REPO, rel), "utf8");
}

/**
 * F-008 phase 4b: GET /api/v1/meta/reference verifies the human session at
 * the handler (requireSessionRead) — it is no longer probe-able bare. This
 * helper mints a REAL next-auth session for a self-contained ensured admin
 * (rt012/rt014 pattern: the CI gate replays only `migrate deploy`, so the
 * admin identity is upserted here, never deleted).
 */
async function metaReferenceRequest(): Promise<Response> {
  const { NextRequest } = await import("next/server");
  const { encode } = await import("next-auth/jwt");
  const { db } = await import("../../src/lib/db");
  const { ROLE_MATRIX } = await import("../../src/lib/auth/role-matrix");
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
  const user = await db.user.upsert({
    where: { email: "admin@faya.local" },
    update: { isActive: true },
    create: { email: "admin@faya.local", name: "F008 Admin", role: "admin", isActive: true },
    select: { id: true, email: true, name: true, role: true },
  });
  const session = await encode({
    token: { id: user.id, email: user.email, name: user.name ?? undefined, role: user.role },
    secret: process.env.NEXTAUTH_SECRET ?? "",
  });
  const { GET } = await import("@/app/api/v1/meta/reference/route");
  return GET(
    new NextRequest("http://app.local/api/v1/meta/reference", {
      method: "GET",
      headers: { cookie: `next-auth.session-token=${session}` },
    })
  );
}

describe("HC-2 — the bootstrap payload carries zero user records", () => {
  test("wire-level: GET /api/v1/meta (handler, real DB) has no users key", async () => {
    const { GET } = await import("@/app/api/v1/meta/route");
    const response = await GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      data: Record<string, unknown>;
    };
    expect(body.success).toBe(true);
    // The F-N3 core assertion — machine-pinned:
    expect("users" in body.data).toBe(false);
    // RT-024 (F-028): the pre-auth surface is EMPTY by contract — vendors,
    // sites and credential profiles moved to the AUTHENTICATED
    // /api/v1/meta/reference (see tests/audit/rt024-meta-preauth-trim.test.ts).
    expect("vendors" in body.data).toBe(false);
    expect("sites" in body.data).toBe(false);
    expect("credentialProfiles" in body.data).toBe(false);
  });

  test("wire-level: GET /api/v1/meta/reference (handler, real DB) carries the pickers", async () => {
    const response = await metaReferenceRequest();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      data: { vendors: unknown[]; sites: unknown[]; credentialProfiles: { username?: string }[] };
    };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.vendors)).toBe(true);
    expect(Array.isArray(body.data.sites)).toBe(true);
    expect(Array.isArray(body.data.credentialProfiles)).toBe(true);
    // R51-A2 holds: no credential-profile operator usernames either.
    if (body.data.credentialProfiles.length > 0) {
      expect("username" in body.data.credentialProfiles[0]).toBe(false);
    }
  });

  test("source: the meta route no longer queries the user table", () => {
    const src = readRepo("src/app/api/v1/meta/route.ts");
    expect(src).not.toContain("db.user.findMany");
    expect(src).not.toContain("roleLabel");
  });
});

describe("HC-2 — the user directory lives behind the session plane", () => {
  test("route exists with the actor gate BEFORE the DB read (R52-F-N1 order)", () => {
    const src = readRepo("src/app/api/v1/meta/users/route.ts");
    const actorAt = src.indexOf("resolveActingUser(request)");
    const dbAt = src.indexOf("db.user.findMany");
    expect(actorAt).toBeGreaterThan(-1);
    expect(dbAt).toBeGreaterThan(-1);
    expect(actorAt).toBeLessThan(dbAt);
    // Exactly once — no double gate drift.
    expect(src.match(/resolveActingUser\(request\)/g)?.length).toBe(1);
  });

  test("wire-level: GET /api/v1/meta/users without a session → 401 (handler)", async () => {
    const { GET } = await import("@/app/api/v1/meta/users/route");
    const response = await GET(
      new Request("http://localhost/api/v1/meta/users")
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as {
      error?: { code?: string };
    };
    expect(body.error?.code).toBe("UNAUTHENTICATED");
  });

  test("proxy exemption stays EXACT — /api/v1/meta/users is not exempt", () => {
    const proxySrc = readRepo("src/proxy.ts");
    // The exact-match exemption for the bootstrap surface…
    expect(proxySrc).toContain('pathname === "/api/v1/meta"');
    // …never widened to the split surface (string literal must not appear).
    expect(proxySrc).not.toContain('"/api/v1/meta/users"');
  });

  test("proxy end-to-end: meta passes pre-auth, meta/users hits the session plane", async () => {
    const { proxy } = await import("@/proxy");
    const { NextRequest } = await import("next/server");
    const pass = await proxy(
      new NextRequest("http://localhost/api/v1/meta", { method: "GET" })
    );
    // Session-exempt bootstrap: the proxy forwards (NextResponse.next()).
    expect(pass.headers.get("x-middleware-next")).toBe("1");

    const gated = await proxy(
      new NextRequest("http://localhost/api/v1/meta/users", { method: "GET" })
    );
    expect(gated.status).toBe(401);
    const body = (await gated.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("UNAUTHENTICATED");
  });
});

describe("HC-2 — client split (types + fetch orchestration + consumers)", () => {
  test("MetaPayload sheds users; MetaUsersPayload serves the split segment", () => {
    const client = readRepo("src/lib/api-client.ts");
    const metaBlock = client.slice(
      client.indexOf("export interface MetaPayload"),
      client.indexOf("export interface MetaUsersPayload")
    );
    // Property-syntax assertion: the interface body must not declare a
    // users field (prose mentions of the split route are fine).
    expect(metaBlock).not.toContain("users:");
    expect(client).toContain("export interface MetaUsersPayload");
    expect(client).toContain("users: UserOption[]");
  });

  test("useMetaUsers fetches the authenticated segment (and only that)", () => {
    const hook = readRepo("src/hooks/api/use-meta.ts");
    expect(hook).toContain('apiFetch<MetaUsersPayload>("/api/v1/meta/users")');
    expect(hook).toContain("queryKeys.metaUsers");
  });

  test("both consumers migrated off the bootstrap users segment", () => {
    for (const file of [
      "src/components/alerts/alert-action-dialogs.tsx",
      "src/components/views/incident-detail-view.tsx",
    ]) {
      const src = readRepo(file);
      expect(src).toContain("useMetaUsers");
      expect(src).not.toContain("useMeta(");
    }
  });

  test("query key registered for the split segment", () => {
    const keys = readRepo("src/lib/query-keys.ts");
    expect(keys).toContain('metaUsers: ["meta", "users"] as const');
  });
});
