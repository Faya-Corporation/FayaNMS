import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";

import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/password";
import type { UserRole } from "@/lib/auth/roles";

/**
 * NextAuth configuration (Task 7-a) — credentials provider with a stateless
 * JWT session (no database adapter; the User table is queried directly in
 * `authorize`).
 *
 * Session/JWT claims: { id, email, name, role }. The jwt callback refreshes
 * those claims from the database whenever the session is re-fetched, so a
 * role change (or deactivation) propagates without waiting for a new
 * sign-in. If the account disappears or is disabled mid-session the claims
 * are stripped, which makes every guarded request answer 401.
 */

/**
 * CredentialsSignin-style failure (next-auth v4 has no importable
 * CredentialsSignin class — the credentials callback surfaces the thrown
 * error's MESSAGE verbatim to the client, so the message doubles as the
 * machine-readable code; keep it stable: "Account disabled").
 */
class CredentialsSigninError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialsSignin";
  }
}

export const authOptions: NextAuthOptions = {
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60, // 30 days, matches the default cookie max-age
  },
  pages: {
    // The sign-in gate lives INSIDE the single-route app (ADR-02) — no
    // dedicated page route is ever created; signIn({ redirect: false })
    // never navigates here.
    signIn: "/",
    error: "/",
  },
  providers: [
    CredentialsProvider({
      name: "Email and password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = credentials?.email?.trim().toLowerCase();
        const password = credentials?.password;
        if (!email || !password) return null;

        const user = await db.user.findUnique({ where: { email } });
        // Uniform failure: unknown account, null hash (login disabled) and
        // wrong password all answer the generic credentials error.
        if (!user || !user.passwordHash) return null;
        if (!user.isActive) throw new CredentialsSigninError("Account disabled");

        const valid = await verifyPassword(password, user.passwordHash);
        if (!valid) return null;

        // Successful sign-in → audit trail entry (schema documents the
        // USER_LOGIN action alongside LOGIN_FAILED).
        try {
          await db.auditEvent.create({
            data: {
              actorId: user.id,
              actorName: user.name ?? user.email,
              action: "USER_LOGIN",
              resourceType: "User",
              resourceId: user.id,
              resourceLabel: user.email,
              result: "SUCCESS",
            },
          });
        } catch {
          // Auditing must never block sign-in.
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role as UserRole,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        // Initial sign-in — stamp the claims from the authorized user.
        token.id = user.id;
        token.email = user.email ?? token.email;
        token.name = user.name ?? token.name;
        token.role = (user as { role?: string }).role ?? "viewer";
        return token;
      }

      // Session refresh — re-hydrate claims so role/deactivation changes
      // propagate live. DB hiccups keep the previous claims (availability
      // over freshness for the demo platform).
      const userId = token.id;
      if (typeof userId === "string" && userId.length > 0) {
        try {
          const fresh = await db.user.findUnique({
            where: { id: userId },
            select: { id: true, email: true, name: true, role: true, isActive: true },
          });
          if (!fresh || !fresh.isActive) {
            // Disabled/deleted mid-session → strip claims; requireUser and
            // the middleware treat the request as unauthenticated.
            delete token.id;
            delete token.role;
            return token;
          }
          token.email = fresh.email;
          token.name = fresh.name ?? undefined;
          token.role = fresh.role;
        } catch {
          // keep previous claims
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = (token.id as string | undefined) ?? "";
        session.user.email = (token.email as string | undefined) ?? null;
        session.user.name = (token.name as string | null | undefined) ?? null;
        session.user.role = (token.role as string | undefined) ?? "viewer";
      }
      return session;
    },
  },
};
