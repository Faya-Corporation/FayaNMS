/**
 * FayaNMS worker — control-plane token verifier (Phase 19-C / audit
 * GATEWAY-101 + SVC-101).
 *
 * The worker's HTTP surface is reachable through the sandbox gateway
 * (XTransformPort=3030), so /simulate/* and /capabilities no longer answer
 * anonymous requests: callers must present a short-lived HS256 service JWT
 * signed with the SHARED secret (FAYANMS_SERVICE_SECRET from the repo-root
 * .env), audience "fayanms:internal", issuer allowlisted to the Next.js
 * control plane ("fayanms:control") and — for the simulator mutation
 * endpoints — carrying the "simulate" scope.
 *
 * /health stays open (liveness probe; counters only, no device surface).
 *
 * Zero external dependencies: same wire format as the Next.js verifier
 * (src/lib/auth/service-auth.ts) and the worker's own signer
 * (service-token.ts).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AUDIENCE = "fayanms:internal";
const CLOCK_SKEW_S = 30;

/**
 * Issuer allowlist: the Next.js control plane ("fayanms:control") drives
 * /simulate/* and /capabilities externally; the worker's own runner makes
 * authenticated loopback self-calls with its own identity
 * ("fayanms:worker", scopes include "simulate"). Both are allowlisted —
 * anything else is rejected.
 */
const ISSUER_ALLOWLIST = ["fayanms:control", "fayanms:worker"];

export interface ControlVerifyResult {
  ok: boolean;
  code: string;
  message: string;
}

function readRootEnvSecret(): string | null {
  if (process.env.FAYANMS_SERVICE_SECRET) {
    return process.env.FAYANMS_SERVICE_SECRET.trim();
  }
  try {
    const envPath = join(import.meta.dir, "..", "..", ".env");
    const text = readFileSync(envPath, "utf8");
    for (const line of text.split("\n")) {
      const match = /^FAYANMS_SERVICE_SECRET=(.+)$/.exec(line.trim());
      if (match) return match[1].trim();
    }
  } catch {
    /* .env unreadable — fall through */
  }
  return null;
}

function b64urlToJson(part: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function timingSafeEqualBuffer(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Verify the Bearer token on a worker control request. Optionally requires
 * a scope (e.g. "simulate" for the /simulate/* mutation endpoints).
 */
export function verifyControlToken(
  req: Request,
  requiredScope?: string
): ControlVerifyResult {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    return {
      ok: false,
      code: "WORKER_UNAUTHENTICATED",
      message: "This worker endpoint requires a Bearer service token.",
    };
  }
  const secret = readRootEnvSecret();
  if (!secret) {
    return {
      ok: false,
      code: "WORKER_UNCONFIGURED",
      message: "FAYANMS_SERVICE_SECRET is not configured on the worker.",
    };
  }
  const parts = match[1].split(".");
  if (parts.length !== 3) {
    return { ok: false, code: "WORKER_TOKEN_MALFORMED", message: "Token is not a compact JWS." };
  }
  const [headPart, bodyPart, sigPart] = parts;
  const headerJson = b64urlToJson(headPart);
  if (!headerJson || headerJson.alg !== "HS256" || headerJson.typ !== "JWT") {
    return {
      ok: false,
      code: "WORKER_TOKEN_MALFORMED",
      message: "Token header must be {alg:HS256,typ:JWT}.",
    };
  }
  const expected = createHmac("sha256", secret)
    .update(`${headPart}.${bodyPart}`)
    .digest();
  const presented = Buffer.from(sigPart, "base64url");
  if (!timingSafeEqualBuffer(expected, presented)) {
    return { ok: false, code: "WORKER_TOKEN_INVALID", message: "Token signature verification failed." };
  }
  const payload = b64urlToJson(bodyPart);
  if (!payload) {
    return { ok: false, code: "WORKER_TOKEN_MALFORMED", message: "Token payload is not valid JSON." };
  }
  if (payload.aud !== AUDIENCE) {
    return { ok: false, code: "WORKER_AUDIENCE_INVALID", message: `Token audience must be "${AUDIENCE}".` };
  }
  const iss = typeof payload.iss === "string" ? payload.iss : "";
  if (!ISSUER_ALLOWLIST.includes(iss)) {
    return {
      ok: false,
      code: "WORKER_ISSUER_INVALID",
      message: `Token issuer "${iss}" is not in the allowlist.`,
    };
  }
  const nowS = Math.floor(Date.now() / 1000);
  const exp = typeof payload.exp === "number" ? payload.exp : null;
  const iat = typeof payload.iat === "number" ? payload.iat : null;
  if (exp === null || exp + CLOCK_SKEW_S < nowS) {
    return { ok: false, code: "WORKER_TOKEN_EXPIRED", message: "Token has expired." };
  }
  if (iat !== null && iat - CLOCK_SKEW_S > nowS) {
    return { ok: false, code: "WORKER_TOKEN_MALFORMED", message: "Token iat is in the future." };
  }
  const scopes = Array.isArray(payload.scopes)
    ? payload.scopes.filter((s): s is string => typeof s === "string")
    : [];
  if (requiredScope && !scopes.includes(requiredScope)) {
    return {
      ok: false,
      code: "WORKER_SCOPE_INSUFFICIENT",
      message: `Token lacks the "${requiredScope}" scope required by this endpoint.`,
    };
  }
  return { ok: true, code: "OK", message: "verified" };
}

/** Uniform 401/403 JSON response for rejected control calls. */
export function controlRejectResponse(result: ControlVerifyResult): Response {
  return Response.json(
    { ok: false, error: result.message, code: result.code },
    { status: 401 }
  );
}
