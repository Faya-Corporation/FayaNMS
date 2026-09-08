import type { AiChatMessage } from "./zai-client";

/**
 * Prompt assembly for the Phase 12-a AI endpoints.
 *
 * Ground rules baked into every system prompt:
 *   - Senior network-operations-engineer persona.
 *   - Diagnostic answers come ONLY from the provided context — no invented
 *     telemetry, devices, alerts or events.
 *   - Diagnosis follows the fixed four-section markdown structure.
 *   - The requested locale controls the answer language; Arabic answers use
 *     genuine network-ops terminology while technical tokens (hostnames,
 *     interface names, metrics, SEV levels, IPs) stay as-is.
 *   - Never touch or request credentials/secrets; read-only advisory.
 */

export type AiLocale = "en" | "ar";

function localeInstruction(locale: AiLocale): string {
  if (locale === "ar") {
    return [
      "Write the entire answer in ARABIC (Modern Standard Arabic) using professional",
      "network-operations terminology (e.g. التنبيهات، الحوادث، زمن الاستجابة، عرض النطاق الترددي،",
      "سجل التدقيق، التكوين، الجدار الناري). Keep technical tokens exactly as they appear in the",
      "context (hostnames, interface names, metric names, SEV levels, IPs, software versions).",
    ].join(" ");
  }
  return "Write the entire answer in English.";
}

const SHARED_GUARDRAILS = [
  "You are a senior network operations engineer working inside FayaNMS, a network monitoring platform.",
  "Answer STRICTLY from the operational context provided to you — never invent telemetry, alerts, devices, interfaces, timestamps or events that are not present in it.",
  "Never reveal, request or guess credentials, passwords, SNMP communities, tokens or any secret material; you are a read-only advisory assistant.",
  "Be concise, concrete and actionable; cite specific evidence (device names, interfaces, metric values, severities, timestamps) from the context.",
  "If the provided context is insufficient to answer confidently, say so explicitly and list exactly which additional data the operator should collect.",
].join(" ");

const ASSIST_STRUCTURE = [
  "When diagnosing a problem, structure the answer in markdown with exactly these four sections:",
  "### Likely cause",
  "### Evidence from context",
  "### Recommended next steps",
  "### Risk if ignored",
  "Each section should be 1–4 short bullets (or a single sentence when obvious).",
  "If the question is informational (not a diagnosis), answer directly in short markdown without forcing the four sections.",
].join(" ");

/**
 * Troubleshooting assistant — system + user messages.
 * The user message embeds the compact operational context and the question.
 */
export function buildAssistMessages(input: {
  locale: AiLocale;
  contextText: string;
  question: string;
  scopeLabel: string;
}): AiChatMessage[] {
  const system = [SHARED_GUARDRAILS, ASSIST_STRUCTURE, localeInstruction(input.locale)].join("\n\n");

  const user = [
    `OPERATIONAL CONTEXT (FayaNMS, scope: ${input.scopeLabel}, assembled ${new Date().toISOString()}):`,
    "<<<CONTEXT",
    input.contextText,
    "CONTEXT>>>",
    "",
    `OPERATOR QUESTION: ${input.question}`,
    "",
    `Answer locale: ${input.locale === "ar" ? "ar (Arabic)" : "en (English)"}.`,
  ].join("\n");

  return [
    { role: "assistant", content: system },
    { role: "user", content: user },
  ];
}

/**
 * RCA draft — the model must return STRICT JSON:
 * { summary, rootCause, contributingFactors[], remediation[], prevention[], confidence }.
 */
export function buildRcaDraftMessages(input: {
  locale: AiLocale;
  contextText: string;
}): AiChatMessage[] {
  const system = [
    SHARED_GUARDRAILS,
    [
      "You draft post-incident reviews (root cause analysis) from incident timelines.",
      "Return a STRICT JSON object with EXACTLY these keys and no others:",
      '{"summary": string, "rootCause": string, "contributingFactors": string[], "remediation": string[], "prevention": string[], "confidence": "low"|"medium"|"high"}',
      '- "summary": 2–3 plain-language sentences describing what happened and the impact.',
      '- "rootCause": the technical root cause, strictly as evidenced by the timeline and alerts.',
      '- "contributingFactors": conditions that made the incident possible or worse (0–5 items).',
      '- "remediation": corrective actions that fix the situation now (1–5 short actionable items).',
      '- "prevention": preventive actions that stop recurrence (1–5 short actionable items).',
      '- "confidence": how strongly the evidence supports the root cause: "low" | "medium" | "high".',
      'If the evidence is thin, still return the JSON with confidence "low" and state what is missing inside "rootCause".',
      'Return JSON ONLY — no markdown fences, no prose before or after the JSON object.',
    ].join("\n"),
    localeInstruction(input.locale),
  ].join("\n\n");

  const user = [
    "INCIDENT CONTEXT (FayaNMS, assembled " + new Date().toISOString() + "):",
    "<<<CONTEXT",
    input.contextText,
    "CONTEXT>>>",
    "",
    `Draft the post-incident review JSON. Answer locale: ${input.locale === "ar" ? "ar (Arabic)" : "en (English)"}.`,
  ].join("\n");

  return [
    { role: "assistant", content: system },
    { role: "user", content: user },
  ];
}
