/**
 * Wave-12 posture/hygiene (fix agent 19-b, trace 1a10de80e295e949) — the
 * audit-18-b fix batch, pinned against the REAL policy function:
 *
 *   F-1 (P3, A1-04 remedy) — metrics default-open posture: /api/metrics
 *     answers 200 UNAUTHENTICATED while FAYANMS_METRICS_TOKEN is unset
 *     (documented dev/CI posture, still pinned by rt025/cloud-metrics —
 *     the REQUEST path is unchanged). The wave-11 proxy-hop contract,
 *     however, sanctions DIRECT-PUBLISH topologies
 *     (FAYANMS_TRUST_PROXY_HOPS=0) where the Caddy edge 404 for
 *     /api/metrics does NOT exist, so the app-level posture must be
 *     self-sufficient: production now REFUSES TO BOOT without a strong
 *     token (findMetricsTokenViolations wired into
 *     findProductionPolicyViolations — the wave-11 F-5 guard shape:
 *     fail-close in production, no dev emitter, dev behavior unchanged).
 *
 *   F-2 (P4) — placeholder-token false assurance: deploy/oci/env.example
 *     ships an ACTIVE FAYANMS_METRICS_TOKEN=SET_ON_HOST_ONLY. The known-bad
 *     scan now covers the variable (repository-public placeholders + the
 *     shared KNOWN_BAD_SECRETS blocklist): a verbatim deploy can no longer
 *     boot "configured" with a token any reader of this repo knows.
 *
 *   F-3 (P4) — Cache-Control: no-store on every /api/v1 envelope (ok + all
 *     fail builders), matching health/metrics; next.config.ts untouched.
 *
 *   F-4 (P4) — health probe memoization: the anonymous DB probe result is
 *     memoized in module scope for a 1 s TTL (first hit per window executes
 *     the probe, concurrent cold hits share one in-flight probe); uptimeSec
 *     and the 200/503 semantics stay exact, no-store stays.
 *
 * Rig notes: the policy functions are PURE over a literal env (batch-14
 * convention) — only the dev-boot pin touches process.env, scrubbed to a
 * known state and restored. The metrics ROUTE file itself is intentionally
 * NOT edited by this wave (route-level token-set semantics stay
 * byte-identical; a source pin below guards that boundary).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";

import { describe, expect, mock, test } from "bun:test";

import {
  METRICS_TOKEN_ENV,
  enforceStartupSecurityPolicy,
  findMetricsTokenViolations,
  findProductionPolicyViolations,
} from "../../src/lib/startup/security-policy";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const read = (relativePath: string): string =>
  readFileSync(path.join(REPO_ROOT, relativePath), "utf8");

/* ── env discipline (batch-14 shape: literal envs for pure functions,
      scrubbed process.env only for the boot-path pin) ───────────────────── */

const NODE_ENV_KEY = "NODE_ENV";

/** Every variable the production policy reads, plus NODE_ENV. */
const BOOT_CHECKED_VARS = [
  "NEXTAUTH_SECRET",
  "FAYANMS_SERVICE_PUBLIC_KEYS",
  "FAYANMS_SERVICE_PRIVATE_KEY",
  "FAYANMS_SERVICE_SECRET",
  "FAYANMS_SERVICE_SECRETS",
  "FAYANMS_CONFIG_ENC_KEY",
  "FAYANMS_DEMO_MODE",
  "DATABASE_URL",
  "FAYANMS_EXPECTED_REPLICAS",
  "FAYANMS_RATE_STORE",
  "FAYANMS_TRUST_PROXY_HOPS",
  "FAYANMS_PUBLIC_PROXY",
  METRICS_TOKEN_ENV,
  NODE_ENV_KEY,
] as const;

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

const E = (vars: Record<string, string> = {}): NodeJS.ProcessEnv =>
  vars as NodeJS.ProcessEnv;

/* ── fixtures ─────────────────────────────────────────────────────────────── */

/** Strong 64-hex fixture token, NOT on any blocklist (self-guarded below). */
const STRONG_METRICS_TOKEN =
  "1f8b2c4d6e9a0f3b5c7e1d9f2a4b6c8d0e2f4a6b8c0d2e4f6a8b0c1d3e5f7a9b";

const FRESH_HEX_SECRET =
  "7f9c2e5a1d3b4c6e8f0a2b4d6e8f0a1b3c5d7e9f1a3b5d7f9c1e3f5a7b9d1f3e";

/**
 * A fully-valid EdDSA-only production env (batch-14's builder shape) WITH
 * the wave-12 baseline: declared proxy AND a strong metrics token. Used for
 * delta isolation — the ONLY deltas in the matrices below are the guards.
 */
function validProductionEnv(
  vars: Record<string, string> = {}
): NodeJS.ProcessEnv {
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
    FAYANMS_PUBLIC_PROXY: "true",
    [METRICS_TOKEN_ENV]: STRONG_METRICS_TOKEN,
    ...vars,
  };
}

/* ── F-1/F-2: the metrics-token guard, through the REAL policy function ──── */

describe("F-1: production refuses to boot without FAYANMS_METRICS_TOKEN", () => {
  test("the fixture token is strong (self-guard: 64 hex, not on a blocklist)", () => {
    expect(STRONG_METRICS_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    // Delta isolation: the baseline is violation-free as a whole.
    expect(findProductionPolicyViolations(validProductionEnv())).toEqual([]);
  });

  test("unset token → violation with the generation remediation named", () => {
    const env: Record<string, string | undefined> = { ...validProductionEnv() };
    delete env[METRICS_TOKEN_ENV];
    const violations = findProductionPolicyViolations(env as NodeJS.ProcessEnv);
    const hit = violations.find((v) => v.variable === METRICS_TOKEN_ENV);
    expect(hit).toBeDefined();
    expect(hit?.reason).toContain("openssl rand -hex 32");
    expect(hit?.reason).toContain("200 UNAUTHENTICATED");
  });

  test("empty/whitespace token counts as missing (the route's unset semantics)", () => {
    for (const value of ["", "   "]) {
      const violations = findMetricsTokenViolations(
        E({ [METRICS_TOKEN_ENV]: value })
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.variable).toBe(METRICS_TOKEN_ENV);
      expect(violations[0]?.reason).toContain("openssl rand -hex 32");
    }
  });

  test("strong token boots clean (the remediation works — whole-env pin)", () => {
    expect(
      findMetricsTokenViolations(E({ [METRICS_TOKEN_ENV]: STRONG_METRICS_TOKEN }))
    ).toEqual([]);
    expect(findProductionPolicyViolations(validProductionEnv())).toEqual([]);
  });
});

describe("F-2: repository-public placeholder tokens are refused at production boot", () => {
  test("SET_ON_HOST_ONLY (deploy/oci/env.example's active placeholder) → violation", () => {
    const violations = findProductionPolicyViolations(
      validProductionEnv({ [METRICS_TOKEN_ENV]: "SET_ON_HOST_ONLY" })
    );
    const hit = violations.find((v) => v.variable === METRICS_TOKEN_ENV);
    expect(hit).toBeDefined();
    expect(hit?.reason).toContain("placeholder");
    expect(hit?.reason).toContain("openssl rand -hex 32");
  });

  test("the production example's own placeholder is refused too (verbatim copies cannot boot)", () => {
    const violations = findMetricsTokenViolations(
      E({ [METRICS_TOKEN_ENV]: "REPLACE_WITH_GENERATED_64_HEX_TOKEN" })
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("placeholder");
  });

  test("comparison is trim/lowercase tolerant (the isKnownBad style)", () => {
    const violations = findMetricsTokenViolations(
      E({ [METRICS_TOKEN_ENV]: "  set_on_host_only  " })
    );
    expect(violations).toHaveLength(1);
  });

  test("the shared KNOWN_BAD_SECRETS blocklist applies to the token as well", () => {
    const violations = findMetricsTokenViolations(
      E({ [METRICS_TOKEN_ENV]: "changeme" })
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("openssl rand -hex 32");
  });
});

describe("F-1 composition + dev posture", () => {
  test("hops and metrics violations compose in ONE findProductionPolicyViolations call", () => {
    const env = validProductionEnv({
      FAYANMS_TRUST_PROXY_HOPS: "1",
      FAYANMS_PUBLIC_PROXY: "",
      [METRICS_TOKEN_ENV]: "",
    });
    const violations = findProductionPolicyViolations(env);
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.variable).sort()).toEqual(
      ["FAYANMS_TRUST_PROXY_HOPS", METRICS_TOKEN_ENV].sort()
    );
  });

  test("development is unchanged: no token, no throw, NO metrics warning (boot path)", () => {
    withScrubbedBootEnv(() => {
      bootEnv[NODE_ENV_KEY] = "development";
      const warnings = mock(() => undefined);
      const originalWarn = console.warn;
      console.warn = warnings;
      try {
        expect(() => enforceStartupSecurityPolicy()).not.toThrow();
        const flattened = warnings.mock.calls
          .map((call) => call.join(" "))
          .join("\n");
        // Other dev warnings may fire (e.g. the dev session-secret hint) —
        // the metrics-token guard must never surface outside production.
        expect(flattened).not.toContain(METRICS_TOKEN_ENV);
      } finally {
        console.warn = originalWarn;
      }
    });
  });
});

/**
 * The dev-boot pin above exercises the REAL production entry point
 * (enforceStartupSecurityPolicy, imported at the top) so a future editor
 * cannot add a metrics-token dev emitter without this pin failing.
 */

/* ── source pins: the fixes exist where the audit found the gaps ──────────── */

describe("wave-12 source pins", () => {
  const policySrc = read("src/lib/startup/security-policy.ts");
  const metricsRouteSrc = read("src/app/api/metrics/route.ts");
  const apiLibSrc = read("src/app/api/v1/_lib/api.ts");
  const healthSrc = read("src/app/api/health/route.ts");
  const envExample = read(".env.example");
  const appEnvExample = read("docs/deploy/env.app.production.example");
  const ociEnvExample = read("deploy/oci/env.example");

  test("F-1/F-2: the guard is wired into the production violation set (not a dead export)", () => {
    expect(policySrc).toContain('METRICS_TOKEN_ENV = "FAYANMS_METRICS_TOKEN"');
    expect(policySrc).toContain(
      "violations.push(...findMetricsTokenViolations(env));"
    );
  });

  test("F-2: the known-bad placeholder set names the shipped repo values", () => {
    expect(policySrc).toContain("KNOWN_BAD_METRICS_TOKENS");
    expect(policySrc).toContain('"SET_ON_HOST_ONLY"');
    expect(policySrc).toContain('"REPLACE_WITH_GENERATED_64_HEX_TOKEN"');
  });

  test("F-1 boundary: the metrics ROUTE file is untouched (token-set semantics byte-identical)", () => {
    // The startup gate is the new control — the request path keeps its
    // documented unset→open / set→timingSafeEqual behavior (rt025 /
    // cloud-metrics remain the behavioral owners of that contract).
    expect(metricsRouteSrc).toContain("if (configuredToken.length > 0)");
    expect(metricsRouteSrc).toContain("timingSafeEqual(suppliedBuf, expected)");
  });

  test("F-3: no-store is on BOTH envelope builders (all four, count-pinned)", () => {
    const noStoreCount = apiLibSrc.split('"Cache-Control": "no-store"').length - 1;
    expect(noStoreCount).toBe(4);
    // Each builder stamps it next to the X-Request-Id discipline:
    for (const builder of [
      "export function ok<T>",
      "export function fail(",
      "export function failWithMeta(",
      "export function failWithDetail(",
    ]) {
      expect(apiLibSrc).toContain(builder);
    }
  });

  test("F-4: the health route memoizes the probe (TTL constant + module-scope state)", () => {
    expect(healthSrc).toContain("const PROBE_CACHE_TTL_MS = 1_000;");
    expect(healthSrc).toContain("let probeCache:");
    expect(healthSrc).toContain("let probeInFlight:");
    expect(healthSrc).toContain("function freshProbeSnapshot(");
    // The TTL is documented in the route docstring, not just declared:
    expect(healthSrc).toContain("PROBE_CACHE_TTL_MS (1 second)");
    // The memo supplements (never replaces) the probe budget:
    expect(healthSrc).toContain("DB_PROBE_TIMEOUT_MS = 3_000");
  });

  test("the env examples carry the metrics-token contract", () => {
    // .env.example: COMMENTED line + generation guidance (dev stays open —
    // the open dev posture must not silently become an active default).
    expect(envExample).toContain("# FAYANMS_METRICS_TOKEN=");
    expect(envExample).not.toMatch(/^FAYANMS_METRICS_TOKEN=/m);
    expect(envExample).toContain("openssl rand -hex 32");
    expect(envExample).toContain("startup security policy REFUSES TO BOOT");
    // Production app example: ACTIVE strong placeholder + contract comment
    // (wave-11 FAYANMS_PUBLIC_PROXY pattern — the value itself is on the
    // known-bad list, so a verbatim copy cannot boot).
    expect(appEnvExample).toMatch(/^FAYANMS_METRICS_TOKEN=.+$/m);
    expect(appEnvExample).toContain("REPLACE_WITH_GENERATED_64_HEX_TOKEN");
    // deploy/oci/env.example: the SET_ON_HOST_ONLY line stays ACTIVE (F-2
    // fix choice) and now documents the boot-refusal contract.
    expect(ociEnvExample).toContain("FAYANMS_METRICS_TOKEN=SET_ON_HOST_ONLY");
    expect(ociEnvExample).toContain("known-bad list");
  });
});
