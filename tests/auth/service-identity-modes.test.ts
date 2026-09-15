import {
  generateKeyPairSync,
  randomBytes,
  createHmac,
  createPrivateKey,
  sign as ed25519Sign,
} from "node:crypto";
import { describe, expect, test } from "bun:test";

import {
  findProductionPolicyViolations,
  resolveServiceIdentityMode,
} from "../../src/lib/startup/security-policy";
import {
  bearerTokenOf,
  parseServicePrivateKey,
  parseServicePublicKeys,
  verifyServiceToken,
} from "../../src/lib/auth/service-jwt";
import { authenticateServiceRequest, mintServiceToken } from "../../src/lib/auth/service-auth";
import {
  assertWorkerServiceIdentity,
  resolveWorkerIdentityEnv,
  type WorkerIdentityEnv,
} from "../../mini-services/worker/identity-boot";

/**
 * TASK-SVC-001-A — complete Ed25519-only production service identity
 * (independent audit 2026-09-15, finding SVC-001: "production
 * startup/configuration still requires the legacy symmetric
 * FAYANMS_SERVICE_SECRET — an EdDSA-only deployment cannot boot").
 *
 * TDD per the remediation prompt §15: the startup-tier tests were written
 * FIRST and failed against the pre-remediation code (the unconditional
 * FAYANMS_SERVICE_SECRET requirement), then the implementation landed.
 *
 * Identity model (explicit, deterministic — derived from configuration,
 * never from token-supplied metadata):
 *
 *   eddsa-only    FAYANMS_SERVICE_PUBLIC_KEYS set, NO symmetric material.
 *                 Recommended production end state. HS256 is structurally
 *                 impossible at runtime (SERVICE_ALG_REJECTED). The app
 *                 process REQUIRES its own Ed25519 private key (it mints
 *                 control-plane tokens; there is no symmetric fallback).
 *   dual          Public keys AND symmetric secret configured — the
 *                 documented, time-boxed P1-007 rotation Phase 1. Both
 *                 algorithms verify; minters prefer EdDSA. Symmetric
 *                 strength rules apply in full.
 *   hs256-legacy  Symmetric secret only. Deprecated; kept for migration.
 *   unconfigured  Production refuses to start.
 *
 * Startup matrix (remediation prompt §11) — each row is a test below.
 * Adversarial algorithm-confusion coverage (§7) rides the runtime tier.
 */

// ── key material ────────────────────────────────────────────────────────────
const WORKER = generateKeyPairSync("ed25519");
const CONTROL = generateKeyPairSync("ed25519");
const RSA = generateKeyPairSync("rsa", { modulusLength: 2048 });

const WORKER_PUB_SPKI = WORKER.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const CONTROL_PRIV_PEM = CONTROL.privateKey
  .export({ format: "pem", type: "pkcs8" })
  .toString("utf8")
  .trim()
  .replaceAll("\n", "\\n");
const WORKER_PRIV_PEM = WORKER.privateKey
  .export({ format: "pem", type: "pkcs8" })
  .toString("utf8")
  .trim()
  .replaceAll("\n", "\\n");
const RSA_PUB_SPKI = RSA.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const RSA_PRIV_PEM = RSA.privateKey.export({ format: "pem", type: "pkcs8" }).toString("utf8").trim();
const CONTROL_PUB_PEM = CONTROL.publicKey.export({ format: "pem", type: "spki" }).toString("utf8").trim();

const FRESH = randomBytes(32).toString("hex");
const FRESH2 = randomBytes(32).toString("hex");

// ── env sandbox ─────────────────────────────────────────────────────────────
const SERVICE_ENV_KEYS = [
  "FAYANMS_SERVICE_SECRET",
  "FAYANMS_SERVICE_SECRETS",
  "FAYANMS_SERVICE_ISSUERS",
  "FAYANMS_SERVICE_PUBLIC_KEYS",
  "FAYANMS_SERVICE_PRIVATE_KEY",
  "NODE_ENV",
] as const;

async function withServiceEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => T | Promise<T>
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of SERVICE_ENV_KEYS) saved.set(key, process.env[key]);
  for (const key of SERVICE_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Otherwise-valid production env (only service identity varies). */
function prodEnv(serviceIdentity: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://fayanms:fayanms@localhost:5433/fayanms",
    NEXTAUTH_SECRET: FRESH,
    FAYANMS_CONFIG_ENC_KEY: FRESH2,
    ...serviceIdentity,
  };
}

/** Service-identity violations only (the other policy dimensions are valid above). */
function serviceViolations(env: Record<string, string | undefined>) {
  return findProductionPolicyViolations(env as NodeJS.ProcessEnv).filter((v) =>
    v.variable.startsWith("FAYANMS_SERVICE")
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Startup tier — remediation prompt §11 matrix
// ════════════════════════════════════════════════════════════════════════════

describe("SVC-001-A startup matrix — EdDSA-only production boots without any shared secret", () => {
  test("§11.1/§11.7 THE GAP: valid Ed25519-only config passes production startup with NO FAYANMS_SERVICE_SECRET", () => {
    const violations = serviceViolations(
      prodEnv({
        FAYANMS_SERVICE_PUBLIC_KEYS: WORKER_PUB_SPKI,
        FAYANMS_SERVICE_PRIVATE_KEY: CONTROL_PRIV_PEM,
      })
    );
    expect(violations).toEqual([]);
  });

  test("§11.2 public keys but the signing process is missing its required private key → FAIL", () => {
    const violations = serviceViolations(
      prodEnv({ FAYANMS_SERVICE_PUBLIC_KEYS: WORKER_PUB_SPKI })
    );
    const hit = violations.find((v) => v.variable === "FAYANMS_SERVICE_PRIVATE_KEY");
    expect(hit).toBeDefined();
    expect(hit?.reason).toContain("required");
  });

  test("§11.3 malformed Ed25519 PUBLIC key material → FAIL (static reason, no material echoed)", () => {
    const violations = serviceViolations(
      prodEnv({
        FAYANMS_SERVICE_PUBLIC_KEYS: "not-a-real-key",
        FAYANMS_SERVICE_PRIVATE_KEY: CONTROL_PRIV_PEM,
      })
    );
    const hit = violations.find((v) => v.variable === "FAYANMS_SERVICE_PUBLIC_KEYS");
    expect(hit).toBeDefined();
    expect(hit?.reason).toContain("malformed");
    expect(hit?.reason).not.toContain("not-a-real-key");
  });

  test("§11.3 malformed Ed25519 PRIVATE key material → FAIL (static reason, no material echoed)", () => {
    const violations = serviceViolations(
      prodEnv({
        FAYANMS_SERVICE_PUBLIC_KEYS: WORKER_PUB_SPKI,
        FAYANMS_SERVICE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nZ0RAU0hCQUs=\\n-----END PRIVATE KEY-----",
      })
    );
    const hit = violations.find((v) => v.variable === "FAYANMS_SERVICE_PRIVATE_KEY");
    expect(hit).toBeDefined();
    expect(hit?.reason).toContain("malformed");
    expect(hit?.reason).not.toContain("Z0RAU0hCQUs=");
  });

  test("§14 wrong key TYPE (RSA public key) → FAIL — the Ed25519 plane refuses non-Ed25519 material", () => {
    const violations = serviceViolations(
      prodEnv({
        FAYANMS_SERVICE_PUBLIC_KEYS: RSA_PUB_SPKI,
        FAYANMS_SERVICE_PRIVATE_KEY: CONTROL_PRIV_PEM,
      })
    );
    expect(violations.find((v) => v.variable === "FAYANMS_SERVICE_PUBLIC_KEYS")).toBeDefined();
  });

  test("§14 wrong key TYPE (RSA private key) → FAIL", () => {
    const violations = serviceViolations(
      prodEnv({
        FAYANMS_SERVICE_PUBLIC_KEYS: WORKER_PUB_SPKI,
        FAYANMS_SERVICE_PRIVATE_KEY: RSA_PRIV_PEM,
      })
    );
    expect(violations.find((v) => v.variable === "FAYANMS_SERVICE_PRIVATE_KEY")).toBeDefined();
  });

  test("§11.5 missing ALL service identity → FAIL with a reason naming both options", () => {
    const violations = serviceViolations(prodEnv({}));
    const hit = violations.find((v) => v.variable === "FAYANMS_SERVICE_PUBLIC_KEYS");
    expect(hit).toBeDefined();
    expect(hit?.reason).toContain("missing service identity");
    expect(hit?.reason).toContain("FAYANMS_SERVICE_PUBLIC_KEYS");
    expect(hit?.reason).toContain("FAYANMS_SERVICE_SECRET");
  });

  test("§11.4 valid explicit legacy HS256 (fresh strong secret, no keys) → PASS (legacy retained, documented)", () => {
    const violations = serviceViolations(prodEnv({ FAYANMS_SERVICE_SECRET: FRESH }));
    expect(violations).toEqual([]);
  });

  test("§11.6 invalid shared secret while HS256 is enabled (legacy) → FAIL (known-bad still refused)", () => {
    const violations = serviceViolations(
      prodEnv({ FAYANMS_SERVICE_SECRET: "6b1f0f4c2c5e4d9a8f3c7e2b1a5d9f8e3c7b2a6d1e9f4c8b3a7d2e6f1c5b9a03" })
    );
    const hit = violations.find((v) => v.variable === "FAYANMS_SERVICE_SECRET");
    expect(hit).toBeDefined();
    expect(hit?.reason).toContain("known demo/repository default");
  });

  test("§11.6 invalid shared secret while HS256 is enabled (dual) → FAIL (shape check unchanged in dual mode)", () => {
    const violations = serviceViolations(
      prodEnv({
        FAYANMS_SERVICE_PUBLIC_KEYS: WORKER_PUB_SPKI,
        FAYANMS_SERVICE_PRIVATE_KEY: CONTROL_PRIV_PEM,
        FAYANMS_SERVICE_SECRET: "too-short",
      })
    );
    const hit = violations.find((v) => v.variable === "FAYANMS_SERVICE_SECRET");
    expect(hit).toBeDefined();
    expect(hit?.reason).toContain("64 hex");
  });

  test("§11.9 conflicting configuration: legacy secret + private key but NO public keys → deterministic FAIL", () => {
    const violations = serviceViolations(
      prodEnv({ FAYANMS_SERVICE_SECRET: FRESH, FAYANMS_SERVICE_PRIVATE_KEY: CONTROL_PRIV_PEM })
    );
    const hit = violations.find((v) => v.variable === "FAYANMS_SERVICE_PRIVATE_KEY");
    expect(hit).toBeDefined();
    expect(hit?.reason).toContain("could never verify");
  });

  test("§11.8 EdDSA-intended + stale symmetric rotation material (no primary secret) → deterministic documented outcome: mode is dual, symmetric rules apply, primary-secret violation", () => {
    const env = prodEnv({
      FAYANMS_SERVICE_PUBLIC_KEYS: WORKER_PUB_SPKI,
      FAYANMS_SERVICE_PRIVATE_KEY: CONTROL_PRIV_PEM,
      FAYANMS_SERVICE_SECRETS: FRESH,
    });
    expect(resolveServiceIdentityMode(env as NodeJS.ProcessEnv)).toBe("dual");
    const hit = serviceViolations(env).find((v) => v.variable === "FAYANMS_SERVICE_SECRET");
    expect(hit).toBeDefined();
    expect(hit?.reason).toContain("64 hex");
  });

  test("known-bad rotation entries are still refused in dual mode", () => {
    const violations = serviceViolations(
      prodEnv({
        FAYANMS_SERVICE_PUBLIC_KEYS: WORKER_PUB_SPKI,
        FAYANMS_SERVICE_PRIVATE_KEY: CONTROL_PRIV_PEM,
        FAYANMS_SERVICE_SECRET: FRESH,
        FAYANMS_SERVICE_SECRETS: "not-hex-at-all",
      })
    );
    expect(violations.find((v) => v.variable === "FAYANMS_SERVICE_SECRETS[0]")).toBeDefined();
  });

  test("whitespace-only material counts as absent (unconfigured), not as a plane", () => {
    expect(
      resolveServiceIdentityMode(
        prodEnv({ FAYANMS_SERVICE_PUBLIC_KEYS: "   ", FAYANMS_SERVICE_SECRET: "  " }) as NodeJS.ProcessEnv
      )
    ).toBe("unconfigured");
  });
});

describe("SVC-001-A — explicit identity-mode derivation (§4)", () => {
  test("public keys + secret → dual (documented P1-007 rotation Phase 1)", () => {
    expect(
      resolveServiceIdentityMode(
        prodEnv({ FAYANMS_SERVICE_PUBLIC_KEYS: WORKER_PUB_SPKI, FAYANMS_SERVICE_SECRET: FRESH }) as NodeJS.ProcessEnv
      )
    ).toBe("dual");
  });

  test("public keys only → eddsa-only", () => {
    expect(
      resolveServiceIdentityMode(prodEnv({ FAYANMS_SERVICE_PUBLIC_KEYS: WORKER_PUB_SPKI }) as NodeJS.ProcessEnv)
    ).toBe("eddsa-only");
  });

  test("secret only → hs256-legacy", () => {
    expect(resolveServiceIdentityMode(prodEnv({ FAYANMS_SERVICE_SECRET: FRESH }) as NodeJS.ProcessEnv)).toBe(
      "hs256-legacy"
    );
  });

  test("neither → unconfigured (production refuses)", () => {
    expect(resolveServiceIdentityMode(prodEnv({}) as NodeJS.ProcessEnv)).toBe("unconfigured");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Runtime tier — algorithm policy, §7 adversarial confusion attempts, §15
// ════════════════════════════════════════════════════════════════════════════

function handMint(options: {
  alg: "EdDSA" | "HS256";
  privateKeyPem?: string;
  hmacSecret?: string;
  headerExtra?: Record<string, unknown>;
  headerOmit?: ("alg" | "typ")[];
  iss?: string;
  aud?: string;
  ttlSeconds?: number;
  scopes?: string[];
}): string {
  const b64 = (input: string | Buffer): string => Buffer.from(input).toString("base64url");
  const nowS = Math.floor(Date.now() / 1000);
  const header: Record<string, unknown> = {};
  if (!options.headerOmit?.includes("alg")) header.alg = options.alg;
  if (!options.headerOmit?.includes("typ")) header.typ = "JWT";
  Object.assign(header, options.headerExtra ?? {});
  const payload = b64(
    JSON.stringify({
      iss: options.iss ?? "fayanms:worker",
      sub: "worker:sim-1",
      aud: options.aud ?? "fayanms:internal",
      iat: nowS,
      exp: nowS + (options.ttlSeconds ?? 300),
      jti: randomBytes(8).toString("hex"),
      scopes: options.scopes ?? ["jobs"],
    })
  );
  const signingInput = `${b64(JSON.stringify(header))}.${payload}`;
  if (options.alg === "EdDSA") {
    const key = createPrivateKey((options.privateKeyPem ?? WORKER_PRIV_PEM).replaceAll("\\n", "\n"));
    return `${signingInput}.${ed25519Sign(null, Buffer.from(signingInput), key).toString("base64url")}`;
  }
  const signature = createHmac("sha256", options.hmacSecret ?? FRESH).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

describe("SVC-001-A runtime — §7 adversarial algorithm confusion (fail closed)", () => {
  test("§7 public key used as HMAC material: HS256 token HMAC'd with the Ed25519 PUBLIC key PEM → REJECTED by an EdDSA-only verifier", async () => {
    await withServiceEnv({ FAYANMS_SERVICE_PUBLIC_KEYS: WORKER_PUB_SPKI }, async () => {
      const token = handMint({ alg: "HS256", hmacSecret: CONTROL_PUB_PEM });
      const result = verifyServiceToken(token);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("SERVICE_ALG_REJECTED");
    });
  });

  test("§7 alg:none → rejected as malformed", async () => {
    await withServiceEnv({ FAYANMS_SERVICE_PUBLIC_KEYS: WORKER_PUB_SPKI }, async () => {
      const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ iss: "fayanms:worker", sub: "s", aud: "fayanms:internal", exp: 9999999999 })).toString("base64url");
      const result = verifyServiceToken(`${header}.${payload}.`);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("SERVICE_TOKEN_MALFORMED");
    });
  });

  test("§7 missing alg → rejected as malformed (header never broadens the policy)", async () => {
    await withServiceEnv({ FAYANMS_SERVICE_PUBLIC_KEYS: WORKER_PUB_SPKI }, async () => {
      const header = Buffer.from(JSON.stringify({ typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ iss: "fayanms:worker", sub: "s", aud: "fayanms:internal", exp: 9999999999 })).toString("base64url");
      const result = verifyServiceToken(`${header}.${payload}.AA`);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("SERVICE_TOKEN_MALFORMED");
    });
  });

  test("§7 unsupported algorithm (HS384) → rejected", async () => {
    await withServiceEnv({ FAYANMS_SERVICE_SECRET: FRESH }, async () => {
      const header = Buffer.from(JSON.stringify({ alg: "HS384", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ iss: "fayanms:worker", sub: "s", aud: "fayanms:internal", exp: 9999999999 })).toString("base64url");
      const result = verifyServiceToken(`${header}.${payload}.AA`);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("SERVICE_TOKEN_MALFORMED");
    });
  });

  test("§7/§10 kid is inert metadata — it can never enable an algorithm or key: unknown kid + valid trusted signature still verifies; an untrusted signer fails regardless of kid", async () => {
    await withServiceEnv({ FAYANMS_SERVICE_PUBLIC_KEYS: WORKER_PUB_SPKI }, async () => {
      const trusted = handMint({ alg: "EdDSA", headerExtra: { kid: "rotated-away-2020" } });
      expect(verifyServiceToken(trusted).ok).toBe(true);

      const weirdKid = handMint({ alg: "EdDSA", headerExtra: { kid: "../../etc/passwd" } });
      expect(verifyServiceToken(weirdKid).ok).toBe(true);

      const FOREIGN = generateKeyPairSync("ed25519");
      const foreign = handMint({
        alg: "EdDSA",
        privateKeyPem: FOREIGN.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
        headerExtra: { kid: WORKER_PUB_SPKI.slice(0, 8) },
      });
      const result = verifyServiceToken(foreign);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("SERVICE_TOKEN_INVALID");
    });
  });

  test("§14 duplicate public keys are deduplicated — verification still works", async () => {
    const keys = parseServicePublicKeys(`${WORKER_PUB_SPKI},${WORKER_PUB_SPKI}`);
    expect(keys.length).toBe(1);
    await withServiceEnv({ FAYANMS_SERVICE_PUBLIC_KEYS: `${WORKER_PUB_SPKI},${WORKER_PUB_SPKI}` }, async () => {
      expect(verifyServiceToken(handMint({ alg: "EdDSA" })).ok).toBe(true);
    });
  });
});

describe("SVC-001-A runtime — §15 sign/verify + configuration isolation", () => {
  test("signer isolation: EdDSA-only minting needs NO symmetric secret — token verifies against public keys only", async () => {
    await withServiceEnv(
      { FAYANMS_SERVICE_PRIVATE_KEY: WORKER_PRIV_PEM, FAYANMS_SERVICE_PUBLIC_KEYS: WORKER_PUB_SPKI },
      async () => {
        const token = mintServiceToken({ issuer: "fayanms:worker", subject: "worker:sim-1", scopes: ["jobs"] });
        const parsed = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8")) as { alg: string };
        expect(parsed.alg).toBe("EdDSA");
        expect(verifyServiceToken(token).ok).toBe(true);
      }
    );
  });

  test("verifier isolation: verification works with public keys ONLY (no private key, no secret)", async () => {
    await withServiceEnv({ FAYANMS_SERVICE_PUBLIC_KEYS: WORKER_PUB_SPKI }, async () => {
      const token = handMint({ alg: "EdDSA" });
      const req = new Request("http://localhost/api/v1/worker/claim", {
        headers: { authorization: `Bearer ${token}` },
      });
      const result = authenticateServiceRequest(req, "jobs");
      expect(result.ok).toBe(true);
    });
  });

  test("§15 legacy HS256 minting still works when explicitly configured (secret only, no private key)", async () => {
    await withServiceEnv({ FAYANMS_SERVICE_SECRET: FRESH }, async () => {
      // Issuer "fayanms:worker" — the app-side verifier's default allowlist
      // (control-issuer tokens are verified by the WORKER, which allowlists
      // "fayanms:control" itself).
      const token = mintServiceToken({ issuer: "fayanms:worker", subject: "worker:sim-1", scopes: ["jobs"] });
      const parsed = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8")) as { alg: string };
      expect(parsed.alg).toBe("HS256");
      expect(verifyServiceToken(token).ok).toBe(true);
    });
  });

  test("§17 EdDSA-only end-to-end contract: worker-minted token → app verification with NO shared secret anywhere; untrusted signer refused", async () => {
    await withServiceEnv(
      { FAYANMS_SERVICE_PUBLIC_KEYS: WORKER_PUB_SPKI, FAYANMS_SERVICE_PRIVATE_KEY: CONTROL_PRIV_PEM },
      async () => {
        // The worker signs with ITS private key; the app verifies with ONLY
        // the worker's public key. No FAYANMS_SERVICE_SECRET exists in this
        // environment — the full §17 chain below must succeed symmetric-free.
        const workerToken = handMint({ alg: "EdDSA", scopes: ["jobs", "simulate"] });
        const token = bearerTokenOf(`Bearer ${workerToken}`);
        expect(token).not.toBeNull();
        const req = new Request("http://localhost/api/v1/worker/claim", {
          headers: { authorization: `Bearer ${token}` },
        });
        const accepted = authenticateServiceRequest(req, "jobs");
        expect(accepted.ok).toBe(true);
        if (accepted.ok) {
          expect(accepted.principal.issuer).toBe("fayanms:worker");
          expect(accepted.principal.scopes).toContain("jobs");
        }

        const FOREIGN = generateKeyPairSync("ed25519");
        const untrusted = handMint({
          alg: "EdDSA",
          privateKeyPem: FOREIGN.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
        });
        const rejected = authenticateServiceRequest(
          new Request("http://localhost/api/v1/worker/claim", {
            headers: { authorization: `Bearer ${untrusted}` },
          }),
          "jobs"
        );
        expect(rejected.ok).toBe(false);
      }
    );
  });

  test("parseServicePrivateKey refuses truncated PEM and non-Ed25519 keys", () => {
    expect(() => parseServicePrivateKey("not-a-key")).toThrow();
    expect(() => parseServicePrivateKey(RSA_PRIV_PEM)).toThrow();
    expect(parseServicePrivateKey(CONTROL_PRIV_PEM).asymmetricKeyType).toBe("ed25519");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Worker boot tier — §12 process-specific startup validation
// ════════════════════════════════════════════════════════════════════════════

describe("SVC-001-A worker boot check — a process requires only ITS identity material", () => {
  const ok = (env: WorkerIdentityEnv): WorkerIdentityEnv => env;

  test("legacy mode (secret only — the certify/ci shape) boots", () => {
    expect(() => assertWorkerServiceIdentity(ok({ publicKeysRaw: null, privateKeyRaw: null, serviceSecretRaw: FRESH }))).not.toThrow();
  });

  test("valid EdDSA-only worker (public keys + own private key, no secret) boots", () => {
    expect(() =>
      assertWorkerServiceIdentity(
        ok({ publicKeysRaw: CONTROL_PUB_PEM, privateKeyRaw: WORKER_PRIV_PEM, serviceSecretRaw: null })
      )
    ).not.toThrow();
  });

  test("dual worker (public keys + private key + secret) boots", () => {
    expect(() =>
      assertWorkerServiceIdentity(
        ok({ publicKeysRaw: CONTROL_PUB_PEM, privateKeyRaw: WORKER_PRIV_PEM, serviceSecretRaw: FRESH })
      )
    ).not.toThrow();
  });

  test("unconfigured worker refuses to boot", () => {
    expect(() =>
      assertWorkerServiceIdentity(ok({ publicKeysRaw: null, privateKeyRaw: null, serviceSecretRaw: null }))
    ).toThrow(/not configured/);
  });

  test("EdDSA-only worker WITHOUT its private key refuses to boot (no symmetric fallback)", () => {
    expect(() =>
      assertWorkerServiceIdentity(ok({ publicKeysRaw: CONTROL_PUB_PEM, privateKeyRaw: null, serviceSecretRaw: null }))
    ).toThrow(/requires FAYANMS_SERVICE_PRIVATE_KEY/);
  });

  test("private key WITHOUT public keys refuses to boot (minted tokens could never verify)", () => {
    expect(() =>
      assertWorkerServiceIdentity(ok({ publicKeysRaw: null, privateKeyRaw: WORKER_PRIV_PEM, serviceSecretRaw: FRESH }))
    ).toThrow(/could never verify/);
  });

  test("malformed public keys refuse to boot", () => {
    expect(() =>
      assertWorkerServiceIdentity(ok({ publicKeysRaw: "garbage", privateKeyRaw: WORKER_PRIV_PEM, serviceSecretRaw: null }))
    ).toThrow(/malformed/);
  });

  test("malformed private key refuses to boot", () => {
    expect(() =>
      assertWorkerServiceIdentity(ok({ publicKeysRaw: CONTROL_PUB_PEM, privateKeyRaw: "not-a-key", serviceSecretRaw: null }))
    ).toThrow(/malformed/);
  });

  test("resolver: process.env wins over the repo-root .env fallback", () => {
    const saved = process.env.FAYANMS_SERVICE_PUBLIC_KEYS;
    process.env.FAYANMS_SERVICE_PUBLIC_KEYS = "process-env-marker";
    try {
      expect(resolveWorkerIdentityEnv().publicKeysRaw).toBe("process-env-marker");
    } finally {
      if (saved === undefined) delete process.env.FAYANMS_SERVICE_PUBLIC_KEYS;
      else process.env.FAYANMS_SERVICE_PUBLIC_KEYS = saved;
    }
  });
});
