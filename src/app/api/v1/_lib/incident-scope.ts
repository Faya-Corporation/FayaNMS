import type { SessionScopeClaims } from "@/lib/auth/scope";
import { sessionSiteScope } from "@/lib/auth/scope";

/**
 * F-031 incident-site scope predicate (wave-10 workflow-plane migration).
 *
 * The wave-9 AI-plane migration (10-b-1) certified this exact predicate as
 * the private `scopedIncidentSiteWhere` helper inside
 * src/app/api/v1/ai/query/route.ts. That file is outside the wave-10
 * workflow-plane fix agent's ownership, so the certified pattern is
 * reproduced HERE (verbatim semantics, not a hand-rolled variant) for the
 * incidents routes to compose — the single place the incident-visibility
 * contract lives for this plane:
 *
 *   - wildcard (absent `sites` claim, or a non-session principal — the
 *     API-client bearer read plane stays unscoped by documented posture)
 *       → `{}` — composes into any AND-list as a no-op, so wildcard
 *         sessions keep the byte-identical base where clause;
 *   - sites mode (including deny-all `[]` and malformed claims, which
 *     sessionSiteScope classifies fail-closed) → `{ site: { code: { in:
 *     codes } } }` — an incident with NO site can never match the relation
 *     filter, so it is hidden from sites-limited sessions (row-level
 *     fail-closed SQL parity, the documented ztp/claims rule).
 *
 * The detail/export reads pair this with the row-level predicate
 * `sessionAllowsSite(claims, incident.site?.code ?? null)` fused into the
 * not-found envelope (404-not-403) so a row hidden from the list cannot
 * leak through the detail route — the same list/detail parity invariant
 * the device domain holds.
 */
export function scopedIncidentSiteWhere(
  scopeClaims: SessionScopeClaims | null | undefined
):
  | Record<string, never>
  | { site: { code: { in: string[] } } } {
  const scope = sessionSiteScope(scopeClaims);
  return scope.mode === "sites"
    ? { site: { code: { in: scope.codes } } }
    : {};
}
