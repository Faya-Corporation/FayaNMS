import { db } from "@/lib/db";
import {
  fail,
  failWithDetail,
  firstIssueMessage,
  newCorrelationId,
  ok,
  requestContext,
} from "../../_lib/api";
import { resolveActingUser } from "../../_lib/actor";
import { buildIncidentContext } from "@/lib/ai/context";
import { buildRcaDraftMessages, type AiLocale } from "@/lib/ai/prompts";
import {
  AiBadResponseError,
  AiUnavailableError,
  aiChat,
} from "@/lib/ai/zai-client";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/ai/rca-draft — LLM-drafted post-incident review (Phase 12-a).
 *
 * Body (Zod-validated): { incidentId, locale: "en"|"ar", actAsUserId? }
 *
 * Loads the incident + full timeline + linked alerts/devices, asks the model
 * for a STRICT JSON draft:
 *   { summary, rootCause, contributingFactors[], remediation[], prevention[],
 *     confidence: "low"|"medium"|"high" }
 * and parses it defensively:
 *   - markdown fences are stripped when the model adds them anyway;
 *   - JSON.parse runs inside try/catch — failure answers 502 AI_BAD_RESPONSE
 *     with the raw text (truncated) in an error.detail field;
 *   - the parsed object is Zod-validated with per-field defaults so missing
 *     or malformed fields degrade gracefully instead of failing.
 *
 * The draft is ONLY a suggestion for the PIR form — this endpoint never
 * writes to the Incident record; the user still saves through the existing
 * save-pir flow. Audit row AI_RCA_DRAFT_GENERATED stays lean: field lengths
 * and confidence only, never the draft text.
 */

const bodySchema = z.object({
  incidentId: z.string().trim().min(1, "incidentId is required").max(64),
  locale: z.enum(["en", "ar"]).default("en"),
  actAsUserId: z.string().trim().max(64).optional(),
});

const RAW_DETAIL_MAX = 4000;

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
  summary: z.coerce.string().trim().catch(""),
  rootCause: z.coerce.string().trim().catch(""),
  contributingFactors: stringList,
  remediation: stringList,
  prevention: stringList,
  confidence: z.enum(["low", "medium", "high"]).catch("medium"),
});

export type RcaDraft = z.infer<typeof draftSchema>;

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

export async function POST(request: Request) {
  const ctx = requestContext(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400, ctx);
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400, ctx);
  }
  const { incidentId, locale, actAsUserId } = parsed.data;

  const incident = await db.incident.findUnique({
    where: { id: incidentId },
    select: { id: true, number: true, title: true },
  });
  if (!incident) {
    return fail("INCIDENT_NOT_FOUND", "Incident not found", 404, ctx);
  }

  const context = await buildIncidentContext(incidentId);
  if (!context) {
    return fail("INCIDENT_NOT_FOUND", "Incident not found", 404, ctx);
  }

  const correlationId = newCorrelationId("AI");
  const actor = await resolveActingUser(actAsUserId);

  // ── LLM round-trip (timeout guard + one retry inside aiChat) ─────────
  let raw: string;
  try {
    raw = await aiChat(
      buildRcaDraftMessages({ locale: locale as AiLocale, contextText: context.text })
    );
  } catch (error) {
    const unavailable = error instanceof AiUnavailableError;
    console.error("[ai/rca-draft] completion failed", error);
    try {
      await db.auditEvent.create({
        data: {
          actorId: actor?.id ?? null,
          actorName: actor?.name ?? "Admin",
          action: "AI_RCA_DRAFT_GENERATED",
          resourceType: "Incident",
          resourceId: incident.id,
          resourceLabel: `${incident.number} — ${incident.title.slice(0, 60)}`,
          result: "FAILURE",
          correlationId,
          afterJson: JSON.stringify({
            locale,
            error: unavailable ? "AI_UNAVAILABLE" : "AI_FAILED",
          }),
        },
      });
    } catch (auditError) {
      console.error("[ai/rca-draft] failure audit write failed", auditError);
    }
    return fail(
      "AI_UNAVAILABLE",
      unavailable && error.message
        ? `The AI service is temporarily unavailable — ${error.message} Please try again in a moment.`
        : "The AI service is temporarily unavailable. Please try again in a moment.",
      503,
      ctx
    );
  }

  // ── Defensive parse + Zod validation with defaults ───────────────────
  let draft: RcaDraft;
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
      console.error("[ai/rca-draft] unexpected parse failure", error);
      return fail("AI_FAILED", "The AI draft could not be generated", 500, ctx);
    }
    console.error("[ai/rca-draft] bad LLM response");
    try {
      await db.auditEvent.create({
        data: {
          actorId: actor?.id ?? null,
          actorName: actor?.name ?? "Admin",
          action: "AI_RCA_DRAFT_GENERATED",
          resourceType: "Incident",
          resourceId: incident.id,
          resourceLabel: `${incident.number} — ${incident.title.slice(0, 60)}`,
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
      console.error("[ai/rca-draft] failure audit write failed", auditError);
    }
    return failWithDetail(
      "AI_BAD_RESPONSE",
      "The AI returned a response that could not be parsed as a valid RCA draft. Please retry.",
      502,
      { raw: error.raw.slice(0, RAW_DETAIL_MAX) },
      ctx
    );
  }

  // ── Lean audit row (lengths/confidence only — never the draft text) ──
  try {
    await db.auditEvent.create({
      data: {
        actorId: actor?.id ?? null,
        actorName: actor?.name ?? "Admin",
        action: "AI_RCA_DRAFT_GENERATED",
        resourceType: "Incident",
        resourceId: incident.id,
        resourceLabel: `${incident.number} — ${incident.title.slice(0, 60)}`,
        result: "SUCCESS",
        correlationId,
        afterJson: JSON.stringify({
          locale,
          summaryLength: draft.summary.length,
          rootCauseLength: draft.rootCause.length,
          contributingFactorsCount: draft.contributingFactors.length,
          remediationCount: draft.remediation.length,
          preventionCount: draft.prevention.length,
          confidence: draft.confidence,
        }),
      },
    });
  } catch (error) {
    console.error("[ai/rca-draft] success audit write failed", error);
  }

  return ok({ draft, correlationId }, { correlationId }, 200, ctx);
}
