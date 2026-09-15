import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { PrismaClient } from "@prisma/client";

import { db } from "../../src/lib/db";
import {
  type AtomicLoginGuardStore,
  type LoginAttemptIdentity,
  type LoginGuardDeps,
  type LoginTelemetryEvent,
  checkLoginAllowed,
  createMemoryLoginGuardStore,
  createPostgresLoginGuardStore,
  hashAccountIdentifier,
  recordLoginFailure,
  recordLoginSuccess,
  resolveLoginGuardStore,
} from "../../src/lib/auth/login-guard";

/**
 * TASK-SCALE-001-B (independent audit 2026-09-15) — distributed backend for
 * the login guard's lockout state; closes the remaining AUTH-001 half.
 *
 * R35 landed the login guard with a per-instance bounded memory store; R38
 * (SCALE-001-A) landed the shared Postgres store for the API rate gate and
 * REFUSED a plain SQL KV for the login plane as a false fix — the guard's
 * read-modify-write lockout state (prune → budget → escalate → upsert/
 * delete) races across instances unless the whole decision serializes on a
 * per-key advisory xact lock inside ONE transaction.
 *
 * Pinned here:
 *   1. the atomic store contract: read-modify-write inside one transaction
 *      (round-trip fidelity, upsert/delete outcomes, defensive state
 *      parsing, parallel mutations never lose updates);
 *   2. the guard contract over the shared store (single instance): budget,
 *      lockout, escalation, decay, success reset, once-per-window telemetry;
 *   3. THE acceptance test: TWO guard clients on SEPARATE Prisma pools —
 *      instance A locks the account, instance B honors the lockout (and
 *      vice versa); a success reset on one instance is visible to the other;
 *      fleet-wide telemetry fires exactly once per window across instances;
 *      12 parallel failures across BOTH instances record 12 stamps with
 *      exactly one lockout escalation (no lost updates, no double flips);
 *   4. failure policy: an unreachable shared store REJECTS the attempt
 *      (fail-closed — the same pinned decision as SCALE-001-A); retention
 *      is server-side (stale rows pruned; active lockouts survive);
 *   5. resolution policy: FAYANMS_RATE_STORE unset/""/"memory" → in-memory
 *      default; "postgres" → the shared store; unknown values refuse.
 */

const WINDOW_MS = 300_000;
const T0 = 1_800_000_000_000;

const KNOBS = {
  FAYANMS_LOGIN_MAX_ATTEMPTS_PER_SOURCE: "100",
  FAYANMS_LOGIN_MAX_ATTEMPTS_PER_ACCOUNT: "10",
} as const;

const ident = (ip: string, email: string): LoginAttemptIdentity => ({
  sourceKey: ip,
  accountHash: hashAccountIdentifier(email),
});

const noSink = (): void => undefined;

function makeDeps(store: unknown, sink: (e: LoginTelemetryEvent) => void = noSink): LoginGuardDeps {
  return { store: store as LoginGuardDeps["store"], env: { ...KNOBS }, sink };
}

describe("SCALE-001-B: atomic store contract (per-key transaction shape)", () => {
  let store: AtomicLoginGuardStore;
  beforeAll(async () => {
    store = createPostgresLoginGuardStore(db as unknown as PrismaClient, { pruneChance: 0 });
    await db.loginGuardState.deleteMany({});
  });
  afterEach(async () => {
    await db.loginGuardState.deleteMany({});
  });
  afterAll(async () => {
    await db.loginGuardState.deleteMany({});
  });

  test("round-trip fidelity: a persisted row is handed to the mutator verbatim", async () => {
    await db.loginGuardState.create({
      data: {
        key: "dist:rt",
        failures: [1000, 2000, 3000],
        lockoutUntil: new Date(5000),
        lockoutCount: 2,
        denialEmittedAt: new Date(4000),
        updatedAt: new Date(6000),
      },
    });
    let seen: unknown = "not-called";
    await store.mutate("dist:rt", (state) => {
      seen = state;
      return { state };
    });
    expect(seen).toEqual({
      failures: [1000, 2000, 3000],
      lockoutUntil: 5000,
      lockoutCount: 2,
      denialEmittedAt: 4000,
    });
  });

  test("absent key → mutator receives undefined; upsert outcome creates the row", async () => {
    let seen: unknown = "not-called";
    await store.mutate("dist:absent", (state) => {
      seen = state;
      return {
        state: {
          failures: [T0],
          lockoutUntil: T0 + 30_000,
          lockoutCount: 1,
          denialEmittedAt: T0,
        },
      };
    });
    expect(seen).toBeUndefined();
    const row = await db.loginGuardState.findUnique({ where: { key: "dist:absent" } });
    expect(row).not.toBeNull();
    expect(row?.failures).toEqual([T0]);
    expect(row?.lockoutCount).toBe(1);
    expect(row?.lockoutUntil.getTime()).toBe(T0 + 30_000);
  });

  test("delete outcome removes the row; no-op outcome leaves it untouched", async () => {
    await db.loginGuardState.create({
      data: { key: "dist:del", failures: [1], lockoutUntil: new Date(0), updatedAt: new Date(1000) },
    });
    await store.mutate("dist:del", () => ({ state: undefined }));
    expect(await db.loginGuardState.findUnique({ where: { key: "dist:del" } })).not.toBeNull();
    await store.mutate("dist:del", () => ({ state: null }));
    expect(await db.loginGuardState.findUnique({ where: { key: "dist:del" } })).toBeNull();
  });

  test("defensive state parsing: garbage stamps are dropped, not trusted", async () => {
    await db.loginGuardState.create({
      data: {
        key: "dist:bad",
        failures: ["x", 7, null, 9.9, Number.POSITIVE_INFINITY] as unknown as number[],
        lockoutUntil: new Date(0),
        updatedAt: new Date(1000),
      },
    });
    let seen: { failures: number[] } | undefined;
    await store.mutate("dist:bad", (state) => {
      seen = state;
      return { state: undefined };
    });
    expect(seen?.failures).toEqual([7, 9]);
  });

  test("parallel mutations on ONE key never lose updates (advisory-lock serialized)", async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        store.mutate(
          "dist:atomic",
          (state) => {
            const base =
              state ?? { failures: [], lockoutUntil: 0, lockoutCount: 0, denialEmittedAt: 0 };
            base.failures.push(T0 + i);
            return { state: base };
          },
          { nowMs: T0, windowMs: WINDOW_MS }
        )
      )
    );
    const row = await db.loginGuardState.findUnique({ where: { key: "dist:atomic" } });
    expect(row?.failures).toHaveLength(12);
  });

  test("distinct keys stay independent", async () => {
    await store.mutate("dist:other", (state) => {
      const base =
        state ?? { failures: [], lockoutUntil: 0, lockoutCount: 0, denialEmittedAt: 0 };
      base.failures.push(T0);
      return { state: base };
    });
    expect(await db.loginGuardState.findUnique({ where: { key: "dist:atomic" } })).toBeNull();
    expect(await db.loginGuardState.findUnique({ where: { key: "dist:other" } })).not.toBeNull();
  });
});

describe("SCALE-001-B: guard contract over the shared store (single instance)", () => {
  let store: AtomicLoginGuardStore;
  beforeAll(() => {
    store = createPostgresLoginGuardStore(db as unknown as PrismaClient, { pruneChance: 0 });
  });
  afterEach(async () => {
    await db.loginGuardState.deleteMany({});
  });
  afterAll(async () => {
    await db.loginGuardState.deleteMany({});
  });

  test("crossing the per-account budget locks the account with the first backoff", async () => {
    const identity = ident("10.9.0.1", "burst-a@corp.example");
    for (let i = 0; i < 10; i++) {
      await recordLoginFailure(identity, T0 + i, makeDeps(store));
    }
    const verdict = await checkLoginAllowed(identity, T0 + 500, makeDeps(store));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("account_locked");
    expect(verdict.retryAfterSec).toBe(30); // 30 s · 2^1 − elapsed
  });

  test("after the lockout expires with the window still hot, backoff escalates (30 → 60 s)", async () => {
    const identity = ident("10.9.0.2", "burst-b@corp.example");
    for (let i = 0; i < 10; i++) {
      await recordLoginFailure(identity, T0 + i, makeDeps(store));
    }
    const stillLocked = await checkLoginAllowed(identity, T0 + 1_000, makeDeps(store));
    expect(stillLocked.reason).toBe("account_locked");
    const escalated = await checkLoginAllowed(identity, T0 + 31_000, makeDeps(store));
    expect(escalated.allowed).toBe(false);
    expect(escalated.reason).toBe("account_locked");
    expect(escalated.retryAfterSec).toBe(60); // 30 s · 2^2
  });

  test("window expiry frees the budget (lockout decays fully — never permanent)", async () => {
    const identity = ident("10.9.0.3", "burst-c@corp.example");
    for (let i = 0; i < 10; i++) {
      await recordLoginFailure(identity, T0 + i, makeDeps(store));
    }
    const afterWindow = await checkLoginAllowed(
      identity,
      T0 + WINDOW_MS + 240_000 + 1_000,
      makeDeps(store)
    );
    expect(afterWindow.allowed).toBe(true);
    expect(afterWindow.reason).toBe("ok");
    const row = await db.loginGuardState.findUnique({
      where: { key: `acct:${identity.accountHash}` },
    });
    expect(row).toBeNull(); // decayed state is deleted, not retained
  });

  test("success resets BOTH dimensions (visible in the shared rows)", async () => {
    const identity = ident("10.9.0.4", "reset-d@corp.example");
    for (let i = 0; i < 5; i++) {
      await recordLoginFailure(identity, T0 + i, makeDeps(store));
    }
    await recordLoginSuccess(identity, T0 + 100, makeDeps(store));
    const verdict = await checkLoginAllowed(identity, T0 + 200, makeDeps(store));
    expect(verdict.allowed).toBe(true);
    expect(await db.loginGuardState.count()).toBe(0);
  });
});

describe("SCALE-001-B: THE acceptance test — TWO instances, ONE fleet state", () => {
  let clientB: PrismaClient;
  const events: LoginTelemetryEvent[] = [];
  beforeAll(() => {
    // A genuinely separate Prisma client = its own connection pool, i.e. a
    // second app instance behind the load balancer.
    clientB = new PrismaClient();
  });
  beforeEach(async () => {
    await db.loginGuardState.deleteMany({});
    events.length = 0;
  });
  afterAll(async () => {
    await clientB.$disconnect();
    await db.loginGuardState.deleteMany({});
  });

  const sink = (e: LoginTelemetryEvent): void => {
    events.push(e);
  };
  const instanceA = (): AtomicLoginGuardStore =>
    createPostgresLoginGuardStore(db as unknown as PrismaClient, { pruneChance: 0 });
  const instanceB = (): AtomicLoginGuardStore =>
    createPostgresLoginGuardStore(clientB as unknown as PrismaClient, { pruneChance: 0 });

  test("instance A locks the account; instance B honors the lockout", async () => {
    const identity = ident("10.10.0.1", "victim-a@corp.example");
    for (let i = 0; i < 10; i++) {
      await recordLoginFailure(identity, T0 + i, makeDeps(instanceA()));
    }
    const verdict = await checkLoginAllowed(
      identity,
      T0 + 100,
      makeDeps(instanceB(), sink)
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("account_locked");
    expect(verdict.retryAfterSec).toBe(30);
  });

  test("symmetry: instance B throttles the source after instance A fills it", async () => {
    const identity = ident("10.10.0.2", "victim-b@corp.example");
    const srcKnobs = {
      FAYANMS_LOGIN_MAX_ATTEMPTS_PER_SOURCE: "10",
      FAYANMS_LOGIN_MAX_ATTEMPTS_PER_ACCOUNT: "100",
    };
    for (let i = 0; i < 10; i++) {
      await recordLoginFailure(identity, T0 + i, {
        store: instanceA(),
        env: srcKnobs,
      });
    }
    const verdict = await checkLoginAllowed(
      identity,
      T0 + 100,
      { store: instanceB(), env: srcKnobs }
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("source_throttled");
    expect(verdict.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  test("a success reset on instance A is visible to instance B", async () => {
    const identity = ident("10.10.0.3", "victim-c@corp.example");
    for (let i = 0; i < 10; i++) {
      await recordLoginFailure(identity, T0 + i, makeDeps(instanceA()));
    }
    const lockedOnB = await checkLoginAllowed(identity, T0 + 100, makeDeps(instanceB()));
    expect(lockedOnB.allowed).toBe(false);
    await recordLoginSuccess(identity, T0 + 200, makeDeps(instanceA()));
    const allowedOnB = await checkLoginAllowed(identity, T0 + 300, makeDeps(instanceB()));
    expect(allowedOnB.allowed).toBe(true);
    expect(allowedOnB.reason).toBe("ok");
  });

  test("fleet telemetry: the lockout event fires exactly ONCE per window across instances", async () => {
    const identity = ident("10.10.0.4", "victim-d@corp.example");
    for (let i = 0; i < 10; i++) {
      await recordLoginFailure(identity, T0 + i, makeDeps(instanceA(), sink));
    }
    // A crossed the budget → one event. B denies against the same shared
    // state (denialEmittedAt is fleet-visible) → no second event.
    await checkLoginAllowed(identity, T0 + 100, makeDeps(instanceB(), sink));
    await recordLoginFailure(identity, T0 + 200, makeDeps(instanceA(), sink));
    expect(events.filter((e) => e.action === "SIGNIN_LOCKOUT")).toHaveLength(1);
  });

  test("12 parallel failures across BOTH instances → 12 stamps, ONE escalation, ONE event", async () => {
    const identity = ident("10.10.0.5", "victim-e@corp.example");
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        recordLoginFailure(
          identity,
          T0, // one burst instant — keeps the flip's lockoutUntil deterministic
          makeDeps(i % 2 === 0 ? instanceA() : instanceB(), sink)
        )
      )
    );
    const row = await db.loginGuardState.findUnique({
      where: { key: `acct:${identity.accountHash}` },
    });
    expect(row?.failures).toHaveLength(12); // no lost updates
    expect(row?.lockoutCount).toBe(1); // no double escalation
    expect(row?.lockoutUntil.getTime()).toBe(T0 + 30_000);
    expect(events.filter((e) => e.action === "SIGNIN_LOCKOUT")).toHaveLength(1);
  });
});

describe("SCALE-001-B: failure policy + server-side retention", () => {
  let deadClient: PrismaClient;
  beforeAll(() => {
    deadClient = new PrismaClient({
      datasources: {
        db: { url: "postgresql://fayanms:fayanms@127.0.0.1:5999/fayanms?connect_timeout=1" },
      },
    });
  });
  afterAll(async () => {
    await deadClient.$disconnect().catch(() => undefined);
    await db.loginGuardState.deleteMany({});
  });

  test("an unreachable shared store REJECTS the attempt (fail-closed, like SCALE-001-A)", async () => {
    const dead = createPostgresLoginGuardStore(deadClient as unknown as PrismaClient, {
      transactionTimeoutMs: 1_500,
      pruneChance: 0,
    });
    expect(
      checkLoginAllowed(ident("10.11.0.1", "outage@corp.example"), T0, makeDeps(dead))
    ).rejects.toThrow();
  });

  test("pruneStale removes dead rows and keeps rows with an ACTIVE lockout", async () => {
    await db.loginGuardState.create({
      data: {
        key: "dist:stale",
        failures: [1],
        lockoutUntil: new Date(0),
        updatedAt: new Date(T0 - 10_000_000),
      },
    });
    await db.loginGuardState.create({
      data: {
        key: "dist:live",
        failures: [T0],
        lockoutUntil: new Date(T0 + 60_000),
        updatedAt: new Date(T0 - 10_000_000),
      },
    });
    const store = createPostgresLoginGuardStore(db as unknown as PrismaClient, { pruneChance: 0 });
    const gone = await store.pruneStale(T0, WINDOW_MS);
    expect(gone).toBe(1);
    expect(await db.loginGuardState.findUnique({ where: { key: "dist:stale" } })).toBeNull();
    expect(await db.loginGuardState.findUnique({ where: { key: "dist:live" } })).not.toBeNull();
  });
});

describe("SCALE-001-B: resolution policy (FAYANMS_RATE_STORE — one knob, both planes)", () => {
  /** Pure env builder (the repo's ProcessEnv augmentation requires NODE_ENV). */
  const envWith = (value?: string): NodeJS.ProcessEnv => ({
    NODE_ENV: "test",
    FAYANMS_RATE_STORE: value,
  });

  test("unset/empty/memory → in-memory default (single-host zero-infra)", () => {
    expect(resolveLoginGuardStore(envWith()).kind).toBe("memory");
    expect(resolveLoginGuardStore(envWith("")).kind).toBe("memory");
    expect(resolveLoginGuardStore(envWith(" memory ")).kind).toBe("memory");
    expect(createMemoryLoginGuardStore().kind).toBe("memory");
  });

  test("postgres → the atomic shared store", () => {
    const store = resolveLoginGuardStore(envWith("postgres"));
    expect(store.kind).toBe("postgres");
    expect(typeof (store as AtomicLoginGuardStore).mutate).toBe("function");
    expect(resolveLoginGuardStore(envWith("POSTGRES")).kind).toBe("postgres");
  });

  test("unknown value refuses (no silent fallback to a weaker posture)", () => {
    expect(() => resolveLoginGuardStore(envWith("redis-but-typoed"))).toThrow(
      /FAYANMS_RATE_STORE/
    );
  });
});
