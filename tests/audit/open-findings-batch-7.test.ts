/**
 * Open-findings batch 7 — the F-008 follow-up: API-client READ scopes are
 * WIRED (P1-012 completion).
 *
 *   History: P1-012 shipped the API-client bearer plane for MUTATIONS
 *   (requirePermission → authenticateApiClient, fail-closed opt-in per
 *   route) while READ routes refused opaque bearers outright at the proxy
 *   (API_CLIENT_READS_NOT_WIRED_BODY) — an honest limitation: reads had no
 *   handler-level gate, so an unvalidated token could not be trusted.
 *
 *   The F-008 sweep (batches 2-6) closed that gap: every /api/v1 GET
 *   except the public bootstrap verifies its principal at the handler.
 *   The revisit became ELIGIBLE and THIS batch ships the deliberate
 *   design decision:
 *
 *     - requireSessionRead (src/lib/auth/session.ts) grows the client
 *       branch: no session → authenticateApiClientRead(authorization,
 *       pathname) — sha256 row lookup + active check + scope grant via
 *       the wired-domain table. Unknown/garbage tokens keep the exact
 *       pre-batch-7 401 UNAUTHENTICATED envelope; valid clients get
 *       precise 401 API_CLIENT_INACTIVE / 403 API_CLIENT_SCOPE_INSUFFICIENT.
 *     - API_CLIENT_READ_DOMAINS (src/lib/auth/api-client-auth.ts): a CODE
 *       table mapping pathname prefixes → route permissions
 *       (devices/interfaces/cmdb/discovery → device.read, alerts/events →
 *       alert.read, incidents → incident.read, changes/approvals →
 *       change.read, metrics/performance → metrics.read, backup/baseline/
 *       compliance/snapshots → config.read). Deliberately NARROWER than
 *       the human surface: credentials, dashboard, maintenance, jobs,
 *       flows, topology, sites, search, firmware, ha, drift,
 *       notifications, predictive, reports, meta/*, admin/*, worker/*
 *       stay UNWIRED → a VALID client token answers 403
 *       API_CLIENT_READS_DOMAIN_NOT_WIRED (precise signal, never silent
 *       data).
 *     - admin.read stays RESERVED (empty mapping): admin surfaces are
 *       ROLE-gated (resolveAdminActor → requireRole("admin")), not
 *       permission-gated — wiring them is a deliberate separate decision.
 *     - Stricter LOCAL gates keep their place AFTER the read gate:
 *       discovery/policies → requirePermission("device.read") without the
 *       opt-in → 403 API_CLIENT_HUMAN_REQUIRED (human accountability).
 *     - src/proxy.ts: the read-plane refusal is DELETED — opaque bearer
 *       candidates are admitted to BOTH planes (the session gate would
 *       otherwise 401 the opaque header before the handler's own gate
 *       could validate it); the handlers are the validation authority.
 *
 * Same certified rig as batches 2-6 (tests/audit/open-findings-batch-{2..6}
 * .test.ts): REAL session tokens minted with the production next-auth/jwt
 * encoder (no mock.module — it is process-wide and poisons later suites).
 * The admin identity AND the ApiClient rows are SELF-CONTAINED via the
 * rt012/rt014 ensure-helper pattern: the CI gate replays ONLY
 * `migrate deploy` (no demo seed), so every row these probes depend on is
 * upserted here and never deleted.
 */

import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";

import { db } from "../../src/lib/db";
import { mintServiceToken } from "../../src/lib/auth/service-auth";
import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";
import { apiClientTokenHash } from "../../src/lib/auth/api-client-auth";

/** Session-shaped projection of the admin identity used by these pins. */
type F008AdminUser = { id: string; email: string; name: string | null; role: string };
let f008Admin: F008AdminUser | null = null;

/** Self-contained admin identity (the certified rt012/rt014 pattern). */
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

/* ── self-contained ApiClient fixtures (fixed deterministic tokens) ── */

const CLIENT_INVENTORY = [
  {
    name: "batch7-device-reader",
    token: "f008batch7deviceReaderToken0000000000aaaaAAAA11",
    scopes: ["devices.read", "alerts.read"],
    isActive: true,
  },
  {
    name: "batch7-metrics-reader",
    token: "f008batch7metricsReaderToken0000000000bbbbBBBB22",
    scopes: ["metrics.read"],
    isActive: true,
  },
  {
    name: "batch7-config-reader",
    token: "f008batch7configReaderToken0000000000ccccCCCC33",
    scopes: ["config.read"],
    isActive: true,
  },
  {
    name: "batch7-deactivated-reader",
    token: "f008batch7deactivatedToken000000000000ddddDDDD44",
    scopes: ["devices.read"],
    isActive: false,
  },
] as const;

const clientTokenByName = new Map<string, string>();

async function ensureBatch7Clients(): Promise<void> {
  if (clientTokenByName.size > 0) return;
  for (const entry of CLIENT_INVENTORY) {
    const tokenHash = apiClientTokenHash(entry.token);
    await db.apiClient.upsert({
      where: { tokenHash },
      update: { isActive: entry.isActive, scopesJson: JSON.stringify([...entry.scopes]) },
      create: {
        name: entry.name,
        tokenHash,
        tokenPrefix: entry.token.slice(0, 8),
        scopesJson: JSON.stringify([...entry.scopes]),
        isActive: entry.isActive,
      },
    });
    clientTokenByName.set(entry.name, entry.token);
  }
}

function bearerOf(name: string): Record<string, string> {
  const token = clientTokenByName.get(name);
  if (!token) throw new Error(`client fixture missing: ${name}`);
  return { Authorization: `Bearer ${token}` };
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

describe("F-008 follow-up (batch 7): API-client read scopes are wired", () => {
  test("anonymous → 401 UNAUTHENTICATED (fail-closed unchanged)", async () => {
    for (const rel of ["devices", "alerts", "performance/overview", "sites"]) {
      const res = await flatGet(rel)({});
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("UNAUTHENTICATED");
    }
  });

  test("unknown opaque token → 401 UNAUTHENTICATED (falls through, no signal leak)", async () => {
    const res = await flatGet("devices")({
      Authorization: `Bearer ${"z".repeat(43)}`,
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("UNAUTHENTICATED");
  });

  test("valid service JWT (machine plane) → 401 — reads never trust machine tokens", async () => {
    const token = mintServiceToken({
      issuer: "fayanms:worker",
      subject: "worker:batch7-read-plane-test",
      scopes: ["metrics"],
    });
    const res = await flatGet("devices")({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("UNAUTHENTICATED");
  });

  test("devices.read client → 200 on the devices domain (devices, interfaces, cmdb)", async () => {
    await ensureBatch7Clients();
    const headers = bearerOf("batch7-device-reader");
    for (const rel of ["devices", "interfaces", "cmdb/items"]) {
      const res = await flatGet(rel)(headers);
      expect(res.status, rel).toBe(200);
      const body = (await res.json()) as { success?: boolean };
      expect(body.success, rel).toBe(true);
    }
  });

  test("alerts.read client → 200 on alerts + events (one domain, one scope)", async () => {
    const headers = bearerOf("batch7-device-reader"); // scopes: devices.read + alerts.read
    for (const rel of ["alerts", "events"]) {
      const res = await flatGet(rel)(headers);
      expect(res.status, rel).toBe(200);
      const body = (await res.json()) as { success?: boolean };
      expect(body.success, rel).toBe(true);
    }
  });

  test("metrics.read client → 200 on metrics + performance", async () => {
    const headers = bearerOf("batch7-metrics-reader");
    for (const rel of ["metrics/retention", "performance/overview"]) {
      const res = await flatGet(rel)(headers);
      expect(res.status, rel).toBe(200);
      const body = (await res.json()) as { success?: boolean };
      expect(body.success, rel).toBe(true);
    }
  });

  test("config.read client → 200 on backup-policies + snapshots", async () => {
    const headers = bearerOf("batch7-config-reader");
    for (const rel of ["backup-policies", "snapshots"]) {
      const res = await flatGet(rel)(headers);
      expect(res.status, rel).toBe(200);
      const body = (await res.json()) as { success?: boolean };
      expect(body.success, rel).toBe(true);
    }
  });

  test("scope insufficient → 403 API_CLIENT_SCOPE_INSUFFICIENT", async () => {
    const res = await flatGet("devices")(bearerOf("batch7-metrics-reader"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("API_CLIENT_SCOPE_INSUFFICIENT");
  });

  test("deactivated client → 401 API_CLIENT_INACTIVE", async () => {
    const res = await flatGet("devices")(bearerOf("batch7-deactivated-reader"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("API_CLIENT_INACTIVE");
  });

  test("unwired domain → 403 API_CLIENT_READS_DOMAIN_NOT_WIRED (valid client, precise signal)", async () => {
    const headers = bearerOf("batch7-device-reader");
    for (const rel of ["sites", "dashboard", "topology", "search"]) {
      const res = await flatGet(rel)(headers);
      expect(res.status, rel).toBe(403);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code, rel).toBe("API_CLIENT_READS_DOMAIN_NOT_WIRED");
    }
  });

  test("permission-gated read (credentials) answers with ITS OWN precise code, not a silent 401", async () => {
    // credentials GET is gated by requirePermission(request, "admin.credential")
    // directly (F-12 invariant — sensitive administration). The client plane
    // resolves the principal, the scopes lack the permission → the route's
    // own 403 API_CLIENT_SCOPE_INSUFFICIENT. Never a silent 401, never data.
    const res = await flatGet("credentials")(bearerOf("batch7-device-reader"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("API_CLIENT_SCOPE_INSUFFICIENT");
  });

  test("admin.read stays RESERVED: client on an admin read → 401 (resolveAdminActor gate, client plane never applies)", async () => {
    // Admin reads (admin/api-clients, admin/settings, …) are ROLE-gated via
    // resolveAdminActor → requireRole("admin") — a DIFFERENT gate from
    // requireSessionRead that never consults the client branch, so a valid
    // client token fails closed with the plain UNAUTHENTICATED envelope.
    // Wiring admin reads for clients would need a deliberate
    // resolveAdminActor change (admin.read stays catalog-reserved).
    const res = await flatGet("admin/api-clients")(bearerOf("batch7-device-reader"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("UNAUTHENTICATED");
  });

  test("stricter local gate stays human-only: discovery/policies → 403 API_CLIENT_HUMAN_REQUIRED", async () => {
    // The client passes requireSessionRead (device.read granted) but the
    // route's local requirePermission("device.read") has NO allowApiClients
    // opt-in — human accountability is preserved (P1-012 mutation-plane
    // convention carried onto the read plane).
    const res = await flatGet("discovery/policies")(bearerOf("batch7-device-reader"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("API_CLIENT_HUMAN_REQUIRED");
  });

  test("real admin session → 200 (human surface untouched by the client branch)", async () => {
    const admin = await ensureF008Admin();
    const session = await mintSessionJwt(admin);
    const auth = { cookie: `next-auth.session-token=${session}` };
    for (const rel of ["devices", "sites", "credentials"]) {
      const res = await flatGet(rel)(auth);
      expect(res.status, rel).toBe(200);
      const body = (await res.json()) as { success?: boolean };
      expect(body.success, rel).toBe(true);
    }
  });

  test("evidence: a successful client read stamps lastUsedAt (60 s throttle)", async () => {
    await ensureBatch7Clients();
    const hash = apiClientTokenHash(CLIENT_INVENTORY[0].token);
    const row = await db.apiClient.findUnique({ where: { tokenHash: hash } });
    expect(row?.lastUsedAt).not.toBeNull();
  });

  test("source contract: the proxy refusal is gone; the read gate wires the client plane", async () => {
    const { readFileSync } = await import("node:fs");
    const proxySrc = readFileSync("src/proxy.ts", "utf8");
    expect(proxySrc).not.toContain("API_CLIENT_READS_NOT_WIRED_BODY");
    expect(proxySrc).not.toContain("isMutation");
    expect(proxySrc).toContain("OPAQUE_BEARER_PATTERN.test(bearerCandidate)");

    const sessionSrc = readFileSync("src/lib/auth/session.ts", "utf8");
    expect(sessionSrc).toContain("authenticateApiClientRead(");
    expect(sessionSrc).toContain("requireReadPrincipal");

    const clientSrc = readFileSync("src/lib/auth/api-client-auth.ts", "utf8");
    expect(clientSrc).toContain('"devices.read": ["device.read"]');
    expect(clientSrc).toContain("API_CLIENT_READ_DOMAINS");
    expect(clientSrc).toContain("API_CLIENT_READS_DOMAIN_NOT_WIRED");
    expect(clientSrc).toContain('code: "API_CLIENT_INACTIVE"');
  });
});
