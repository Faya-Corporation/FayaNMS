/**
 * GA-6 / P2-S01 (2026-10-06 re-audit) — ABSOLUTE human session lifetime.
 *
 * The wave-11 honesty correction established that next-auth v4's
 * `session.maxAge` is a SLIDING inactivity window: the core session route
 * re-encodes the token with a FRESH `exp` on every /api/auth/session
 * fetch, so a continuously-used session never dies. This module closes
 * that gap with a TRUE absolute cap anchored on the token's `iat`.
 *
 * Why `iat` is a sound anchor (verified empirically against next-auth v4
 * in this repo): `jwt.encode` mints `iat` ONCE at the initial encode and
 * PRESERVES it on every re-encode — only `exp` is refreshed. The claims
 * the app's jwt callback carries therefore always know when the SESSION
 * was originally authenticated, no matter how many sliding refreshes
 * happened since.
 *
 * Enforcement point: the authOptions `jwt` callback's refresh path — a
 * token whose absolute lifetime is exceeded gets its claims STRIPPED
 * (the same contract as a mid-session deactivation), so requireUser and
 * the middleware treat the request as unauthenticated and the next
 * /api/auth/session fetch drops the session. The check runs BEFORE the
 * DB refresh: an expired token costs no database work.
 *
 * Configuration (env lever, per the remediation plan):
 *   FAYANMS_SESSION_MAX_AGE_HOURS — absolute lifetime cap in hours.
 *     default 12 (NOC-shift scale, mirrors session.maxAge);
 *     0 = legacy OFF (the documented rollback lever);
 *     invalid/negative values FAIL SAFE to the default (the cap stays
 *     enforced — a typo can never silently disable it).
 */

export const SESSION_MAX_AGE_HOURS_DEFAULT = 12;

/** Parse the env lever; invalid input fails SAFE to the default cap. */
export function sessionMaxAgeHours(): number {
  const raw = process.env.FAYANMS_SESSION_MAX_AGE_HOURS?.trim() ?? "";
  if (raw === "") return SESSION_MAX_AGE_HOURS_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(
      `[session-lifetime] FAYANMS_SESSION_MAX_AGE_HOURS="${raw}" is not a valid non-negative number — failing safe to the ${SESSION_MAX_AGE_HOURS_DEFAULT}h default (the absolute cap stays enforced)`
    );
    return SESSION_MAX_AGE_HOURS_DEFAULT;
  }
  return parsed;
}

/**
 * TRUE when the token's ABSOLUTE lifetime is exceeded (the session must
 * die even though the sliding window keeps renewing). Fail-closed: a
 * token with no usable `iat` anchor counts as expired. Accepts the
 * next-auth JWT structurally (it extends Record<string, unknown>).
 */
export function absoluteSessionLifetimeExceeded(
  token: Record<string, unknown> | undefined,
  nowS: number = Date.now() / 1000
): boolean {
  const capHours = sessionMaxAgeHours();
  if (capHours === 0) return false; // documented legacy-off lever
  const iatRaw = token?.iat;
  const iat =
    typeof iatRaw === "number" && Number.isFinite(iatRaw) ? iatRaw : undefined;
  if (iat === undefined) return true; // no issuance anchor → fail closed
  return nowS - iat > capHours * 3600;
}
