/**
 * GA-3 (2026-10-06 re-audit): P1-A04 API-client credential lifecycle +
 * P1-A05 API-client resource scope.
 *
 * P1-A04 — tokens die centrally:
 *   - resolveActiveClient() refuses expired tokens on EVERY plane
 *     (mutation + read) with API_CLIENT_EXPIRED (401);
 *   - creation applies the FAYANMS_API_CLIENT_MAX_LIFETIME_DAYS policy
 *     (clamped 0..3650, default 90): explicit expiry honored up to the
 *     maximum, omitted expiry gets the default, 0 disables the automatic
 *     lifetime; legacy rows (null expiresAt) are grandfathered;
 *   - rotation stamps rotatedAt; PATCH can extend/set/clear expiry.
 *
 * P1-A05 — capability × resource scope:
 *   - ApiClient.siteScopeJson mirrors User.siteScopeJson semantics
 *     (null = wildcard/global, [] = deny-all, malformed = deny-all);
 *   - the SAME scope primitives enforce it: sessionScopeFor resolves a
 *     valid client token's resource scope, so scopedDeviceWhere /
 *     requireSiteScope bound the machine plane with zero per-route edits;
 *   - creation/PATCH validate site codes against the inventory.
 *
 * Certified rig: real route handlers + real bearer tokens (hash-registered
 * ApiClient rows), RUN-suffixed fixtures, surgical cleanup.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";
import { randomBytes } from "node:crypto";

import { db } from "../../src/lib/db";
import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";
import {
  apiClientTokenHash,
  authenticateApiClient,
  resolveApiClientScopeClaims,
} from "../../src/lib/auth/api-client-auth";

const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
const PREFIX = `ga3-`;
const SITE_A_CODE = `G3A-${RUN}`;
const SITE_B_CODE = `G3B-${RUN}`;
const ADMIN_EMAIL = `${PREFIX}admin-${RUN.toLowerCase()}@faya.local`;

const testStartedAt = new Date();

let orgId = "";
let siteAId = "";
let siteBId = "";
let vendorId = "";
let deviceAId = "";
let deviceBId = "";
let adminId = "";
const createdClientIds: string[] = [];

/** Mint + register a live client row; returns the plaintext bearer token. */
async function registerClient(opts: {
  scopes: string[];
  expiresAt?: Date | null;
  siteScopeJson?: string | null;
}): Promise<{ id: string; token: string }> {
  const token = randomBytes(32).toString("base64url");
  const row = await db.apiClient.create({
    data: {
      name: `${PREFIX}client-${RUN.toLowerCase()}-${randomBytes(3).toString("hex")}`,
      tokenHash: apiClientTokenHash(token),
      tokenPrefix: token.slice(0, 8),
      scopesJson: JSON.stringify(opts.scopes),
      isActive: true,
      expiresAt: opts.expiresAt ?? null,
      siteScopeJson: opts.siteScopeJson ?? null,
    },
  });
  createdClientIds.push(row.id);
  return { id: row.id, token };
}

function bearerRequest(method: string, url: string, token: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** An admin JWT for the human-plane admin routes. */
async function adminJwt(): Promise<string> {
  return encode({
    token: {
      id: adminId,
      email: ADMIN_EMAIL,
      name: "GA-3 Admin",
      role: "admin",
    },
    secret: process.env.NEXTAUTH_SECRET ?? "",
  });
}

type Envelope = { success?: boolean; data?: unknown; error?: { code?: string } };

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
    data: { email: ADMIN_EMAIL, name: "GA-3 Admin", role: "admin", isActive: true },
    select: { id: true },
  });
  adminId = admin.id;

  const org = await db.organization.create({ data: { name: `${PREFIX}org-${RUN}` } });
  orgId = org.id;
  const siteA = await db.site.create({
    data: { name: `GA-3 Site A ${RUN}`, code: SITE_A_CODE, organizationId: orgId },
  });
  siteAId = siteA.id;
  const siteB = await db.site.create({
    data: { name: `GA-3 Site B ${RUN}`, code: SITE_B_CODE, organizationId: orgId },
  });
  siteBId = siteB.id;

  const vendor = await db.vendor.create({
    data: { key: `${PREFIX}vendor-${RUN}`, name: `GA-3 Vendor ${RUN}`, adapterKey: "generic" },
  });
  vendorId = vendor.id;
  const devA = await db.device.create({
    data: { hostname: `${PREFIX}dev-a-${RUN.toLowerCase()}`, mgmtIp: "192.0.2.41", vendorId, siteId: siteAId, status: "ONLINE" },
  });
  deviceAId = devA.id;
  const devB = await db.device.create({
    data: { hostname: `${PREFIX}dev-b-${RUN.toLowerCase()}`, mgmtIp: "192.0.2.42", vendorId, siteId: siteBId, status: "ONLINE" },
  });
  deviceBId = devB.id;
});

afterAll(async () => {
  await db.auditEvent.deleteMany({
    where: {
      createdAt: { gte: testStartedAt },
      action: {
        in: [
          "API_CLIENT_CREATED",
          "API_CLIENT_UPDATED",
          "API_CLIENT_REVOKED",
          "API_CLIENT_ROTATED",
          "BASELINE_CREATED",
        ],
      },
    },
  });
  await db.maintenanceWindow.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await db.configSnapshot.deleteMany({
    where: { deviceId: { in: [deviceAId, deviceBId].filter(Boolean) }, createdAt: { gte: testStartedAt } },
  });
  await db.apiClient.deleteMany({ where: { id: { in: createdClientIds } } });
  await db.device.deleteMany({ where: { id: { in: [deviceAId, deviceBId].filter(Boolean) } } });
  await db.vendor.deleteMany({ where: { id: vendorId } });
  await db.site.deleteMany({ where: { id: { in: [siteAId, siteBId].filter(Boolean) } } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.user.deleteMany({ where: { id: adminId } });
});

/* ── P1-A04: central expiry enforcement ────────────────────────────────── */

describe("GA-3: API-client expiry (P1-A04)", () => {
  test("expired token → API_CLIENT_EXPIRED 401 on the mutation plane", async () => {
    const { token } = await registerClient({
      scopes: ["devices.write"],
      expiresAt: new Date(Date.now() - 1000),
    });
    const result = await authenticateApiClient(`Bearer ${token}`, "device.write");
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.code).toBe("API_CLIENT_EXPIRED");
      expect(result.status).toBe(401);
    }
  });

  test("expired token → rejected on the READ plane too (same resolver)", async () => {
    const { token } = await registerClient({
      scopes: ["devices.read"],
      expiresAt: new Date(Date.now() - 1000),
    });
    const result = await authenticateApiClient(`Bearer ${token}`, "device.read");
    expect(result.outcome).toBe("rejected");
  });

  test("legacy row (null expiresAt) is grandfathered", async () => {
    const { token } = await registerClient({ scopes: ["devices.read"], expiresAt: null });
    const result = await authenticateApiClient(`Bearer ${token}`, "device.read");
    expect(result.outcome).toBe("principal");
  });

  test("live token inside its window authenticates", async () => {
    const { token } = await registerClient({
      scopes: ["devices.read"],
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const result = await authenticateApiClient(`Bearer ${token}`, "device.read");
    expect(result.outcome).toBe("principal");
  });
});

/* ── P1-A05: resource scope via the same scope primitives ──────────────── */

describe("GA-3: API-client resource scope (P1-A05)", () => {
  test("resolveApiClientScopeClaims mirrors the siteScopeJson semantics", async () => {
    const wildcard = await registerClient({ scopes: ["devices.read"], siteScopeJson: null });
    expect((await resolveApiClientScopeClaims(`Bearer ${wildcard.token}`))?.sites).toBeUndefined();

    const scoped = await registerClient({ scopes: ["devices.read"], siteScopeJson: JSON.stringify([SITE_A_CODE]) });
    expect((await resolveApiClientScopeClaims(`Bearer ${scoped.token}`))?.sites).toEqual([SITE_A_CODE]);

    const denyAll = await registerClient({ scopes: ["devices.read"], siteScopeJson: "[]" });
    expect((await resolveApiClientScopeClaims(`Bearer ${denyAll.token}`))?.sites).toEqual([]);

    const malformed = await registerClient({ scopes: ["devices.read"], siteScopeJson: "{nope" });
    expect((await resolveApiClientScopeClaims(`Bearer ${malformed.token}`))?.sites).toEqual([]);

    const garbage = await resolveApiClientScopeClaims("Bearer not-a-real-token");
    expect(garbage).toBeNull();
  });

  test("scoped client: GET /devices returns ONLY in-scope rows", async () => {
    const { token } = await registerClient({
      scopes: ["devices.read"],
      siteScopeJson: JSON.stringify([SITE_A_CODE]),
    });
    const GET = (await import("../../src/app/api/v1/devices/route")).GET;
    const res = await GET(bearerRequest("GET", "http://app.local/api/v1/devices", token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const data = body.data as { devices?: Array<{ hostname: string }> } | Array<{ hostname: string }>;
    const rows = Array.isArray(data) ? data : (data.devices ?? []);
    const hostnames = rows.map((r) => r.hostname);
    expect(hostnames).toContain(`${PREFIX}dev-a-${RUN.toLowerCase()}`);
    expect(hostnames).not.toContain(`${PREFIX}dev-b-${RUN.toLowerCase()}`);
  });

  test("deny-all client: GET /devices returns zero rows", async () => {
    const { token } = await registerClient({
      scopes: ["devices.read"],
      siteScopeJson: "[]",
    });
    const GET = (await import("../../src/app/api/v1/devices/route")).GET;
    const res = await GET(bearerRequest("GET", "http://app.local/api/v1/devices", token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const data = body.data as { devices?: unknown[] } | unknown[];
    const rows = Array.isArray(data) ? data : (data.devices ?? []);
    expect(rows).toHaveLength(0);
  });

  test("wildcard (legacy) client: GET /devices keeps the global read plane", async () => {
    const { token } = await registerClient({ scopes: ["devices.read"], siteScopeJson: null });
    const GET = (await import("../../src/app/api/v1/devices/route")).GET;
    const res = await GET(bearerRequest("GET", "http://app.local/api/v1/devices", token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const data = body.data as { devices?: Array<{ hostname: string }> } | Array<{ hostname: string }>;
    const rows = Array.isArray(data) ? data : (data.devices ?? []);
    // Relative invariant (the fleet page is large): the wildcard page holds
    // MORE rows than the site-scoped page (which holds exactly its own one
    // fixture device plus nothing else of ours).
    expect(rows.length).toBeGreaterThan(1);
  });

  test("scoped client: GET /devices page holds exactly the in-scope fixture", async () => {
    const { token } = await registerClient({
      scopes: ["devices.read"],
      siteScopeJson: JSON.stringify([SITE_A_CODE]),
    });
    const GET = (await import("../../src/app/api/v1/devices/route")).GET;
    const res = await GET(bearerRequest("GET", "http://app.local/api/v1/devices", token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const data = body.data as { devices?: Array<{ hostname: string }> } | Array<{ hostname: string }>;
    const rows = Array.isArray(data) ? data : (data.devices ?? []);
    const ours = rows.filter((r) => r.hostname.startsWith(PREFIX));
    expect(ours.map((r) => r.hostname)).toEqual([`${PREFIX}dev-a-${RUN.toLowerCase()}`]);
  });

  test("scoped client mutation: alert acknowledge out-of-scope → 403, in-scope → 200", async () => {
    // The acknowledge route is the certified client-opted mutation face —
    // and, pre-P1-A05, it SKIPPED the site-scope gate for clients entirely.
    // The gate now applies to every principal.
    const alertB = await db.alert.create({
      data: { deviceId: deviceBId, severity: "MEDIUM", message: `${PREFIX}alert-b` },
    });
    const alertA = await db.alert.create({
      data: { deviceId: deviceAId, severity: "MEDIUM", message: `${PREFIX}alert-a` },
    });

    const { token } = await registerClient({
      scopes: ["alerts.write"], // maps onto alert.ack (scope table)
      siteScopeJson: JSON.stringify([SITE_A_CODE]),
    });
    const POST = (await import("../../src/app/api/v1/alerts/[id]/acknowledge/route")).POST;

    // Out of scope → 403, alert untouched.
    const denied = await POST(
      bearerRequest("POST", `http://app.local/api/v1/alerts/${alertB.id}/acknowledge`, token),
      { params: Promise.resolve({ id: alertB.id }) }
    );
    expect(denied.status).toBe(403);
    const deniedBody = (await denied.json()) as Envelope;
    expect(deniedBody.error?.code).toBe("SITE_SCOPE_FORBIDDEN");
    expect((await db.alert.findUnique({ where: { id: alertB.id } }))!.status).toBe("ACTIVE");

    // In scope → the client acknowledges it (P1-012 pattern: null FK, audit
    // attribution viaApiClientId).
    const allowed = await POST(
      bearerRequest("POST", `http://app.local/api/v1/alerts/${alertA.id}/acknowledge`, token),
      { params: Promise.resolve({ id: alertA.id }) }
    );
    expect(allowed.status).toBe(200);
    expect((await db.alert.findUnique({ where: { id: alertA.id } }))!.status).toBe("ACKNOWLEDGED");

    await db.auditEvent.deleteMany({ where: { resourceType: "Alert", resourceId: { in: [alertA.id, alertB.id] } } });
    await db.alert.deleteMany({ where: { id: { in: [alertA.id, alertB.id] } } });
  });
});

/* ── admin lifecycle surface: create / patch / rotate ──────────────────── */

describe("GA-3: admin client lifecycle surface", () => {
  async function adminPost(body: unknown): Promise<Response> {
    const { POST } = await import("../../src/app/api/v1/admin/api-clients/route");
    return POST(
      new NextRequest("http://app.local/api/v1/admin/api-clients", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `next-auth.session-token=${await adminJwt()}` },
        body: JSON.stringify(body),
      })
    );
  }

  test("create: omitted expiry gets the 90-day default; clientView carries lifecycle fields", async () => {
    const res = await adminPost({
      name: `${PREFIX}default-lifetime-${RUN}`,
      scopes: ["devices.read"],
      siteCodes: [SITE_A_CODE],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Envelope;
    const client = (body.data as { client: { id: string; expiresAt: string | null; siteCodes: string[] | null } }).client;
    createdClientIds.push(client.id);
    expect(client.expiresAt).not.toBeNull();
    const days = (new Date(client.expiresAt!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(91);
    expect(client.siteCodes).toEqual([SITE_A_CODE]);
  });

  test("create: expiry beyond the policy maximum → 400 EXPIRY_BEYOND_MAX_LIFETIME", async () => {
    const res = await adminPost({
      name: `${PREFIX}beyond-${RUN}`,
      scopes: ["devices.read"],
      expiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Envelope;
    expect(body.error?.code).toBe("EXPIRY_BEYOND_MAX_LIFETIME");
  });

  test("create: past expiry → 400 INVALID_EXPIRY; unknown site code → 400 SITE_CODE_INVALID", async () => {
    const past = await adminPost({
      name: `${PREFIX}past-${RUN}`,
      scopes: ["devices.read"],
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect((await past.json() as Envelope).error?.code).toBe("INVALID_EXPIRY");

    const unknownCode = await adminPost({
      name: `${PREFIX}unknown-code-${RUN}`,
      scopes: ["devices.read"],
      siteCodes: ["NOPE-404"],
    });
    expect((await unknownCode.json() as Envelope).error?.code).toBe("SITE_CODE_INVALID");
  });

  test("PATCH: expiry can be set within policy; site codes can be re-scoped", async () => {
    const createRes = await adminPost({
      name: `${PREFIX}patchme-${RUN}`,
      scopes: ["devices.read"],
      siteCodes: [SITE_A_CODE],
    });
    const created = ((await createRes.json()) as Envelope).data as {
      client: { id: string };
    };
    createdClientIds.push(created.client.id);

    const { PATCH } = await import("../../src/app/api/v1/admin/api-clients/[id]/route");
    const newExpiry = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const res = await PATCH(
      new NextRequest(`http://app.local/api/v1/admin/api-clients/${created.client.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: `next-auth.session-token=${await adminJwt()}` },
        body: JSON.stringify({ expiresAt: newExpiry, siteCodes: [SITE_A_CODE, SITE_B_CODE] }),
      }),
      { params: Promise.resolve({ id: created.client.id }) }
    );
    expect(res.status).toBe(200);
    const row = await db.apiClient.findUnique({ where: { id: created.client.id } });
    expect(row!.expiresAt?.toISOString()).toBe(new Date(newExpiry).toISOString());
    expect(JSON.parse(row!.siteScopeJson!)).toEqual([SITE_A_CODE, SITE_B_CODE]);
  });

  test("rotate: rotatedAt is stamped", async () => {
    const createRes = await adminPost({
      name: `${PREFIX}rotateme-${RUN}`,
      scopes: ["devices.read"],
    });
    const created = ((await createRes.json()) as Envelope).data as {
      client: { id: string };
    };
    createdClientIds.push(created.client.id);

    const { POST } = await import("../../src/app/api/v1/admin/api-clients/[id]/rotate/route");
    const res = await POST(
      new NextRequest(`http://app.local/api/v1/admin/api-clients/${created.client.id}/rotate`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `next-auth.session-token=${await adminJwt()}` },
      }),
      { params: Promise.resolve({ id: created.client.id }) }
    );
    expect(res.status).toBe(200);
    const row = await db.apiClient.findUnique({ where: { id: created.client.id } });
    expect(row!.rotatedAt).not.toBeNull();
    expect(row!.rotatedAt!.getTime()).toBeGreaterThanOrEqual(testStartedAt.getTime());
  });
});
