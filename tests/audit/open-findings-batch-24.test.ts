/**
 * Open-findings batch 24 — F-034 (P3, A1-11): single-factor authn for an
 * NMS that pushes configurations to network devices.
 *
 *   History: sign-in was email+password (scrypt N=16384) with a minimum
 *   length of 8 and NO second factor anywhere; admin phishing /
 *   credential-stuffing was single-factor (the login guard bounds online
 *   brute force only). No second-factor flow existed for privileged roles.
 *
 *   The closure (the BACKLOG plan's two named phases):
 *     Phase 1 — role-aware password policy at every password SET surface
 *     (admin user creation, admin PATCH, admin reset — NEVER at login):
 *     privileged roles (admin, operator) need ≥ 12 chars (regular roles
 *     keep 8) and an OFFLINE common-password denylist applies to ALL
 *     roles. Honest limitation: the denylist is a compact embedded list —
 *     the production follow-up is a k-anonymity HIBP range-API check.
 *     Phase 2 — TOTP second factor for privileged roles: RFC 6238
 *     (HMAC-SHA1, 30 s step, 6 digits, ±1 step window) with node:crypto
 *     ONLY (zero new dependencies), Base32 codec in pure TS, secret at
 *     rest through the EXISTING enc1: AES-256-GCM envelope
 *     (FAYANMS_CONFIG_ENC_KEY, AAD-bound), enroll→confirm lifecycle,
 *     single-use recovery codes as a dedicated TABLE (conditional
 *     updateMany = atomic single-use), per-step anti-replay
 *     (UserMfa.lastTotpStep), the login challenge integrated into the
 *     NextAuth v4 credentials authorize() (the code rides the SAME
 *     sign-in POST), the FAYANMS_MFA_MODE rollback knob, and MFA_* audit
 *     rows.
 *
 *   Style: batch-22 pinning discipline — pure unit pins (TOTP RFC
 *   vectors, window, Base32, policy matrix, mode knob), DB-backed pins on
 *   SYNTHETIC FIXTURES ONLY (users prefixed batch24-f034-, fully removed
 *   with residue verification), live handler pins through the real routes
 *   with minted session cookies (the rt012/batch-11 rig), and source pins
 *   for the wiring contracts.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { db } from "../../src/lib/db";
import {
  MIN_PASSWORD_LENGTH,
  PASSWORD_DENYLIST,
  PRIVILEGED_MIN_PASSWORD_LENGTH,
  PRIVILEGED_PASSWORD_ROLES,
  hashPassword,
  isPrivilegedPasswordRole,
  validatePasswordPolicy,
} from "../../src/lib/auth/password";
import {
  MFA_MODE_ENV,
  RECOVERY_CODE_COUNT,
  TOTP_DIGITS,
  TOTP_ISSUER,
  TOTP_STEP_SECONDS,
  TOTP_WINDOW_STEPS,
  base32Decode,
  base32Encode,
  evaluateMfaChallenge,
  generateTotpSecret,
  otpauthUri,
  recoveryCodeHash,
  resetMfaModeForTests,
  resolveMfaMode,
  totpCodeAt,
  verifyTotpCode,
} from "../../src/lib/auth/mfa";

/* ── synthetic fixtures (never a seeded row) ──────────────────────────── */

const FIXTURE_PREFIX = "batch24-f034-";
const testStartedAt = new Date();

let admin: { id: string; email: string } | null = null;
let operator: { id: string; email: string } | null = null;
let viewer: { id: string; email: string } | null = null;

let mfaResidueBefore = 0;

async function ensureFixtureUser(
  email: string,
  role: string
): Promise<{ id: string; email: string }> {
  const user = await db.user.upsert({
    where: { email },
    update: { role, isActive: true },
    create: { email, name: `F034 ${role}`, role, isActive: true },
    select: { id: true, email: true },
  });
  return user;
}

/** Mint a REAL next-auth session cookie for a synthetic user. */
async function sessionCookieFor(user: { id: string; email: string; role: string }): Promise<string> {
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

beforeAll(async () => {
  // Leftovers from an aborted earlier run must never skew the fixtures.
  await db.user.deleteMany({ where: { email: { startsWith: FIXTURE_PREFIX } } });
  mfaResidueBefore = await db.userMfa.count();
  admin = await ensureFixtureUser(`${FIXTURE_PREFIX}admin@faya.local`, "admin");
  operator = await ensureFixtureUser(`${FIXTURE_PREFIX}operator@faya.local`, "operator");
  viewer = await ensureFixtureUser(`${FIXTURE_PREFIX}viewer@faya.local`, "viewer");
  // The fail-tight disable route re-verifies the account password — give
  // the synthetic operator a real scrypt hash (never a seeded row).
  await db.user.update({
    where: { id: operator.id },
    data: { passwordHash: await hashPassword("batch24-Operator!2026") },
  });
});

afterAll(async () => {
  resetMfaModeForTests();
  delete process.env.FAYANMS_MFA_MODE;
  // Synthetic users only; UserMfa/UserMfaRecoveryCode cascade by FK.
  await db.user.deleteMany({ where: { email: { startsWith: FIXTURE_PREFIX } } });
  // Audit rows this suite created (all carry a synthetic actor id — both
  // the MFA_* rows AND the USER_CREATED/USER_UPDATED/USER_PASSWORD_RESET
  // rows authored by the synthetic admin through the admin routes; the
  // login-guard suite's actorId-scoped cleanup is the precedent).
  const syntheticIds = [admin?.id, operator?.id, viewer?.id].filter(
    (id): id is string => typeof id === "string"
  );
  if (syntheticIds.length > 0) {
    await db.auditEvent.deleteMany({
      where: { actorId: { in: syntheticIds }, createdAt: { gte: testStartedAt } },
    });
  }
  // Residue verification: no MFA rows may remain (was mfaResidueBefore).
  expect(await db.userMfa.count()).toBe(mfaResidueBefore);
  expect(await db.user.count({ where: { email: { startsWith: FIXTURE_PREFIX } } })).toBe(0);
});

/* ── Phase 1: the role-aware password policy (pure) ───────────────────── */

describe("F-034 phase 1 — role-aware password policy (pure)", () => {
  test("privileged roles keep the 12-char bar; regular roles keep 8", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
    expect(PRIVILEGED_MIN_PASSWORD_LENGTH).toBe(12);
    expect(PRIVILEGED_PASSWORD_ROLES).toEqual(["admin", "operator"]);
    expect(isPrivilegedPasswordRole("admin")).toBe(true);
    expect(isPrivilegedPasswordRole("operator")).toBe(true);
    expect(isPrivilegedPasswordRole("engineer")).toBe(false);
    expect(isPrivilegedPasswordRole("auditor")).toBe(false);
    expect(isPrivilegedPasswordRole("manager")).toBe(false);
    expect(isPrivilegedPasswordRole("viewer")).toBe(false);
  });

  test("privileged 11 chars → PASSWORD_TOO_SHORT_FOR_ROLE; 12 → accepted", () => {
    const tooShort = validatePasswordPolicy("Abcd12!ab12", "admin");
    expect(tooShort?.code).toBe("PASSWORD_TOO_SHORT_FOR_ROLE");
    expect(tooShort?.message).toContain("admin");
    expect(tooShort?.message).toContain("12");
    expect(validatePasswordPolicy("N0c-Device!2026", "operator")).toBeNull();
    // Exactly at the bar.
    expect(validatePasswordPolicy("Abcd12!ab123", "operator")).toBeNull();
  });

  test("regular 8 chars still accepted; 7 refused with the baseline code", () => {
    expect(validatePasswordPolicy("Abcd12!x", "viewer")).toBeNull();
    expect(validatePasswordPolicy("Abcd12!x", "engineer")).toBeNull();
    const baseline = validatePasswordPolicy("Abc12!x", "viewer");
    expect(baseline?.code).toBe("PASSWORD_TOO_SHORT");
  });

  test("the denylist refuses common passwords for ALL roles (case-tolerant)", () => {
    expect(PASSWORD_DENYLIST.size).toBeGreaterThanOrEqual(200);
    // Privileged roles need a ≥12-char denylisted entry (the role-aware
    // length check deliberately wins for shorter ones — see below).
    for (const role of ["admin", "operator"]) {
      expect(validatePasswordPolicy("administrator", role)?.code).toBe("PASSWORD_DENYLISTED");
    }
    for (const role of ["engineer", "manager", "auditor", "viewer"]) {
      expect(validatePasswordPolicy("qwertyuiop", role)?.code).toBe("PASSWORD_DENYLISTED");
      expect(validatePasswordPolicy("QWERTYUIOP", role)?.code).toBe("PASSWORD_DENYLISTED");
    }
    // Privileged + too short + denylisted → the ROLE refusal wins (more specific).
    expect(validatePasswordPolicy("password", "admin")?.code).toBe("PASSWORD_TOO_SHORT_FOR_ROLE");
    // The seeded demo password is deliberately NOT denylisted (policy runs
    // at SET time only — resetting demo users stays possible).
    expect(PASSWORD_DENYLIST.has("faya123")).toBe(false);
  });
});

describe("F-034 phase 1 — enforcement is wired at every SET surface (source)", () => {
  const read = (p: string): string => readFileSync(join("src", p), "utf8");

  test("all three admin surfaces call validatePasswordPolicy BEFORE hashPassword", () => {
    const create = read("app/api/v1/admin/users/route.ts");
    expect(create).toContain("validatePasswordPolicy(data.password, data.role)");
    const patch = read("app/api/v1/admin/users/[id]/route.ts");
    // Effective role: the payload's role wins when a promotion rides along.
    expect(patch).toContain("const effectiveRole = data.role ?? target.role;");
    expect(patch).toContain("validatePasswordPolicy(data.password, effectiveRole)");
    const reset = read("app/api/v1/admin/users/[id]/reset-password/route.ts");
    expect(reset).toContain("validatePasswordPolicy(parsed.data.password, target.role)");
    for (const source of [create, patch, reset]) {
      expect(source.indexOf("validatePasswordPolicy(")).toBeGreaterThan(-1);
      expect(source.indexOf("validatePasswordPolicy(")).toBeLessThan(source.indexOf("hashPassword("));
      // The typed refusal propagates verbatim into the error envelope —
      // the DISTINCT machine-readable codes (PASSWORD_TOO_SHORT_FOR_ROLE /
      // PASSWORD_DENYLISTED / PASSWORD_TOO_SHORT) reach the API caller
      // through policyIssue.code, pinned live in the next handler test.
      expect(source).toContain("fail(policyIssue.code, policyIssue.message, 400)");
    }
  });

  test("the policy NEVER runs at login (options.ts stays policy-free)", () => {
    const options = read("lib/auth/options.ts");
    expect(options).not.toContain("validatePasswordPolicy");
  });

  test("LIVE HANDLER PIN: admin create/reset answer the policy codes", async () => {
    expect(admin).not.toBeNull();
    const cookie = await sessionCookieFor({ id: admin!.id, email: admin!.email, role: "admin" });
    const createMod = await import("../../src/app/api/v1/admin/users/route");

    // Operator + 11 chars → refused with the role-aware code.
    const refused = await createMod.POST(
      jsonRequest("http://app.local/api/v1/admin/users", "POST", cookie, {
        email: `${FIXTURE_PREFIX}new-op@faya.local`,
        name: "F034 New Operator",
        role: "operator",
        password: "Abcd12!ab12",
      })
    );
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error?: { code?: string } }).error?.code).toBe(
      "PASSWORD_TOO_SHORT_FOR_ROLE"
    );

    // Denylisted password for the LOWEST role → still refused.
    const denylisted = await createMod.POST(
      jsonRequest("http://app.local/api/v1/admin/users", "POST", cookie, {
        email: `${FIXTURE_PREFIX}new-viewer@faya.local`,
        name: "F034 New Viewer",
        role: "viewer",
        password: "qwertyuiop",
      })
    );
    expect(denylisted.status).toBe(400);
    expect(((await denylisted.json()) as { error?: { code?: string } }).error?.code).toBe(
      "PASSWORD_DENYLISTED"
    );

    // 12-char operator → created; 8-char viewer → created (regular bar).
    const okOperator = await createMod.POST(
      jsonRequest("http://app.local/api/v1/admin/users", "POST", cookie, {
        email: `${FIXTURE_PREFIX}new-op@faya.local`,
        name: "F034 New Operator",
        role: "operator",
        password: "N0c-Device!2026",
      })
    );
    expect(okOperator.status).toBe(201);
    const okViewer = await createMod.POST(
      jsonRequest("http://app.local/api/v1/admin/users", "POST", cookie, {
        email: `${FIXTURE_PREFIX}new-viewer@faya.local`,
        name: "F034 New Viewer",
        role: "viewer",
        password: "viewer-pass-1",
      })
    );
    expect(okViewer.status).toBe(201);

    // PATCH: an 11-char password cannot ride along an admin promotion, but
    // the same PATCH with 12 chars succeeds. (The _lib envelope wraps the
    // payload: { success, data: { user: … }, meta }.)
    const createdOp = ((await okOperator.json()) as { data?: { user?: { id: string } } }).data?.user;
    const createdViewer = ((await okViewer.json()) as { data?: { user?: { id: string } } }).data?.user;
    expect(createdOp?.id).toBeDefined();
    expect(createdViewer?.id).toBeDefined();
    const patchMod = await import("../../src/app/api/v1/admin/users/[id]/route");
    const rideAlong = await patchMod.PATCH(
      jsonRequest(
        `http://app.local/api/v1/admin/users/${createdViewer!.id}`,
        "PATCH",
        cookie,
        { role: "operator", password: "Abcd12!ab12" }
      ),
      { params: Promise.resolve({ id: createdViewer!.id }) }
    );
    expect(rideAlong.status).toBe(400);
    expect(((await rideAlong.json()) as { error?: { code?: string } }).error?.code).toBe(
      "PASSWORD_TOO_SHORT_FOR_ROLE"
    );
    const promoted = await patchMod.PATCH(
      jsonRequest(
        `http://app.local/api/v1/admin/users/${createdViewer!.id}`,
        "PATCH",
        cookie,
        { role: "operator", password: "N0c-Device!2026" }
      ),
      { params: Promise.resolve({ id: createdViewer!.id }) }
    );
    expect(promoted.status).toBe(200);

    // reset-password: the TARGET's role decides (operator below 12 → refused).
    const resetMod = await import("../../src/app/api/v1/admin/users/[id]/reset-password/route");
    const resetRefused = await resetMod.POST(
      jsonRequest(
        `http://app.local/api/v1/admin/users/${createdOp!.id}/reset-password`,
        "POST",
        cookie,
        { password: "Abcd12!ab12" }
      ),
      { params: Promise.resolve({ id: createdOp!.id }) }
    );
    expect(resetRefused.status).toBe(400);
    expect(((await resetRefused.json()) as { error?: { code?: string } }).error?.code).toBe(
      "PASSWORD_TOO_SHORT_FOR_ROLE"
    );
    const resetOk = await resetMod.POST(
      jsonRequest(
        `http://app.local/api/v1/admin/users/${createdOp!.id}/reset-password`,
        "POST",
        cookie,
        { password: "N0c-Device!2027" }
      ),
      { params: Promise.resolve({ id: createdOp!.id }) }
    );
    expect(resetOk.status).toBe(200);
  });
});

/* ── Phase 2: TOTP engine (pure RFC pins) ─────────────────────────────── */

describe("F-034 phase 2 — TOTP engine (RFC 6238 SHA-1 vectors)", () => {
  // RFC 6238 Appendix B secret for SHA-1: ASCII "12345678901234567890"
  // = Base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ. The 6-digit codes are the
  // decimal last-6 of the RFC's 8-digit vector table (value mod 10^6).
  const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  test("RFC vectors: T=59 → 287082, T=1111111109 → 081804, T=1234567890 → 005924", () => {
    expect(TOTP_STEP_SECONDS).toBe(30);
    expect(TOTP_DIGITS).toBe(6);
    expect(totpCodeAt(RFC_SECRET, 59)).toBe("287082");
    expect(totpCodeAt(RFC_SECRET, 1_111_111_109)).toBe("081804");
    expect(totpCodeAt(RFC_SECRET, 1_234_567_890)).toBe("005924");
  });

  test("the ±1 step window accepts neighbors and rejects ±2", () => {
    expect(TOTP_WINDOW_STEPS).toBe(1);
    const t0 = 1_111_111_100; // step 37037036 (floor(1111111109/30) neighbor)
    const code = totpCodeAt(RFC_SECRET, t0);
    expect(verifyTotpCode(RFC_SECRET, code, t0).matched).toBe(true);
    expect(verifyTotpCode(RFC_SECRET, code, t0 + TOTP_STEP_SECONDS).matched).toBe(true);
    expect(verifyTotpCode(RFC_SECRET, code, t0 - TOTP_STEP_SECONDS).matched).toBe(true);
    expect(verifyTotpCode(RFC_SECRET, code, t0 + 2 * TOTP_STEP_SECONDS).matched).toBe(false);
    expect(verifyTotpCode(RFC_SECRET, code, t0 - 2 * TOTP_STEP_SECONDS).matched).toBe(false);
    expect(verifyTotpCode(RFC_SECRET, "000000", t0).matched).toBe(false);
    // Malformed shapes never throw.
    expect(verifyTotpCode(RFC_SECRET, "12a456", t0).matched).toBe(false);
    expect(verifyTotpCode(RFC_SECRET, "12345", t0).matched).toBe(false);
    expect(verifyTotpCode(RFC_SECRET, null, t0).matched).toBe(false);
  });

  test("Base32 codec: RFC 4648 vectors + round-trip + case/whitespace + strictness", () => {
    // RFC 4648 test vectors (padding tolerated on decode, never emitted).
    expect(base32Encode(new TextEncoder().encode("f"))).toBe("MY");
    expect(base32Encode(new TextEncoder().encode("fo"))).toBe("MZXQ");
    expect(base32Encode(new TextEncoder().encode("foo"))).toBe("MZXW6");
    expect(base32Encode(new TextEncoder().encode("foob"))).toBe("MZXW6YQ");
    expect(base32Encode(new TextEncoder().encode("fooba"))).toBe("MZXW6YTB");
    expect(base32Encode(new TextEncoder().encode("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Decode("MZXW6YTBOI======").toString()).toBe("foobar");
    // Round-trip across sizes 1..64.
    for (let size = 1; size <= 64; size++) {
      const bytes = new Uint8Array(size).map((_, i) => (i * 37 + 11) % 256);
      expect(base32Decode(base32Encode(bytes))).toEqual(Buffer.from(bytes));
    }
    // Lowercase + whitespace/dash tolerated; invalid character throws.
    expect(base32Decode("mzxw 6y-tb").toString()).toBe("fooba");
    expect(() => base32Decode("MZXW6YTBO1")).toThrow(); // '1' is not Base32
    // Generated secrets decode to 20 bytes (160-bit).
    expect(base32Decode(generateTotpSecret()).length).toBe(20);
  });

  test("otpauth URI carries issuer FayaNMS and the RFC profile", () => {
    const uri = otpauthUri("ABC234DEF567", `${FIXTURE_PREFIX}operator@faya.local`);
    expect(uri.startsWith(`otpauth://totp/${TOTP_ISSUER}%3A`)).toBe(true);
    expect(uri).toContain("issuer=FayaNMS");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
    expect(uri).toContain("secret=ABC234DEF567");
  });
});

/* ── Phase 2: enrollment lifecycle + login challenge (DB fixtures) ────── */

describe("F-034 phase 2 — enroll → confirm → challenge → disable (DB)", () => {
  let secret = "";
  let recoveryCodes: string[] = [];
  const NOW = new Date("2026-10-03T12:00:00.000Z"); // step anchor: floor(...)
  const unixAt = (ms: number): number => Math.floor(ms / 1000);

  test("enroll generates a secret, stores it ENCRYPTED at rest, row DISABLED", async () => {
    const { beginMfaEnrollment } = await import("../../src/lib/auth/mfa");
    const enrollment = await beginMfaEnrollment(operator!);
    secret = enrollment.secret;
    expect(base32Decode(secret).length).toBe(20);

    const row = await db.userMfa.findUnique({ where: { userId: operator!.id } });
    expect(row).not.toBeNull();
    expect(row!.enabled).toBe(false);
    // Encrypted-at-rest pin: the enc1: envelope, never the plaintext secret.
    expect(row!.totpSecretEnc.startsWith("enc1:")).toBe(true);
    expect(row!.totpSecretEnc).not.toContain(secret);
    // AAD-bound to the user id (transplanting fails authentication).
    expect(row!.totpSecretEnc.split(":").length).toBe(5);

    // Re-enrolling rotates the pending secret; the row stays disabled.
    const rotated = await beginMfaEnrollment(operator!);
    expect(rotated.secret).not.toBe(secret);
    secret = rotated.secret;
    const rotatedRow = await db.userMfa.findUnique({ where: { userId: operator!.id } });
    expect(rotatedRow!.enabled).toBe(false);
    expect(rotatedRow!.totpSecretEnc).not.toBe(row!.totpSecretEnc);

    // The enroll path wrote one MFA_ENROLLED audit row per call.
    const audits = await db.auditEvent.count({
      where: { actorId: operator!.id, action: "MFA_ENROLLED" },
    });
    expect(audits).toBe(2);
  });

  test("confirm with a WRONG code refuses and leaves the row disabled", async () => {
    const { confirmMfaEnrollment } = await import("../../src/lib/auth/mfa");
    const wrong = totpCodeAt(secret, unixAt(NOW.getTime()) - 10 * TOTP_STEP_SECONDS);
    expect(confirmMfaEnrollment(operator!, wrong, { now: NOW })).rejects.toMatchObject({
      code: "MFA_CODE_INVALID",
    });
    expect((await db.userMfa.findUnique({ where: { userId: operator!.id } }))!.enabled).toBe(false);
  });

  test("confirm with the RIGHT code enables + issues single-use recovery codes", async () => {
    const { confirmMfaEnrollment } = await import("../../src/lib/auth/mfa");
    const code = totpCodeAt(secret, unixAt(NOW.getTime()));
    const result = await confirmMfaEnrollment(operator!, code, { now: NOW });
    recoveryCodes = result.recoveryCodes;
    expect(recoveryCodes.length).toBe(RECOVERY_CODE_COUNT);
    expect(RECOVERY_CODE_COUNT).toBe(10);

    const row = await db.userMfa.findUnique({ where: { userId: operator!.id } });
    expect(row!.enabled).toBe(true);
    // The confirming code's step is consumed — it cannot be replayed at login.
    expect(row!.lastTotpStep).toBe(Math.floor(unixAt(NOW.getTime()) / TOTP_STEP_SECONDS));
    const hashes = await db.userMfaRecoveryCode.findMany({ where: { mfaId: row!.id } });
    expect(hashes.length).toBe(RECOVERY_CODE_COUNT);
    // Only hashes at rest — and they hash-match the returned plaintexts.
    expect(hashes.every((h) => /^[0-9a-f]{64}$/.test(h.codeHash))).toBe(true);
    expect(hashes.every((h) => h.usedAt === null)).toBe(true);
    const expectedHashes = new Set(recoveryCodes.map(recoveryCodeHash));
    expect(new Set(hashes.map((h) => h.codeHash))).toEqual(expectedHashes);
    // Plaintext recovery codes never touch the database.
    for (const code of recoveryCodes) {
      const stored = hashes.map((h) => h.codeHash).join("|");
      expect(stored).not.toContain(code);
    }
    const confirmed = await db.auditEvent.findFirst({
      where: { actorId: operator!.id, action: "MFA_CONFIRMED" },
    });
    expect(confirmed).not.toBeNull();
  });

  test("login challenge: TOTP within window passes and stamps anti-replay", async () => {
    // Step right AFTER the confirm step (the confirm consumed its own).
    const after = new Date(NOW.getTime() + TOTP_STEP_SECONDS * 1000);
    const code = totpCodeAt(secret, unixAt(after.getTime()));
    const verdict = await evaluateMfaChallenge(operator!, code, { now: after });
    expect(verdict).toMatchObject({ outcome: "passed", via: "totp" });
    const row = await db.userMfa.findUnique({ where: { userId: operator!.id } });
    expect(row!.lastTotpStep).toBe(Math.floor(unixAt(after.getTime()) / TOTP_STEP_SECONDS));
  });

  test("login challenge: the same step replays → MFA_CODE_REPLAYED; absent code → required", async () => {
    // Same step as the previous (passed) login — the anti-replay write
    // (lastTotpStep must be strictly behind) makes the second use fail.
    const sameStep = new Date(NOW.getTime() + TOTP_STEP_SECONDS * 1000 + 5_000);
    const replay = await evaluateMfaChallenge(
      operator!,
      totpCodeAt(secret, unixAt(sameStep.getTime())),
      { now: sameStep }
    );
    expect(replay).toMatchObject({ outcome: "failed", reason: "MFA_CODE_REPLAYED" });

    const absent = await evaluateMfaChallenge(operator!, undefined, { now: sameStep });
    expect(absent).toMatchObject({ outcome: "failed", reason: "MFA_CODE_REQUIRED" });

    const garbage = await evaluateMfaChallenge(operator!, "9z!", { now: sameStep });
    expect(garbage).toMatchObject({ outcome: "failed", reason: "MFA_CODE_INVALID" });

    // Outside the window (the candidate step is ±5 away, window is ±1)
    // → plain invalid: the code for the CURRENT anchor step (already
    // consumed by confirm) no longer matches 150 s later.
    const farFuture = new Date(NOW.getTime() + 5 * TOTP_STEP_SECONDS * 1000);
    const stale = await evaluateMfaChallenge(
      operator!,
      totpCodeAt(secret, unixAt(NOW.getTime())),
      { now: farFuture }
    );
    expect(stale).toMatchObject({ outcome: "failed", reason: "MFA_CODE_INVALID" });

    const failures = await db.auditEvent.count({
      where: { actorId: operator!.id, action: "MFA_LOGIN_FAILED" },
    });
    expect(failures).toBe(4);
  });

  test("recovery codes are single-use: first consumes, second is rejected", async () => {
    const later = new Date(NOW.getTime() + 10 * TOTP_STEP_SECONDS * 1000);
    const first = await evaluateMfaChallenge(operator!, recoveryCodes[0], { now: later });
    expect(first).toMatchObject({ outcome: "passed", via: "recovery" });
    // Case/dash tolerance does NOT resurrect a consumed code.
    const second = await evaluateMfaChallenge(
      operator!,
      recoveryCodes[0].toLowerCase().replace("-", ""),
      { now: later }
    );
    expect(second).toMatchObject({ outcome: "failed", reason: "MFA_CODE_INVALID" });
    const usedAt = await db.userMfaRecoveryCode.findFirst({
      where: { codeHash: recoveryCodeHash(recoveryCodes[0]) },
    });
    expect(usedAt?.usedAt).not.toBeNull();
    const recovered = await db.auditEvent.findFirst({
      where: { actorId: operator!.id, action: "MFA_RECOVERY_USED" },
    });
    expect(recovered).not.toBeNull();
  });

  test("an unenrolled user bypasses; the disabled knob bypasses ENROLLED users", async () => {
    // viewer has no UserMfa row → single factor as before.
    const bypassed = await evaluateMfaChallenge(viewer!, "123456", { now: NOW });
    expect(bypassed).toMatchObject({ outcome: "bypassed", reason: "NOT_ENROLLED" });

    // Rollback lever: FAYANMS_MFA_MODE=disabled bypasses even ENABLED rows.
    process.env.FAYANMS_MFA_MODE = "disabled";
    resetMfaModeForTests();
    const off = await evaluateMfaChallenge(operator!, undefined, { now: NOW });
    expect(off).toMatchObject({ outcome: "bypassed", reason: "MFA_DISABLED" });
  });

  test("the mode knob: unknown values clamp to enforce with a [security-policy] warning", () => {
    resetMfaModeForTests();
    delete process.env[MFA_MODE_ENV];
    expect(resolveMfaMode()).toBe("enforce");
    process.env[MFA_MODE_ENV] = "DISABLED";
    expect(resolveMfaMode()).toBe("disabled");
    process.env[MFA_MODE_ENV] = "off";
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message?: unknown) => warnings.push(String(message));
    try {
      expect(resolveMfaMode()).toBe("enforce");
    } finally {
      console.warn = original;
    }
    expect(warnings.some((w) => w.includes("[security-policy]") && w.includes(MFA_MODE_ENV))).toBe(true);
    // The warning is one-shot per process.
    const warningsAfter = warnings.length;
    resolveMfaMode();
    expect(warnings.length).toBe(warningsAfter);
    delete process.env[MFA_MODE_ENV];
    resetMfaModeForTests();
  });

  test("LIVE HANDLER PIN: enroll answers MFA_DISABLED with the knob off", async () => {
    process.env.FAYANMS_MFA_MODE = "disabled";
    resetMfaModeForTests();
    try {
      const cookie = await sessionCookieFor({ id: operator!.id, email: operator!.email, role: "operator" });
      const mod = await import("../../src/app/api/v1/auth/mfa/enroll/route");
      const res = await mod.POST(
        new NextRequest("http://app.local/api/v1/auth/mfa/enroll", {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookie },
        })
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe("MFA_DISABLED");
    } finally {
      delete process.env.FAYANMS_MFA_MODE;
      resetMfaModeForTests();
    }
  });

  test("LIVE HANDLER PIN: enroll is role-gated; anonymous fails closed", async () => {
    // viewer session → 403 RBAC_FORBIDDEN (the second factor is privileged-only).
    const viewerCookie = await sessionCookieFor({ id: viewer!.id, email: viewer!.email, role: "viewer" });
    const mod = await import("../../src/app/api/v1/auth/mfa/enroll/route");
    const forbidden = await mod.POST(
      new NextRequest("http://app.local/api/v1/auth/mfa/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: viewerCookie },
      })
    );
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json()) as { error?: { code?: string } }).error?.code).toBe(
      "RBAC_FORBIDDEN"
    );

    // No cookie at all → 401 UNAUTHENTICATED (the route owns the public-
    // bootstrap prefix: /api/v1/auth/* skips the proxy session gate).
    const anonymous = await mod.POST(
      new NextRequest("http://app.local/api/v1/auth/mfa/enroll", { method: "POST" })
    );
    expect(anonymous.status).toBe(401);
    expect(((await anonymous.json()) as { error?: { code?: string } }).error?.code).toBe(
      "UNAUTHENTICATED"
    );
  });

  test("LIVE HANDLER PIN: DELETE disable is fail-tight (password AND code)", async () => {
    const cookie = await sessionCookieFor({ id: operator!.id, email: operator!.email, role: "operator" });
    const url = "http://app.local/api/v1/auth/mfa";
    const mod = await import("../../src/app/api/v1/auth/mfa/route");

    // Wrong password → refused even with a valid code.
    const goodCode = totpCodeAt(secret, Math.floor(Date.now() / 1000));
    const wrongPassword = await mod.DELETE(
      jsonRequest(url, "DELETE", cookie, { password: "not-the-password", code: goodCode })
    );
    expect(wrongPassword.status).toBe(400);
    expect(((await wrongPassword.json()) as { error?: { code?: string } }).error?.code).toBe(
      "MFA_PASSWORD_INVALID"
    );

    // Right password, stale code → refused.
    const staleCode = totpCodeAt(secret, Math.floor(Date.now() / 1000) - 10 * TOTP_STEP_SECONDS);
    const wrongCode = await mod.DELETE(
      jsonRequest(url, "DELETE", cookie, { password: "batch24-Operator!2026", code: staleCode })
    );
    expect(wrongCode.status).toBe(400);
    expect(((await wrongCode.json()) as { error?: { code?: string } }).error?.code).toBe(
      "MFA_CODE_INVALID"
    );
    expect((await db.userMfa.findUnique({ where: { userId: operator!.id } }))!.enabled).toBe(true);

    // Right password + a valid CURRENT code → disabled, rows gone (cascade).
    const ok = await mod.DELETE(
      jsonRequest(url, "DELETE", cookie, {
        password: "batch24-Operator!2026",
        code: totpCodeAt(secret, Math.floor(Date.now() / 1000)),
      })
    );
    expect(ok.status).toBe(200);
    expect(await db.userMfa.findUnique({ where: { userId: operator!.id } })).toBeNull();
    expect(
      await db.userMfaRecoveryCode.count({ where: { codeHash: recoveryCodeHash(recoveryCodes[1]) } })
    ).toBe(0);
    const disabled = await db.auditEvent.findFirst({
      where: { actorId: operator!.id, action: "MFA_DISABLED" },
    });
    expect(disabled).not.toBeNull();
  });
});

describe("F-034 phase 2 — wiring pins (source + schema)", () => {
  const read = (p: string): string => readFileSync(join(".", p), "utf8");

  test("authorize() integrates the challenge AFTER the password and counts failures", () => {
    const options = read("src/lib/auth/options.ts");
    expect(options).toContain("evaluateMfaChallenge(user, submittedCode)");
    const verifyAt = options.indexOf("verifyPassword(password, user.passwordHash)");
    const mfaAt = options.indexOf("evaluateMfaChallenge(user, submittedCode)");
    expect(verifyAt).toBeGreaterThan(-1);
    expect(mfaAt).toBeGreaterThan(verifyAt);
    expect(options.indexOf("recordLoginFailure(loginIdentity)", mfaAt)).toBeGreaterThan(-1);
    // The credentials model: the second factor rides the SAME sign-in POST.
    expect(options).toContain('totp: { label: "2FA code", type: "text" }');
  });

  test("the login form posts the optional 2FA field; the session surface exposes mfaEnabled", () => {
    const gate = read("src/components/auth/sign-in-gate.tsx");
    expect(gate).toContain('totp: totp.trim()');
    expect(gate).toContain('id="sign-in-totp"');
    expect(gate).toContain('autoComplete="one-time-code"');
    const session = read("src/app/api/v1/auth/session/route.ts");
    expect(session).toContain("mfaEnabled: mfa?.enabled === true");
  });

  test("schema: recovery codes are ROWS (atomic single-use), cascades bound to User", () => {
    const schema = read("prisma/schema.prisma");
    const mfaBlock = schema.slice(schema.indexOf("model UserMfa "), schema.indexOf("model UserMfaRecoveryCode"));
    expect(mfaBlock).toContain("userId         String   @unique");
    expect(mfaBlock).toContain('user           User     @relation(fields: [userId], references: [id], onDelete: Cascade)');
    expect(mfaBlock).toContain("totpSecretEnc  String");
    expect(mfaBlock).toContain("enabled        Boolean  @default(false)");
    expect(mfaBlock).toContain("lastTotpStep   Int?");
    const recoveryBlock = schema.slice(schema.indexOf("model UserMfaRecoveryCode"));
    expect(recoveryBlock).toContain("codeHash  String");
    expect(recoveryBlock).toContain("usedAt    DateTime?");
    // The JSON-array design the plan rejected: no primitive array column.
    expect(schema).not.toContain("recoveryCodesJson");
  });

  test("the committed migration is additive SQL matching the schema", () => {
    const migration = read("prisma/migrations/20261003030000_add_user_mfa/migration.sql");
    expect(migration).toContain('CREATE TABLE "UserMfa"');
    expect(migration).toContain('CREATE TABLE "UserMfaRecoveryCode"');
    expect(migration).toContain('ON DELETE CASCADE');
    expect(migration).toContain('CREATE UNIQUE INDEX "UserMfa_userId_key"');
    expect(migration).not.toMatch(/DROP TABLE|DROP COLUMN|ALTER COLUMN/i);
  });

  test("the rollback knob + honest limitation are documented where operators read", () => {
    expect(read(".env.example")).toContain("FAYANMS_MFA_MODE");
    expect(read(".env.example")).toContain("enforce");
    const runbook = read("docs/runbooks/deployment.md");
    expect(runbook).toContain("FAYANMS_MFA_MODE");
    expect(runbook).toContain("FAYANMS_CONFIG_ENC_KEY");
    expect(runbook).toContain("single-use recovery codes");
    const matrix = read("docs/security/authorization-matrix.md");
    expect(matrix).toContain("/auth/mfa/enroll");
    expect(matrix).toContain("/auth/mfa/confirm");
    expect(matrix).toContain("fail-tight disable");
  });
});
