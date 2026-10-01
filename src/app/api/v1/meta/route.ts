import { ok } from "../_lib/api";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/meta — session-exempt bootstrap endpoint (see src/proxy.ts,
 * exact-match exemption). The pre-auth payload is EMPTY by contract.
 *
 * Disclosure history (each step machine-pinned):
 *   - R51-A2: no credential-profile operator usernames.
 *   - HC-2 (R54): the active-user directory moved to the AUTHENTICATED
 *     `/api/v1/meta/users`.
 *   - RT-024 (F-028): vendors, sites and credential profiles moved to the
 *     AUTHENTICATED `/api/v1/meta/reference` — unauthenticated callers must
 *     not enumerate credential-profile names/types or the site inventory.
 *
 * Verified at RT-024 time: NO pre-auth surface consumes this route's data
 * (`useMeta` and every consumer render behind the session shell;
 * `sign-in-gate.tsx` never calls it), so the sign-in transition needs
 * nothing here. The route stays as a stable session-exempt liveness /
 * bootstrap surface (e.g. the e2e readiness probe) and answers the standard
 * success envelope with an empty data object. Anything a future pre-auth
 * surface genuinely needs must be added here ONLY after the same disclosure
 * review, and pinned in tests/audit/rt024-meta-preauth-trim.test.ts.
 */
export async function GET() {
  return ok({});
}
