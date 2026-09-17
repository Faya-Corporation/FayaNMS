/**
 * R50-T021 — credential-profile authorization for ACTIVE probes.
 *
 * The auto-detect probe attaches a live credential to an active network
 * action. Roadmap requirement: "Verify actor → credential profile → tenant
 * → target network scope". The chain as verified TODAY (single-tenant
 * schema — the honest statement of what each link means here):
 *
 *   actor → profile   requirePermission("device.detect") bounds WHO may
 *                     probe at all (RBAC, R50-T020); THIS module decides
 *                     which credential profiles may be USED for probing —
 *                     an optional operator allowlist
 *                     (FAYANMS_PROBE_CREDENTIAL_ALLOWLIST, csv of profile
 *                     ids or names). Unset = every profile usable (the
 *                     documented single-tenant demo posture — the RBAC
 *                     gate still bounds who); set = fail-closed: a profile
 *                     matching NO entry is refused with the stable
 *                     CREDENTIAL_NOT_AUTHORIZED code and audited with the
 *                     "profile-not-allowlisted" reason.
 *   profile → tenant  the schema is single-tenant BY DESIGN (see the
 *                     R50.7 audit evidence: `tenant: null` is the reserved
 *                     shape, never a silent omission) — both sides of the
 *                     link are the same tenant, so the link passes
 *                     structurally and is RECORDED as such
 *                     (tenantScope: "single-tenant") rather than skipped.
 *   profile → target  the target-network scope of the ACTION is governed
 *                     by the two-plane target policy (R50-T022/T023): the
 *                     literal classification app-side + the worker-side
 *                     resolved-address check before the dial. The route
 *                     records both classes in the audit evidence so the
 *                     chain is auditable end-to-end.
 *
 * Pure module (no db, no env reads inside the decision — the route owns
 * the env read so tests inject the parsed list directly).
 */

/** The decision the route acts on (audited verbatim). */
export type ProbeCredentialDecision =
  /** Profile is authorized for probing. */
  | "allowed"
  /** An allowlist is enforced and the profile matched no entry. */
  | "refused-not-allowlisted";

export interface ProbeCredentialAuthorization {
  decision: ProbeCredentialDecision;
  /** Which allowlist entry matched (when enforcement is on and allowed). */
  matchedBy: "id" | "name" | null;
  /** True when an allowlist is enforced at all (evidence for the audit). */
  allowlistEnforced: boolean;
}

/**
 * Parse the FAYANMS_PROBE_CREDENTIAL_ALLOWLIST value.
 *   undefined / blank  → null  (not enforced — documented default posture)
 *   "a, b ,,c"         → ["a", "b", "c"]  (trim; empty tokens dropped)
 * A malformed list cannot exist syntactically (csv of strings), and an
 * ENFORCED-but-empty list is expressed by setting the var to a sentinel
 * that matches nothing (e.g. "none") — the parse never silently converts
 * "set" into "not enforced".
 */
export function parseProbeCredentialAllowlist(raw: string | undefined | null): string[] | null {
  if (raw === undefined || raw === null) return null;
  const entries = raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (entries.length === 0) return null; // blank string = not enforced
  return entries;
}

/**
 * Decide whether the referenced profile may be attached to an active
 * probe. `allowlist === null` means no allowlist is configured (default
 * posture — the RBAC gate device.detect remains the actor bound); a
 * non-null list is fail-closed: the profile must match an entry by id or
 * by unique name.
 */
export function authorizeProbeCredential(input: {
  profileId: string;
  profileName: string;
  allowlist: string[] | null;
}): ProbeCredentialAuthorization {
  const { profileId, profileName, allowlist } = input;
  if (allowlist === null) {
    return { decision: "allowed", matchedBy: null, allowlistEnforced: false };
  }
  if (allowlist.includes(profileId)) {
    return { decision: "allowed", matchedBy: "id", allowlistEnforced: true };
  }
  if (profileName.length > 0 && allowlist.includes(profileName)) {
    return { decision: "allowed", matchedBy: "name", allowlistEnforced: true };
  }
  return { decision: "refused-not-allowlisted", matchedBy: null, allowlistEnforced: true };
}
