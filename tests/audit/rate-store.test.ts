import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { PrismaClient } from "@prisma/client";

import { db } from "../../src/lib/db";
import {
  type SharedRateStore,
  createInMemoryRateStore,
  createPostgresRateStore,
  resolveRateStore,
} from "../../src/lib/api/rate-store";

/**
 * SCALE-001-A (TASK-SCALE-001-A) — shared distributed rate-limit store.
 *
 * The confirmed finding: `src/lib/api/rate-gate.ts` buckets were a
 * process-local Map — budgets were per-instance, so behind a load balancer
 * every instance minted its own budget (fleet quota = N × budget) and the
 * documented single-host posture could not scale honestly.
 *
 * Pinned here:
 *   1. one store contract, two implementations — in-memory (single-host
 *      default, zero new infra) and PostgreSQL (opt-in shared store for
 *      horizontally scaled deployments, FAYANMS_RATE_STORE=postgres);
 *   2. atomicity: parallel hits against the Postgres store never exceed the
 *      budget (per-key advisory lock + prune/count/insert in one transaction
 *      — no GET/increment/SET race);
 *   3. THE acceptance test: TWO store clients on SEPARATE Prisma
 *      connections observe ONE shared budget (instance A + instance B draw
 *      from the same bucket);
 *   4. fail-closed outage policy: an unreachable store REJECTS the hit
 *      (documented decision — the shared store is the same PostgreSQL the
 *      app already depends on; an outage is a platform outage, protection
 *      is never silently removed);
 *   5. bounded retention: stale rows are pruned (per-key on every hit +
 *      a global stale sweep), so distinct-key floods cannot grow the table
 *      without bound;
 *   6. resolution policy: memory default, postgres opt-in, unknown values
 *      refuse (no silent fallback).
 */

const WINDOW_MS = 60_000;

/** Contract suite every backend must satisfy (B4: deterministic tests). */
function exerciseStoreContract(
  name: string,
  makeStore: () => SharedRateStore | Promise<SharedRateStore>
) {
  test(`${name}: budget exhausted → limited with Retry-After ≥ 1`, async () => {
    const store = await makeStore();
    for (let i = 0; i < 3; i++) {
      const hit = await store.hit("contract:exhaust", 3, WINDOW_MS, 1_000_000);
      expect(hit.allowed).toBe(true);
      expect(hit.retryAfterSec).toBe(0);
    }
    const denied = await store.hit("contract:exhaust", 3, WINDOW_MS, 1_000_000 + 1_000);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(denied.retryAfterSec).toBeLessThanOrEqual(60);
  });

  test(`${name}: sliding window slides — budget recovers after expiry`, async () => {
    const store = await makeStore();
    for (let i = 0; i < 2; i++) {
      await store.hit("contract:slide", 2, WINDOW_MS, 2_000_000);
    }
    const stillDenied = await store.hit("contract:slide", 2, WINDOW_MS, 2_000_000 + WINDOW_MS - 1);
    expect(stillDenied.allowed).toBe(false);
    const recovered = await store.hit("contract:slide", 2, WINDOW_MS, 2_000_000 + WINDOW_MS + 1);
    expect(recovered.allowed).toBe(true);
  });

  test(`${name}: Retry-After counts from the OLDEST surviving stamp`, async () => {
    const store = await makeStore();
    await store.hit("contract:retry", 1, WINDOW_MS, 3_000_000);
    await new Promise((r) => setTimeout(r, 0)); // distinct timestamps where the backend uses real time
    const denied = await store.hit("contract:retry", 1, WINDOW_MS, 3_000_000 + 20_000);
    expect(denied.allowed).toBe(false);
    // oldest stamp at 3_000_000 + window → 40 s remain at now = 3_020_000
    expect(denied.retryAfterSec).toBe(40);
  });

  test(`${name}: distinct keys draw from distinct budgets`, async () => {
    const store = await makeStore();
    for (let i = 0; i < 3; i++) {
      expect((await store.hit("contract:key-a", 3, WINDOW_MS, 4_000_000)).allowed).toBe(true);
    }
    expect((await store.hit("contract:key-a", 3, WINDOW_MS, 4_000_001)).allowed).toBe(false);
    expect((await store.hit("contract:key-b", 3, WINDOW_MS, 4_000_001)).allowed).toBe(true);
  });

  test(`${name}: denied attempts do NOT consume slots (window stays truthful)`, async () => {
    const store = await makeStore();
    await store.hit("contract:noslot", 2, WINDOW_MS, 5_000_000);
    await store.hit("contract:noslot", 2, WINDOW_MS, 5_000_001);
    // Hammer the exhausted budget until just before expiry — denied hits
    // must not extend the window.
    for (let t = 5_002; t < 5_059; t += 7) {
      const denied = await store.hit("contract:noslot", 2, WINDOW_MS, t * 1_000);
      expect(denied.allowed).toBe(false);
    }
    const afterExpiry = await store.hit("contract:noslot", 2, WINDOW_MS, 5_060_001);
    expect(afterExpiry.allowed).toBe(true);
  });

  test(`${name}: parallel hits never exceed the budget (atomicity)`, async () => {
    const store = await makeStore();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => store.hit("contract:parallel", 5, WINDOW_MS, 6_000_000 + i))
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(results.filter((r) => !r.allowed)).toHaveLength(7);
  });
}

describe("SCALE-001-A: in-memory store contract (single-host default)", () => {
  let store: SharedRateStore;
  beforeAll(async () => {
    store = createInMemoryRateStore();
  });
  afterEach(() => {
    (store as { resetForTests?: () => void }).resetForTests?.();
  });
  exerciseStoreContract("memory", () => store);
});

describe("SCALE-001-A: Postgres store contract (opt-in shared store)", () => {
  let store: SharedRateStore;
  beforeAll(async () => {
    store = createPostgresRateStore(db as unknown as PrismaClient, { pruneChance: 0 });
    await db.rateLimitHit.deleteMany({});
  });
  afterEach(async () => {
    await db.rateLimitHit.deleteMany({});
  });
  afterAll(async () => {
    await db.rateLimitHit.deleteMany({});
  });
  exerciseStoreContract("postgres", () => store);

  test("postgres: bounded retention — stale rows are pruned globally", async () => {
    await db.rateLimitHit.create({
      data: { bucketKey: "contract:stale", hitAt: new Date(1_000) },
    });
    const store2 = createPostgresRateStore();
    await (store2 as unknown as { pruneStale: (nowMs: number) => Promise<number> }).pruneStale(
      10_000_000 // far future: everything before now-60s is stale
    );
    expect(await db.rateLimitHit.count({ where: { bucketKey: "contract:stale" } })).toBe(0);
  });
});

describe("SCALE-001-A: TWO store clients observe ONE shared budget (the acceptance test)", () => {
  let clientB: PrismaClient;
  beforeAll(() => {
    // A genuinely separate Prisma client = its own connection pool, i.e. a
    // second "app instance" in the horizontal-scaling thought experiment.
    clientB = new PrismaClient();
  });
  afterAll(async () => {
    await clientB.$disconnect();
    await db.rateLimitHit.deleteMany({});
  });

  test("instance A draws 2 of 3; instance B sees the shared remainder and is limited on the 4th", async () => {
    const instanceA = createPostgresRateStore(db as unknown as PrismaClient, { pruneChance: 0 });
    const instanceB = createPostgresRateStore(clientB as unknown as PrismaClient, { pruneChance: 0 });
    await db.rateLimitHit.deleteMany({});

    const key = "fleet:shared-budget";
    expect((await instanceA.hit(key, 3, WINDOW_MS, 7_000_000)).allowed).toBe(true);
    expect((await instanceA.hit(key, 3, WINDOW_MS, 7_000_001)).allowed).toBe(true);

    // Instance B counts what A already spent — one shared budget.
    const bThird = await instanceB.hit(key, 3, WINDOW_MS, 7_000_002);
    expect(bThird.allowed).toBe(true);
    expect(bThird.total).toBe(3);

    const bFourth = await instanceB.hit(key, 3, WINDOW_MS, 7_000_003);
    expect(bFourth.allowed).toBe(false);
    expect(bFourth.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  test("instance A is limited by instance B's spend (symmetry)", async () => {
    const instanceA = createPostgresRateStore(db as unknown as PrismaClient, { pruneChance: 0 });
    const instanceB = createPostgresRateStore(clientB as unknown as PrismaClient, { pruneChance: 0 });
    await db.rateLimitHit.deleteMany({});

    const key = "fleet:symmetric";
    await instanceB.hit(key, 1, WINDOW_MS, 7_100_000);
    const aDenied = await instanceA.hit(key, 1, WINDOW_MS, 7_100_001);
    expect(aDenied.allowed).toBe(false);
  });
});

describe("SCALE-001-A: failure policy — an unreachable shared store is fail-closed", () => {
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
  });

  test("postgres: store outage REJECTS the hit (protection never silently removed)", async () => {
    const store = createPostgresRateStore(deadClient as unknown as PrismaClient, { transactionTimeoutMs: 1_500 });
    expect(store.hit("outage:probe", 10, WINDOW_MS)).rejects.toThrow();
  });
});

describe("SCALE-001-A: resolution policy (FAYANMS_RATE_STORE)", () => {
  const original = process.env.FAYANMS_RATE_STORE;
  afterEach(() => {
    if (original === undefined) delete process.env.FAYANMS_RATE_STORE;
    else process.env.FAYANMS_RATE_STORE = original;
  });

  test("unset/empty/memory → in-memory default (single-host zero-infra)", () => {
    delete process.env.FAYANMS_RATE_STORE;
    expect(resolveRateStore(process.env).kind).toBe("memory");
    process.env.FAYANMS_RATE_STORE = "";
    expect(resolveRateStore(process.env).kind).toBe("memory");
    process.env.FAYANMS_RATE_STORE = " memory ";
    expect(resolveRateStore(process.env).kind).toBe("memory");
  });

  test("postgres → Postgres-backed shared store", () => {
    process.env.FAYANMS_RATE_STORE = "postgres";
    expect(resolveRateStore(process.env).kind).toBe("postgres");
    process.env.FAYANMS_RATE_STORE = "POSTGRES";
    expect(resolveRateStore(process.env).kind).toBe("postgres");
  });

  test("unknown value refuses (no silent fallback)", () => {
    process.env.FAYANMS_RATE_STORE = "redis-but-typoed";
    expect(() => resolveRateStore(process.env)).toThrow(/FAYANMS_RATE_STORE/);
  });
});
