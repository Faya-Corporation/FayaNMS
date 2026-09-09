import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";

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

function withEnv<T>(fn: () => T): T {
  const previous = process.env.FAYANMS_SERVICE_SECRET;
  const previousIssuers = process.env.FAYANMS_SERVICE_ISSUERS;
  process.env.FAYANMS_SERVICE_SECRET = TEST_SECRET;
  delete process.env.FAYANMS_SERVICE_ISSUERS;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.FAYANMS_SERVICE_SECRET;
    else process.env.FAYANMS_SERVICE_SECRET = previous;
    if (previousIssuers === undefined) delete process.env.FAYANMS_SERVICE_ISSUERS;
    else process.env.FAYANMS_SERVICE_ISSUERS = previousIssuers;
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
    const previous = process.env.FAYANMS_SERVICE_SECRET;
    delete process.env.FAYANMS_SERVICE_SECRET;
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
      if (previous === undefined) delete process.env.FAYANMS_SERVICE_SECRET;
      else process.env.FAYANMS_SERVICE_SECRET = previous;
    }
  });
});
