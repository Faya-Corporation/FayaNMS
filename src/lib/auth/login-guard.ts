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
 * RESOURCE SAFETY: bounded in-memory store — MAX_LOGIN_GUARD_KEYS keys
 * (stale-first sweep to half the cap when exceeded), MAX_FAILURE_STAMPS_PER_KEY
 * timestamps per key. The store sits behind the LoginGuardStore interface so
 * SCALE-001-A can slot a shared backend (Redis/Postgres) in without touching
 * call sites. Known, documented limitation: the in-memory default is
 * per-process — the shared store is a separate, explicitly tracked task.
 *
 * TELEMETRY: typed audit events (SIGNIN_THROTTLED / SIGNIN_LOCKOUT) written
 * to the existing AuditEvent trail at most once per key per window (never a
 * per-attempt row storm). Rows carry actorId null (pre-auth — no fabricated
 * actor FK), actorName "login-guard", the keyed account hash and the
 * sanitized source key — never a raw email, never a password. Telemetry
 * failures never break the sign-in path.
 */

import { createHmac, randomUUID } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/lib/db";
import {
  rateLimitedBody,
  rateLimitedHeaders,
  resolveClientIp,
} from "@/lib/api/rate-gate";

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
  get(key: string): LoginKeyState | undefined;
  set(key: string, state: LoginKeyState): void;
  delete(key: string): void;
  size(): number;
  entries(): IterableIterator<[string, LoginKeyState]>;
}

/**
 * Bounded in-memory default (single process). SCALE-001-A landed the shared
 * store for the API rate gate (rate-store.ts, FAYANMS_RATE_STORE=postgres);
 * a distributed backend for THIS guard's read-modify-write state needs the
 * same atomic per-key transaction shape — tracked as TASK-SCALE-001-B (a
 * plain get/set KV over SQL is NOT atomic across instances and is refused
 * as a false fix).
 */
export function createMemoryLoginGuardStore(): LoginGuardStore {
  const map = new Map<string, LoginKeyState>();
  return {
    get: (key) => map.get(key),
    set: (key, state) => void map.set(key, state),
    delete: (key) => void map.delete(key),
    size: () => map.size,
    entries: () => map.entries(),
  };
}

let globalStore: LoginGuardStore = createMemoryLoginGuardStore();

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
    store: deps.store ?? globalStore,
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

/** Once-per-window telemetry rule: bounded rows, no per-attempt storm. */
async function maybeEmit(
  state: LoginKeyState,
  action: LoginTelemetryAction,
  identity: LoginAttemptIdentity,
  now: number,
  windowMs: number,
  sink: LoginTelemetrySink
): Promise<void> {
  if (
    state.denialEmittedAt !== 0 &&
    now - state.denialEmittedAt < windowMs
  ) {
    return;
  }
  state.denialEmittedAt = now;
  await sink({
    action,
    sourceKey: identity.sourceKey,
    accountHash: identity.accountHash,
  });
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

/**
 * Decide whether a credential sign-in attempt may proceed to verification.
 * Denied attempts on a LOCKED account are recorded (bounded) so sustained
 * hammering keeps the failure window hot and the backoff escalates; denied
 * attempts on a merely THROTTLED source consume no slots (truthful
 * Retry-After, mirroring the API gate's sliding-window semantics).
 */
export async function checkLoginAllowed(
  identity: LoginAttemptIdentity,
  nowMs: number = Date.now(),
  deps: LoginGuardDeps = {}
): Promise<LoginVerdict> {
  const { store, sink, cfg } = resolveDeps(deps);
  const now = nowMs;

  // 1. Source dimension — plain sliding budget.
  const sKey = sourceKeyOf(identity);
  const src = store.get(sKey);
  if (src) {
    prune(src, now, cfg.windowMs);
    if (src.failures.length >= cfg.maxPerSource) {
      await maybeEmit(src, "SIGNIN_THROTTLED", identity, now, cfg.windowMs, sink);
      store.set(sKey, src);
      return {
        allowed: false,
        retryAfterSec: retryFromOldest(src, now, cfg.windowMs),
        reason: "source_throttled",
      };
    }
    if (src.failures.length === 0) store.delete(sKey);
    else store.set(sKey, src);
  }

  // 2. Account dimension — budget + escalating temporary lockout.
  const aKey = accountKeyOf(identity);
  const acct = store.get(aKey);
  if (acct) {
    prune(acct, now, cfg.windowMs);
    if (acct.lockoutUntil > now) {
      // Denied while locked: keep the window hot (drives escalation).
      pushCapped(acct, now);
      await maybeEmit(acct, "SIGNIN_LOCKOUT", identity, now, cfg.windowMs, sink);
      store.set(aKey, acct);
      return {
        allowed: false,
        retryAfterSec: Math.max(
          1,
          Math.ceil((acct.lockoutUntil - now) / 1000)
        ),
        reason: "account_locked",
      };
    }
    if (acct.failures.length === 0 && acct.lockoutCount > 0) {
      // Window slid clean with no lockout pending → full decay.
      acct.lockoutCount = 0;
      store.delete(aKey);
      return { allowed: true, retryAfterSec: 0, reason: "ok" };
    }
    if (acct.failures.length >= cfg.maxPerAccount) {
      acct.lockoutCount += 1;
      const backoff = backoffFor(acct.lockoutCount);
      acct.lockoutUntil = now + backoff;
      pushCapped(acct, now);
      await maybeEmit(acct, "SIGNIN_LOCKOUT", identity, now, cfg.windowMs, sink);
      store.set(aKey, acct);
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil(backoff / 1000)),
        reason: "account_locked",
      };
    }
    store.set(aKey, acct);
  }

  return { allowed: true, retryAfterSec: 0, reason: "ok" };
}

/**
 * Record one FAILED verification (unknown account, disabled-hash account or
 * wrong password) against BOTH dimensions. Crossing either budget flips the
 * state and emits the typed telemetry event (once per key per window).
 */
export async function recordLoginFailure(
  identity: LoginAttemptIdentity,
  nowMs: number = Date.now(),
  deps: LoginGuardDeps = {}
): Promise<void> {
  const { store, sink, cfg } = resolveDeps(deps);
  const now = nowMs;

  const sKey = sourceKeyOf(identity);
  const src = store.get(sKey) ?? emptyState();
  prune(src, now, cfg.windowMs);
  pushCapped(src, now);
  const sourceCrossed = src.failures.length >= cfg.maxPerSource;
  store.set(sKey, src);
  if (sourceCrossed) {
    await maybeEmit(src, "SIGNIN_THROTTLED", identity, now, cfg.windowMs, sink);
  }

  const aKey = accountKeyOf(identity);
  const acct = store.get(aKey) ?? emptyState();
  prune(acct, now, cfg.windowMs);
  pushCapped(acct, now);
  if (acct.lockoutUntil <= now && acct.failures.length >= cfg.maxPerAccount) {
    acct.lockoutCount += 1;
    acct.lockoutUntil = now + backoffFor(acct.lockoutCount);
    await maybeEmit(acct, "SIGNIN_LOCKOUT", identity, now, cfg.windowMs, sink);
  }
  store.set(aKey, acct);

  if (store.size() > MAX_LOGIN_GUARD_KEYS) {
    sweepStore(store, now, cfg.windowMs);
  }
}

/**
 * Successful authentication: reset the (source, account) state immediately
 * (the intended reset policy — a legit user who fat-fingered a few times
 * starts from a clean budget after signing in).
 */
export async function recordLoginSuccess(
  identity: LoginAttemptIdentity,
  _nowMs: number = Date.now(),
  deps: LoginGuardDeps = {}
): Promise<void> {
  const { store } = resolveDeps(deps);
  store.delete(sourceKeyOf(identity));
  store.delete(accountKeyOf(identity));
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
