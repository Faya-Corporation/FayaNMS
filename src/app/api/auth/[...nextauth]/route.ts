import NextAuth from "next-auth";

import { authOptions } from "@/lib/auth/options";

/**
 * NextAuth catch-all handler (Task 7-a).
 *
 * Serves /api/auth/{csrf,signin,session,signout,callback/credentials,…}.
 * Enforcement of the /api/v1 surface happens in src/middleware.ts; the auth
 * routes themselves stay public (they bootstrap the session).
 *
 * @see src/lib/auth/options.ts — provider + JWT/session callbacks.
 */
const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
