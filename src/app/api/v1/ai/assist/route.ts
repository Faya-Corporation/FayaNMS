import { db } from "@/lib/db";
import {
  fail,
  firstIssueMessage,
  newCorrelationId,
  ok,
} from "../../_lib/api";
import { resolveActingUser } from "../../_lib/actor";
import { buildDeviceContext, buildIncidentContext } from "@/lib/ai/context";
import { buildAssistMessages, type AiLocale } from "@/lib/ai/prompts";
import { AiUnavailableError, aiChat } from "@/lib/ai/zai-client";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/ai/assist — AI troubleshooting assistant (Phase 12-a).
 *
 * Body (Zod-validated):
 *   { scope: "device" | "incident", id, question (1..500 chars),
 *     locale: "en"|"ar" }  — actor is the session principal (P19 SEC-001)
 *
 * The operational context is assembled server-side from FayaNMS records
 * (device → record/last alerts/audit trail/open incidents/interface summary;
 * incident → record/full timeline/linked alerts/devices). No secrets or
 * credential material ever enters the prompt. The answer is streamed back as
 * markdown text the UI renders directly.
 *
 * Every query writes a lean AI_ASSIST_QUERY audit row (correlationId AI-XXXXXXX)
 * carrying ONLY metadata — scope, question (truncated to 200 chars) and
 * lengths — never the full prompt or answer.
 *
 * Errors: 400 INVALID_BODY · 404 DEVICE_NOT_FOUND/INCIDENT_NOT_FOUND ·
 * 503 AI_UNAVAILABLE (actionable message, after timeout+retry exhausted).
 */

const bodySchema = z.object({
  scope: z.enum(["device", "incident"]),
  id: z.string().trim().min(1, "id is required").max(64),
  question: z
    .string()
    .trim()
    .min(1, "question is required")
    .max(500, "question must be 500 characters or fewer"),
  locale: z.enum(["en", "ar"]).default("en"),
});

const QUESTION_AUDIT_MAX = 200;

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
  const { scope, id, question, locale } = parsed.data;

  // R52-F-N1 (Full End-to-End Production ReAudit 2026-09-18): resolve the
  // actor BEFORE any DB work. A principal that passes the proxy but fails
  // requireUser (deactivated user with a live JWT, or an opaque-bearer API
  // client admitted on the mutation plane) must get 401 here — never a
  // 404-vs-401 existence oracle or pre-auth context-build work. Mirrors ai/query.
  const actor = await resolveActingUser(request);
  if (!actor) {
    return fail("UNAUTHENTICATED", "Sign in required — no valid session was provided.", 401);
  }

  // ── Assemble the operational context (server-side, secret-free) ──────
  let contextText: string;
  let contextSummary: {
    alertsConsidered: number;
    eventsConsidered: number;
    incidentsConsidered: number;
  };
  try {
    const context =
      scope === "device"
        ? await buildDeviceContext(id)
        : await buildIncidentContext(id);
    if (!context) {
      return fail(
        scope === "device" ? "DEVICE_NOT_FOUND" : "INCIDENT_NOT_FOUND",
        scope === "device"
          ? "The requested device does not exist"
          : "The requested incident does not exist",
        404
      );
    }
    contextText = context.text;
    contextSummary = context.summary;
  } catch (error) {
    console.error("[ai/assist] context build failed", error);
    return fail("CONTEXT_FAILED", "The operational context could not be loaded", 500);
  }

  const correlationId = newCorrelationId("AI");
  const scopeLabel = scope === "device" ? "device" : "incident";

  // ── LLM round-trip (timeout guard + one retry inside aiChat) ─────────
  let answer: string;
  try {
    answer = await aiChat(
      buildAssistMessages({ locale: locale as AiLocale, contextText, question, scopeLabel })
    );
  } catch (error) {
    const unavailable = error instanceof AiUnavailableError;
    console.error("[ai/assist] completion failed", error);
    // Audit the failed attempt too — same lean metadata discipline.
    try {
      await db.auditEvent.create({
        data: {
          actorId: actor?.id ?? null,
          actorName: actor?.name ?? "Admin",
          action: "AI_ASSIST_QUERY",
          resourceType: scope === "device" ? "Device" : "Incident",
          resourceId: id,
          result: "FAILURE",
          correlationId,
          afterJson: JSON.stringify({
            scope,
            locale,
            question: question.slice(0, QUESTION_AUDIT_MAX),
            questionLength: question.length,
            answerLength: null,
            error: unavailable ? "AI_UNAVAILABLE" : "AI_FAILED",
          }),
        },
      });
    } catch (auditError) {
      console.error("[ai/assist] failure audit write failed", auditError);
    }
    return fail(
      "AI_UNAVAILABLE",
      unavailable && error.message
        ? `The AI assistant is temporarily unavailable — ${error.message} Please try again in a moment.`
        : "The AI assistant is temporarily unavailable. Please try again in a moment.",
      503
    );
  }

  // ── Lean audit row (metadata only — never the full prompt/answer) ────
  try {
    await db.auditEvent.create({
      data: {
        actorId: actor?.id ?? null,
        actorName: actor?.name ?? "Admin",
        action: "AI_ASSIST_QUERY",
        resourceType: scope === "device" ? "Device" : "Incident",
        resourceId: id,
        result: "SUCCESS",
        correlationId,
        afterJson: JSON.stringify({
          scope,
          locale,
          question: question.slice(0, QUESTION_AUDIT_MAX),
          questionLength: question.length,
          answerLength: answer.length,
        }),
      },
    });
  } catch (error) {
    // The answer is already valid — an audit hiccup must not eat it.
    console.error("[ai/assist] success audit write failed", error);
  }

  return ok(
    {
      answer,
      correlationId,
      contextSummary,
    },
    { correlationId },
    200
  );
}
