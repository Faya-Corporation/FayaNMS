import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";

import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/password";
import { evaluateMfaChallenge } from "@/lib/auth/mfa";
import { SITE_SCOPE_CLAIM_KEY, userSiteScopeClaim } from "@/lib/auth/scope";
import { absoluteSessionLifetimeExceeded } from "@/lib/auth/session-lifetime";
import {
  checkLoginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
  resolveLoginIdentity,
} from "@/lib/auth/login-guard";
import type { UserRole } from "@/lib/auth/roles";

/**
 * NextAuth configuration (Task 7-a) — credentials provider with a stateless
 * JWT session (no database adapter; the User table is queried directly in
 * `authorize`).
 *
 * Session/JWT claims: { id, email, name, role, sites? }. The jwt callback
 * refreshes the identity claims from the database whenever the session is
 * re-fetched, so a role change (or deactivation) propagates without waiting
 * for a new sign-in. If the account disappears or is disabled mid-session
 * the claims are stripped, which makes every guarded request answer 401.
 *
 * F-031 resource-level scoping: the OPTIONAL `sites` claim (site codes) is
 * minted ONLY at sign-in, from the user's User.siteScopeJson column (null
 * column → no claim → wildcard = the single-tenant default). The session
 * refresh branch deliberately does NOT touch it — the refreshed claim is
 * minted at the user's NEXT sign-in. Wave-11 (audit 15-b F-3): a scope
 * change now ALSO bumps User.credentialEpoch in the same transaction, so
 * every live token minted before it is evicted (requireUser's epoch-vs-DB
 * comparison) and the re-login — which mints the NEW scope — is enforced,
 * not conventional (documented in docs/security/authorization-matrix.md §5).
 *
 * AUTH-001-A: the credentials verification path is guarded by the dedicated
 * login abuse-control module (src/lib/auth/login-guard.ts) — throttling,
 * exponential temporary lockout and typed sign-in telemetry run BEFORE the
 * password verification, keyed by the trusted-proxy source and a keyed
 * account hash. The route-level pre-check (route.ts) is the outer layer;
 * this in-authorize check is the authoritative one on the verification path
 * itself. Session/CSRF/signout flows never touch the guard.
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

/**
 * Wave-11 (audit 15-b F-1): a REAL, well-formed scrypt hash of a random
 * throwaway password, used ONLY as a timing equalizer. The stored format
 * is `scrypt$N$salt$hash` (src/lib/auth/password.ts) — a MALFORMED string
 * would short-circuit in verifyPassword() WITHOUT running the scrypt KDF,
 * so the constant must stay a genuine `scrypt$16384$<32 hex>$<128 hex>`
 * derivation: it burns exactly the same work (N=2^14, 64-byte key) as the
 * verification against a real user row, flattening the timing difference
 * between "unknown email / login-disabled" and "wrong password" (the
 * enumeration oracle the repo's own AUTH-001-A acceptance line forbids).
 * The derivation result is deliberately discarded — this path always
 * answers the generic null failure.
 */
export const DUMMY_CREDENTIAL_HASH =
  "scrypt$16384$7808450a9140561fc6197d56c973064d$8d24714c695698990a02f7a50a72279f9712b1c0c60bb9238654e04602dcb6f248db045d149729d505877f8bf0a1580d34eb8f3488eb6bb4c29adc0a474c26f8";

export const authOptions: NextAuthOptions = {
  session: {
    strategy: "jwt",
    // P3-SESSION (independent audit 2026-09-15): an administrative/NOC plane
    // does not carry 30-day sessions. 12 h bounds the stolen-cookie half-life
    // to a NOC-shift scale while remaining operationally sane; role changes
    // and account deactivation already propagate per-request (the session
    // revalidates the live user), so the lifetime bounds ANONYMOUS
    // persistence of a VALID credential state — exactly what should be
    // shortest here.
    //
    // Wave-11 honesty correction (audit 15-b F-4): next-auth v4 re-encodes
    // the token with a FRESH expiry on every /api/auth/session fetch (its
    // core session route re-issues the cookie), so this maxAge is a SLIDING
    // inactivity window renewed per full page load — NOT an absolute
    // lifetime. GA-6 (P2-S01, 2026-10-06 re-audit): the ABSOLUTE cap is now enforced
    // on top — the jwt callback's refresh path strips the claims once the
    // token's `iat` age exceeds FAYANMS_SESSION_MAX_AGE_HOURS
    // (default 12, 0 = legacy off; see src/lib/auth/session-lifetime.ts).
    // next-auth preserves `iat` across re-encodes (only exp refreshes), so
    // it is a sound absolute-issuance anchor.
    // Revocation-NOW is the credentialEpoch bump (password set/reset or
    // scope change → requireUser / requireSessionRead evict every token
    // minted before the bump).
    maxAge: 12 * 60 * 60, // 12 h — bounded admin-plane sessions (was 30 d)
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
        // F-034 phase 2: the second factor rides in the SAME sign-in POST
        // (NextAuth v4 credentials model) — a current 6-digit TOTP code or
        // an unused recovery code. Optional for accounts without MFA.
        totp: { label: "2FA code", type: "text" },
      },
      async authorize(credentials, req) {
        const email = credentials?.email?.trim().toLowerCase();
        const password = credentials?.password;
        if (!email || !password) return null;

        // AUTH-001-A (external audit 2026-09-15): the abuse guard runs BEFORE
        // the DB lookup and BEFORE the expensive scrypt verification. A
        // throttled caller receives the exact same public failure as a wrong
        // password — no throttled-state disclosure, no enumeration channel.
        // The request headers carry the spoof-resistant source identity via
        // the repository's rightmost-trusted-hop policy (rate-gate).
        const loginIdentity = resolveLoginIdentity(
          new Headers((req?.headers ?? {}) as Record<string, string>),
          email
        );
        const loginVerdict = await checkLoginAllowed(loginIdentity);
        if (!loginVerdict.allowed) return null;

        const user = await db.user.findUnique({ where: { email } });
        // Wave-11 (audit 15-b F-1) — enumeration/timing discipline. The
        // scrypt verification runs FIRST whenever a user with a passwordHash
        // exists, and the isActive check only AFTER the credential verified:
        // a wrong guess against a disabled account answers the generic null
        // (previously the "Account disabled" throw leaked the account's
        // existence BEFORE any credential check). The distinct "Account
        // disabled" message is preserved for the legitimate case — a VALID
        // credential for a disabled account — which the sign-in gate renders
        // verbatim.
        if (user?.passwordHash) {
          const valid = await verifyPassword(password, user.passwordHash);
          if (!valid) {
            await recordLoginFailure(loginIdentity);
            return null;
          }
          if (!user.isActive) {
            throw new CredentialsSigninError("Account disabled");
          }
        } else {
          // Unknown account or null hash (login disabled): burn an
          // equivalent scrypt derivation against the fixed dummy hash so
          // this failure path is as slow as a real verification, then keep
          // the uniform generic failure — the SAME public answer as a wrong
          // password, with the SAME login-guard accounting as before
          // (unknown accounts still record a failure; the verification
          // verdict itself is deliberately discarded).
          await verifyPassword(password, DUMMY_CREDENTIAL_HASH);
          await recordLoginFailure(loginIdentity);
          return null;
        }

        // F-034 phase 2 — the TOTP second factor (privileged roles). After
        // the password verifies, an enabled enrollment MUST present the
        // second factor in this same POST: a current 6-digit code (±1 step
        // window, per-step anti-replay) or an unused single-use recovery
        // code. Absent/invalid → null, i.e. a failed sign-in — the login
        // guard's (source, account) budgets above naturally cover
        // brute-force on the second factor. Fail-open exists ONLY under
        // FAYANMS_MFA_MODE=disabled, the documented rollback lever.
        const submittedCode =
          typeof credentials?.totp === "string" ? credentials.totp : undefined;
        const mfaVerdict = await evaluateMfaChallenge(user, submittedCode);
        if (mfaVerdict.outcome === "failed") {
          // The challenge already audited MFA_LOGIN_FAILED; counting the
          // failure into the login guard keeps the second factor inside
          // the same brute-force budget as the first.
          await recordLoginFailure(loginIdentity);
          return null;
        }

        // Successful sign-in resets the (source, account) failure state.
        await recordLoginSuccess(loginIdentity);

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

        // F-031: the site scope rides the sign-in claims — null column →
        // undefined → the sites claim key is OMITTED (wildcard). The
        // userSiteScopeClaim parser is fail-closed (malformed row → []),
        // so a hand-edited siteScopeJson can never mint wildcard access.
        const siteScope = userSiteScopeClaim(user.siteScopeJson);
        // Wave-9 credential epoch (audit 9-a F-3): the epoch rides the
        // sign-in claims so requireUser can detect a token minted BEFORE
        // the last credential change (password SET bumps User.credentialEpoch
        // in the same transaction). Absent → 0 semantics (backward
        // compatible with every pre-epoch token).
        const credentialEpoch =
          typeof user.credentialEpoch === "number" &&
          Number.isFinite(user.credentialEpoch)
            ? user.credentialEpoch
            : 0;
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role as UserRole,
          credentialEpoch,
          ...(siteScope !== undefined
            ? { [SITE_SCOPE_CLAIM_KEY]: siteScope }
            : {}),
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
        // F-031: the sites claim is stamped ONLY here (sign-in time).
        // Absent → no claim → wildcard (single-tenant default). The claim
        // key is the single-sourced SITE_SCOPE_CLAIM_KEY constant — the
        // token contract must not drift from the enforcement readers.
        const sites = (user as unknown as Record<string, unknown>)[
          SITE_SCOPE_CLAIM_KEY
        ];
        if (Array.isArray(sites)) {
          token[SITE_SCOPE_CLAIM_KEY] = sites;
        }
        // Wave-9 credential epoch: stamped ONLY here (sign-in time),
        // exactly like the sites claim. The refresh branch below must NOT
        // re-read it from the DB — a password reset must never self-heal a
        // token minted before it, or session eviction (requireUser's
        // epoch-vs-DB comparison) would silently stop working.
        const epoch = (user as unknown as Record<string, unknown>).credentialEpoch;
        token.credentialEpoch =
          typeof epoch === "number" && Number.isFinite(epoch) ? epoch : 0;
        return token;
      }

      // Session refresh — re-hydrate claims so role/deactivation changes
      // propagate live. DB hiccups keep the previous claims (availability
      // over freshness for the demo platform).
      //
      // GA-6 (P2-S01): the ABSOLUTE lifetime check runs FIRST — a token
      // past its absolute cap is dead regardless of the sliding window,
      // and its claims are stripped exactly like a mid-session
      // deactivation (requireUser answers 401; the next session fetch
      // drops the session). An expired token costs no DB work.
      if (absoluteSessionLifetimeExceeded(token)) {
        delete token.id;
        delete token.role;
        return token;
      }
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
          // F-031: token.sites is deliberately NOT refreshed here — scope
          // changes land on the NEXT sign-in (the JWT is minted at login).
          // Wave-9: token.credentialEpoch is deliberately NOT refreshed
          // here either — a password SET bumps the DB epoch, and the
          // stale token must keep its old claim so requireUser evicts it
          // (a refresh would defeat the eviction entirely).
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
