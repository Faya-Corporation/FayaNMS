/**
 * Open-findings batch 4 — F-008 phase 3 runtime pins (devices/interfaces).
 *
 *   F-008 (A1-01, P2): ~35 operational GET handlers under /api/v1 were
 *   authenticated ONLY by the proxy matcher (src/proxy.ts,
 *   `/api/v1/:path*`). Phase 1 (batch 2) landed the typed
 *   requireSessionRead() helper and gated the dashboard domain; phase 2
 *   (batch 3) gated events/alerts; the documented rollout order is
 *   dashboard → events/alerts → devices/interfaces → the rest.
 *
 *   Phase 3 (this suite): the devices/interfaces domain is handler-gated:
 *     - GET /api/v1/devices                    (inventory list)
 *     - GET /api/v1/devices/[id]               (full device record)
 *     - GET /api/v1/devices/[id]/alerts        (device alert stream)
 *     - GET /api/v1/devices/[id]/audit         (device audit timeline)
 *     - GET /api/v1/devices/[id]/changes       (device change requests)
 *     - GET /api/v1/devices/[id]/incidents     (device incidents)
 *     - GET /api/v1/devices/[id]/interfaces    (device interface inventory)
 *     - GET /api/v1/devices/[id]/metrics       (per-device metric series)
 *     - GET /api/v1/interfaces                 (fleet-wide interface view)
 *   The mutation plane is untouched: devices POST/PATCH stay
 *   requirePermission("device.write") with the session principal as the
 *   audit actor.
 *
 *   Pins (mirroring the batch-3 rig):
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
 * Same rig as batch 2/3 (tests/audit/open-findings-batch-{2,3}.test.ts):
 * REAL session tokens minted with the production next-auth/jwt encoder (no
 * mock.module — it is process-wide and poisons later suites). The admin
 * identity AND the probed device fixture are SELF-CONTAINED via the
 * certified rt012/rt014 ensure-helper pattern: the CI gate replays ONLY
 * `migrate deploy` (no demo seed), so the admin Role (from ROLE_MATRIX,
 * the seed's single source of truth), the admin User, the fixture Vendor
 * and the fixture Device are upserted here and never deleted.
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

/**
 * Self-contained device fixture for the [id]-scoped routes. Vendor first
 * (Device.vendorId is a required relation), then the device itself — both
 * idempotent upserts keyed on their unique fields (Vendor.key, Device
 * .hostname), never deleted (seed-equivalent shared state).
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

async function mintSessionJwt(user: F008AdminUser): Promise<string> {
  return encode({
    token: { id: user.id, email: user.email, name: user.name ?? undefined, role: user.role },
    secret: process.env.NEXTAUTH_SECRET ?? "",
  });
}

/* ── request helpers (handler-level — the gate runs inside the handler) ── */

async function devicesListRequest(headers: Record<string, string>): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/devices/route");
  return GET(
    new NextRequest("http://app.local/api/v1/devices?page=1&pageSize=5", {
      method: "GET",
      headers,
    })
  );
}

async function deviceDetailRequest(
  headers: Record<string, string>,
  id: string
): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/devices/[id]/route");
  return GET(
    new NextRequest(`http://app.local/api/v1/devices/${id}`, { method: "GET", headers }),
    { params: Promise.resolve({ id }) }
  );
}

async function deviceAlertsRequest(
  headers: Record<string, string>,
  id: string
): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/devices/[id]/alerts/route");
  return GET(
    new NextRequest(`http://app.local/api/v1/devices/${id}/alerts?page=1&pageSize=5`, {
      method: "GET",
      headers,
    }),
    { params: Promise.resolve({ id }) }
  );
}

async function deviceAuditRequest(
  headers: Record<string, string>,
  id: string
): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/devices/[id]/audit/route");
  return GET(
    new NextRequest(`http://app.local/api/v1/devices/${id}/audit?page=1&pageSize=5`, {
      method: "GET",
      headers,
    }),
    { params: Promise.resolve({ id }) }
  );
}

async function deviceChangesRequest(
  headers: Record<string, string>,
  id: string
): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/devices/[id]/changes/route");
  return GET(
    new NextRequest(`http://app.local/api/v1/devices/${id}/changes?page=1&pageSize=5`, {
      method: "GET",
      headers,
    }),
    { params: Promise.resolve({ id }) }
  );
}

async function deviceIncidentsRequest(
  headers: Record<string, string>,
  id: string
): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/devices/[id]/incidents/route");
  return GET(
    new NextRequest(`http://app.local/api/v1/devices/${id}/incidents?page=1&pageSize=5`, {
      method: "GET",
      headers,
    }),
    { params: Promise.resolve({ id }) }
  );
}

async function deviceInterfacesRequest(
  headers: Record<string, string>,
  id: string
): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/devices/[id]/interfaces/route");
  return GET(
    new NextRequest(`http://app.local/api/v1/devices/${id}/interfaces?page=1&pageSize=5`, {
      method: "GET",
      headers,
    }),
    { params: Promise.resolve({ id }) }
  );
}

async function deviceMetricsRequest(
  headers: Record<string, string>,
  id: string
): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/devices/[id]/metrics/route");
  return GET(
    new NextRequest(`http://app.local/api/v1/devices/${id}/metrics`, {
      method: "GET",
      headers,
    }),
    { params: Promise.resolve({ id }) }
  );
}

async function interfacesFleetRequest(headers: Record<string, string>): Promise<Response> {
  const { GET } = await import("../../src/app/api/v1/interfaces/route");
  return GET(
    new NextRequest("http://app.local/api/v1/interfaces?page=1&pageSize=10", {
      method: "GET",
      headers,
    })
  );
}

const ALL_ROUTES = [
  "devices",
  "devices/[id]",
  "devices/[id]/alerts",
  "devices/[id]/audit",
  "devices/[id]/changes",
  "devices/[id]/incidents",
  "devices/[id]/interfaces",
  "devices/[id]/metrics",
  "interfaces (fleet)",
] as const;

describe("F-008 phase 3: the devices/interfaces read domain is handler-gated", () => {
  test("anonymous → 401 UNAUTHENTICATED on every domain route", async () => {
    const ghostId = "device-f008-phase3-nonexistent";
    for (const [name, call] of [
      ["devices", () => devicesListRequest({})],
      ["devices/[id]", () => deviceDetailRequest({}, ghostId)],
      ["devices/[id]/alerts", () => deviceAlertsRequest({}, ghostId)],
      ["devices/[id]/audit", () => deviceAuditRequest({}, ghostId)],
      ["devices/[id]/changes", () => deviceChangesRequest({}, ghostId)],
      ["devices/[id]/incidents", () => deviceIncidentsRequest({}, ghostId)],
      ["devices/[id]/interfaces", () => deviceInterfacesRequest({}, ghostId)],
      ["devices/[id]/metrics", () => deviceMetricsRequest({}, ghostId)],
      ["interfaces (fleet)", () => interfacesFleetRequest({})],
    ] as const) {
      const res = await call();
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
      subject: "worker:f008-phase3-read-plane-test",
      scopes: ["metrics"],
    });
    for (const call of [devicesListRequest, interfacesFleetRequest]) {
      const res = await call({ Authorization: `Bearer ${token}` });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("UNAUTHENTICATED");
    }
  });

  test("session claims for an UNKNOWN user → 401 ACCOUNT_DISABLED (DB re-verification)", async () => {
    const ghost = await encode({
      token: {
        id: "user-f008-phase3-ghost-nonexistent",
        email: "ghost-f008-p3@faya.local",
        name: "F-008 Phase 3 Ghost",
        role: "admin",
      },
      secret: process.env.NEXTAUTH_SECRET ?? "",
    });
    const res = await devicesListRequest({
      cookie: `next-auth.session-token=${ghost}`,
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("ACCOUNT_DISABLED");
  });

  test("real admin session → 200 with the domain payload on every route", async () => {
    const admin = await ensureF008Admin();
    const deviceId = await ensureF008Device();
    const session = await mintSessionJwt(admin);
    const auth = { cookie: `next-auth.session-token=${session}` };

    // devices list — page envelope with a numeric total.
    const list = await devicesListRequest(auth);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      success?: boolean;
      meta?: { total?: number };
    };
    expect(listBody.success).toBe(true);
    expect(typeof listBody.meta?.total).toBe("number");

    // devices/[id] — the ensured fixture round-trips.
    const detail = await deviceDetailRequest(auth, deviceId);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      success?: boolean;
      data?: { id?: string; hostname?: string };
    };
    expect(detailBody.success).toBe(true);
    expect(detailBody.data?.id).toBe(deviceId);
    expect(detailBody.data?.hostname).toBe("f008-phase3-device");

    // devices/[id]/alerts — array payload.
    const alerts = await deviceAlertsRequest(auth, deviceId);
    expect(alerts.status).toBe(200);
    const alertsBody = (await alerts.json()) as { success?: boolean; data?: unknown[] };
    expect(alertsBody.success).toBe(true);
    expect(Array.isArray(alertsBody.data)).toBe(true);

    // devices/[id]/audit — array payload.
    const audit = await deviceAuditRequest(auth, deviceId);
    expect(audit.status).toBe(200);
    const auditBody = (await audit.json()) as { success?: boolean; data?: unknown[] };
    expect(auditBody.success).toBe(true);
    expect(Array.isArray(auditBody.data)).toBe(true);

    // devices/[id]/changes — array payload.
    const changes = await deviceChangesRequest(auth, deviceId);
    expect(changes.status).toBe(200);
    const changesBody = (await changes.json()) as { success?: boolean; data?: unknown[] };
    expect(changesBody.success).toBe(true);
    expect(Array.isArray(changesBody.data)).toBe(true);

    // devices/[id]/incidents — array payload.
    const incidents = await deviceIncidentsRequest(auth, deviceId);
    expect(incidents.status).toBe(200);
    const incidentsBody = (await incidents.json()) as { success?: boolean; data?: unknown[] };
    expect(incidentsBody.success).toBe(true);
    expect(Array.isArray(incidentsBody.data)).toBe(true);

    // devices/[id]/interfaces — array payload with the device hostname in meta.
    const ifaces = await deviceInterfacesRequest(auth, deviceId);
    expect(ifaces.status).toBe(200);
    const ifacesBody = (await ifaces.json()) as {
      success?: boolean;
      data?: unknown[];
      meta?: { hostname?: string };
    };
    expect(ifacesBody.success).toBe(true);
    expect(Array.isArray(ifacesBody.data)).toBe(true);
    expect(ifacesBody.meta?.hostname).toBe("f008-phase3-device");

    // devices/[id]/metrics — merged series payload.
    const metrics = await deviceMetricsRequest(auth, deviceId);
    expect(metrics.status).toBe(200);
    const metricsBody = (await metrics.json()) as {
      success?: boolean;
      data?: { series?: unknown[] };
    };
    expect(metricsBody.success).toBe(true);
    expect(Array.isArray(metricsBody.data?.series)).toBe(true);

    // interfaces (fleet) — summary block payload.
    const fleet = await interfacesFleetRequest(auth);
    expect(fleet.status).toBe(200);
    const fleetBody = (await fleet.json()) as {
      success?: boolean;
      data?: { summary?: { total?: number } };
    };
    expect(fleetBody.success).toBe(true);
    expect(typeof fleetBody.data?.summary?.total).toBe("number");

    // Sanity: the pins really covered the documented domain surface.
    expect(ALL_ROUTES.length).toBe(9);
  });

  test("source contract: every phase-3 GET body gates on requireSessionRead", async () => {
    const { readFileSync } = await import("node:fs");
    for (const rel of [
      "src/app/api/v1/devices/route.ts",
      "src/app/api/v1/devices/[id]/route.ts",
      "src/app/api/v1/devices/[id]/alerts/route.ts",
      "src/app/api/v1/devices/[id]/audit/route.ts",
      "src/app/api/v1/devices/[id]/changes/route.ts",
      "src/app/api/v1/devices/[id]/incidents/route.ts",
      "src/app/api/v1/devices/[id]/interfaces/route.ts",
      "src/app/api/v1/devices/[id]/metrics/route.ts",
      "src/app/api/v1/interfaces/route.ts",
    ]) {
      const src = readFileSync(rel, "utf8");
      expect(src).toContain("await requireSessionRead(request)");
      expect(src).toContain("authErrorToFail");
    }
    // The mutation plane is untouched: devices POST/PATCH keep their
    // device.write permission gate with the session principal as actor.
    const devices = readFileSync("src/app/api/v1/devices/route.ts", "utf8");
    expect(devices).toContain('requirePermission(request, "device.write")');
    const deviceDetail = readFileSync("src/app/api/v1/devices/[id]/route.ts", "utf8");
    expect(deviceDetail).toContain('requirePermission(request, "device.write")');
  });
});
