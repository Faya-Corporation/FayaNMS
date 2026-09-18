import { db } from "@/lib/db";
import { ok } from "../_lib/api";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/meta — lightweight reference data for filter bars and
 * form pickers (vendors, sites, credential profiles). Consumed by the
 * device filters, the Add/Edit Device form and the Sites view.
 *
 * HC-2 (R54, Production-Readiness Roadmap — F-N3): this endpoint is
 * SESSION-EXEMPT (bootstrap surface — see src/proxy.ts, exact-match
 * exemption) and therefore carries ONLY the pre-auth-needed reference
 * data for the sign-in transition. The active-user directory moved to
 * the AUTHENTICATED `/api/v1/meta/users` (the proxy matcher gates it;
 * the alert assign/suppress picker fetches it after hydration), so the
 * pre-auth payload contains ZERO user records — machine-pinned in
 * tests/audit/r54-meta-users-split.test.ts.
 *
 * R51-A2 (Independent Production ReAudit 2026-09-18, F-2): no
 * credential-profile OPERATOR usernames here either (pickers render
 * `name · type` only). Adding future fields here requires the same
 * pre-auth disclosure review.
 */
export async function GET() {
  const [vendors, sites, credentialProfiles] = await Promise.all([
    db.vendor.findMany({
      orderBy: { name: "asc" },
      select: { id: true, key: true, name: true },
    }),
    db.site.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, code: true },
    }),
    db.credentialProfile.findMany({
      orderBy: { name: "asc" },
      // R51-A2: no `username` here — pre-auth bootstrap surface.
      select: { id: true, name: true, type: true },
    }),
  ]);

  return ok({
    vendors,
    sites,
    credentialProfiles,
  });
}
