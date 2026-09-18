import { db } from "@/lib/db";
import {
  fail,
  failWithDetail,
  firstIssueMessage,
  newCorrelationId,
  ok,
} from "../../_lib/api";
import { resolveActingUser } from "../../_lib/actor";
import {
  buildQueryAnswerMessages,
  buildQueryPlanMessages,
  type AiLocale,
} from "@/lib/ai/prompts";
import {
  AiBadResponseError,
  AiUnavailableError,
  aiChat,
} from "@/lib/ai/zai-client";
import { INCIDENT_OPEN_STATUSES } from "@/lib/incidents/lifecycle";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/ai/query — "Ask the network": natural-language query over the
 * whole NMS (Phase 14-a). READ-ONLY — the executed plan never writes.
 *
 * Body (Zod-validated): { prompt (10..500 chars), locale: "en"|"ar" }
 *
 * TWO-STAGE LLM pipeline:
 *   STAGE 1 — plan: the model classifies the question into STRICT JSON
 *     { intent: "inventory"|"incidents"|"changes"|"jobs"|"predictive"|"summary",
 *       site?, vendor?, severity?, status?, hostnameLike?, limit? }
 *     parsed defensively (fence stripping, first-{..last-} slice, try/catch →
 *     AiBadResponseError) and Zod-validated with per-field .catch defaults so
 *     a malformed field degrades to its default instead of failing (intent
 *     falls back to "summary"). Stage-1 failures answer 503 AI_UNAVAILABLE /
 *     502 AI_BAD_RESPONSE (mirroring the 13-a change-draft envelope).
 *
 *   STAGE 2 (server, deterministic) — the plan is EXECUTED against Prisma
 *     with bounded, whitelisted queries: site/vendor/status values are
 *     grounded against the real vocabulary (unknown → dropped), limits are
 *     clamped to ≤20 rows, and every query is read-only.
 *
 *   STAGE 3 — answer: buildQueryAnswerMessages embeds the plan and the
 *     JSON-serialized rows and asks for a concise locale-aware answer that
 *     references ONLY the returned rows. If stage 3 fails, the request still
 *     succeeds with fallback=true and a deterministic locale-aware bullet
 *     summary built from the same rows — stage-3 problems never fail the
 *     whole request.
 *
 * Audit: NL_QUERY_ANSWERED with an AI-XXXXXXX correlationId; the afterJson
 * stays lean (intent, filters, result counts, sources, fallback, latencyMs) —
 * never the prompt or the answer text. FAILURE rows land on stage-1 AI errors.
 */

const bodySchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(10, "prompt must be at least 10 characters")
    .max(500, "prompt is limited to 500 characters"),
  locale: z.enum(["en", "ar"]).default("en"),
});

const RAW_DETAIL_MAX = 4000;
/** Row ceiling for every result group (mirrors the UI contract). */
const MAX_ROWS = 20;
/** Predictive intent — approximate alert-pressure ranking depth. */
const PREDICTIVE_TOP = 3;
/** Summary intent — recent changes shown in the snapshot. */
const SUMMARY_RECENT_CHANGES = 5;

const planSchema = z.object({
  intent: z
    .enum(["inventory", "incidents", "changes", "jobs", "predictive", "summary"])
    .catch("summary"),
  site: z.string().trim().max(32).nullable().catch(null),
  vendor: z.string().trim().max(32).nullable().catch(null),
  severity: z.string().trim().max(16).nullable().catch(null),
  status: z.string().trim().max(32).nullable().catch(null),
  hostnameLike: z.string().trim().max(64).nullable().catch(null),
  limit: z.coerce.number().int().min(1).max(20).nullable().catch(null),
});

export type AiQueryPlan = z.infer<typeof planSchema>;

/** Serializable row shapes the UI renders directly (dates are ISO strings). */
interface QueryDeviceRow {
  id: string;
  hostname: string;
  model: string | null;
  firmware: string | null;
  status: string;
  criticality: string;
  backupCompliance: string;
  siteCode: string | null;
  siteName: string | null;
  vendorKey: string | null;
}

interface QueryIncidentRow {
  id: string;
  number: string;
  title: string;
  severity: string;
  status: string;
  siteCode: string | null;
  createdAt: string;
  slaDueAt: string | null;
  linkedChangeNumber: string | null;
}

interface QueryChangeRow {
  id: string;
  number: string;
  title: string;
  type: string;
  status: string;
  riskLevel: string;
  siteCode: string | null;
  scheduledStart: string | null;
  createdAt: string;
}

interface QueryJobRow {
  correlationId: string;
  type: string;
  status: string;
  progress: number;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
}

interface QueryPredictiveRow {
  hostname: string;
  status: string;
  criticality: string;
  siteCode: string | null;
  activeAlerts: number;
  worstSeverity: string | null;
}

interface QuerySnapshot {
  devicesByStatus: Record<string, number>;
  openIncidentsBySeverity: Record<string, number>;
  recentChanges: { number: string; title: string; status: string }[];
  backupJobs24h: { total: number; succeeded: number; successRatePct: number | null };
}

interface QueryResults {
  devices?: QueryDeviceRow[];
  incidents?: QueryIncidentRow[];
  changes?: QueryChangeRow[];
  jobs?: QueryJobRow[];
  predictive?: QueryPredictiveRow[];
  snapshot?: QuerySnapshot;
}

interface AppliedFilters {
  site: string | null;
  vendor: string | null;
  severity: string | null;
  status: string | null;
  hostnameLike: string | null;
  limit: number | null;
}

/**
 * Strip markdown fences and any prose around the JSON object, then parse.
 * Throws AiBadResponseError when no usable object can be extracted.
 */
function parsePlanJson(raw: string): unknown {
  let text = raw.trim();
  // ```json … ``` / ``` … ``` fences
  const fenced = text.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
  if (fenced) text = fenced[1].trim();
  // Fallback: slice from the first "{" to the last "}".
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new AiBadResponseError(
      raw,
      "The AI response did not contain a JSON object."
    );
  }
  const candidate = text.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    throw new AiBadResponseError(
      raw,
      "The AI response could not be parsed as JSON."
    );
  }
}

/** Map loose alert/health severity wording onto the incident SEV scale. */
function normalizeIncidentSeverity(value: string | null): string | null {
  if (!value) return null;
  const upper = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const sev = upper.match(/^SEV([1-4])$/);
  if (sev) return `SEV${sev[1]}`;
  const aliases: Record<string, string> = {
    CRITICAL: "SEV1",
    HIGH: "SEV2",
    MEDIUM: "SEV3",
    MODERATE: "SEV3",
    LOW: "SEV4",
    INFO: "SEV4",
  };
  return aliases[upper] ?? null;
}

/** Device statuses accepted for the inventory plan filter. */
const DEVICE_STATUS_VALUES = new Set([
  "ONLINE",
  "OFFLINE",
  "DEGRADED",
  "MAINTENANCE",
  "UNKNOWN",
  "UNMANAGED",
]);

/** Change lifecycle statuses accepted for the changes plan filter. */
const CHANGE_STATUS_VALUES = new Set([
  "DRAFT",
  "PLANNING",
  "TECHNICAL_REVIEW",
  "AWAITING_APPROVAL",
  "APPROVED",
  "SCHEDULED",
  "PRE_CHECK",
  "EXECUTING",
  "VALIDATING",
  "SUCCESSFUL",
  "POST_REVIEW",
  "CLOSED",
  "FAILED",
  "ROLLBACK",
  "ROLLBACK_FAILED",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
  "PARTIAL_SUCCESS",
]);

/** Job statuses accepted for the jobs plan filter. */
const JOB_STATUS_VALUES = new Set([
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "DEAD",
  "CANCELLED",
]);

/** Normalize a loose status word onto a known lifecycle value or null. */
function normalizeStatus(
  value: string | null,
  allowed: Set<string>
): string | null {
  if (!value) return null;
  const upper = value.toUpperCase().replace(/[^A-Z_]/g, "");
  if (allowed.has(upper)) return upper;
  const aliases: Record<string, string> = {
    SUCCESS: "SUCCESSFUL",
    SUCCEEDED: "SUCCESSFUL",
    FAILURE: "FAILED",
    FAIL: "FAILED",
    ROLLEDBACK: "ROLLBACK",
    PENDING: "AWAITING_APPROVAL",
    PENDINGAPPROVAL: "AWAITING_APPROVAL",
    AWAITING: "AWAITING_APPROVAL",
    APPROVAL: "AWAITING_APPROVAL",
    OPEN: "QUEUED",
    COMPLETE: "CLOSED",
    COMPLETED: "CLOSED",
    DOWN: "OFFLINE",
    UP: "ONLINE",
  };
  const mapped = aliases[upper];
  return mapped && allowed.has(mapped) ? mapped : null;
}

/** Severity weights for the approximate predictive ranking (matches v1). */
const ALERT_SEVERITY_WEIGHT: Record<string, number> = {
  CRITICAL: 10,
  HIGH: 6,
  MEDIUM: 3,
  LOW: 1,
  INFO: 0,
};

/* ───────────────────────── deterministic executors ─────────────────────── */

async function executeInventory(
  filters: AppliedFilters
): Promise<{ results: QueryResults; sources: string[] }> {
  const where = {
    AND: [
      filters.site ? { site: { code: filters.site } } : {},
      filters.vendor ? { vendor: { key: filters.vendor } } : {},
      filters.hostnameLike
        ? {
            OR: [
              { hostname: { contains: filters.hostnameLike } },
              { displayName: { contains: filters.hostnameLike } },
            ],
          }
        : {},
      filters.status ? { status: filters.status } : {},
    ],
  };
  const rows = await db.device.findMany({
    where,
    orderBy: { hostname: "asc" },
    take: Math.min(filters.limit ?? 10, MAX_ROWS),
    select: {
      id: true,
      hostname: true,
      model: true,
      firmware: true,
      status: true,
      criticality: true,
      backupCompliance: true,
      site: { select: { code: true, name: true } },
      vendor: { select: { key: true } },
    },
  });
  return {
    results: {
      devices: rows.map((row) => ({
        id: row.id,
        hostname: row.hostname,
        model: row.model,
        firmware: row.firmware,
        status: row.status,
        criticality: row.criticality,
        backupCompliance: row.backupCompliance,
        siteCode: row.site?.code ?? null,
        siteName: row.site?.name ?? null,
        vendorKey: row.vendor?.key ?? null,
      })),
    },
    sources: ["devices"],
  };
}

async function executeIncidents(
  filters: AppliedFilters
): Promise<{ results: QueryResults; sources: string[] }> {
  const where = {
    AND: [
      { status: { in: [...INCIDENT_OPEN_STATUSES] } },
      filters.severity ? { severity: filters.severity } : {},
      filters.site ? { site: { code: filters.site } } : {},
    ],
  };
  const rows = await db.incident.findMany({
    where,
    // SEV1 first — lexicographic order matches the SEV scale (see 5-b).
    orderBy: [{ severity: "asc" }, { createdAt: "desc" }],
    take: Math.min(filters.limit ?? 10, MAX_ROWS),
    select: {
      id: true,
      number: true,
      title: true,
      severity: true,
      status: true,
      site: { select: { code: true } },
      createdAt: true,
      slaDueAt: true,
      change: { select: { number: true } },
    },
  });
  return {
    results: {
      incidents: rows.map((row) => ({
        id: row.id,
        number: row.number,
        title: row.title,
        severity: row.severity,
        status: row.status,
        siteCode: row.site?.code ?? null,
        createdAt: row.createdAt.toISOString(),
        slaDueAt: row.slaDueAt?.toISOString() ?? null,
        linkedChangeNumber: row.change?.number ?? null,
      })),
    },
    sources: ["incidents"],
  };
}

async function executeChanges(
  filters: AppliedFilters
): Promise<{ results: QueryResults; sources: string[] }> {
  const where = {
    AND: [
      filters.status ? { status: filters.status } : {},
      filters.site ? { site: { code: filters.site } } : {},
    ],
  };
  const rows = await db.changeRequest.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: Math.min(filters.limit ?? 10, MAX_ROWS),
    select: {
      id: true,
      number: true,
      title: true,
      type: true,
      status: true,
      riskLevel: true,
      site: { select: { code: true } },
      scheduledStart: true,
      createdAt: true,
    },
  });
  return {
    results: {
      changes: rows.map((row) => ({
        id: row.id,
        number: row.number,
        title: row.title,
        type: row.type,
        status: row.status,
        riskLevel: row.riskLevel,
        siteCode: row.site?.code ?? null,
        scheduledStart: row.scheduledStart?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
    },
    sources: ["changes"],
  };
}

async function executeJobs(
  filters: AppliedFilters
): Promise<{ results: QueryResults; sources: string[] }> {
  const rows = await db.jobExecution.findMany({
    where: filters.status ? { status: filters.status } : undefined,
    orderBy: { createdAt: "desc" },
    take: Math.min(filters.limit ?? 10, MAX_ROWS),
    select: {
      correlationId: true,
      type: true,
      status: true,
      progress: true,
      createdAt: true,
      finishedAt: true,
      error: true,
    },
  });
  return {
    results: {
      jobs: rows.map((row) => ({
        correlationId: row.correlationId,
        type: row.type,
        status: row.status,
        progress: row.progress,
        createdAt: row.createdAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null,
        error: row.error ? row.error.slice(0, 160) : null,
      })),
    },
    sources: ["jobs"],
  };
}

/**
 * Approximate predictive ranking (the 12-c route exposes no exported pure
 * functions, so per the 14-a contract this is a simple bounded alert-pressure
 * proxy: active-alert severity weights per device, worst first). The rows are
 * labeled approximate in the LLM prompt and the UI copy stays honest.
 */
async function executePredictive(
  filters: AppliedFilters
): Promise<{ results: QueryResults; sources: string[] }> {
  const alerts = await db.alert.findMany({
    where: { status: "ACTIVE" },
    select: { deviceId: true, severity: true },
    take: 500,
  });
  const devices = await db.device.findMany({
    where: {
      AND: [
        { status: { not: "UNMANAGED" } },
        filters.site ? { site: { code: filters.site } } : {},
        filters.vendor ? { vendor: { key: filters.vendor } } : {},
        filters.hostnameLike
          ? { hostname: { contains: filters.hostnameLike } }
          : {},
      ],
    },
    orderBy: { hostname: "asc" },
    select: {
      id: true,
      hostname: true,
      status: true,
      criticality: true,
      site: { select: { code: true } },
    },
  });

  const pressure = new Map<
    string,
    { count: number; weight: number; worst: string }
  >();
  const severityRank = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];
  for (const alert of alerts) {
    const entry = pressure.get(alert.deviceId) ?? {
      count: 0,
      weight: 0,
      worst: "INFO",
    };
    entry.count += 1;
    entry.weight += ALERT_SEVERITY_WEIGHT[alert.severity] ?? 0;
    if (
      severityRank.indexOf(alert.severity) < severityRank.indexOf(entry.worst)
    ) {
      entry.worst = alert.severity;
    }
    pressure.set(alert.deviceId, entry);
  }

  const rows: QueryPredictiveRow[] = devices
    .map((device) => {
      const entry = pressure.get(device.id);
      return {
        hostname: device.hostname,
        status: device.status,
        criticality: device.criticality,
        siteCode: device.site?.code ?? null,
        activeAlerts: entry?.count ?? 0,
        worstSeverity: entry?.worst ?? null,
        weight: entry?.weight ?? 0,
      };
    })
    .filter((row) => row.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.hostname.localeCompare(b.hostname))
    .slice(0, Math.min(filters.limit ?? PREDICTIVE_TOP, PREDICTIVE_TOP))
    .map(({ weight: _weight, ...row }) => row);

  return { results: { predictive: rows }, sources: ["predictive"] };
}

/** Compact cross-domain snapshot (read-only, bounded). */
async function executeSummary(): Promise<{
  results: QueryResults;
  sources: string[];
}> {
  const since24h = new Date(Date.now() - 24 * 3_600_000);
  const [deviceGroups, incidentGroups, recentChanges, backupTotal, backupOk] =
    await Promise.all([
      db.device.groupBy({ by: ["status"], _count: { _all: true } }),
      db.incident.groupBy({
        by: ["severity"],
        _count: { _all: true },
        where: { status: { in: [...INCIDENT_OPEN_STATUSES] } },
      }),
      db.changeRequest.findMany({
        orderBy: { createdAt: "desc" },
        take: SUMMARY_RECENT_CHANGES,
        select: { number: true, title: true, status: true },
      }),
      db.jobExecution.count({
        where: { type: "CONFIG_BACKUP", createdAt: { gte: since24h } },
      }),
      db.jobExecution.count({
        where: {
          type: "CONFIG_BACKUP",
          createdAt: { gte: since24h },
          status: "SUCCEEDED",
        },
      }),
    ]);

  const devicesByStatus: Record<string, number> = {};
  for (const group of deviceGroups) {
    devicesByStatus[group.status] = group._count._all;
  }
  const openIncidentsBySeverity: Record<string, number> = {};
  for (const group of incidentGroups) {
    openIncidentsBySeverity[group.severity] = group._count._all;
  }

  return {
    results: {
      snapshot: {
        devicesByStatus,
        openIncidentsBySeverity,
        recentChanges,
        backupJobs24h: {
          total: backupTotal,
          succeeded: backupOk,
          successRatePct:
            backupTotal > 0
              ? Math.round((backupOk / backupTotal) * 100)
              : null,
        },
      },
    },
    sources: ["devices", "incidents", "changes", "jobs"],
  };
}

/** Locale-aware deterministic bullet summary (stage-3 fallback). */
function buildFallbackSummary(results: QueryResults, locale: AiLocale): string {
  const lines: string[] = [];
  if (results.devices?.length) {
    lines.push(locale === "ar" ? "الأجهزة المطابقة:" : "Matching devices:");
    for (const row of results.devices.slice(0, 5)) {
      lines.push(
        `- ${row.hostname} — ${row.model ?? "?"} · ${row.status} · ${row.siteCode ?? "-"}`
      );
    }
  }
  if (results.incidents?.length) {
    lines.push(locale === "ar" ? "الحوادث المفتوحة:" : "Open incidents:");
    for (const row of results.incidents.slice(0, 5)) {
      lines.push(
        `- ${row.number} — ${row.title} · ${row.severity} · ${row.status}`
      );
    }
  }
  if (results.changes?.length) {
    lines.push(locale === "ar" ? "التغييرات:" : "Changes:");
    for (const row of results.changes.slice(0, 5)) {
      lines.push(`- ${row.number} — ${row.title} · ${row.status}`);
    }
  }
  if (results.jobs?.length) {
    lines.push(locale === "ar" ? "المهام الأخيرة:" : "Recent jobs:");
    for (const row of results.jobs.slice(0, 5)) {
      lines.push(`- ${row.type} · ${row.status} · ${row.correlationId}`);
    }
  }
  if (results.predictive?.length) {
    lines.push(
      locale === "ar"
        ? "أعلى الأجهزة ضغطاً بالتنبيهات (تقريبي):"
        : "Highest alert pressure (approximate):"
    );
    for (const row of results.predictive.slice(0, 5)) {
      lines.push(
        `- ${row.hostname} — ${row.activeAlerts} active alerts${row.worstSeverity ? ` (${row.worstSeverity})` : ""}`
      );
    }
  }
  const snapshot = results.snapshot;
  if (snapshot) {
    const statusText = Object.entries(snapshot.devicesByStatus)
      .map(([status, count]) => `${count} ${status}`)
      .join(" / ");
    const sevText = Object.entries(snapshot.openIncidentsBySeverity)
      .map(([sev, count]) => `${sev} ${count}`)
      .join(" / ");
    const backup = snapshot.backupJobs24h;
    if (locale === "ar") {
      lines.push(`الأجهزة حسب الحالة: ${statusText || "لا يوجد"}`);
      lines.push(`الحوادث المفتوحة: ${sevText || "لا شيء"}`);
      lines.push(
        backup.total > 0
          ? `نسخ احتياطية 24 ساعة: ${backup.succeeded}/${backup.total} نجحت (${backup.successRatePct ?? 0}%)`
          : "نسخ احتياطية 24 ساعة: لا توجد مهام"
      );
    } else {
      lines.push(`Devices by status: ${statusText || "none"}`);
      lines.push(`Open incidents: ${sevText || "none"}`);
      lines.push(
        backup.total > 0
          ? `Backup jobs (24h): ${backup.succeeded}/${backup.total} succeeded (${backup.successRatePct ?? 0}%)`
          : "Backup jobs (24h): none"
      );
    }
  }
  if (lines.length === 0) {
    return locale === "ar"
      ? "لم يتم العثور على سجلات مطابقة لاستفسارك."
      : "No matching records were found for your question.";
  }
  return lines.join("\n");
}

export async function POST(request: Request) {
  const startedAt = Date.now();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const { prompt, locale } = parsed.data;

  const correlationId = newCorrelationId("AI");
  const actor = await resolveActingUser(request);
  if (!actor) {
    return fail("UNAUTHENTICATED", "Sign in required — no valid session was provided.", 401);
  }

  /* ── Grounding vocabulary (labels only) ─────────────────────────────── */
  const [sites, vendors] = await Promise.all([
    db.site.findMany({
      select: { code: true, name: true },
      orderBy: { code: "asc" },
    }),
    db.vendor.findMany({
      select: { key: true, name: true },
      orderBy: { key: "asc" },
    }),
  ]);
  const siteCodes = new Set(sites.map((site) => site.code));
  const vendorKeys = new Set(vendors.map((vendor) => vendor.key));

  /* ── STAGE 1: plan (fail the request on AI errors — mirror 13-a) ────── */
  let rawPlan: string;
  try {
    rawPlan = await aiChat(
      buildQueryPlanMessages({
        locale: locale as AiLocale,
        prompt,
        vocab: { siteCodes: sites, vendorKeys: vendors },
      })
    );
  } catch (error) {
    const unavailable = error instanceof AiUnavailableError;
    console.error("[ai/query] plan completion failed", error);
    try {
      await db.auditEvent.create({
        data: {
          actorId: actor?.id ?? null,
          actorName: actor?.name ?? "Admin",
          action: "NL_QUERY_ANSWERED",
          resourceType: "AiQuery",
          resourceId: null,
          resourceLabel: "AI network query",
          result: "FAILURE",
          correlationId,
          afterJson: JSON.stringify({
            locale,
            stage: "plan",
            error: unavailable ? "AI_UNAVAILABLE" : "AI_FAILED",
          }),
        },
      });
    } catch (auditError) {
      console.error("[ai/query] failure audit write failed", auditError);
    }
    return fail(
      "AI_UNAVAILABLE",
      unavailable && error.message
        ? `The AI service is temporarily unavailable — ${error.message} Please try again in a moment.`
        : "The AI service is temporarily unavailable. Please try again in a moment.",
      503
    );
  }

  let plan: AiQueryPlan;
  try {
    const parsedPlan = planSchema.safeParse(parsePlanJson(rawPlan));
    if (!parsedPlan.success) {
      throw new AiBadResponseError(
        rawPlan,
        "The AI query plan did not match the expected schema."
      );
    }
    plan = parsedPlan.data;
  } catch (error) {
    if (!(error instanceof AiBadResponseError)) {
      console.error("[ai/query] unexpected plan parse failure", error);
      return fail("AI_FAILED", "The AI query could not be planned", 500);
    }
    console.error("[ai/query] bad LLM plan response");
    try {
      await db.auditEvent.create({
        data: {
          actorId: actor?.id ?? null,
          actorName: actor?.name ?? "Admin",
          action: "NL_QUERY_ANSWERED",
          resourceType: "AiQuery",
          resourceId: null,
          resourceLabel: "AI network query",
          result: "FAILURE",
          correlationId,
          afterJson: JSON.stringify({
            locale,
            stage: "plan",
            error: "AI_BAD_RESPONSE",
            rawLength: error.raw.length,
          }),
        },
      });
    } catch (auditError) {
      console.error("[ai/query] failure audit write failed", auditError);
    }
    return failWithDetail(
      "AI_BAD_RESPONSE",
      "The AI returned a response that could not be parsed as a valid query plan. Please retry.",
      502,
      { raw: error.raw.slice(0, RAW_DETAIL_MAX) }
    );
  }

  /* ── STAGE 2: deterministic, bounded, READ-ONLY execution ───────────── */
  // Ground the reference values: anything outside the real vocabulary is
  // dropped (never passed into the where clauses).
  const appliedFilters: AppliedFilters = {
    site: plan.site && siteCodes.has(plan.site) ? plan.site : null,
    vendor: plan.vendor && vendorKeys.has(plan.vendor) ? plan.vendor : null,
    severity: normalizeIncidentSeverity(plan.severity),
    status: null,
    hostnameLike: plan.hostnameLike || null,
    limit: plan.limit ?? null,
  };

  let results: QueryResults;
  let sources: string[];
  try {
    switch (plan.intent) {
      case "inventory": {
        appliedFilters.status = normalizeStatus(
          plan.status,
          DEVICE_STATUS_VALUES
        );
        ({ results, sources } = await executeInventory(appliedFilters));
        break;
      }
      case "incidents": {
        ({ results, sources } = await executeIncidents(appliedFilters));
        break;
      }
      case "changes": {
        appliedFilters.status = normalizeStatus(
          plan.status,
          CHANGE_STATUS_VALUES
        );
        ({ results, sources } = await executeChanges(appliedFilters));
        break;
      }
      case "jobs": {
        appliedFilters.status = normalizeStatus(plan.status, JOB_STATUS_VALUES);
        ({ results, sources } = await executeJobs(appliedFilters));
        break;
      }
      case "predictive": {
        ({ results, sources } = await executePredictive(appliedFilters));
        break;
      }
      default: {
        appliedFilters.site = null;
        appliedFilters.vendor = null;
        appliedFilters.severity = null;
        appliedFilters.status = null;
        appliedFilters.hostnameLike = null;
        appliedFilters.limit = null;
        ({ results, sources } = await executeSummary());
      }
    }
  } catch (error) {
    console.error("[ai/query] plan execution failed", error);
    return fail(
      "QUERY_EXECUTION_FAILED",
      "The query could not be executed against the network data",
      500
    );
  }

  /* ── STAGE 3: grounded answer (never fails the request) ─────────────── */
  const planJson = JSON.stringify({
    intent: plan.intent,
    site: appliedFilters.site,
    vendor: appliedFilters.vendor,
    severity: appliedFilters.severity,
    status: appliedFilters.status,
    hostnameLike: appliedFilters.hostnameLike,
    limit: appliedFilters.limit,
  });
  const resultsJson = JSON.stringify(results);

  let summary: string;
  let fallback = false;
  try {
    const rawAnswer = await aiChat(
      buildQueryAnswerMessages({
        locale: locale as AiLocale,
        prompt,
        planJson,
        resultsJson,
      })
    );
    summary = rawAnswer.trim();
  } catch (error) {
    // Stage-3 failures degrade to the deterministic summary — by design the
    // request still succeeds (fallback=true) and never 5xx because of it.
    console.error("[ai/query] answer completion failed — using fallback", error);
    summary = buildFallbackSummary(results, locale as AiLocale);
    fallback = true;
  }

  /* ── Lean audit row (no prompt, no answer text) ─────────────────────── */
  const resultCounts: Record<string, number> = {};
  if (results.devices) resultCounts.devices = results.devices.length;
  if (results.incidents) resultCounts.incidents = results.incidents.length;
  if (results.changes) resultCounts.changes = results.changes.length;
  if (results.jobs) resultCounts.jobs = results.jobs.length;
  if (results.predictive) resultCounts.predictive = results.predictive.length;
  if (results.snapshot) resultCounts.snapshot = 1;

  try {
    await db.auditEvent.create({
      data: {
        actorId: actor?.id ?? null,
        actorName: actor?.name ?? "Admin",
        action: "NL_QUERY_ANSWERED",
        resourceType: "AiQuery",
        resourceId: null,
        resourceLabel: "AI network query",
        result: "SUCCESS",
        correlationId,
        afterJson: JSON.stringify({
          locale,
          promptLength: prompt.length,
          intent: plan.intent,
          filters: appliedFilters,
          resultCounts,
          sources,
          fallback,
          latencyMs: Date.now() - startedAt,
        }),
      },
    });
  } catch (error) {
    console.error("[ai/query] success audit write failed", error);
  }

  return ok(
    {
      intent: plan.intent,
      appliedFilters,
      summary,
      results,
      sources,
      fallback,
      correlationId,
    },
    { correlationId },
    200
  );
}
