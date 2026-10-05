import { db } from "@/lib/db";
import {
  fail,
  failWithDetail,
  failWithMeta,
  firstIssueMessage,
  newCorrelationId,
  ok,
} from "../../_lib/api";
import { consumeAiDailyQuota } from "@/lib/api/ai-quota";
import { resolveActingUser } from "../../_lib/actor";
import { sessionScopeFor } from "@/lib/auth/session";
import { scopedDeviceWhere, type SessionScopeClaims } from "@/lib/auth/scope";
import { buildChangeDraftMessages, type AiLocale } from "@/lib/ai/prompts";
import {
  AiBadResponseError,
  AiUnavailableError,
  aiChat,
} from "@/lib/ai/zai-client";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/ai/change-draft — natural-language → change-request draft (Phase 13-a).
 *
 * Body (Zod-validated): { prompt (10..600 chars), locale: "en"|"ar" } — actor is the session principal (P19 SEC-001)
 *
 * The server first loads the REAL device inventory (hostname, model, vendor
 * key, site, role, criticality) and embeds it in the LLM prompt, so the draft
 * can only reference devices that actually exist. The model must answer with
 * STRICT JSON:
 *   { title, description, changeType: "STANDARD"|"NORMAL"|"EMERGENCY",
 *     riskHint: "low"|"medium"|"high"|"critical", deviceHostnames[],
 *     implementationPlan[], validationPlan[], rollbackPlan[],
 *     suggestedWindowHint: string|null }
 * and the answer is parsed defensively:
 *   - markdown fences are stripped when the model adds them anyway;
 *   - JSON.parse runs inside try/catch — failure answers 502 AI_BAD_RESPONSE
 *     with the raw text (truncated) in an error.detail field;
 *   - the parsed object is Zod-validated with per-field defaults so missing
 *     or malformed fields degrade gracefully instead of failing;
 *   - deviceHostnames are matched case-insensitively against the inventory —
 *     unknown hostnames are dropped (never invented into ids) and the
 *     matched rows are returned as matchedDevices with their server ids.
 *
 * F-031 (wave 9, audit 9-b F-1): the inventory snapshot is composed through
 * scopedDeviceWhere — a sites-limited session's prompt only ever contains
 * in-scope devices, and an out-of-scope hostname referenced by the draft
 * grounds exactly like an unknown hostname (dropped — no match/no-match
 * existence leak beyond what the wildcard path already shows). The load is
 * also bounded by INVENTORY_PROMPT_CAP (see the constant's justification).
 * The grounding matcher is exported as a pure function for behavioral pins.
 *
 * The draft is ONLY a suggestion for the change wizard — this endpoint never
 * writes a Change row; the user reviews and submits through the wizard.
 * Audit row NL_CHANGE_DRAFT_GENERATED stays lean: lengths/counts/hints only,
 * never the prompt or the draft text.
 */

const bodySchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(10, "prompt must be at least 10 characters")
    .max(600, "prompt is limited to 600 characters"),
  locale: z.enum(["en", "ar"]).default("en"),
});

const RAW_DETAIL_MAX = 4000;
/** Wizard contract caps a change at 20 devices. */
const MAX_MATCHED_DEVICES = 20;
/**
 * Inventory rows embedded in the LLM prompt (wave-9 take cap). Each row is
 * one ~80-char line, so 200 rows ≈ 16 KB of prompt — comfortably inside the
 * model budget while the wizard itself caps a change at 20 devices
 * (MAX_MATCHED_DEVICES). hostname-asc ordering makes any truncation
 * deterministic, and the bound keeps a pathological fleet from degrading
 * (or pricing out) every draft request. Typical fleets sit far below this.
 */
const INVENTORY_PROMPT_CAP = 200;

/** Coerce "string | string[]" into a clean string array (LLMs do both). */
const stringList = z
  .union([z.string(), z.array(z.unknown())])
  .transform((value) =>
    (Array.isArray(value) ? value : [value])
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0)
  )
  .default([]);

const draftSchema = z.object({
  title: z.coerce
    .string()
    .trim()
    .catch("")
    .transform((value) => value.slice(0, 200)),
  description: z.coerce.string().trim().catch(""),
  changeType: z.enum(["STANDARD", "NORMAL", "EMERGENCY"]).catch("NORMAL"),
  riskHint: z.enum(["low", "medium", "high", "critical"]).catch("medium"),
  implementationPlan: stringList,
  validationPlan: stringList,
  rollbackPlan: stringList,
  /** Grounded against the real inventory below — never trusted for ids. */
  deviceHostnames: stringList,
  suggestedWindowHint: z
    .union([z.coerce.string().trim(), z.null()])
    .catch(null)
    .transform((value) => (value ? value.slice(0, 140) : null)),
});

export type AiChangeDraft = z.infer<typeof draftSchema>;

/** Device matched by the server from the draft's hostname references. */
export interface AiMatchedDeviceRow {
  id: string;
  hostname: string;
  model: string | null;
  role: string | null;
  criticality: string;
  siteCode: string | null;
  vendorKey: string | null;
}

/** Minimal inventory-row shape the grounding matcher consumes. */
export interface AiInventoryDeviceRow {
  id: string;
  hostname: string;
  model: string | null;
  role: string | null;
  criticality: string;
  vendor: { key: string } | null;
  site: { name: string; code: string } | null;
}

/**
 * Strip markdown fences and any prose around the JSON object, then parse.
 * Throws AiBadResponseError when no usable object can be extracted.
 */
function parseDraft(raw: string): unknown {
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

/** One-line inventory row for the LLM prompt (terse label: value style). */
function deviceLine(row: {
  hostname: string;
  model: string | null;
  role: string | null;
  criticality: string;
  vendorKey: string | null;
  siteName: string | null;
}): string {
  return [
    `- ${row.hostname}`,
    row.model ? `model ${row.model}` : "model n/a",
    row.vendorKey ? `vendor ${row.vendorKey}` : "vendor n/a",
    row.role ? `role ${row.role}` : null,
    `criticality ${row.criticality}`,
    row.siteName ? `site ${row.siteName}` : "site unassigned",
  ]
    .filter((part): part is string => part !== null)
    .join(" | ");
}

export async function POST(request: Request) {

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

  // R52-F-N1 (Full End-to-End Production ReAudit 2026-09-18): actor BEFORE DB
  // work — no pre-auth context-build or 404-vs-401 existence oracle.
  const actor = await resolveActingUser(request);
  if (!actor) {
    return fail("UNAUTHENTICATED", "Sign in required — no valid session was provided.", 401);
  }

  // F-031 (wave 9): the session's site scope bounds the grounding inventory
  // (wildcard sessions — absent claims — keep byte-identical behavior).
  const scopeClaims = await sessionScopeFor(request);

  // ── Real inventory snapshot for grounding (labels only — no secrets) ──
  const devices = await loadChangeDraftInventory(scopeClaims);

  const correlationId = newCorrelationId("AI");

  const deviceListText = devices
    .map((device) =>
      deviceLine({
        hostname: device.hostname,
        model: device.model,
        role: device.role,
        criticality: device.criticality,
        vendorKey: device.vendor?.key ?? null,
        siteName: device.site?.name ?? null,
      })
    )
    .join("\n");

  // F-030 (batch-11): durable per-user daily AI quota — consumed here,
  // immediately before the LLM round-trip (the proxy's 10/min ai burst
  // budget is IP-keyed and cannot see the user identity).
  const quota = await consumeAiDailyQuota(actor.id);
  if (!quota.ok) {
    if (quota.code === "AI_DAILY_QUOTA_EXCEEDED") {
      return failWithMeta(
        "AI_DAILY_QUOTA_EXCEEDED",
        `Daily AI quota exhausted (${quota.limit}/day, UTC). The counter resets at 00:00 UTC.`,
        429,
        { used: quota.used, limit: quota.limit, day: quota.day }
      );
    }
    return fail(
      "AI_QUOTA_STORE_UNAVAILABLE",
      "The AI quota store is temporarily unavailable; the request is refused (fail-closed).",
      503
    );
  }

  // ── LLM round-trip (timeout guard + one retry inside aiChat) ─────────
  let raw: string;
  try {
    raw = await aiChat(
      buildChangeDraftMessages({
        locale: locale as AiLocale,
        deviceListText,
        deviceCount: devices.length,
        request: prompt,
      })
    );
  } catch (error) {
    const unavailable = error instanceof AiUnavailableError;
    console.error("[ai/change-draft] completion failed", error);
    try {
      await db.auditEvent.create({
        data: {
          actorId: actor?.id ?? null,
          actorName: actor?.name ?? "Admin",
          action: "NL_CHANGE_DRAFT_GENERATED",
          resourceType: "Change",
          resourceId: null,
          resourceLabel: "AI change draft",
          result: "FAILURE",
          correlationId,
          afterJson: JSON.stringify({
            locale,
            error: unavailable ? "AI_UNAVAILABLE" : "AI_FAILED",
          }),
        },
      });
    } catch (auditError) {
      console.error("[ai/change-draft] failure audit write failed", auditError);
    }
    return fail(
      "AI_UNAVAILABLE",
      unavailable && error.message
        ? `The AI service is temporarily unavailable — ${error.message} Please try again in a moment.`
        : "The AI service is temporarily unavailable. Please try again in a moment.",
      503
    );
  }

  // ── Defensive parse + Zod validation with defaults ───────────────────
  let draft: AiChangeDraft;
  try {
    const parsedDraft = draftSchema.safeParse(parseDraft(raw));
    if (!parsedDraft.success) {
      throw new AiBadResponseError(
        raw,
        "The AI draft did not match the expected schema."
      );
    }
    draft = parsedDraft.data;
  } catch (error) {
    if (!(error instanceof AiBadResponseError)) {
      console.error("[ai/change-draft] unexpected parse failure", error);
      return fail("AI_FAILED", "The AI draft could not be generated", 500);
    }
    console.error("[ai/change-draft] bad LLM response");
    try {
      await db.auditEvent.create({
        data: {
          actorId: actor?.id ?? null,
          actorName: actor?.name ?? "Admin",
          action: "NL_CHANGE_DRAFT_GENERATED",
          resourceType: "Change",
          resourceId: null,
          resourceLabel: "AI change draft",
          result: "FAILURE",
          correlationId,
          afterJson: JSON.stringify({
            locale,
            error: "AI_BAD_RESPONSE",
            rawLength: error.raw.length,
          }),
        },
      });
    } catch (auditError) {
      console.error("[ai/change-draft] failure audit write failed", auditError);
    }
    return failWithDetail(
      "AI_BAD_RESPONSE",
      "The AI returned a response that could not be parsed as a valid change draft. Please retry.",
      502,
      { raw: error.raw.slice(0, RAW_DETAIL_MAX) }
    );
  }

  // ── Ground the hostnames in the real (scope-filtered) inventory ─────
  // The matcher drops unknown AND out-of-scope hostnames identically —
  // device ids are only ever resolved server-side.
  const { matchedDevices, droppedHostnames } = groundDeviceHostnames(
    devices,
    draft.deviceHostnames ?? []
  );

  // ── Lean audit row (lengths/counts/hints only — never prompt or draft) ─
  try {
    await db.auditEvent.create({
      data: {
        actorId: actor?.id ?? null,
        actorName: actor?.name ?? "Admin",
        action: "NL_CHANGE_DRAFT_GENERATED",
        resourceType: "Change",
        resourceId: null,
        resourceLabel: "AI change draft",
        result: "SUCCESS",
        correlationId,
        afterJson: JSON.stringify({
          locale,
          promptLength: prompt.length,
          titleLength: draft.title.length,
          descriptionLength: draft.description.length,
          changeType: draft.changeType,
          riskHint: draft.riskHint,
          referencedHostnames: (draft.deviceHostnames ?? []).length,
          matchedDeviceCount: matchedDevices.length,
          droppedHostnames,
          implementationSteps: draft.implementationPlan.length,
          validationChecks: draft.validationPlan.length,
          rollbackSteps: draft.rollbackPlan.length,
          hasWindowHint: draft.suggestedWindowHint !== null,
        }),
      },
    });
  } catch (error) {
    console.error("[ai/change-draft] success audit write failed", error);
  }

  return ok(
    {
      draft: {
        title: draft.title,
        description: draft.description,
        changeType: draft.changeType,
        riskHint: draft.riskHint,
        implementationPlan: draft.implementationPlan,
        validationPlan: draft.validationPlan,
        rollbackPlan: draft.rollbackPlan,
        suggestedWindowHint: draft.suggestedWindowHint,
      },
      matchedDevices,
      correlationId,
    },
    { correlationId },
    200
  );
}

/**
 * The REAL device inventory the draft is grounded against (labels only — no
 * secrets). F-031 (wave 9): composed through scopedDeviceWhere so a
 * sites-limited session's prompt and grounding vocabulary contain ONLY
 * in-scope devices; wildcard sessions (absent claims) get the base load
 * unchanged, byte-identical to pre-wave-9. Bounded by INVENTORY_PROMPT_CAP.
 * Exported for behavioral scoping pins (tests/audit/ai-scope-hardening.test.ts).
 */
export async function loadChangeDraftInventory(
  scopeClaims?: SessionScopeClaims | null
): Promise<AiInventoryDeviceRow[]> {
  return db.device.findMany({
    where: scopedDeviceWhere(scopeClaims, {}),
    orderBy: { hostname: "asc" },
    take: INVENTORY_PROMPT_CAP,
    select: {
      id: true,
      hostname: true,
      model: true,
      role: true,
      criticality: true,
      vendor: { select: { key: true } },
      site: { select: { name: true, code: true } },
    },
  });
}

/**
 * Ground the draft's hostname references in the (already scope-filtered)
 * inventory — case-insensitive match (LLMs drift on casing); unknown
 * hostnames are dropped and device ids are only ever resolved server-side.
 * Because the inventory is scope-filtered by loadChangeDraftInventory, an
 * OUT-OF-SCOPE hostname falls into the same dropped bucket as an unknown
 * one — no match/no-match existence leak beyond what the wildcard path
 * already shows. Extracted verbatim from the POST body (wave 9) so the
 * grounding is behaviorally pinnable; the semantics are unchanged.
 */
export function groundDeviceHostnames(
  devices: readonly AiInventoryDeviceRow[],
  rawHostnames: readonly string[]
): { matchedDevices: AiMatchedDeviceRow[]; droppedHostnames: number } {
  const byHostname = new Map<string, AiInventoryDeviceRow>();
  for (const device of devices) {
    byHostname.set(device.hostname.toLowerCase(), device);
  }
  const seen = new Set<string>();
  const matchedDevices: AiMatchedDeviceRow[] = [];
  let droppedHostnames = 0;
  for (const rawHostname of rawHostnames) {
    const device = byHostname.get(String(rawHostname).trim().toLowerCase());
    if (!device) {
      droppedHostnames += 1;
      continue;
    }
    if (seen.has(device.id)) continue;
    seen.add(device.id);
    if (matchedDevices.length < MAX_MATCHED_DEVICES) {
      matchedDevices.push({
        id: device.id,
        hostname: device.hostname,
        model: device.model,
        role: device.role,
        criticality: device.criticality,
        siteCode: device.site?.code ?? null,
        vendorKey: device.vendor?.key ?? null,
      });
    }
  }
  return { matchedDevices, droppedHostnames };
}
