/**
 * Open-findings batch 25 — F-031 (P3, A1-08): no resource-level scoping.
 *
 *   Permissions are global per role — `requirePermission` answers "does this
 *   ROLE hold this PERMISSION" and nothing constrained a session to a site
 *   or device group. The honest graduation (the BACKLOG plan, single-tenant
 *   by design): land the SCOPING INFRASTRUCTURE with byte-unchanged defaults
 *   — NOT product tenancy:
 *
 *     1. The session JWT carries an OPTIONAL `sites: string[]` claim (site
 *        codes), minted ONLY at sign-in from the additive nullable
 *        User.siteScopeJson column. Absent claim = wildcard = exactly the
 *        pre-F-031 world; a scope change lands on the NEXT sign-in (the jwt
 *        refresh branch deliberately does not re-read it — no live
 *        revocation).
 *     2. Central, PURE enforcement core (src/lib/auth/scope.ts):
 *        sessionSiteScope() classifies claims fail-closed — empty array AND
 *        malformed claims resolve deny-all (malformed scope can never widen
 *        access), only the ABSENT claim widens — plus scopedDeviceWhere()
 *        composing `site.code IN (…)` over any base where clause and the
 *        requirePermission-family gates in session.ts (sessionScopeFor,
 *        requireSiteScope).
 *     3. Reference route migration: GET /api/v1/devices (list — where
 *        composed through scopedDeviceWhere) and GET /api/v1/devices/[id]
 *        (detail — the row-level sessionAllowsSite predicate with
 *        404-NOT-403 semantics for out-of-scope devices, so the detail
 *        route cannot leak what the list hides).
 *     4. Scope administration: PATCH /api/v1/admin/users/[id] accepts
 *        `siteScope: string[] | null` (admin-only, ≤ 32 pattern-validated
 *        deduped codes; null = wildcard reset), audited with dedicated
 *        USER_SCOPE_SET / USER_SCOPE_CLEARED rows.
 *
 *   Test style: a PURE scope matrix (no DB) for the classification and the
 *   wildcard deep-equality parity guarantee; source pins for the wiring and
 *   the additive migration; DB-backed functional tests on SYNTHETIC FIXTURES
 *   ONLY (own org/sites/vendor/devices/users, minted next-auth session JWTs
 *   via the certified rt012/batch-3 encode pattern) — the shared demo data
 *   is never touched and every fixture row is reclaimed in afterAll.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";

import { db } from "../../src/lib/db";
import {
  SITE_SCOPE_CLAIM_KEY,
  SiteScopeDeniedError,
  assertSiteScope,
  normalizeSiteScopeCodes,
  scopedDeviceWhere,
  sessionAllowsSite,
  sessionSiteScope,
  siteScopeAllows,
  userSiteScopeClaim,
} from "../../src/lib/auth/scope";
import {
  AuthError,
  requireSiteScope,
  sessionScopeFor,
} from "../../src/lib/auth/session";
import { authOptions } from "../../src/lib/auth/options";
import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";

/* ── part 1 — the pure scope matrix (no DB) ─────────────────────────────── */

describe("F-031 sessionSiteScope classification (fail-closed matrix)", () => {
  test("absent claim → wildcard (null session, undefined session, no sites key)", () => {
    expect(sessionSiteScope(null)).toEqual({ mode: "wildcard" });
    expect(sessionSiteScope(undefined)).toEqual({ mode: "wildcard" });
    expect(sessionSiteScope({})).toEqual({ mode: "wildcard" });
    expect(sessionSiteScope({ sites: undefined })).toEqual({ mode: "wildcard" });
    expect(sessionSiteScope({ sites: null })).toEqual({ mode: "wildcard" });
  });

  test("empty array → deny-all (sites mode with codes: [])", () => {
    expect(sessionSiteScope({ sites: [] })).toEqual({ mode: "sites", codes: [] });
  });

  test("valid arrays → sites mode, deduped order-preserving", () => {
    expect(sessionSiteScope({ sites: ["HQ-SAN", "DC-ADN"] })).toEqual({
      mode: "sites",
      codes: ["HQ-SAN", "DC-ADN"],
    });
    // Duplicates collapse to the FIRST occurrence; order is preserved.
    expect(sessionSiteScope({ sites: ["B", "A", "B", "C", "A"] })).toEqual({
      mode: "sites",
      codes: ["B", "A", "C"],
    });
  });

  test("malformed claims → deny-all + console.warn (never wildcard)", () => {
    const warns: unknown[][] = [];
    const spy = spyOn(console, "warn").mockImplementation((...args) => {
      warns.push(args);
    });
    try {
      const malformed: unknown[] = [
        "HQ-SAN", // bare string, not an array
        42, // number
        { sites: true }, // object
        ["A", 1], // non-string member
        ["A", ""], // empty-string member
        [null], // null member
        [[]], // nested array member
      ];
      for (const claim of malformed) {
        expect(sessionSiteScope({ sites: claim })).toEqual({ mode: "sites", codes: [] });
      }
      // Every malformed classification logged the fail-closed line.
      expect(warns.length).toBe(malformed.length);
      expect(String(warns[0]?.[0])).toContain("[auth:scope]");
      expect(String(warns[0]?.[0])).toContain("fail-closed");
    } finally {
      spy.mockRestore();
    }
  });

  test("normalizeSiteScopeCodes: the shared validator underneath", () => {
    expect(normalizeSiteScopeCodes([])).toEqual([]);
    expect(normalizeSiteScopeCodes(["A", "A", "B"])).toEqual(["A", "B"]);
    expect(normalizeSiteScopeCodes("A")).toBeNull();
    expect(normalizeSiteScopeCodes({ 0: "A" })).toBeNull();
    expect(normalizeSiteScopeCodes(["A", ""])).toBeNull();
    expect(normalizeSiteScopeCodes([3])).toBeNull();
  });

  test("the claim key is exactly 'sites' (the JWT contract)", () => {
    expect(SITE_SCOPE_CLAIM_KEY).toBe("sites");
  });
});

describe("F-031 scopedDeviceWhere — wildcard parity + sites composition", () => {
  const baseWhere: Prisma.DeviceWhereInput = {
    AND: [
      { OR: [{ hostname: { contains: "core" } }] },
      { status: { in: ["ONLINE"] } },
      { vendorId: "vendor-x" },
    ],
  };

  test("wildcard → the BASE WHERE unchanged (deep-equality + identity parity)", () => {
    // toBe: the helper returns the very same object — nothing is wrapped,
    // so the SQL Prisma emits for a wildcard session is byte-identical to
    // the pre-F-031 query.
    expect(scopedDeviceWhere(null, baseWhere)).toBe(baseWhere);
    expect(scopedDeviceWhere(undefined, baseWhere)).toBe(baseWhere);
    expect(scopedDeviceWhere({}, baseWhere)).toBe(baseWhere);
    expect(scopedDeviceWhere({ sites: undefined }, baseWhere)).toEqual(baseWhere);
    expect(scopedDeviceWhere({ sites: null }, baseWhere)).toEqual(baseWhere);
  });

  test("sites mode → { AND: [baseWhere, { site: { code: { in: codes } } }] }", () => {
    expect(scopedDeviceWhere({ sites: ["B25A", "B25B"] }, baseWhere)).toEqual({
      AND: [baseWhere, { site: { code: { in: ["B25A", "B25B"] } } }],
    });
  });

  test("deny-all scope → the same composition with an empty IN list", () => {
    // Prisma `in: []` matches nothing — the empty scope degrades naturally.
    expect(scopedDeviceWhere({ sites: [] }, baseWhere)).toEqual({
      AND: [baseWhere, { site: { code: { in: [] } } }],
    });
    expect(scopedDeviceWhere({ sites: "garbage" }, baseWhere)).toEqual({
      AND: [baseWhere, { site: { code: { in: [] } } }],
    });
  });

  test("wildcard over an EMPTY base where stays empty (parity again)", () => {
    expect(scopedDeviceWhere(null, {})).toEqual({});
  });
});

describe("F-031 row predicate + resource gate (list/detail/403 semantics)", () => {
  test("siteScopeAllows: wildcard sees all; sites mode needs membership; siteless rows hidden", () => {
    const wildcard = sessionSiteScope(null);
    expect(siteScopeAllows(wildcard, "ANY")).toBe(true);
    expect(siteScopeAllows(wildcard, null)).toBe(true);

    const scoped = sessionSiteScope({ sites: ["B25A"] });
    expect(siteScopeAllows(scoped, "B25A")).toBe(true);
    expect(siteScopeAllows(scoped, "B25B")).toBe(false);
    // A device with NO site can never match the SQL `site.code IN (…)`
    // filter — the predicate mirrors that exactly (fail-closed parity).
    expect(siteScopeAllows(scoped, null)).toBe(false);

    const denyAll = sessionSiteScope({ sites: [] });
    expect(siteScopeAllows(denyAll, "B25A")).toBe(false);
    expect(siteScopeAllows(denyAll, null)).toBe(false);
  });

  test("sessionAllowsSite composes classification + predicate", () => {
    expect(sessionAllowsSite({ sites: ["X"] }, "X")).toBe(true);
    expect(sessionAllowsSite({}, "X")).toBe(true); // wildcard
    expect(sessionAllowsSite({ sites: "junk" }, "X")).toBe(false); // fail-closed
  });

  test("assertSiteScope: unscoped resources bypass; out-of-scope throws 403-class error", () => {
    // RESOURCE-level null rule: a resource with no site dimension is global.
    expect(() => assertSiteScope({ sites: [] }, null)).not.toThrow();
    expect(() => assertSiteScope(null, null)).not.toThrow();

    expect(() => assertSiteScope(null, "B25A")).not.toThrow(); // wildcard
    expect(() => assertSiteScope({ sites: ["B25A"] }, "B25A")).not.toThrow();

    try {
      assertSiteScope({ sites: ["B25A"] }, "B25B");
      throw new Error("expected SiteScopeDeniedError");
    } catch (error) {
      expect(error instanceof SiteScopeDeniedError).toBe(true);
      expect((error as SiteScopeDeniedError).code).toBe("SITE_SCOPE_FORBIDDEN");
      expect((error as SiteScopeDeniedError).message).toContain("B25B");
    }
  });
});

describe("F-031 userSiteScopeClaim — the sign-in mint parser", () => {
  test("null/undefined column → undefined = NO claim = wildcard (key omitted)", () => {
    expect(userSiteScopeClaim(null)).toBeUndefined();
    expect(userSiteScopeClaim(undefined)).toBeUndefined();
  });

  test("valid JSON arrays mint the deduped list; an explicit [] is minted (deny-all)", () => {
    expect(userSiteScopeClaim('["A","A","B"]')).toEqual(["A", "B"]);
    expect(userSiteScopeClaim("[]")).toEqual([]);
  });

  test("malformed stored rows → [] deny-all + console.warn (never wildcard)", () => {
    const warns: unknown[][] = [];
    const spy = spyOn(console, "warn").mockImplementation((...args) => {
      warns.push(args);
    });
    try {
      for (const row of ["{not json", '"a-string"', '{"a":1}', "42", "null", '["A",2]']) {
        expect(userSiteScopeClaim(row)).toEqual([]);
      }
      // "null" parses to JSON null → normalize fails → deny-all. A
      // hand-edited siteScopeJson can never mint wildcard access.
      expect(warns.length).toBe(6);
      expect(String(warns[0]?.[0])).toContain("[auth:scope]");
    } finally {
      spy.mockRestore();
    }
  });

  test("the jwt callback stamps `sites` ONLY at sign-in (and only arrays)", async () => {
    const jwt = authOptions.callbacks?.jwt;
    expect(jwt).toBeDefined();

    const baseToken = { id: "u1", email: "u@faya.local", name: "U", role: "viewer" };

    // Sign-in with a sites array → claim stamped.
    const withSites = await jwt!({
      token: { ...baseToken } as never,
      user: { id: "u1", email: "u@faya.local", name: "U", role: "viewer", sites: ["B25A"] } as never,
    } as never);
    expect((withSites as Record<string, unknown>).sites).toEqual(["B25A"]);

    // Sign-in WITHOUT a sites key (null column at authorize) → no claim key
    // at all — the wildcard default is an ABSENT claim, not an empty one.
    const withoutSites = await jwt!({
      token: { ...baseToken } as never,
      user: { id: "u1", email: "u@faya.local", name: "U", role: "viewer" } as never,
    } as never);
    expect("sites" in (withoutSites as Record<string, unknown>)).toBe(false);

    // A non-array can never be stamped (second fail-closed layer behind
    // userSiteScopeClaim).
    const junk = await jwt!({
      token: { ...baseToken } as never,
      user: { id: "u1", email: "u@faya.local", name: "U", role: "viewer", sites: "B25A" } as never,
    } as never);
    expect("sites" in (junk as Record<string, unknown>)).toBe(false);
  });
});

/* ── part 2 — wiring + additive-migration source pins ───────────────────── */

describe("F-031 wiring pins (routes, admin surface, migration)", () => {
  test("devices list route composes its where through scopedDeviceWhere", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/app/api/v1/devices/route.ts", "utf8");
    expect(src).toContain("scopedDeviceWhere(scopeClaims, {");
    expect(src).toContain("await sessionScopeFor(request)");
    // The F-008 read gate is untouched (the scope filter rides AFTER it).
    expect(src).toContain("await requireSessionRead(request)");
  });

  test("devices detail route answers 404-NOT-403 through the row predicate", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/app/api/v1/devices/[id]/route.ts", "utf8");
    expect(src).toContain("sessionAllowsSite(scopeClaims, device.site?.code ?? null)");
    // The gate is FUSED with the not-found branch — no unguarded read path.
    expect(src).toContain("!device || !sessionAllowsSite");
    // The SAME envelope for missing and out-of-scope — no existence leak.
    expect(src).toContain('"DEVICE_NOT_FOUND"');
    // Site-scope wave 2 (device-domain migration): the PATCH mutation plane
    // in this same file now gates through requireSiteScope — the 403
    // SITE_SCOPE_FORBIDDEN contract lives ONLY on the mutation path (both
    // the current-site gate and the repoint-target gate); the GET above
    // keeps the 404-not-403 anti-existence-leak shape.
    expect(src).toContain("requireSiteScope(request, current.site?.code ?? null)");
    expect(src).toContain("requireSiteScope(request, site.code)");
  });

  test("options.ts mints the claim at sign-in and never in the refresh branch", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/auth/options.ts", "utf8");
    expect(src).toContain("userSiteScopeClaim(user.siteScopeJson)");
    // The refresh branch documents the deliberate omission.
    expect(src).toContain("token.sites is deliberately NOT refreshed here");
  });

  test("admin users route: bounded, pattern-validated, deduped siteScope + dedicated audits", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/app/api/v1/admin/users/[id]/route.ts", "utf8");
    expect(src).toContain('SITE_SCOPE_MAX_CODES = 32');
    expect(src).toContain('SITE_SCOPE_MAX_CODE_LENGTH = 32');
    expect(src).toContain('requireRole(request, "admin")');
    expect(src).toContain('"USER_SCOPE_SET"');
    expect(src).toContain('"USER_SCOPE_CLEARED"');
    expect(src).toContain("JSON.stringify(data.siteScope)");
  });

  test("the migration is the additive nullable column (no destructive DDL)", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = "prisma/migrations/20261003024531_add_user_site_scope";
    expect(readdirSync(dir)).toContain("migration.sql");
    const sql = readFileSync(`${dir}/migration.sql`, "utf8");
    expect(sql).toMatch(/ALTER TABLE "User" ADD COLUMN\s+"siteScopeJson" TEXT/);
    expect(sql.toLowerCase()).not.toContain("drop ");
    expect(sql.toLowerCase()).not.toContain("delete ");
    // Schema and migration agree (additive nullable String?).
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    expect(schema).toContain("siteScopeJson String?");
  });

  test("authorization-matrix §5 documents the scoping contract", async () => {
    const { readFileSync } = await import("node:fs");
    const doc = readFileSync("docs/security/authorization-matrix.md", "utf8");
    expect(doc).toContain("5.1 Resource-level site scoping (F-031");
    expect(doc).toContain("404-NOT-403");
    expect(doc).toContain("USER_SCOPE_SET");
    expect(doc).toContain("NEXT sign-in");
  });
});

/* ── part 3 — functional mint-session tests on synthetic fixtures ───────── */

const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
const ORG_NAME = `b25-scope-org-${RUN}`;
const SITE_A_CODE = `B25A-${RUN}`;
const SITE_B_CODE = `B25B-${RUN}`;
const VENDOR_KEY = `b25-scope-vendor-${RUN}`;
const HOST_A = `b25-dev-a-${RUN.toLowerCase()}`;
const HOST_B = `b25-dev-b-${RUN.toLowerCase()}`;
const ADMIN_EMAIL = "admin@faya.local";
const TARGET_EMAIL = `b25-scope-target-${RUN.toLowerCase()}@faya.local`;
const VIEWER_EMAIL = `b25-viewer-${RUN.toLowerCase()}@faya.local`;

const testStartedAt = new Date();

let orgId = "";
let siteAId = "";
let siteBId = "";
let vendorId = "";
let deviceAId = "";
let deviceBId = "";
let targetUserId = "";
let viewerUserId = "";

type SessionShape = { id: string; email: string; name: string | null; role: string; sites?: unknown };

/**
 * The certified rt012/batch-3 session-mint helper, extended with the F-031
 * claim: a REAL next-auth JWT from the production encoder (no mock.module —
 * it is process-wide and poisons later suites). The token shape mirrors
 * exactly what options.ts mints at sign-in: { id, email, name, role,
 * sites? } — the wildcard variant simply OMITS the claim key.
 */
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

async function devicesRequest(jwt: string): Promise<Response> {
  const { GET } = (await import("../../src/app/api/v1/devices/route")) as {
    GET: (req: Request) => Promise<Response>;
  };
  return GET(
    new NextRequest("http://app.local/api/v1/devices?pageSize=100", {
      method: "GET",
      headers: { cookie: `next-auth.session-token=${jwt}` },
    })
  );
}

async function deviceDetailRequest(jwt: string, id: string): Promise<Response> {
  const { GET } = (await import("../../src/app/api/v1/devices/[id]/route")) as {
    GET: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  };
  return GET(
    new NextRequest(`http://app.local/api/v1/devices/${id}`, {
      method: "GET",
      headers: { cookie: `next-auth.session-token=${jwt}` },
    }),
    { params: Promise.resolve({ id }) }
  );
}

async function adminPatchRequest(jwt: string, id: string, body: unknown): Promise<Response> {
  const { PATCH } = (await import("../../src/app/api/v1/admin/users/[id]/route")) as {
    PATCH: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  };
  return PATCH(
    new NextRequest(`http://app.local/api/v1/admin/users/${id}`, {
      method: "PATCH",
      headers: { cookie: `next-auth.session-token=${jwt}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
}

/** The list rows that belong to THIS suite's fixtures (DB is shared). */
function fixtureHostnames(rows: Array<{ hostname: string }>): string[] {
  return rows
    .map((r) => r.hostname)
    .filter((h) => h === HOST_A || h === HOST_B)
    .sort();
}

async function requireSessionRequest(jwt: string, siteCode: string | null): Promise<void> {
  return requireSiteScope(
    new NextRequest("http://app.local/api/v1/devices", {
      method: "GET",
      headers: { cookie: `next-auth.session-token=${jwt}` },
    }),
    siteCode
  );
}

beforeAll(async () => {
  // The CI gate replays ONLY `migrate deploy` (no demo seed): upsert the
  // admin Role + admin identity from ROLE_MATRIX — the certified rt012/
  // batch-3 pattern. Seed-equivalent shared state is never deleted.
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
  const admin = await db.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: { isActive: true },
    create: { email: ADMIN_EMAIL, name: "B25 Admin", role: "admin", isActive: true },
    select: { id: true, email: true, name: true, role: true },
  });

  const viewer = await db.user.create({
    data: { email: VIEWER_EMAIL, name: "B25 Viewer", role: "viewer", isActive: true },
  });
  viewerUserId = viewer.id;

  const target = await db.user.create({
    data: { email: TARGET_EMAIL, name: "B25 Scope Target", role: "viewer", isActive: true },
  });
  targetUserId = target.id;

  const org = await db.organization.create({ data: { name: ORG_NAME } });
  orgId = org.id;
  const siteA = await db.site.create({
    data: { name: `B25 Site A ${RUN}`, code: SITE_A_CODE, organizationId: orgId },
  });
  siteAId = siteA.id;
  const siteB = await db.site.create({
    data: { name: `B25 Site B ${RUN}`, code: SITE_B_CODE, organizationId: orgId },
  });
  siteBId = siteB.id;

  const vendor = await db.vendor.create({
    data: { key: VENDOR_KEY, name: `B25 Scope Vendor ${RUN}`, adapterKey: "generic" },
  });
  vendorId = vendor.id;

  const devA = await db.device.create({
    data: { hostname: HOST_A, mgmtIp: "192.0.2.41", vendorId, siteId: siteAId, status: "ONLINE" },
  });
  deviceAId = devA.id;
  const devB = await db.device.create({
    data: { hostname: HOST_B, mgmtIp: "192.0.2.42", vendorId, siteId: siteBId, status: "ONLINE" },
  });
  deviceBId = devB.id;

  // Sanity: the fixtures really exist before the functional pins run.
  expect(admin.id.length).toBeGreaterThan(0);
  expect(deviceAId).not.toBe(deviceBId);
});

afterAll(async () => {
  // Surgical cleanup in FK order — every fixture row this suite created,
  // nothing else. The audit rows the admin-PATCH tests produced are
  // reclaimed with the established createdAt-gte bound (batch-22 pattern).
  await db.auditEvent.deleteMany({
    where: { resourceType: "User", resourceId: { in: [targetUserId, viewerUserId] }, createdAt: { gte: testStartedAt } },
  });
  await db.device.deleteMany({ where: { id: { in: [deviceAId, deviceBId].filter(Boolean) } } });
  await db.vendor.deleteMany({ where: { id: vendorId } });
  await db.site.deleteMany({ where: { id: { in: [siteAId, siteBId].filter(Boolean) } } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.user.deleteMany({ where: { id: { in: [targetUserId, viewerUserId].filter(Boolean) } } });
});

describe("F-031 functional — device list/detail scoping (minted sessions)", () => {
  test("wildcard session (no sites claim) sees BOTH fixture devices (byte-unchanged parity)", async () => {
    const admin = await db.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { id: true, email: true, name: true, role: true } });
    expect(admin).toBeTruthy();
    const jwt = await mintSessionJwt(admin!);
    const res = await devicesRequest(jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success?: boolean; data?: Array<{ hostname: string }> };
    expect(body.success).toBe(true);
    expect(fixtureHostnames(body.data ?? [])).toEqual([HOST_A, HOST_B].sort());
  });

  test("sites-limited session sees ONLY site A devices in the list", async () => {
    const admin = await db.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { id: true, email: true, name: true, role: true } });
    const jwt = await mintSessionJwt({ ...admin!, sites: [SITE_A_CODE] });
    const res = await devicesRequest(jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: Array<{ hostname: string; site?: { code?: string } }> };
    expect(fixtureHostnames(body.data ?? [])).toEqual([HOST_A]);
    // Every returned fixture row carries an in-scope site code.
    for (const row of body.data ?? []) {
      if (row.site?.code) expect([SITE_A_CODE, SITE_B_CODE]).toContain(row.site.code);
    }
  });

  test("deny-all scope (sites: []) sees NEITHER fixture device", async () => {
    const admin = await db.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { id: true, email: true, name: true, role: true } });
    const jwt = await mintSessionJwt({ ...admin!, sites: [] });
    const res = await devicesRequest(jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: Array<{ hostname: string }> };
    expect(fixtureHostnames(body.data ?? [])).toEqual([]);
  });

  test("MALFORMED claim is fail-closed at the route (neither device visible)", async () => {
    const admin = await db.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { id: true, email: true, name: true, role: true } });
    const spy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const jwt = await mintSessionJwt({ ...admin!, sites: "B25A" });
      const res = await devicesRequest(jwt);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data?: Array<{ hostname: string }> };
      expect(fixtureHostnames(body.data ?? [])).toEqual([]);
      // The deny-all classification logged its audit line.
      expect(spy.mock.calls.some((args) => String(args[0]).includes("[auth:scope]"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("detail: in-scope 200, out-of-scope 404, missing 404 — SAME envelope code", async () => {
    const admin = await db.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { id: true, email: true, name: true, role: true } });
    const scopedJwt = await mintSessionJwt({ ...admin!, sites: [SITE_A_CODE] });
    const wildcardJwt = await mintSessionJwt(admin!);

    // In-scope detail → 200 with the device payload.
    const okRes = await deviceDetailRequest(scopedJwt, deviceAId);
    expect(okRes.status).toBe(200);
    const okBody = (await okRes.json()) as { data?: { hostname?: string } };
    expect(okBody.data?.hostname).toBe(HOST_A);

    // Out-of-scope detail → 404 NOT 403 (existence-leak avoidance).
    const hiddenRes = await deviceDetailRequest(scopedJwt, deviceBId);
    expect(hiddenRes.status).toBe(404);

    // A MISSING device answers the IDENTICAL envelope code.
    const missingRes = await deviceDetailRequest(scopedJwt, "device-b25-does-not-exist");
    expect(missingRes.status).toBe(404);
    const hiddenBody = (await hiddenRes.json()) as { error?: { code?: string } };
    const missingBody = (await missingRes.json()) as { error?: { code?: string } };
    expect(hiddenBody.error?.code).toBe("DEVICE_NOT_FOUND");
    expect(missingBody.error?.code).toBe(hiddenBody.error?.code);

    // Wildcard detail on the same out-of-scope device → 200 (the list hides
    // nothing for wildcard sessions, so neither does the detail route).
    const wildcardRes = await deviceDetailRequest(wildcardJwt, deviceBId);
    expect(wildcardRes.status).toBe(200);
  });
});

describe("F-031 functional — requirePermission-family scope gates", () => {
  test("requireSiteScope: wildcard passes, out-of-scope throws 403-class AuthError, null site bypasses", async () => {
    const admin = await db.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { id: true, email: true, name: true, role: true } });
    const scopedJwt = await mintSessionJwt({ ...admin!, sites: [SITE_A_CODE] });
    const wildcardJwt = await mintSessionJwt(admin!);
    const denyAllJwt = await mintSessionJwt({ ...admin!, sites: [] });

    await expect(requireSessionRequest(wildcardJwt, SITE_B_CODE)).resolves.toBeUndefined();
    await expect(requireSessionRequest(scopedJwt, SITE_A_CODE)).resolves.toBeUndefined();

    try {
      await requireSessionRequest(scopedJwt, SITE_B_CODE);
      throw new Error("expected AuthError");
    } catch (error) {
      expect(error instanceof AuthError).toBe(true);
      expect((error as AuthError).code).toBe("SITE_SCOPE_FORBIDDEN");
      expect((error as AuthError).status).toBe(403);
    }

    // The unscoped-resource rule: a null site bypasses even a deny-all scope.
    await expect(requireSessionRequest(denyAllJwt, null)).resolves.toBeUndefined();
  });

  test("sessionScopeFor resolves the minted claims (and null for the bearer plane)", async () => {
    const admin = await db.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { id: true, email: true, name: true, role: true } });
    const scopedJwt = await mintSessionJwt({ ...admin!, sites: [SITE_A_CODE] });
    const claims = await sessionScopeFor(
      new NextRequest("http://app.local/api/v1/devices", {
        method: "GET",
        headers: { cookie: `next-auth.session-token=${scopedJwt}` },
      })
    );
    expect(claims?.sites).toEqual([SITE_A_CODE]);

    // No session at all → null claims → wildcard downstream (the bearer /
    // anonymous planes never carry a site scope in F-031).
    const anon = await sessionScopeFor(new NextRequest("http://app.local/api/v1/devices", { method: "GET" }));
    expect(anon).toBeNull();
  });
});

describe("F-031 functional — admin scope administration (PATCH users/[id])", () => {
  test("non-admin session → 403 RBAC_FORBIDDEN (admin-only write surface)", async () => {
    const viewer = await db.user.findUnique({ where: { email: VIEWER_EMAIL }, select: { id: true, email: true, name: true, role: true } });
    const jwt = await mintSessionJwt(viewer!);
    const res = await adminPatchRequest(jwt, targetUserId, { siteScope: [SITE_A_CODE] });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("RBAC_FORBIDDEN");
    // Nothing was written.
    const after = await db.user.findUnique({ where: { id: targetUserId }, select: { siteScopeJson: true } });
    expect(after?.siteScopeJson).toBeNull();
  });

  test("invalid scope → 400 INVALID_BODY (bad pattern, too many codes)", async () => {
    const admin = await db.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { id: true, email: true, name: true, role: true } });
    const jwt = await mintSessionJwt(admin!);

    const badPattern = await adminPatchRequest(jwt, targetUserId, { siteScope: ["HAS SPACE"] });
    expect(badPattern.status).toBe(400);
    expect(((await badPattern.json()) as { error?: { code?: string } }).error?.code).toBe("INVALID_BODY");

    const tooMany = await adminPatchRequest(jwt, targetUserId, {
      siteScope: Array.from({ length: 33 }, (_, i) => `S${i}`),
    });
    expect(tooMany.status).toBe(400);

    const tooLong = await adminPatchRequest(jwt, targetUserId, { siteScope: ["x".repeat(33)] });
    expect(tooLong.status).toBe(400);

    const after = await db.user.findUnique({ where: { id: targetUserId }, select: { siteScopeJson: true } });
    expect(after?.siteScopeJson).toBeNull();
  });

  test("set → 200, deduped stored scope, USER_SCOPE_SET audit row", async () => {
    const admin = await db.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { id: true, email: true, name: true, role: true } });
    const jwt = await mintSessionJwt(admin!);

    // Duplicates + padding in, deduped order-preserving out.
    const res = await adminPatchRequest(jwt, targetUserId, {
      siteScope: [SITE_B_CODE, SITE_A_CODE, SITE_B_CODE],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { user?: { siteScope?: string[] } } };
    expect(body.data?.user?.siteScope).toEqual([SITE_B_CODE, SITE_A_CODE]);

    const stored = await db.user.findUnique({ where: { id: targetUserId }, select: { siteScopeJson: true } });
    expect(stored?.siteScopeJson).toBe(JSON.stringify([SITE_B_CODE, SITE_A_CODE]));

    const audit = await db.auditEvent.findFirst({
      where: { action: "USER_SCOPE_SET", resourceId: targetUserId, createdAt: { gte: testStartedAt } },
    });
    expect(audit).toBeTruthy();
    expect(JSON.parse(audit!.afterJson ?? "{}")).toEqual({ siteScope: [SITE_B_CODE, SITE_A_CODE] });
    // First SET: the effective prior scope was the wildcard (null).
    expect(JSON.parse(audit!.beforeJson ?? "{}")).toEqual({ siteScope: null });
  });

  test("clear → USER_SCOPE_CLEARED, column back to null (wildcard reset)", async () => {
    const admin = await db.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { id: true, email: true, name: true, role: true } });
    const jwt = await mintSessionJwt(admin!);

    const res = await adminPatchRequest(jwt, targetUserId, { siteScope: null });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { user?: { siteScope?: string[] | null } } };
    expect(body.data?.user?.siteScope).toBeNull();

    const stored = await db.user.findUnique({ where: { id: targetUserId }, select: { siteScopeJson: true } });
    expect(stored?.siteScopeJson).toBeNull();

    const audit = await db.auditEvent.findFirst({
      where: { action: "USER_SCOPE_CLEARED", resourceId: targetUserId, createdAt: { gte: testStartedAt } },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).toBeTruthy();
    expect(JSON.parse(audit!.afterJson ?? "{}")).toEqual({ siteScope: null });
  });

  test("a scope-only PATCH writes NO USER_UPDATED row (each audit row states one fact)", async () => {
    const count = await db.auditEvent.count({
      where: { action: "USER_UPDATED", resourceId: targetUserId, createdAt: { gte: testStartedAt } },
    });
    expect(count).toBe(0);
  });

  test("effect timing: the refresh callback does NOT re-read the scope (next sign-in)", async () => {
    // Store a scope for the target user, then run the jwt callback's REFRESH
    // branch (no `user` argument) on a token minted WITHOUT the claim: the
    // token must NOT gain the scope, and a token that CARRIES a stale claim
    // must keep it — a scope change lands on the NEXT sign-in only.
    await db.user.update({ where: { id: targetUserId }, data: { siteScopeJson: JSON.stringify([SITE_A_CODE]) } });
    const jwt = authOptions.callbacks?.jwt;
    expect(jwt).toBeDefined();

    const refreshedWild = await jwt!({
      token: { id: targetUserId, email: TARGET_EMAIL, name: "T", role: "viewer" } as never,
    } as never);
    expect("sites" in (refreshedWild as Record<string, unknown>)).toBe(false);

    const refreshedStale = await jwt!({
      token: { id: targetUserId, email: TARGET_EMAIL, name: "T", role: "viewer", sites: [SITE_B_CODE] } as never,
    } as never);
    expect((refreshedStale as Record<string, unknown>).sites).toEqual([SITE_B_CODE]);

    await db.user.update({ where: { id: targetUserId }, data: { siteScopeJson: null } });
  });
});
