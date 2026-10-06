/**
 * Wave-11 authN issuance pins (audit 15-b — authorize enumeration/timing,
 * /auth/session epoch enforcement, scope-change eviction, doc/env honesty).
 *
 * Fix batch (trace 1a10d76de6d970cd):
 *
 *   F-1 (P3)  authorize() no longer answers "Account disabled" BEFORE the
 *             scrypt verification — the disabled check moved BEHIND
 *             verifyPassword, so a wrong guess against a disabled account
 *             gets the generic null (no existence oracle), while a VALID
 *             credential for a disabled account still surfaces the distinct
 *             "Account disabled" message the sign-in gate renders verbatim.
 *             The unknown-email / null-hash path burns an equivalent scrypt
 *             derivation against a FIXED dummy hash (timing equalizer) and
 *             STILL records the login-guard failure (uniform accounting).
 *   F-2 (P4)  GET /api/v1/auth/session enforces the wave-9 credential-epoch
 *             eviction contract (requireUser mirror): a stale-epoch token
 *             gets the SAME signed-out envelope an anonymous request gets —
 *             no identity/permission/mfa bootstrap for an evicted token.
 *             Epoch-0 row + claim-less token stays valid (backward compat).
 *   F-3 (P4)  A siteScope change on PATCH /api/v1/admin/users/[id] bumps
 *             User.credentialEpoch inside the SAME transaction — the
 *             documented "scope changes require re-login" is now a hard
 *             guarantee (the live token's stale-WIDER sites claim dies with
 *             the token).
 *   F-4 (P4)  The session maxAge docstring states the REAL semantics
 *             (sliding, renewed per page load; revocation-NOW = epoch bump;
 *             absolute cap deliberately NOT implemented — owner decision)
 *             and the authorization matrix says the same.
 *   F-5 (P4)  The production env example models NEXTAUTH_URL as https://
 *             with the secure-cookie-derives-from-scheme note.
 *
 * Harness: the certified batch-25/wave-9 rig — REAL next-auth JWTs from the
 * production `encode`, RUN-suffixed fixtures, surgical afterAll cleanup,
 * real scrypt, real handlers.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";

import { db } from "../../src/lib/db";
import { hashPassword, verifyPassword } from "../../src/lib/auth/password";
import { DUMMY_CREDENTIAL_HASH, authOptions } from "../../src/lib/auth/options";
import { AuthError } from "../../src/lib/auth/session";
import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";

/* ── fixtures (RUN-suffixed — parallel-safe, re-runnable) ─────────────── */

const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
const ADMIN_EMAIL = `w11an-admin-${RUN.toLowerCase()}@faya.local`;
const TARGET_EMAIL = `w11an-target-${RUN.toLowerCase()}@faya.local`;
const DISABLED_EMAIL = `w11an-disabled-${RUN.toLowerCase()}@faya.local`;
const VALID_EMAIL = `w11an-valid-${RUN.toLowerCase()}@faya.local`;
const UNKNOWN_EMAIL = `w11an-unknown-${RUN.toLowerCase()}@faya.local`;

const testStartedAt = new Date();

let adminUserId = "";
let targetUserId = "";

type SessionShape = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  credentialEpoch?: number;
};

/** The certified rt012/batch-3 session-mint helper, epoch-aware. */
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

function sessionRequest(jwt: string, url: string): Request {
  return new NextRequest(url, {
    method: "GET",
    headers: { cookie: `next-auth.session-token=${jwt}` },
  }) as unknown as Request;
}

async function getSession(jwt: string): Promise<Response> {
  const { GET } = (await import("../../src/app/api/v1/auth/session/route")) as {
    GET: (req: Request) => Promise<Response>;
  };
  return GET(sessionRequest(jwt, "http://app.local/api/v1/auth/session"));
}

async function patchUser(jwt: string, id: string, body: unknown): Promise<Response> {
  const { PATCH } = (await import(
    "../../src/app/api/v1/admin/users/[id]/route"
  )) as {
    PATCH: (
      req: Request,
      ctx: { params: Promise<{ id: string }> }
    ) => Promise<Response>;
  };
  return PATCH(
    new NextRequest(`http://app.local/api/v1/admin/users/${id}`, {
      method: "PATCH",
      headers: {
        cookie: `next-auth.session-token=${jwt}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }) as unknown as Request,
    { params: Promise.resolve({ id }) }
  );
}

/* ── authorize() extracted from the real provider (login-guard rig) ────── */

type AuthorizeFn = (
  credentials: Record<string, string> | undefined,
  req: {
    headers?: Record<string, unknown>;
    body?: Record<string, unknown>;
    query?: Record<string, unknown>;
    method?: string;
  }
) => Promise<unknown>;
// next-auth v4 ships the configured authorize under provider.options — the
// provider object itself carries a `() => null` STUB which the core replaces
// by merging userOptions over it (core/lib/providers.js parseProviders).
const providerRaw = authOptions.providers[0] as unknown as {
  authorize?: AuthorizeFn;
  options?: { authorize?: AuthorizeFn };
};
const authorize = (providerRaw.options?.authorize ??
  providerRaw.authorize) as AuthorizeFn;

function authorizeReq(ip: string): Parameters<AuthorizeFn>[1] {
  return {
    method: "POST",
    headers: { "x-forwarded-for": ip },
    body: {},
    query: {},
  };
}

async function createTestUser(
  email: string,
  role: string,
  isActive: boolean,
  password?: string
): Promise<string> {
  const user = await db.user.create({
    data: {
      email,
      name: `Wave11 AuthN ${email.slice(5, 16)}`,
      role,
      isActive,
      ...(password !== undefined
        ? { passwordHash: await hashPassword(password) }
        : {}),
    },
    select: { id: true },
  });
  return user.id;
}

beforeAll(async () => {
  // The CI gate replays ONLY `migrate deploy` (no demo seed): upsert the
  // roles the probes act through from ROLE_MATRIX — the certified batch-25
  // pattern. The custom /auth/session route reads Role.permissionsJson.
  for (const roleName of ["admin", "viewer"] as const) {
    const entry = ROLE_MATRIX.find((role) => role.name === roleName);
    await db.role.upsert({
      where: { name: roleName },
      update: {},
      create: {
        name: roleName,
        description: entry?.description ?? roleName,
        permissionsJson: JSON.stringify(
          entry?.permissions ?? (roleName === "admin" ? ["*"] : [])
        ),
      },
    });
  }

  adminUserId = await createTestUser(ADMIN_EMAIL, "admin", true);
  targetUserId = await createTestUser(TARGET_EMAIL, "viewer", true);
});

afterAll(async () => {
  // Surgical cleanup (createdAt-gte bound so a parallel RUN's rows survive).
  const emails = [ADMIN_EMAIL, TARGET_EMAIL, DISABLED_EMAIL, VALID_EMAIL, UNKNOWN_EMAIL];
  const users = await db.user.findMany({
    where: { email: { in: emails } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length > 0) {
    await db.auditEvent.deleteMany({ where: { actorId: { in: ids } } });
  }
  await db.user.deleteMany({ where: { email: { in: emails } } });
  // Pre-auth telemetry rows (login-guard sink) from THIS run only.
  await db.auditEvent.deleteMany({
    where: { actorName: "login-guard", createdAt: { gte: testStartedAt } },
  });
});

/* ───────────────── F-1 — authorize enumeration/timing discipline ──────── */

describe("wave-11 F-1 — authorize() enumeration/timing (real DB, real scrypt)", () => {
  test("disabled account + WRONG password answers the GENERIC null (no existence oracle)", async () => {
    await createTestUser(DISABLED_EMAIL, "viewer", false, "right-password");
    let threw = "";
    let result: unknown = "sentinel";
    try {
      result = await authorize(
        { email: DISABLED_EMAIL, password: "wrong-guess" },
        authorizeReq("10.40.0.1")
      );
    } catch (error) {
      threw = error instanceof Error ? error.message : "";
    }
    expect(threw).toBe(""); // nothing thrown — the pre-verify oracle is gone
    expect(result).toBeNull(); // the generic credentials failure
  });

  test("disabled account + VALID credential still throws the distinct 'Account disabled'", async () => {
    let message = "";
    try {
      await authorize(
        { email: DISABLED_EMAIL, password: "right-password" },
        authorizeReq("10.40.1.1")
      );
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toBe("Account disabled");
  });

  test("unknown email answers the SAME generic null as a wrong password", async () => {
    const unknown = await authorize(
      { email: UNKNOWN_EMAIL, password: "whatever" },
      authorizeReq("10.40.2.1")
    );
    expect(unknown).toBeNull();
  });

  test("the dummy-hash burn is a REAL full-cost scrypt hash (format + verify behavior)", async () => {
    // The burn only equalizes timing if the string is well-formed: a
    // malformed value short-circuits in verifyPassword WITHOUT the KDF.
    expect(DUMMY_CREDENTIAL_HASH).toMatch(
      /^scrypt\$16384\$[0-9a-f]{32}\$[0-9a-f]{128}$/
    );
    // It parses, derives and (deliberately) never matches a real guess —
    // the authorize() branch discards the verdict either way.
    expect(await verifyPassword("any-guess", DUMMY_CREDENTIAL_HASH)).toBe(false);
  });

  test("unknown-email failures STILL feed the login guard (recordLoginFailure preserved)", async () => {
    // Burn the per-source budget with UNKNOWN emails (each burns scrypt and
    // records a failure). The 11th attempt from the same source — even with
    // a VALID account + correct password — is denied by the guard.
    const ip = "10.40.3.1";
    for (let i = 0; i < 10; i += 1) {
      const burn = await authorize(
        { email: UNKNOWN_EMAIL, password: `guess-${i}` },
        authorizeReq(ip)
      );
      expect(burn).toBeNull();
    }
    const validId = await createTestUser(VALID_EMAIL, "viewer", true, "correct-horse");
    try {
      const denied = await authorize(
        { email: VALID_EMAIL, password: "correct-horse" },
        authorizeReq(ip)
      );
      expect(denied).toBeNull();
      // No successful sign-in leaked through the tripped guard.
      const loginRow = await db.auditEvent.findFirst({
        where: { action: "USER_LOGIN", resourceLabel: VALID_EMAIL },
      });
      expect(loginRow).toBeNull();
      // The guard is SOURCE-keyed: a fresh source signs in the same account.
      const freshSource = await authorize(
        { email: VALID_EMAIL, password: "correct-horse" },
        authorizeReq("10.40.3.2")
      );
      expect(freshSource).not.toBeNull();
    } finally {
      await db.auditEvent.deleteMany({
        where: { action: "USER_LOGIN", resourceId: validId },
      });
      await db.user.delete({ where: { id: validId } });
    }
  });
});

/* ───────────────── F-2 — /auth/session epoch enforcement ──────────────── */

describe("wave-11 F-2 — GET /api/v1/auth/session enforces the credential epoch", () => {
  test("current-epoch token → full bootstrap (user + permissions + mfaEnabled)", async () => {
    const target = await db.user.findUnique({ where: { id: targetUserId } });
    const jwt = await mintSessionJwt({
      id: target!.id,
      email: target!.email,
      name: target!.name,
      role: target!.role,
      credentialEpoch: target!.credentialEpoch,
    });
    const res = await getSession(jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data?: { user?: { email?: string }; permissions?: string[]; mfaEnabled?: boolean };
    };
    expect(body.data?.user?.email).toBe(TARGET_EMAIL);
    expect(Array.isArray(body.data?.permissions)).toBe(true);
    expect(body.data?.mfaEnabled).toBe(false);
  });

  test("stale-epoch token → the SAME signed-out envelope an anonymous request gets", async () => {
    // Dedicated fixture: bump the row's epoch AFTER minting the token (any
    // credential event — password set/reset or a scope change — does this).
    const evictedEmail = `w11an-evicted-${RUN.toLowerCase()}@faya.local`;
    const userId = await createTestUser(evictedEmail, "viewer", true);
    try {
      const jwt = await mintSessionJwt({
        id: userId,
        email: evictedEmail,
        name: null,
        role: "viewer",
        credentialEpoch: 0,
      });
      expect((await getSession(jwt)).status).toBe(200);

      await db.user.update({ where: { id: userId }, data: { credentialEpoch: { increment: 1 } } });

      const res = await getSession(jwt);
      expect(res.status).toBe(401);
      const body = (await res.json()) as {
        success?: boolean;
        data?: unknown;
        error?: { code?: string };
      };
      expect(body.success).toBe(false);
      expect(body.error?.code).toBe("UNAUTHENTICATED");
      expect(body.data).toBeUndefined(); // no identity/permission bootstrap

      // A claim-less (pre-epoch) token on a bumped row is evicted too —
      // the absent claim degrades to epoch 0, which no longer matches.
      const claimless = await mintSessionJwt({
        id: userId,
        email: evictedEmail,
        name: null,
        role: "viewer",
      });
      expect((await getSession(claimless)).status).toBe(401);
    } finally {
      await db.user.delete({ where: { id: userId } });
    }
  });

  test("backward compat: epoch-0 row + claim-less (pre-epoch) token stays signed in", async () => {
    const admin = await db.user.findUnique({ where: { id: adminUserId } });
    expect(admin?.credentialEpoch).toBe(0);
    const jwt = await mintSessionJwt({
      id: admin!.id,
      email: admin!.email,
      name: admin!.name,
      role: admin!.role,
      // credentialEpoch omitted — the pre-epoch token shape.
    });
    const res = await getSession(jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { user?: { email?: string } } };
    expect(body.data?.user?.email).toBe(ADMIN_EMAIL);
  });
});

/* ──────────────── F-3 — scope-change eviction (end to end) ────────────── */

describe("wave-11 F-3 — a scope change evicts live tokens (re-login enforced)", () => {
  test("scope-only PATCH bumps the epoch in-transaction; the pre-bump token dies, a fresh one works", async () => {
    const admin = await db.user.findUnique({ where: { id: adminUserId } });
    const adminJwt = await mintSessionJwt(admin!);
    const target = await db.user.findUnique({ where: { id: targetUserId } });
    const beforeEpoch = target?.credentialEpoch ?? 0;

    // The user's LIVE token (minted before the scope change).
    const oldJwt = await mintSessionJwt({
      id: target!.id,
      email: target!.email,
      name: target!.name,
      role: target!.role,
      credentialEpoch: beforeEpoch,
    });
    expect((await getSession(oldJwt)).status).toBe(200);

    // Scope-only PATCH → 200 and epoch +1.
    const res = await patchUser(adminJwt, targetUserId, { siteScope: ["HQ-SAN"] });
    expect(res.status).toBe(200);
    const after = await db.user.findUnique({
      where: { id: targetUserId },
      select: { credentialEpoch: true, siteScopeJson: true },
    });
    expect(after?.credentialEpoch).toBe(beforeEpoch + 1);
    expect(after?.siteScopeJson).toBe(JSON.stringify(["HQ-SAN"]));

    // The OLD (stale-WIDER) token is evicted from the bootstrap plane…
    const evicted = await getSession(oldJwt);
    expect(evicted.status).toBe(401);
    const evictedBody = (await evicted.json()) as { error?: { code?: string } };
    expect(evictedBody.error?.code).toBe("UNAUTHENTICATED");
    // …and from the requireUser mutation plane (same contract).
    const { requireUser } = await import("../../src/lib/auth/session");
    try {
      await requireUser(sessionRequest(oldJwt, "http://app.local/api/v1/devices"));
      throw new Error("expected AuthError for a stale-epoch token");
    } catch (error) {
      expect(error instanceof AuthError).toBe(true);
      expect((error as AuthError).code).toBe("UNAUTHENTICATED");
    }

    // A token minted AFTER the change (fresh sign-in semantics) works and
    // the name-only PATCH leaves the epoch untouched.
    const newJwt = await mintSessionJwt({
      id: target!.id,
      email: target!.email,
      name: target!.name,
      role: target!.role,
      credentialEpoch: beforeEpoch + 1,
    });
    expect((await getSession(newJwt)).status).toBe(200);
    const rename = await patchUser(adminJwt, targetUserId, { name: `W11 Renamed ${RUN}` });
    expect(rename.status).toBe(200);
    const afterRename = await db.user.findUnique({
      where: { id: targetUserId },
      select: { credentialEpoch: true },
    });
    expect(afterRename?.credentialEpoch).toBe(beforeEpoch + 1);

    // Cleanup of the fixture writes (parallel-safe re-runnability).
    await db.user.update({
      where: { id: targetUserId },
      data: { siteScopeJson: null, name: `Wave11 AuthN target` },
    });
    await db.auditEvent.deleteMany({
      where: {
        resourceType: "User",
        resourceId: targetUserId,
        createdAt: { gte: testStartedAt },
      },
    });
  });
});

/* ─────────────────────── structural regression pins ───────────────────── */

describe("wave-11 — source pins (the mechanisms cannot silently rot)", () => {
  const read = (p: string): string => readFileSync(p, "utf8");

  test("F-1 PIN: authorize verifies the password BEFORE the isActive check", () => {
    const src = read("src/lib/auth/options.ts");
    const verifyAt = src.indexOf("const valid = await verifyPassword(password, user.passwordHash)");
    const disabledAt = src.indexOf('CredentialsSigninError("Account disabled")');
    const mfaAt = src.indexOf("evaluateMfaChallenge(user, submittedCode)");
    expect(verifyAt).toBeGreaterThan(-1);
    expect(disabledAt).toBeGreaterThan(verifyAt); // verify FIRST, then isActive
    expect(mfaAt).toBeGreaterThan(disabledAt); // challenge still after both
  });

  test("F-1 PIN: the unknown/null-hash branch burns the dummy hash, records, returns null", () => {
    const src = read("src/lib/auth/options.ts");
    const burnAt = src.indexOf("await verifyPassword(password, DUMMY_CREDENTIAL_HASH)");
    const recordAt = src.indexOf("recordLoginFailure(loginIdentity)", burnAt);
    const nullAt = src.indexOf("return null", recordAt);
    expect(burnAt).toBeGreaterThan(-1);
    expect(recordAt).toBeGreaterThan(burnAt);
    expect(nullAt).toBeGreaterThan(recordAt);
    // The wrong-password branch still records through the guard (the
    // uniform (source, account) accounting is unchanged).
    expect(src).toContain("recordLoginSuccess(loginIdentity)");
  });

  test("F-1 PIN: the guard still runs BEFORE the DB lookup and the verification", () => {
    const src = read("src/lib/auth/options.ts");
    const guardAt = src.indexOf("await checkLoginAllowed(");
    const dbAt = src.indexOf("db.user.findUnique");
    const verifyAt = src.indexOf("await verifyPassword(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(dbAt).toBeGreaterThan(guardAt);
    expect(verifyAt).toBeGreaterThan(guardAt);
  });

  test("F-2 PIN: the session route selects credentialEpoch and compares before the ok() response", () => {
    const src = read("src/app/api/v1/auth/session/route.ts");
    const selectAt = src.indexOf("credentialEpoch: true");
    const compareAt = src.indexOf(
      "(claims.credentialEpoch ?? 0) !== user.credentialEpoch"
    );
    const okAt = src.indexOf("return ok({");
    expect(selectAt).toBeGreaterThan(-1);
    expect(compareAt).toBeGreaterThan(selectAt);
    expect(okAt).toBeGreaterThan(compareAt);
    // The evicted token gets the anonymous signed-out envelope.
    expect(src).toContain('"UNAUTHENTICATED"');
  });

  test("F-3 PIN: the scope-change epoch bump rides the SAME users/[id] transaction", () => {
    const src = read("src/app/api/v1/admin/users/[id]/route.ts");
    expect(src).toContain("db.$transaction(async (tx)");
    // The scope leg carries the bump…
    expect(src).toContain("{ siteScopeJson, credentialEpoch: { increment: 1 } }");
    // …and the wave-9 password leg is unchanged…
    expect(src).toContain("passwordHash, credentialEpoch: { increment: 1 }");
    // …both INSIDE the transactional update (no second escape-hatch write).
    expect(src).not.toMatch(/await db\.user\.update/);
  });

  test("F-4 PIN: the maxAge docstring states the sliding truth and the absolute-cap truth (P2-S01)", () => {
    const src = read("src/lib/auth/options.ts");
    expect(src).toContain("inactivity window renewed per full page load");
    expect(src).toContain("Revocation-NOW is the credentialEpoch bump");
    // GA-6 (P2-S01): the old "deliberately NOT implemented (owner decision)"
    // note is RETIRED — the docstring now pins the implemented absolute cap
    // and its env lever (see tests/auth/session-lifetime.test.ts).
    expect(src).toContain("ABSOLUTE cap is now enforced");
    expect(src).toContain("FAYANMS_SESSION_MAX_AGE_HOURS");
    // The matrix carries the same honesty (and the batch-25 anchor phrase).
    const matrix = read("docs/security/authorization-matrix.md");
    expect(matrix).toMatch(/SLIDING\s+inactivity window renewed per full page load/);
    expect(matrix).toContain("not an absolute cap");
    expect(matrix).toContain("NEXT sign-in");
  });

  test("F-5 PIN: the production env example models NEXTAUTH_URL as https with the secure-cookie note", () => {
    const src = read("docs/deploy/env.app.production.example");
    expect(src).toMatch(/^NEXTAUTH_URL=https:\/\//m);
    expect(src).not.toMatch(/^NEXTAUTH_URL=http:\/\//m);
    expect(src).toMatch(/Wave-11 \(audit 15-b F-5\): keep this https/);
    expect(src).toContain("NEXTAUTH_URL scheme");
  });
});
