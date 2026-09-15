/**
 * Login abuse control (AUTH-001-A — external independent audit 2026-09-15,
 * finding AUTH-001 / TASK AUTH-001-A).
 *
 * HISTORY OF THE DEFECT: `/api/auth/*` sits OUTSIDE the `/api/v1` proxy gate
 * (src/proxy.ts matcher `["/api/v1/:path*"]`) and the NextAuth credentials
 * `authorize()` performed password verification with no throttling, backoff,
 * lockout or telemetry — online password guessing (brute force / credential
 * stuffing) was bounded only by network-level controls.
 *
 * WHY A DEDICATED GUARD (not the generic API limiter): login traffic has
 * different semantics — budgets must span BOTH the calling source AND the
 * targeted account (a distributed attack uses fresh sources per request),
 * failures must drive an escalating temporary lockout instead of a flat
 * window, and a success must reset the state. This module is the single
 * enforcement point for credential sign-in attempts.
 *
 * ENFORCEMENT POINTS (both must stay in place — see the contract tests):
 *   1. ROUTE PRE-CHECK — POST /api/auth/callback/credentials (and nothing
 *      else) is consulted BEFORE NextAuth parses the request; a denied
 *      caller receives the standard 429 envelope with Retry-After, so the
 *      expensive scrypt verification is never reached. Malformed bodies
 *      fail OPEN here (NextAuth keeps owning them).
 *   2. AUTHORIZE INTEGRATION — src/lib/auth/options.ts consults
 *      checkLoginAllowed() BEFORE the DB lookup + scrypt and records the
 *      outcome afterwards. This protects the actual credentials
 *      verification path, independent of any wrapper.
 *
 * KEYING:
 *   - source: the repository's rightmost-trusted-hop policy
 *     (resolveClientIp from src/lib/api/rate-gate.ts — the leftmost
 *     X-Forwarded-For entries are attacker-controlled and never trusted).
 *   - account: HMAC-SHA256(NEXTAUTH_SECRET, normalized email), 128-bit
 *     slice — a NON-REVERSIBLE keyed representation, so no raw account
 *     identifier is ever persisted, logged or emitted. Unknown and known
 *     accounts are keyed identically (no enumeration channel).
 *
 * POLICY (small, fixed shape — three documented env knobs, no more):
 *   - sliding window (FAYANMS_LOGIN_WINDOW_SECONDS, default 300 s);
 *   - per-source failure budget (FAYANMS_LOGIN_MAX_ATTEMPTS_PER_SOURCE,
 *     default 10) — a plain sliding budget, denied attempts do not consume
 *     slots, so Retry-After stays truthful;
 *   - per-account failure budget (FAYANMS_LOGIN_MAX_ATTEMPTS_PER_ACCOUNT,
 *     default 30, deliberately ABOVE the per-source budget so a single
 *     source cannot lock an account alone — distributed abuse required);
 *   - account lockout: temporary, exponential (30 s · 2^n), capped at
 *     LOGIN_LOCKOUT_MAX_MS (240 s — kept BELOW the default window so
 *     hammering-during-lockout escalation stays coherent). NEVER permanent:
 *     an unauthenticated attacker cannot cause an irrecoverable denial; the
 *     state decays fully once the attack stops, and a successful login
 *     resets the (source, account) state immediately.
 *
 * RESOURCE SAFETY: bounded state — MAX_LOGIN_GUARD_KEYS keys
 * (stale-first sweep to half the cap when exceeded), MAX_FAILURE_STAMPS_PER_KEY
 * timestamps per key. The store sits behind the LoginGuardStore interface;
 * TASK-SCALE-001-B added the shared backend: when FAYANMS_RATE_STORE=postgres
 * (the SAME knob as the API gate's shared store — one knob, both planes),
 * every per-key read-modify-write (prune → budget → escalate → upsert/
 * delete) serializes on a per-key advisory xact lock inside ONE transaction,
 * so login budgets and lockouts are FLEET-WIDE, not per-instance. An
 * unreachable shared store fails CLOSED (the pinned SCALE-001-A decision —
 * the DB is already a hard dependency; protection is never silently
 * removed). A plain get/set KV over SQL is NOT atomic across instances and
 * remains refused.
 *
 * TELEMETRY: typed audit events (SIGNIN_THROTTLED / SIGNIN_LOCKOUT) written
 * to the existing AuditEvent trail at most once per key per window (never a
 * per-attempt row storm). Rows carry actorId null (pre-auth — no fabricated
 * actor FK), actorName "login-guard", the keyed account hash and the
 * sanitized source key — never a raw email, never a password. Telemetry
 * failures never break the sign-in path.
 */

import { createHmac, randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";

import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/lib/db";
import {
  rateLimitedBody,
  rateLimitedHeaders,
  resolveClientIp,
} from "@/lib/api/rate-gate";
import { resolveRateStoreKind } from "@/lib/api/rate-store";

/* ───────────────────────────── policy constants ──────────────────────── */

export const LOGIN_WINDOW_MS_DEFAULT = 300_000; // 5 minutes
export const LOGIN_MAX_FAILS_PER_SOURCE_DEFAULT = 10;
export const LOGIN_MAX_FAILS_PER_ACCOUNT_DEFAULT = 30;
export const LOGIN_LOCKOUT_BASE_MS = 30_000; // first lockout: 30 s
export const LOGIN_LOCKOUT_MAX_MS = 240_000; // cap: 4 min (< default window)
export const MAX_LOGIN_GUARD_KEYS = 5_000;
export const MAX_FAILURE_STAMPS_PER_KEY = 64;
export const UNSPECIFIED_ACCOUNT = "unspecified";
export const CREDENTIALS_CALLBACK_PATH = "/api/auth/callback/credentials";

/* ───────────────────────────── configuration ─────────────────────────── */

export interface LoginGuardEnv {
  FAYANMS_LOGIN_WINDOW_SECONDS?: string;
  FAYANMS_LOGIN_MAX_ATTEMPTS_PER_SOURCE?: string;
  FAYANMS_LOGIN_MAX_ATTEMPTS_PER_ACCOUNT?: string;
}

export interface LoginGuardConfig {
  windowMs: number;
  maxPerSource: number;
  maxPerAccount: number;
}

function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

/** Parse + clamp the three knobs; garbage falls back to secure defaults. */
export function parseLoginGuardEnv(env: LoginGuardEnv): LoginGuardConfig {
  return {
    windowMs: clampInt(
      env.FAYANMS_LOGIN_WINDOW_SECONDS,
      LOGIN_WINDOW_MS_DEFAULT / 1000,
      30,
      3_600
    ) * 1000,
    maxPerSource: clampInt(
      env.FAYANMS_LOGIN_MAX_ATTEMPTS_PER_SOURCE,
      LOGIN_MAX_FAILS_PER_SOURCE_DEFAULT,
      3,
      100
    ),
    maxPerAccount: clampInt(
      env.FAYANMS_LOGIN_MAX_ATTEMPTS_PER_ACCOUNT,
      LOGIN_MAX_FAILS_PER_ACCOUNT_DEFAULT,
      5,
      200
    ),
  };
}

/* ─────────────────────────── store abstraction ───────────────────────── */

export interface LoginKeyState {
  /** Recent failure timestamps (pruned to the window, capped per key). */
  failures: number[];
  /** Current lockout expiry (0 = never locked). */
  lockoutUntil: number;
  /** Consecutive lockouts — drives the exponential backoff; decays clean. */
  lockoutCount: number;
  /** Last telemetry emission for this key (once-per-window rule). */
  denialEmittedAt: number;
}

export interface LoginGuardStore {
  /** Which backend this store resolved to (observability + tests). */
  readonly kind: "memory" | "postgres";
  get(key: string): LoginKeyState | undefined;
  set(key: string, state: LoginKeyState): void;
  delete(key: string): void;
  size(): number;
  entries(): IterableIterator<[string, LoginKeyState]>;
}

/**
 * Outcome of one per-key mutation. The mutator runs INSIDE the serialized
 * critical section (transaction for the shared store, plain flow for the
 * process-local one) and returns:
 *   - { state: LoginKeyState } → upsert the key's state;
 *   - { state: null }          → delete the key (decayed/reset state);
 *   - { state: undefined }     → leave the key untouched (nothing to write);
 * plus an optional `emit` action — the once-per-window telemetry decision is
 * made INSIDE the serialized mutator (denialEmittedAt is part of the state,
 * so the rule holds fleet-wide), while the sink is invoked by the guard
 * AFTER the write lands — telemetry must never break or hold the decision
 * path — and an optional `verdict`, the deny/allow short-circuit used by
 * checkLoginAllowed.
 */
export interface LoginKeyMutatorOutcome {
  state?: LoginKeyState | null;
  emit?: LoginTelemetryAction;
  verdict?: LoginVerdict;
}

export type LoginKeyMutator = (
  state: LoginKeyState | undefined
) => LoginKeyMutatorOutcome;

/** Timing context for a mutation (drives the shared store's stale sweep). */
export interface AtomicMutateContext {
  nowMs: number;
  windowMs: number;
}

/**
 * A store whose per-key mutations are ATOMIC across processes — the
 * Postgres implementation serializes pg_advisory_xact_lock → read →
 * mutate → write inside ONE transaction (the exact shape SCALE-001-A uses
 * for the API gate). The guard routes every state change through `mutate`
 * when a store exposes it; a plain get/set KV over SQL is NOT atomic and
 * remains refused as a false fix.
 */
export interface AtomicLoginGuardStore extends LoginGuardStore {
  mutate(
    key: string,
    mutator: LoginKeyMutator,
    ctx?: AtomicMutateContext
  ): Promise<LoginKeyMutatorOutcome>;
  /** Global stale sweep (direct-callable for deterministic tests). */
  pruneStale(nowMs: number, windowMs: number): Promise<number>;
}

/**
 * Bounded in-memory default (single process, zero new infra). The shared
 * fleet-wide backend is createPostgresLoginGuardStore below — selected by
 * resolveLoginGuardStore when FAYANMS_RATE_STORE=postgres (TASK-SCALE-001-B,
 * the same knob as the API gate's shared store).
 */
export function createMemoryLoginGuardStore(): LoginGuardStore {
  const map = new Map<string, LoginKeyState>();
  return {
    kind: "memory",
    get: (key) => map.get(key),
    set: (key, state) => void map.set(key, state),
    delete: (key) => void map.delete(key),
    size: () => map.size,
    entries: () => map.entries(),
  };
}

/* ───────────── Postgres shared store (TASK-SCALE-001-B) ───────────── */

export interface PostgresLoginGuardStoreOptions {
  /**
   * Prisma client (defaults to the app's singleton `db`). Typed as the BASE
   * `PrismaClient`: the exported `db` is an $extends-wrapped client (audit
   * hash-chain stamping) whose extended type is not assignable to the base
   * type — the same one honest boundary cast as the rate store; at runtime
   * the extended client is a structural superset and every used delegate
   * behaves identically.
   */
  client?: PrismaClient;
  /** Transaction budget in ms (default 5 s; tests shorten it). */
  transactionTimeoutMs?: number;
  /** Probability of running the global stale sweep per mutation (default 0.01). */
  pruneChance?: number;
}

/** Defensive row → state parse: never trust persisted stamp arrays. */
function stateFromRow(row: {
  failures: unknown;
  lockoutUntil: Date;
  lockoutCount: number;
  denialEmittedAt: Date;
}): LoginKeyState {
  const list: unknown[] = Array.isArray(row.failures) ? row.failures : [];
  const failures = list
    .map((v) => (typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : null))
    .filter((v): v is number => v !== null);
  return {
    failures,
    lockoutUntil: row.lockoutUntil.getTime(),
    lockoutCount: row.lockoutCount,
    denialEmittedAt: row.denialEmittedAt.getTime(),
  };
}

function rowFields(state: LoginKeyState): {
  failures: number[];
  lockoutUntil: Date;
  lockoutCount: number;
  denialEmittedAt: Date;
} {
  return {
    failures: state.failures,
    lockoutUntil: new Date(state.lockoutUntil),
    lockoutCount: state.lockoutCount,
    denialEmittedAt: new Date(state.denialEmittedAt),
  };
}

const EMPTY_ITERATOR: IterableIterator<[string, LoginKeyState]> = new Map<
  string,
  LoginKeyState
>().entries();

/**
 * PostgreSQL-backed shared login-guard store (TASK-SCALE-001-B — the
 * distributed backend for the lockout plane). Every mutation runs in ONE
 * transaction:
 *
 *   1. pg_advisory_xact_lock(hashtextextended(key)) — serializes concurrent
 *      mutations for the SAME key (other keys proceed untouched); the lock
 *      is held until COMMIT, so the guard's read-modify-write (prune →
 *      budget → escalate → upsert/delete) cannot interleave across app
 *      instances — budgets and lockouts are fleet-wide;
 *   2. load the key's row (defensively parsed — see stateFromRow);
 *   3. run the mutator (pure + synchronous — no await points inside the
 *      transaction, no partial writes);
 *   4. apply the outcome: upsert | delete | leave untouched.
 *
 * FAILURE POLICY (pinned, documented): store errors propagate — fail-closed,
 * identical to SCALE-001-A. The shared store is the same PostgreSQL the app
 * already depends on; if it is down, sign-in cannot verify users anyway, and
 * protection is never silently removed. The in-memory default has no remote
 * failure mode.
 *
 * RETENTION: rows are rewritten per key on every hit and a global stale
 * sweep (probabilistic per mutation, direct-callable as pruneStale for
 * deterministic tests) deletes rows whose last activity left the window AND
 * whose lockout has expired — a distinct-key flood cannot grow the table
 * without bound. The process-local memory sweep never applies here.
 *
 * The inherited LoginGuardStore accessors are INERT by design — every state
 * operation flows through the atomic `mutate` (recordLoginSuccess routes its
 * reset through mutate too). They exist for interface parity and are pinned
 * never to lie: get() reports undefined, size() reports 0 — which is what
 * disables the memory-only key-cap sweep for this backend.
 */
export function createPostgresLoginGuardStore(
  client: PrismaClient = db as unknown as PrismaClient,
  options: PostgresLoginGuardStoreOptions = {}
): AtomicLoginGuardStore {
  const timeoutMs = options.transactionTimeoutMs ?? 5_000;
  const pruneChance = options.pruneChance ?? 0.01;

  const pruneStale = async (nowMs: number, windowMs: number): Promise<number> => {
    const gone = await client.loginGuardState.deleteMany({
      where: {
        updatedAt: { lt: new Date(nowMs - windowMs) },
        lockoutUntil: { lt: new Date(nowMs) },
      },
    });
    return gone.count;
  };

  return {
    kind: "postgres",
    get: () => undefined,
    set: () => undefined,
    delete: () => undefined,
    size: () => 0,
    entries: () => EMPTY_ITERATOR,
    async mutate(key, mutator, ctx) {
      const outcome = await client.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
          const row = await tx.loginGuardState.findUnique({ where: { key } });
          const result = mutator(row ? stateFromRow(row) : undefined);
          if (result.state === null) {
            if (row) await tx.loginGuardState.delete({ where: { key } });
            return result;
          }
          if (result.state) {
            const data = rowFields(result.state);
            await tx.loginGuardState.upsert({
              where: { key },
              create: { key, ...data },
              update: data,
            });
          }
          return result;
        },
        { timeout: timeoutMs }
      );
      if (ctx && Math.random() < pruneChance) {
        // Fire-and-forget: retention never delays the decision path. Tests
        // pass pruneChance: 0 for determinism and call pruneStale directly.
        void pruneStale(ctx.nowMs, ctx.windowMs).catch(() => undefined);
      }
      return outcome;
    },
    pruneStale,
  };
}

/**
 * Resolve the login guard's store from an env (pure — tests and boot).
 * FAYANMS_RATE_STORE is THE knob for both shared planes (API gate + login
 * guard): unset/""/"memory" → bounded in-memory default (single-host
 * posture); "postgres" → the atomic shared store. Unknown values refuse —
 * no silent fallback to a weaker posture (resolution reuses the rate
 * store's exact policy, so both planes can never disagree).
 */
export function resolveLoginGuardStore(
  env: NodeJS.ProcessEnv = process.env
): LoginGuardStore {
  if (resolveRateStoreKind(env) === "postgres") return createPostgresLoginGuardStore();
  return createMemoryLoginGuardStore();
}

/**
 * Process-wide default store — resolved LAZILY from the ambient env on
 * first use, then cached (mirrors the rate gate's getRateStore()).
 */
let globalStore: LoginGuardStore | undefined;

function defaultStore(): LoginGuardStore {
  if (globalStore === undefined) globalStore = resolveLoginGuardStore(process.env);
  return globalStore;
}

/* ─────────────────────────── telemetry contract ──────────────────────── */

export type LoginTelemetryAction = "SIGNIN_THROTTLED" | "SIGNIN_LOCKOUT";

export interface LoginTelemetryEvent {
  action: LoginTelemetryAction;
  sourceKey: string;
  accountHash: string;
}

export type LoginTelemetrySink = (
  event: LoginTelemetryEvent
) => void | Promise<void>;

/**
 * Default sink: the existing AuditEvent trail. Pre-auth rows carry a NULL
 * actor (no fabricated FK) and the keyed account hash — never a raw email,
 * never a password. Awaited by the guard (deterministic for tests) but
 * wrapped in try/catch: telemetry must never break the sign-in path.
 */
async function defaultSink(event: LoginTelemetryEvent): Promise<void> {
  try {
    await db.auditEvent.create({
      data: {
        actorId: null,
        actorName: "login-guard",
        action: event.action,
        resourceType: "AuthSignin",
        resourceId: null,
        resourceLabel:
          event.action === "SIGNIN_LOCKOUT"
            ? `account:${event.accountHash}`
            : `source:${event.sourceKey}`,
        result: "FAILURE",
        ip: event.sourceKey,
      },
    });
  } catch {
    // Telemetry must never break the sign-in path.
  }
}

/* ────────────────────────────── identity ─────────────────────────────── */

export interface LoginAttemptIdentity {
  /** Sanitized, spoof-resistant source key (rightmost-trusted-hop policy). */
  sourceKey: string;
  /** Keyed non-reversible account representation (HMAC slice). */
  accountHash: string;
}

export interface LoginVerdict {
  allowed: boolean;
  /** Seconds to wait before retrying (0 when allowed). */
  retryAfterSec: number;
  reason: "ok" | "source_throttled" | "account_locked";
}

export interface LoginGuardDeps {
  store?: LoginGuardStore;
  sink?: LoginTelemetrySink;
  env?: LoginGuardEnv;
}

function resolveDeps(deps: LoginGuardDeps): {
  store: LoginGuardStore;
  sink: LoginTelemetrySink;
  cfg: LoginGuardConfig;
} {
  return {
    store: deps.store ?? defaultStore(),
    sink: deps.sink ?? defaultSink,
    cfg: parseLoginGuardEnv(deps.env ?? (process.env as LoginGuardEnv)),
  };
}

/** Trim + lowercase + cap — identical to authorize()'s email normalization. */
export function normalizeAccountIdentifier(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 320 ? trimmed.slice(0, 320) : trimmed;
}

function accountHashKey(): string {
  const secret = process.env.NEXTAUTH_SECRET;
  return secret && secret.length > 0
    ? secret
    : "fayanms-login-guard-dev-key";
}

/** Keyed, non-reversible account representation (128-bit slice). */
export function hashAccountIdentifier(normalized: string): string {
  const input = normalizeAccountIdentifier(normalized);
  if (input === "") return UNSPECIFIED_ACCOUNT;
  return createHmac("sha256", accountHashKey())
    .update(input)
    .digest("hex")
    .slice(0, 32);
}

/** Spoof-resistant (source, account) identity for one sign-in attempt. */
export function resolveLoginIdentity(
  headers: Headers,
  emailRaw: unknown
): LoginAttemptIdentity {
  return {
    sourceKey: resolveClientIp(headers),
    accountHash: hashAccountIdentifier(normalizeAccountIdentifier(emailRaw)),
  };
}

const sourceKeyOf = (identity: LoginAttemptIdentity): string =>
  `src:${identity.sourceKey}`;
const accountKeyOf = (identity: LoginAttemptIdentity): string =>
  `acct:${identity.accountHash}`;

/* ─────────────────────────── state primitives ────────────────────────── */

function emptyState(): LoginKeyState {
  return { failures: [], lockoutUntil: 0, lockoutCount: 0, denialEmittedAt: 0 };
}

function prune(state: LoginKeyState, now: number, windowMs: number): void {
  if (state.failures.length === 0) return;
  state.failures = state.failures.filter((stamp) => now - stamp < windowMs);
}

function pushCapped(state: LoginKeyState, now: number): void {
  state.failures.push(now);
  if (state.failures.length > MAX_FAILURE_STAMPS_PER_KEY) {
    state.failures.splice(0, state.failures.length - MAX_FAILURE_STAMPS_PER_KEY);
  }
}

function retryFromOldest(
  state: LoginKeyState,
  now: number,
  windowMs: number
): number {
  const oldest = state.failures[0] ?? now;
  return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
}

function backoffFor(lockoutCount: number): number {
  return Math.min(
    LOGIN_LOCKOUT_BASE_MS * 2 ** (lockoutCount - 1),
    LOGIN_LOCKOUT_MAX_MS
  );
}

/**
 * Once-per-window telemetry decision — made INSIDE the serialized mutator
 * (denialEmittedAt is part of the state, so the rule holds fleet-wide); the
 * sink itself is invoked by the guard after the write lands.
 */
function emissionFor(
  state: LoginKeyState,
  action: LoginTelemetryAction,
  now: number,
  windowMs: number
): LoginTelemetryAction | undefined {
  if (state.denialEmittedAt !== 0 && now - state.denialEmittedAt < windowMs) {
    return undefined;
  }
  state.denialEmittedAt = now;
  return action;
}

/** Stale-first sweep; keeps the map at or below half the key cap. */
function sweepStore(
  store: LoginGuardStore,
  now: number,
  windowMs: number
): void {
  for (const [key, state] of store.entries()) {
    const newest = state.failures[state.failures.length - 1] ?? 0;
    if (now - newest > windowMs && state.lockoutUntil <= now) {
      store.delete(key);
    }
    if (store.size() <= MAX_LOGIN_GUARD_KEYS / 2) return;
  }
}

/* ──────────────────────────── guard operations ───────────────────────── */

/** Dispatch one per-key mutation; returns the mutator's verdict, if any. */
async function applyKey(
  store: LoginGuardStore,
  key: string,
  mutator: LoginKeyMutator,
  identity: LoginAttemptIdentity,
  sink: LoginTelemetrySink,
  ctx: AtomicMutateContext
): Promise<LoginVerdict | undefined> {
  let outcome: LoginKeyMutatorOutcome;
  if (typeof (store as AtomicLoginGuardStore).mutate === "function") {
    // Shared store: the whole read-modify-write runs inside the store's
    // per-key advisory-lock transaction (atomic across instances).
    outcome = await (store as AtomicLoginGuardStore).mutate(key, mutator, ctx);
  } else {
    // Process-local store: single-threaded JS + no await between the read
    // and the write — per-key atomicity is process-guaranteed.
    outcome = mutator(store.get(key));
    if (outcome.state === null) store.delete(key);
    else if (outcome.state) store.set(key, outcome.state);
  }
  if (outcome.emit) {
    await sink({
      action: outcome.emit,
      sourceKey: identity.sourceKey,
      accountHash: identity.accountHash,
    });
  }
  return outcome.verdict;
}

/* -- pure per-key decision mutators (identical logic for BOTH stores) -- */

function sourceCheckMutator(cfg: LoginGuardConfig, now: number): LoginKeyMutator {
  return (state) => {
    if (!state) return {};
    prune(state, now, cfg.windowMs);
    if (state.failures.length >= cfg.maxPerSource) {
      return {
        state,
        emit: emissionFor(state, "SIGNIN_THROTTLED", now, cfg.windowMs),
        verdict: {
          allowed: false,
          retryAfterSec: retryFromOldest(state, now, cfg.windowMs),
          reason: "source_throttled",
        },
      };
    }
    // Slid clean → drop the row; otherwise persist the pruned state.
    return state.failures.length === 0 ? { state: null } : { state };
  };
}

function accountCheckMutator(cfg: LoginGuardConfig, now: number): LoginKeyMutator {
  return (state) => {
    if (!state) return {};
    prune(state, now, cfg.windowMs);
    if (state.lockoutUntil > now) {
      // Denied while locked: keep the window hot (drives escalation).
      pushCapped(state, now);
      return {
        state,
        emit: emissionFor(state, "SIGNIN_LOCKOUT", now, cfg.windowMs),
        verdict: {
          allowed: false,
          retryAfterSec: Math.max(1, Math.ceil((state.lockoutUntil - now) / 1000)),
          reason: "account_locked",
        },
      };
    }
    if (state.failures.length === 0 && state.lockoutCount > 0) {
      // Window slid clean with no lockout pending → full decay.
      state.lockoutCount = 0;
      return { state: null, verdict: { allowed: true, retryAfterSec: 0, reason: "ok" } };
    }
    if (state.failures.length >= cfg.maxPerAccount) {
      state.lockoutCount += 1;
      const backoff = backoffFor(state.lockoutCount);
      state.lockoutUntil = now + backoff;
      pushCapped(state, now);
      return {
        state,
        emit: emissionFor(state, "SIGNIN_LOCKOUT", now, cfg.windowMs),
        verdict: {
          allowed: false,
          retryAfterSec: Math.max(1, Math.ceil(backoff / 1000)),
          reason: "account_locked",
        },
      };
    }
    return { state };
  };
}

function sourceFailureMutator(cfg: LoginGuardConfig, now: number): LoginKeyMutator {
  return (state) => {
    const base = state ?? emptyState();
    prune(base, now, cfg.windowMs);
    pushCapped(base, now);
    const crossed = base.failures.length >= cfg.maxPerSource;
    return {
      state: base,
      emit: crossed ? emissionFor(base, "SIGNIN_THROTTLED", now, cfg.windowMs) : undefined,
    };
  };
}

function accountFailureMutator(cfg: LoginGuardConfig, now: number): LoginKeyMutator {
  return (state) => {
    const base = state ?? emptyState();
    prune(base, now, cfg.windowMs);
    pushCapped(base, now);
    let emit: LoginTelemetryAction | undefined;
    if (base.lockoutUntil <= now && base.failures.length >= cfg.maxPerAccount) {
      base.lockoutCount += 1;
      base.lockoutUntil = now + backoffFor(base.lockoutCount);
      emit = emissionFor(base, "SIGNIN_LOCKOUT", now, cfg.windowMs);
    }
    return { state: base, emit };
  };
}

/**
 * Decide whether a credential sign-in attempt may proceed to verification.
 * Denied attempts on a LOCKED account are recorded (bounded) so sustained
 * hammering keeps the failure window hot and the backoff escalates; denied
 * attempts on a merely THROTTLED source consume no slots (truthful
 * Retry-After, mirroring the API gate's sliding-window semantics). Each
 * dimension is one serialized per-key mutation — on the shared store the
 * decision runs inside its transaction, so the verdict is fleet-coherent.
 */
export async function checkLoginAllowed(
  identity: LoginAttemptIdentity,
  nowMs: number = Date.now(),
  deps: LoginGuardDeps = {}
): Promise<LoginVerdict> {
  const { store, sink, cfg } = resolveDeps(deps);
  const now = nowMs;
  const ctx: AtomicMutateContext = { nowMs: now, windowMs: cfg.windowMs };

  // 1. Source dimension — plain sliding budget.
  const srcVerdict = await applyKey(
    store,
    sourceKeyOf(identity),
    sourceCheckMutator(cfg, now),
    identity,
    sink,
    ctx
  );
  if (srcVerdict) return srcVerdict;

  // 2. Account dimension — budget + escalating temporary lockout.
  const acctVerdict = await applyKey(
    store,
    accountKeyOf(identity),
    accountCheckMutator(cfg, now),
    identity,
    sink,
    ctx
  );
  if (acctVerdict) return acctVerdict;

  return { allowed: true, retryAfterSec: 0, reason: "ok" };
}

/**
 * Record one FAILED verification (unknown account, disabled-hash account or
 * wrong password) against BOTH dimensions. Crossing either budget flips the
 * state and emits the typed telemetry event (once per key per window — the
 * rule rides on the shared state, so it holds across instances).
 */
export async function recordLoginFailure(
  identity: LoginAttemptIdentity,
  nowMs: number = Date.now(),
  deps: LoginGuardDeps = {}
): Promise<void> {
  const { store, sink, cfg } = resolveDeps(deps);
  const now = nowMs;
  const ctx: AtomicMutateContext = { nowMs: now, windowMs: cfg.windowMs };

  await applyKey(
    store,
    sourceKeyOf(identity),
    sourceFailureMutator(cfg, now),
    identity,
    sink,
    ctx
  );
  await applyKey(
    store,
    accountKeyOf(identity),
    accountFailureMutator(cfg, now),
    identity,
    sink,
    ctx
  );

  // Memory-only cap sweep (the shared store's retention is server-side).
  if (
    typeof (store as AtomicLoginGuardStore).mutate !== "function" &&
    store.size() > MAX_LOGIN_GUARD_KEYS
  ) {
    sweepStore(store, now, cfg.windowMs);
  }
}

/**
 * Successful authentication: reset the (source, account) state immediately
 * (the intended reset policy — a legit user who fat-fingered a few times
 * starts from a clean budget after signing in). On the shared store the
 * reset is an awaited atomic mutation, so a concurrent instance sees it
 * deterministically.
 */
export async function recordLoginSuccess(
  identity: LoginAttemptIdentity,
  _nowMs: number = Date.now(),
  deps: LoginGuardDeps = {}
): Promise<void> {
  const { store } = resolveDeps(deps);
  const reset: LoginKeyMutator = () => ({ state: null });
  if (typeof (store as AtomicLoginGuardStore).mutate === "function") {
    const atomic = store as AtomicLoginGuardStore;
    await atomic.mutate(sourceKeyOf(identity), reset);
    await atomic.mutate(accountKeyOf(identity), reset);
  } else {
    store.delete(sourceKeyOf(identity));
    store.delete(accountKeyOf(identity));
  }
}

/* ─────────────────────────── test seams ──────────────────────────────── */

/** Test seam — drop the process-wide default store (never in request paths). */
export function resetLoginGuardForTests(): void {
  globalStore = createMemoryLoginGuardStore();
}

/* ─────────────────────── route-level pre-check ───────────────────────── */

/**
 * HTTP adapter for the NextAuth catch-all route: pre-check ONLY the
 * credentials sign-in submission. Returns the standard 429 envelope when
 * the guard denies, or null when the request must flow to NextAuth
 * untouched (every non-credential action, unthrottled callers, and —
 * fail-open — unparseable bodies, which NextAuth owns).
 *
 * The request BODY is read from a CLONE so NextAuth still receives the raw
 * stream; the pre-check happens BEFORE NextAuth parses anything, and long
 * before the expensive scrypt verification inside authorize().
 */
export async function preCheckCredentialsSignin(
  req: NextRequest,
  nowMs: number = Date.now(),
  deps: LoginGuardDeps = {}
): Promise<NextResponse | null> {
  if (req.method !== "POST" || req.nextUrl.pathname !== CREDENTIALS_CALLBACK_PATH) {
    return null;
  }

  let emailRaw: unknown;
  try {
    const clone = req.clone();
    const contentType = clone.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body: unknown = await clone.json();
      emailRaw = (body as Record<string, unknown> | null)?.email;
    } else {
      emailRaw = (await clone.formData()).get("email");
    }
  } catch {
    return null; // fail-open: NextAuth keeps owning malformed bodies
  }

  const identity = resolveLoginIdentity(req.headers, emailRaw);
  const verdict = await checkLoginAllowed(identity, nowMs, deps);
  if (verdict.allowed) return null;

  // Generic envelope — identical shape to the /api/v1 429 contract; it
  // never echoes the submitted identifier (no enumeration channel).
  const requestId = randomUUID();
  return NextResponse.json(
    rateLimitedBody(verdict.retryAfterSec, requestId),
    {
      status: 429,
      headers: rateLimitedHeaders(verdict.retryAfterSec, requestId),
    }
  );
}
