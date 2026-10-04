/**
 * F-034 phase 2 — TOTP second factor for privileged roles (admin/operator).
 *
 * A config-pushing NMS must not rest on a single password factor. This
 * module implements the whole second-factor plane with ZERO new runtime
 * dependencies:
 *
 *   - Base32 codec (RFC 4648) — pure TypeScript, needed because the
 *     authenticator-app provisioning format (otpauth://) carries the
 *     secret Base32-encoded.
 *   - TOTP (RFC 6238) — HMAC-SHA1, 30 s step, 6 digits, ±1 step acceptance
 *     window (the Google Authenticator default profile).
 *   - At-rest protection — the secret is stored ONLY through the SAME
 *     enc1: AES-256-GCM envelope the webhook signing secrets use
 *     (src/lib/config/crypto.ts, FAYANMS_CONFIG_ENC_KEY master key),
 *     AAD-bound to the user id. No new key, no invented crypto.
 *   - Recovery codes — 10 single-use codes; stored as sha256 hashes in the
 *     dedicated UserMfaRecoveryCode TABLE (not a JSON array) so consumption
 *     is ONE conditional updateMany (usedAt: null → stamped) — an atomic
 *     single-use guarantee.
 *   - Anti-replay — the highest accepted TOTP time-step is persisted
 *     (UserMfa.lastTotpStep) and a candidate step S is accepted only when
 *     S > lastTotpStep via a conditional updateMany; exactly one sign-in
 *     wins per time-step (a code reused inside its validity window is
 *     rejected with MFA_CODE_REPLAYED). Documented tradeoff: two sign-ins
 *     inside the same 30 s step need a recovery code — the honest cost of
 *     replay protection.
 *
 * ROLLBACK (the plan's disable flag): FAYANMS_MFA_MODE=enforce|disabled.
 *   - enforce (default)  — enrollment allowed, enabled rows challenge at
 *                          sign-in.
 *   - disabled           — the second factor is structurally OFF:
 *                          enrollment routes answer MFA_DISABLED and every
 *                          existing enrollment is BYPASSED at sign-in.
 *                          This is a documented, deliberate FAIL-OPEN — the
 *                          operator's rollback lever when a lost device
 *                          would otherwise lock out the NOC.
 *   Unknown values clamp to enforce with a one-shot [security-policy]
 *   warning (the established warning channel/prefix).
 *
 * Failure posture: EVERYTHING here fails closed on the login path (an
 * invalid/absent code is a failed sign-in covered by the login guard's
 * brute-force budget); audit rows (MFA_*) never block the flow they
 * describe.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { fail } from "@/app/api/v1/_lib/api";
import { decryptAtRest, encryptAtRest } from "@/lib/config/crypto";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/password";

/* ───────────────────────────── Base32 (RFC 4648) ──────────────────────── */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const BASE32_LOOKUP: Map<string, number> = new Map(
  BASE32_ALPHABET.split("").map((char, index) => [char, index])
);

/** Encode bytes as unpadded Base32 (RFC 4648). */
export function base32Encode(bytes: Uint8Array): string {
  let output = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/**
 * Decode Base32 (padded or unpadded, case-insensitive, whitespace/dash
 * tolerated). Throws on characters outside the alphabet — provisioning
 * secrets must never be silently mangled.
 */
export function base32Decode(input: string): Buffer {
  const cleaned = input.replace(/[\s-=]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const index = BASE32_LOOKUP.get(char);
    if (index === undefined) {
      throw new Error(`Invalid base32 character: ${JSON.stringify(char)}`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/* ─────────────────────────── TOTP (RFC 6238) ──────────────────────────── */

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** ±1 step acceptance window (the standard authenticator tolerance). */
export const TOTP_WINDOW_STEPS = 1;

/** Generate a fresh 160-bit TOTP secret, Base32 (unpadded). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function hotpSha1(key: Buffer, counter: number): string {
  // 8-byte big-endian moving factor (RFC 4226 §5.1)
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(message).digest();
  // Dynamic truncation (RFC 4226 §5.3)
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return (binary % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, "0");
}

function normalizeTotpCode(code: string | null | undefined): string | null {
  if (code === null || code === undefined) return null;
  const trimmed = String(code).replace(/[\s-]/g, "");
  if (!/^\d{6}$/.test(trimmed)) return null;
  return trimmed;
}

/** The TOTP code for a secret at an absolute unix timestamp (seconds). */
export function totpCodeAt(secret: string, unixSeconds: number): string {
  const step = Math.floor(unixSeconds / TOTP_STEP_SECONDS);
  return hotpSha1(base32Decode(secret), step);
}

export interface TotpVerification {
  matched: boolean;
  /** The matched time-step (valid only when matched). */
  step: number;
}

/**
 * Verify a 6-digit code against a Base32 secret within ±TOTP_WINDOW_STEPS
 * of `unixSeconds`. Constant-time code comparison per candidate step.
 */
export function verifyTotpCode(
  secret: string,
  code: string | null | undefined,
  unixSeconds: number
): TotpVerification {
  const normalized = normalizeTotpCode(code);
  if (!normalized) return { matched: false, step: 0 };
  const key = base32Decode(secret);
  const currentStep = Math.floor(unixSeconds / TOTP_STEP_SECONDS);
  const candidate = Buffer.from(normalized, "utf8");
  for (let delta = -TOTP_WINDOW_STEPS; delta <= TOTP_WINDOW_STEPS; delta++) {
    const step = currentStep + delta;
    const expected = Buffer.from(hotpSha1(key, step), "utf8");
    if (timingSafeEqual(candidate, expected)) {
      return { matched: true, step };
    }
  }
  return { matched: false, step: 0 };
}

/* ─────────────────────── otpauth provisioning URI ─────────────────────── */

/** Issuer shown in authenticator apps. */
export const TOTP_ISSUER = "FayaNMS";

export function otpauthUri(secret: string, email: string): string {
  const label = encodeURIComponent(`${TOTP_ISSUER}:${email}`);
  const issuer = encodeURIComponent(TOTP_ISSUER);
  return (
    `otpauth://totp/${label}?secret=${secret}` +
    `&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}` +
    `&period=${TOTP_STEP_SECONDS}`
  );
}

/* ──────────────────────── at-rest secret envelope ─────────────────────── */

/** AAD context binding a TOTP-secret ciphertext to its owner row. */
export function mfaSecretAad(userId: string): string {
  return `user-mfa-totp|v1|${userId}`;
}

function encryptTotpSecret(secret: string, userId: string): string {
  return encryptAtRest(secret, mfaSecretAad(userId));
}

function decryptTotpSecret(stored: string, userId: string): string {
  return decryptAtRest(stored, mfaSecretAad(userId));
}

/* ──────────────────────────── mode knob (rollback) ────────────────────── */

export const MFA_MODE_ENV = "FAYANMS_MFA_MODE";
export type MfaMode = "enforce" | "disabled";
/** One-shot warning dedupe (module lifetime). */
let mfaModeWarned = false;

export function resetMfaModeForTests(): void {
  mfaModeWarned = false;
}

/**
 * Resolve FAYANMS_MFA_MODE. Unset/empty → enforce; "disabled" → the
 * documented rollback lever; anything else clamps to enforce with a
 * one-shot [security-policy] warning (never fatal, never silent).
 */
export function resolveMfaMode(env: NodeJS.ProcessEnv = process.env): MfaMode {
  const raw = env[MFA_MODE_ENV]?.trim() ?? "";
  if (raw === "") return "enforce";
  const lowered = raw.toLowerCase();
  if (lowered === "enforce") return "enforce";
  if (lowered === "disabled") return "disabled";
  if (!mfaModeWarned) {
    mfaModeWarned = true;
    console.warn(
      `[security-policy] ${MFA_MODE_ENV}: unknown value "${raw}" — ` +
        'clamped to "enforce" (valid values: enforce | disabled)'
    );
  }
  return "enforce";
}

/* ────────────────────────────── recovery codes ────────────────────────── */

export const RECOVERY_CODE_COUNT = 10;
/** Unambiguous alphabet (no 0/O/1/I/L) for human-typed codes. */
const RECOVERY_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** Format: XXXX-XXXX (dash purely visual; verification strips it). */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    codes.push(`${randomRecoveryBody(4)}-${randomRecoveryBody(4)}`);
  }
  return codes;
}

/**
 * Bias-free random draw from RECOVERY_ALPHABET (31 chars): bytes ≥ 31*8=248
 * are rejected so the modulo is exactly uniform.
 */
function randomRecoveryBody(length: number): string {
  let body = "";
  while (body.length < length) {
    const bytes = randomBytes(length);
    for (const byte of bytes) {
      if (body.length >= length) break;
      if (byte >= RECOVERY_ALPHABET.length * 8) continue; // rejection sample
      body += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
    }
  }
  return body;
}

/** Normalize a typed recovery code (case/dash/space tolerant) → sha256 hex. */
export function recoveryCodeHash(code: string): string {
  const normalized = code.replace(/[\s-]/g, "").toUpperCase();
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/* ─────────────────────────── typed module errors ──────────────────────── */

export type MfaErrorCode =
  | "MFA_DISABLED"
  | "MFA_ALREADY_ENABLED"
  | "MFA_NOT_ENROLLED"
  | "MFA_CODE_REQUIRED"
  | "MFA_CODE_INVALID"
  | "MFA_PASSWORD_INVALID"
  | "MFA_FORBIDDEN_ROLE";

export class MfaError extends Error {
  readonly code: MfaErrorCode;
  readonly status: number;

  constructor(code: MfaErrorCode, message: string, status = 400) {
    super(message);
    this.name = "MfaError";
    this.code = code;
    this.status = status;
  }
}

/** Map an MfaError to the standard error envelope; null for foreign errors. */
export function mfaErrorToFail(error: unknown): ReturnType<typeof fail> | null {
  if (error instanceof MfaError) {
    return fail(error.code, error.message, error.status);
  }
  return null;
}

/* ──────────────────────────── audit (best-effort) ─────────────────────── */

async function auditMfa(input: {
  userId: string;
  actorName: string;
  action:
    | "MFA_ENROLLED"
    | "MFA_CONFIRMED"
    | "MFA_DISABLED"
    | "MFA_RECOVERY_USED"
    | "MFA_LOGIN_FAILED"
    | "MFA_CONFIRM_FAILED"
    | "MFA_DISABLE_FAILED";
  result: "SUCCESS" | "FAILURE";
  detail: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.auditEvent.create({
      data: {
        actorId: input.userId,
        actorName: input.actorName,
        action: input.action,
        resourceType: "User",
        resourceId: input.userId,
        resourceLabel: input.actorName,
        result: input.result,
        afterJson: JSON.stringify(input.detail),
      },
    });
  } catch {
    // Auditing must never block the auth flow it describes.
  }
}

/* ─────────────────────── the challenge (login plane) ──────────────────── */

export type MfaChallengeOutcome =
  | { outcome: "bypassed"; reason: "MFA_DISABLED" | "NOT_ENROLLED" }
  | { outcome: "passed"; via: "totp"; step: number }
  | { outcome: "passed"; via: "recovery" }
  | {
      outcome: "failed";
      reason: "MFA_CODE_REQUIRED" | "MFA_CODE_INVALID" | "MFA_CODE_REPLAYED";
    };

/**
 * Evaluate the second factor for `user` with the code submitted alongside
 * the password (NextAuth v4 credentials extension — the login form posts
 * the code in the SAME sign-in POST).
 *
 * Pure-ish contract pinned by tests: bypass rules first (mode disabled →
 * structurally off; no enabled enrollment → single factor as before), then
 * the code check (TOTP within the ±1 window + step anti-replay, else a
 * single-use recovery code), then failure with a typed reason. Failures are
 * audited MFA_LOGIN_FAILED; recovery consumption is audited
 * MFA_RECOVERY_USED. Both audit writes are best-effort.
 */
export async function evaluateMfaChallenge(
  user: { id: string; email: string },
  code: string | null | undefined,
  opts: { now?: Date; mode?: MfaMode } = {}
): Promise<MfaChallengeOutcome> {
  const mode = opts.mode ?? resolveMfaMode();
  if (mode === "disabled") {
    return { outcome: "bypassed", reason: "MFA_DISABLED" };
  }

  const mfa = await db.userMfa.findUnique({
    where: { userId: user.id },
    select: { id: true, enabled: true, totpSecretEnc: true, lastTotpStep: true },
  });
  if (!mfa || !mfa.enabled) {
    return { outcome: "bypassed", reason: "NOT_ENROLLED" };
  }

  const now = opts.now ?? new Date();
  const unixSeconds = Math.floor(now.getTime() / 1000);

  if (typeof code !== "string" || code.trim() === "") {
    await auditMfa({
      userId: user.id,
      actorName: user.email,
      action: "MFA_LOGIN_FAILED",
      result: "FAILURE",
      detail: { reason: "MFA_CODE_REQUIRED" },
    });
    return { outcome: "failed", reason: "MFA_CODE_REQUIRED" };
  }

  // First factor for the second factor: the TOTP code itself.
  let secret: string;
  try {
    secret = decryptTotpSecret(mfa.totpSecretEnc, user.id);
  } catch {
    // A broken envelope must never yield a silent single-factor login.
    await auditMfa({
      userId: user.id,
      actorName: user.email,
      action: "MFA_LOGIN_FAILED",
      result: "FAILURE",
      detail: { reason: "MFA_CODE_INVALID" },
    });
    return { outcome: "failed", reason: "MFA_CODE_INVALID" };
  }
  const verification = verifyTotpCode(secret, code, unixSeconds);
  if (verification.matched) {
    const step = verification.step;
    // Anti-replay: one conditional write decides the winner for this step
    // (lastTotpStep must still be behind the candidate step — or unset).
    const claimed = await db.userMfa.updateMany({
      where: {
        id: mfa.id,
        lastTotpStep: mfa.lastTotpStep === null ? null : { lt: step },
      },
      data: { lastTotpStep: step },
    });
    if (claimed.count === 1) {
      return { outcome: "passed", via: "totp", step };
    }
    await auditMfa({
      userId: user.id,
      actorName: user.email,
      action: "MFA_LOGIN_FAILED",
      result: "FAILURE",
      detail: { reason: "MFA_CODE_REPLAYED", step },
    });
    return { outcome: "failed", reason: "MFA_CODE_REPLAYED" };
  }

  // Second factor fallback: a single-use recovery code (any non-empty
  // string is hashed and looked up — 6-digit TOTP shapes simply miss). The
  // conditional updateMany (usedAt: null → stamped) makes double-use
  // impossible — exactly one concurrent caller gets count === 1.
  const consumed = await db.userMfaRecoveryCode.updateMany({
    where: {
      mfaId: mfa.id,
      codeHash: recoveryCodeHash(code),
      usedAt: null,
    },
    data: { usedAt: now },
  });
  if (consumed.count === 1) {
    await auditMfa({
      userId: user.id,
      actorName: user.email,
      action: "MFA_RECOVERY_USED",
      result: "SUCCESS",
      detail: { via: "recovery" },
    });
    return { outcome: "passed", via: "recovery" };
  }

  await auditMfa({
    userId: user.id,
    actorName: user.email,
    action: "MFA_LOGIN_FAILED",
    result: "FAILURE",
    detail: { reason: "MFA_CODE_INVALID" },
  });
  return { outcome: "failed", reason: "MFA_CODE_INVALID" };
}

/* ──────────────────── enrollment lifecycle (session plane) ────────────── */

export interface MfaEnrollment {
  secret: string;
  otpauth: string;
}

/**
 * Begin self-service enrollment: generate a fresh secret and return the
 * provisioning URI. The row is stored DISABLED — nothing challenges at
 * sign-in until the first valid code confirms possession (confirm).
 * Re-enrolling over a pending (unconfirmed) row rotates the secret;
 * an already-ENABLED row requires disable first.
 */
export async function beginMfaEnrollment(user: {
  id: string;
  email: string;
}): Promise<MfaEnrollment> {
  if (resolveMfaMode() === "disabled") {
    throw new MfaError(
      "MFA_DISABLED",
      "Multi-factor authentication is disabled by FAYANMS_MFA_MODE — the rollback lever is set to disabled."
    );
  }
  const existing = await db.userMfa.findUnique({
    where: { userId: user.id },
    select: { enabled: true },
  });
  if (existing?.enabled) {
    throw new MfaError(
      "MFA_ALREADY_ENABLED",
      "Multi-factor authentication is already enabled — disable it before re-enrolling.",
      409
    );
  }

  const secret = generateTotpSecret();
  await db.userMfa.upsert({
    where: { userId: user.id },
    update: {
      // Rotate the pending secret and clear stale anti-replay state.
      totpSecretEnc: encryptTotpSecret(secret, user.id),
      enabled: false,
      lastTotpStep: null,
    },
    create: {
      userId: user.id,
      totpSecretEnc: encryptTotpSecret(secret, user.id),
      enabled: false,
    },
  });

  await auditMfa({
    userId: user.id,
    actorName: user.email,
    action: "MFA_ENROLLED",
    result: "SUCCESS",
    detail: { stage: "pending-confirm" },
  });

  return { secret, otpauth: otpauthUri(secret, user.email) };
}

/**
 * Confirm enrollment with the first valid code (proves the user actually
 * provisioned the secret into an authenticator). Atomically flips enabled,
 * stamps the anti-replay step so the confirming code cannot be replayed at
 * sign-in, and generates the single-use recovery codes (plaintexts are
 * returned EXACTLY ONCE; only sha256 hashes are stored).
 *
 * Fail-closed details (post-register audit wave 5):
 *   - the knob gates confirm the same way it gates enroll — a pending row
 *     can NEVER flip enabled while FAYANMS_MFA_MODE=disabled;
 *   - the ENABLED flip is a conditional claim (`enabled: false` in the
 *     where) inside the transaction — two concurrent confirms cannot both
 *     win and silently invalidate the first caller's issued recovery
 *     codes (the loser answers MFA_ALREADY_ENABLED);
 *   - a failed code verification is audited MFA_CONFIRM_FAILED so the
 *     guessing attempt leaves an audit trail.
 */
export async function confirmMfaEnrollment(
  user: { id: string; email: string },
  code: string | null | undefined,
  opts: { now?: Date } = {}
): Promise<{ recoveryCodes: string[] }> {
  if (resolveMfaMode() === "disabled") {
    throw new MfaError(
      "MFA_DISABLED",
      "Multi-factor authentication is disabled by FAYANMS_MFA_MODE — the rollback lever is set to disabled."
    );
  }
  const mfa = await db.userMfa.findUnique({
    where: { userId: user.id },
    select: { id: true, enabled: true, totpSecretEnc: true },
  });
  if (!mfa) {
    throw new MfaError(
      "MFA_NOT_ENROLLED",
      "No pending enrollment — call POST /api/v1/me/mfa/enroll first."
    );
  }
  if (mfa.enabled) {
    throw new MfaError(
      "MFA_ALREADY_ENABLED",
      "Multi-factor authentication is already enabled.",
      409
    );
  }

  if (typeof code !== "string" || code.trim() === "") {
    throw new MfaError(
      "MFA_CODE_REQUIRED",
      "Provide the 6-digit code from your authenticator app to confirm enrollment."
    );
  }

  let secret: string;
  try {
    secret = decryptTotpSecret(mfa.totpSecretEnc, user.id);
  } catch {
    throw new MfaError(
      "MFA_CODE_INVALID",
      "The stored enrollment secret is unreadable — re-enroll.",
      409
    );
  }

  const unixSeconds = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const verification = verifyTotpCode(secret, code, unixSeconds);
  if (!verification.matched) {
    await auditMfa({
      userId: user.id,
      actorName: user.email,
      action: "MFA_CONFIRM_FAILED",
      result: "FAILURE",
      detail: { reason: "MFA_CODE_INVALID" },
    });
    throw new MfaError(
      "MFA_CODE_INVALID",
      "That code does not match the pending enrollment secret."
    );
  }

  const recoveryCodes = generateRecoveryCodes();
  await db.$transaction(async (tx) => {
    // Conditional claim — only a still-DISABLED row can flip. Two
    // concurrent confirms of the same pending enrollment produce exactly
    // one winner; the loser's MFA_ALREADY_ENABLED propagates out of the
    // transaction (its locally generated codes are never returned).
    const claimed = await tx.userMfa.updateMany({
      where: { id: mfa.id, enabled: false },
      data: { enabled: true, lastTotpStep: verification.step },
    });
    if (claimed.count !== 1) {
      throw new MfaError(
        "MFA_ALREADY_ENABLED",
        "Multi-factor authentication is already enabled.",
        409
      );
    }
    // Fresh codes for a fresh enrollment (replaces any stale pending set).
    await tx.userMfaRecoveryCode.deleteMany({ where: { mfaId: mfa.id } });
    await tx.userMfaRecoveryCode.createMany({
      data: recoveryCodes.map((code) => ({
        mfaId: mfa.id,
        codeHash: recoveryCodeHash(code),
      })),
    });
  });

  await auditMfa({
    userId: user.id,
    actorName: user.email,
    action: "MFA_CONFIRMED",
    result: "SUCCESS",
    detail: {
      via: "totp",
      step: verification.step,
      recoveryCodesIssued: recoveryCodes.length,
    },
  });

  return { recoveryCodes };
}

/**
 * Disable (fail-tight): requires the account password AND a valid current
 * TOTP code or an unused recovery code — a stolen session alone can never
 * strip the second factor. Deletes the enrollment (recovery codes cascade)
 * and stamps the anti-replay state with it.
 *
 * Post-register audit wave 5: failed verification attempts are audited
 * (MFA_DISABLE_FAILED) so an online guessing attack against the password
 * re-entry or the code leaves an audit trail; the route layer additionally
 * feeds guessing-class failures into the login guard's account budget.
 */
export async function disableMfa(
  user: { id: string; email: string },
  password: string | null | undefined,
  code: string | null | undefined,
  opts: { now?: Date } = {}
): Promise<void> {
  if (typeof password !== "string" || password.length === 0) {
    throw new MfaError(
      "MFA_PASSWORD_INVALID",
      "Re-enter your password to disable multi-factor authentication."
    );
  }
  const account = await db.user.findUnique({
    where: { id: user.id },
    select: { passwordHash: true },
  });
  if (!account || !(await verifyPassword(password, account.passwordHash))) {
    await auditMfa({
      userId: user.id,
      actorName: user.email,
      action: "MFA_DISABLE_FAILED",
      result: "FAILURE",
      detail: { reason: "MFA_PASSWORD_INVALID" },
    });
    throw new MfaError(
      "MFA_PASSWORD_INVALID",
      "Password re-entry failed — multi-factor authentication stays enabled."
    );
  }

  const mfa = await db.userMfa.findUnique({
    where: { userId: user.id },
    select: { id: true, enabled: true, totpSecretEnc: true },
  });
  if (!mfa || !mfa.enabled) {
    throw new MfaError(
      "MFA_NOT_ENROLLED",
      "Multi-factor authentication is not enabled for this account."
    );
  }

  if (typeof code !== "string" || code.trim() === "") {
    throw new MfaError(
      "MFA_CODE_REQUIRED",
      "Provide a current 6-digit code or an unused recovery code to disable."
    );
  }

  let matched = false;
  let secret = "";
  try {
    secret = decryptTotpSecret(mfa.totpSecretEnc, user.id);
  } catch {
    secret = "";
  }
  if (secret) {
    const unixSeconds = Math.floor((opts.now ?? new Date()).getTime() / 1000);
    matched = verifyTotpCode(secret, code, unixSeconds).matched;
  }
  if (!matched) {
    // Recovery-code fallback (single-use consumption, same as login).
    const consumed = await db.userMfaRecoveryCode.updateMany({
      where: {
        mfaId: mfa.id,
        codeHash: recoveryCodeHash(code),
        usedAt: null,
      },
      data: { usedAt: opts.now ?? new Date() },
    });
    if (consumed.count === 1) {
      await auditMfa({
        userId: user.id,
        actorName: user.email,
        action: "MFA_RECOVERY_USED",
        result: "SUCCESS",
        detail: { via: "recovery", context: "disable" },
      });
      matched = true;
    }
  }
  if (!matched) {
    await auditMfa({
      userId: user.id,
      actorName: user.email,
      action: "MFA_DISABLE_FAILED",
      result: "FAILURE",
      detail: { reason: "MFA_CODE_INVALID" },
    });
    throw new MfaError(
      "MFA_CODE_INVALID",
      "That code is not a current TOTP code or an unused recovery code."
    );
  }

  await db.userMfa.delete({ where: { id: mfa.id } });

  await auditMfa({
    userId: user.id,
    actorName: user.email,
    action: "MFA_DISABLED",
    result: "SUCCESS",
    detail: { via: "self-disable" },
  });
}
