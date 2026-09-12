import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { AuthError } from "@/lib/auth/session";

/**
 * Service-principal authentication (Phase 19 / audit SEC-002).
 *
 * The internal job-engine surface (POST /api/v1/worker/* minus the UI-facing
 * /worker/status diagnostic, plus /api/v1/alerts/evaluate,
 * /api/v1/reports/execute and /api/v1/metrics/retention/prune) is no longer
 * anonymous. Machine callers authenticate with a short-lived HS256 service
 * JWT signed with FAYANMS_SERVICE_SECRET:
 *
 *   header  { alg: "HS256", typ: "JWT" }
 *   payload { iss: "fayanms:<service>", sub: "<machine identity>",
 *             aud: "fayanms:internal", iat, exp, jti, scopes: [...] }
 *
 * Verification enforces, in order:
 *   1. well-formed compact JWT with alg "HS256";
 *   2. signature valid against ANY accepted secret (current + rotation list,
 *      timing-safe compare);
 *   3. audience exactly "fayanms:internal" (wrong audience rejected);
 *   4. not expired and not issued in the future (± 30 s clock skew).
 *
 * Rotation: append the previous secret to FAYANMS_SERVICE_SECRETS (comma
 * list) before changing FAYANMS_SERVICE_SECRET — both verify during the
 * window, so rotation needs no outage.
 *
 * A service token NEVER satisfies a human route: human routes use the
 * NextAuth session (requireUser/requireRole/requirePermission) and never
 * read this token. Conversely requireServicePrincipal ignores cookies.
 */

export const SERVICE_AUDIENCE = "fayanms:internal";
const CLOCK_SKEW_S = 30;

/**
 * Issuer allowlist (Phase 19-C / audit SVC-101 §11.3): a shared symmetric
 * secret alone would let any holder mint tokens with arbitrary iss/sub/
 * scopes. Verification therefore rejects issuers outside this list.
 * Override with FAYANMS_SERVICE_ISSUERS (comma list) when additional
 * machine identities are introduced; each issuer must still present a
 * valid signature under a configured secret.
 */
export function getServiceIssuers(): string[] {
  const raw = process.env.FAYANMS_SERVICE_ISSUERS?.trim();
  const configured = raw
    ? raw.split(",").map((value) => value.trim()).filter(Boolean)
    : [];
  return configured.length > 0 ? configured : ["fayanms:worker"];
}

/**
 * Per-route scope requirements (Phase 19-C / audit SVC-101 §11.2): scopes
 * in the token are authorization, not metadata. Every service route maps
 * to exactly one required scope:
 *   worker/* (job engine) → "jobs"
 *   alerts/evaluate       → "alerts"
 *   reports/execute       → "reports"
 *   metrics/retention/prune → "metrics"
 *   ("simulate" authorizes Next→worker simulator calls — enforced by the
 *   worker mini-service's own HTTP layer.)
 */
export type ServiceScope = "jobs" | "simulate" | "alerts" | "reports" | "metrics";

export interface ServicePrincipal {
  readonly kind: "service";
  readonly id: string;
  readonly issuer: string;
  readonly scopes: string[];
}

export type ServiceAuthResult =
  | { ok: true; principal: ServicePrincipal }
  | { ok: false; code: string; message: string };

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
 * Authenticate a machine caller AND enforce the route's required scope
 * (Phase 19-C / audit SVC-101). Returns a discriminated result with a
 * precise error code for the 401/403 envelope (never throws).
 */
export function authenticateServiceRequest(
  req: Request,
  requiredScope?: ServiceScope
): ServiceAuthResult {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    return {
      ok: false,
      code: "SERVICE_UNAUTHENTICATED",
      message: "Internal service endpoints require a Bearer service token.",
    };
  }
  const secrets = getServiceSecrets();
  if (secrets.length === 0) {
    return {
      ok: false,
      code: "SERVICE_UNCONFIGURED",
      message: "FAYANMS_SERVICE_SECRET is not configured on the server.",
    };
  }
  const verified = verifyServiceJwt(match[1], secrets);
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
  if (requiredScope && !scopes.includes(requiredScope)) {
    return {
      ok: false,
      code: "SERVICE_SCOPE_INSUFFICIENT",
      message: `Service token lacks the "${requiredScope}" scope required by this endpoint.`,
    };
  }
  return {
    ok: true,
    principal: { kind: "service", id: sub, issuer: iss, scopes },
  };
}

/**
 * Mint a short-lived HS256 service JWT (Phase 19-C): the Next.js server
 * uses this to authenticate its OWN outbound calls to the worker's HTTP
 * surface (/simulate/*, /capabilities) — the mirror image of the worker
 * signing tokens for the Next.js job-engine routes. SERVER-ONLY: reads
 * FAYANMS_SERVICE_SECRET from the process environment.
 */
export function mintServiceToken(options: {
  issuer?: string;
  subject?: string;
  scopes: ServiceScope[];
  ttlSeconds?: number;
}): string {
  const secret = process.env.FAYANMS_SERVICE_SECRET?.trim();
  if (!secret) {
    throw new Error(
      "FAYANMS_SERVICE_SECRET is not configured — cannot mint a service token."
    );
  }
  const nowS = Math.floor(Date.now() / 1000);
  const ttl = options.ttlSeconds ?? 300;
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
    "base64url"
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: options.issuer ?? "fayanms:control",
      sub: options.subject ?? "control-plane",
      aud: SERVICE_AUDIENCE,
      iat: nowS,
      exp: nowS + ttl,
      jti: randomUUID(),
      scopes: options.scopes,
    })
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}
/**
 * All-in-one guard for internal endpoints that may be driven by EITHER the
 * machine principal (service JWT) OR an authorized human session (e.g. the
 * retention-prune button in the admin UI). Returns the service principal on
 * the service path, the session user on the human path, or an AuthError for
 * the caller to map via authErrorToFail.
 */
export async function requireServiceOrPermission(
  req: Request,
  permission: string,
  requiredScope?: ServiceScope
): Promise<ServicePrincipal | Awaited<ReturnType<typeof import("@/lib/auth/session").requirePermission>>> {
  const { requirePermission } = await import("@/lib/auth/session");
  if (/^Bearer\s+/i.test(req.headers.get("authorization") ?? "")) {
    const result = authenticateServiceRequest(req, requiredScope);
    if (result.ok) return result.principal;
    throw new AuthError(result.code, result.message, 401);
  }
  return requirePermission(req, permission);
}
