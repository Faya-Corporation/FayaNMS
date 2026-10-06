/**
 * P1-A03 closure (GA re-audit 2026-10-06) — shared backup-policy scope guard.
 *
 * The finding: a sites-limited human holding `config.backup` could still
 * TARGET any site (or `*`, or an empty/missing siteCodes list — all
 * fleet-wide under the canonical scope contract) when creating or editing
 * backup policies. Scheduling is actuation: the worker executes whatever the
 * policy says, so this was an actuation authorization gap, not just an
 * information leak. The old in-route comment ("13-c F-10 — owner decision,
 * deliberately NOT changed here") is SUPERSEDED by the 2026-10-06 re-audit:
 * `requestedPolicySites ⊆ sessionAllowedSites` is now enforced, and
 * fleet-wide policies require a wildcard session.
 *
 * Pure and dependency-free so POST (create) and PATCH (replace-whole scope)
 * compose the SAME rule and the test suite can pin the exact denials:
 *
 *   - missing / empty siteCodes  → deny (canonical contract: an empty scope
 *     object means fleet-wide — omitting the list must not bypass the gate);
 *   - siteCodes containing "*"   → deny (fleet-wide);
 *   - any code outside the caller's scope → deny (named in the message);
 *   - otherwise                  → null (allowed).
 *
 * Wildcard sessions never call this guard (their behavior is byte-unchanged).
 */

/** One message for both fleet-wide shapes (empty list and "*") — a caller
 * cannot distinguish them from the outside, and both mean the same thing. */
export const BACKUP_POLICY_FLEET_DENIAL =
  'A site-limited session cannot target fleet-wide backup policies (a missing or empty siteCodes list, or "*", means fleet-wide).';

export function backupPolicyScopeDenial(
  allowedCodes: string[],
  requestedSiteCodes: readonly string[] | undefined
): string | null {
  if (!requestedSiteCodes || requestedSiteCodes.length === 0) {
    return BACKUP_POLICY_FLEET_DENIAL;
  }
  if (requestedSiteCodes.includes("*")) {
    return BACKUP_POLICY_FLEET_DENIAL;
  }
  const allowed = new Set(allowedCodes);
  const outside = requestedSiteCodes.filter((code) => !allowed.has(code));
  if (outside.length > 0) {
    return `This session's site scope does not include backup-policy target site(s): ${outside.join(", ")}.`;
  }
  return null;
}
