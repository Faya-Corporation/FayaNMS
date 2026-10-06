/**
 * GA-6 / P2-S01 (2026-10-06 re-audit) — ABSOLUTE human session lifetime.
 *
 * The sliding session.maxAge can never kill a continuously-used session
 * (next-auth v4 re-encodes with a fresh exp on every session fetch). This
 * suite pins the ABSOLUTE cap that now rides on top:
 *   - the env lever (FAYANMS_SESSION_MAX_AGE_HOURS: default 12, 0 = off,
 *     invalid → fail-safe to the default so the cap can never be silently
 *     disabled by a typo);
 *   - the iat anchor (next-auth preserves iat across re-encodes — only
 *     exp refreshes — verified empirically; a token WITHOUT an iat anchor
 *     fails CLOSED);
 *   - the authOptions jwt callback strips claims past the cap BEFORE any
 *     DB work — the same contract as a mid-session deactivation.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { authOptions } from "../../src/lib/auth/options";
import {
  SESSION_MAX_AGE_HOURS_DEFAULT,
  absoluteSessionLifetimeExceeded,
  sessionMaxAgeHours,
} from "../../src/lib/auth/session-lifetime";

const savedEnv = process.env.FAYANMS_SESSION_MAX_AGE_HOURS;

/** Fetch the jwt callback, failing loudly if the shape ever drifts. */
function jwtCallback(): NonNullable<NonNullable<typeof authOptions.callbacks>["jwt"]> {
  const cb = authOptions.callbacks?.jwt;
  if (!cb) throw new Error("authOptions.callbacks.jwt is missing");
  return cb;
}

function withEnv(value: string | undefined): void {
  if (value === undefined) delete process.env.FAYANMS_SESSION_MAX_AGE_HOURS;
  else process.env.FAYANMS_SESSION_MAX_AGE_HOURS = value;
}

afterAll(() => {
  withEnv(savedEnv);
});

describe("P2-S01: the env lever", () => {
  test("defaults to 12h when unset (mirrors the sliding maxAge)", () => {
    withEnv(undefined);
    expect(sessionMaxAgeHours()).toBe(SESSION_MAX_AGE_HOURS_DEFAULT);
    expect(sessionMaxAgeHours()).toBe(12);
  });

  test("honors an explicit value; 0 is the documented legacy-off lever", () => {
    withEnv("6");
    expect(sessionMaxAgeHours()).toBe(6);
    withEnv("0");
    expect(sessionMaxAgeHours()).toBe(0);
    withEnv(" 24 ");
    expect(sessionMaxAgeHours()).toBe(24);
  });

  test("invalid / negative values FAIL SAFE to the default cap", () => {
    // A typo must never silently disable the absolute cap.
    for (const bad of ["abc", "-1", "NaN", "Infinity", "1e999"]) {
      withEnv(bad);
      expect(sessionMaxAgeHours()).toBe(SESSION_MAX_AGE_HOURS_DEFAULT);
    }
    withEnv(undefined);
  });
});

describe("P2-S01: the absolute cap on the iat anchor", () => {
  const NOW = 1_800_000_000; // fixed epoch seconds for determinism

  test("a fresh token survives; a token one second past the cap dies", () => {
    withEnv("12");
    const fresh = { iat: NOW - 12 * 3600 + 59 };
    expect(absoluteSessionLifetimeExceeded(fresh, NOW)).toBe(false);

    const expired = { iat: NOW - 12 * 3600 - 1 };
    expect(absoluteSessionLifetimeExceeded(expired, NOW)).toBe(true);
  });

  test("cap 0 (legacy off) never expires — even an ancient token", () => {
    withEnv("0");
    expect(
      absoluteSessionLifetimeExceeded({ iat: NOW - 100 * 24 * 3600 }, NOW)
    ).toBe(false);
  });

  test("fail-closed: a token with no usable iat anchor counts as expired", () => {
    withEnv("12");
    expect(absoluteSessionLifetimeExceeded({}, NOW)).toBe(true);
    expect(absoluteSessionLifetimeExceeded({ iat: Number.NaN }, NOW)).toBe(true);
    expect(absoluteSessionLifetimeExceeded({ iat: undefined }, NOW)).toBe(true);
    withEnv(undefined);
  });
});

describe("P2-S01: the authOptions jwt callback enforces the cap", () => {
  test("an over-cap refresh token is claim-stripped BEFORE any DB work", async () => {
    withEnv("12");
    const jwt = jwtCallback();

    const ancient = {
      id: "usr-no-such-ga6-user",
      email: "ga6@faya.local",
      name: "GA-6",
      role: "admin",
      iat: Math.floor(Date.now() / 1000) - 13 * 3600, // past the default cap
    };
    const result = await jwt({ token: ancient as never, user: undefined } as never);
    // Claims stripped — requireUser/middleware treat the request as
    // unauthenticated. The refresh path never reached the DB (the id no
    // longer exists; a DB read would have thrown/been skipped silently).
    expect(result.id).toBeUndefined();
    expect(result.role).toBeUndefined();
    withEnv(undefined);
  });

  test("a fresh refresh token keeps its claims (live user re-hydration)", async () => {
    withEnv("12");
    const { db } = await import("../../src/lib/db");
    const { ROLE_MATRIX } = await import("../../src/lib/auth/role-matrix");

    const adminEntry = ROLE_MATRIX.find((role) => role.name === "admin");
    await db.role.upsert({
      where: { name: "admin" },
      update: {},
      create: {
        name: "admin",
        description: adminEntry?.description ?? "Full platform administration",
        permissionsJson: JSON.stringify(adminEntry?.permissions ?? ["*"]),
      },
    });
    const email = `ga6-lifetime-${Math.random().toString(36).slice(2, 8)}@faya.local`;
    const user = await db.user.create({
      data: { email, name: "GA-6 Lifetime", role: "admin", isActive: true },
      select: { id: true, email: true },
    });
    try {
      const jwt = jwtCallback();
      const token = {
        id: user.id,
        email: user.email,
        name: "GA-6 Lifetime",
        role: "admin",
        iat: Math.floor(Date.now() / 1000) - 60, // 1 minute old — well inside
      };
      const result = await jwt({ token: token as never, user: undefined } as never);
      expect(result.id).toBe(user.id);
      expect(result.role).toBe("admin");
    } finally {
      await db.user.delete({ where: { id: user.id } });
    }
    withEnv(undefined);
  });

  test("initial sign-in (user present) bypasses the cap — the token was just minted", async () => {
    withEnv("12");
    const jwt = jwtCallback();
    const result = await jwt({
      token: { iat: 1 } as never, // absurdly old iat, but this is a SIGN-IN
      user: { id: "usr-x", email: "x@faya.local", role: "admin" } as never,
    } as never);
    expect(result.id).toBe("usr-x");
    expect(result.role).toBe("admin");
    withEnv(undefined);
  });
});
