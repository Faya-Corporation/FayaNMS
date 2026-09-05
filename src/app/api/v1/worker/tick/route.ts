import { db } from "@/lib/db";
import { fail, firstIssueMessage, newJobCorrelationId, ok } from "../../_lib/api";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/worker/tick — scheduler tick driven by the worker mini-service.
 *
 * For every active BackupPolicy:
 *   1. parse its 5-field cron expression (supports star, exact values, a-b
 *      ranges, a,b lists and step values written as star-slash-n — a small
 *      hand-rolled matcher);
 *      the policy is DUE when a matching minute mark falls inside the last
 *      tick window (default 65 s — a 30 s tick loop always lands inside one).
 *   2. if due, resolve the policy's target devices from its scopeJson
 *      ({ siteCodes: ["*"|codes], criticality: [...], excludeStatuses: [...] });
 *      UNMANAGED and OFFLINE devices are always excluded (unreachable devices
 *      are not scheduled — the seeded HQ-IDF-SW-01 failed-backup story stays
 *      untouched; manual backup-now on an OFFLINE device still fails
 *      realistically in the worker).
 *   3. dedupe per device: skip devices that already have a QUEUED/RUNNING
 *      CONFIG_BACKUP job, or a policy-tagged job (payloadJson contains the
 *      policyId) created within the 10-minute dedupe window. Repeated ticks
 *      within a minute can therefore never double-enqueue.
 *   4. enqueue CONFIG_BACKUP JobExecutions (payload: deviceId, policyId,
 *      policyName, source SCHEDULED), capped at 10 per policy per tick.
 *
 * Returns { enqueued, evaluatedAt, policies }.
 */

const tickSchema = z.object({
  windowSec: z.number().int().min(5).max(3_600).default(65),
});

const PER_POLICY_CAP = 10;
const DEDUPE_WINDOW_MIN = 10;

/* ── tiny 5-field cron matcher ──────────────────────────────────────────── */

function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  return field.split(",").some((rawPart) => {
    const part = rawPart.trim();
    if (!part) return false;
    let step = 1;
    let range = part;
    if (part.includes("/")) {
      const [r, s] = part.split("/");
      range = r;
      step = Number.parseInt(s, 10);
      if (!Number.isFinite(step) || step < 1) return false;
    }
    if (range === "*" || range === "") {
      return (value - min) % step === 0;
    }
    if (range.includes("-")) {
      const [a, b] = range.split("-").map((n) => Number.parseInt(n, 10));
      if (!Number.isFinite(a) || !Number.isFinite(b) || a > b) return false;
      if (value < a || value > b) return false;
      return (value - a) % step === 0;
    }
    const n = Number.parseInt(range, 10);
    if (!Number.isFinite(n)) return false;
    if (value < n) return false;
    return (value - n) % step === 0;
  });
}

/** True when `expr` matches the given minute. Invalid expressions never match. */
function cronMatches(expr: string, at: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minuteF, hourF, domF, monthF, dowF] = fields;

  if (!fieldMatches(minuteF, at.getMinutes(), 0, 59)) return false;
  if (!fieldMatches(hourF, at.getHours(), 0, 23)) return false;
  if (!fieldMatches(monthF, at.getMonth() + 1, 1, 12)) return false;

  const domRestricted = domF !== "*";
  const dowRestricted = dowF !== "*";
  const domOk = fieldMatches(domF, at.getDate(), 1, 31);
  const dow = dowF === "7" ? "0" : dowF; // allow 7 = Sunday
  const dowOk = fieldMatches(dow, at.getDay(), 0, 6);

  // Vixie-cron semantics: when both day fields are restricted, either may match.
  if (domRestricted && dowRestricted) return domOk || dowOk;
  if (domRestricted) return domOk;
  if (dowRestricted) return dowOk;
  return true;
}

/** Due when a matching minute mark falls within (now - windowSec, now]. */
function cronDueWithin(expr: string, windowSec: number, now: Date): boolean {
  const nowMs = now.getTime();
  const endMinute = Math.floor(nowMs / 60_000);
  const startMinute = Math.floor((nowMs - windowSec * 1_000) / 60_000);
  for (let mark = startMinute; mark <= endMinute; mark += 1) {
    if (cronMatches(expr, new Date(mark * 60_000))) return true;
  }
  return false;
}

/* ── scope resolution ───────────────────────────────────────────────────── */

function safeParseScope(text: string | null | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const arr = value.filter((v): v is string => typeof v === "string" && v.length > 0);
  return arr.length > 0 ? arr : null;
}

export async function POST(request: Request) {
  let body: unknown = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = tickSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const { windowSec } = parsed.data;
  const now = new Date();

  const policies = await db.backupPolicy.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
  });

  let enqueuedTotal = 0;
  const policyResults: Array<Record<string, unknown>> = [];

  for (const policy of policies) {
    const due = cronDueWithin(policy.cronExpr, windowSec, now);
    if (!due) {
      policyResults.push({ id: policy.id, name: policy.name, cron: policy.cronExpr, due: false, enqueued: 0 });
      continue;
    }

    const scope = safeParseScope(policy.scopeJson);
    const siteCodes = stringArray(scope.siteCodes);
    const criticality = stringArray(scope.criticality);
    const excludeStatuses = stringArray(scope.excludeStatuses) ?? [];

    // Unreachable/unmanaged devices are never scheduled (see header note).
    const excluded = Array.from(new Set([...excludeStatuses, "UNMANAGED", "OFFLINE"]));

    const devices = await db.device.findMany({
      where: {
        status: { notIn: excluded },
        ...(criticality ? { criticality: { in: criticality } } : {}),
        ...(siteCodes && !siteCodes.includes("*")
          ? { site: { code: { in: siteCodes } } }
          : {}),
      },
      select: { id: true, hostname: true },
      orderBy: { hostname: "asc" },
    });

    const policyTag = `"policyId":"${policy.id}"`;

    // Dedupe (a): devices with an in-flight CONFIG_BACKUP job of any kind.
    const activeJobs = await db.jobExecution.findMany({
      where: {
        type: "CONFIG_BACKUP",
        status: { in: ["QUEUED", "RUNNING"] },
      },
      select: { targetId: true },
    });
    const activeDevices = new Set(activeJobs.map((j) => j.targetId));

    // Dedupe (b): policy-tagged jobs created within the dedupe window
    // (any status) — protects against re-enqueue after fast completion.
    const since = new Date(now.getTime() - DEDUPE_WINDOW_MIN * 60_000);
    const recentJobs = await db.jobExecution.findMany({
      where: {
        type: "CONFIG_BACKUP",
        createdAt: { gte: since },
        payloadJson: { contains: policyTag },
      },
      select: { targetId: true },
    });
    const recentDevices = new Set(recentJobs.map((j) => j.targetId));

    const targets = devices
      .filter((d) => !activeDevices.has(d.id) && !recentDevices.has(d.id))
      .slice(0, PER_POLICY_CAP);

    let count = 0;
    if (targets.length > 0) {
      const res = await db.jobExecution.createMany({
        data: targets.map((d) => ({
          type: "CONFIG_BACKUP",
          targetType: "DEVICE",
          targetId: d.id,
          status: "QUEUED",
          progress: 0,
          priority: 5,
          maxAttempts: 3,
          payloadJson: JSON.stringify({
            deviceId: d.id,
            policyId: policy.id,
            policyName: policy.name,
            source: "SCHEDULED",
          }),
          correlationId: newJobCorrelationId(),
        })),
      });
      count = res.count;
    }

    enqueuedTotal += count;
    policyResults.push({
      id: policy.id,
      name: policy.name,
      cron: policy.cronExpr,
      due: true,
      candidates: devices.length,
      enqueued: count,
    });
  }

  // Reaper: RUNNING CONFIG_BACKUP/DISCOVERY jobs whose startedAt is older
  // than 10 minutes were orphaned (server crash, worker restart mid-flight —
  // the in-memory runner state is gone) and would otherwise stay RUNNING
  // forever. Fail them so the Job Center shows the truth; retries happen
  // through normal re-enqueue (manual backup-now or the next scheduler tick).
  const STALE_RUNNING_MS = 10 * 60_000;
  const reaped = await db.jobExecution.updateMany({
    where: {
      type: { in: ["CONFIG_BACKUP", "DISCOVERY"] },
      status: "RUNNING",
      startedAt: { lt: new Date(now.getTime() - STALE_RUNNING_MS) },
    },
    data: {
      status: "FAILED",
      progress: 0,
      error: "Orphaned: no worker heartbeat for over 10 minutes (reaped by scheduler tick)",
      finishedAt: now,
    },
  });

  return ok({
    enqueued: enqueuedTotal,
    reapedOrphans: reaped.count,
    evaluatedAt: now.toISOString(),
    policies: policyResults,
  });
}
