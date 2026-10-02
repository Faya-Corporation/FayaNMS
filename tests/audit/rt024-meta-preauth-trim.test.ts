/**
 * RT-024 / F-028 — the pre-auth bootstrap surface discloses nothing.
 *
 * `/api/v1/meta` is SESSION-EXEMPT by design (proxy exact-match), which
 * historically made it an unauthenticated inventory oracle: credential-
 * profile names/types and the full site/vendor list leaked to anyone who
 * could reach the API. The payload is now EMPTY (stable liveness/bootstrap
 * envelope), and the picker data moved to the AUTHENTICATED
 * /api/v1/meta/reference (proxy matcher gates it — not in the exemption
 * list). The client choke point (use-meta.ts) was repointed in the same
 * change; no pre-auth consumer exists (verified in the RT).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const REPO = join(import.meta.dir, "..", "..");

/**
 * F-008 phase 4b: GET /api/v1/meta/reference verifies the human session at
 * the handler (requireSessionRead) — the proxy is no longer its only gate.
 * This helper mints a REAL next-auth session for a self-contained ensured
 * admin (rt012/rt014 pattern: the CI gate replays only `migrate deploy`, so
 * the admin identity is upserted here, never deleted).
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

describe("RT-024 — pre-auth meta trim", () => {
  test("pre-auth GET /api/v1/meta returns an empty data object", async () => {
    const { GET } = await import("@/app/api/v1/meta/route");
    const response = await GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; data: Record<string, unknown> };
    expect(body.success).toBe(true);
    expect(Object.keys(body.data)).toEqual([]);
  });

  test("proxy end-to-end: reference route is session-gated, meta is exempt", async () => {
    const { proxy } = await import("@/proxy");
    const { NextRequest } = await import("next/server");
    const gated = await proxy(
      new NextRequest("http://localhost/api/v1/meta/reference", { method: "GET" }),
    );
    expect(gated.status).toBe(401);
    const gatedBody = (await gated.json()) as { error?: { code?: string } };
    expect(gatedBody.error?.code).toBe("UNAUTHENTICATED");

    // The trimmed bootstrap surface stays session-exempt (exact match).
    const pass = await proxy(
      new NextRequest("http://localhost/api/v1/meta", { method: "GET" }),
    );
    expect(pass.headers.get("x-middleware-next")).toBe("1");
  });

  test("reference route handler serves the picker data (R51-A2: no usernames)", async () => {
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
    if (body.data.credentialProfiles.length > 0) {
      expect("username" in body.data.credentialProfiles[0]).toBe(false);
    }
  });

  test("client choke point consumes the authenticated reference route", () => {
    const hook = readFileSync(join(REPO, "src/hooks/api/use-meta.ts"), "utf8");
    expect(hook).toContain('apiFetch<MetaPayload>("/api/v1/meta/reference")');
    expect(hook).not.toContain('apiFetch<MetaPayload>("/api/v1/meta")');
  });
});
