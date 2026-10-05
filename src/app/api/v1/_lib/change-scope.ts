import type { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { fail } from "../_lib/api";
import { sessionScopeFor } from "@/lib/auth/session";
import {
  scopedDeviceWhere,
  sessionSiteScope,
  type SessionScopeClaims,
} from "@/lib/auth/scope";

/**
 * Change-plane site-scope helpers (F-031 wave 10 — audit 13-b F-2/F-3).
 *
 * A ChangeRequest carries its site dimension in TWO places: the nullable
 * `site` relation (the primary leg) and, when `siteId` is unset, the linked
 * ChangeDevice rows (the device leg). The read plane composes BOTH legs into
 * its where clauses (a change is visible when its site OR any linked device
 * is inside the session's scope); the mutation plane requires the WHOLE
 * resource to be inside the scope (site leg, or EVERY linked device for a
 * site-less change). A change with no site and no linked devices has no site
 * dimension anywhere — the documented assertSiteScope(null) unscoped-resource
 * bypass applies (authorization-matrix.md §5.1).
 *
 * Centralized here (like cmdb's linkage predicate) so the list, detail,
 * conflicts and the four mutation routes cannot drift apart.
 */

/** Where does a change's site dimension live? */
export type ChangeScopeTarget =
  | { kind: "missing" } // the change row vanished between load and gate
  | { kind: "site"; code: string } // the primary site leg
  | { kind: "devices"; deviceIds: string[] } // site-less; rides the linked devices
  | { kind: "unscoped" }; // no site AND no devices — genuinely global

/**
 * Resolve the site dimension of a change row (site relation first; a
 * site-less change falls back to its linked devices). `missing` means the
 * row no longer exists — callers answer their ordinary not-found envelope.
 */
export async function resolveChangeScopeTarget(
  changeId: string
): Promise<ChangeScopeTarget> {
  const change = await db.changeRequest.findUnique({
    where: { id: changeId },
    select: { site: { select: { code: true } } },
  });
  if (!change) return { kind: "missing" };
  if (change.site?.code) return { kind: "site", code: change.site.code };
  const links = await db.changeDevice.findMany({
    where: { changeId },
    select: { deviceId: true },
  });
  if (links.length === 0) return { kind: "unscoped" };
  return { kind: "devices", deviceIds: links.map((link) => link.deviceId) };
}

/**
 * MUTATION-plane gate for a site-less change: EVERY linked device must be
 * inside the session's scope (wildcard sessions bypass; a device whose site
 * is unset can never match the scope filter and is denied fail-closed, the
 * row-level rule from scope.ts). Returns a 403 SITE_SCOPE_FORBIDDEN
 * envelope when the leg is out of scope, else null. Null claims (no
 * session) answer 401 — unreachable today (every caller sits behind
 * requirePermission), kept strict per the wave-7 requireSiteScope rule.
 */
export async function requireDeviceLegScope(
  request: Request,
  deviceIds: string[]
): Promise<NextResponse | null> {
  const claims = await sessionScopeFor(request);
  if (claims === null) {
    return fail(
      "UNAUTHENTICATED",
      "Sign in required — no valid session was provided.",
      401
    );
  }
  const scope = sessionSiteScope(claims);
  if (scope.mode === "wildcard") return null;
  const rows = await db.device.findMany({
    where: { id: { in: deviceIds } },
    select: { id: true, site: { select: { code: true } } },
  });
  const allInScope =
    rows.length === deviceIds.length &&
    rows.every((row) => {
      const code = row.site?.code ?? null;
      return code !== null && scope.codes.includes(code);
    });
  if (!allInScope) {
    return fail(
      "SITE_SCOPE_FORBIDDEN",
      "This session's site scope does not include the site of every device linked to this change.",
      403
    );
  }
  return null;
}

/**
 * READ-plane where leg for change lists (changes list, approvals queue via
 * the `change` relation, conflicts calendar): a change is visible when its
 * OWN site is in scope OR any linked device is. Wildcard sessions get the
 * base where unchanged — the byte-parity guarantee (the AI plane's changes
 * executor composes the same site leg; the device leg adds the site-less
 * changes the AI leg cannot see).
 */
export function changeScopeListWhere(
  scopeClaims: SessionScopeClaims | null | undefined
): Prisma.ChangeRequestWhereInput {
  const scope = sessionSiteScope(scopeClaims);
  if (scope.mode === "wildcard") return {};
  return {
    OR: [
      { site: { code: { in: scope.codes } } },
      { devices: { some: { device: { site: { code: { in: scope.codes } } } } } },
    ],
  };
}

/**
 * Row-level visibility predicate for change detail reads (404-not-403): the
 * EXACT semantics of changeScopeListWhere exposed as a predicate, so a
 * change hidden from the list cannot leak through the detail route (the
 * devices-[id] pattern). Out-of-scope ≡ unknown — callers answer their
 * ordinary CHANGE_NOT_FOUND envelope.
 */
export async function changeVisibleInScope(
  scopeClaims: SessionScopeClaims | null | undefined,
  change: { id: string; siteCode: string | null }
): Promise<boolean> {
  const scope = sessionSiteScope(scopeClaims);
  if (scope.mode === "wildcard") return true;
  if (change.siteCode !== null && scope.codes.includes(change.siteCode)) {
    return true;
  }
  const links = await db.changeDevice.findMany({
    where: { changeId: change.id },
    select: { device: { select: { site: { select: { code: true } } } } },
  });
  return links.some((link) => {
    const code = link.device.site?.code ?? null;
    return code !== null && scope.codes.includes(code);
  });
}

/**
 * CREATE/EDIT-plane device intersection: for a sites-limited session EVERY
 * requested device id must resolve INSIDE the scope; the fused refusal
 * (unknown ∪ out-of-scope) answers the ordinary DEVICE_NOT_FOUND shape
 * WITHOUT echoing ids — echoing would leak which out-of-scope ids exist
 * (the cmdb POST device-reference rule). Wildcard sessions return null:
 * their unknown-id handling stays exactly the pre-wave-10 echo envelope
 * (byte-parity — for a wildcard session "out of scope" is empty by
 * definition, so `missing` is genuinely unknown).
 */
export async function requireDevicesInScope(
  request: Request,
  deviceIds: string[]
): Promise<NextResponse | null> {
  const claims = await sessionScopeFor(request);
  const scope = sessionSiteScope(claims);
  if (scope.mode === "wildcard") return null;
  const visible = await db.device.findMany({
    where: scopedDeviceWhere(claims, { id: { in: deviceIds } }),
    select: { id: true },
  });
  const visibleIds = new Set(visible.map((row) => row.id));
  if (deviceIds.some((id) => !visibleIds.has(id))) {
    return fail(
      "DEVICE_NOT_FOUND",
      "One or more of the selected devices does not exist or is outside your site scope",
      400
    );
  }
  return null;
}

/**
 * F-029/R69 email discipline for change-plane user labels: engineer-visible
 * lists show the name or the email LOCAL-PART — the full address stays
 * admin/auditor (the F-029 directory rule). `fullEmail` is true only for
 * admin/auditor principals.
 */
export function changeUserLabel(
  user: { name: string | null; email: string } | null | undefined,
  fullEmail: boolean
): string | null {
  if (!user) return null;
  if (user.name) return user.name;
  const localPart = user.email.split("@")[0] ?? null;
  return fullEmail ? (user.email || localPart) : localPart;
}
