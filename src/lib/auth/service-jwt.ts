/**
 * Pure service-JWT verification core (SAFE-002 refactor).
 *
 * Extracted from src/lib/auth/service-auth.ts so the proxy gate
 * (src/proxy.ts) can verify the machine plane WITHOUT importing the
 * heavyweight session module (which instantiates the Prisma client).
 * This module imports ONLY node:crypto — safe for the middleware/proxy
 * module graph, and unit-testable in isolation.
 *
 * Token contract (Phase 19 / audit SEC-002):
 *   header  { alg: "HS256", typ: "JWT" }
 *   payload { iss, sub, aud: "fayanms:internal", iat, exp, jti, scopes }
 *
 * Verification enforces, in order:
 *   1. well-formed compact JWT with alg "HS256";
 *   2. signature valid against ANY accepted secret (current + rotation
 *      list, timing-safe compare);
 *   3. audience exactly "fayanms:internal";
 *   4. not expired / not issued in the future (± 30 s clock skew);
 *   5. iss/sub present and issuer allowlisted (a shared symmetric secret
 *      alone would let any holder mint tokens with arbitrary identities).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const SERVICE_AUDIENCE = "fayanms:internal";
const CLOCK_SKEW_S = 30;

/**
 * Issuer allowlist (Phase 19-C / audit SVC-101 §11.3). Override with
 * FAYANMS_SERVICE_ISSUERS (comma list) when additional machine identities
 * are introduced; each issuer must still present a valid signature under a
 * configured secret.
 */
export function getServiceIssuers(): string[] {
  const raw = process.env.FAYANMS_SERVICE_ISSUERS?.trim();
  const configured = raw
    ? raw.split(",").map((value) => value.trim()).filter(Boolean)
    : [];
  return configured.length > 0 ? configured : ["fayanms:worker"];
}

/** All accepted secrets: the current one plus any rotation-window values. */
export function getServiceSecrets(): string[] {
  const secrets: string[] = [];
  const current = process.env.FAYANMS_SERVICE_SECRET?.trim();
  if (current) secrets.push(current);
  for (const raw of (process.env.FAYANMS_SERVICE_SECRETS ?? "").split(",")) {
    const value = raw.trim();
    if (value && !secrets.includes(value)) secrets.push(value);
  }
  return secrets;
}

export interface ServicePrincipal {
  readonly kind: "service";
  readonly id: string;
  readonly issuer: string;
  readonly scopes: string[];
}

/**
 * Per-route scope catalog (Phase 19-C): jobs (worker job engine), simulate
 * (Next→worker simulator calls), alerts, reports, metrics.
 */
export type ServiceScope = "jobs" | "simulate" | "alerts" | "reports" | "metrics";

export type ServiceAuthResult =
  | { ok: true; principal: ServicePrincipal }
  | { ok: false; code: string; message: string };


function b64urlToJson(part: string): Record<string, unknown> | null {
  try {
    const json = Buffer.from(part, "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function hmac(signingInput: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(signingInput).digest();
}

function timingSafeEqualBuffer(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Verify a compact JWS; returns the payload or a precise failure. */
function verifyServiceJwt(
  token: string,
  secrets: string[]
): { ok: true; payload: Record<string, unknown> } | { ok: false; code: string; message: string } {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, code: "SERVICE_TOKEN_MALFORMED", message: "Service token is not a compact JWS." };
  }
  const [headPart, bodyPart, sigPart] = parts;
  const header = b64urlToJson(headPart);
  if (!header || header.alg !== "HS256" || header.typ !== "JWT") {
    return { ok: false, code: "SERVICE_TOKEN_MALFORMED", message: "Service token header must be {alg:HS256,typ:JWT}." };
  }
  const signature = Buffer.from(sigPart, "base64url");
  const signingInput = `${headPart}.${bodyPart}`;
  const valid = secrets.some((secret) =>
    timingSafeEqualBuffer(signature, hmac(signingInput, secret))
  );
  if (!valid) {
    return { ok: false, code: "SERVICE_TOKEN_INVALID", message: "Service token signature verification failed." };
  }
  const payload = b64urlToJson(bodyPart);
  if (!payload) {
    return { ok: false, code: "SERVICE_TOKEN_MALFORMED", message: "Service token payload is not valid JSON." };
  }
  if (payload.aud !== SERVICE_AUDIENCE) {
    return { ok: false, code: "SERVICE_AUDIENCE_INVALID", message: `Service token audience must be "${SERVICE_AUDIENCE}".` };
  }
  const now = Math.floor(Date.now() / 1000);
  const exp = typeof payload.exp === "number" ? payload.exp : null;
  const iat = typeof payload.iat === "number" ? payload.iat : null;
  if (exp === null) {
    return { ok: false, code: "SERVICE_TOKEN_MALFORMED", message: "Service token must carry a numeric exp." };
  }
  if (exp + CLOCK_SKEW_S < now) {
    return { ok: false, code: "SERVICE_TOKEN_EXPIRED", message: "Service token has expired." };
  }
  if (iat !== null && iat - CLOCK_SKEW_S > now) {
    return { ok: false, code: "SERVICE_TOKEN_MALFORMED", message: "Service token iat is in the future." };
  }
  return { ok: true, payload };
}

/**
 * Verify a bearer service token end-to-end (signature + audience + expiry
 * + issuer allowlist). Returns the principal on success — the single
 * verification path used by BOTH the proxy gate (machine-plane exemption,
 * no scope) and the route handlers (authenticateServiceRequest + scope).
 */
export function verifyServiceToken(token: string): ServiceAuthResult {
  const secrets = getServiceSecrets();
  if (secrets.length === 0) {
    return {
      ok: false,
      code: "SERVICE_UNCONFIGURED",
      message: "FAYANMS_SERVICE_SECRET is not configured on the server.",
    };
  }
  const verified = verifyServiceJwt(token, secrets);
  if (!verified.ok) return verified;

  const payload = verified.payload;
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  const iss = typeof payload.iss === "string" ? payload.iss : "";
  if (sub.length === 0 || iss.length === 0) {
    return { ok: false, code: "SERVICE_TOKEN_MALFORMED", message: "Service token must carry iss and sub." };
  }
  if (!getServiceIssuers().includes(iss)) {
    return {
      ok: false,
      code: "SERVICE_ISSUER_INVALID",
      message: `Service token issuer "${iss}" is not in the allowlist.`,
    };
  }
  const scopes = Array.isArray(payload.scopes)
    ? payload.scopes.filter((s): s is string => typeof s === "string")
    : [];
  return {
    ok: true,
    principal: { kind: "service", id: sub, issuer: iss, scopes },
  };
}

/** Extract the bearer token from an Authorization header value (or null). */
export function bearerTokenOf(authorization: string | null | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
  return match ? match[1] : null;
}
