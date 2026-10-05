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
 *   3. API-CLIENT PLANE (P1-012 — external ULTRA audit; F-008 follow-up):
 *      an OPAQUE bearer token (base64url, no dots — the ApiClient token
 *      shape) is admitted to BOTH planes — mutations and reads — always
 *      after the rate gate (external traffic is never exempt). The proxy
 *      performs NO credential validation beyond the shape test: the
 *      handler layer owns the real check,
 *        mutations → requirePermission → authenticateApiClient (sha256
 *        lookup, active check, scope mapping; opt-in per route for human
 *        accountability),
 *        reads     → requireSessionRead → authenticateApiClientRead over
 *        the wired read-domain table (API_CLIENT_READ_DOMAINS).
 *      Fail-closed lives in the handlers: an unknown/inactive/scoped-out
 *      token is 401/403 there. A request that ALSO carries a next-auth
 *      session cookie falls back to the session plane in its handler
 *      (cookie-first precedence everywhere), so a cookie-carrying MUTATION
 *      must pass the step-5 CSRF origin check BEFORE this plane's early
 *      return admits it (the wave-11 gate at 3a/3b).
 *   4. SESSION PLANE (Task 7-a): no valid session → 401 envelope
 *      { code: "UNAUTHENTICATED" }.
 *   5. CSRF ORIGIN CHECK (RT-008 / F-010 — defense-in-depth behind the
 *      cookie policy): a cookie-authenticated MUTATION (POST/PUT/PATCH/
 *      DELETE) must present same-origin browser credentials —
 *      `sec-fetch-site: same-origin|none` passes; `cross-site` AND
 *      `same-site` are 403 { code: "CSRF_ORIGIN_REJECTED" } (same-site is
 *      NOT safe enough: sibling-subdomain risk); with no Sec-Fetch-Site
 *      but an Origin header, the Origin host must equal the Host header
 *      (the NextAuth origin-check pattern). A request carrying NEITHER
 *      header is allowed: it is a non-browser client that cannot carry the
 *      cookie cross-site in practice, and SameSite=Lax still guards the
 *      cookie itself.
 *      WAVE-11 (F-1, audit 15-a P3): the SAME origin check now also runs
 *      at the step-3a and step-3b early returns whenever a mutating
 *      request CARRIES a session cookie — the three dual-gate
 *      MACHINE_EXACT POST routes fall back to the admin session in their
 *      handlers (requireServiceOrPermission → requirePermission), so a
 *      same-site sibling-subdomain form POST (Lax cookie, no preflight,
 *      no custom headers) used to ride step 3a straight past this check
 *      into a destructive admin mutation; step 3b had the same hole for a
 *      cookie + decoy opaque bearer. Requests WITHOUT a session cookie
 *      (machine and API-client callers) and GETs keep the documented fast
 *      path; a VERIFIED service token never reaches these gates (step 1
 *      returned it — pass on the machine surface, hard 401 elsewhere).
 *      Authenticated `auditor` performing any non-GET/HEAD → 403
 *      { code: "RBAC_FORBIDDEN" } (step 6).
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

/**
 * RT-008 / F-010 — CSRF origin rejection envelope (typed code so the
 * browser client and logs can distinguish it from RBAC_FORBIDDEN).
 */
const CSRF_REJECTED_BODY = {
  success: false as const,
  error: {
    code: "CSRF_ORIGIN_REJECTED",
    message: "Cross-site mutation rejected.",
  },
};

/**
 * P1-012 history: this body used to refuse opaque bearers on the READ
 * plane ("reads do not carry handler-level token gates yet"). The F-008
 * sweep closed that gap — every /api/v1 GET except the public bootstrap
 * /api/v1/meta verifies its principal at the handler (requireSessionRead,
 * which since batch-7 also authenticates API clients over the wired
 * read-domain table) — so the refusal is DELETED and both planes admit
 * opaque candidates to their handler-level gates. Fail-closed lives in
 * the handlers, where the real credential validation always was.
 */

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
  // Machine-plane job + ingest routes registered BELOW the R62 wave
  // (48b3cfe flow retention; the RT-012/RT-013 protocol ingest family).
  // Every handler here enforces authenticateServiceRequest itself — the
  // proxy merely confines the machine principal to its surface.
  "/api/v1/flows/retention/prune",
  "/api/v1/ingest/protocol",
  "/api/v1/ingest/protocol/snmpv3-profile",
  "/api/v1/ingest/protocol/snmpv3-profile/poll",
  "/api/v1/ingest/protocol/snmpv3-profile/accept",
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

/**
 * Mutating methods for the CSRF origin check (RT-008/F-010) — the SAME set
 * at step 5 and at the wave-11 cookie gates in steps 3a/3b. GET/HEAD/OPTIONS
 * never mutate state and keep the fast path everywhere.
 */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The next-auth v4 session cookie names (plain + __Secure- variants). The
 * wave-11 gate keys on cookie PRESENCE, not validity: the early-return
 * planes deliberately skip the JWT decode, so the cookie alone marks a
 * request whose handler call may fall back to the session plane.
 */
const SESSION_COOKIE_NAMES = [
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
] as const;

function carriesNextAuthSessionCookie(req: NextRequest): boolean {
  return SESSION_COOKIE_NAMES.some((name) => req.cookies.get(name) !== undefined);
}

/**
 * The RT-008/F-010 origin decision, shared VERBATIM by step 5 and the
 * wave-11 cookie gates — identical rule, error body and status at every
 * call site (no second implementation to drift):
 *   - sec-fetch-site same-origin|none   → pass;
 *   - cross-site AND same-site          → rejected (sibling-subdomain risk);
 *   - no sec-fetch-site, Origin present → Origin host must equal Host;
 *   - neither header                    → allowed (non-browser client).
 */
function csrfOriginRejected(req: NextRequest): boolean {
  const site = req.headers.get("sec-fetch-site");
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  let originHost: string | null = null;
  if (origin !== null) {
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null; // malformed Origin → treated as cross-site below
    }
  }
  return (
    (site !== null && site !== "same-origin" && site !== "none") ||
    (site === null && origin !== null && host !== null && originHost !== host)
  );
}

/**
 * Wave-11 F-1 (audit 15-a P3): the step-5 CSRF origin check, applied at
 * the EARLY-RETURN planes (3a machine/public, 3b opaque bearer).
 *
 * Fires ONLY when ALL of these hold:
 *   (a) the method is mutating (reads keep the fast path);
 *   (b) the request carries a next-auth session cookie (machine and
 *       API-client callers send none and are untouched);
 *   (c) any Authorization bearer present is NOT a fully-verified service
 *       token. This is guaranteed STRUCTURALLY, with no second
 *       verification: a verified token already returned at step 1 (pass on
 *       the machine surface, hard 401 elsewhere), so ANY bearer surviving
 *       to 3a/3b has FAILED verification and the handler will fall back to
 *       the session plane — exactly the cookie-authenticated mutation the
 *       origin check exists for.
 *
 * Returns the step-5 rejection response (identical body + status), or null
 * to admit the request to the early return it guards.
 */
function cookieSessionCsrfRejection(req: NextRequest): NextResponse | null {
  if (!MUTATING_METHODS.has(req.method)) return null;
  if (!carriesNextAuthSessionCookie(req)) return null;
  if (csrfOriginRejected(req)) {
    return NextResponse.json(CSRF_REJECTED_BODY, { status: 403 });
  }
  return null;
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 1. Machine plane — a VERIFIED service JWT is exempt from the rate
  // budget ONLY on the machine surface (R61 P1: surface isolation — a
  // service principal on a human path is unauthenticated, full stop).
  const bearer = bearerTokenOf(req.headers.get("authorization"));
  // Wave-11 invariant the 3a/3b CSRF gates rely on: past this block NO
  // request carries a VERIFIED service token — a verified token returned
  // right here (pass on the machine surface, hard 401 elsewhere), so any
  // bearer that survives to the later steps has FAILED verification and
  // never counts as a machine credential.
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
    // Service-principal routes ride the SAME rules as step 1 — DERIVED
    // from MACHINE_EXACT_ROUTES (single source of truth; the post-audit
    // fix for the wave-4 lesson: step 3a used to hand-copy the exact
    // pathnames and could silently drift). Each handler below enforces its
    // own service JWT (authenticateServiceRequest): an unauthenticated
    // caller gets the handler's SERVICE_* 401, never a session-gate free
    // pass. tests/audit/machine-surface-registration.test.ts scans the
    // handler tree and asserts every service-authenticated route is
    // covered by the machine-surface rules above.
    pathname.startsWith("/api/v1/worker/") ||
    MACHINE_EXACT_ROUTES.has(pathname)
  ) {
    // Wave-11 F-1: the three dual-gate MACHINE_EXACT POST routes fall back
    // to the admin session at the handler — a cookie-carrying MUTATION
    // must pass the step-5 CSRF origin check BEFORE this early return
    // admits it. No-cookie callers and GETs keep the fast path.
    const csrfRejection = cookieSessionCsrfRejection(req);
    if (csrfRejection !== null) return csrfRejection;
    return NextResponse.next();
  }

  // 3b. API-client plane (P1-012 + the F-008 follow-up, batch-7): an
  // opaque bearer candidate is admitted to BOTH planes. The handler
  // performs the real sha256 + active + scope validation:
  //   mutations → requirePermission → authenticateApiClient (opt-in per
  //   route for human accountability);
  //   reads     → requireSessionRead → authenticateApiClientRead over
  //   API_CLIENT_READ_DOMAINS (the wired-domain table).
  // The proxy's old read-plane refusal body is deleted (see the history
  // note above): with the F-008 sweep complete, NO read surface trusts an
  // unvalidated token — the session gate would otherwise 401 the opaque
  // header before the handler's own gate could see it (next-auth getToken
  // cannot verify an opaque token), which is why both planes branch here.
  const bearerCandidate = bearerTokenOf(req.headers.get("authorization"));
  if (bearerCandidate && OPAQUE_BEARER_PATTERN.test(bearerCandidate)) {
    // Wave-11 F-1 (Vector B): a cookie + opaque bearer falls back to the
    // cookie session in the handler (next-auth cannot verify an opaque
    // token, requireSessionRead/requirePermission land on the session) —
    // run the same CSRF origin check before admitting it.
    const csrfRejection = cookieSessionCsrfRejection(req);
    if (csrfRejection !== null) return csrfRejection;
    return NextResponse.next();
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

  // 5. CSRF origin check (RT-008 / F-010) — ONLY for cookie-session
  // mutations. The API-client bearer plane returned at step 3b (after the
  // wave-11 cookie gate) and the machine plane at step 1, so anything
  // reaching here with a mutating method is cookie-authenticated traffic;
  // the public bootstrap surfaces returned at step 3a under the same
  // cookie gate. Fail-open applies ONLY to a request with neither
  // Sec-Fetch-Site nor Origin — a non-browser client that cannot carry the
  // cookie cross-site in practice (SameSite=Lax still guards the cookie
  // itself). `same-site` is deliberately rejected: sibling-subdomain
  // compromise makes it not safe enough. The decision logic is the shared
  // helper — identical to the 3a/3b wave-11 gates by construction.
  if (token && MUTATING_METHODS.has(req.method) && csrfOriginRejected(req)) {
    return NextResponse.json(CSRF_REJECTED_BODY, { status: 403 });
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
