/**
 * SCALE-001-A (independent audit 2026-09-15) — shared distributed
 * rate-limit store.
 *
 * THE FINDING: the API rate gate's buckets were a process-local Map —
 * budgets were per-instance. Behind a load balancer every instance minted
 * its own budget (fleet quota = N × budget), so the SAFE-002 gate could not
 * mean anything fleet-wide, and the single-host posture could not scale
 * honestly.
 *
 * THE DESIGN (documented decisions, each pinned by tests):
 *
 *   - ONE store contract, two implementations:
 *       · in-memory (DEFAULT — the zero-new-infra single-host posture,
 *         identical semantics to the pre-SCALE gate: sliding window, bounded
 *         key cap with stale-first sweep, denied attempts consume no slots);
 *       · PostgreSQL (OPT-IN via FAYANMS_RATE_STORE=postgres) — the shared
 *         store for horizontally scaled app instances. It reuses the
 *         database the app ALREADY depends on: no new mandatory service in
 *         the stack (a Redis service would add infra the single-host
 *         deployment does not run; the interface accepts further backends).
 *
 *   - ATOMICITY: a Postgres hit serializes on a per-key advisory xact lock
 *     and runs prune → count → (insert | deny) inside ONE transaction.
 *     There is no GET/increment-in-app/SET window — the classic race that
 *     lets N concurrent callers all observe "N-1 used" and all pass.
 *
 *   - RETENTION: rows are pruned per key on every hit (window expiry) and
 *     by a global stale sweep (probabilistic per hit, direct-callable for
 *     deterministic tests), so a distinct-key flood cannot grow the table
 *     without bound.
 *
 *   - FAILURE POLICY (pinned, documented): an unreachable shared store
 *     REJECTS the hit — fail-closed. The shared store is the same
 *     PostgreSQL the app already depends on; if it is down, the app cannot
 *     serve requests anyway, so fail-closed never converts a working
 *     deployment into a broken one, and it guarantees protection is never
 *     silently removed. The in-memory default has no remote failure mode.
 *
 *   - RESOLUTION: unset/""/"memory" → in-memory; "postgres" → Postgres
 *     (case/space tolerant); ANY other value refuses — no silent fallback
 *     to a weaker posture.
 */

import { PrismaClient } from "@prisma/client";

import { db } from "@/lib/db";

export const RATE_STORE_ENV = "FAYANMS_RATE_STORE";

/** Result of one atomic hit against a sliding-window budget. */
export interface SharedRateHit {
  /** Hits recorded in the current window INCLUDING this one (when allowed). */
  total: number;
  allowed: boolean;
  /** Seconds until the oldest surviving stamp leaves the window (0 when allowed). */
  retryAfterSec: number;
}

export interface SharedRateStore {
  /** Which backend resolved — surfaced for observability and tests. */
  readonly kind: "memory" | "postgres";
  /**
   * Atomically record one hit for `key` against a `limit` per `windowMs`.
   * `nowMs` is injectable for deterministic tests; production omits it.
   */
  hit(key: string, limit: number, windowMs: number, nowMs?: number): Promise<SharedRateHit>;
  /** Drop every recorded hit (test seam; never used in request paths). */
  resetForTests?(): Promise<void> | void;
}

/* ────────────────────────── in-memory implementation ─────────────────────── */

export const MAX_MEMORY_RATE_KEYS = 5_000;

/**
 * Bounded in-memory sliding-window store — the single-host default.
 * Same semantics the SAFE-002 gate has always had, extracted so the gate
 * itself becomes store-agnostic. Internal hits are synchronous (no
 * interleaving points), so per-key atomicity is process-guaranteed.
 */
export function createInMemoryRateStore(maxKeys: number = MAX_MEMORY_RATE_KEYS): SharedRateStore {
  const buckets = new Map<string, number[]>();

  function sweepStale(nowMs: number): void {
    if (buckets.size <= maxKeys) return;
    for (const [key, stamps] of buckets) {
      const newest = stamps[stamps.length - 1];
      if (newest === undefined || nowMs - newest > 60_000) buckets.delete(key);
      if (buckets.size <= maxKeys / 2) break;
    }
  }

  const store = {
    kind: "memory" as const,
    // Async signature for contract parity with the Postgres store (the
    // internal logic is synchronous — no interleaving points per key).
    async hit(key, limit, windowMs, nowMs = Date.now()) {
      sweepStale(nowMs);
      const stamps = (buckets.get(key) ?? []).filter((stamp) => nowMs - stamp < windowMs);
      if (stamps.length >= limit) {
        const retryAfterSec = Math.max(1, Math.ceil((stamps[0] + windowMs - nowMs) / 1000));
        buckets.set(key, stamps);
        return { total: stamps.length, allowed: false, retryAfterSec };
      }
      stamps.push(nowMs);
      buckets.set(key, stamps);
      return { total: stamps.length, allowed: true, retryAfterSec: 0 };
    },
    resetForTests() {
      buckets.clear();
    },
  };

  // defineProperty (not a spread) so the value is read LIVE for the
  // bounded-sweep pins in rate-gate.test.ts.
  Object.defineProperty(store, "sizeForTests", {
    get: () => buckets.size,
    enumerable: false,
  });

  return store as SharedRateStore & { sizeForTests: number };
}

/* ────────────────────────── Postgres implementation ──────────────────────── */

export interface PostgresRateStoreOptions {
  /**
   * Prisma client (defaults to the app's singleton `db`). Typed as the BASE
   * `PrismaClient`: the exported `db` is an $extends-wrapped client (audit
   * hash-chain stamping) whose extended type is not assignable to the base
   * type — one honest boundary cast below; at runtime the extended client
   * is a structural superset and every used delegate behaves identically.
   */
  client?: PrismaClient;
  /** Transaction budget in ms (default 5 s; tests shorten it). */
  transactionTimeoutMs?: number;
  /** Probability of running the global stale sweep per hit (default 0.01). */
  pruneChance?: number;
}

/**
 * PostgreSQL-backed shared store. Every hit runs in ONE transaction:
 *
 *   1. pg_advisory_xact_lock(hashtextextended(key)) — serializes concurrent
 *      hits for the SAME key (other keys proceed untouched); the lock is
 *      held until COMMIT, so the read-modify-write below cannot interleave;
 *   2. DELETE the key's rows older than the window (retention);
 *   3. COUNT the key's surviving rows;
 *   4a. count >= limit → deny with Retry-After computed from the OLDEST
 *       surviving stamp (a denied attempt inserts NOTHING — the window
 *       stays truthful, matching the in-memory semantics);
 *   4b. count < limit → INSERT the hit, allow.
 *
 * Store errors propagate (fail-closed — see the module contract above).
 */
export function createPostgresRateStore(
  client: PrismaClient = db as unknown as PrismaClient,
  options: PostgresRateStoreOptions = {}
): SharedRateStore {
  const timeoutMs = options.transactionTimeoutMs ?? 5_000;
  const pruneChance = options.pruneChance ?? 0.01;

  return {
    kind: "postgres",
    async hit(key, limit, windowMs, nowMs = Date.now()) {
      const windowStart = new Date(nowMs - windowMs);
      const decision = await client.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
          await tx.rateLimitHit.deleteMany({
            where: { bucketKey: key, hitAt: { lt: windowStart } },
          });
          const used = await tx.rateLimitHit.count({
            where: { bucketKey: key, hitAt: { gte: windowStart } },
          });
          if (used >= limit) {
            const oldest = await tx.rateLimitHit.findFirst({
              where: { bucketKey: key },
              orderBy: { hitAt: "asc" },
              select: { hitAt: true },
            });
            const retryAfterSec = oldest
              ? Math.max(1, Math.ceil((oldest.hitAt.getTime() + windowMs - nowMs) / 1000))
              : 1;
            return { total: used, allowed: false, retryAfterSec };
          }
          await tx.rateLimitHit.create({ data: { bucketKey: key, hitAt: new Date(nowMs) } });
          return { total: used + 1, allowed: true, retryAfterSec: 0 };
        },
        { timeout: timeoutMs }
      );

      if (Math.random() < pruneChance) {
        // Fire-and-forget: retention never delays the decision path. Tests
        // pass pruneChance: 0 for determinism and call pruneStale directly.
        void client.rateLimitHit
          .deleteMany({ where: { hitAt: { lt: new Date(nowMs - windowMs) } } })
          .catch(() => undefined);
      }
      return decision;
    },
    async resetForTests() {
      await client.rateLimitHit.deleteMany({});
    },
    async pruneStale(nowMs: number): Promise<number> {
      const gone = await client.rateLimitHit.deleteMany({
        where: { hitAt: { lt: new Date(nowMs - 60_000) } },
      });
      return gone.count;
    },
  } as SharedRateStore & { pruneStale: (nowMs: number) => Promise<number> };
}

/* ────────────────────────────── resolution ──────────────────────────────── */

function resolveStoreKind(env: NodeJS.ProcessEnv): "memory" | "postgres" {
  const raw = (env[RATE_STORE_ENV] ?? "").trim().toLowerCase();
  if (raw === "" || raw === "memory") return "memory";
  if (raw === "postgres" || raw === "postgresql") return "postgres";
  throw new Error(
    `[rate-store] ${RATE_STORE_ENV}="${raw}" is not a supported store — ` +
      `supported values: unset/"memory" (single-host default) or "postgres" (shared store).`
  );
}

/** Resolve the store from an env (pure — used by tests and boot). */
export function resolveRateStore(
  env: NodeJS.ProcessEnv = process.env
): SharedRateStore {
  const kind = resolveStoreKind(env);
  if (kind === "postgres") return createPostgresRateStore();
  return createInMemoryRateStore();
}

let activeStore: SharedRateStore | undefined;

/**
 * The process-wide store (resolved once, cached). The rate gate calls this
 * on every hit; resolution is a no-op after the first call.
 */
export function getRateStore(): SharedRateStore {
  if (activeStore === undefined) activeStore = resolveRateStore();
  return activeStore;
}

/** Test seam — force a store (or null to re-resolve from env). */
export function setRateStoreForTests(store: SharedRateStore | null): void {
  activeStore = store ?? undefined;
}
