/**
 * GA-1 tenancy completion (2026-10-06 re-audit P1-A02 + P1-A03).
 *
 * Pins the two repository-actionable authorization gaps the re-audit confirmed:
 *
 *   P1-A02  GET /api/v1/sites — the site catalog itself is scope-aware. A
 *           sites-limited session sees only ITS site rows (the response
 *           carries operational metadata + addresses); aggregates are
 *           composed over the same scope; the wildcard default (absent
 *           claim) stays byte-identical; deny-all and malformed claims
 *           match nothing (fail-closed).
 *
 *   P1-A03  POST /api/v1/backup-policies and PATCH /api/v1/backup-policies/[id]
 *           — a sites-limited config.backup holder can no longer ACTUATE
 *           outside its scope: no out-of-scope site codes, no "*", and no
 *           missing/empty siteCodes list (empty = fleet-wide under the
 *           canonical scope contract). PATCH replaces scope whole when
 *           provided, so the guard evaluates the EFFECTIVE post-replacement
 *           list; a patch that does not touch scope cannot widen anything.
 *           Wildcard sessions keep byte-identical behavior (a fleet-wide
 *           policy is still creatable there).
 *
 * Certified rig (batch-25/wave-9 discipline): REAL next-auth JWTs from the
 * production `encode`, RUN-suffixed fixtures, surgical afterAll cleanup.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";

import { db } from "../../src/lib/db";
import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";
import { backupPolicyScopeDenial } from "../../src/app/api/v1/backup-policies/policy-scope";

/* ── fixtures (RUN-suffixed — parallel-safe, re-runnable) ─────────────── */

const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
const PREFIX = `ga1-`;
const ORG_NAME = `${PREFIX}org-${RUN}`;
const SITE_A_CODE = `G1A-${RUN}`; // inside the scoped session's scope
const SITE_B_CODE = `G1B-${RUN}`; // out of scope for the scoped session
const VENDOR_KEY = `${PREFIX}vendor-${RUN}`;
const HOST_A = `${PREFIX}dev-a-${RUN.toLowerCase()}`;
const HOST_B = `${PREFIX}dev-b-${RUN.toLowerCase()}`;
const IP_A = `192.0.2.2${(parseInt(RUN.slice(0, 2), 36) % 40) + 30}`;
const IP_B = `192.0.2.2${(parseInt(RUN.slice(2, 4), 36) % 40) + 70}`;
const ADMIN_EMAIL = `${PREFIX}admin-${RUN.toLowerCase()}@faya.local`;

const testStartedAt = new Date();

let orgId = "";
let siteAId = "";
let siteBId = "";
let vendorId = "";
let deviceAId = "";
let deviceBId = "";
let adminId = "";
const createdPolicyIds: string[] = [];
const createdAuditCorrelations: string[] = [];

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
    name: "GA-1 Tenancy Admin",
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

type Envelope = {
  success?: boolean;
  data?: unknown;
  meta?: Record<string, unknown>;
  error?: { code?: string; message?: string };
};

async function importGet(relPath: string) {
  const mod = (await import(relPath)) as { GET: (req: Request) => Promise<Response> };
  return mod.GET;
}

async function importPost(relPath: string) {
  const mod = (await import(relPath)) as { POST: (req: Request) => Promise<Response> };
  return mod.POST;
}

async function importPatch(relPath: string) {
  const mod = (await import(relPath)) as {
    PATCH: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  };
  return mod.PATCH;
}

const POLICY_BASE = "http://app.local/api/v1/backup-policies";

/** Create one policy via the POST handler; registers it for cleanup. */
async function createPolicy(
  jwt: string,
  body: Record<string, unknown>
): Promise<{ status: number; envelope: Envelope }> {
  const POST = await importPost("../../src/app/api/v1/backup-policies/route");
  const res = await POST(jsonRequest("POST", POLICY_BASE, jwt, body));
  const envelope = (await res.json()) as Envelope;
  if (res.status === 201) {
    const data = envelope.data as { policy?: { id?: string }; correlationId?: string } | undefined;
    const policyId = (data as { policy?: { id?: string } })?.policy?.id;
    if (policyId) createdPolicyIds.push(policyId);
    const corr = (envelope.meta as { correlationId?: string })?.correlationId;
    if (corr) createdAuditCorrelations.push(corr);
  }
  return { status: res.status, envelope };
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
    data: { email: ADMIN_EMAIL, name: "GA-1 Tenancy Admin", role: "admin", isActive: true },
    select: { id: true },
  });
  adminId = admin.id;

  const org = await db.organization.create({ data: { name: ORG_NAME } });
  orgId = org.id;
  const siteA = await db.site.create({
    data: { name: `GA-1 Site A ${RUN}`, code: SITE_A_CODE, organizationId: orgId },
  });
  siteAId = siteA.id;
  const siteB = await db.site.create({
    data: { name: `GA-1 Site B ${RUN}`, code: SITE_B_CODE, organizationId: orgId },
  });
  siteBId = siteB.id;

  const vendor = await db.vendor.create({
    data: { key: VENDOR_KEY, name: `GA-1 Vendor ${RUN}`, adapterKey: "generic" },
  });
  vendorId = vendor.id;

  const devA = await db.device.create({
    data: { hostname: HOST_A, mgmtIp: IP_A, vendorId, siteId: siteAId, status: "ONLINE" },
  });
  deviceAId = devA.id;
  const devB = await db.device.create({
    data: { hostname: HOST_B, mgmtIp: IP_B, vendorId, siteId: siteBId, status: "ONLINE" },
  });
  deviceBId = devB.id;
});

afterAll(async () => {
  // Surgical cleanup in FK order — every fixture row this suite created,
  // nothing else.
  if (createdPolicyIds.length > 0) {
    await db.auditEvent.deleteMany({
      where: {
        action: { in: ["BACKUP_POLICY_CREATED", "BACKUP_POLICY_UPDATED"] },
        resourceType: "BackupPolicy",
        resourceId: { in: createdPolicyIds },
        createdAt: { gte: testStartedAt },
      },
    });
    await db.backupPolicy.deleteMany({ where: { id: { in: createdPolicyIds } } });
  }
  // The 403 gates must have written nothing — defensively sweep this run's
  // audit correlations anyway (the RUN prefix makes rows unambiguous).
  if (createdAuditCorrelations.length > 0) {
    await db.auditEvent.deleteMany({ where: { correlationId: { in: createdAuditCorrelations } } });
  }
  await db.device.deleteMany({ where: { id: { in: [deviceAId, deviceBId].filter(Boolean) } } });
  await db.vendor.deleteMany({ where: { id: vendorId } });
  await db.site.deleteMany({ where: { id: { in: [siteAId, siteBId].filter(Boolean) } } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.user.deleteMany({ where: { id: adminId } });
});

/* ── pure guard pins (backupPolicyScopeDenial) ─────────────────────────── */

describe("GA-1: backupPolicyScopeDenial (pure guard)", () => {
  test("undefined / empty siteCodes → fleet-wide denial", () => {
    expect(backupPolicyScopeDenial(["A"], undefined)).toContain("fleet-wide");
    expect(backupPolicyScopeDenial(["A"], [])).toContain("fleet-wide");
  });

  test('"*" → fleet-wide denial', () => {
    expect(backupPolicyScopeDenial(["A"], ["*"])).toContain("fleet-wide");
  });

  test("out-of-scope codes are named in the denial", () => {
    const denial = backupPolicyScopeDenial(["A"], ["A", "B"]);
    expect(denial).toContain("B");
    expect(denial).not.toContain('"A"');
  });

  test("in-scope codes → null (allowed)", () => {
    expect(backupPolicyScopeDenial(["A", "B"], ["A"])).toBeNull();
    expect(backupPolicyScopeDenial(["A", "B"], ["B", "A"])).toBeNull();
  });
});

/* ── P1-A02: the /sites catalog is scope-aware ─────────────────────────── */

describe("GA-1: GET /api/v1/sites scoping", () => {
  test("wildcard session: byte-parity — every site row, fleet totals", async () => {
    const GET = await importGet("../../src/app/api/v1/sites/route");
    const res = await GET(getRequest("http://app.local/api/v1/sites", await adminJwt()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const rows = body.data as Array<Record<string, unknown>>;
    const codes = rows.map((r) => r.code);
    expect(codes).toContain(SITE_A_CODE);
    expect(codes).toContain(SITE_B_CODE);
    expect(body.meta?.sites).toBe(rows.length);
  });

  test("sites-limited session: only in-scope rows, aggregates intersected", async () => {
    const GET = await importGet("../../src/app/api/v1/sites/route");
    const res = await GET(getRequest("http://app.local/api/v1/sites", await adminJwt([SITE_A_CODE])));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    const rows = body.data as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe(SITE_A_CODE);
    expect(rows[0].deviceCount).toBe(1);
    expect(body.meta?.sites).toBe(1);
    expect(body.meta?.devices).toBe(1); // only site A's device — no aggregate leak
  });

  test("deny-all scope (sites: []): zero rows, zero aggregates", async () => {
    const GET = await importGet("../../src/app/api/v1/sites/route");
    const res = await GET(getRequest("http://app.local/api/v1/sites", await adminJwt([])));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.data).toHaveLength(0);
    expect(body.meta?.devices).toBe(0);
  });

  test("malformed scope claim: fail-closed — zero rows (never wildcard)", async () => {
    const GET = await importGet("../../src/app/api/v1/sites/route");
    const res = await GET(
      getRequest("http://app.local/api/v1/sites", await adminJwt("not-an-array"))
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.data).toHaveLength(0);
  });
});

/* ── P1-A03: backup-policy actuation is scope-bounded ──────────────────── */

describe("GA-1: POST /api/v1/backup-policies cross-site enforcement", () => {
  const base = { name: "", cronExpr: "0 2 * * *" };

  test("sites-limited + in-scope codes → 201 created", async () => {
    const { status, envelope } = await createPolicy(await adminJwt([SITE_A_CODE]), {
      ...base,
      name: `${PREFIX}in-scope-${RUN}`,
      scope: { siteCodes: [SITE_A_CODE] },
    });
    expect(status).toBe(201);
    expect(envelope.success).toBe(true);
  });

  test("sites-limited + out-of-scope code → 403 SITE_SCOPE_FORBIDDEN, nothing written", async () => {
    const name = `${PREFIX}out-${RUN}`;
    const { status, envelope } = await createPolicy(await adminJwt([SITE_A_CODE]), {
      ...base,
      name,
      scope: { siteCodes: [SITE_B_CODE] },
    });
    expect(status).toBe(403);
    expect(envelope.error?.code).toBe("SITE_SCOPE_FORBIDDEN");
    const row = await db.backupPolicy.findUnique({ where: { name }, select: { id: true } });
    expect(row).toBeNull();
  });

  test('sites-limited + "*" → 403 (fleet-wide)', async () => {
    const { status, envelope } = await createPolicy(await adminJwt([SITE_A_CODE]), {
      ...base,
      name: `${PREFIX}star-${RUN}`,
      scope: { siteCodes: ["*"] },
    });
    expect(status).toBe(403);
    expect(envelope.error?.code).toBe("SITE_SCOPE_FORBIDDEN");
  });

  test("sites-limited + scope omitted → 403 (empty scope = fleet-wide)", async () => {
    const { status, envelope } = await createPolicy(await adminJwt([SITE_A_CODE]), {
      ...base,
      name: `${PREFIX}noscope-${RUN}`,
    });
    expect(status).toBe(403);
    expect(envelope.error?.code).toBe("SITE_SCOPE_FORBIDDEN");
  });

  test("sites-limited + empty siteCodes array → 403 (serializes fleet-wide)", async () => {
    const { status, envelope } = await createPolicy(await adminJwt([SITE_A_CODE]), {
      ...base,
      name: `${PREFIX}empty-${RUN}`,
      scope: { siteCodes: [], criticalities: ["HIGH"] },
    });
    expect(status).toBe(403);
    expect(envelope.error?.code).toBe("SITE_SCOPE_FORBIDDEN");
  });

  test("wildcard session keeps fleet-wide create parity", async () => {
    const { status, envelope } = await createPolicy(await adminJwt(), {
      ...base,
      name: `${PREFIX}wild-${RUN}`,
      scope: { siteCodes: ["*"] },
    });
    expect(status).toBe(201);
    expect(envelope.success).toBe(true);
  });
});

describe("GA-1: PATCH /api/v1/backup-policies/[id] cross-site enforcement", () => {
  const PATCH = () => importPatch("../../src/app/api/v1/backup-policies/[id]/route");

  function patchRequest(jwt: string, id: string, body: unknown): [
    NextRequest,
    { params: Promise<{ id: string }> },
  ] {
    return [jsonRequest("PATCH", `${POLICY_BASE}/${id}`, jwt, body), { params: Promise.resolve({ id }) }];
  }

  test("scope-bearing patch to out-of-scope codes → 403, row untouched", async () => {
    const { envelope } = await createPolicy(await adminJwt(), {
      name: `${PREFIX}p1-${RUN}`,
      cronExpr: "0 2 * * *",
      scope: { siteCodes: [SITE_A_CODE] },
    });
    const policyId = (envelope.data as { policy: { id: string } }).policy.id;

    const patch = await PATCH();
    const res = await patch(...patchRequest(await adminJwt([SITE_A_CODE]), policyId, {
      scope: { siteCodes: [SITE_B_CODE] },
    }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as Envelope;
    expect(body.error?.code).toBe("SITE_SCOPE_FORBIDDEN");

    const row = await db.backupPolicy.findUnique({ where: { id: policyId } });
    expect(JSON.parse(row!.scopeJson)).toEqual({ siteCodes: [SITE_A_CODE] }); // unchanged
  });

  test("scope-bearing patch WITHOUT siteCodes → 403 (replace-whole ⇒ fleet-wide)", async () => {
    const { envelope } = await createPolicy(await adminJwt(), {
      name: `${PREFIX}p2-${RUN}`,
      cronExpr: "0 2 * * *",
      scope: { siteCodes: [SITE_A_CODE] },
    });
    const policyId = (envelope.data as { policy: { id: string } }).policy.id;

    const patch = await PATCH();
    const res = await patch(...patchRequest(await adminJwt([SITE_A_CODE]), policyId, {
      scope: { criticalities: ["HIGH"] },
    }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as Envelope;
    expect(body.error?.code).toBe("SITE_SCOPE_FORBIDDEN");
  });

  test("in-scope patch succeeds and updates the row", async () => {
    const { envelope } = await createPolicy(await adminJwt(), {
      name: `${PREFIX}p3-${RUN}`,
      cronExpr: "0 2 * * *",
      scope: { siteCodes: [SITE_A_CODE] },
    });
    const policyId = (envelope.data as { policy: { id: string } }).policy.id;

    const patch = await PATCH();
    const res = await patch(...patchRequest(await adminJwt([SITE_A_CODE]), policyId, {
      scope: { siteCodes: [SITE_A_CODE], criticalities: ["CRITICAL"] },
    }));
    expect(res.status).toBe(200);
    const row = await db.backupPolicy.findUnique({ where: { id: policyId } });
    expect(JSON.parse(row!.scopeJson)).toEqual({ siteCodes: [SITE_A_CODE], criticalities: ["CRITICAL"] });
  });

  test("non-scope patch (name only) by a sites-limited session → 200 (no widening possible)", async () => {
    const { envelope } = await createPolicy(await adminJwt(), {
      name: `${PREFIX}p4-${RUN}`,
      cronExpr: "0 2 * * *",
      scope: { siteCodes: ["*"] }, // fleet-wide row created by a WILDCARD admin
    });
    const policyId = (envelope.data as { policy: { id: string } }).policy.id;

    const patch = await PATCH();
    const res = await patch(...patchRequest(await adminJwt([SITE_A_CODE]), policyId, {
      name: `${PREFIX}p4-renamed-${RUN}`,
    }));
    expect(res.status).toBe(200);
    const row = await db.backupPolicy.findUnique({ where: { id: policyId } });
    expect(row!.name).toBe(`${PREFIX}p4-renamed-${RUN}`);
    expect(JSON.parse(row!.scopeJson)).toEqual({ siteCodes: ["*"] }); // unchanged, not widened by this actor
  });

  test("wildcard session keeps fleet-wide PATCH parity", async () => {
    const { envelope } = await createPolicy(await adminJwt(), {
      name: `${PREFIX}p5-${RUN}`,
      cronExpr: "0 2 * * *",
      scope: { siteCodes: [SITE_A_CODE] },
    });
    const policyId = (envelope.data as { policy: { id: string } }).policy.id;

    const patch = await PATCH();
    const res = await patch(...patchRequest(await adminJwt(), policyId, {
      scope: { siteCodes: ["*"] },
    }));
    expect(res.status).toBe(200);
    const row = await db.backupPolicy.findUnique({ where: { id: policyId } });
    expect(JSON.parse(row!.scopeJson)).toEqual({ siteCodes: ["*"] });
  });
});
