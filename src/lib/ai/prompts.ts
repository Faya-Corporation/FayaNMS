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
 * Natural-language change draft (Phase 13-a) — the model must return STRICT JSON:
 * { title, description, changeType, riskHint, deviceHostnames[],
 *   implementationPlan[], validationPlan[], rollbackPlan[], suggestedWindowHint }.
 *
 * The DEVICES block is assembled server-side from the real FayaNMS inventory so
 * the draft can only reference hostnames that actually exist.
 */
export function buildChangeDraftMessages(input: {
  locale: AiLocale;
  deviceListText: string;
  deviceCount: number;
  request: string;
}): AiChatMessage[] {
  const system = [
    SHARED_GUARDRAILS,
    [
      "You convert plain-language operator requests into structured change-request drafts for the FayaNMS change wizard.",
      "Return a STRICT JSON object with EXACTLY these keys and no others:",
      '{"title": string, "description": string, "changeType": "STANDARD"|"NORMAL"|"EMERGENCY", "riskHint": "low"|"medium"|"high"|"critical", "deviceHostnames": string[], "implementationPlan": string[], "validationPlan": string[], "rollbackPlan": string[], "suggestedWindowHint": string|null}',
      '- "title": concise, operationally specific summary — at most 120 characters.',
      '- "description": 2–4 sentences covering why the change is needed and its expected impact.',
      '- "changeType": "STANDARD" (pre-approved, routine, low risk) | "NORMAL" (planned change with full review) | "EMERGENCY" (urgent fix).',
      '- "riskHint": overall execution risk: "low" | "medium" | "high" | "critical".',
      '- "deviceHostnames": hostnames copied VERBATIM from the DEVICES list below — never invent, shorten or guess hostnames; use [] when none apply.',
      '- "implementationPlan": 3–8 concrete ordered steps, one action per item (numbered prose lives in the wizard, keep items short).',
      '- "validationPlan": 2–5 checks that prove the change worked.',
      '- "rollbackPlan": 2–4 steps that restore the previous state.',
      '- "suggestedWindowHint": a short maintenance-window suggestion (max 140 characters, e.g. "Saturday 02:00–04:00 local") or null when the request implies no timing.',
      'Base the draft ONLY on the operator request and the DEVICES list — never invent sites, IPs, software versions or credentials.',
      'Return JSON ONLY — no markdown fences, no prose before or after the JSON object.',
    ].join("\n"),
    localeInstruction(input.locale),
  ].join("\n\n");

  const user = [
    `DEVICES (FayaNMS inventory, ${input.deviceCount} devices — reference hostnames exactly as listed):`,
    "<<<DEVICES",
    input.deviceListText,
    "DEVICES>>>",
    "",
    `OPERATOR REQUEST: ${input.request}`,
    "",
    `Draft the change-request JSON. Answer locale: ${input.locale === "ar" ? "ar (Arabic)" : "en (English)"}.`,
  ].join("\n");

  return [
    { role: "assistant", content: system },
    { role: "user", content: user },
  ];
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Natural-language network query ("Ask the network", Phase 14-a).
 *
 * Two LLM stages:
 *   1. buildQueryPlanMessages   — classify the question into a STRICT-JSON
 *      query plan {intent, site, vendor, severity, status, hostnameLike, limit}.
 *      The server (not the model) executes the plan against the database.
 *   2. buildQueryAnswerMessages — a grounded answer written ONLY from the
 *      JSON-serialized rows the server returned for the plan.
 */

export type QueryIntent =
  | "inventory"
  | "incidents"
  | "changes"
  | "jobs"
  | "predictive"
  | "summary";

/** Site codes / vendor keys the plan may reference (grounded server-side). */
export interface QueryPlanVocab {
  siteCodes: { code: string; name: string }[];
  vendorKeys: { key: string; name: string }[];
}

/**
 * Stage 1 — the model must return STRICT JSON:
 * { intent, site, vendor, severity, status, hostnameLike, limit }.
 * Every reference field must be copied verbatim from the vocabulary lists or
 * be null; the server re-validates them anyway.
 */
export function buildQueryPlanMessages(input: {
  locale: AiLocale;
  prompt: string;
  vocab: QueryPlanVocab;
}): AiChatMessage[] {
  const system = [
    [
      "You classify a network operator's question into a structured query plan for FayaNMS,",
      "a network monitoring platform. You do NOT answer the question — you only classify it.",
    ].join(" "),
    [
      "Return a STRICT JSON object with EXACTLY these keys and no others:",
      '{"intent": "inventory"|"incidents"|"changes"|"jobs"|"predictive"|"summary", "site": string|null, "vendor": string|null, "severity": string|null, "status": string|null, "hostnameLike": string|null, "limit": number|null}',
      '- "intent": what the question is really about:',
      '  "inventory" — which devices exist, models, firmware, locations, "which switches/routers…";',
      '  "incidents" — open incidents, outages, SEV levels, alert escalations;',
      '  "changes" — change requests and how they went (successful, failed, rolled back…);',
      '  "jobs" — backup/discovery/other job executions and their outcomes;',
      '  "predictive" — which devices look risky, degraded, or carry high alert pressure;',
      '  "summary" — broad fleet-overview questions ("how is the network doing?") or anything ambiguous.',
      '- "site": a site code copied VERBATIM from the SITES list below, or null.',
      '- "vendor": a vendor key copied VERBATIM from the VENDORS list below, or null.',
      '- "severity": "SEV1"|"SEV2"|"SEV3"|"SEV4" for incident wording, or "CRITICAL"|"HIGH"|"MEDIUM"|"LOW"|"INFO" for health/alert wording; null otherwise.',
      '- "status": an UPPERCASE lifecycle state the question names explicitly (e.g. "FAILED", "OFFLINE", "SUCCEEDED"); null when the question does not name one.',
      '- "hostnameLike": a hostname fragment the question implies (e.g. "CORE", "FW", "HQ"); null when none.',
      '- "limit": how many rows would satisfy the question (1–20); null for a sensible default.',
      "Never invent site codes or vendor keys — use null whenever unsure.",
      "Return JSON ONLY — no markdown fences, no prose before or after the JSON object.",
    ].join("\n"),
  ].join("\n\n");

  const siteList = input.vocab.siteCodes
    .map((site) => `${site.code} (${site.name})`)
    .join(", ");
  const vendorList = input.vocab.vendorKeys
    .map((vendor) => `${vendor.key} (${vendor.name})`)
    .join(", ");

  const user = [
    `SITES (code — name): ${siteList}`,
    `VENDORS (key — name): ${vendorList}`,
    "",
    `OPERATOR QUESTION: ${input.prompt}`,
    "",
    "Classify the question into the query-plan JSON.",
  ].join("\n");

  return [
    { role: "assistant", content: system },
    { role: "user", content: user },
  ];
}

/**
 * Stage 2 — grounded answer. The model receives the plan and the
 * JSON-serialized query results and must answer ONLY from those rows.
 */
export function buildQueryAnswerMessages(input: {
  locale: AiLocale;
  prompt: string;
  planJson: string;
  resultsJson: string;
}): AiChatMessage[] {
  const system = [
    SHARED_GUARDRAILS,
    [
      "You answer an operator's question about the FayaNMS network using ONLY the QUERY RESULTS",
      "provided below — every fact you state must come from those rows; never invent devices,",
      "models, numbers, statuses, severities or timestamps that are not in them.",
      "Answer in 2–6 concise sentences, optionally followed by a short bullet list (max 5 items)",
      "when individual rows deserve enumeration. Cite concrete evidence (hostnames, sites,",
      "severities, statuses, counts).",
      "Do not mention the query plan, JSON, or that structured data was given to you — answer",
      "naturally, as a network operations engineer briefing a colleague.",
      "If the results are empty or insufficient for the question, say so plainly and suggest",
      "what the operator could check or ask instead.",
    ].join(" "),
    localeInstruction(input.locale),
  ].join("\n\n");

  const user = [
    `OPERATOR QUESTION: ${input.prompt}`,
    "",
    "QUERY PLAN (how the question was classified — for your reference only):",
    input.planJson,
    "",
    "QUERY RESULTS (the ONLY allowed source of facts):",
    "<<<RESULTS",
    input.resultsJson,
    "RESULTS>>>",
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
