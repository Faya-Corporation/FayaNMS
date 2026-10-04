/**
 * F-034 documented follow-up — HIBP k-anonymity password-breach check.
 *
 * The offline common-password denylist in src/lib/auth/password.ts is the
 * always-on breach protection. This module adds the documented PRODUCTION
 * follow-up: a breach-corpus check against the Pwned Passwords range API
 * using k-anonymity — the password itself and even its full SHA-1 hash never
 * leave the process. Only the 5-character hash prefix is transmitted; the
 * response lists candidate suffixes with occurrence counts and the match
 * happens locally.
 *
 *   - SHA-1 (node:crypto), UPPERCASE hex → 5-char prefix + 35-char suffix.
 *   - GET https://api.pwnedpasswords.com/range/{prefix} with the
 *     "Add-Padding: true" etiquette header (response padding defeats
 *     prefix-length traffic analysis) and a proper User-Agent.
 *   - Response lines are "<35-char SUFFIX>:<COUNT>"; the candidate's suffix
 *     is matched case-insensitively.
 *
 * MODE GATE — FAYANMS_HIBP_MODE = off | enforce (default off), mirroring the
 * FAYANMS_MFA_MODE knob conventions exactly (src/lib/auth/mfa.ts):
 *   - off (default)  — the check is NEVER called: zero network, byte-unchanged
 *                      provisioning behavior. The offline denylist stays the
 *                      only breach protection; offline CI/sandboxes remain
 *                      hermetic.
 *   - enforce        — at the SAME enforcement points as the denylist
 *                      (admin user create / PATCH / reset-password — NEVER at
 *                      login; the login guard owns that plane) a password
 *                      that passed the offline policy is also checked BEFORE
 *                      acceptance:
 *                        * present in the corpus (occurrences > 0) →
 *                          PASSWORD_BREACHED (occurrence count in the error
 *                          detail);
 *                        * transport/timeout/malformed-response failure →
 *                          PASSWORD_BREACH_CHECK_UNAVAILABLE — a deliberate
 *                          FAIL-CLOSED posture (the same as the AI quota
 *                          store): the operator explicitly opted in, so a
 *                          password that cannot be verified is refused.
 *   Unknown values clamp to off with a one-shot [security-policy] warning
 *   (the established clamp pattern — never fatal, never silent).
 *
 * Timeout: FAYANMS_HIBP_TIMEOUT_MS (default 1500) clamped to 500–10000;
 * garbage falls back to the default (the documented login-guard convention).
 *
 * v1 HONEST LIMITATIONS (documented in .env.example + docs/runbooks/
 * deployment.md): no caching and no retries — each password SET performs at
 * most ONE range request; the breach corpus is HIBP's (by definition this
 * check can only answer "known to Have I Been Pwned"). Caching/retries are
 * the documented next steps, not silent behavior.
 */

import { createHash } from "node:crypto";

import { failWithDetail } from "@/app/api/v1/_lib/api";
import type { NextResponse } from "next/server";

/* ────────────────────────────── knobs (env) ────────────────────────────── */

export const HIBP_MODE_ENV = "FAYANMS_HIBP_MODE";
export const HIBP_TIMEOUT_ENV = "FAYANMS_HIBP_TIMEOUT_MS";

export type HibpMode = "off" | "enforce";

export const HIBP_DEFAULT_TIMEOUT_MS = 1500;
export const HIBP_MIN_TIMEOUT_MS = 500;
export const HIBP_MAX_TIMEOUT_MS = 10000;

/** One-shot warning dedupe (module lifetime), mirroring mfa.ts. */
let hibpModeWarned = false;

export function resetHibpModeForTests(): void {
  hibpModeWarned = false;
}

/**
 * Resolve FAYANMS_HIBP_MODE. Unset/empty → off (the hermetic default);
 * "enforce" → the production posture; anything else clamps to off with a
 * one-shot [security-policy] warning (never fatal, never silent).
 */
export function resolveHibpMode(env: NodeJS.ProcessEnv = process.env): HibpMode {
  const raw = env[HIBP_MODE_ENV]?.trim() ?? "";
  if (raw === "") return "off";
  const lowered = raw.toLowerCase();
  if (lowered === "enforce") return "enforce";
  if (lowered === "off") return "off";
  if (!hibpModeWarned) {
    hibpModeWarned = true;
    console.warn(
      `[security-policy] ${HIBP_MODE_ENV}: unknown value "${raw}" — ` +
        'clamped to "off" (valid values: off | enforce)'
    );
  }
  return "off";
}

/**
 * Resolve the range-request deadline. Unset/empty → the 1500 ms default;
 * a finite number clamps into 500..10000; garbage falls back to the default
 * (never zero, never unbounded — a misconfigured operator must not disable
 * the timeout by typo).
 */
export function resolveHibpTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[HIBP_TIMEOUT_ENV]?.trim() ?? "";
  if (raw === "") return HIBP_DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return HIBP_DEFAULT_TIMEOUT_MS;
  return Math.min(
    HIBP_MAX_TIMEOUT_MS,
    Math.max(HIBP_MIN_TIMEOUT_MS, Math.round(parsed))
  );
}

/* ─────────────────────────── range-API mechanics ───────────────────────── */

export const HIBP_RANGE_API_BASE = "https://api.pwnedpasswords.com/range/";
/** k-anonymity: exactly this many hash characters leave the process. */
export const HIBP_PREFIX_LENGTH = 5;
export const HIBP_SUFFIX_LENGTH = 35; // SHA-1 hex is 40 chars: 40 - 5.

/**
 * Identifies the deployment to the range API (etiquette; HIBP asks for a
 * meaningful User-Agent). Carries no secrets and no password material.
 */
export const HIBP_USER_AGENT =
  "FayaNMS (self-hosted network management system; k-anonymity breach check on password SET)";

/** Every failure of the CHECK ITSELF (transport, timeout, malformed body). */
export class HibpCheckUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HibpCheckUnavailableError";
  }
}

/** SHA-1 of the candidate, UPPERCASE hex — computed locally, never sent. */
export function sha1HexUpper(password: string): string {
  return createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
}

export interface HibpBreachResult {
  breached: boolean;
  occurrences: number;
}

/**
 * One range response line: "<35-char suffix>:<count>". Strict — HIBP pads
 * with leading zeros on the suffix, so the shape is deterministic; anything
 * else is a malformed response and the caller must fail closed.
 */
const RANGE_LINE_PATTERN = /^\s*([0-9A-Fa-f]{35}):\s*(\d+)\s*$/;

/**
 * Parse a range-API body and return how often the candidate's 35-char
 * suffix appears in it (case-insensitive on the hex). Throws
 * HibpCheckUnavailableError on ANY non-conforming non-empty line — a
 * partially parseable response cannot be trusted to prove absence.
 * A whitespace-only body parses as an empty range HERE (the pure helper),
 * but queryPwnedPasswordRange fails closed on it before calling this —
 * an empty 200 is an anomaly, not proof of absence.
 */
export function parseRangeBodyForSuffix(body: string, suffix: string): number {
  const wanted = suffix.toUpperCase();
  let occurrences = 0;
  for (const line of body.split("\n")) {
    if (line.trim() === "") continue;
    const match = RANGE_LINE_PATTERN.exec(line);
    if (!match) {
      throw new HibpCheckUnavailableError(
        "malformed range response — expected '<35-hex-suffix>:<count>' lines"
      );
    }
    if ((match[1] ?? "").toUpperCase() === wanted) {
      occurrences = Number.parseInt(match[2] ?? "0", 10);
    }
  }
  return occurrences;
}

/**
 * The k-anonymity core: hash locally, send ONLY the 5-char prefix, match
 * the suffix locally. Injectable fetch (and timeout override) keeps this
 * hermetically testable — production passes no options and pays at most
 * one request per password SET. No caching, no retries (v1 honest
 * simplicity — documented as follow-ups).
 */
export async function queryPwnedPasswordRange(
  password: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<HibpBreachResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? resolveHibpTimeoutMs();

  const hash = sha1HexUpper(password);
  const prefix = hash.slice(0, HIBP_PREFIX_LENGTH);
  const suffix = hash.slice(HIBP_PREFIX_LENGTH);

  // Bounded deadline covering the WHOLE exchange (connect, response, body —
  // an incomplete body is as unverifiable as a failed connection) without
  // depending on AbortSignal.timeout availability: an explicit controller +
  // timer, always cleared.
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(`HIBP range request timed out after ${timeoutMs} ms`)
      ),
    timeoutMs
  );

  try {
    const response = await doFetch(`${HIBP_RANGE_API_BASE}${prefix}`, {
      method: "GET",
      headers: {
        "Add-Padding": "true",
        "User-Agent": HIBP_USER_AGENT,
        Accept: "text/plain",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new HibpCheckUnavailableError(
        `HIBP range API answered HTTP ${response.status}`
      );
    }
    const body = await response.text();
    if (body.trim() === "") {
      // Post-register audit wave 5: a 200 with NO conforming lines is an
      // anomaly (real HIBP buckets hold hundreds of entries) — as
      // unverifiable as a malformed line, so it fails closed instead of
      // proving absence.
      throw new HibpCheckUnavailableError(
        "HIBP range API returned an empty 200 body — absence cannot be proven"
      );
    }
    const occurrences = parseRangeBodyForSuffix(body, suffix);
    return { breached: occurrences > 0, occurrences };
  } catch (error) {
    if (error instanceof HibpCheckUnavailableError) throw error;
    throw new HibpCheckUnavailableError(
      "HIBP range request failed (transport, timeout, or unreadable response)",
      { cause: error }
    );
  } finally {
    clearTimeout(timer);
  }
}

/* ────────────────────────── enforcement surface ────────────────────────── */

/**
 * Distinct machine-readable codes for the two refusals this module adds to
 * the password-policy family (PASSWORD_TOO_SHORT / PASSWORD_TOO_SHORT_FOR_ROLE
 * / PASSWORD_DENYLISTED — the PASSWORD_* naming is the family's convention).
 */
export type HibpErrorCode =
  | "PASSWORD_BREACHED"
  | "PASSWORD_BREACH_CHECK_UNAVAILABLE";

export interface PasswordBreachIssue {
  code: HibpErrorCode;
  message: string;
  /** Present ONLY for PASSWORD_BREACHED — the corpus occurrence count. */
  detail?: { occurrences: number };
}

/**
 * Enforcement gate for password SET surfaces (admin create / PATCH /
 * reset-password). Returns null when the password may proceed to hashing;
 * otherwise a typed issue for the route's error envelope.
 *
 * off → null immediately (no hashing, no network — byte-unchanged behavior).
 * enforce → the range check runs; a breach refuses with the occurrence
 * count and ANY check failure refuses fail-closed (the operator opted in;
 * an unverifiable password is not accepted — the AI-quota-store posture).
 * NEVER wired at login: the login guard owns the authentication plane,
 * exactly like the offline policy.
 */
export async function checkPasswordBreach(
  password: string,
  opts: {
    mode?: HibpMode;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<PasswordBreachIssue | null> {
  const mode = opts.mode ?? resolveHibpMode(opts.env);
  if (mode !== "enforce") return null;

  try {
    const { breached, occurrences } = await queryPwnedPasswordRange(password, {
      timeoutMs: opts.timeoutMs,
      fetchImpl: opts.fetchImpl,
    });
    if (!breached) return null;
    return {
      code: "PASSWORD_BREACHED",
      message: `password appears in known breach corpora ${occurrences} time(s) — choose a password that has not been breached`,
      detail: { occurrences },
    };
  } catch (error) {
    // Constant format string (W3-D precedent, unsafe-formatstring): the env
    // var NAME is a compile-time literal here — HIBP_MODE_ENV stays exported
    // for the env reads above, but logs must never treat identifiers as
    // format input. The caught error passes positionally.
    console.error(
      "[hibp] FAYANMS_HIBP_MODE=enforce but the breach check failed — refusing (fail-closed)",
      error
    );
    return {
      code: "PASSWORD_BREACH_CHECK_UNAVAILABLE",
      message:
        "the breach-corpus check could not be completed — refusing the password while the check is unavailable (fail-closed)",
    };
  }
}

/**
 * Route-side convenience: turn a breach issue into the standard error
 * envelope. failWithDetail omits the detail field when it is undefined, so
 * PASSWORD_BREACH_CHECK_UNAVAILABLE renders byte-identically to a plain
 * fail() while PASSWORD_BREACHED carries the occurrence count.
 */
export function breachIssueToFail(issue: PasswordBreachIssue): NextResponse {
  return failWithDetail(issue.code, issue.message, 400, issue.detail);
}
