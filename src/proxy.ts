import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { randomUUID } from "node:crypto";
import { bearerTokenOf, verifyServiceToken } from "@/lib/auth/service-jwt";
import {
  rateKind,
  rateLimitedBody,
  rateLimitedHeaders,
  resolveClientIp,
  takeRateSlot,
} from "@/lib/api/rate-gate";

/**
 * API gate (Task 7-a + SAFE-002) — WithAuth-style enforcement AND
 * pre-handler rate limiting for the /api/v1 surface.
 *
 * Evaluation order (safe-fastest first):
 *   1. MACHINE PLANE: a VERIFIED service JWT (signature + audience + expiry
 *      + issuer allowlist, src/lib/auth/service-jwt.ts) passes through
 *      untouched ONLY on the machine surface (/api/v1/worker/* plus the
 *      three service-principal job routes) — the worker's claim/step/
 *      progress loops share the loopback bucket with human traffic and a
 *      live change must never self-throttle mid-run. The exemption
 *      requires a VERIFIED token, never merely the header's presence, and
 *      (R61 P1) a verified token on any NON-machine path is a hard 401:
 *      a service principal is not a session credential and must never
 *      reach human read surfaces through the proxy.
 *   2. RATE GATE (SAFE-002 — external ULTRA audit P0-002): every other
 *      request consumes a sliding-window slot BEFORE any route handler
 *      runs — 300 req/min per client for GET/HEAD, 120 req/min for
 *      mutations (unknown method → the stricter mutation budget), so a
 *      rate-limited request can no longer commit side effects and then
 *      answer 429. The client key uses a rightmost-trusted-hop
 *      X-Forwarded-For policy (src/lib/api/rate-gate.ts) — the leftmost
 *      entries are attacker-controlled and are never trusted. Exceeded
 *      budgets answer the standard 429 envelope with Retry-After.
 *   3. API-CLIENT PLANE (P1-012 — external ULTRA audit): an OPAQUE bearer
 *      token (base64url, no dots — the ApiClient token shape) is admitted
 *      for MUTATIONS ONLY, always after the rate gate (external traffic is
 *      never exempt), and is fully validated at the handler layer by
 *      requirePermission → authenticateApiClient (sha256 lookup, active
 *      check, scope mapping). READS stay session-gated: no read route
 *      carries a handler-level gate yet, so admitting a token there would
 *      turn the proxy into the only check — refused with a precise 401
 *      until read routes grow gates (see api-client-auth.ts).
 *   4. SESSION PLANE (Task 7-a): no valid session → 401 envelope
 *      { code: "UNAUTHENTICATED" }; authenticated `auditor` performing
 *      any non-GET/HEAD → 403 { code: "RBAC_FORBIDDEN" }.
 *
 * The matcher is limited to /api/v1/:path*, so /api/auth/*, /_next/* and
 * static assets are never touched by this middleware. Inside /api/v1 the
 * PUBLIC surfaces are:
 *   - /api/v1/meta        — branding/status bootstrap used pre-sign-in
 *   - /api/v1/auth/*      — session bootstrap (answers its own 401 envelope)
 * (They are still rate-limited — they are exactly the unauthenticated-
 * facing surfaces the gate must protect.)
 *
 * INTERNAL SERVICE ENDPOINTS (P19 / audit SEC-002): the worker mini-service
 * (:3030) drives the job engine backend-to-backend with no user session —
 * the exact POST routes below stay session-exempt BUT each of them now
 * enforces a service-principal JWT at the handler layer, and machine
 * traffic with a verified token is exempt from the rate budget by rule 1.
 * Unauthenticated hammering of those routes is NOT exempt — it is rate-
 * limited before the handler's own 401.
 *
 * Route handlers additionally verify identity server-side via
 * src/lib/auth/session.ts (requireUser/requireRole/requirePermission) —
 * middleware is the coarse gate, not the only check.
 */

const UNAUTHENTICATED_BODY = {
  success: false as const,
  error: {
    code: "UNAUTHENTICATED",
    message: "Sign in required — this API surface requires a session.",
  },
};

const RBAC_FORBIDDEN_BODY = {
  success: false as const,
  error: {
    code: "RBAC_FORBIDDEN",
    message: "Auditors have read-only access",
  },
};

const API_CLIENT_READS_NOT_WIRED_BODY = {
  success: false as const,
  error: {
    code: "UNAUTHENTICATED",
    message:
      "API-client tokens are accepted on the mutation plane only — read routes do not carry handler-level token gates yet (P1-012 plane boundaries).",
  },
};

/**
 * R61 P1 — the MACHINE SURFACE: the pathnames a service principal is
 * allowed to touch. A verified service JWT is a MACHINE credential — on
 * anything outside this set the request is UNAUTHENTICATED (401), never a
 * free pass into human read surfaces (the pre-R61 early next() let a
 * worker token walk Dashboard/Devices/Events/Credentials GETs that trusted
 * the proxy gate). Machine routes enforce the token AND its scope at the
 * handler layer (authenticateServiceRequest) — the proxy merely confines
 * the principal to its surface.
 */
const MACHINE_EXACT_ROUTES: ReadonlySet<string> = new Set([
  "/api/v1/alerts/evaluate",
  "/api/v1/reports/execute",
  "/api/v1/metrics/retention/prune",
  "/api/v1/metrics/rollup/aggregate",
  "/api/v1/protocol/queue/retention/prune",
]);

function isMachineSurface(pathname: string): boolean {
  return pathname.startsWith("/api/v1/worker/") || MACHINE_EXACT_ROUTES.has(pathname);
}

/**
 * The ApiClient token shape: OPAQUE base64url (24–128 chars, no dots).
 * Service JWTs are three dot-separated segments; NextAuth bearer JWTs are
 * also dot-separated — neither can collide with this pattern.
 */
const OPAQUE_BEARER_PATTERN = /^[A-Za-z0-9_-]{24,128}$/;

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 1. Machine plane — a VERIFIED service JWT is exempt from the rate
  // budget ONLY on the machine surface (R61 P1: surface isolation — a
  // service principal on a human path is unauthenticated, full stop).
  const bearer = bearerTokenOf(req.headers.get("authorization"));
  if (bearer && verifyServiceToken(bearer).ok) {
    if (isMachineSurface(pathname)) {
      return NextResponse.next();
    }
    return NextResponse.json(UNAUTHENTICATED_BODY, { status: 401 });
  }

  // 2. Rate gate — BEFORE any handler can commit side effects (SAFE-002).
  // HC-1: the pathname rides along so high-cost route families draw their
  // OWN named budget (ai → 10/min, devices/csv-import → 5/min) instead of
  // the shared client-kind pool; unknown routes keep the kind budgets.
  const clientKey = resolveClientIp(req.headers);
  const kind = rateKind(req.method);
  const decision = await takeRateSlot(clientKey, kind, Date.now(), pathname);
  if (decision.limited) {
    const requestId = randomUUID();
    return NextResponse.json(
      rateLimitedBody(decision.retryAfterSec, requestId),
      { status: 429, headers: rateLimitedHeaders(decision.retryAfterSec, requestId) }
    );
  }

  // 3a. Public surfaces (bootstrap) + service-principal routes (see above —
  // each enforcing its own service JWT at the handler layer).
  if (
    pathname === "/api/v1/meta" ||
    pathname.startsWith("/api/v1/auth/") ||
    pathname === "/api/v1/worker/claim" ||
    pathname === "/api/v1/worker/complete" ||
    pathname === "/api/v1/worker/progress" ||
    pathname === "/api/v1/worker/tick" ||
    pathname === "/api/v1/worker/drift-evaluate" ||
    pathname === "/api/v1/worker/change-step" ||
    pathname === "/api/v1/worker/firmware-upgrade" ||
    pathname === "/api/v1/worker/ztp-provision" ||
    pathname === "/api/v1/alerts/evaluate" ||
    pathname === "/api/v1/reports/execute" ||
    pathname === "/api/v1/metrics/retention/prune" ||
    pathname === "/api/v1/metrics/rollup/aggregate" ||
    pathname === "/api/v1/protocol/queue/retention/prune"
  ) {
    return NextResponse.next();
  }

  // 3b. API-client plane (P1-012): an opaque bearer candidate is admitted
  // to the MUTATION plane only — the handler (requirePermission →
  // authenticateApiClient) performs the real sha256 + active + scope
  // validation; the proxy merely refuses to let the session plane eat the
  // request. A candidate on the read plane is refused outright: reads are
  // proxy-session-gated and would otherwise trust an unvalidated token.
  const bearerCandidate = bearerTokenOf(req.headers.get("authorization"));
  if (bearerCandidate && OPAQUE_BEARER_PATTERN.test(bearerCandidate)) {
    const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (isMutation) {
      return NextResponse.next();
    }
    return NextResponse.json(API_CLIENT_READS_NOT_WIRED_BODY, { status: 401 });
  }

  // GHSA-xmf8-cvqr-rfgj (next-auth v4): getToken() throws an uncaught
  // exception on a malformed Bearer authorization header. Library fix only
  // exists in the v5 line; until that migration, malformed tokens are
  // rejected here as 401 instead of crashing the middleware.
  let token: Awaited<ReturnType<typeof getToken>> = null;
  try {
    token = await getToken({
      req,
      secret: process.env.NEXTAUTH_SECRET,
    });
  } catch {
    return NextResponse.json(UNAUTHENTICATED_BODY, { status: 401 });
  }

  if (!token || typeof token.id !== "string" || token.id.length === 0) {
    return NextResponse.json(UNAUTHENTICATED_BODY, { status: 401 });
  }

  if (token.role === "auditor" && req.method !== "GET" && req.method !== "HEAD") {
    return NextResponse.json(RBAC_FORBIDDEN_BODY, { status: 403 });
  }

  return NextResponse.next();
}

export const config = {
  // Only the versioned API surface runs through the gate; /api/auth/*,
  // /_next/* and static files are untouched.
  matcher: ["/api/v1/:path*"],
};
