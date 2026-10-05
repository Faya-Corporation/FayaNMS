import { createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, sign as ed25519Sign, verify as cryptoVerify } from "node:crypto";
import { describe, expect, test } from "bun:test";

import {
  authenticateServiceRequest,
  mintServiceToken,
  SERVICE_AUDIENCE,
} from "../../src/lib/auth/service-auth";
import {
  bearerTokenOf,
  resetServiceReplayCache,
  verifyServiceToken,
} from "../../src/lib/auth/service-jwt";
import {
  resetServiceTokenCache,
  serviceAuthToken,
} from "../../mini-services/worker/service-token";
import { verifyControlToken } from "../../mini-services/worker/control-auth";

/**
 * P1-007 — asymmetric service identity (ULTRA audit: "HS256 shared-secret
 * only; holder of the secret can mint any token").
 *
 * Pins the Ed25519 (alg "EdDSA") plane end-to-end:
 *   - minters PREFER the private key; HS256 remains the explicit fallback;
 *   - verifiers holding ONLY public keys can authenticate but never mint;
 *   - the flag-free rotation is real: both algs accepted while the shared
 *     secret exists; removing it makes HS256 structurally impossible
 *     (SERVICE_ALG_REJECTED / WORKER_ALG_REJECTED);
 *   - malformed configured keys fail TIGHT (never silently dropped);
 *   - the full two-plane loop: a worker-minted EdDSA token verifies on the
 *     Next.js side against the worker's public key, and vice versa.
 */

const CONTROL = generateKeyPairSync("ed25519");
const WORKER = generateKeyPairSync("ed25519");

const CONTROL_PUB_SPKI = CONTROL.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const CONTROL_PRIV_PEM = CONTROL.privateKey
  .export({ format: "pem", type: "pkcs8" })
  .toString("utf8")
  .trim()
  .replaceAll("\n", "\\n");
const WORKER_PUB_SPKI = WORKER.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const WORKER_PRIV_PEM = WORKER.privateKey
  .export({ format: "pem", type: "pkcs8" })
  .toString("utf8")
  .trim()
  .replaceAll("\n", "\\n");

const TEST_SECRET = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";

const SERVICE_ENV_KEYS = [
  "FAYANMS_SERVICE_SECRET",
  "FAYANMS_SERVICE_SECRETS",
  "FAYANMS_SERVICE_ISSUERS",
  "FAYANMS_SERVICE_PUBLIC_KEYS",
  "FAYANMS_SERVICE_PRIVATE_KEY",
  // Wave-11 hygiene: the worker's readRootEnvValue falls back to the
  // repo-root .env file when process.env lacks a key — without pinning the
  // R64 knob empty, the worktree .env's (mismatched) keypair leaks into the
  // worker-side fixtures below and false-fails them outside CI.
  "FAYANMS_SERVICE_ENV_FILE",
] as const;

/** Full env sandbox — every service-plane variable is explicitly managed. */
async function withServiceEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => T | Promise<T>
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of SERVICE_ENV_KEYS) saved.set(key, process.env[key]);
  for (const key of SERVICE_ENV_KEYS) delete process.env[key];
  process.env.FAYANMS_SERVICE_ENV_FILE = ""; // R64: no .env-file fallback in tests
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
  resetServiceReplayCache(); // wave-11 jti bindings start empty per sandbox
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetServiceReplayCache();
  }
}

function tokenHeader(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8")) as Record<string, unknown>;
}

function requestWithToken(token: string | null): Request {
  return new Request("http://localhost:3000/api/v1/worker/claim", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

/** Hand-mint an EdDSA control token the way the worker side expects it. */
function handMintEdDSA(options: {
  privateKeyPem: string;
  iss: string;
  sub: string;
  aud?: string;
  scopes: string[];
  ttlSeconds?: number;
}): string {
  const b64 = (input: string | Buffer): string => Buffer.from(input).toString("base64url");
  const nowS = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
  const payload = b64(
    JSON.stringify({
      iss: options.iss,
      sub: options.sub,
      aud: options.aud ?? SERVICE_AUDIENCE,
      iat: nowS,
      exp: nowS + (options.ttlSeconds ?? 300),
      scopes: options.scopes,
    })
  );
  const priv = createPrivateKey(options.privateKeyPem.replaceAll("\\n", "\n"));
  const signature = ed25519Sign(null, Buffer.from(`${header}.${payload}`), priv).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

describe("P1-007 Next.js plane: minting preference", () => {
  test("with a private key configured, minted tokens are EdDSA and verify", async () => {
    await withServiceEnv(
      {
        FAYANMS_SERVICE_PRIVATE_KEY: CONTROL_PRIV_PEM,
        FAYANMS_SERVICE_PUBLIC_KEYS: CONTROL_PUB_SPKI,
        // The Next verifier's default allowlist is the worker identity only;
        // control-minted tokens on this plane are an explicit allowlist entry.
        FAYANMS_SERVICE_ISSUERS: "fayanms:control,fayanms:worker",
      },
      async () => {
        const token = mintServiceToken({ scopes: ["jobs"] });
        expect(tokenHeader(token).alg).toBe("EdDSA");
        const result = verifyServiceToken(token);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.principal.issuer).toBe("fayanms:control");
          expect(result.principal.scopes).toContain("jobs");
        }
      },
    );
  });

  test("mint preference: private key + shared secret both present → EdDSA wins", async () => {
    await withServiceEnv(
      {
        FAYANMS_SERVICE_PRIVATE_KEY: CONTROL_PRIV_PEM,
        FAYANMS_SERVICE_PUBLIC_KEYS: CONTROL_PUB_SPKI,
        FAYANMS_SERVICE_SECRET: TEST_SECRET,
      },
      () => {
        expect(tokenHeader(mintServiceToken({ scopes: ["jobs"] })).alg).toBe("EdDSA");
      },
    );
  });

  test("HS256 fallback without a private key (Phase 1 coexistence)", async () => {
    await withServiceEnv(
      { FAYANMS_SERVICE_SECRET: TEST_SECRET, FAYANMS_SERVICE_ISSUERS: "fayanms:control,fayanms:worker" },
      () => {
      const token = mintServiceToken({ scopes: ["reports"] });
      expect(tokenHeader(token).alg).toBe("HS256");
      expect(verifyServiceToken(token).ok).toBe(true);
    });
  });

  test("no trust plane at all → minting refuses loudly", async () => {
    await withServiceEnv({}, () => {
      expect(() => mintServiceToken({ scopes: ["jobs"] })).toThrow(/cannot mint a service token/);
    });
  });
});

describe("P1-007 Next.js plane: verifier trust policy", () => {
  test("public keys ONLY (no shared secret) authenticate EdDSA — verifiers cannot mint", async () => {
    await withServiceEnv(
      {
        FAYANMS_SERVICE_PRIVATE_KEY: CONTROL_PRIV_PEM,
        FAYANMS_SERVICE_PUBLIC_KEYS: CONTROL_PUB_SPKI,
        FAYANMS_SERVICE_SECRET: TEST_SECRET,
      },
      () => {
        const token = mintServiceToken({ scopes: ["jobs"] });
        // Phase 2 endpoint state: the shared secret is GONE on the verifier.
        return withServiceEnv(
          { FAYANMS_SERVICE_PUBLIC_KEYS: CONTROL_PUB_SPKI, FAYANMS_SERVICE_ISSUERS: "fayanms:control,fayanms:worker" },
          () => {
            const result = verifyServiceToken(token);
            expect(result.ok).toBe(true);
            if (result.ok) expect(result.principal.id).toBe("control-plane");
          },
        );
      },
    );
  });

  test("Phase 2 endpoint: HS256 token presented where the symmetric plane is retired → SERVICE_ALG_REJECTED", async () => {
    await withServiceEnv({ FAYANMS_SERVICE_PUBLIC_KEYS: CONTROL_PUB_SPKI }, () => {
      const b64 = (input: string | Buffer): string => Buffer.from(input).toString("base64url");
      const nowS = Math.floor(Date.now() / 1000);
      const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
      const body = b64(JSON.stringify({ iss: "fayanms:worker", sub: "worker:sim-1", aud: SERVICE_AUDIENCE, iat: nowS, exp: nowS + 300, scopes: ["jobs"] }));
      const sig = createHmac("sha256", TEST_SECRET).update(`${head}.${body}`).digest("base64url");
      const result = verifyServiceToken(`${head}.${body}.${sig}`);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("SERVICE_ALG_REJECTED");
        expect(result.message).toMatch(/symmetric plane is retired/);
      }
    });
  });

  test("EdDSA presented where no public keys are configured → SERVICE_ALG_REJECTED", async () => {
    await withServiceEnv({ FAYANMS_SERVICE_SECRET: TEST_SECRET }, () => {
      const token = handMintEdDSA({ privateKeyPem: CONTROL_PRIV_PEM, iss: "fayanms:control", sub: "control-plane", scopes: ["jobs"] });
      const result = verifyServiceToken(token);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("SERVICE_ALG_REJECTED");
    });
  });

  test("neither plane configured → SERVICE_UNCONFIGURED", async () => {
    await withServiceEnv({}, () => {
      const result = verifyServiceToken("a.b.c");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("SERVICE_UNCONFIGURED");
        expect(result.message).toMatch(/FAYANMS_SERVICE_PUBLIC_KEYS/);
      }
    });
  });

  test("token signed by a foreign keypair is refused (wrong identity)", async () => {
    await withServiceEnv(
      {
        FAYANMS_SERVICE_PRIVATE_KEY: CONTROL_PRIV_PEM,
        FAYANMS_SERVICE_PUBLIC_KEYS: WORKER_PUB_SPKI,
        FAYANMS_SERVICE_ISSUERS: "fayanms:control,fayanms:worker",
      },
      () => {
      const token = mintServiceToken({ scopes: ["jobs"] }); // signed by CONTROL private key
      const result = verifyServiceToken(token);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("SERVICE_TOKEN_INVALID");
    });
  });

  test("rotation: an old key verifies while its public half remains in the list", async () => {
    await withServiceEnv(
      {
        FAYANMS_SERVICE_PRIVATE_KEY: CONTROL_PRIV_PEM,
        FAYANMS_SERVICE_PUBLIC_KEYS: `${WORKER_PUB_SPKI},${CONTROL_PUB_SPKI}`,
        FAYANMS_SERVICE_ISSUERS: "fayanms:control,fayanms:worker",
      },
      () => {
        expect(verifyServiceToken(mintServiceToken({ scopes: ["jobs"] })).ok).toBe(true);
        const workerToken = handMintEdDSA({ privateKeyPem: WORKER_PRIV_PEM, iss: "fayanms:worker", sub: "worker:sim-1", scopes: ["jobs"] });
        expect(verifyServiceToken(workerToken).ok).toBe(true);
      },
    );
  });

  test("tampered payload refused", async () => {
    await withServiceEnv(
      {
        FAYANMS_SERVICE_PRIVATE_KEY: CONTROL_PRIV_PEM,
        FAYANMS_SERVICE_PUBLIC_KEYS: CONTROL_PUB_SPKI,
      },
      () => {
        const token = mintServiceToken({ scopes: ["jobs"] });
        const [head, , sig] = token.split(".");
        const forgedBody = Buffer.from(
          JSON.stringify({ iss: "fayanms:control", sub: "control-plane", aud: SERVICE_AUDIENCE, iat: 1, exp: 9999999999, scopes: ["admin-everything"] })
        ).toString("base64url");
        const result = verifyServiceToken(`${head}.${forgedBody}.${sig}`);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.code).toBe("SERVICE_TOKEN_INVALID");
      },
    );
  });

  test("alg confusion (none / HS384) refused as malformed", async () => {
    await withServiceEnv(
      {
        FAYANMS_SERVICE_PRIVATE_KEY: CONTROL_PRIV_PEM,
        FAYANMS_SERVICE_PUBLIC_KEYS: CONTROL_PUB_SPKI,
        FAYANMS_SERVICE_SECRET: TEST_SECRET,
      },
      () => {
        const b64 = (input: string | Buffer): string => Buffer.from(input).toString("base64url");
        const body = b64(JSON.stringify({ iss: "fayanms:control", sub: "x", aud: SERVICE_AUDIENCE, exp: 9999999999, scopes: [] }));
        for (const alg of ["none", "HS384", "RS256"]) {
          const head = b64(JSON.stringify({ alg, typ: "JWT" }));
          const result = verifyServiceToken(`${head}.${body}.${b64("garbage-signature")}`);
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.code).toBe("SERVICE_TOKEN_MALFORMED");
        }
      },
    );
  });

  test("malformed configured public key material fails TIGHT (SERVICE_KEYS_MISCONFIGURED)", async () => {
    await withServiceEnv({ FAYANMS_SERVICE_PUBLIC_KEYS: "not-base64-key-material!!" }, () => {
      const token = handMintEdDSA({ privateKeyPem: CONTROL_PRIV_PEM, iss: "fayanms:control", sub: "control-plane", scopes: ["jobs"] });
      const result = verifyServiceToken(token);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("SERVICE_KEYS_MISCONFIGURED");
    });
  });

  test("expired EdDSA token → SERVICE_TOKEN_EXPIRED; foreign issuer → SERVICE_ISSUER_INVALID", async () => {
    await withServiceEnv(
      {
        FAYANMS_SERVICE_PRIVATE_KEY: CONTROL_PRIV_PEM,
        FAYANMS_SERVICE_PUBLIC_KEYS: CONTROL_PUB_SPKI,
      },
      () => {
        const expired = mintServiceToken({ scopes: ["jobs"], ttlSeconds: -120 });
        const r1 = verifyServiceToken(expired);
        expect(r1.ok).toBe(false);
        if (!r1.ok) expect(r1.code).toBe("SERVICE_TOKEN_EXPIRED");

        const foreign = mintServiceToken({ issuer: "evil:plane", scopes: ["jobs"] });
        const r2 = verifyServiceToken(foreign);
        expect(r2.ok).toBe(false);
        if (!r2.ok) expect(r2.code).toBe("SERVICE_ISSUER_INVALID");
      },
    );
  });

  test("hand-crafted wrong-audience EdDSA token → SERVICE_AUDIENCE_INVALID", async () => {
    await withServiceEnv({ FAYANMS_SERVICE_PUBLIC_KEYS: CONTROL_PUB_SPKI }, () => {
      const token = handMintEdDSA({ privateKeyPem: CONTROL_PRIV_PEM, iss: "fayanms:control", sub: "control-plane", aud: "other:plane", scopes: ["jobs"] });
      const result = verifyServiceToken(token);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("SERVICE_AUDIENCE_INVALID");
    });
  });

  test("authenticateServiceRequest enforces scopes on the EdDSA path", async () => {
    await withServiceEnv(
      {
        FAYANMS_SERVICE_PRIVATE_KEY: CONTROL_PRIV_PEM,
        FAYANMS_SERVICE_PUBLIC_KEYS: CONTROL_PUB_SPKI,
        FAYANMS_SERVICE_ISSUERS: "fayanms:control,fayanms:worker",
      },
      () => {
        const okResult = authenticateServiceRequest(requestWithToken(mintServiceToken({ scopes: ["jobs"] })), "jobs");
        expect(okResult.ok).toBe(true);

        const insufficient = authenticateServiceRequest(requestWithToken(mintServiceToken({ scopes: ["metrics"] })), "jobs");
        expect(insufficient.ok).toBe(false);
        if (!insufficient.ok) expect(insufficient.code).toBe("SERVICE_SCOPE_INSUFFICIENT");

        const anonymous = authenticateServiceRequest(requestWithToken(null), "jobs");
        expect(anonymous.ok).toBe(false);
        if (!anonymous.ok) expect(anonymous.code).toBe("SERVICE_UNAUTHENTICATED");
      },
    );
  });
});

describe("P1-007 worker plane: control-auth verification", () => {
  test("worker holding ONLY the control public key verifies an EdDSA control token", async () => {
    await withServiceEnv({ FAYANMS_SERVICE_PUBLIC_KEYS: CONTROL_PUB_SPKI }, () => {
      const token = handMintEdDSA({ privateKeyPem: CONTROL_PRIV_PEM, iss: "fayanms:control", sub: "control-plane", scopes: ["simulate"] });
      const result = verifyControlToken(requestWithToken(token), "simulate");
      expect(result.ok).toBe(true);
      expect(result.code).toBe("OK");
    });
  });

  test("legacy HS256 control token still verifies while the shared secret exists", async () => {
    await withServiceEnv(
      { FAYANMS_SERVICE_SECRET: TEST_SECRET, FAYANMS_SERVICE_PUBLIC_KEYS: CONTROL_PUB_SPKI },
      () => {
        const b64 = (input: string | Buffer): string => Buffer.from(input).toString("base64url");
        const nowS = Math.floor(Date.now() / 1000);
        const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
        const body = b64(JSON.stringify({ iss: "fayanms:control", sub: "control-plane", aud: SERVICE_AUDIENCE, iat: nowS, exp: nowS + 300, scopes: ["simulate"] }));
        const sig = createHmac("sha256", TEST_SECRET).update(`${head}.${body}`).digest("base64url");
        const result = verifyControlToken(requestWithToken(`${head}.${body}.${sig}`), "simulate");
        expect(result.ok).toBe(true);
      },
    );
  });

  test("EdDSA control token with no public keys configured → WORKER_ALG_REJECTED", async () => {
    await withServiceEnv({ FAYANMS_SERVICE_SECRET: TEST_SECRET }, () => {
      const token = handMintEdDSA({ privateKeyPem: CONTROL_PRIV_PEM, iss: "fayanms:control", sub: "control-plane", scopes: ["simulate"] });
      const result = verifyControlToken(requestWithToken(token), "simulate");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("WORKER_ALG_REJECTED");
    });
  });

  test("malformed worker-side public keys → WORKER_KEYS_MISCONFIGURED", async () => {
    await withServiceEnv({ FAYANMS_SERVICE_PUBLIC_KEYS: "@@@malformed@!!" }, () => {
      const token = handMintEdDSA({ privateKeyPem: CONTROL_PRIV_PEM, iss: "fayanms:control", sub: "control-plane", scopes: ["simulate"] });
      const result = verifyControlToken(requestWithToken(token), "simulate");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("WORKER_KEYS_MISCONFIGURED");
    });
  });

  test("worker policy pins: foreign issuer, insufficient scope, expired token", async () => {
    await withServiceEnv({ FAYANMS_SERVICE_PUBLIC_KEYS: CONTROL_PUB_SPKI }, () => {
      const foreign = handMintEdDSA({ privateKeyPem: CONTROL_PRIV_PEM, iss: "evil:plane", sub: "x", scopes: ["simulate"] });
      expect(verifyControlToken(requestWithToken(foreign), "simulate").code).toBe("WORKER_ISSUER_INVALID");

      const noScope = handMintEdDSA({ privateKeyPem: CONTROL_PRIV_PEM, iss: "fayanms:control", sub: "control-plane", scopes: ["jobs"] });
      expect(verifyControlToken(requestWithToken(noScope), "simulate").code).toBe("WORKER_SCOPE_INSUFFICIENT");

      const expired = handMintEdDSA({ privateKeyPem: CONTROL_PRIV_PEM, iss: "fayanms:control", sub: "control-plane", scopes: ["simulate"], ttlSeconds: -120 });
      expect(verifyControlToken(requestWithToken(expired), "simulate").code).toBe("WORKER_TOKEN_EXPIRED");
    });
  });
});

describe("P1-007 two-plane loop: worker-minted tokens verify on the Next.js side", () => {
  test("worker mints EdDSA with ITS private key; Next verifies with the worker public key ONLY", async () => {
    await withServiceEnv({ FAYANMS_SERVICE_PRIVATE_KEY: WORKER_PRIV_PEM }, () => {
      resetServiceTokenCache();
      const token = serviceAuthToken();
      expect(tokenHeader(token).alg).toBe("EdDSA");
      // The Next.js verifier state (Phase 2): public keys only, no shared secret.
      return withServiceEnv({ FAYANMS_SERVICE_PUBLIC_KEYS: WORKER_PUB_SPKI }, () => {
        const result = verifyServiceToken(bearerTokenOf(`Bearer ${token}`) ?? "");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.principal.id).toBe("worker:sim-1");
          expect(result.principal.issuer).toBe("fayanms:worker");
          expect(result.principal.scopes).toContain("jobs");
        }
      });
    });
  });

  test("worker falls back to HS256 without a private key (legacy coexistence)", async () => {
    await withServiceEnv({ FAYANMS_SERVICE_SECRET: TEST_SECRET }, () => {
      resetServiceTokenCache();
      const token = serviceAuthToken();
      expect(tokenHeader(token).alg).toBe("HS256");
      expect(verifyServiceToken(token).ok).toBe(true);
      resetServiceTokenCache();
    });
  });

  test("the raw Ed25519 signature round-trips through node verify", async () => {
    const token = handMintEdDSA({ privateKeyPem: WORKER_PRIV_PEM, iss: "fayanms:worker", sub: "worker:sim-1", scopes: ["jobs"] });
    const [head, body, sig] = token.split(".");
    // Bun's createPublicKey(Buffer) shorthand misreads DER as PEM — the
    // explicit {key, format, type} form is the portable one.
    const ok = cryptoVerify(
      null,
      Buffer.from(`${head}.${body}`),
      createPublicKey({ key: Buffer.from(WORKER_PUB_SPKI, "base64"), format: "der", type: "spki" }),
      Buffer.from(sig, "base64url"),
    );
    expect(ok).toBe(true);
  });
});
