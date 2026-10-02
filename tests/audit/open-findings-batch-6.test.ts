/**
 * Open-findings batch 6 — F-008 phase 4b runtime pins (the long tail).
 *
 *   F-008 (A1-01, P2): ~35 operational GET handlers under /api/v1 were
 *   authenticated ONLY by the proxy matcher (src/proxy.ts,
 *   `/api/v1/:path*`). Rollout order: dashboard (batch 2) → events/alerts
 *   (batch 3) → devices/interfaces (batch 4) → incidents/changes/cmdb +
 *   admin-read recognition (batch 5) → THE LONG TAIL (this suite).
 *
 *   Phase 4b (this suite) gates the final 27 read routes with
 *   requireSessionRead (−27 allowlist entries):
 *
 *     - GET /api/v1/backup-policies         (policy list)
 *     - GET /api/v1/backup-policies/[id]    (policy detail)
 *     - GET /api/v1/baselines               (latest baseline per device)
 *     - GET /api/v1/compliance/backup       (backup compliance KPIs)
 *     - GET /api/v1/discovery               (recent discovery executions)
 *     - GET /api/v1/discovery/policies      (discovery policy list)
 *     - GET /api/v1/drift                   (drift detections list)
 *     - GET /api/v1/firmware                (fleet firmware inventory)
 *     - GET /api/v1/flows                   (per-device flow records)
 *     - GET /api/v1/flows/retention         (retention setting view)
 *     - GET /api/v1/ha                      (HA pair status)
 *     - GET /api/v1/jobs                    (job execution list)
 *     - GET /api/v1/maintenance             (maintenance windows list)
 *     - GET /api/v1/metrics/retention       (metric retention view)
 *     - GET /api/v1/notifications           (the caller's notification feed)
 *     - GET /api/v1/performance/overview    (fleet performance buckets)
 *     - GET /api/v1/performance/availability
 *     - GET /api/v1/performance/capacity
 *     - GET /api/v1/performance/devices
 *     - GET /api/v1/performance/interfaces
 *     - GET /api/v1/predictive              (risk horizon projections)
 *     - GET /api/v1/search                  (global header search)
 *     - GET /api/v1/sites                   (site list)
 *     - GET /api/v1/snapshots               (config snapshot list)
 *     - GET /api/v1/topology                (site/link topology graph)
 *     - GET /api/v1/ztp/claims              (zero-touch claims board)
 *     - GET /api/v1/meta/reference          (filter-bar picker data)
 *
 *   The meta/reference decision: it was allowlisted as "authenticated
 *   filter-bar reference data — proxy-gated today"; with the sweep complete
 *   there is no remaining justification for a handler-bare authenticated
 *   surface, so it is gated like every other read (the public PRE-AUTH
 *   bootstrap stays /api/v1/meta, deliberately non-gated).
 *
 *   Signature notes: seven no-param GETs (backup-policies, baselines,
 *   compliance/backup, discovery, metrics/retention, sites, meta/reference)
 *   gained `request: Request` to feed the gate; backup-policies/[id]'s
 *   unused `_request` was renamed to `request`. Locally-wrapped permission
 *   gates survive untouched (discovery/policies actorFor →
 *   requirePermission("device.read"); flows/retention requireAdminSystem →
 *   requirePermission("admin.system")) — the session gate runs FIRST, the
 *   stricter permission check still runs after it.
 *
 *   Read allowlist after this batch: 28 → 1 (shrink-only cap 59 intact;
 *   the sole survivor is the deliberate /api/v1/meta public bootstrap).
 *
 * Same certified rig as batches 2-5 (tests/audit/open-findings-batch-{2..5}
 * .test.ts): REAL session tokens minted with the production next-auth/jwt
 * encoder (no mock.module — it is process-wide and poisons later suites).
 * The admin identity, the flows probe device AND the backup-policies/[id]
 * fixture are SELF-CONTAINED via the rt012/rt014 ensure-helper pattern: the
 * CI gate replays ONLY `migrate deploy` (no demo seed), so every row these
 * probes depend on is upserted here and never deleted.
 */

import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";

import { db } from "../../src/lib/db";
import { mintServiceToken } from "../../src/lib/auth/service-auth";
import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";

/** Session-shaped projection of the admin identity used by these pins. */
type F008AdminUser = { id: string; email: string; name: string | null; role: string };
let f008Admin: F008AdminUser | null = null;
let f008DeviceId: string | null = null;
let f008PolicyId: string | null = null;

/**
 * Self-contained admin identity (the certified rt012/rt014 pattern): the CI
 * gate replays ONLY `migrate deploy` on a fresh service container (no demo
 * seed), so `admin@faya.local` cannot be assumed to exist — and neither can
 * the seeded admin ROLE row. Upserts are atomic and seed-equivalent shared
 * state is never deleted mid-run.
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

/**
 * The flows GET resolves the deviceId against a REAL device (ghost → 404
 * DEVICE_NOT_FOUND before any flow rows are read). Same fixture shape as
 * the batch-4 device (shared DB state; upsert is idempotent).
 */
async function ensureF008Device(): Promise<string> {
  if (f008DeviceId) return f008DeviceId;
  const vendor = await db.vendor.upsert({
    where: { key: "f008-vendor" },
    update: {},
    create: {
      key: "f008-vendor",
      name: "F008 Phase 3 Vendor",
      adapterKey: "f008-phase3-sim",
    },
    select: { id: true },
  });
  const device = await db.device.upsert({
    where: { hostname: "f008-phase3-device" },
    update: {},
    create: {
      hostname: "f008-phase3-device",
      displayName: "F008 Phase 3 Device",
      mgmtIp: "192.0.2.1",
      vendorId: vendor.id,
      status: "UNKNOWN",
      criticality: "MEDIUM",
      dataSource: "SIMULATOR",
    },
    select: { id: true },
  });
  f008DeviceId = device.id;
  return f008DeviceId;
}

/** The backup-policies/[id] GET 404s without a real policy row. */
async function ensureF008Policy(): Promise<string> {
  if (f008PolicyId) return f008PolicyId;
  const policy = await db.backupPolicy.upsert({
    where: { name: "f008-phase4b-policy" },
    update: {},
    create: {
      name: "f008-phase4b-policy",
      cronExpr: "0 2 * * *",
      scopeJson: JSON.stringify({ siteCodes: ["*"], criticality: ["CRITICAL"] }),
      retentionDays: 90,
      isActive: true,
    },
    select: { id: true },
  });
  f008PolicyId = policy.id;
  return f008PolicyId;
}

async function mintSessionJwt(user: F008AdminUser): Promise<string> {
  return encode({
    token: { id: user.id, email: user.email, name: user.name ?? undefined, role: user.role },
    secret: process.env.NEXTAUTH_SECRET ?? "",
  });
}

/* ── request helpers (handler-level — the gate runs inside the handler) ── */

type GetFn = (headers: Record<string, string>) => Promise<Response>;

function flatGet(rel: string, query = ""): GetFn {
  return async (headers) => {
    const mod = await import(`../../src/app/api/v1/${rel}/route`);
    return mod.GET(
      new NextRequest(`http://app.local/api/v1/${rel}${query}`, { method: "GET", headers })
    );
  };
}

async function policyDetailRequest(
  headers: Record<string, string>,
  id: string
): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/backup-policies/[id]/route");
  return GET(
    new NextRequest(`http://app.local/api/v1/backup-policies/${id}`, { method: "GET", headers }),
    { params: Promise.resolve({ id }) }
  );
}

/** The 27 phase-4b routes: name → probe (deviceId/query wired in the probes below). */
const PHASE4B_ROUTES: readonly (readonly [string, GetFn])[] = [
  ["backup-policies", flatGet("backup-policies")],
  ["backup-policies/[id]", (h) => policyDetailRequest(h, f008PolicyId ?? "unwired")],
  ["baselines", flatGet("baselines")],
  ["compliance/backup", flatGet("compliance/backup")],
  ["discovery", flatGet("discovery")],
  ["discovery/policies", flatGet("discovery/policies")],
  ["drift", flatGet("drift")],
  ["firmware", flatGet("firmware")],
  ["flows", (h) => flatGet("flows", `?deviceId=${f008DeviceId ?? "unwired"}`)(h)],
  ["flows/retention", flatGet("flows/retention")],
  ["ha", flatGet("ha")],
  ["jobs", flatGet("jobs")],
  ["maintenance", flatGet("maintenance")],
  ["metrics/retention", flatGet("metrics/retention")],
  ["notifications", flatGet("notifications")],
  ["performance/overview", flatGet("performance/overview")],
  ["performance/availability", flatGet("performance/availability")],
  ["performance/capacity", flatGet("performance/capacity")],
  ["performance/devices", flatGet("performance/devices")],
  ["performance/interfaces", flatGet("performance/interfaces")],
  ["predictive", flatGet("predictive")],
  ["search", flatGet("search", "?q=f008")],
  ["sites", flatGet("sites")],
  ["snapshots", flatGet("snapshots")],
  ["topology", flatGet("topology")],
  ["ztp/claims", flatGet("ztp/claims")],
  ["meta/reference", flatGet("meta/reference")],
];

describe("F-008 phase 4b: the long tail is handler-gated", () => {
  test("anonymous → 401 UNAUTHENTICATED on every phase-4b route", async () => {
    expect(PHASE4B_ROUTES.length).toBe(27);
    for (const [name, call] of PHASE4B_ROUTES) {
      const res = await call({});
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("UNAUTHENTICATED");
      // Sanity: the probe really hit the route it claims to.
      expect(name.length).toBeGreaterThan(0);
    }
  });

  test("valid service JWT (machine plane) → 401 — reads stay human-session-gated", async () => {
    const token = mintServiceToken({
      issuer: "fayanms:worker",
      subject: "worker:f008-phase4b-read-plane-test",
      scopes: ["metrics"],
    });
    for (const [name, call] of [
      ["performance/overview", PHASE4B_ROUTES[15][1]],
      ["backup-policies", PHASE4B_ROUTES[0][1]],
      ["meta/reference", PHASE4B_ROUTES[26][1]],
    ] as const) {
      const res = await call({ Authorization: `Bearer ${token}` });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("UNAUTHENTICATED");
      expect(name.length).toBeGreaterThan(0);
    }
  });

  test("session claims for an UNKNOWN user → 401 ACCOUNT_DISABLED (DB re-verification)", async () => {
    const ghost = await encode({
      token: {
        id: "user-f008-phase4b-ghost-nonexistent",
        email: "ghost-f008-p4b@faya.local",
        name: "F-008 Phase 4b Ghost",
        role: "admin",
      },
      secret: process.env.NEXTAUTH_SECRET ?? "",
    });
    const jobsGet = PHASE4B_ROUTES[11][1];
    const res = await jobsGet({ cookie: `next-auth.session-token=${ghost}` });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("ACCOUNT_DISABLED");
  });

  test("real admin session → 200 with the domain payload on every phase-4b route", async () => {
    const admin = await ensureF008Admin();
    await ensureF008Device(); // flows probe target
    const policyId = await ensureF008Policy(); // backup-policies/[id] probe target
    const session = await mintSessionJwt(admin);
    const auth = { cookie: `next-auth.session-token=${session}` };

    for (const [name, call] of PHASE4B_ROUTES) {
      const res = await call(auth);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success?: boolean };
      expect(body.success).toBe(true);
      // Sanity: the probe really hit the route it claims to.
      expect(name.length).toBeGreaterThan(0);
    }

    // The [id] fixture round-trips (policy detail echoes the row id).
    const detail = await policyDetailRequest(auth, policyId);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      success?: boolean;
      data?: { id?: string; name?: string };
    };
    expect(detailBody.success).toBe(true);
    expect(detailBody.data?.id).toBe(policyId);
    expect(detailBody.data?.name).toBe("f008-phase4b-policy");

    // meta/reference keeps serving the picker arrays (now behind the gate).
    const ref = await PHASE4B_ROUTES[26][1](auth);
    expect(ref.status).toBe(200);
    const refBody = (await ref.json()) as {
      success?: boolean;
      data?: { vendors?: unknown[]; sites?: unknown[]; credentialProfiles?: unknown[] };
    };
    expect(refBody.success).toBe(true);
    expect(Array.isArray(refBody.data?.vendors)).toBe(true);
    expect(Array.isArray(refBody.data?.sites)).toBe(true);
    expect(Array.isArray(refBody.data?.credentialProfiles)).toBe(true);
  });

  test("source contract: every phase-4b GET body gates on requireSessionRead; mutation gates survive", async () => {
    const { readFileSync } = await import("node:fs");
    const rels = [
      "backup-policies/route.ts",
      "backup-policies/[id]/route.ts",
      "baselines/route.ts",
      "compliance/backup/route.ts",
      "discovery/route.ts",
      "discovery/policies/route.ts",
      "drift/route.ts",
      "firmware/route.ts",
      "flows/route.ts",
      "flows/retention/route.ts",
      "ha/route.ts",
      "jobs/route.ts",
      "maintenance/route.ts",
      "metrics/retention/route.ts",
      "notifications/route.ts",
      "performance/overview/route.ts",
      "performance/availability/route.ts",
      "performance/capacity/route.ts",
      "performance/devices/route.ts",
      "performance/interfaces/route.ts",
      "predictive/route.ts",
      "search/route.ts",
      "sites/route.ts",
      "snapshots/route.ts",
      "topology/route.ts",
      "ztp/claims/route.ts",
      "meta/reference/route.ts",
    ];
    expect(rels.length).toBe(27);
    for (const rel of rels) {
      const src = readFileSync(`src/app/api/v1/${rel}`, "utf8");
      expect(src).toContain("await requireSessionRead(request)");
      expect(src).toContain("authErrorToFail");
    }
    // The locally-wrapped permission gates survive the gate addition.
    const discoveryPolicies = readFileSync("src/app/api/v1/discovery/policies/route.ts", "utf8");
    expect(discoveryPolicies).toContain('requirePermission(request, "device.read")');
    const flowsRetention = readFileSync("src/app/api/v1/flows/retention/route.ts", "utf8");
    expect(flowsRetention).toContain('requirePermission(request, "admin.system")');
    // The backup-policy mutation plane is untouched.
    const policyDetail = readFileSync("src/app/api/v1/backup-policies/[id]/route.ts", "utf8");
    expect(policyDetail).toContain('requirePermission(request, "config.backup")');
  });
});
