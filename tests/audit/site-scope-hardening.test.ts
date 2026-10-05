/**
 * Site-scope wave 7 hardening — fixes from the F-031 wave-7 read-only audit
 * (three agents: 7-a primitives, 7-b route sweep, 7-c rig/docs), pinned with
 * the batch-25 certified rig (REAL next-auth JWTs from the production
 * `encode`, synthetic fixtures only, surgical afterAll cleanup):
 *
 *   P3 (7-a F3)  normalizeSiteScopeCodes bounds per-code LENGTH: any member
 *                longer than SITE_SCOPE_MAX_CODE_CHARS (64) makes the WHOLE
 *                claim MALFORMED → deny-all + console.warn (mint AND
 *                enforcement), never truncated. The write surface caps
 *                codes at 32 chars, so a >64-char member can only come
 *                from a hand-edited DB row — the hand-edited-row threat
 *                model must bound cookie size, not just the code count.
 *   P3 (7-a F4)  requireSiteScope is an auth gate by ENFORCEMENT, not
 *                convention: a null-claims principal asserting a concrete
 *                site answers the same 401 UNAUTHENTICATED envelope the
 *                require* gates produce (it used to resolve wildcard and
 *                pass — safe only because every call site is ordered
 *                behind an auth gate). Null siteCode keeps the documented
 *                unscoped-resource bypass.
 *   P3 (7-a F6)  the token contract reads/writes the single-sourced
 *                SITE_SCOPE_CLAIM_KEY constant (no hardcoded "sites"
 *                literal left on the token plane).
 *   P3 (7-b F-3) create-surface gates: csv-import skips out-of-scope ROWS
 *                with the route's row-error shape and a SITE_SCOPE_FORBIDDEN
 *                reason (request never aborts; wildcard byte-unchanged);
 *                discovery/import and ztp/claims gate the resolved site
 *                through requireSiteScope (existence error first, then the
 *                scope 403 — the POST /api/v1/devices ordering).
 *   P3 (7-b F-4) the POST /api/v1/devices hostname probe composes
 *                scopedDeviceWhere, so a sites-limited session no longer
 *                gets a global existence oracle; a CROSS-scope collision
 *                falls through to the hostname @unique constraint and
 *                answers the SAME HOSTNAME_TAKEN envelope.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { db } from "../../src/lib/db";
import {
  SITE_SCOPE_CLAIM_KEY,
  SITE_SCOPE_MAX_CODE_CHARS,
  SITE_SCOPE_MAX_CODES,
  normalizeSiteScopeCodes,
  sessionSiteScope,
  userSiteScopeClaim,
} from "../../src/lib/auth/scope";
import {
  AuthError,
  requireSiteScope,
  sessionScopeFor,
} from "../../src/lib/auth/session";
import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";

/* ── part 1 — pure parser pins (no DB) ─────────────────────────────────── */

describe("wave7: per-code length cap in the scope parser (7-a F3)", () => {
  const OVER = "X".repeat(SITE_SCOPE_MAX_CODE_CHARS + 1);
  const EXACT = "Y".repeat(SITE_SCOPE_MAX_CODE_CHARS);

  test("a member over 64 chars makes the WHOLE claim MALFORMED (never truncated)", () => {
    expect(normalizeSiteScopeCodes(["OK", OVER])).toBeNull();
    expect(normalizeSiteScopeCodes([OVER])).toBeNull();
  });

  test("the boundary is exact: 64 chars still validates (case handling untouched)", () => {
    expect(normalizeSiteScopeCodes([EXACT])).toEqual([EXACT]);
    // An oversized member fails no matter what else is in the list.
    expect(normalizeSiteScopeCodes(["ok", OVER])).toBeNull();
  });

  test("sessionSiteScope classifies the oversized member deny-all + console.warn", () => {
    const warns: unknown[][] = [];
    const spy = spyOn(console, "warn").mockImplementation((...args) => {
      warns.push(args);
    });
    try {
      expect(sessionSiteScope({ sites: ["OK", OVER] })).toEqual({
        mode: "sites",
        codes: [],
      });
      expect(
        warns.some((args) =>
          String(args[0]).includes("[auth:scope] malformed site-scope claim")
        )
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("mint level: userSiteScopeClaim returns [] (deny-all) for such a row", () => {
    expect(
      userSiteScopeClaim(JSON.stringify(["HQ-OK", OVER]))
    ).toEqual([]);
    // The oversized row never mints a claim carrying the long member.
    expect(
      JSON.stringify(userSiteScopeClaim(JSON.stringify([OVER])))
    ).not.toContain(OVER);
  });

  test("the count rule and the length rule are independent bounds", () => {
    expect(SITE_SCOPE_MAX_CODES).toBe(32);
    expect(SITE_SCOPE_MAX_CODE_CHARS).toBe(64);
    // 32 short codes still validate; 33 do not (the wave-5 rule intact).
    const short = Array.from({ length: SITE_SCOPE_MAX_CODES }, (_, i) => `s${i}`);
    expect(normalizeSiteScopeCodes(short)).toEqual(short);
    expect(normalizeSiteScopeCodes([...short, "one-more"])).toBeNull();
  });
});

/* ── part 2 — claim-key constant adoption (7-a F6, source pins) ────────── */

describe("wave7: the token contract uses SITE_SCOPE_CLAIM_KEY, not literals", () => {
  const REPO_ROOT = join(import.meta.dir, "../..");
  function read(relPath: string): string {
    return readFileSync(join(REPO_ROOT, relPath), "utf8");
  }

  test("the exported constant is still the JWT contract key", () => {
    expect(SITE_SCOPE_CLAIM_KEY).toBe("sites");
  });

  test("SOURCE PIN: options.ts reads/writes the constant on the token plane", () => {
    const src = read("src/lib/auth/options.ts");
    expect(src).toContain("token[SITE_SCOPE_CLAIM_KEY] = sites");
    expect(src).toContain("{ [SITE_SCOPE_CLAIM_KEY]: siteScope }");
    // The executable literals are gone (a doc-comment mention of the old
    // spelling survives deliberately — it is pinned verbatim by batch-25).
    expect(src).not.toContain("token.sites =");
    expect(src).not.toContain("{ sites: siteScope }");
  });

  test("SOURCE PIN: session.ts reads the constant when passing claims through", () => {
    const src = read("src/lib/auth/session.ts");
    expect(src).toContain("sites: token[SITE_SCOPE_CLAIM_KEY]");
    expect(src).not.toContain("token.sites");
  });
});

/* ── part 3 — fixtures + certified mint rig (batch-25 pattern) ─────────── */

const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
const PREFIX = `w7h-`;
const ORG_NAME = `${PREFIX}org-${RUN}`;
const SITE_A_CODE = `W7A-${RUN}`;
const SITE_B_CODE = `W7B-${RUN}`;
const HOST_A = `${PREFIX}dev-a-${RUN.toLowerCase()}`; // lives at site A
const HOST_B = `${PREFIX}dev-b-${RUN.toLowerCase()}`; // lives at site B
const ADMIN_EMAIL = `${PREFIX}admin-${RUN.toLowerCase()}@faya.local`;

const testStartedAt = new Date();

let orgId = "";
let siteAId = "";
let siteBId = "";
let vendorId = "";
let deviceAId = "";
let deviceBId = "";
let adminId = "";
let discoveryJobId = "";
let ciscoVendorOwnedBySuite = false;
const createdDeviceIds: string[] = [];

type SessionShape = { id: string; email: string; name: string | null; role: string; sites?: unknown };

/** The certified rt012/batch-3 session-mint helper (real next-auth encode). */
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

async function adminJwt(sites?: unknown): Promise<string> {
  const claims: SessionShape = {
    id: adminId,
    email: ADMIN_EMAIL,
    name: "W7 Hardening Admin",
    role: "admin",
  };
  if (sites !== undefined) claims.sites = sites;
  return mintSessionJwt(claims);
}

function getRequest(url: string, jwt: string): NextRequest {
  return new NextRequest(url, {
    method: "GET",
    headers: { cookie: `next-auth.session-token=${jwt}` },
  });
}

function postRequest(url: string, jwt: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `next-auth.session-token=${jwt}`,
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  // The CI gate replays ONLY `migrate deploy` (no demo seed): upsert the
  // admin Role from ROLE_MATRIX — the certified batch-25 pattern.
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
    data: { email: ADMIN_EMAIL, name: "W7 Hardening Admin", role: "admin", isActive: true },
    select: { id: true },
  });
  adminId = admin.id;

  const org = await db.organization.create({ data: { name: ORG_NAME } });
  orgId = org.id;
  const siteA = await db.site.create({
    data: { name: `W7 Site A ${RUN}`, code: SITE_A_CODE, organizationId: orgId },
  });
  siteAId = siteA.id;
  const siteB = await db.site.create({
    data: { name: `W7 Site B ${RUN}`, code: SITE_B_CODE, organizationId: orgId },
  });
  siteBId = siteB.id;

  const vendor = await db.vendor.create({
    data: { key: `w7h-vendor-${RUN}`, name: `W7 Hardening Vendor ${RUN}`, adapterKey: "generic" },
  });
  vendorId = vendor.id;

  // ZTP claims validate vendorKey against the in-code template catalog
  // (cisco-ztp provisions the seeded "cisco" vendor). Ensure the row the
  // catalog names exists WITHOUT touching it if the seed already made it —
  // the same ensure-don't-modify pattern batch-25 uses for the admin role.
  const cisco = await db.vendor.findUnique({ where: { key: "cisco" } });
  if (!cisco) {
    await db.vendor.create({
      data: { key: "cisco", name: `W7 Cisco Placeholder ${RUN}`, adapterKey: "generic" },
    });
    ciscoVendorOwnedBySuite = true;
  }

  const devA = await db.device.create({
    data: { hostname: HOST_A, mgmtIp: "192.0.2.71", vendorId, siteId: siteAId, status: "ONLINE" },
  });
  deviceAId = devA.id;
  createdDeviceIds.push(deviceAId);
  const devB = await db.device.create({
    data: { hostname: HOST_B, mgmtIp: "192.0.2.72", vendorId, siteId: siteBId, status: "ONLINE" },
  });
  deviceBId = devB.id;
  createdDeviceIds.push(deviceBId);

  const job = await db.jobExecution.create({
    data: {
      type: "DISCOVERY",
      status: "SUCCEEDED",
      correlationId: `JOB-W7H-${RUN}`,
      resultJson: JSON.stringify({ candidates: [] }),
    },
  });
  discoveryJobId = job.id;

  expect(adminId.length).toBeGreaterThan(0);
});

afterAll(async () => {
  // Surgical cleanup in FK order — every fixture row this suite created,
  // nothing else (the shared "cisco" vendor row is deleted ONLY when this
  // suite created it; a seeded row is left exactly as found).
  await db.auditEvent.deleteMany({
    where: {
      resourceType: "Device",
      resourceId: { in: createdDeviceIds },
      createdAt: { gte: testStartedAt },
    },
  });
  await db.device.deleteMany({ where: { id: { in: createdDeviceIds } } });
  await db.jobExecution.deleteMany({ where: { id: discoveryJobId } });
  if (ciscoVendorOwnedBySuite) {
    await db.vendor.deleteMany({ where: { key: "cisco" } });
  }
  await db.vendor.deleteMany({ where: { id: vendorId } });
  await db.site.deleteMany({ where: { id: { in: [siteAId, siteBId].filter(Boolean) } } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.user.deleteMany({ where: { id: adminId } });
});

/* ── part 4 — requireSiteScope strictness (7-a F4) ─────────────────────── */

describe("wave7: requireSiteScope is an enforcement gate, not convention", () => {
  test("a null-claims principal asserting a concrete site gets the auth-gate 401 envelope", async () => {
    const req = new NextRequest("http://app.local/api/v1/devices", { method: "GET" });
    // Sanity: the request really carries no session claims.
    expect(await sessionScopeFor(req)).toBeNull();
    try {
      await requireSiteScope(req, "W7-SOME-SITE");
      throw new Error("expected AuthError");
    } catch (error) {
      expect(error instanceof AuthError).toBe(true);
      expect((error as AuthError).code).toBe("UNAUTHENTICATED");
      expect((error as AuthError).status).toBe(401);
      // Verbatim reuse of the require* gates' envelope message.
      expect((error as AuthError).message).toBe(
        "Sign in required — no valid session was provided."
      );
    }
  });

  test("the null siteCode (unscoped resource) bypass survives null claims", async () => {
    const req = new NextRequest("http://app.local/api/v1/devices", { method: "GET" });
    await expect(requireSiteScope(req, null)).resolves.toBeUndefined();
  });

  test("legitimate flows still pass: wildcard + in-scope allowed, out-of-scope 403", async () => {
    const wildcard = getRequest("http://app.local/api/v1/devices", await adminJwt());
    await expect(requireSiteScope(wildcard, SITE_B_CODE)).resolves.toBeUndefined();

    const scoped = getRequest("http://app.local/api/v1/devices", await adminJwt([SITE_A_CODE]));
    await expect(requireSiteScope(scoped, SITE_A_CODE)).resolves.toBeUndefined();

    const outOfScope = getRequest("http://app.local/api/v1/devices", await adminJwt([SITE_A_CODE]));
    try {
      await requireSiteScope(outOfScope, SITE_B_CODE);
      throw new Error("expected AuthError");
    } catch (error) {
      expect(error instanceof AuthError).toBe(true);
      expect((error as AuthError).code).toBe("SITE_SCOPE_FORBIDDEN");
      expect((error as AuthError).status).toBe(403);
    }
  });
});

/* ── part 5 — route-level length cap + csv-import row gates (7-a F3 / 7-b F-3) ── */

async function devicesList(jwt: string): Promise<Response> {
  const { GET } = (await import("../../src/app/api/v1/devices/route")) as {
    GET: (req: Request) => Promise<Response>;
  };
  return GET(getRequest("http://app.local/api/v1/devices?pageSize=100", jwt));
}

describe("wave7: create surfaces honor the session's site scope", () => {
  test("ROUTE PROBE: an oversized claim member is deny-all at the devices list (200, zero rows, warn)", async () => {
    const spy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const jwt = await adminJwt([SITE_A_CODE, "X".repeat(SITE_SCOPE_MAX_CODE_CHARS + 1)]);
      const res = await devicesList(jwt);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data?: unknown[]; meta?: { total?: number } };
      expect(body.data).toEqual([]); // deny-all — nothing leaks, not even other tenants' rows
      expect(body.meta?.total).toBe(0);
      expect(
        spy.mock.calls.some((args) => String(args[0]).includes("[auth:scope]"))
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("csv-import: the out-of-scope ROW is skipped SITE_SCOPE_FORBIDDEN, the in-scope row still imports", async () => {
    const { POST } = (await import("../../src/app/api/v1/devices/csv-import/route")) as {
      POST: (req: Request) => Promise<Response>;
    };
    const hostIn = `${PREFIX}imp-a-${RUN.toLowerCase()}`;
    const hostOut = `${PREFIX}imp-b-${RUN.toLowerCase()}`;
    const jwt = await adminJwt([SITE_A_CODE]);
    const res = await POST(
      postRequest("http://app.local/api/v1/devices/csv-import", jwt, {
        rows: [
          { hostname: hostIn, vendor: `w7h-vendor-${RUN}`, mgmtIp: "192.0.2.81", siteCode: SITE_A_CODE },
          { hostname: hostOut, vendor: `w7h-vendor-${RUN}`, mgmtIp: "192.0.2.82", siteCode: SITE_B_CODE },
        ],
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data?: {
        created: number;
        devices: { id: string; hostname: string }[];
        skipped: { ip: string; reason: string }[];
      };
    };
    // Per-row semantics: the request did NOT abort; exactly one row imported.
    expect(body.data?.created).toBe(1);
    expect(body.data?.devices.map((d) => d.hostname)).toEqual([hostIn]);
    createdDeviceIds.push(...(body.data?.devices ?? []).map((d) => d.id));
    const skipped = body.data?.skipped ?? [];
    expect(skipped.length).toBe(1);
    expect(skipped[0]?.ip).toBe("192.0.2.82");
    expect(skipped[0]?.reason).toContain("SITE_SCOPE_FORBIDDEN");
    expect(skipped[0]?.reason).toContain(SITE_B_CODE);
    // DB truth: the in-scope device exists, the out-of-scope one was never created.
    expect(await db.device.findUnique({ where: { hostname: hostIn }, select: { id: true } })).toBeTruthy();
    expect(await db.device.findUnique({ where: { hostname: hostOut }, select: { id: true } })).toBeNull();
  });

  test("csv-import: a deny-all session imports NOTHING (every site is out of scope)", async () => {
    const { POST } = (await import("../../src/app/api/v1/devices/csv-import/route")) as {
      POST: (req: Request) => Promise<Response>;
    };
    const hostDeny = `${PREFIX}deny-${RUN.toLowerCase()}`;
    const jwt = await adminJwt([]);
    const res = await POST(
      postRequest("http://app.local/api/v1/devices/csv-import", jwt, {
        rows: [
          { hostname: hostDeny, vendor: `w7h-vendor-${RUN}`, mgmtIp: "192.0.2.83", siteCode: SITE_A_CODE },
        ],
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data?: { created: number; skipped: { reason: string }[] };
    };
    expect(body.data?.created).toBe(0);
    expect(body.data?.skipped[0]?.reason).toContain("SITE_SCOPE_FORBIDDEN");
    expect(
      await db.device.findUnique({ where: { hostname: hostDeny }, select: { id: true } })
    ).toBeNull();
  });

  test("csv-import: a wildcard session imports into BOTH sites (byte-unchanged)", async () => {
    const { POST } = (await import("../../src/app/api/v1/devices/csv-import/route")) as {
      POST: (req: Request) => Promise<Response>;
    };
    const hostWcA = `${PREFIX}wc-a-${RUN.toLowerCase()}`;
    const hostWcB = `${PREFIX}wc-b-${RUN.toLowerCase()}`;
    const jwt = await adminJwt(); // no sites claim → wildcard
    const res = await POST(
      postRequest("http://app.local/api/v1/devices/csv-import", jwt, {
        rows: [
          { hostname: hostWcA, vendor: `w7h-vendor-${RUN}`, mgmtIp: "192.0.2.84", siteCode: SITE_A_CODE },
          { hostname: hostWcB, vendor: `w7h-vendor-${RUN}`, mgmtIp: "192.0.2.85", siteCode: SITE_B_CODE },
        ],
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data?: { created: number; devices: { id: string }[]; skipped: unknown[] };
    };
    expect(body.data?.created).toBe(2);
    expect(body.data?.skipped).toEqual([]);
    createdDeviceIds.push(...(body.data?.devices ?? []).map((d) => d.id));
  });

  test("discovery/import: existence 400 first, then the scope 403 on the target site", async () => {
    const { POST } = (await import("../../src/app/api/v1/discovery/import/route")) as {
      POST: (req: Request) => Promise<Response>;
    };
    const jwt = await adminJwt([SITE_A_CODE]);
    const url = "http://app.local/api/v1/discovery/import";

    // Ordering pin: a NONEXISTENT site answers its own 400 (existence error
    // precedes any scope decision — the POST /devices contract).
    const missing = await POST(
      postRequest(url, jwt, { jobId: discoveryJobId, ips: ["192.0.2.90"], siteId: "w7h-no-such-site" })
    );
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error?: { code?: string } }).error?.code).toBe("SITE_NOT_FOUND");

    // The real site resolves → the scope gate fires (whole-request 403).
    const forbidden = await POST(
      postRequest(url, jwt, { jobId: discoveryJobId, ips: ["192.0.2.90"], siteId: siteBId })
    );
    expect(forbidden.status).toBe(403);
    const body = (await forbidden.json()) as {
      error?: { code?: string; message?: string };
    };
    expect(body.error?.code).toBe("SITE_SCOPE_FORBIDDEN");
    expect(body.error?.message).toContain(SITE_B_CODE);

    // Wildcard is unaffected by the gate (fails later on empty candidates,
    // which proves the request REACHED the import logic).
    const wildcardRes = await POST(
      postRequest(url, await adminJwt(), { jobId: discoveryJobId, ips: ["192.0.2.90"], siteId: siteBId })
    );
    expect(wildcardRes.status).toBe(200);
    const wildcardBody = (await wildcardRes.json()) as { data?: { created: number } };
    expect(wildcardBody.data?.created).toBe(0);
  });

  test("ztp/claims: existence 422 first, then the scope 403 on the claim's site", async () => {
    const { POST } = (await import("../../src/app/api/v1/ztp/claims/route")) as {
      POST: (req: Request) => Promise<Response>;
    };
    const jwt = await adminJwt([SITE_A_CODE]);
    const url = "http://app.local/api/v1/ztp/claims";
    const claim = (siteId: string) => ({
      serial: `W7H-${RUN}-0001`,
      hostname: `${PREFIX}ztp-${RUN.toLowerCase()}`,
      vendorKey: "cisco",
      model: "W7 Hardened Model",
      templateId: "cisco-ztp",
      siteId,
    });

    // Ordering pin: a NONEXISTENT site answers 422 SITE_NOT_FOUND first.
    const missing = await POST(postRequest(url, jwt, claim("w7h-no-such-site")));
    expect(missing.status).toBe(422);
    expect(((await missing.json()) as { error?: { code?: string } }).error?.code).toBe("SITE_NOT_FOUND");

    // The real out-of-scope site resolves → requireSiteScope answers 403
    // BEFORE any duplicate-guard/claim-row work happens.
    const forbidden = await POST(postRequest(url, jwt, claim(siteBId)));
    expect(forbidden.status).toBe(403);
    const body = (await forbidden.json()) as {
      error?: { code?: string; message?: string };
    };
    expect(body.error?.code).toBe("SITE_SCOPE_FORBIDDEN");
    expect(body.error?.message).toContain(SITE_B_CODE);
    // Nothing was written.
    expect(
      await db.ztpClaim.findFirst({ where: { serial: `W7H-${RUN}-0001` }, select: { id: true } })
    ).toBeNull();
  });
});

/* ── part 6 — hostname existence-oracle scoping (7-b F-4) ──────────────── */

describe("wave7: the POST /devices hostname probe is scope-composed", () => {
  async function createDevice(jwt: string, hostname: string): Promise<Response> {
    const { POST } = (await import("../../src/app/api/v1/devices/route")) as {
      POST: (req: Request) => Promise<Response>;
    };
    return POST(
      postRequest("http://app.local/api/v1/devices", jwt, {
        hostname,
        vendorId,
        mgmtIp: "192.0.2.99",
        siteId: siteBId,
      })
    );
  }

  test("SOURCE PIN: the probe composes scopedDeviceWhere over sessionScopeFor", async () => {
    const src = readFileSync(
      join(import.meta.dir, "../../src/app/api/v1/devices/route.ts"),
      "utf8"
    );
    expect(src).toContain("scopedDeviceWhere(await sessionScopeFor(request)");
  });

  test("an in-scope collision 409s from the probe; a CROSS-scope collision answers the SAME envelope", async () => {
    const jwt = await adminJwt([SITE_B_CODE]);

    // In-scope collision (HOST_B lives at site B): the scoped probe sees it.
    const inScope = await createDevice(jwt, HOST_B);
    expect(inScope.status).toBe(409);
    const inScopeBody = (await inScope.json()) as { error?: { code?: string; message?: string } };
    expect(inScopeBody.error?.code).toBe("HOSTNAME_TAKEN");

    // CROSS-scope collision (HOST_A lives at site A): the scoped probe no
    // longer confirms it (no existence oracle) — the create falls through
    // to the hostname @unique constraint, whose catch answers the SAME
    // HOSTNAME_TAKEN envelope. The constraint held: still exactly one row.
    const crossScope = await createDevice(jwt, HOST_A);
    expect(crossScope.status).toBe(409);
    const crossBody = (await crossScope.json()) as { error?: { code?: string; message?: string } };
    expect(crossBody.error?.code).toBe("HOSTNAME_TAKEN");
    // The constraint path produces the envelope the probe would have
    // produced for the same candidate hostname (code AND message shape).
    expect(crossBody.error?.message).toBe(
      `A device with hostname "${HOST_A}" already exists`
    );
    expect(await db.device.count({ where: { hostname: HOST_A } })).toBe(1);

    // Wildcard parity: the same duplicate create still 409s from the probe.
    const wildcard = await createDevice(await adminJwt(), HOST_A);
    expect(wildcard.status).toBe(409);
    expect(((await wildcard.json()) as { error?: { code?: string } }).error?.code).toBe("HOSTNAME_TAKEN");
    expect(await db.device.count({ where: { hostname: HOST_A } })).toBe(1);
  });
});
