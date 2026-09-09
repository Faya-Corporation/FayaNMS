import { z } from "zod";

import { db } from "@/lib/db";
import {
  fail,
  firstIssueMessage,
  newCorrelationId,
  ok,
  requestContext,
} from "../../_lib/api";
import { resolveAdminActor } from "@/lib/auth/acting-admin";
import { authErrorToFail, requireRole } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * /api/v1/admin/settings (Task 7-b)
 *
 * System settings over the Setting table (dotted key → JSON value).
 * Whitelist-enforced: only the keys below are readable/writable — anything
 * else is UNKNOWN_SETTING / UNKNOWN_SETTINGS. The metrics *tier* retention
 * policy (raw/5M/1H/1D days + enabled) has its dedicated surface already
 * (/api/v1/metrics/retention + Performance Overview UI) and is NOT here.
 *
 * GET   — whitelisted keys, values parsed from valueJson.
 * PATCH — { updates: [{ key, value }] } with per-key type validation,
 *         before/after audit (SETTINGS_UPDATED, SET-XXXXXX correlation).
 */

/** Type-directed whitelist: "number" | "string" | "boolean". */
const SETTING_CATALOG: Record<string, { type: "number" | "string" | "boolean"; label: string; min?: number; max?: number }> = {
  "system.name": { type: "string", label: "Platform name", max: 60 },
  "backup.retention.days": { type: "number", label: "Backup retention (days)", min: 7, max: 730 },
  "backup.encryption": { type: "string", label: "Backup encryption", max: 40 },
  "drift.check.intervalMinutes": { type: "number", label: "Drift check cadence (minutes)", min: 5, max: 1440 },
  "alert.suppression.maintenanceWindows": { type: "boolean", label: "Suppress alerts in maintenance windows" },
  "metrics.rollup.retention.days": { type: "number", label: "Legacy scalar rollup retention (days)", min: 7, max: 3650 },
  "performance.sla.target": { type: "number", label: "Availability SLA target (%)", min: 90, max: 99.999 },
};

function parseValue(valueJson: string): unknown {
  try {
    return JSON.parse(valueJson);
  } catch {
    return valueJson;
  }
}

export async function GET(request: Request) {
  try {
    await resolveAdminActor(request);
    const rows = await db.setting.findMany({
      where: { key: { in: Object.keys(SETTING_CATALOG) } },
    });
    const settings: { key: string; value: unknown; type: string; label: string; updatedAt: string | null }[] = rows.map((row) => ({
      key: row.key,
      value: parseValue(row.valueJson),
      type: SETTING_CATALOG[row.key]?.type ?? "string",
      label: SETTING_CATALOG[row.key]?.label ?? row.key,
      updatedAt: row.updatedAt.toISOString(),
    }));
    // Include whitelist entries missing from the table so the UI renders
    // every control (with its default absent-value state).
    const present = new Set(rows.map((r) => r.key));
    for (const [key, spec] of Object.entries(SETTING_CATALOG)) {
      if (!present.has(key)) {
        settings.push({ key, value: null, type: spec.type, label: spec.label, updatedAt: null });
      }
    }
    return ok(
      { settings },
      { total: settings.length },
      200,
      requestContext(request)
    );
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (authFail) return authFail;
    throw error;
  }
}

const updateSchema = z.object({
  updates: z
    .array(
      z.object({
        key: z.string().trim().min(1),
        value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
      })
    )
    .min(1, "provide at least one update")
    .max(32),
});

export async function PATCH(request: Request) {
  try {
    // Phase 19-C (audit AUTHZ-001 sweep): admin-only gate (requireRole
    // replaces resolveAdminActor, whose UNAUTHENTICATED fallback let
    // anonymous callers through).
    let actor: Awaited<ReturnType<typeof requireRole>>;
    try {
      actor = await requireRole(request, "admin");
    } catch (error) {
      const authFail = authErrorToFail(error);
      if (!authFail) throw error;
      return authFail;
    }
    const body = await request.json().catch(() => null);
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
    }

    // Validate every update against the whitelist + type constraints FIRST
    // (atomic: nothing is written unless the whole batch is valid).
    const prepared: { key: string; value: unknown; before: unknown }[] = [];
    for (const { key, value } of parsed.data.updates) {
      const spec = SETTING_CATALOG[key];
      if (!spec) {
        return fail(
          "UNKNOWN_SETTING",
          `Setting "${key}" is not writable here (allowed: ${Object.keys(SETTING_CATALOG).join(", ")})`,
          400
        );
      }
      if (value === null) {
        return fail("INVALID_BODY", `Setting "${key}" cannot be set to null`, 400);
      }
      if (spec.type === "number") {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          return fail("INVALID_BODY", `Setting "${key}" expects a number`, 400);
        }
        if (spec.min !== undefined && value < spec.min) {
          return fail("INVALID_BODY", `Setting "${key}" must be ≥ ${spec.min}`, 400);
        }
        if (spec.max !== undefined && value > spec.max) {
          return fail("INVALID_BODY", `Setting "${key}" must be ≤ ${spec.max}`, 400);
        }
      } else if (spec.type === "boolean" && typeof value !== "boolean") {
        return fail("INVALID_BODY", `Setting "${key}" expects a boolean`, 400);
      } else if (spec.type === "string") {
        if (typeof value !== "string" || value.trim().length === 0) {
          return fail("INVALID_BODY", `Setting "${key}" expects a non-empty string`, 400);
        }
        if (spec.max !== undefined && value.length > spec.max) {
          return fail("INVALID_BODY", `Setting "${key}" must be ≤ ${spec.max} chars`, 400);
        }
      }
      const existing = await db.setting.findUnique({ where: { key } });
      prepared.push({ key, value, before: existing ? parseValue(existing.valueJson) : null });
    }

    const after: Record<string, unknown> = {};
    for (const { key, value } of prepared) {
      await db.setting.upsert({
        where: { key },
        update: { valueJson: JSON.stringify(value) },
        create: { key, valueJson: JSON.stringify(value) },
      });
      after[key] = value;
    }

    const correlationId = newCorrelationId("SET");
    await db.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName: actor.name ?? actor.email,
        action: "SETTINGS_UPDATED",
        resourceType: "Setting",
        resourceLabel: prepared.map((p) => p.key).join(", ").slice(0, 120),
        result: "SUCCESS",
        correlationId,
        beforeJson: JSON.stringify(Object.fromEntries(prepared.map((p) => [p.key, p.before]))),
        afterJson: JSON.stringify(after),
      },
    });

    return ok(
      {
        updated: Object.keys(after),
        settings: after,
        audit: { correlationId },
      },
      undefined,
      200,
      requestContext(request)
    );
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (authFail) return authFail;
    throw error;
  }
}
