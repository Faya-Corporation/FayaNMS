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

async function POST(req: NextRequest) {
  const throttled = await preCheckCredentialsSignin(req);
  if (throttled) return throttled;
  return handler(req);
}

export { handler as GET, POST };
