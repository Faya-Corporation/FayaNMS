import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

/**
 * API gate (Task 7-a) — WithAuth-style enforcement for the /api/v1 surface.
 *
 * Rules:
 *   1. No valid session → 401 envelope { code: "UNAUTHENTICATED" }.
 *   2. Authenticated `auditor` performing any non-GET/HEAD → 403 envelope
 *      { code: "RBAC_FORBIDDEN", message: "Auditors have read-only access" }.
 *
 * The matcher is limited to /api/v1/:path*, so /api/auth/*, /_next/* and
 * static assets are never touched by this middleware. Inside /api/v1 the
 * PUBLIC surfaces are:
 *   - /api/v1/meta        — branding/status bootstrap used pre-sign-in
 *   - /api/v1/auth/*      — session bootstrap (answers its own 401 envelope)
 *
 * INTERNAL SERVICE ENDPOINTS (deliberate trust-boundary decision): the
 * worker mini-service (:3030) drives the job engine backend-to-backend with
 * no user session — POST /api/v1/worker/*, /api/v1/alerts/evaluate and
 * /api/v1/metrics/retention/prune stay open so scheduled backups, drift
 * checks, alert evaluation and retention pruning keep working. Hardening
 * these with a shared service token is parked for Phase 7-b.
 *
 * Route handlers additionally verify identity server-side via
 * src/lib/auth/session.ts (requireUser/requireRole) — middleware is the
 * coarse gate, not the only check.
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

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Public surfaces (bootstrap + internal worker trust boundary).
  if (
    pathname === "/api/v1/meta" ||
    pathname.startsWith("/api/v1/auth/") ||
    pathname.startsWith("/api/v1/worker/") ||
    pathname === "/api/v1/alerts/evaluate" ||
    pathname === "/api/v1/metrics/retention/prune"
  ) {
    return NextResponse.next();
  }

  const token = await getToken({
    req,
    secret: process.env.NEXTAUTH_SECRET,
  });

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
