import { db } from "@/lib/db";
import {
  authErrorToFail,
  requireSessionRead,
  sessionScopeFor,
} from "@/lib/auth/session";
import { scopedDeviceWhere, sessionSiteScope } from "@/lib/auth/scope";
import { fail, firstIssueMessage, ok } from "../_lib/api";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/search?q=<min 2 chars>
 * Cross-entity search for the command palette:
 * devices (top 5), incidents (top 3), changes (top 3).
 *
 * F-031 wave-9 (read-plane migration): every leg is scope-composed. The
 * device leg rides scopedDeviceWhere (hostname/displayName/mgmtIp hits —
 * including mgmtIp — no longer leak cross-scope); the incident and change
 * legs merge the SAME scope codes into their `site` relation (`site.code IN
 * (…)`), so out-of-scope incidents/changes vanish from the palette. A
 * site-less incident/change cannot match the relation filter and is hidden
 * from sites-limited sessions (row-level fail-closed parity with devices).
 * Wildcard sessions (no `sites` claim) keep the byte-unchanged where
 * shapes; deny-all sessions get empty legs.
 */

const querySchema = z.object({
  q: z.string().trim().min(2, "Search needs at least 2 characters").max(120),
});

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
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({ q: url.searchParams.get("q") ?? "" });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }

  const q = parsed.data.q;
  const contains = { contains: q };

  // F-031 wave-9: one scope resolution feeds all three legs. Wildcard →
  // the exact pre-F-031 where shapes; sites-mode → the scope codes merge
  // into the device where (scopedDeviceWhere) and the site relations.
  const scopeClaims = await sessionScopeFor(request);
  const scope = sessionSiteScope(scopeClaims);
  const textOr = { OR: [{ number: contains }, { title: contains }] };

  const [devices, incidents, changes] = await Promise.all([
    db.device.findMany({
      where: scopedDeviceWhere(scopeClaims, {
        OR: [
          { hostname: contains },
          { displayName: contains },
          { mgmtIp: contains },
        ],
      }),
      orderBy: { hostname: "asc" },
      take: 5,
      select: { id: true, hostname: true, mgmtIp: true, status: true },
    }),
    db.incident.findMany({
      where:
        scope.mode === "sites"
          ? { AND: [textOr, { site: { code: { in: scope.codes } } }] }
          : textOr,
      orderBy: { createdAt: "desc" },
      take: 3,
      select: {
        id: true,
        number: true,
        title: true,
        severity: true,
        status: true,
      },
    }),
    db.changeRequest.findMany({
      where:
        scope.mode === "sites"
          ? { AND: [textOr, { site: { code: { in: scope.codes } } }] }
          : textOr,
      orderBy: { createdAt: "desc" },
      take: 3,
      select: { id: true, number: true, title: true, status: true },
    }),
  ]);

  return ok({ devices, incidents, changes });
}
