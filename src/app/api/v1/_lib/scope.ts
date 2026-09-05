import type { Prisma } from "@prisma/client";

/**
 * Shared BackupPolicy scope resolution (Task 3-a).
 *
 * scopeJson is a serialized JSON object. Two shapes exist in the wild:
 *   - Legacy (seed, tick 2-b): { siteCodes, criticality, excludeStatuses }
 *   - Canonical (policies API since 3-a): { siteCodes, criticalities, statuses }
 *
 * `statuses` is an INCLUDE filter (only devices in those statuses); it is
 * not an exclusion list — UNMANAGED and OFFLINE are always excluded by the
 * scheduler regardless. `excludeStatuses` stays supported for the seeded
 * policies and narrows the include filter further.
 */

export interface ParsedPolicyScope {
  /** Site codes ("*" = every site); null/absent = all sites. */
  siteCodes: string[] | null;
  /** Device criticalities; null/absent = all. */
  criticalities: string[] | null;
  /** Device status include-filter; null/absent = all manageable statuses. */
  statuses: string[] | null;
  /** Legacy exclusion list (seeded policies); always narrowed by UNMANAGED/OFFLINE. */
  excludeStatuses: string[];
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const arr = value.filter(
    (v): v is string => typeof v === "string" && v.length > 0
  );
  return arr.length > 0 ? arr : null;
}

export function parsePolicyScope(
  text: string | null | undefined
): ParsedPolicyScope {
  let scope: Record<string, unknown> = {};
  if (text) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        scope = parsed as Record<string, unknown>;
      }
    } catch {
      scope = {};
    }
  }

  return {
    siteCodes: stringArray(scope.siteCodes),
    criticalities: stringArray(scope.criticality) ?? stringArray(scope.criticalities),
    statuses: stringArray(scope.statuses),
    excludeStatuses: stringArray(scope.excludeStatuses) ?? [],
  };
}

/** Statuses the scheduler never touches (unreachable or unmanaged devices). */
export const ALWAYS_EXCLUDED_STATUSES = ["UNMANAGED", "OFFLINE"] as const;

/**
 * Prisma where-clause matching the devices a policy scope targets.
 * Status constraints are combined via AND because a single `status` key
 * cannot carry both `in` and `notIn`.
 */
export function scopeDeviceWhere(scope: ParsedPolicyScope): Prisma.DeviceWhereInput {
  const excluded = Array.from(
    new Set<string>([...scope.excludeStatuses, ...ALWAYS_EXCLUDED_STATUSES])
  );

  return {
    AND: [
      { status: { notIn: excluded } },
      ...(scope.statuses ? [{ status: { in: scope.statuses } }] : []),
      ...(scope.criticalities
        ? [{ criticality: { in: scope.criticalities } }]
        : []),
      ...(scope.siteCodes && !scope.siteCodes.includes("*")
        ? [{ site: { code: { in: scope.siteCodes } } }]
        : []),
    ],
  };
}
