import { db } from "@/lib/db";
import { fail, ok } from "../../_lib/api";
import { resolveActingUser } from "../../_lib/actor";

export const dynamic = "force-dynamic";

/** Friendly label per seeded role (no auth server yet — demo identity). */
const ROLE_LABELS: Record<string, string> = {
  admin: "Administrator",
  operator: "NOC Operator",
  engineer: "Network Engineer",
  auditor: "Auditor",
  manager: "Service Manager",
  viewer: "Viewer",
};

/**
 * GET /api/v1/meta/users — the ACTIVE account directory powering the
 * alert assign/suppress picker (id/name/role + a username-style key
 * derived from the email local-part). No emails are exposed beyond the
 * local-part (already public inside the demo lab).
 *
 * HC-2 (R54, Production-Readiness Roadmap — F-N3): this segment SPLIT
 * OUT of the session-exempt `/api/v1/meta` bootstrap surface. The proxy
 * matcher gates `/api/v1/:path*` and the exemption list covers the EXACT
 * pathname `/api/v1/meta` only, so this route always crosses the session
 * plane; the handler additionally resolves the actor BEFORE any DB work
 * (R52-F-N1 ordering discipline — 401, never a pre-auth read). API-client
 * opaque tokens are refused on the read plane by the proxy (P1-012).
 */
export async function GET(request: Request) {
  const actor = await resolveActingUser(request);
  if (!actor) {
    return fail(
      "UNAUTHENTICATED",
      "Sign in required — no valid session was provided.",
      401
    );
  }

  const users = await db.user.findMany({
    where: { isActive: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, email: true, role: true },
  });

  return ok({
    users: users.map((user) => ({
      id: user.id,
      // R69 re-review remediation: the fallback is the email LOCAL-PART —
      // a bare `?? user.email` here would expose the FULL email address of
      // any active user whose name is null, contradicting this route's own
      // "no emails beyond the local-part" contract.
      name: user.name ?? user.email.split("@")[0] ?? user.id,
      username: user.email.split("@")[0] ?? user.id,
      roleLabel: ROLE_LABELS[user.role] ?? user.role,
    })),
  });
}
