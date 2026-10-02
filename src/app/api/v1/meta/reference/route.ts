import { db } from "@/lib/db";
import { authErrorToFail, requireSessionRead } from "@/lib/auth/session";

import { ok } from "../../_lib/api";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/meta/reference — authenticated reference data for filter bars
 * and form pickers (vendors, sites, credential profiles).
 *
 * RT-024 (F-028): this data used to live on the SESSION-EXEMPT
 * `/api/v1/meta` bootstrap surface, letting any unauthenticated caller
 * enumerate credential-profile names/types and the full site inventory.
 * No pre-auth surface consumes it (verified at RT-024 time: useMeta and
 * every consumer render behind the session shell), so it moved behind the
 * session gate (the proxy matcher covers this path; only the exact-match
 * `/api/v1/meta` remains session-exempt).
 *
 * R51-A2 (F-2) still holds here: no credential-profile OPERATOR usernames —
 * pickers render `name · type` only. Adding future fields requires the same
 * disclosure review.
 */
export async function GET(request: Request) {
  // F-008 phase 4b (read-plane defense-in-depth): the GET handler verifies
  // the human session itself (requireSessionRead) — the proxy matcher stays
  // the coarse gate, not the only check.
  try {
    await requireSessionRead(request);
  } catch (error) {
    const envelope = authErrorToFail(error);
    if (envelope) return envelope;
    throw error;
  }
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
      // R51-A2: no `username` here.
      select: { id: true, name: true, type: true },
    }),
  ]);

  return ok({
    vendors,
    sites,
    credentialProfiles,
  });
}
