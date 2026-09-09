import { z } from "zod";

import { db } from "@/lib/db";

/**
 * CMDB route helpers (Phase 15-a) — shared Zod contracts + item resolution
 * for the /api/v1/cmdb/* surface. Enumerations mirror the documented String
 * columns of CmdbItem / CmdbRelation in prisma/schema.prisma (SQLite — no
 * Prisma enums, per schema rule 1).
 */

export const CMDB_CI_TYPES = [
  "device",
  "interface",
  "service",
  "application",
  "site",
  "circuit",
] as const;

export const CMDB_STATUSES = ["active", "planned", "retired", "maintenance"] as const;

export const CMDB_CRITICALITIES = ["low", "medium", "high", "critical"] as const;

export const CMDB_ENVIRONMENTS = ["production", "staging", "lab"] as const;

export const CMDB_SERVICE_TIERS = ["tier-1", "tier-2", "tier-3"] as const;

export const CMDB_RELATION_TYPES = [
  "runs_on",
  "connects_to",
  "part_of",
  "depends_on",
  "monitored_by",
] as const;

export const cmdbCiTypeSchema = z.enum(CMDB_CI_TYPES);
export const cmdbStatusSchema = z.enum(CMDB_STATUSES);
export const cmdbCriticalitySchema = z.enum(CMDB_CRITICALITIES);
export const cmdbEnvironmentSchema = z.enum(CMDB_ENVIRONMENTS);
export const cmdbServiceTierSchema = z.enum(CMDB_SERVICE_TIERS);
export const cmdbRelationTypeSchema = z.enum(CMDB_RELATION_TYPES);

/** ciId wire format — CI-000NNN, six digits (lexicographic == numeric order). */
export const CMDB_CI_ID_RE = /^CI-\d{6}$/;

/**
 * Resolve a CMDB item reference — accepts the cuid primary key OR the
 * human-facing CI-000NNN identifier (deep links and curl ergonomics).
 */
export async function resolveCmdbItem(ref: string) {
  if (CMDB_CI_ID_RE.test(ref)) {
    return db.cmdbItem.findUnique({ where: { ciId: ref } });
  }
  return db.cmdbItem.findUnique({ where: { id: ref } });
}

/** Shared projection for counterpart summaries in relation lists / impact. */
export const CMDB_ITEM_SUMMARY_SELECT = {
  id: true,
  ciId: true,
  name: true,
  ciType: true,
  status: true,
  criticality: true,
  environment: true,
  serviceTier: true,
} as const;

export type CmdbItemSummary = {
  id: string;
  ciId: string;
  name: string;
  ciType: string;
  status: string;
  criticality: string;
  environment: string;
  serviceTier: string;
};

/**
 * Next free CI-000NNN. The zero-padded format keeps lexicographic and
 * numeric order identical, so max(ciId) is a single ordered read. Callers
 * retry the create once on a unique violation in case two requests race.
 */
export async function nextCmdbCiId(): Promise<string> {
  const highest = await db.cmdbItem.findFirst({
    orderBy: { ciId: "desc" },
    select: { ciId: true },
  });
  const next = highest ? Number.parseInt(highest.ciId.slice(3), 10) + 1 : 1;
  return `CI-${String(next).padStart(6, "0")}`;
}
