import { db } from "@/lib/db";
import { fail, firstIssueMessage, newCorrelationId, ok } from "../../_lib/api";
import {
  METRICS_RETENTION_KEY,
  mergeRetention,
  partialSectionSchema,
  parseStoredRetention,
  readRetentionSetting,
} from "@/lib/performance/retention";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * /api/v1/metrics/retention (Task 6-a)
 *
 * GET  — effective metric retention policy (defaults merged when unset):
 *   data: { raw, rollup5M, rollup1H, rollup1D } × { days, enabled }
 *         + lastPrunedAt (ISO|null) + lastPruneResult (object|null)
 *   Defaults: raw 14d / 5M 3d / 1H 90d / 1D 365d, all enabled.
 *
 * PUT  — partial update. Every section is optional; inside a section both
 *   days (int 1–3650) and enabled (bool) are optional and merge onto the
 *   stored values. Guard: rollup5M.days ≤ 30 (5-minute rollups derive from
 *   raw samples — retaining fine-granularity data for months is pure
 *   storage cost). Upserts the "metrics.retention" Setting and audits
 *   SETTINGS_UPDATED with a RET-XXXXXX correlation (beforeJson/afterJson).
 */

const putSchema = z
  .object({
    raw: partialSectionSchema.optional(),
    rollup5M: partialSectionSchema.optional(),
    rollup1H: partialSectionSchema.optional(),
    rollup1D: partialSectionSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // 5M rollups derive from raw samples — cap their retention at 30 days.
    const days = value.rollup5M?.days;
    if (days !== undefined && days > 30) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rollup5M", "days"],
        message: "rollup5M.days must be ≤ 30 (5-minute rollups derive from raw samples)",
      });
    }
  });

export async function GET() {
  const view = parseStoredRetention((await readRetentionSetting())?.valueJson);
  return ok(view);
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }

  const existing = await readRetentionSetting();
  const stored = parseStoredRetention(existing?.valueJson);
  const { merged } = mergeRetention(stored, parsed.data);

  const correlationId = newCorrelationId("RET");
  const afterJson = JSON.stringify(merged);

  await db.setting.upsert({
    where: { key: METRICS_RETENTION_KEY },
    update: { valueJson: afterJson },
    create: { key: METRICS_RETENTION_KEY, valueJson: afterJson },
  });

  await db.auditEvent.create({
    data: {
      actorName: "Admin",
      action: "SETTINGS_UPDATED",
      resourceType: "Setting",
      resourceId: METRICS_RETENTION_KEY,
      resourceLabel: "Metric retention policy",
      result: "SUCCESS",
      correlationId,
      beforeJson: JSON.stringify(stored),
      afterJson,
    },
  });

  return ok({ ...merged, audit: { correlationId } });
}
