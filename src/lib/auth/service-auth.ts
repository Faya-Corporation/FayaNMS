import { createHmac, randomUUID, sign as ed25519Sign } from "node:crypto";

import { AuthError } from "@/lib/auth/session";
import {
  bearerTokenOf,
  verifyServiceToken,
  getServiceSigningKey,
  SERVICE_AUDIENCE,
  getServiceIssuers,
  getServiceSecrets,
  type ServicePrincipal,
  type ServiceAuthResult,
  type ServiceScope as JwtServiceScope,
} from "@/lib/auth/service-jwt";

/**
 * Service-principal authentication (Phase 19 / audit SEC-002).
 *
 * The internal job-engine surface (POST /api/v1/worker/* minus the UI-facing
 * /worker/status diagnostic, plus /api/v1/alerts/evaluate,
 * /api/v1/reports/execute and /api/v1/metrics/retention/prune) is no longer
 * anonymous. Machine callers authenticate with a short-lived HS256 service
 * JWT signed with FAYANMS_SERVICE_SECRET.
 *
 * The token contract, verification order and rotation semantics live in the
 * dependency-free core (src/lib/auth/service-jwt.ts) — this module keeps the
 * route-facing API (scope enforcement + session interop) and re-exports the
 * contract pieces so existing call sites and tests stay untouched. The core
 * exists so the proxy rate gate (SAFE-002) can verify the machine plane
 * without importing the Prisma-bound session module.
 *
 * A service token NEVER satisfies a human route: human routes use the
 * NextAuth session (requireUser/requireRole/requirePermission) and never
 * read this token. Conversely requireServicePrincipal ignores cookies.
 */

export {
  SERVICE_AUDIENCE,
  getServiceIssuers,
  getServiceSecrets,
  verifyServiceToken,
  bearerTokenOf,
  type ServicePrincipal,
  type ServiceAuthResult,
} from "@/lib/auth/service-jwt";

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
export type ServiceScope = JwtServiceScope;

/**
 * Authenticate a machine caller AND enforce the route's required scope
 * (Phase 19-C / audit SVC-101). Returns a discriminated result with a
 * precise error code for the 401/403 envelope (never throws).
 */
export function authenticateServiceRequest(
  req: Request,
  requiredScope?: ServiceScope
): ServiceAuthResult {
  const token = bearerTokenOf(req.headers.get("authorization"));
  if (!token) {
    return {
      ok: false,
      code: "SERVICE_UNAUTHENTICATED",
      message: "Internal service endpoints require a Bearer service token.",
    };
  }
  const result = verifyServiceToken(token);
  if (!result.ok) return result;
  if (requiredScope && !result.principal.scopes.includes(requiredScope)) {
    return {
      ok: false,
      code: "SERVICE_SCOPE_INSUFFICIENT",
      message: `Service token lacks the "${requiredScope}" scope required by this endpoint.`,
    };
  }
  return result;
}

/**
 * Machine-plane detection for the API governance layer: true when the
 * CURRENT request scope carries a VALID service JWT (signature + audience
 * + expiry verified against the configured secrets). The proxy rate gate
 * (SAFE-002) applies the same exemption pre-handler — a live change must
 * never self-throttle mid-run. The exemption requires a VERIFIED token,
 * never merely the header's presence.
 */
export async function currentRequestIsServiceAuth(): Promise<boolean> {
  try {
    const { headers } = await import("next/headers");
    const h = await headers();
    const token = bearerTokenOf(h.get("authorization"));
    if (!token) return false;
    return verifyServiceToken(token).ok;
  } catch {
    // No request scope — not machine traffic.
    return false;
  }
}

/**
 * Mint a short-lived service JWT (Phase 19-C; P1-007 asymmetric identity;
 * TASK-SVC-001-A signing policy).
 *
 * Trust PREFERENCE: when FAYANMS_SERVICE_PRIVATE_KEY is configured the
 * token is Ed25519 (alg "EdDSA") — verifiers holding only the matching
 * FAYANMS_SERVICE_PUBLIC_KEYS can authenticate it but can NEVER mint one.
 * Without a private key the legacy HS256 shared-secret path is used
 * (Phase 1 of the rotation; removing FAYANMS_SERVICE_SECRET everywhere
 * completes Phase 2 and structurally kills symmetric tokens). The fallback
 * is based on key PRESENCE only — never on an EdDSA failure (§8: a failed
 * Ed25519 sign aborts token generation, it never downgrades). In an
 * EdDSA-only deployment there is no shared secret to fall back to, so the
 * fallback path is structurally unreachable there; when it does run
 * (migration Phase 1) it is made VISIBLE with a warning. SERVER-ONLY:
 * reads the key material from the process environment.
 */
export function mintServiceToken(options: {
  issuer?: string;
  subject?: string;
  scopes: ServiceScope[];
  ttlSeconds?: number;
}): string {
  const nowS = Math.floor(Date.now() / 1000);
  const ttl = options.ttlSeconds ?? 300;
  const header = (alg: string): string =>
    Buffer.from(JSON.stringify({ alg, typ: "JWT" })).toString("base64url");
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
  const signingInput = `${header("EdDSA")}.${payload}`;

  const signingKey = getServiceSigningKey();
  if (signingKey) {
    // Asymmetric identity (P1-007): the signature is produced with the
    // private key; verifiers need only the public half. Ed25519 signs with
    // a null digest per RFC 8032 / node docs.
    return `${signingInput}.${ed25519Sign(null, Buffer.from(signingInput), signingKey).toString("base64url")}`;
  }

  const secret = getServiceSecrets()[0];
  if (!secret) {
    throw new Error(
      "Neither FAYANMS_SERVICE_PRIVATE_KEY nor FAYANMS_SERVICE_SECRET is configured — cannot mint a service token."
    );
  }
  // Legacy minting is deliberate (rotation Phase 1) but never silent:
  // operators completing Phase 2 should see exactly which processes still
  // emit symmetric tokens.
  console.warn(
    "[service-auth] minting a legacy HS256 service token — FAYANMS_SERVICE_PRIVATE_KEY is not configured " +
      "(EdDSA is the production identity; complete the rotation by configuring the private key and removing FAYANMS_SERVICE_SECRET)."
  );
  const signature = createHmac("sha256", secret)
    .update(`${header("HS256")}.${payload}`)
    .digest("base64url");
  return `${header("HS256")}.${payload}.${signature}`;
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
