import NextAuth from "next-auth";
import type { NextRequest } from "next/server";

import { authOptions } from "@/lib/auth/options";
import { preCheckCredentialsSignin } from "@/lib/auth/login-guard";

/**
 * NextAuth catch-all handler (Task 7-a) + AUTH-001-A login abuse control.
 *
 * Serves /api/auth/{csrf,signin,session,signout,callback/credentials,…}.
 * Enforcement of the /api/v1 surface happens in src/middleware.ts; the auth
 * routes themselves stay public (they bootstrap the session).
 *
 * AUTH-001-A (external independent audit 2026-09-15): ONLY the credentials
 * sign-in submission — POST /api/auth/callback/credentials — passes through
 * the dedicated login guard FIRST. A throttled caller receives the standard
 * 429 envelope (Retry-After) before NextAuth parses anything, so the
 * expensive scrypt verification is never reached. Session reads, CSRF,
 * signout and provider metadata are NOT password-attempt traffic and flow
 * to NextAuth untouched. The actual verification path is additionally
 * guarded inside authorize() itself (defense in depth on the credentials
 * lifecycle — see src/lib/auth/options.ts).
 *
 * @see src/lib/auth/options.ts — provider + JWT/session callbacks.
 * @see src/lib/auth/login-guard.ts — the abuse-control policy + store.
 */
const handler = NextAuth(authOptions);

/** Next 16 route context (params is a Promise; next-auth v4.24.15 awaits it). */
interface NextAuthRouteContext {
  params: Promise<{ nextauth: string[] }>;
}

/**
 * TEST-001-A regression fix (found by the E2E login journey): the wrapper
 * MUST forward the route context. NextAuth resolves the auth action by
 * destructuring `nextauth` from ctx.params — a bare `handler(req)` passes
 * undefined and 500s EVERY credentials sign-in at runtime (the unit tier
 * mocked the handler and could not see this; the live journey could).
 */
async function POST(req: NextRequest, ctx?: NextAuthRouteContext) {
  const throttled = await preCheckCredentialsSignin(req);
  if (throttled) return throttled;
  return handler(req, ctx);
}

export { handler as GET, POST };
