import type { Prisma } from "@prisma/client";

/**
 * Resource-level site scoping (F-031, audit A1-08) — pure enforcement core.
 *
 * The finding: permissions are global per role — any viewer could read every
 * site/device. Product tenancy is NOT landing now; this module ships the
 * SCOPING INFRASTRUCTURE with single-tenant-safe defaults so today's
 * behavior is byte-unchanged while the mechanism exists centrally:
 *
 *   - The session JWT carries an OPTIONAL `sites: string[]` claim (site
 *     codes), minted at sign-in from User.siteScopeJson (nullable column).
 *   - ABSENT claim = WILDCARD (every site) — the single-tenant default.
 *     Every session minted before F-031 (and every user whose scope was
 *     never set) has no claim, so nothing changes for them.
 *   - A sites-limited claim restricts device reads to those site codes.
 *   - FAIL-CLOSED: a MALFORMED claim (present but not an array of non-empty
 *     strings) and an EMPTY array (`sites: []`) both resolve to deny-all —
 *     malformed scope can never widen access. The only "wide" state is the
 *     ABSENT claim, which is exactly the pre-F-031 world.
 *
 * Scope semantics are centralized here (pure, dependency-free) so per-route
 * migrations compose the same predicates instead of hand-rolling where
 * clauses — the reference migration is GET /api/v1/devices (list) and
 * GET /api/v1/devices/[id] (detail). The remaining routes migrate on
 * demand (documented in docs/security/authorization-matrix.md §5).
 */

/** Resolved scope for a session: wildcard (everything) or an explicit code list. */
export type SiteScope = { mode: "wildcard" } | { mode: "sites"; codes: string[] };

/**
 * Minimal claim shape consumed by the scope helpers. `sites` is typed
 * `unknown` on purpose: a JWT claim (or a hand-edited DB row) can be
 * anything, and the helpers must classify it fail-closed, not trust it.
 */
export interface SessionScopeClaims {
  sites?: unknown;
}

/** The JWT claim key carrying the site codes ("sites"). */
export const SITE_SCOPE_CLAIM_KEY = "sites";

/**
 * Validate + normalize a candidate site-code list. Returns the deduped
 * code array (first-occurrence order preserved) or null when the value is
 * MALFORMED (not an array, or any member is not a non-empty string).
 * An empty array is VALID (it means deny-all, the fail-closed choice).
 *
 * Size bound (post-register audit wave 5): more than SITE_SCOPE_MAX_CODES
 * codes is treated as MALFORMED — the admin write surface caps at 32 and
 * the parser's own threat model (a hand-edited DB row) must not mint an
 * unbounded claim whose per-request re-normalization degrades the request
 * path. Fail-closed: an oversized list denies all, never truncates.
 *
 * Per-code length bound (site-scope wave 7): any member longer than
 * SITE_SCOPE_MAX_CODE_CHARS makes the WHOLE claim MALFORMED, mirroring the
 * count rule above. Rationale: the write surface caps codes at 32 chars
 * (SITE_SCOPE_MAX_CODE_LENGTH in the admin users route), so a >64-char
 * member can only come from a hand-edited DB row — the documented
 * hand-edited-row threat model must bound cookie size too, not just the
 * code count.
 */
export const SITE_SCOPE_MAX_CODES = 32;
export const SITE_SCOPE_MAX_CODE_CHARS = 64;

export function normalizeSiteScopeCodes(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > SITE_SCOPE_MAX_CODES) return null;
  const seen = new Set<string>();
  const codes: string[] = [];
  for (const member of value) {
    if (typeof member !== "string" || member.length === 0) return null;
    if (member.length > SITE_SCOPE_MAX_CODE_CHARS) return null;
    if (!seen.has(member)) {
      seen.add(member);
      codes.push(member);
    }
  }
  return codes;
}

/**
 * Classify a session's site scope (the single source of truth for
 * enforcement). Contract:
 *
 *   - null/undefined session, or absent (undefined/null) `sites` claim
 *       → { mode: "wildcard" } — the single-tenant default; every session
 *         minted before F-031 lands here, byte-unchanged behavior.
 *   - `sites: []` (empty array)
 *       → { mode: "sites", codes: [] } — deny-all (fail-closed).
 *   - malformed claim (non-array / non-string or empty-string members)
 *       → { mode: "sites", codes: [] } — deny-all (fail-closed), with a
 *         console.warn log line. A malformed scope can NEVER widen access;
 *         treating it as wildcard is forbidden.
 *   - valid array of non-empty strings
 *       → { mode: "sites", codes } — deduped, order-preserving.
 */
export function sessionSiteScope(
  session: SessionScopeClaims | null | undefined
): SiteScope {
  const claim = session === null || session === undefined ? undefined : session.sites;
  if (claim === undefined || claim === null) {
    return { mode: "wildcard" };
  }
  const codes = normalizeSiteScopeCodes(claim);
  if (codes === null) {
    console.warn(
      "[auth:scope] malformed site-scope claim — denying all sites (fail-closed)"
    );
    return { mode: "sites", codes: [] };
  }
  return { mode: "sites", codes };
}

/**
 * Device-row visibility for a resolved scope — the EXACT semantics of the
 * Prisma filter composed by scopedDeviceWhere (`site: { code: { in: … } }`),
 * exposed as a predicate so the detail route (404-not-403) cannot drift
 * from the list route's where clause:
 *
 *   - wildcard → true (every device, byte-unchanged pre-F-031 behavior);
 *   - sites mode → the device's site code must be IN the scope list;
 *   - a device whose site is unset (siteId is nullable, Site delete is
 *     SetNull) can never match the relation filter, so sites-limited
 *     sessions do not see it here either (fail-closed parity with SQL).
 *
 * NOTE the deliberate difference from assertSiteScope: this predicate is
 * ROW-level (a device with no site is hidden from sites-limited sessions),
 * while assertSiteScope is RESOURCE-level (a resource without a site
 * dimension bypasses scoping entirely — the documented rule). Devices
 * normally always carry a site, so the row-level null edge is safety-only.
 */
export function siteScopeAllows(scope: SiteScope, siteCode: string | null): boolean {
  if (scope.mode === "wildcard") return true;
  return siteCode !== null && scope.codes.includes(siteCode);
}

/** Convenience composition: classify the session claims, then siteScopeAllows. */
export function sessionAllowsSite(
  session: SessionScopeClaims | null | undefined,
  siteCode: string | null
): boolean {
  return siteScopeAllows(sessionSiteScope(session), siteCode);
}

/** Thrown by assertSiteScope when a sites-limited session reaches for a
 * site outside its scope. Mapped to 403 by the require* layer (session.ts). */
export class SiteScopeDeniedError extends Error {
  readonly code = "SITE_SCOPE_FORBIDDEN";

  constructor(siteCode: string) {
    super(`This session's site scope does not include site "${siteCode}".`);
    this.name = "SiteScopeDeniedError";
  }
}

/**
 * RESOURCE-level scope gate (the requirePermission-family primitive).
 * Rule for the null site (a resource with NO site dimension — the edge is
 * safety-only for devices, which normally always carry a siteId):
 * UNSCOPED/GLOBAL RESOURCES BYPASS SITE SCOPING — a sites-limited session
 * may still touch them. Documented in authorization-matrix.md §5.
 *
 * Throws SiteScopeDeniedError for an out-of-scope site code; the caller
 * decides the response shape (403, or 404 for anti-existence-leak detail
 * reads — see the devices [id] route).
 */
export function assertSiteScope(
  session: SessionScopeClaims | null | undefined,
  siteCode: string | null
): void {
  if (siteCode === null) return; // unscoped resource — bypasses site scoping
  const scope = sessionSiteScope(session);
  if (scope.mode === "wildcard") return;
  if (!scope.codes.includes(siteCode)) {
    throw new SiteScopeDeniedError(siteCode);
  }
}

/**
 * Compose the scope filter over any base device where-clause (the central
 * where-builder per-route migrations call instead of hand-rolling):
 *
 *   - wildcard → the BASE WHERE, unchanged (the parity guarantee: sessions
 *     without a scope claim see exactly what they saw before F-031);
 *   - sites mode → `{ AND: [baseWhere, { site: { code: { in: codes } } }] }`
 *     — a deny-all scope (`codes: []`) naturally matches nothing because
 *     Prisma `in: []` is empty.
 */
export function scopedDeviceWhere(
  session: SessionScopeClaims | null | undefined,
  baseWhere: Prisma.DeviceWhereInput
): Prisma.DeviceWhereInput {
  return deviceWhereForScope(sessionSiteScope(session), baseWhere);
}

/**
 * The RESOLVED-SCOPE variant of scopedDeviceWhere (GA re-audit 2026-10-06,
 * P1-A01): compose the site filter over a base where from an ALREADY
 * resolved SiteScope — for report generation, where the scope is FROZEN at
 * schedule-creation/run time and carried as a value object rather than
 * re-resolved from the (service-plane) request's claims. Semantics are
 * IDENTICAL to scopedDeviceWhere:
 *
 *   - wildcard → the BASE WHERE, unchanged;
 *   - sites mode → `{ AND: [baseWhere, { site: { code: { in: codes } } }] }`.
 *
 * scopedDeviceWhere(session, base) is exactly deviceWhereForScope(
 * sessionSiteScope(session), base) — one composition, no drift.
 */
export function deviceWhereForScope(
  scope: SiteScope,
  baseWhere: Prisma.DeviceWhereInput
): Prisma.DeviceWhereInput {
  if (scope.mode === "wildcard") return baseWhere;
  return {
    AND: [baseWhere, { site: { code: { in: scope.codes } } }],
  };
}

/**
 * Mint-side parser (sign-in path): turn User.siteScopeJson into the JWT
 * `sites` claim. Contract:
 *
 *   - null/undefined column → undefined = NO claim = wildcard (the
 *     single-tenant default; the claim key is omitted from the token);
 *   - valid JSON array → the deduped code list (empty array IS minted —
 *     an explicit deny-all scope is a deliberate admin action);
 *   - malformed JSON / wrong shape → [] (deny-all) with a console.warn —
 *     fail-closed, consistent with sessionSiteScope's malformed rule (a
 *     hand-edited DB row can never mint wildcard access).
 */
export function userSiteScopeClaim(
  siteScopeJson: string | null | undefined
): string[] | undefined {
  if (siteScopeJson === null || siteScopeJson === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(siteScopeJson);
  } catch {
    console.warn(
      "[auth:scope] malformed User.siteScopeJson — minting a deny-all scope (fail-closed)"
    );
    return [];
  }
  const codes = normalizeSiteScopeCodes(parsed);
  if (codes === null) {
    console.warn(
      "[auth:scope] malformed User.siteScopeJson — minting a deny-all scope (fail-closed)"
    );
    return [];
  }
  return codes;
}
