import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";

import { resetServiceReplayCache } from "../../src/lib/auth/service-jwt";
import {
  authenticateServiceRequest,
  mintServiceToken,
  SERVICE_AUDIENCE,
} from "../../src/lib/auth/service-auth";

/**
 * Service-auth scope/issuer enforcement (Phase 19-C / audit SVC-101).
 * Covers the audit's service-auth test matrix: missing token, bad
 * signature, wrong audience, expired, wrong scope, wrong issuer.
 */

const TEST_SECRET = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";

/* Full service-plane sandbox (wave-11 hygiene): the original helper only
 * managed the two variables it cared about, so an ambient asymmetric
 * keypair (the worktree .env keypair is a mismatched pair — batch-16) made
 * mintServiceToken prefer EdDSA while the verifier saw a different trust
 * plane, false-failing every fixture outside CI. Pin ALL service variables
 * (the FAYANMS_SERVICE_ENV_FILE empty value is the R64 knob that keeps a
 * worker-side .env fallback from re-supplying material) and reset the
 * wave-11 jti replay bindings per sandbox entry. Pin semantics unchanged.
 */
const SERVICE_ENV_KEYS = [
  "FAYANMS_SERVICE_SECRET",
  "FAYANMS_SERVICE_SECRETS",
  "FAYANMS_SERVICE_ISSUERS",
  "FAYANMS_SERVICE_PUBLIC_KEYS",
  "FAYANMS_SERVICE_PRIVATE_KEY",
  "FAYANMS_SERVICE_ENV_FILE",
] as const;

function withEnv<T>(fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of SERVICE_ENV_KEYS) saved.set(key, process.env[key]);
  for (const key of SERVICE_ENV_KEYS) delete process.env[key];
  process.env.FAYANMS_SERVICE_ENV_FILE = "";
  process.env.FAYANMS_SERVICE_SECRET = TEST_SECRET;
  delete process.env.FAYANMS_SERVICE_ISSUERS;
  resetServiceReplayCache();
  try {
    return fn();
  } finally {
    for (const [key, value] of saved.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetServiceReplayCache();
  }
}

function requestWithToken(token: string | null): Request {
  return new Request("http://localhost:3000/api/v1/worker/claim", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("service JWT verification", () => {
  test("valid token with the required scope authenticates", () => {
    withEnv(() => {
      const token = mintServiceToken({ issuer: "fayanms:worker", scopes: ["jobs"] });
      const result = authenticateServiceRequest(requestWithToken(token), "jobs");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.principal.issuer).toBe("fayanms:worker");
        expect(result.principal.scopes).toContain("jobs");
      }
    });
  });

  test("missing token is rejected", () => {
    withEnv(() => {
      const result = authenticateServiceRequest(requestWithToken(null), "jobs");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("SERVICE_UNAUTHENTICATED");
    });
  });

  test("tampered payload fails the signature check", () => {
    withEnv(() => {
      const token = mintServiceToken({ scopes: ["jobs"] });
      const [head, body, sig] = token.split(".");
      const forged = Buffer.from(
        JSON.stringify({
          iss: "fayanms:control",
          sub: "attacker",
          aud: SERVICE_AUDIENCE,
          exp: Math.floor(Date.now() / 1000) + 60,
          scopes: ["jobs"],
        })
      ).toString("base64url");
      const result = authenticateServiceRequest(
        requestWithToken(`${head}.${forged}.${sig}`),
        "jobs"
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("SERVICE_TOKEN_INVALID");
    });
  });

  test("wrong audience is rejected", () => {
    withEnv(() => {
      // Properly SIGNED token whose audience is not fayanms:internal.
      const secret = TEST_SECRET;
      const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const body = Buffer.from(
        JSON.stringify({
          iss: "fayanms:worker",
          sub: "worker:sim-1",
          aud: "some:other:audience",
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 60,
          jti: "aud-test",
          scopes: ["jobs"],
        })
      ).toString("base64url");
      const sig = createHmac("sha256", secret)
        .update(`${head}.${body}`)
        .digest("base64url");
      const result = authenticateServiceRequest(requestWithToken(`${head}.${body}.${sig}`));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("SERVICE_AUDIENCE_INVALID");
    });
  });

  test("expired token is rejected", () => {
    withEnv(() => {
      const token = mintServiceToken({ scopes: ["jobs"], ttlSeconds: -60 });
      const result = authenticateServiceRequest(requestWithToken(token), "jobs");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("SERVICE_TOKEN_EXPIRED");
    });
  });

  test("token without the required scope is rejected (scopes are authorization)", () => {
    withEnv(() => {
      const token = mintServiceToken({ issuer: "fayanms:worker", scopes: ["reports"] });
      const result = authenticateServiceRequest(requestWithToken(token), "jobs");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("SERVICE_SCOPE_INSUFFICIENT");
    });
  });

  test("issuer outside the allowlist is rejected", () => {
    withEnv(() => {
      const token = mintServiceToken({ issuer: "fayanms:rogue", scopes: ["jobs"] });
      const result = authenticateServiceRequest(requestWithToken(token), "jobs");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("SERVICE_ISSUER_INVALID");
    });
  });

  test("the control-plane issuer is NOT accepted for job-engine routes by default", () => {
    withEnv(() => {
      // mintServiceToken's default issuer is fayanms:control (the Next→worker
      // identity) — the Next-side verifier allowlists fayanms:worker only.
      const token = mintServiceToken({ scopes: ["jobs"] });
      const result = authenticateServiceRequest(requestWithToken(token), "jobs");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("SERVICE_ISSUER_INVALID");
    });
  });

  test("the worker's issuer is allowlisted by default", () => {
    withEnv(() => {
      const token = mintServiceToken({ issuer: "fayanms:worker", scopes: ["alerts"] });
      const result = authenticateServiceRequest(requestWithToken(token), "alerts");
      expect(result.ok).toBe(true);
    });
  });

  test("unconfigured server fails closed", () => {
    // Truly unconfigured = NO service variable anywhere (wave-11 hygiene:
    // the original helper deleted only the secret, so an ambient .env
    // keypair made the verifier asymmetric-capable and the token answered
    // SERVICE_ALG_REJECTED instead of the pinned SERVICE_UNCONFIGURED —
    // in CI, with no .env, the pinned code is the real one).
    const saved = new Map<string, string | undefined>();
    for (const key of SERVICE_ENV_KEYS) saved.set(key, process.env[key]);
    for (const key of SERVICE_ENV_KEYS) delete process.env[key];
    try {
      const secret = TEST_SECRET;
      const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const body = Buffer.from(
        JSON.stringify({
          iss: "fayanms:worker",
          sub: "worker:sim-1",
          aud: "fayanms:internal",
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 60,
          jti: "no-secret",
          scopes: ["jobs"],
        })
      ).toString("base64url");
      const sig = createHmac("sha256", secret)
        .update(`${head}.${body}`)
        .digest("base64url");
      const result = authenticateServiceRequest(requestWithToken(`${head}.${body}.${sig}`), "jobs");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("SERVICE_UNCONFIGURED");
    } finally {
      for (const [key, value] of saved.entries()) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
