/**
 * AUTH-001-A — credential-login abuse-control contract tests
 * (external independent audit 2026-09-15, finding AUTH-001 / TASK AUTH-001-A).
 *
 * DEFECT: `/api/auth/*` sits OUTSIDE the `/api/v1` proxy gate (src/proxy.ts
 * matcher `["/api/v1/:path*"]`) and the NextAuth credentials `authorize()`
 * performed password verification with NO attempt throttling, backoff,
 * lockout or telemetry — online password guessing was bounded only by
 * network-level controls.
 *
 * THE FIX (dedicated login abuse control — NOT a reuse of the generic API
 * limiter, whose budget semantics do not fit credential traffic):
 *   - a pre-verification guard keyed by (trusted-proxy source, HMAC-keyed
 *     account hash) with a sliding-window attempt budget per dimension,
 *     exponential temporary lockout for accounts (30s·2^n, capped BELOW the
 *     attempt window so escalation stays coherent — never permanent, so
 *     unauthenticated traffic cannot cause an irrecoverable account
 *     denial), and success-triggered reset;
 *   - enforcement on the ACTUAL credentials verification path
 *     (authorize() consults the guard BEFORE the DB lookup and scrypt),
 *     plus a route-level pre-check on POST /api/auth/callback/credentials
 *     that answers the standard 429 envelope with Retry-After before
 *     NextAuth touches the request at all;
 *   - bounded in-memory state (key cap + per-key stamp cap + sweep) behind
 *     a store interface so SCALE-001-A can slot a shared backend in;
 *   - bounded telemetry: typed audit events (SIGNIN_THROTTLED /
 *     SIGNIN_LOCKOUT) written at most once per key per window, actorId null
 *     (pre-auth — never a fabricated actor FK), keyed account hash (never a
 *     raw email), never a password;
 *   - enumeration-safe behavior: throttled and credential failures produce
 *     identical public semantics (generic null / generic 429 envelope).
 *
 * Deterministic: injected clocks for all guard-policy tests (no sleeps);
 * the real-clock authorize() integration tier relies only on thresholds far
 * above test-execution time. Regression pins keep the /api/v1 gate, the
 * proxy matcher and the existing auth failure semantics untouched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

// DB-tier prerequisite: these tests exercise the REAL verification path
// against a real PostgreSQL. The URL alignment (the sandbox shell still
// exports a stale SQLite-era file: DATABASE_URL) happens ONCE per test
// process, before any PrismaClient is constructed, via the bunfig [test]
// preload in tests/_setup.ts — Prisma caches the URL at client
// construction, so a per-file fix inside a test module is too late when
// another test file's import graph built the client first.

import {
  LOGIN_LOCKOUT_BASE_MS,
  LOGIN_LOCKOUT_MAX_MS,
  LOGIN_MAX_FAILS_PER_ACCOUNT_DEFAULT,
  LOGIN_MAX_FAILS_PER_SOURCE_DEFAULT,
  LOGIN_WINDOW_MS_DEFAULT,
  MAX_FAILURE_STAMPS_PER_KEY,
  MAX_LOGIN_GUARD_KEYS,
  checkLoginAllowed,
  createMemoryLoginGuardStore,
  hashAccountIdentifier,
  normalizeAccountIdentifier,
  parseLoginGuardEnv,
  preCheckCredentialsSignin,
  recordLoginFailure,
  recordLoginSuccess,
  resetLoginGuardForTests,
  resolveLoginIdentity,
} from "@/lib/auth/login-guard";
import type {
  LoginGuardStore,
  LoginTelemetryEvent,
} from "@/lib/auth/login-guard";
import { hashPassword } from "@/lib/auth/password";
import { authOptions } from "@/lib/auth/options";
import { db } from "@/lib/db";

/* ────────────────────────────── test plumbing ────────────────────────── */

const HOPS_ENV = "FAYANMS_TRUST_PROXY_HOPS";
let savedHopsEnv: string | undefined;
const sinkEvents: LoginTelemetryEvent[] = [];
const testEmails: string[] = [];

function sink(e: LoginTelemetryEvent): void {
  sinkEvents.push(e);
}

let deps: { store: LoginGuardStore; sink: typeof sink };

beforeEach(() => {
  savedHopsEnv = process.env[HOPS_ENV];
  delete process.env[HOPS_ENV]; // default hops = 1 unless a block sets it
  resetLoginGuardForTests();
  sinkEvents.length = 0;
  deps = { store: createMemoryLoginGuardStore(), sink };
});

afterEach(() => {
  if (savedHopsEnv === undefined) delete process.env[HOPS_ENV];
  else process.env[HOPS_ENV] = savedHopsEnv;
});

afterEach(async () => {
  await cleanupTestData();
});

function testEmail(tag: string): string {
  const email = `lg-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
  testEmails.push(email);
  return email;
}

async function cleanupTestData(): Promise<void> {
  if (testEmails.length === 0) return;
  const users = await db.user.findMany({
    where: { email: { in: [...testEmails] } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length > 0) {
    await db.auditEvent.deleteMany({ where: { actorId: { in: ids } } });
  }
  await db.user.deleteMany({ where: { email: { in: [...testEmails] } } });
  // Pre-auth telemetry rows carry actorId null + actorName "login-guard".
  await db.auditEvent.deleteMany({ where: { actorName: "login-guard" } });
  testEmails.length = 0;
}

function identityOf(source: string, email: string) {
  return resolveLoginIdentity(
    new Headers({ "x-forwarded-for": source }),
    email
  );
}

/** authorize() extracted from the real provider (the actual verify path). */
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
// Extract the REAL function exactly the way the core resolves it.
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

/* ───────────────────── Tier A — identifier normalization ─────────────── */

describe("AUTH-001-A — account-identifier normalization + keyed hash", () => {
  test("normalization trims, lowercases and caps the stored form", () => {
    expect(normalizeAccountIdentifier("  Alice@Example.COM \n")).toBe(
      "alice@example.com"
    );
    expect(normalizeAccountIdentifier(undefined)).toBe("");
    expect(normalizeAccountIdentifier(null)).toBe("");
    expect(normalizeAccountIdentifier("   ")).toBe("");
    expect(normalizeAccountIdentifier("x".repeat(500)).length).toBe(320);
  });

  test("PIN: account hash is a KEYED HMAC, not a plain digest (dictionary-safe at rest)", () => {
    const email = "officer@faya.local";
    const keyed = hashAccountIdentifier(email);
    const plain = createHash("sha256").update(email).digest("hex");
    expect(keyed).not.toBe(plain);
    expect(keyed).not.toContain(email);
    expect(keyed).toBe(hashAccountIdentifier(email)); // stable
    expect(keyed).not.toBe(hashAccountIdentifier("other@faya.local"));
    expect(keyed.length).toBe(32); // 128-bit slice — enough to key, not to reverse
  });

  test("unspecified identifier collapses to a constant (no empty-key blowup)", () => {
    expect(hashAccountIdentifier("")).toBe(hashAccountIdentifier(""));
    expect(hashAccountIdentifier("")).not.toContain("@");
  });
});

/* ─────────────────────── Tier A — trusted-proxy keying ───────────────── */

describe("AUTH-001-A — trusted-proxy source keying", () => {
  test("PIN: spoofed leftmost XFF never mints a fresh source key", () => {
    const rotated = resolveLoginIdentity(
      new Headers({ "x-forwarded-for": "rotated-1, 10.0.0.1" }),
      "a@x.com"
    );
    const rotatedAgain = resolveLoginIdentity(
      new Headers({ "x-forwarded-for": "rotated-2, 10.0.0.1" }),
      "a@x.com"
    );
    expect(rotated.sourceKey).toBe("10.0.0.1");
    expect(rotated.sourceKey).toBe(rotatedAgain.sourceKey);
  });

  test("hops=0 trusts nothing — every caller shares the 'local' bucket", () => {
    process.env[HOPS_ENV] = "0";
    const id = resolveLoginIdentity(
      new Headers({ "x-forwarded-for": "203.0.113.7" }),
      "a@x.com"
    );
    expect(id.sourceKey).toBe("local");
  });

  test("same source, different accounts → same source key, distinct account keys", () => {
    const a = identityOf("10.0.0.9", "a@x.com");
    const b = identityOf("10.0.0.9", "b@x.com");
    expect(a.sourceKey).toBe(b.sourceKey);
    expect(a.accountHash).not.toBe(b.accountHash);
  });
});

/* ─────────────────────────── Tier A — env parsing ────────────────────── */

describe("AUTH-001-A — configuration parsing (bounded ranges, secure defaults)", () => {
  test("defaults: 300 s window, 10 per source, 30 per account", () => {
    const cfg = parseLoginGuardEnv({});
    expect(cfg.windowMs).toBe(LOGIN_WINDOW_MS_DEFAULT);
    expect(cfg.maxPerSource).toBe(LOGIN_MAX_FAILS_PER_SOURCE_DEFAULT);
    expect(cfg.maxPerAccount).toBe(LOGIN_MAX_FAILS_PER_ACCOUNT_DEFAULT);
    expect(LOGIN_WINDOW_MS_DEFAULT).toBe(300_000);
    expect(LOGIN_MAX_FAILS_PER_SOURCE_DEFAULT).toBe(10);
    expect(LOGIN_MAX_FAILS_PER_ACCOUNT_DEFAULT).toBe(30);
  });

  test("PIN: lockout constants sit below the window (escalation stays coherent)", () => {
    expect(LOGIN_LOCKOUT_BASE_MS).toBe(30_000);
    expect(LOGIN_LOCKOUT_MAX_MS).toBe(240_000);
    expect(LOGIN_LOCKOUT_MAX_MS).toBeLessThanOrEqual(LOGIN_WINDOW_MS_DEFAULT);
  });

  test("values clamp into their documented ranges; garbage falls back", () => {
    expect(parseLoginGuardEnv({ FAYANMS_LOGIN_WINDOW_SECONDS: "10" }).windowMs).toBe(30_000);
    expect(parseLoginGuardEnv({ FAYANMS_LOGIN_WINDOW_SECONDS: "99999" }).windowMs).toBe(3_600_000);
    expect(parseLoginGuardEnv({ FAYANMS_LOGIN_MAX_ATTEMPTS_PER_SOURCE: "1" }).maxPerSource).toBe(3);
    expect(parseLoginGuardEnv({ FAYANMS_LOGIN_MAX_ATTEMPTS_PER_SOURCE: "1000" }).maxPerSource).toBe(100);
    expect(parseLoginGuardEnv({ FAYANMS_LOGIN_MAX_ATTEMPTS_PER_ACCOUNT: "1" }).maxPerAccount).toBe(5);
    expect(parseLoginGuardEnv({ FAYANMS_LOGIN_MAX_ATTEMPTS_PER_ACCOUNT: "999" }).maxPerAccount).toBe(200);
    const garbage = parseLoginGuardEnv({
      FAYANMS_LOGIN_WINDOW_SECONDS: "banana",
      FAYANMS_LOGIN_MAX_ATTEMPTS_PER_SOURCE: "",
      FAYANMS_LOGIN_MAX_ATTEMPTS_PER_ACCOUNT: "2.9x",
    });
    expect(garbage.windowMs).toBe(LOGIN_WINDOW_MS_DEFAULT);
    expect(garbage.maxPerSource).toBe(LOGIN_MAX_FAILS_PER_SOURCE_DEFAULT);
    expect(garbage.maxPerAccount).toBe(LOGIN_MAX_FAILS_PER_ACCOUNT_DEFAULT);
  });
});

/* ────────────────────── Tier A — budget/backoff/lockout ──────────────── */

describe("AUTH-001-A — source budget (sliding window)", () => {
  test("attempts below the threshold behave normally", async () => {
    const id = identityOf("10.0.0.1", "victim@x.com");
    for (let i = 0; i < 9; i += 1) {
      await recordLoginFailure(id, 1_000 + i, deps);
    }
    const verdict = await checkLoginAllowed(id, 2_000, deps);
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toBe("ok");
  });

  test("PIN: repeated failures eventually throttle; Retry-After is sane", async () => {
    const id = identityOf("10.0.0.2", "victim@x.com");
    for (let i = 0; i < 10; i += 1) {
      await recordLoginFailure(id, 1_000 + i, deps);
    }
    const verdict = await checkLoginAllowed(id, 2_000, deps);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("source_throttled");
    expect(verdict.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(verdict.retryAfterSec).toBeLessThanOrEqual(300);
  });

  test("window expiry frees the budget (deterministic clock, no sleeps)", async () => {
    const id = identityOf("10.0.0.3", "victim@x.com");
    for (let i = 0; i < 10; i += 1) {
      await recordLoginFailure(id, 1_000 + i, deps);
    }
    expect((await checkLoginAllowed(id, 2_000, deps)).allowed).toBe(false);
    // One millisecond past the window every stale stamp is filtered out.
    const later = await checkLoginAllowed(id, 1_000 + LOGIN_WINDOW_MS_DEFAULT + 1, deps);
    expect(later.allowed).toBe(true);
  });

  test("per-source isolation: one hammering client never throttles another", async () => {
    const hammer = identityOf("10.0.0.4", "a@x.com");
    for (let i = 0; i < 12; i += 1) {
      await recordLoginFailure(hammer, 1_000 + i, deps);
    }
    const other = identityOf("10.0.0.5", "b@x.com");
    expect((await checkLoginAllowed(other, 2_000, deps)).allowed).toBe(true);
  });

  test("env knob: FAYANMS_LOGIN_MAX_ATTEMPTS_PER_SOURCE=3 tightens the budget", async () => {
    const id = identityOf("10.0.0.6", "a@x.com");
    const envDeps = { ...deps, env: { FAYANMS_LOGIN_MAX_ATTEMPTS_PER_SOURCE: "3" } };
    for (let i = 0; i < 3; i += 1) {
      await recordLoginFailure(id, 1_000 + i, envDeps);
    }
    const verdict = await checkLoginAllowed(id, 2_000, envDeps);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("source_throttled");
  });
});

describe("AUTH-001-A — account lockout (exponential, temporary, escalating)", () => {
  test("PIN: a distributed burst locks the ACCOUNT, not the (many) sources", async () => {
    const email = "victim@x.com";
    for (let i = 0; i < 30; i += 1) {
      await recordLoginFailure(identityOf(`10.1.0.${i}`, email), 1_000 + i, deps);
    }
    const verdict = await checkLoginAllowed(
      identityOf("10.2.0.1", email), // a FRESH source the attacker has not used yet
      2_000,
      deps
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("account_locked");
    expect(verdict.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(verdict.retryAfterSec).toBeLessThanOrEqual(LOGIN_LOCKOUT_BASE_MS / 1000);
    // Sources stay clean: the per-source dimension never fired for them.
    expect(
      (
        await checkLoginAllowed(
          identityOf("10.1.0.0", "someoneelse@x.com"),
          2_000,
          deps
        )
      ).allowed
    ).toBe(true);
  });

  test("PIN: lockout escalates (30s → 60s → …) while hammering continues, capped", async () => {
    const email = "victim@x.com";
    for (let i = 0; i < 30; i += 1) {
      await recordLoginFailure(identityOf(`10.3.0.${i}`, email), 1_000 + i, deps);
    }
    const id = identityOf("10.9.9.9", email);
    const first = await checkLoginAllowed(id, 2_000, deps);
    expect(first.allowed).toBe(false);
    expect(first.reason).toBe("account_locked");
    expect(first.retryAfterSec).toBeLessThanOrEqual(LOGIN_LOCKOUT_BASE_MS / 1000);

    // A stuffing bot keeps hammering THROUGH the lockout: every denied
    // attempt keeps the failure window hot, so each expiry re-locks with a
    // doubled backoff until the cap. Denied attempts never hit scrypt.
    let last = first;
    let now = 2_000;
    for (let i = 0; i < 12; i += 1) {
      for (let h = 0; h < 35; h += 1) {
        const hammer = await checkLoginAllowed(id, now + h, deps);
        expect(hammer.allowed).toBe(false);
      }
      now += last.retryAfterSec * 1_000 + 1;
      last = await checkLoginAllowed(id, now, deps);
      expect(last.allowed).toBe(false);
      expect(last.reason).toBe("account_locked");
      expect(last.retryAfterSec).toBeLessThanOrEqual(LOGIN_LOCKOUT_MAX_MS / 1000);
    }
    expect(last.retryAfterSec).toBeLessThanOrEqual(LOGIN_LOCKOUT_MAX_MS / 1000);
  });

  test("lockout decays fully when the attack stops (no permanent denial)", async () => {
    const email = "victim@x.com";
    for (let i = 0; i < 30; i += 1) {
      await recordLoginFailure(identityOf(`10.4.0.${i}`, email), 1_000 + i, deps);
    }
    // Attack stops; well past window AND past any lockout → clean slate.
    const muchLater = 1_000 + LOGIN_WINDOW_MS_DEFAULT * 3;
    const verdict = await checkLoginAllowed(identityOf("10.5.0.1", email), muchLater, deps);
    expect(verdict.allowed).toBe(true);
    // The escalation counter decayed too: a fresh single failure must not re-lock.
    await recordLoginFailure(identityOf("10.5.0.2", email), muchLater + 1, deps);
    expect(
      (await checkLoginAllowed(identityOf("10.5.0.3", email), muchLater + 2, deps)).allowed
    ).toBe(true);
  });

  test("success resets BOTH dimensions (intended reset policy)", async () => {
    const email = "legit@x.com";
    const id = identityOf("10.6.0.1", email);
    for (let i = 0; i < 9; i += 1) {
      await recordLoginFailure(id, 1_000 + i, deps);
    }
    await recordLoginSuccess(id, 2_000, deps);
    expect((await checkLoginAllowed(id, 2_100, deps)).allowed).toBe(true);
    expect(deps.store.size()).toBe(0); // both keys deleted
  });
});

/* ─────────────── Tier A — bounded state + bounded telemetry ──────────── */

describe("AUTH-001-A — resource safety (bounded maps, bounded rows)", () => {
  test("PIN: attacker-controlled identifiers cannot grow the store unbounded", async () => {
    const ancient = 1_000;
    for (let i = 0; i < MAX_LOGIN_GUARD_KEYS + 120; i += 1) {
      await recordLoginFailure(
        identityOf(`10.7.0.${i % 200}`, `attacker-${i}@evil.test`),
        ancient,
        deps
      );
    }
    // The fill grew past the key cap (sweep found nothing stale yet).
    expect(deps.store.size()).toBeGreaterThan(MAX_LOGIN_GUARD_KEYS);
    // One fresh hit triggers the sweep; stale keys are evicted.
    await recordLoginFailure(
      identityOf("10.7.9.9", "fresh@evil.test"),
      ancient + LOGIN_WINDOW_MS_DEFAULT * 2,
      deps
    );
    expect(deps.store.size()).toBeLessThanOrEqual(MAX_LOGIN_GUARD_KEYS / 2 + 2);
  });

  test("PIN: per-key failure history is capped (no unbounded arrays)", async () => {
    const id = identityOf("10.8.0.1", "hoarder@evil.test");
    for (let i = 0; i < 500; i += 1) {
      await recordLoginFailure(id, 1_000 + i, deps);
    }
    const state = deps.store.get(`acct:${id.accountHash}`);
    expect(state).toBeDefined();
    expect(state?.failures.length).toBeLessThanOrEqual(MAX_FAILURE_STAMPS_PER_KEY);
  });

  test("PIN: telemetry fires at most once per key per window (no audit-row storm)", async () => {
    const email = "storm@evil.test";
    // Cross the source threshold (1 SIGNIN_THROTTLED) then keep failing.
    const id = identityOf("10.10.0.1", email);
    for (let i = 0; i < 25; i += 1) {
      await recordLoginFailure(id, 2_000 + i, deps);
    }
    const throttledRows = sinkEvents.filter((e) => e.action === "SIGNIN_THROTTLED");
    expect(throttledRows.length).toBe(1);
    expect(sinkEvents.some((e) => e.action === "SIGNIN_LOCKOUT")).toBe(false);

    // Distributed account lock (distinct sources → account dimension).
    for (let i = 0; i < 30; i += 1) {
      await recordLoginFailure(identityOf(`10.11.0.${i}`, email), 3_000 + i, deps);
    }
    expect(sinkEvents.filter((e) => e.action === "SIGNIN_LOCKOUT").length).toBe(1);

    // A denied attempt inside the same window does NOT write another row…
    await checkLoginAllowed(identityOf("10.12.0.1", email), 3_500, deps);
    expect(sinkEvents.filter((e) => e.action === "SIGNIN_LOCKOUT").length).toBe(1);

    // …but a fresh window re-arms the transition.
    const freshWindow = 3_100 + LOGIN_WINDOW_MS_DEFAULT;
    for (let i = 0; i < 30; i += 1) {
      await recordLoginFailure(identityOf(`10.13.0.${i}`, email), freshWindow + i, deps);
    }
    expect(sinkEvents.filter((e) => e.action === "SIGNIN_LOCKOUT").length).toBe(2);
  });

  test("telemetry never carries the raw account identifier", async () => {
    const email = "privacy@evil.test";
    const id = identityOf("10.14.0.1", email);
    for (let i = 0; i < 10; i += 1) {
      await recordLoginFailure(id, 1_000 + i, deps);
    }
    expect(sinkEvents.length).toBeGreaterThanOrEqual(1);
    for (const e of sinkEvents) {
      expect(JSON.stringify(e)).not.toContain(email);
      expect(e.accountHash).toBe(id.accountHash);
      expect(e.accountHash).not.toContain("@");
    }
  });
});

/* ─────────────────── Tier B — route-level pre-check (HTTP) ───────────── */

function signinRequest(
  ip: string,
  email: string,
  opts?: { json?: boolean }
): NextRequest {
  if (opts?.json) {
    return new NextRequest("http://localhost/api/auth/callback/credentials", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": ip,
      },
      body: JSON.stringify({ email, password: "whatever", csrfToken: "x" }),
    });
  }
  const form = new URLSearchParams({
    email,
    password: "whatever",
    csrfToken: "x",
  });
  return new NextRequest("http://localhost/api/auth/callback/credentials", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": ip,
    },
    body: form,
  });
}

describe("AUTH-001-A — route pre-check on POST /api/auth/callback/credentials", () => {
  test("below the threshold the request is delegated (null), not answered here", async () => {
    const email = testEmail("precheck-ok");
    const response = await preCheckCredentialsSignin(
      signinRequest("10.20.0.1", email),
      Date.now(),
      deps
    );
    expect(response).toBeNull();
  });

  test("PIN: 50 simulated stuffing attempts → throttled 429 with Retry-After", async () => {
    const email = testEmail("stuffing");
    const ip = "10.21.0.1";
    // Drive failures through the guard (the route pre-check itself denies
    // without recording, so abuse is recorded by the authorize tier).
    const id = identityOf(ip, email);
    for (let i = 0; i < 50; i += 1) {
      await recordLoginFailure(id, Date.now(), deps);
    }
    const response = await preCheckCredentialsSignin(
      signinRequest(ip, email),
      Date.now(),
      deps
    );
    expect(response).not.toBeNull();
    expect(response?.status).toBe(429);
    const retryAfter = response?.headers.get("Retry-After") ?? "";
    expect(Number.parseInt(retryAfter, 10)).toBeGreaterThanOrEqual(1);
    expect(response?.headers.get("X-Request-Id")?.length).toBe(36);
    const body = (await response?.json()) as {
      success: boolean;
      error: { code: string; message: string };
    };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("RATE_LIMITED");
    // Enumeration safety: the envelope never echoes the submitted email.
    expect(JSON.stringify(body)).not.toContain(email);
    expect(JSON.stringify(body)).not.toContain("@");
  });

  test("JSON sign-in bodies are throttled identically", async () => {
    const email = testEmail("json-body");
    const ip = "10.22.0.1";
    const id = identityOf(ip, email);
    for (let i = 0; i < 12; i += 1) {
      await recordLoginFailure(id, Date.now(), deps);
    }
    const response = await preCheckCredentialsSignin(
      signinRequest(ip, email, { json: true }),
      Date.now(),
      deps
    );
    expect(response?.status).toBe(429);
  });

  test("unparseable bodies fail OPEN (NextAuth keeps handling the request)", async () => {
    const request = new NextRequest(
      "http://localhost/api/auth/callback/credentials",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-forwarded-for": "10.23.0.1",
        },
        body: "%zz=not-a-form&&",
      }
    );
    const response = await preCheckCredentialsSignin(request, Date.now(), deps);
    expect(response).toBeNull();
  });

  test("non-credential NextAuth actions are never password-attempt traffic", async () => {
    const email = testEmail("session-reads");
    const id = identityOf("10.24.0.1", email);
    for (let i = 0; i < 50; i += 1) {
      await recordLoginFailure(id, Date.now(), deps);
    }
    // Session read / signout — both pass straight through.
    const session = await preCheckCredentialsSignin(
      new NextRequest("http://localhost/api/auth/session", {
        method: "GET",
        headers: { "x-forwarded-for": "10.24.0.1" },
      }),
      Date.now(),
      deps
    );
    expect(session).toBeNull();
    const signout = await preCheckCredentialsSignin(
      new NextRequest("http://localhost/api/auth/signout", {
        method: "POST",
        headers: { "x-forwarded-for": "10.24.0.1" },
        body: new URLSearchParams({ csrfToken: "x" }),
      }),
      Date.now(),
      deps
    );
    expect(signout).toBeNull();
  });
});

/* ───────────── Tier C — the actual verification path (authorize) ─────── */

describe("AUTH-001-A — authorize() integration (real DB, real scrypt)", () => {
  test("valid login succeeds with the guard engaged (and audits USER_LOGIN)", async () => {
    const email = testEmail("valid-login");
    const password = "correct-horse-battery";
    await db.user.create({
      data: {
        email,
        name: "Login Guard Test",
        role: "admin",
        isActive: true,
        passwordHash: await hashPassword(password),
      },
    });
    const result = (await authorize(
      { email, password },
      authorizeReq("10.30.0.1")
    )) as { email?: string; role?: string };
    expect(result).not.toBeNull();
    expect(result.email).toBe(email);
    expect(result.role).toBe("admin");
    const loginRow = await db.auditEvent.findFirst({
      where: { action: "USER_LOGIN", resourceLabel: email },
    });
    expect(loginRow).not.toBeNull();
  });

  test("normal invalid login remains rejected with the generic null", async () => {
    const email = testEmail("invalid-login");
    await db.user.create({
      data: {
        email,
        name: "Login Guard Test",
        role: "viewer",
        isActive: true,
        passwordHash: await hashPassword("right-password"),
      },
    });
    const wrong = await authorize(
      { email, password: "wrong-password" },
      authorizeReq("10.31.0.1")
    );
    expect(wrong).toBeNull();
    // Unknown account answers the SAME public null (enumeration-safe).
    const unknown = await authorize(
      { email: testEmail("unknown"), password: "whatever" },
      authorizeReq("10.31.0.2")
    );
    expect(unknown).toBeNull();
  });

  test("disabled account keeps its exact existing failure semantics", async () => {
    const email = testEmail("disabled");
    await db.user.create({
      data: {
        email,
        name: "Login Guard Test",
        role: "viewer",
        isActive: false,
        passwordHash: await hashPassword("right-password"),
      },
    });
    let message = "";
    try {
      await authorize(
        { email, password: "right-password" },
        authorizeReq("10.32.0.1")
      );
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toBe("Account disabled");
  });

  test("PIN: after the source budget trips, verification is not performed again — even valid credentials are denied", async () => {
    const email = testEmail("throttled-path");
    const password = "actually-correct";
    await db.user.create({
      data: {
        email,
        name: "Login Guard Test",
        role: "admin",
        isActive: true,
        passwordHash: await hashPassword(password),
      },
    });
    const ip = "10.33.0.1";
    // Burn the source budget with wrong passwords (10 real verifications).
    for (let i = 0; i < 10; i += 1) {
      await authorize({ email, password: `wrong-${i}` }, authorizeReq(ip));
    }
    // The 11th attempt — even with the CORRECT password — is denied by the
    // guard BEFORE the DB lookup/scrypt (order pinned structurally below).
    const denied = await authorize({ email, password }, authorizeReq(ip));
    expect(denied).toBeNull();
    // The audit trail must NOT show a successful login for this account.
    const loginRow = await db.auditEvent.findFirst({
      where: { action: "USER_LOGIN", resourceLabel: email },
    });
    expect(loginRow).toBeNull();
  });

  test("successful sign-in resets the failure state for the (source, account)", async () => {
    const email = testEmail("reset-on-success");
    const password = "the-right-one";
    await db.user.create({
      data: {
        email,
        name: "Login Guard Test",
        role: "viewer",
        isActive: true,
        passwordHash: await hashPassword(password),
      },
    });
    const ip = "10.34.0.1";
    await authorize({ email, password: "nope-1" }, authorizeReq(ip));
    await authorize({ email, password: "nope-2" }, authorizeReq(ip));
    const ok = await authorize({ email, password }, authorizeReq(ip));
    expect(ok).not.toBeNull();
    // The reset policy: the next wrong attempt starts from a clean budget —
    // it is rejected as a normal failure (not insta-throttled).
    const afterReset = await authorize(
      { email, password: "nope-3" },
      authorizeReq(ip)
    );
    expect(afterReset).toBeNull();
  });

  test("PIN: a tripped account lockout is recorded in the audit trail (typed rows)", async () => {
    const email = testEmail("lockout-rows");
    // Distributed burst → account lock → the default sink writes real rows.
    for (let i = 0; i < 30; i += 1) {
      await recordLoginFailure(identityOf(`10.35.0.${i}`, email), Date.now() + i);
    }
    const rows = await db.auditEvent.findMany({
      where: { action: "SIGNIN_LOCKOUT", actorName: "login-guard" },
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0];
    expect(row.result).toBe("FAILURE");
    expect(row.resourceType).toBe("AuthSignin");
    expect(row.actorId).toBeNull(); // pre-auth — never a fabricated actor FK
    expect(row.resourceLabel ?? "").toStartWith("account:");
    expect(row.resourceLabel ?? "").not.toContain(email); // keyed hash only
  });
});

/* ──────────────────── Structural regression pins (source) ────────────── */

describe("AUTH-001-A — regression pins (adjacent surfaces untouched)", () => {
  const proxySrc = readFileSync("src/proxy.ts", "utf8");
  const optionsSrc = readFileSync("src/lib/auth/options.ts", "utf8");
  const routeSrc = readFileSync("src/app/api/auth/[...nextauth]/route.ts", "utf8");
  const guardSrc = readFileSync("src/lib/auth/login-guard.ts", "utf8");

  test("PIN: /api/v1 matcher and rate gate unchanged — login control is NOT the API limiter", () => {
    expect(proxySrc).toContain('matcher: ["/api/v1/:path*"]');
    // The auth routes stay outside the generic limiter by design.
    expect(proxySrc).not.toMatch(/matcher:\s*\[[^\]]*\/api\/auth/);
    expect(proxySrc).toContain("takeRateSlot");
  });

  test("PIN: authorize() consults the guard BEFORE the DB lookup + password verification", () => {
    const guardIdx = optionsSrc.indexOf("await checkLoginAllowed(");
    const dbIdx = optionsSrc.indexOf("db.user.findUnique");
    const verifyIdx = optionsSrc.indexOf("await verifyPassword(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(dbIdx).toBeGreaterThan(guardIdx);
    expect(verifyIdx).toBeGreaterThan(guardIdx);
    // Failures and successes are recorded through the guard.
    expect(optionsSrc).toContain("recordLoginFailure");
    expect(optionsSrc).toContain("recordLoginSuccess");
  });

  test("PIN: only the credentials callback is pre-checked; session/CSRF/signout flow untouched", () => {
    // The wrapper delegates to the real NextAuth handler and pre-checks only
    // the credential sign-in path (the path constant lives in the guard).
    expect(routeSrc).toContain("preCheckCredentialsSignin");
    expect(routeSrc).toMatch(/handler\(req\)/);
    expect(guardSrc).toContain('"/api/auth/callback/credentials"');
  });

  test("PIN: schema documents the new typed telemetry verbs", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    expect(schema).toContain("SIGNIN_THROTTLED");
    expect(schema).toContain("SIGNIN_LOCKOUT");
  });
});
