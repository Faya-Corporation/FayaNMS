/**
 * Open-findings batch 14 — F-032 (P3, BACKLOG order):
 * rate/login budgets are per-process by default and multiply with replicas.
 *
 *   History: SCALE-001-A landed the shared-rate-store abstraction — the
 *   /api/v1 gate's budgets AND (SCALE-001-B, one knob) the login guard's
 *   throttle/lockout state are process-local by default (bounded
 *   in-memory) and fleet-wide only when FAYANMS_RATE_STORE=postgres.
 *   Nothing, however, told an operator that scaling the app to N
 *   instances on the DEFAULT silently multiplies every documented
 *   ceiling by N (fleet rate budget = N × budget) and leaves login
 *   lockout state per instance (a distributed attack rotates sources
 *   AND instances) — the misconfiguration was invisible until an
 *   incident proved it.
 *
 *   The closure (the BACKLOG plan's named decision): the startup
 *   security policy gains a fail-loud scale guard. Orchestrator scale
 *   is not visible in-process, so the instance count is an explicit
 *   declaration — FAYANMS_EXPECTED_REPLICAS (unset = 1, the documented
 *   single-host default boots unchanged). When the declaration exceeds
 *   1 and the resolved budget store is NOT the shared postgres store,
 *   production REFUSES TO START (same refusal block as every other
 *   production posture violation); development warns and never aborts.
 *   A malformed declaration (non-integer/zero/negative) is itself a
 *   violation — an operator who declared something unparseable must not
 *   get a silently mis-scoped guard decision.
 *
 *   Per-instance math (documented in the deploy runbook, pinned below):
 *   N instances × per-instance budgets = N × every documented ceiling;
 *   the shared store restores ONE budget per plane over the database the
 *   app already depends on.
 *
 *   Rig notes: unlike batches 2-13 this closure is a pure env-policy
 *   unit — no DB rows, no session minting. The production-boot pin
 *   builds a fully-valid EdDSA-only environment with keys generated
 *   in-process (crypto.generateKeyPairSync), so the ONLY delta between
 *   the throwing and the clean boot is the scale guard itself.
 */

import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";

import { RATE_STORE_ENV } from "../../src/lib/api/rate-store";
import {
  EXPECTED_REPLICAS_ENV,
  enforceStartupSecurityPolicy,
  findProductionPolicyViolations,
  findRateStoreScaleViolations,
  resolveExpectedReplicas,
  warnRateStoreScale,
} from "../../src/lib/startup/security-policy";

/* ── env discipline (pure functions get literal envs; process.env only for
      the boot-path pins, scrubbed to a known state and restored after) ──── */

const NODE_ENV_KEY = "NODE_ENV";

/**
 * Every variable the production policy reads, plus the two F-032 knobs and
 * NODE_ENV. bun auto-loads the repo .env into process.env, so the boot-path
 * pins scrub these to a KNOWN state before asserting and restore them after
 * (the policy functions stay pure over literal envs — only
 * enforceStartupSecurityPolicy reads process.env).
 */
const BOOT_CHECKED_VARS = [
  "NEXTAUTH_SECRET",
  "FAYANMS_SERVICE_PUBLIC_KEYS",
  "FAYANMS_SERVICE_PRIVATE_KEY",
  "FAYANMS_SERVICE_SECRET",
  "FAYANMS_SERVICE_SECRETS",
  "FAYANMS_CONFIG_ENC_KEY",
  "FAYANMS_DEMO_MODE",
  "DATABASE_URL",
  EXPECTED_REPLICAS_ENV,
  RATE_STORE_ENV,
  // Wave-11 F-5 knobs (the proxy-hop trust guard reads both).
  "FAYANMS_TRUST_PROXY_HOPS",
  "FAYANMS_PUBLIC_PROXY",
  NODE_ENV_KEY,
] as const;

/** process.env NODE_ENV is typed readonly in newer @types/node — the boot pins write it through this alias. */
const bootEnv = process.env as Record<string, string | undefined>;

function withScrubbedBootEnv<T>(fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of BOOT_CHECKED_VARS) {
    saved[key] = bootEnv[key];
    delete bootEnv[key];
  }
  try {
    return fn();
  } finally {
    for (const key of BOOT_CHECKED_VARS) {
      if (saved[key] === undefined) delete bootEnv[key];
      else bootEnv[key] = saved[key];
    }
  }
}

/**
 * Literal test envs. NODE_ENV is a REQUIRED key on NodeJS.ProcessEnv in
 * newer @types/node, so every literal env the pure functions receive is
 * wrapped here once instead of casting at each call site.
 */
const E = (vars: Record<string, string> = {}): NodeJS.ProcessEnv =>
  vars as NodeJS.ProcessEnv;
/* ── resolveExpectedReplicas: the declaration parser ─────────────────────── */

describe("resolveExpectedReplicas (F-032 declaration parser)", () => {
  test("unset / empty declaration means 1 (single-host default boots unchanged)", () => {
    expect(resolveExpectedReplicas(E({}))).toEqual({ ok: true, replicas: 1 });
    expect(resolveExpectedReplicas(E({ [EXPECTED_REPLICAS_ENV]: "" }))).toEqual({
      ok: true,
      replicas: 1,
    });
    expect(resolveExpectedReplicas(E({ [EXPECTED_REPLICAS_ENV]: "   " }))).toEqual({
      ok: true,
      replicas: 1,
    });
  });

  test("positive integers parse (whitespace-tolerant)", () => {
    expect(resolveExpectedReplicas(E({ [EXPECTED_REPLICAS_ENV]: "1" }))).toEqual({
      ok: true,
      replicas: 1,
    });
    expect(resolveExpectedReplicas(E({ [EXPECTED_REPLICAS_ENV]: "4" }))).toEqual({
      ok: true,
      replicas: 4,
    });
    expect(resolveExpectedReplicas(E({ [EXPECTED_REPLICAS_ENV]: " 2 " }))).toEqual({
      ok: true,
      replicas: 2,
    });
  });

  test("malformed declarations fail loud (fail-loud guard, not a silent default)", () => {
    for (const bad of ["0", "-3", "2.5", "two", "1,2", "NaN"]) {
      const resolution = resolveExpectedReplicas(E({ [EXPECTED_REPLICAS_ENV]: bad }));
      expect(resolution.ok).toBe(false);
      if (!resolution.ok) {
        expect(resolution.reason).toContain("positive integer");
        expect(resolution.reason).toContain(EXPECTED_REPLICAS_ENV);
      }
    }
  });
});

/* ── findRateStoreScaleViolations: the guard matrix ──────────────────────── */

describe("findRateStoreScaleViolations (F-032 guard matrix)", () => {
  test("single instance (declared or not) never violates — the default posture is unchanged", () => {
    expect(findRateStoreScaleViolations(E({}))).toEqual([]);
    expect(
      findRateStoreScaleViolations(E({ [EXPECTED_REPLICAS_ENV]: "1" }))
    ).toEqual([]);
    expect(
      findRateStoreScaleViolations(E({
        [EXPECTED_REPLICAS_ENV]: "1",
        [RATE_STORE_ENV]: "memory",
      }))
    ).toEqual([]);
    expect(
      findRateStoreScaleViolations(E({
        [EXPECTED_REPLICAS_ENV]: "1",
        [RATE_STORE_ENV]: "not-a-store",
      }))
    ).toEqual([]);
  });

  test("multi-instance + in-memory default refuses (the multiplying defect)", () => {
    for (const env of [
      E({ [EXPECTED_REPLICAS_ENV]: "3" }),
      E({ [EXPECTED_REPLICAS_ENV]: "3", [RATE_STORE_ENV]: "memory" }),
      E({ [EXPECTED_REPLICAS_ENV]: "2" }),
    ]) {
      const violations = findRateStoreScaleViolations(env);
      expect(violations.length).toBe(1);
      expect(violations[0]?.variable).toBe(RATE_STORE_ENV);
      const reason = violations[0]?.reason ?? "";
      // The math is named, not just the knob:
      expect(reason).toContain(`${EXPECTED_REPLICAS_ENV}=${(env[EXPECTED_REPLICAS_ENV] ?? "").trim()}`);
      expect(reason).toContain("per-process");
      expect(reason).toContain("N×");
      // The remediation is named:
      expect(reason).toContain(`${RATE_STORE_ENV}=postgres`);
      expect(reason).toContain("lockout");
    }
  });

  test("multi-instance + the shared postgres store is clean (case/space tolerant)", () => {
    for (const storeValue of ["postgres", "postgresql", " Postgres ", "POSTGRESQL"]) {
      expect(
        findRateStoreScaleViolations(E({
          [EXPECTED_REPLICAS_ENV]: "2",
          [RATE_STORE_ENV]: storeValue,
        }))
      ).toEqual([]);
    }
  });

  test("multi-instance + an unsupported store value refuses (the shared-store requirement is unverifiable)", () => {
    const violations = findRateStoreScaleViolations(E({
      [EXPECTED_REPLICAS_ENV]: "2",
      [RATE_STORE_ENV]: "redis",
    }));
    expect(violations.length).toBe(1);
    expect(violations[0]?.variable).toBe(RATE_STORE_ENV);
    expect(violations[0]?.reason).toContain("not a supported store");
    expect(violations[0]?.reason).toContain("shared store is required");
  });

  test("a malformed multi-instance declaration is its own violation (fail loud on the declaration)", () => {
    const violations = findRateStoreScaleViolations(E({
      [EXPECTED_REPLICAS_ENV]: "2.5",
    }));
    expect(violations.length).toBe(1);
    expect(violations[0]?.variable).toBe(EXPECTED_REPLICAS_ENV);
    expect(violations[0]?.reason).toContain("positive integer");
  });
});

/* ── production wiring: the refusal is part of the boot posture ──────────── */

describe("production posture wiring (findProductionPolicyViolations)", () => {
  test("the scale violation is part of the production refusal set", () => {
    const withScale = findProductionPolicyViolations(E({
      [EXPECTED_REPLICAS_ENV]: "3",
    }));
    expect(
      withScale.some((violation) => violation.variable === RATE_STORE_ENV)
    ).toBe(true);

    // Same env without the declaration → no scale violation (delta isolation).
    const withoutScale = findProductionPolicyViolations(E());
    expect(
      withoutScale.some((violation) => violation.variable === RATE_STORE_ENV)
    ).toBe(false);
    expect(
      withoutScale.some((violation) => violation.variable === EXPECTED_REPLICAS_ENV)
    ).toBe(false);
  });
});

/* ── boot path: dev warns, production throws ─────────────────────────────── */

/** A distinct 64-hex secret NOT on the known-bad blocklist. */
const FRESH_HEX_SECRET = "7f9c2e5a1d3b4c6e8f0a2b4d6e8f0a1b3c5d7e9f1a3b5d7f9c1e3f5a7b9d1f3e";

/** A fully-valid EdDSA-only production env; the ONLY delta below is the guard. */
function validEddsaProductionEnv(): NodeJS.ProcessEnv {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const pkcs8Pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  return {
    [NODE_ENV_KEY]: "production",
    NEXTAUTH_SECRET: FRESH_HEX_SECRET,
    FAYANMS_SERVICE_PUBLIC_KEYS: spki,
    FAYANMS_SERVICE_PRIVATE_KEY: pkcs8Pem,
    FAYANMS_CONFIG_ENC_KEY: FRESH_HEX_SECRET.split("").reverse().join(""),
    DATABASE_URL: "postgresql://faya:secret@localhost:5432/fayanms",
    // Wave-11 F-5 (differential pin update): the fixture models a
    // proxy-fronted deployment, so the appending-proxy declaration is part
    // of the "fully valid" baseline — the no-proxy refusal has its own
    // dedicated matrix in tests/audit/wave11-edge.test.ts.
    FAYANMS_PUBLIC_PROXY: "true",
  };
}

describe("enforceStartupSecurityPolicy (F-032 boot path)", () => {
  test("production: N>1 on the per-process store REFUSES TO START naming the knob", () => {
    const env = validEddsaProductionEnv();
    env[EXPECTED_REPLICAS_ENV] = "3";
    // The base env is otherwise fully valid — the ONLY violation is the scale guard.
    expect(findProductionPolicyViolations(env)).toHaveLength(1);
    withScrubbedBootEnv(() => {
      bootEnv[NODE_ENV_KEY] = "production";
      for (const [key, value] of Object.entries(env)) process.env[key] = value;
      delete process.env[RATE_STORE_ENV];
      expect(() => enforceStartupSecurityPolicy()).toThrow(RATE_STORE_ENV);
    });
  });

  test("production: N>1 WITH the shared store boots clean (the remediation works)", () => {
    const env = validEddsaProductionEnv();
    env[EXPECTED_REPLICAS_ENV] = "3";
    env[RATE_STORE_ENV] = "postgres";
    expect(findProductionPolicyViolations(env)).toHaveLength(0);
    withScrubbedBootEnv(() => {
      bootEnv[NODE_ENV_KEY] = "production";
      for (const [key, value] of Object.entries(env)) process.env[key] = value;
      expect(() => enforceStartupSecurityPolicy()).not.toThrow();
    });
  });

  test("development: the same misconfiguration warns and NEVER aborts", () => {
    withScrubbedBootEnv(() => {
      bootEnv[NODE_ENV_KEY] = "development";
      process.env[EXPECTED_REPLICAS_ENV] = "3";
      delete process.env[RATE_STORE_ENV];
      const warnings = mock(() => undefined);
      const originalWarn = console.warn;
      console.warn = warnings;
      try {
        expect(() => enforceStartupSecurityPolicy()).not.toThrow();
        expect(warnings.mock.calls.length).toBeGreaterThan(0);
        const flattened = warnings.mock.calls.map((call) => call.join(" ")).join("\n");
        expect(flattened).toContain(RATE_STORE_ENV);
        expect(flattened).toContain("per-process");
      } finally {
        console.warn = originalWarn;
      }
    });
  });
});

/* ── one knob, both planes (the guard's refusal text covers rate AND login) ── */

describe("SCALE-001-A/B parity (one knob drives both budget planes)", () => {
  const rateGateSource = readFileSync("src/lib/api/rate-gate.ts", "utf8");
  const loginGuardSource = readFileSync("src/lib/auth/login-guard.ts", "utf8");
  const rateStoreSource = readFileSync("src/lib/api/rate-store.ts", "utf8");

  test("the login guard resolves its store through the SAME shared-store knob", () => {
    expect(loginGuardSource).toContain('from "@/lib/api/rate-store"');
    expect(loginGuardSource).toContain("resolveRateStoreKind");
  });

  test("the API rate gate draws from the shared store abstraction", () => {
    expect(rateGateSource).toContain('from "@/lib/api/rate-store"');
    expect(rateGateSource).toContain("getRateStore");
  });

  test("the shared store contract is still the documented two-implementation shape", () => {
    expect(rateStoreSource).toContain('"memory" | "postgres"');
    expect(rateStoreSource).toContain('RATE_STORE_ENV = "FAYANMS_RATE_STORE"');
  });
});

/* ── guard placement + documentation pins ────────────────────────────────── */

describe("F-032 documentation (runbook math + env surfaces)", () => {
  const policySource = readFileSync("src/lib/startup/security-policy.ts", "utf8");
  const envExample = readFileSync(".env.example", "utf8");
  const appEnvExample = readFileSync("docs/deploy/env.app.production.example", "utf8");
  const runbook = readFileSync("docs/runbooks/deployment.md", "utf8");

  test("the guard is wired into the production posture (not a dead export)", () => {
    expect(policySource).toContain("violations.push(...findRateStoreScaleViolations(env));");
    expect(policySource).toContain("warnRateStoreScale();");
  });

  test(".env.example documents the declaration next to the shared store", () => {
    expect(envExample).toContain(EXPECTED_REPLICAS_ENV);
    expect(envExample).toContain(RATE_STORE_ENV);
  });

  test("the production app env template carries the declaration", () => {
    expect(appEnvExample).toContain(EXPECTED_REPLICAS_ENV);
  });

  test("the deploy runbook documents the per-instance math", () => {
    expect(runbook).toContain(EXPECTED_REPLICAS_ENV);
    expect(runbook).toContain("multipl"); // multiply/multiplies/multiplication
    expect(runbook).toContain(RATE_STORE_ENV);
  });
});
