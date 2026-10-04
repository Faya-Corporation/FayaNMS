/**
 * Post-register audit wave 5 — fixes from a three-agent fresh audit of the
 * surfaces that landed AFTER the findings register closed (71/71, main
 * a398984) and therefore never rode the original five module audits:
 *
 *   Agent 5-a — MFA surface (mfa.ts, /api/v1/me/mfa family, login
 *               challenge, models, UI): 0 P1 / 1 P2 / 4 P3.
 *   Agent 5-b — site scoping + machine-surface proxy lockstep:
 *               0 P1 / 1 P2 / 3 P3.
 *   Agent 5-c — HIBP breach check + ops retention: 0 P1 / 0 P2 / 3 P3.
 *
 * The fixes pinned here (every behavioral pin is DB-backed on synthetic
 * fixtures prefixed wave5-audit- and fully removed afterwards, in the
 * batch-22/24 pinning discipline):
 *
 *   P2 (5-b)  proxy step 3a now DERIVES from MACHINE_EXACT_ROUTES (single
 *             source of truth) instead of hand-copying the 10 exact
 *             pathnames — the drift that already bit once post-R62 cannot
 *             recur silently. Pinned at source level (each exact pathname
 *             appears EXACTLY ONCE in proxy.ts; `.has(pathname)` drives
 *             step 3a) AND by a registration SCAN: every route file under
 *             src/app that authenticates a service principal
 *             (authenticateServiceRequest / requireServiceOrPermission)
 *             must resolve to the machine surface (the /api/v1/worker/
 *             prefix rule or a MACHINE_EXACT_ROUTES entry) — a future
 *             unregistered machine route fails the suite, not production.
 *
 *   P2 (5-a)  failed confirm/disable verification attempts are audited
 *             (MFA_CONFIRM_FAILED / MFA_DISABLE_FAILED) and feed the login
 *             guard's ACCOUNT budget — the same escalating lockout that
 *             covers sign-in — so an online guessing attack against the
 *             fail-tight verification cannot ride the shared per-IP pool
 *             unnoticed (before this fix: 120/min per source, zero audit
 *             trail). Pinned behaviorally through the real route handlers
 *             with minted session cookies.
 *
 *   P3 (5-a)  confirm is gated by FAYANMS_MFA_MODE (the docblock's "a
 *             pending row stays DISABLED" claim is now enforced, not just
 *             documented); the ENABLED flip is a conditional claim
 *             (updateMany where enabled: false) so two concurrent confirms
 *             cannot both win and silently invalidate the first caller's
 *             issued recovery codes; the negative state machine
 *             (MFA_NOT_ENROLLED / MFA_ALREADY_ENABLED) and the
 *             disable-via-recovery-code fallback are pinned.
 *
 *   P3 (5-a)  UserMfaRecoveryCode gains @@unique([mfaId, codeHash]) —
 *             defense-in-depth making duplicate draws structurally
 *             impossible (additive migration).
 *
 *   P3 (5-b)  normalizeSiteScopeCodes caps at SITE_SCOPE_MAX_CODES (32):
 *             an oversized list (the parser's own threat model is a
 *             hand-edited DB row) is MALFORMED → deny-all fail-closed,
 *             never an unbounded claim with quadratic re-normalization on
 *             every request.
 *
 *   P3 (5-c)  a 200 with an EMPTY body from the HIBP range API is an
 *             anomaly (real buckets hold hundreds of entries) and now
 *             fails closed (PASSWORD_BREACH_CHECK_UNAVAILABLE) instead of
 *             proving absence.
 *
 *   P3 (5-c)  the retention candidate guards (terminal-status + cutoff
 *             repeated on every deleteMany, CAS spirit) are source-pinned;
 *             STATE.md's batch-22 inventory claimed a "live concurrent
 *             race pin" that never existed — corrected there.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { db } from "../../src/lib/db";
import {
  TOTP_STEP_SECONDS,
  beginMfaEnrollment,
  confirmMfaEnrollment,
  disableMfa,
  MfaError,
  resetMfaModeForTests,
  totpCodeAt,
} from "../../src/lib/auth/mfa";
import {
  SITE_SCOPE_MAX_CODES,
  normalizeSiteScopeCodes,
  sessionSiteScope,
  userSiteScopeClaim,
} from "../../src/lib/auth/scope";
import {
  HibpCheckUnavailableError,
  queryPwnedPasswordRange,
} from "../../src/lib/auth/hibp";
import {
  checkLoginAllowed,
  recordLoginFailure,
  resolveLoginIdentity,
} from "../../src/lib/auth/login-guard";
import { hashPassword } from "../../src/lib/auth/password";

/* ── helpers (batch-24 rig) ───────────────────────────────────────────── */

const FIXTURE_PREFIX = "wave5-audit-";
const REPO_ROOT = join(import.meta.dir, "../..");

function read(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

async function ensureFixtureUser(
  email: string,
  role: string,
  password?: string
): Promise<{ id: string; email: string }> {
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return existing;
  const user = await db.user.create({
    data: {
      email,
      name: FIXTURE_PREFIX + role,
      role,
      isActive: true,
      passwordHash: password ? await hashPassword(password) : null,
    },
    select: { id: true, email: true },
  });
  return user;
}

/** Mint a REAL next-auth session cookie for a synthetic user. */
async function sessionCookieFor(user: {
  id: string;
  email: string;
  role: string;
}): Promise<string> {
  const { encode } = await import("next-auth/jwt");
  const token = await encode({
    token: { id: user.id, email: user.email, name: undefined, role: user.role },
    secret: process.env.NEXTAUTH_SECRET ?? "",
  });
  return `next-auth.session-token=${token}`;
}

function jsonRequest(
  url: string,
  method: string,
  cookie: string,
  body: unknown
): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/* ── fixture state ────────────────────────────────────────────────────── */

let admin: { id: string; email: string } | null = null;
let operator: { id: string; email: string } | null = null;
const OPERATOR_PASSWORD = "wave5-Operator!2026";
const guardKeysTouched = new Set<string>();

function identityFor(email: string) {
  // Same construction the route layer performs (no forwarding headers in
  // the handler pins → identical source/account keys).
  const identity = resolveLoginIdentity(new Headers({}), email);
  guardKeysTouched.add(`src:${identity.sourceKey}`);
  guardKeysTouched.add(`acct:${identity.accountHash}`);
  return identity;
}

beforeAll(async () => {
  await db.user.deleteMany({ where: { email: { startsWith: FIXTURE_PREFIX } } });
  admin = await ensureFixtureUser(`${FIXTURE_PREFIX}admin@faya.local`, "admin");
  operator = await ensureFixtureUser(
    `${FIXTURE_PREFIX}operator@faya.local`,
    "operator",
    OPERATOR_PASSWORD
  );
  // Deterministic verification budget for the throttle pins (the account
  // clamp floor is 5; the source dimension is lifted out of the way).
  process.env.FAYANMS_LOGIN_MAX_ATTEMPTS_PER_ACCOUNT = "5";
  process.env.FAYANMS_LOGIN_MAX_ATTEMPTS_PER_SOURCE = "100";
});

afterAll(async () => {
  resetMfaModeForTests();
  delete process.env.FAYANMS_MFA_MODE;
  delete process.env.FAYANMS_LOGIN_MAX_ATTEMPTS_PER_ACCOUNT;
  delete process.env.FAYANMS_LOGIN_MAX_ATTEMPTS_PER_SOURCE;
  // Synthetic users only; UserMfa/UserMfaRecoveryCode cascade by FK.
  await db.user.deleteMany({ where: { email: { startsWith: FIXTURE_PREFIX } } });
  // Audit rows authored by the synthetic fixtures (auditMfa stamps
  // actorName = the fixture email).
  await db.auditEvent.deleteMany({
    where: { actorName: { startsWith: FIXTURE_PREFIX } },
  });
  // Login-guard state rows the suite touched (both dimensions).
  for (const key of guardKeysTouched) {
    await db.loginGuardState.deleteMany({ where: { key } });
  }
});

/* ── 1. machine-surface lockstep (P2, agent 5-b) ──────────────────────── */

describe("wave5: machine-surface lockstep is derived, not duplicated", () => {
  const proxySrc = read("src/proxy.ts");

  test("SOURCE PIN: step 3a derives from MACHINE_EXACT_ROUTES", () => {
    expect(proxySrc).toContain("MACHINE_EXACT_ROUTES.has(pathname)");
    // The old hand-copy is gone: no `pathname === "/api/v1/..."` comparison
    // for machine routes may remain outside the Set literal itself.
    const handCopies = proxySrc.match(/pathname === "\/api\/v1\/(?!meta")[^"]+"/g) ?? [];
    expect(handCopies).toEqual([]);
  });

  test("SOURCE PIN: every exact machine pathname appears EXACTLY ONCE", () => {
    const setStart = proxySrc.indexOf("const MACHINE_EXACT_ROUTES");
    const setEnd = proxySrc.indexOf("function isMachineSurface");
    expect(setStart).toBeGreaterThan(-1);
    expect(setEnd).toBeGreaterThan(setStart);
    const setBlock = proxySrc.slice(setStart, setEnd);
    const exactRoutes = [...setBlock.matchAll(/"(\/api\/v1\/[^"]+)"/g)].map(
      (m) => m[1] as string
    );
    expect(exactRoutes.length).toBe(10);
    for (const route of exactRoutes) {
      const occurrences = proxySrc.split(`"${route}"`).length - 1;
      expect(occurrences).toBe(1);
    }
  });

  test("REGISTRATION SCAN: every service-authenticated route is on the machine surface", () => {
    // Derive the exact set from the SOURCE (not an import — proxy.ts is
    // edge middleware; the scan must not pull its module graph).
    const setBlock = proxySrc.slice(
      proxySrc.indexOf("const MACHINE_EXACT_ROUTES"),
      proxySrc.indexOf("function isMachineSurface")
    );
    const exactRoutes = new Set(
      [...setBlock.matchAll(/"(\/api\/v1\/[^"]+)"/g)].map((m) => m[1] as string)
    );

    // Walk the handler tree for service-principal authentication call sites.
    const apiDir = join(REPO_ROOT, "src/app/api");
    const files = readdirSync(apiDir, { recursive: true }).map(String).filter(
      (f) => f.endsWith("route.ts")
    );
    const serviceRoutes: string[] = [];
    for (const file of files) {
      const src = readFileSync(join(apiDir, file), "utf8");
      if (
        src.includes("authenticateServiceRequest(") ||
        src.includes("requireServiceOrPermission(")
      ) {
        // readdirSync paths are relative to src/app/api — e.g.
        // "v1/worker/tick/route.ts" → "/api/v1/worker/tick".
        serviceRoutes.push(("/api/" + file).replace(/\/route\.ts$/, ""));
      }
    }

    // The scan must not silently no-op to green: the known surface is 21
    // routes (11 under the worker prefix + 10 exact — the wave-4 census).
    expect(serviceRoutes.length).toBeGreaterThanOrEqual(21);

    for (const route of serviceRoutes) {
      const covered =
        route.startsWith("/api/v1/worker/") || exactRoutes.has(route);
      expect(covered).toBe(true);
    }
  });
});

/* ── 2. MFA fail-closed lifecycle (P3 fixes, agent 5-a) ───────────────── */

describe("wave5: MFA confirm fail-closed lifecycle", () => {
  test("confirm is gated when FAYANMS_MFA_MODE=disabled", async () => {
    const user = await ensureFixtureUser(
      `${FIXTURE_PREFIX}mode@faya.local`,
      "operator"
    );
    await beginMfaEnrollment(user); // pending row exists — the knob still gates
    process.env.FAYANMS_MFA_MODE = "disabled";
    resetMfaModeForTests();
    try {
      await expect(confirmMfaEnrollment(user, "123456")).rejects.toMatchObject({
        code: "MFA_DISABLED",
      });
      const row = await db.userMfa.findUnique({ where: { userId: user.id } });
      expect(row?.enabled).toBe(false);
    } finally {
      delete process.env.FAYANMS_MFA_MODE;
      resetMfaModeForTests();
    }
  });

  test("negative state machine: MFA_NOT_ENROLLED then MFA_ALREADY_ENABLED 409", async () => {
    const user = await ensureFixtureUser(
      `${FIXTURE_PREFIX}state@faya.local`,
      "operator"
    );
    // No row at all → MFA_NOT_ENROLLED.
    await expect(confirmMfaEnrollment(user, "123456")).rejects.toMatchObject({
      code: "MFA_NOT_ENROLLED",
    });

    // Enabled row → MFA_ALREADY_ENABLED with HTTP 409 (before any code math).
    await beginMfaEnrollment(user);
    await db.userMfa.update({
      where: { userId: user.id },
      data: { enabled: true },
    });
    try {
      await expect(confirmMfaEnrollment(user, "123456")).rejects.toMatchObject({
        code: "MFA_ALREADY_ENABLED",
        status: 409,
      });
    } finally {
      await db.userMfa.deleteMany({ where: { userId: user.id } });
    }
  });

  test("TOCTOU: two concurrent confirms — exactly one wins, codes stay valid", async () => {
    const user = await ensureFixtureUser(
      `${FIXTURE_PREFIX}race@faya.local`,
      "operator"
    );
    const { secret } = await beginMfaEnrollment(user);
    const nowS = Math.floor(Date.now() / 1000);
    // Two DISTINCT valid codes (current step and the previous step — both
    // inside the ±1 acceptance window) so neither fails verification.
    const codeA = totpCodeAt(secret, nowS);
    const codeB = totpCodeAt(secret, nowS - TOTP_STEP_SECONDS);

    const results = await Promise.allSettled([
      confirmMfaEnrollment(user, codeA),
      confirmMfaEnrollment(user, codeB),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r) => r.status === "rejected"
    ) as PromiseRejectedResult[];

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    // The loser answered MFA_ALREADY_ENABLED — its locally generated codes
    // were never returned (the conditional claim aborted its transaction).
    expect((rejected[0]!.reason as MfaError).code).toBe("MFA_ALREADY_ENABLED");

    const row = await db.userMfa.findUnique({ where: { userId: user.id } });
    expect(row?.enabled).toBe(true);
    // Exactly ONE recovery-code set exists (10 rows) for the ONE winner.
    expect(
      await db.userMfaRecoveryCode.count({
        where: { mfa: { userId: user.id } },
      })
    ).toBe(10);

    await db.userMfa.deleteMany({ where: { userId: user.id } });
  });

  test("failed confirm code is audited MFA_CONFIRM_FAILED", async () => {
    const user = await ensureFixtureUser(
      `${FIXTURE_PREFIX}cfailla@faya.local`,
      "operator"
    );
    await beginMfaEnrollment(user);
    await expect(confirmMfaEnrollment(user, "000000")).rejects.toMatchObject({
      code: "MFA_CODE_INVALID",
    });
    const audit = await db.auditEvent.findFirst({
      where: {
        actorId: user.id,
        action: "MFA_CONFIRM_FAILED",
        result: "FAILURE",
      },
    });
    expect(audit).not.toBeNull();
    await db.userMfa.deleteMany({ where: { userId: user.id } });
  });

  test("failed disable password re-entry is audited MFA_DISABLE_FAILED", async () => {
    const user = await ensureFixtureUser(
      `${FIXTURE_PREFIX}dfaill@faya.local`,
      "operator",
      OPERATOR_PASSWORD
    );
    await beginMfaEnrollment(user);
    await db.userMfa.update({
      where: { userId: user.id },
      data: { enabled: true },
    });
    await expect(
      disableMfa(user, "not-the-password", "123456")
    ).rejects.toMatchObject({ code: "MFA_PASSWORD_INVALID" });
    const audit = await db.auditEvent.findFirst({
      where: {
        actorId: user.id,
        action: "MFA_DISABLE_FAILED",
        result: "FAILURE",
      },
    });
    expect(audit).not.toBeNull();
    // The enrollment survives the failed disable (fail-tight).
    expect(
      (await db.userMfa.findUnique({ where: { userId: user.id } }))?.enabled
    ).toBe(true);
    await db.userMfa.deleteMany({ where: { userId: user.id } });
  });

  test("disable via RECOVERY CODE works (fallback branch)", async () => {
    const user = await ensureFixtureUser(
      `${FIXTURE_PREFIX}recdis@faya.local`,
      "operator",
      OPERATOR_PASSWORD
    );
    const { secret } = await beginMfaEnrollment(user);
    const { recoveryCodes } = await confirmMfaEnrollment(
      user,
      totpCodeAt(secret, Math.floor(Date.now() / 1000))
    );
    expect(recoveryCodes.length).toBe(10);
    await disableMfa(user, OPERATOR_PASSWORD, recoveryCodes[0]);
    expect(
      await db.userMfa.findUnique({ where: { userId: user.id } })
    ).toBeNull();
    const used = await db.auditEvent.findFirst({
      where: { actorId: user.id, action: "MFA_RECOVERY_USED" },
    });
    expect(used).not.toBeNull();
  });
});

/* ── 3. MFA verification budget (P2, agent 5-a) ───────────────────────── */

describe("wave5: MFA guessing feeds the sign-in account budget", () => {
  test("LIVE HANDLER PIN: repeated wrong confirm codes exhaust the account budget → 429", async () => {
    const user = await ensureFixtureUser(
      `${FIXTURE_PREFIX}budget@faya.local`,
      "operator"
    );
    await beginMfaEnrollment(user);
    const cookie = await sessionCookieFor({
      id: user.id,
      email: user.email,
      role: "operator",
    });
    const mod = await import("../../src/app/api/v1/me/mfa/confirm/route");

    // The account budget in this suite is 5 (FAYANMS_LOGIN_MAX_ATTEMPTS_
    // PER_ACCOUNT=5, set in beforeAll). The first 5 wrong codes answer the
    // typed MFA_CODE_INVALID 400 — each one feeding the login guard — and
    // the 6th is refused 429 BEFORE any verification runs. This is the
    // store-agnostic proof: guessing can no longer ride the shared per-IP
    // pool unnoticed.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await mod.POST(
        jsonRequest("http://app.local/api/v1/me/mfa/confirm", "POST", cookie, {
          code: "000000",
        })
      );
      expect(res.status).toBe(400);
      expect(
        ((await res.json()) as { error?: { code?: string } }).error?.code
      ).toBe("MFA_CODE_INVALID");
    }
    const locked = await mod.POST(
      jsonRequest("http://app.local/api/v1/me/mfa/confirm", "POST", cookie, {
        code: "000000",
      })
    );
    expect(locked.status).toBe(429);
    await db.userMfa.deleteMany({ where: { userId: user.id } });
  });

  test("LIVE HANDLER PIN: a locked account gets 429 on confirm AND disable", async () => {
    const user = await ensureFixtureUser(
      `${FIXTURE_PREFIX}locked@faya.local`,
      "operator",
      OPERATOR_PASSWORD
    );
    await beginMfaEnrollment(user); // pending row (confirm) — disable needs enabled;
    await db.userMfa.update({
      where: { userId: user.id },
      data: { enabled: true },
    });
    const identity = identityFor(user.email);
    // Prime the account dimension to the configured budget (env = 5).
    for (let i = 0; i < 5; i += 1) {
      await recordLoginFailure(identity);
    }
    const allowed = await checkLoginAllowed(identity);
    expect(allowed.allowed).toBe(false);

    const cookie = await sessionCookieFor({
      id: user.id,
      email: user.email,
      role: "operator",
    });
    const confirmMod = await import(
      "../../src/app/api/v1/me/mfa/confirm/route"
    );
    const confirmRes = await confirmMod.POST(
      jsonRequest("http://app.local/api/v1/me/mfa/confirm", "POST", cookie, {
        code: "123456",
      })
    );
    expect(confirmRes.status).toBe(429);

    const disableMod = await import("../../src/app/api/v1/me/mfa/route");
    const disableRes = await disableMod.DELETE(
      jsonRequest("http://app.local/api/v1/me/mfa", "DELETE", cookie, {
        password: OPERATOR_PASSWORD,
        code: "123456",
      })
    );
    expect(disableRes.status).toBe(429);

    await db.userMfa.deleteMany({ where: { userId: user.id } });
  });
});

/* ── 4. site-scope size bound (P3, agent 5-b) ─────────────────────────── */

describe("wave5: site-scope parser is size-bounded and fail-closed", () => {
  test("SITE_SCOPE_MAX_CODES is the admin write surface's bound", () => {
    expect(SITE_SCOPE_MAX_CODES).toBe(32);
  });

  test("an oversized scope list is MALFORMED → deny-all, never truncated", () => {
    const codes = Array.from({ length: SITE_SCOPE_MAX_CODES + 1 }, (_, i) =>
      `site-${String(i).padStart(3, "0")}`
    );
    expect(normalizeSiteScopeCodes(codes)).toBeNull();
    // The denial flows through both consumers:
    expect(sessionSiteScope({ sites: codes })).toEqual({
      mode: "sites",
      codes: [],
    });
    expect(
      userSiteScopeClaim(JSON.stringify(codes))
    ).toEqual([]); // minted claim is deny-all, not unbounded
  });

  test("exactly SITE_SCOPE_MAX_CODES distinct codes still validates", () => {
    const codes = Array.from({ length: SITE_SCOPE_MAX_CODES }, (_, i) =>
      `site-${String(i).padStart(3, "0")}`
    );
    expect(normalizeSiteScopeCodes(codes)).toEqual(codes);
  });

  test("Set-based dedup preserves first-occurrence order (parity with the old includes loop)", () => {
    expect(normalizeSiteScopeCodes(["b", "a", "b", "c", "a"])).toEqual([
      "b",
      "a",
      "c",
    ]);
  });
});

/* ── 5. HIBP empty-200 fails closed (P3, agent 5-c) ───────────────────── */

describe("wave5: HIBP empty 200 body is unavailable, not clean", () => {
  test("an empty 200 body throws HibpCheckUnavailableError", async () => {
    await expect(
      queryPwnedPasswordRange("wave5-empty-body-probe", {
        fetchImpl: (async (
          _input: RequestInfo | URL,
          _init?: RequestInit
        ) => new Response("", { status: 200 })) as typeof fetch,
      })
    ).rejects.toBeInstanceOf(HibpCheckUnavailableError);
  });

  test("a whitespace-only 200 body is equally unavailable", async () => {
    await expect(
      queryPwnedPasswordRange("wave5-ws-body-probe", {
        fetchImpl: (async (
          _input: RequestInfo | URL,
          _init?: RequestInit
        ) => new Response("\n  \n", { status: 200 })) as typeof fetch,
      })
    ).rejects.toBeInstanceOf(HibpCheckUnavailableError);
  });

  test("a NORMAL non-empty body without the suffix still proves absence", async () => {
    // The common not-breached path must NOT regress into unavailability.
    // One conforming 35-hex line that does NOT match the candidate.
    const body = `"${"0".repeat(34)}A":5\n`.replace(/"/g, "");
    const result = await queryPwnedPasswordRange("wave5-clean-probe", {
      fetchImpl: (async (
        _input: RequestInfo | URL,
        _init?: RequestInit
      ) => new Response(body, { status: 200 })) as typeof fetch,
    });
    expect(result.breached).toBe(false);
    expect(result.occurrences).toBe(0);
  });
});

/* ── 6. retention candidate guards (P3, agent 5-c) ────────────────────── */

describe("wave5: ops-retention deleteMany candidate guards are source-pinned", () => {
  const retentionSrc = read("src/lib/ops/retention.ts");

  test("JobExecution: the terminal+age guard rides BOTH the scan and the delete", () => {
    // findMany (candidate selection) AND deleteMany (CAS-spirit re-check).
    const guards = retentionSrc.match(
      /status: \{ in: TERMINAL_JOB_EXECUTION_STATUSES \}/g
    );
    expect((guards ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test("Notification: readAt < cutoff guards BOTH the scan and the delete", () => {
    // SQL three-valued logic keeps unread rows out of both statements.
    const guards = retentionSrc.match(/readAt: \{ lt: cutoff \}/g);
    expect((guards ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test("DiscoveryObservation: observedAt < cutoff guards BOTH the scan and the delete", () => {
    const guards = retentionSrc.match(/observedAt: \{ lt: cutoff \}/g);
    expect((guards ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test("AuditEvent is never swept (append-only chain, RT-012/RT-013)", () => {
    expect(retentionSrc).not.toContain("auditEvent.deleteMany");
  });
});

/* ── 7. recovery-code composite unique (P3, agent 5-a) ────────────────── */

describe("wave5: UserMfaRecoveryCode composite unique index", () => {
  test("schema: @@unique([mfaId, codeHash]) on the recovery block", () => {
    const schema = read("prisma/schema.prisma");
    const block = schema.slice(schema.indexOf("model UserMfaRecoveryCode"));
    expect(block).toContain("@@unique([mfaId, codeHash])");
  });

  test("migration: the committed SQL is additive with the canonical index name", () => {
    const migration = read(
      "prisma/migrations/20261004081500_add_user_mfa_recovery_code_unique/migration.sql"
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "UserMfaRecoveryCode_mfaId_codeHash_key"'
    );
    expect(migration).not.toMatch(/DROP TABLE|DROP COLUMN|ALTER COLUMN/i);
  });

  test("the index exists on the live database", async () => {
    const rows = (await db.$queryRaw`SELECT indexname FROM pg_indexes WHERE tablename = 'UserMfaRecoveryCode'`) as Array<{
      indexname: string;
    }>;
    expect(
      rows.some((r) => r.indexname === "UserMfaRecoveryCode_mfaId_codeHash_key")
    ).toBe(true);
  });
});
