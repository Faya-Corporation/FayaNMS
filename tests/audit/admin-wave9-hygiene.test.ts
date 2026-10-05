/**
 * Admin-plane wave-9 hygiene (audit agent 9-a findings F-1/F-2/F-3 + pin
 * gaps) — fixes implemented by fix agent 10-c on the Task 7-b surfaces.
 *
 *   F-2  transactional mutation+audit: every admin mutation route now wraps
 *        its write AND its auditEvent.create in ONE db.$transaction
 *        (settings PATCH is additionally atomic WITHIN the batch — all
 *        upserts + the single SETTINGS_UPDATED row commit together).
 *   F-1  CHANNEL_UPDATED audit payload: the closed channel config
 *        (address/displayName/url — no credential fields) is now recorded
 *        before/after, mirroring the webhook routes' URL snapshots.
 *   F-3  credential epoch: User.credentialEpoch (additive Int @default(0))
 *        is minted into the session JWT at sign-in ONLY and re-checked
 *        per-request in requireUser (and the read plane) — a password SET
 *        bumps the epoch inside the mutation transaction, so every token
 *        minted before it answers 401 UNAUTHENTICATED on its next request
 *        (stolen-cookie window closes at the SET, not at the 12 h maxAge).
 *
 *   Pin gaps closed: route-level SSRF admission wiring (webhooks +
 *   notification-channels, create/update), SELF_UPDATE_FORBIDDEN, the
 *   settings PATCH allowlist (unknown key / wrong type / null / min / max),
 *   password-material absence from USER_PASSWORD_RESET, the epoch
 *   semantics at the requireUser level (a full credentials sign-in needs
 *   the FAYANMS_E2E topology — the mandate's documented unit fallback),
 *   and transactionality as source pins (the certified readFileSync style).
 *
 *   Test style: the certified batch-25/rt012 pattern — REAL next-auth JWTs
 *   from the production encoder (no mock.module), DB-backed functional
 *   tests on SYNTHETIC FIXTURES ONLY (unique RUN-suffixed rows, reclaimed
 *   in afterAll with the createdAt-gte audit bound), plus source-text pins.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";

import { db } from "../../src/lib/db";
import { AuthError, requireUser } from "../../src/lib/auth/session";
import { authOptions } from "../../src/lib/auth/options";
import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";

/* ── fixtures ──────────────────────────────────────────────────────────── */

const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
const ADMIN_EMAIL = `w9hy-admin-${RUN.toLowerCase()}@faya.local`;
const TARGET_EMAIL = `w9hy-target-${RUN.toLowerCase()}@faya.local`;
const WEBHOOK_NAME = `w9hy-hook-${RUN}`;
const CHANNEL_NAME = `w9hy-chan-${RUN}`;
const API_CLIENT_NAME = `w9hy-client-${RUN}`;
// Unique, denylist-safe, ≥ 8 chars (viewer-role policy bar).
const RESET_PASSWORD = `W9hy-${RUN}-Ev1ct#7qZx`;

const testStartedAt = new Date();

let adminUserId = "";
let targetUserId = "";
let webhookId = "";
let channelId = "";
let apiClientId = "";
let originalSystemName: string | null = null;
let originalBackupEncryption: string | null = null;

type SessionShape = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  credentialEpoch?: number;
};

/**
 * The certified rt012/batch-3/batch-25 session-mint helper, extended with
 * the wave-9 credentialEpoch claim (omitted when undefined — the absent
 * claim IS the pre-epoch token shape).
 */
async function mintSessionJwt(user: SessionShape): Promise<string> {
  return encode({
    token: {
      id: user.id,
      email: user.email,
      name: user.name ?? undefined,
      role: user.role,
      ...(user.credentialEpoch !== undefined
        ? { credentialEpoch: user.credentialEpoch }
        : {}),
    },
    secret: process.env.NEXTAUTH_SECRET ?? "",
  });
}

function sessionRequest(jwt: string, url: string, init?: { method?: string; body?: string }): Request {
  return new NextRequest(url, {
    method: init?.method ?? "GET",
    ...(init?.body !== undefined ? { body: init.body } : {}),
    headers: {
      cookie: `next-auth.session-token=${jwt}`,
      "content-type": "application/json",
    },
  }) as unknown as Request;
}

async function patchUser(jwt: string, id: string, body: unknown): Promise<Response> {
  const { PATCH } = (await import("../../src/app/api/v1/admin/users/[id]/route")) as {
    PATCH: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  };
  return PATCH(
    sessionRequest(jwt, `http://app.local/api/v1/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) }
  );
}

async function resetPassword(jwt: string, id: string, password: string): Promise<Response> {
  const { POST } = (await import("../../src/app/api/v1/admin/users/[id]/reset-password/route")) as {
    POST: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  };
  return POST(
    sessionRequest(jwt, `http://app.local/api/v1/admin/users/${id}/reset-password`, {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
    { params: Promise.resolve({ id }) }
  );
}

async function postWebhook(jwt: string, body: unknown): Promise<Response> {
  const { POST } = (await import("../../src/app/api/v1/admin/webhooks/route")) as {
    POST: (req: Request) => Promise<Response>;
  };
  return POST(sessionRequest(jwt, "http://app.local/api/v1/admin/webhooks", { method: "POST", body: JSON.stringify(body) }));
}

async function patchWebhook(jwt: string, id: string, body: unknown): Promise<Response> {
  const { PATCH } = (await import("../../src/app/api/v1/admin/webhooks/[id]/route")) as {
    PATCH: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  };
  return PATCH(
    sessionRequest(jwt, `http://app.local/api/v1/admin/webhooks/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) }
  );
}

async function postChannel(jwt: string, body: unknown): Promise<Response> {
  const { POST } = (await import("../../src/app/api/v1/admin/notification-channels/route")) as {
    POST: (req: Request) => Promise<Response>;
  };
  return POST(
    sessionRequest(jwt, "http://app.local/api/v1/admin/notification-channels", { method: "POST", body: JSON.stringify(body) })
  );
}

async function patchChannel(jwt: string, id: string, body: unknown): Promise<Response> {
  const { PATCH } = (await import("../../src/app/api/v1/admin/notification-channels/[id]/route")) as {
    PATCH: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  };
  return PATCH(
    sessionRequest(jwt, `http://app.local/api/v1/admin/notification-channels/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
}

async function postApiClient(jwt: string, body: unknown): Promise<Response> {
  const { POST } = (await import("../../src/app/api/v1/admin/api-clients/route")) as {
    POST: (req: Request) => Promise<Response>;
  };
  return POST(sessionRequest(jwt, "http://app.local/api/v1/admin/api-clients", { method: "POST", body: JSON.stringify(body) }));
}

async function patchSettings(jwt: string, body: unknown): Promise<Response> {
  const { PATCH } = (await import("../../src/app/api/v1/admin/settings/route")) as {
    PATCH: (req: Request) => Promise<Response>;
  };
  return PATCH(sessionRequest(jwt, "http://app.local/api/v1/admin/settings", { method: "PATCH", body: JSON.stringify(body) }));
}

function errCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } })?.error?.code;
}

beforeAll(async () => {
  // The rt012/batch-3 seed-equivalent upserts — synthetic rows ONLY for
  // this suite's own identities (unique RUN-suffixed emails).
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
    data: { email: ADMIN_EMAIL, name: `W9 Hygiene Admin ${RUN}`, role: "admin", isActive: true },
  });
  adminUserId = admin.id;
  const target = await db.user.create({
    data: { email: TARGET_EMAIL, name: `W9 Hygiene Target ${RUN}`, role: "viewer", isActive: true },
  });
  targetUserId = target.id;

  // Snapshot the shared settings this suite touches so afterAll can
  // restore the demo world exactly.
  const systemNameRow = await db.setting.findUnique({
    where: { key: "system.name" },
    select: { valueJson: true },
  });
  originalSystemName = systemNameRow ? (JSON.parse(systemNameRow.valueJson) as string) : null;
  const backupEncRow = await db.setting.findUnique({
    where: { key: "backup.encryption" },
    select: { valueJson: true },
  });
  originalBackupEncryption = backupEncRow ? (JSON.parse(backupEncRow.valueJson) as string) : null;

  expect(adminUserId.length).toBeGreaterThan(0);
  expect(targetUserId.length).toBeGreaterThan(0);
});

afterAll(async () => {
  // 1) Restore the shared setting values (the audit rows the restore
  //    produces are deleted by the createdAt-gte sweep below).
  await db.setting.upsert({
    where: { key: "system.name" },
    update: { valueJson: JSON.stringify(originalSystemName) },
    create: { key: "system.name", valueJson: JSON.stringify(originalSystemName) },
  });
  await db.setting.upsert({
    where: { key: "backup.encryption" },
    update: { valueJson: JSON.stringify(originalBackupEncryption) },
    create: { key: "backup.encryption", valueJson: JSON.stringify(originalBackupEncryption) },
  });

  // 2) Fixture rows in FK order.
  await db.webhookEndpoint.deleteMany({ where: { id: webhookId || "none" } });
  await db.notificationChannel.deleteMany({ where: { id: channelId || "none" } });
  await db.apiClient.deleteMany({ where: { id: apiClientId || "none" } });
  await db.user.deleteMany({ where: { id: { in: [adminUserId, targetUserId].filter(Boolean) } } });

  // 3) The audit rows this suite produced (batch-22 createdAt-gte pattern,
  //    scoped to this suite's fixture ids for User rows and to this suite's
  //    window for the shared admin surfaces it owns this wave).
  await db.auditEvent.deleteMany({
    where: {
      createdAt: { gte: testStartedAt },
      OR: [
        { resourceType: "User", resourceId: { in: [adminUserId, targetUserId].filter(Boolean) } },
        {
          action: {
            in: [
              "SETTINGS_UPDATED",
              "WEBHOOK_CREATED",
              "WEBHOOK_UPDATED",
              "WEBHOOK_DELETED",
              "CHANNEL_CREATED",
              "CHANNEL_UPDATED",
              "CHANNEL_DELETED",
              "API_CLIENT_CREATED",
            ],
          },
        },
      ],
    },
  });
});

/* ── F-1/F-2 functional — SSRF admission wiring (route-level, behavioral) ── */

describe("wave-9 pin: route-level SSRF admission (webhooks + channels, create+update)", () => {
  test("POST /admin/webhooks refuses the cloud-metadata address with the SSRF_BLOCKED envelope", async () => {
    const admin = await db.user.findUnique({ where: { id: adminUserId } });
    const jwt = await mintSessionJwt(admin!);
    const res = await postWebhook(jwt, {
      name: WEBHOOK_NAME,
      url: "http://169.254.169.254/latest/meta-data/",
      events: ["alert.fired"],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("SSRF_BLOCKED");
    expect(body.error?.message).toContain("SSRF_BLOCKED");
    // Admission ran BEFORE any write: no row for this name exists.
    const stored = await db.webhookEndpoint.findFirst({ where: { name: WEBHOOK_NAME } });
    expect(stored).toBeNull();
  });

  test("POST /admin/webhooks refuses loopback (127.0.0.1) — and the encoded decimal form", async () => {
    const admin = await db.user.findUnique({ where: { id: adminUserId } });
    const jwt = await mintSessionJwt(admin!);
    for (const url of ["http://127.0.0.1:8080/hook", "http://2130706433/hook"]) {
      const res = await postWebhook(jwt, { name: WEBHOOK_NAME, url, events: ["test"] });
      expect(res.status).toBe(400);
      expect(errCode(await res.json())).toBe("SSRF_BLOCKED");
    }
  });

  test("PATCH /admin/webhooks/[id] re-passes admission — rotation cannot smuggle a private target", async () => {
    const admin = await db.user.findUnique({ where: { id: adminUserId } });
    const jwt = await mintSessionJwt(admin!);
    const created = await postWebhook(jwt, {
      name: WEBHOOK_NAME,
      url: "https://hooks.example.invalid/w9hy",
      events: ["alert.fired"],
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { data?: { webhook?: { id?: string; url?: string } } };
    webhookId = createdBody.data?.webhook?.id ?? "";
    expect(webhookId.length).toBeGreaterThan(0);

    const res = await patchWebhook(jwt, webhookId, { url: "http://10.9.9.9/hook" });
    expect(res.status).toBe(400);
    expect(errCode(await res.json())).toBe("SSRF_BLOCKED");
    // The stored URL is unchanged after the refused update.
    const row = await db.webhookEndpoint.findUnique({ where: { id: webhookId } });
    expect(row?.url).toBe("https://hooks.example.invalid/w9hy");
  });

  test("POST /admin/notification-channels refuses a WEBHOOK config aimed at metadata space", async () => {
    const admin = await db.user.findUnique({ where: { id: adminUserId } });
    const jwt = await mintSessionJwt(admin!);
    const res = await postChannel(jwt, {
      name: CHANNEL_NAME,
      type: "WEBHOOK",
      config: { url: "http://169.254.169.254/x" },
    });
    expect(res.status).toBe(400);
    expect(errCode(await res.json())).toBe("SSRF_BLOCKED");
    const stored = await db.notificationChannel.findFirst({ where: { name: CHANNEL_NAME } });
    expect(stored).toBeNull();
  });

  test("PATCH /admin/notification-channels/[id] re-passes admission on config.url", async () => {
    const admin = await db.user.findUnique({ where: { id: adminUserId } });
    const jwt = await mintSessionJwt(admin!);
    const created = await postChannel(jwt, {
      name: CHANNEL_NAME,
      type: "EMAIL",
      config: { address: `w9hy-${RUN.toLowerCase()}@example.invalid`, displayName: `W9 ${RUN}` },
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { data?: { channel?: { id?: string } } };
    channelId = createdBody.data?.channel?.id ?? "";
    expect(channelId.length).toBeGreaterThan(0);

    const res = await patchChannel(jwt, channelId, { config: { url: "http://127.1/hook" } });
    expect(res.status).toBe(400);
    expect(errCode(await res.json())).toBe("SSRF_BLOCKED");
  });
});

/* ── pin gap: the self-guard (SELF_UPDATE_FORBIDDEN) ────────────────────── */

describe("wave-9 pin: SELF_UPDATE_FORBIDDEN (no self-deactivation / self-demotion)", () => {
  test("an admin cannot deactivate their own account", async () => {
    const admin = await db.user.findUnique({ where: { id: adminUserId } });
    const jwt = await mintSessionJwt(admin!);
    const res = await patchUser(jwt, adminUserId, { isActive: false });
    expect(res.status).toBe(409); // the route's established refusal status
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("SELF_UPDATE_FORBIDDEN");
    expect(body.error?.message).toContain("deactivate");
    const row = await db.user.findUnique({ where: { id: adminUserId } });
    expect(row?.isActive).toBe(true);
  });

  test("an admin cannot demote their own role", async () => {
    const admin = await db.user.findUnique({ where: { id: adminUserId } });
    const jwt = await mintSessionJwt(admin!);
    const res = await patchUser(jwt, adminUserId, { role: "viewer" });
    expect(res.status).toBe(409);
    expect(errCode(await res.json())).toBe("SELF_UPDATE_FORBIDDEN");
    const row = await db.user.findUnique({ where: { id: adminUserId } });
    expect(row?.role).toBe("admin");
  });
});

/* ── pin gap: settings PATCH allowlist + typed refusals ─────────────────── */

describe("wave-9 pin: settings PATCH allowlist (UNKNOWN_SETTING + typed refusals)", () => {
  test("an unknown key answers UNKNOWN_SETTING (allowlist enforced)", async () => {
    const admin = await db.user.findUnique({ where: { id: adminUserId } });
    const jwt = await mintSessionJwt(admin!);
    const res = await patchSettings(jwt, {
      updates: [{ key: "telemetry.phones.home", value: "555-0100" }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("UNKNOWN_SETTING");
    expect(body.error?.message).toContain("telemetry.phones.home");
  });

  test("wrong type / null / below min / above max answer the typed INVALID_BODY refusals", async () => {
    const admin = await db.user.findUnique({ where: { id: adminUserId } });
    const jwt = await mintSessionJwt(admin!);

    // string-typed key given a number
    const wrongType = await patchSettings(jwt, { updates: [{ key: "system.name", value: 42 }] });
    expect(wrongType.status).toBe(400);
    expect(((await wrongType.json()) as { error?: { message?: string } }).error?.message).toContain(
      "expects a non-empty string"
    );

    // null is never writable
    const nulled = await patchSettings(jwt, { updates: [{ key: "system.name", value: null }] });
    expect(nulled.status).toBe(400);
    expect(((await nulled.json()) as { error?: { message?: string } }).error?.message).toContain(
      "cannot be set to null"
    );

    // number below the catalog minimum
    const below = await patchSettings(jwt, { updates: [{ key: "backup.retention.days", value: 3 }] });
    expect(below.status).toBe(400);
    expect(((await below.json()) as { error?: { message?: string } }).error?.message).toContain("≥ 7");

    // number above the catalog maximum
    const above = await patchSettings(jwt, { updates: [{ key: "backup.retention.days", value: 99999 }] });
    expect(above.status).toBe(400);
    expect(((await above.json()) as { error?: { message?: string } }).error?.message).toContain("≤ 730");

    // boolean-typed key given a string
    const boolType = await patchSettings(jwt, {
      updates: [{ key: "alert.suppression.maintenanceWindows", value: "yes" }],
    });
    expect(boolType.status).toBe(400);
    expect(((await boolType.json()) as { error?: { message?: string } }).error?.message).toContain(
      "expects a boolean"
    );
  });

  test("a valid PATCH writes the value and one SETTINGS_UPDATED row with before/after", async () => {
    const admin = await db.user.findUnique({ where: { id: adminUserId } });
    const jwt = await mintSessionJwt(admin!);
    const nextName = `W9 Hygiene ${RUN}`;
    const res = await patchSettings(jwt, {
      updates: [
        { key: "system.name", value: nextName },
        { key: "backup.encryption", value: `w9hy-${RUN}` },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { updated?: string[]; settings?: Record<string, unknown> } };
    expect(body.data?.updated).toEqual(["system.name", "backup.encryption"]);
    expect(body.data?.settings?.["system.name"]).toBe(nextName);

    const audit = await db.auditEvent.findFirst({
      where: { action: "SETTINGS_UPDATED", resourceType: "Setting", createdAt: { gte: testStartedAt } },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).toBeTruthy();
    expect(JSON.parse(audit!.afterJson ?? "{}")).toEqual({
      "system.name": nextName,
      "backup.encryption": `w9hy-${RUN}`,
    });
    expect(JSON.parse(audit!.beforeJson ?? "{}")["system.name"]).toBe(originalSystemName);
    expect(JSON.parse(audit!.beforeJson ?? "{}")["backup.encryption"]).toBe(originalBackupEncryption);
  });
});

/* ── pin gap: no password material in the USER_PASSWORD_RESET audit row ─── */

describe("wave-9 pin: USER_PASSWORD_RESET carries no password material", () => {
  test("the reset audit row never contains the plaintext (or any hash fragment)", async () => {
    const admin = await db.user.findUnique({ where: { id: adminUserId } });
    const jwt = await mintSessionJwt(admin!);
    const res = await resetPassword(jwt, targetUserId, RESET_PASSWORD);
    expect(res.status).toBe(200);

    const audit = await db.auditEvent.findFirst({
      where: { action: "USER_PASSWORD_RESET", resourceId: targetUserId, createdAt: { gte: testStartedAt } },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).toBeTruthy();
    const serialized = JSON.stringify({
      before: audit!.beforeJson,
      after: audit!.afterJson,
      label: audit!.resourceLabel,
    });
    expect(serialized.includes(RESET_PASSWORD)).toBe(false);
    // The after payload is EXACTLY the documented fact pair — no extra
    // field can smuggle material in.
    expect(JSON.parse(audit!.afterJson ?? "null")).toEqual({
      email: TARGET_EMAIL,
      passwordChanged: true, // never the value itself
    });

    // The stored credential is the scrypt envelope, never the plaintext.
    const row = await db.user.findUnique({ where: { id: targetUserId }, select: { passwordHash: true } });
    expect(row?.passwordHash?.startsWith("scrypt$")).toBe(true);
    expect(row?.passwordHash?.includes(RESET_PASSWORD)).toBe(false);
  });
});

/* ── F-3: credential-epoch semantics ───────────────────────────────────── */

describe("wave-9 F-3: credential epoch (mint / check / bump)", () => {
  test("current-epoch token accepted; stale-epoch and claim-less tokens refused (requireUser-level eviction)", async () => {
    const target = await db.user.findUnique({ where: { id: targetUserId } });
    const epoch = target?.credentialEpoch ?? 0;
    expect(epoch).toBeGreaterThan(0); // the reset above bumped it

    // A token minted AFTER the bump (fresh sign-in semantics) → accepted.
    const currentJwt = await mintSessionJwt({
      id: target!.id,
      email: target!.email,
      name: target!.name,
      role: target!.role,
      credentialEpoch: epoch,
    });
    await expect(requireUser(sessionRequest(currentJwt, "http://app.local/x"))).resolves.toBeTruthy();

    // The token minted BEFORE the bump (one epoch behind) → 401.
    const staleJwt = await mintSessionJwt({
      id: target!.id,
      email: target!.email,
      name: target!.name,
      role: target!.role,
      credentialEpoch: epoch - 1,
    });
    try {
      await requireUser(sessionRequest(staleJwt, "http://app.local/x"));
      throw new Error("expected AuthError for a stale-epoch token");
    } catch (error) {
      expect(error instanceof AuthError).toBe(true);
      expect((error as AuthError).code).toBe("UNAUTHENTICATED");
      expect((error as AuthError).status).toBe(401);
    }

    // A claim-less (pre-epoch) token against a bumped row → 401 too: the
    // absent claim degrades to epoch 0, which no longer matches.
    const claimlessJwt = await mintSessionJwt({
      id: target!.id,
      email: target!.email,
      name: target!.name,
      role: target!.role,
    });
    try {
      await requireUser(sessionRequest(claimlessJwt, "http://app.local/x"));
      throw new Error("expected AuthError for a claim-less token on a bumped row");
    } catch (error) {
      expect((error as AuthError).code).toBe("UNAUTHENTICATED");
      expect((error as AuthError).status).toBe(401);
    }
  });

  test("epoch 0 row + absent claim → valid; a MISMATCHED claim → refused (fail-closed both ways)", async () => {
    const fresh = await db.user.create({
      data: { email: `w9hy-epoch0-${RUN.toLowerCase()}@faya.local`, name: "W9 Epoch0", role: "viewer", isActive: true },
      select: { id: true, email: true, name: true, role: true, credentialEpoch: true },
    });
    try {
      expect(fresh.credentialEpoch).toBe(0);
      const okJwt = await mintSessionJwt({ ...fresh, credentialEpoch: 0 });
      await expect(requireUser(sessionRequest(okJwt, "http://app.local/x"))).resolves.toBeTruthy();

      const futureJwt = await mintSessionJwt({ ...fresh, credentialEpoch: 7 });
      try {
        await requireUser(sessionRequest(futureJwt, "http://app.local/x"));
        throw new Error("expected AuthError for a token claiming a future epoch");
      } catch (error) {
        expect((error as AuthError).code).toBe("UNAUTHENTICATED");
        expect((error as AuthError).status).toBe(401);
      }
    } finally {
      await db.auditEvent.deleteMany({
        where: { resourceType: "User", resourceId: fresh.id, createdAt: { gte: testStartedAt } },
      });
      await db.user.delete({ where: { id: fresh.id } });
    }
  });

  test("the epoch bump rides the users/[id] PATCH transaction on password SET and scope change (wave-11)", async () => {
    const admin = await db.user.findUnique({ where: { id: adminUserId } });
    const jwt = await mintSessionJwt(admin!);
    const before = await db.user.findUnique({ where: { id: targetUserId }, select: { credentialEpoch: true } });

    // Name-only PATCH: epoch untouched.
    const nameOnly = await patchUser(jwt, targetUserId, { name: `W9 Renamed ${RUN}` });
    expect(nameOnly.status).toBe(200);
    const afterName = await db.user.findUnique({ where: { id: targetUserId }, select: { credentialEpoch: true } });
    expect(afterName?.credentialEpoch).toBe(before?.credentialEpoch);

    // Password SET: epoch increments in the same transaction.
    const withPassword = await patchUser(jwt, targetUserId, { password: `W9hy-Set-${RUN}-9kLm` });
    expect(withPassword.status).toBe(200);
    const afterPassword = await db.user.findUnique({ where: { id: targetUserId }, select: { credentialEpoch: true } });
    expect(afterPassword?.credentialEpoch).toBe((before?.credentialEpoch ?? 0) + 1);

    // Wave-11 (audit 15-b F-3): a scope-only PATCH ALSO bumps the epoch in
    // the same transaction — the documented "scope changes require
    // re-login" is enforced (the stale-WIDER sites claim dies with the old
    // token instead of riding it to expiry).
    const scopeOnly = await patchUser(jwt, targetUserId, { siteScope: null });
    expect(scopeOnly.status).toBe(200);
    const afterScope = await db.user.findUnique({ where: { id: targetUserId }, select: { credentialEpoch: true } });
    expect(afterScope?.credentialEpoch).toBe((before?.credentialEpoch ?? 0) + 2);
  });

  test("options.ts mints the epoch at sign-in and the refresh branch never re-reads it", async () => {
    const jwtCallback = authOptions.callbacks?.jwt;
    expect(jwtCallback).toBeDefined();

    // Sign-in: the claim is stamped from the authorized user (3 → 3).
    const minted = await jwtCallback!({
      token: { id: "x", email: "x@faya.local" } as never,
      user: { id: "x", email: "x@faya.local", name: "X", role: "viewer", credentialEpoch: 3 } as never,
    } as never);
    expect((minted as Record<string, unknown>).credentialEpoch).toBe(3);

    // Sign-in WITHOUT the key (pre-epoch authorize shape) → 0 semantics.
    const mintedLegacy = await jwtCallback!({
      token: { id: "x", email: "x@faya.local" } as never,
      user: { id: "x", email: "x@faya.local", name: "X", role: "viewer" } as never,
    } as never);
    expect((mintedLegacy as Record<string, unknown>).credentialEpoch).toBe(0);

    // Refresh branch (no `user` argument): the DB row's epoch must NOT
    // bleed into a token minted before the bump — eviction would self-heal
    // otherwise. Target row carries epoch 1 here; a token claiming 0 stays 0.
    const refreshed = await jwtCallback!({
      token: { id: targetUserId, email: TARGET_EMAIL, name: "T", role: "viewer", credentialEpoch: 0 } as never,
    } as never);
    expect((refreshed as Record<string, unknown>).credentialEpoch).toBe(0);
    // ...and a token with NO claim gains nothing from the refresh either.
    const refreshedBare = await jwtCallback!({
      token: { id: targetUserId, email: TARGET_EMAIL, name: "T", role: "viewer" } as never,
    } as never);
    expect("credentialEpoch" in (refreshedBare as Record<string, unknown>)).toBe(false);
  });
});

/* ── F-2: transactional mutation+audit — behavioral + source pins ───────── */

describe("wave-9 F-2: mutation+audit transactionality", () => {
  test("API client create commits the row AND its API_CLIENT_CREATED audit inside one transaction", async () => {
    const admin = await db.user.findUnique({ where: { id: adminUserId } });
    const jwt = await mintSessionJwt(admin!);
    const res = await postApiClient(jwt, { name: API_CLIENT_NAME, scopes: ["devices.read"] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data?: { client?: { id?: string; tokenPrefix?: string; scopes?: string[] }; token?: string; audit?: { correlationId: string } };
    };
    apiClientId = body.data?.client?.id ?? "";
    expect(apiClientId.length).toBeGreaterThan(0);
    // The plaintext token is shown exactly once and the hash never leaves.
    expect(typeof body.data?.token).toBe("string");
    expect(JSON.stringify(body)).not.toContain("tokenHash");
    expect(body.data?.audit?.correlationId).toBeTruthy();

    const audit = await db.auditEvent.findFirst({
      where: { action: "API_CLIENT_CREATED", resourceId: apiClientId, createdAt: { gte: testStartedAt } },
    });
    expect(audit).toBeTruthy();
    expect(audit!.correlationId).toBe(body.data!.audit!.correlationId);
    const after = JSON.parse(audit!.afterJson ?? "{}") as { tokenPrefix?: string; scopes?: string[] };
    expect(after.tokenPrefix).toBe(body.data?.client?.tokenPrefix);
    expect(after.scopes).toEqual(["devices.read"]);
  });

  test("every Task 7-b route wraps its mutation and its audit row in one $transaction (source pins)", () => {
    const surfaces: Array<{ file: string; model: string; ops: string[] }> = [
      { file: "src/app/api/v1/admin/settings/route.ts", model: "setting", ops: ["upsert"] },
      { file: "src/app/api/v1/admin/api-clients/route.ts", model: "apiClient", ops: ["create"] },
      { file: "src/app/api/v1/admin/api-clients/[id]/route.ts", model: "apiClient", ops: ["update", "delete"] },
      { file: "src/app/api/v1/admin/api-clients/[id]/rotate/route.ts", model: "apiClient", ops: ["update"] },
      { file: "src/app/api/v1/admin/webhooks/route.ts", model: "webhookEndpoint", ops: ["create"] },
      { file: "src/app/api/v1/admin/webhooks/[id]/route.ts", model: "webhookEndpoint", ops: ["update", "delete"] },
      { file: "src/app/api/v1/admin/notification-channels/route.ts", model: "notificationChannel", ops: ["create"] },
      { file: "src/app/api/v1/admin/notification-channels/[id]/route.ts", model: "notificationChannel", ops: ["update", "delete"] },
    ];
    for (const { file, model, ops } of surfaces) {
      const src = readFileSync(file, "utf8");
      // The audit row is written on the TRANSACTION client…
      expect(src, file).toContain("tx.auditEvent.create");
      // …inside a $transaction block…
      expect(src, file).toContain("db.$transaction(async (tx)");
      // …and no audit or mutation write escapes the transaction anymore.
      expect(src, file).not.toMatch(/await db\.auditEvent\.create/);
      expect(src, file).not.toMatch(new RegExp(`await db\\.${model}\\.(create|update|upsert|delete)\\b`));
      for (const op of ops) {
        expect(src, file).toContain(`tx.${model}.${op}`);
      }
    }

    // The settings batch is atomic WITHIN itself: validation prepares the
    // keys, then ONE transaction does before-reads + all upserts + audit.
    const settings = readFileSync("src/app/api/v1/admin/settings/route.ts", "utf8");
    expect(settings).toContain("tx.setting.findUnique");
    expect(settings).toContain("tx.setting.upsert");
    expect(settings).toContain('"SETTINGS_UPDATED"');
  });

  test("the epoch bump shares the users-family transactions (source pins)", () => {
    const patch = readFileSync("src/app/api/v1/admin/users/[id]/route.ts", "utf8");
    expect(patch).toContain("passwordHash, credentialEpoch: { increment: 1 }");
    expect(patch).toContain("db.$transaction(async (tx)");
    expect(patch).not.toMatch(/await db\.user\.update/);

    const reset = readFileSync("src/app/api/v1/admin/users/[id]/reset-password/route.ts", "utf8");
    expect(reset).toContain("data: { passwordHash, credentialEpoch: { increment: 1 } }");
    expect(reset).toContain("db.$transaction(async (tx)");
    expect(reset).not.toMatch(/await db\.user\.update/);
    expect(reset).not.toMatch(/await db\.auditEvent\.create/);
  });

  test("schema + mint + check wiring pins (the epoch mechanism cannot silently rot)", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    expect(schema).toMatch(/credentialEpoch\s+Int\s+@default\(0\)/);

    const options = readFileSync("src/lib/auth/options.ts", "utf8");
    expect(options).toContain("credentialEpoch");
    expect(options).toContain("token.credentialEpoch is deliberately NOT refreshed");

    const session = readFileSync("src/lib/auth/session.ts", "utf8");
    expect(session).toContain("assertCredentialEpochFresh(claims, user)");
    // The check lives in BOTH re-verification planes (mutations + reads).
    expect(session.match(/assertCredentialEpochFresh\(claims, user\)/g)?.length).toBe(2);
    expect(session).toContain("UNAUTHENTICATED");
  });

  test("CHANNEL_UPDATED records the full closed config before/after (F-1)", async () => {
    const admin = await db.user.findUnique({ where: { id: adminUserId } });
    const jwt = await mintSessionJwt(admin!);
    const newAddress = `w9hy-renamed-${RUN.toLowerCase()}@example.invalid`;
    const res = await patchChannel(jwt, channelId, {
      config: { address: newAddress, displayName: `W9 Renamed ${RUN}` },
    });
    expect(res.status).toBe(200);

    const audit = await db.auditEvent.findFirst({
      where: { action: "CHANNEL_UPDATED", resourceId: channelId, createdAt: { gte: testStartedAt } },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).toBeTruthy();
    const before = JSON.parse(audit!.beforeJson ?? "{}") as { config?: Record<string, unknown> };
    const after = JSON.parse(audit!.afterJson ?? "{}") as { config?: Record<string, unknown> };
    expect(before.config?.address).toBe(`w9hy-${RUN.toLowerCase()}@example.invalid`);
    expect(after.config?.address).toBe(newAddress);
    expect(after.config?.displayName).toBe(`W9 Renamed ${RUN}`);
    // The closed schema carries no credential-like field to mask.
    const configKeys = Object.keys(after.config ?? {});
    for (const key of configKeys) {
      expect(["address", "displayName", "url"]).toContain(key);
    }
  });
});
