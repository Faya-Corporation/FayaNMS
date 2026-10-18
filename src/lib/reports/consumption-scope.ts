import type { SiteScope } from "@/lib/auth/scope";
import { reportScopeFromJson } from "@/lib/reports/generate";

// FNM-2026-104 (2026-10-18 re-audit, Wave R2) — report-artifact consumption
// scoping. GA-2 froze the CREATION scope of schedules; this module enforces
// the READ side: a report artifact may be consumed by a session whose site
// scope CONTAINS the artifact's frozen data scope.
//
// Semantics (set containment on site codes):
//   - wildcard viewer      → reads everything (the pre-GA-2 single-tenant
//                            default; admins and seeded rows);
//   - wildcard artifact    → contains FLEET-wide data, so ONLY a wildcard
//                            viewer may read it (a site-limited viewer is
//                            denied even if they created... they cannot have:
//                            creation freezes the creator's scope, so a
//                            wildcard artifact can only come from a wildcard
//                            creator or legacy rows — both beyond a limited
//                            viewer's reach);
//   - sites artifact A     → readable by viewer V iff A.codes ⊆ V.codes
//                            (a site-A viewer reads a site-A artifact; a
//                            site-B viewer does not);
//   - deny-all artifact (∅) → readable by everyone — it contains NO data
//                            (the generation is empty by construction).

export const REPORT_SCOPE_FORBIDDEN = "REPORT_SCOPE_FORBIDDEN";

/**
 * True when `viewer` may consume an artifact whose frozen data scope is
 * `artifact`. Wildcard always reads; a wildcard ARTIFACT is never readable
 * by a sites-limited viewer (it holds fleet-wide data); a sites artifact is
 * readable iff every one of its codes is inside the viewer's scope.
 */
export function artifactReadableBy(artifact: SiteScope, viewer: SiteScope): boolean {
  if (viewer.mode === "wildcard") return true;
  if (artifact.mode === "wildcard") return false;
  return artifact.codes.every((code) => viewer.codes.includes(code));
}

/**
 * Convenience over a schedule row's frozen scopeJson (null = wildcard —
 * the legacy + wildcard-creator default; "[]" = deny-all; JSON array =
 * sites mode). Parse failures classify deny-all inside
 * reportScopeFromJson, so a hand-edited row can never widen access.
 */
export function scheduleReadableByViewer(
  scheduleScopeJson: string | null | undefined,
  viewer: SiteScope
): boolean {
  return artifactReadableBy(reportScopeFromJson(scheduleScopeJson), viewer);
}
