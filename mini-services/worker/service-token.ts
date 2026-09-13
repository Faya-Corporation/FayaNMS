/**
 * FayaNMS worker — service-principal token signer (P19 / audit SEC-002).
 *
 * The Next.js side now authenticates every internal job-engine call with an
 * HS256 service JWT (src/lib/auth/service-auth.ts). This module signs those
 * tokens with the SHARED secret from the repo-root .env (FAYANMS_SERVICE_
 * SECRET) or process.env — zero external dependencies, same wire format.
 *
 * Token shape: header {alg:"HS256",typ:"JWT"}, payload
 *   { iss: "fayanms:worker", sub: "worker:sim-1", aud: "fayanms:internal",
 *     iat, exp, jti, scopes: ["jobs", "simulate", "alerts", "reports", "metrics"] }
 * Tokens are cached and refreshed 60 s before expiry.
 */

import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AUDIENCE = "fayanms:internal";
const TOKEN_TTL_S = 300; // 5 minutes — short-lived per audit guidance
const REFRESH_MARGIN_S = 60;

let cached: { token: string; expiresAtMs: number } | null = null;

function readRootEnvSecret(): string | null {
  if (process.env.FAYANMS_SERVICE_SECRET) {
    return process.env.FAYANMS_SERVICE_SECRET.trim();
  }
  try {
    const envPath = join(import.meta.dir, "..", "..", ".env");
    const text = readFileSync(envPath, "utf8");
    for (const line of text.split("\n")) {
      const match = /^FAYANMS_SERVICE_SECRET=(.+)$/.exec(line.trim());
      if (match) {
        let value = match[1].trim();
        // Tolerate dotenv-style quoting (Phase 22 lesson: a quoted value in
        // .env must not leak its quote characters into the HMAC secret).
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

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** Sign a fresh HS256 service token (or return the cached, still-valid one). */
export function serviceAuthToken(): string {
  const nowMs = Date.now();
  if (cached && cached.expiresAtMs - nowMs > REFRESH_MARGIN_S * 1000) {
    return cached.token;
  }
  const secret = readRootEnvSecret();
  if (!secret) {
    throw new Error(
      "FAYANMS_SERVICE_SECRET is not set (checked process env and repo-root .env) — cannot authenticate to the Next.js API."
    );
  }
  const nowS = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
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
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  const token = `${header}.${payload}.${signature}`;
  cached = { token, expiresAtMs: nowMs + TOKEN_TTL_S * 1000 };
  return token;
}

/** Authorization header value for outbound Next.js service calls. */
export function serviceAuthHeader(): string {
  return `Bearer ${serviceAuthToken()}`;
}
