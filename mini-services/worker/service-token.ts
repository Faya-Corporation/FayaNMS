/**
 * FayaNMS worker — service-principal token signer (P19 / audit SEC-002;
 * P1-007 asymmetric service identity).
 *
 * The Next.js side authenticates every internal job-engine call with a
 * short-lived service JWT (src/lib/auth/service-auth.ts). This module signs
 * those tokens with the worker's own identity:
 *
 *   PREFERRED  Ed25519 (alg "EdDSA") when FAYANMS_SERVICE_PRIVATE_KEY is
 *              configured — the Next.js verifier holds only the matching
 *              FAYANMS_SERVICE_PUBLIC_KEYS and can therefore authenticate
 *              but never mint worker tokens.
 *   LEGACY     HS256 with the SHARED secret (FAYANMS_SERVICE_SECRET from
 *              the repo-root .env or process.env) — Phase 1 of the P1-007
 *              rotation; removing the shared secret everywhere completes
 *              Phase 2. Zero external dependencies, same wire format.
 *
 * Token shape: header {alg:"EdDSA"|"HS256",typ:"JWT"}, payload
 *   { iss: "fayanms:worker", sub: "worker:sim-1", aud: "fayanms:internal",
 *     iat, exp, jti, scopes: ["jobs", "simulate", "alerts", "reports", "metrics"] }
 * Tokens are cached and refreshed 60 s before expiry; resetServiceTokenCache()
 * forces a fresh mint after an operator rotates key material without a
 * process restart.
 */

import { createHmac, randomUUID, sign as ed25519Sign, createPrivateKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AUDIENCE = "fayanms:internal";
const TOKEN_TTL_S = 300; // 5 minutes — short-lived per audit guidance
const REFRESH_MARGIN_S = 60;

let cached: { token: string; expiresAtMs: number } | null = null;

/** Invalidate the cached token (key rotation / tests). */
export function resetServiceTokenCache(): void {
  cached = null;
}

/**
 * Read an env value from process.env first, then the repo-root .env, with
 * dotenv-style quote tolerance and escaped-\n PEM support.
 */
function readRootEnvValue(key: string): string | null {
  const fromProcess = process.env[key];
  if (typeof fromProcess === "string" && fromProcess.trim()) {
    return fromProcess.trim();
  }
  try {
    const envPath = join(import.meta.dir, "..", "..", ".env");
    const text = readFileSync(envPath, "utf8");
    for (const line of text.split("\n")) {
      const match = new RegExp(`^${key}=(.+)$`).exec(line.trim());
      if (match) {
        let value = match[1].trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        return value;
      }
    }
  } catch {
    /* .env unreadable — fall through */
  }
  return null;
}

/** The worker's Ed25519 private key, or null when unconfigured. */
function signingKey(): KeyObject | null {
  const raw = readRootEnvValue("FAYANMS_SERVICE_PRIVATE_KEY");
  if (!raw) return null;
  const pem = raw.includes("\\n") ? raw.replaceAll("\\n", "\n") : raw;
  return createPrivateKey(pem);
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** Sign a fresh service token (or return the cached, still-valid one). */
export function serviceAuthToken(): string {
  const nowMs = Date.now();
  if (cached && cached.expiresAtMs - nowMs > REFRESH_MARGIN_S * 1000) {
    return cached.token;
  }
  const nowS = Math.floor(nowMs / 1000);
  const header = (alg: string): string =>
    b64url(JSON.stringify({ alg, typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "fayanms:worker",
      sub: "worker:sim-1",
      aud: AUDIENCE,
      iat: nowS,
      exp: nowS + TOKEN_TTL_S,
      jti: randomUUID(),
      scopes: ["jobs", "simulate", "alerts", "reports", "metrics"],
    })
  );

  const key = signingKey();
  if (key) {
    // P1-007: asymmetric worker identity — Ed25519, null digest (RFC 8032).
    const signingInput = `${header("EdDSA")}.${payload}`;
    const signature = ed25519Sign(null, Buffer.from(signingInput), key)
      .toString("base64url");
    const token = `${signingInput}.${signature}`;
    cached = { token, expiresAtMs: nowMs + TOKEN_TTL_S * 1000 };
    return token;
  }

  const secret = readRootEnvValue("FAYANMS_SERVICE_SECRET");
  if (!secret) {
    throw new Error(
      "Neither FAYANMS_SERVICE_PRIVATE_KEY nor FAYANMS_SERVICE_SECRET is set (checked process env and repo-root .env) — cannot authenticate to the Next.js API."
    );
  }
  const signingInput = `${header("HS256")}.${payload}`;
  const signature = createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64url");
  const token = `${signingInput}.${signature}`;
  cached = { token, expiresAtMs: nowMs + TOKEN_TTL_S * 1000 };
  return token;
}

/** Authorization header value for outbound Next.js service calls. */
export function serviceAuthHeader(): string {
  return `Bearer ${serviceAuthToken()}`;
}
