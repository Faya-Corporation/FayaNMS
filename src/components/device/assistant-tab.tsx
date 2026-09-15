"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Bot, Loader2, Send, Sparkles } from "lucide-react";

import { aiErrorKey, useAiAssist } from "@/hooks/api/use-ai";
import { useCurrentLocale } from "@/i18n/locale-provider";
import { ErrorState } from "@/components/domain/error-state";
import { SectionCard } from "@/components/domain/section-card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, type AiAssistResult } from "@/lib/api-client";
import { cn } from "@/lib/utils";

/**
 * Device-detail "Assistant" tab (Phase 12-a): ask an operations question
 * about this device and get an LLM answer grounded in the FayaNMS context
 * the server assembles (record, alerts, audit trail, open incidents,
 * interfaces/metrics). Locale-aware; the answer renders as lightweight
 * markdown (headings + lists + inline bold/code) with zero extra deps.
 */

/** Max question length — mirrored by the API contract (500). */
const QUESTION_MAX = 500;

/* ------------------------------------------------------------------ */
/* Tiny markdown-ish renderer (headings, lists, bold, inline code)     */
/* ------------------------------------------------------------------ */

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  // Split on **bold** and `code` tokens while keeping the delimiters.
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code
          key={key}
          className="rounded bg-muted px-1 py-0.5 font-tech text-[0.85em] ltr-technical"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={key}>{part}</span>;
  });
}

function MarkdownishAnswer({ text }: { text: string }) {
  const blocks = useMemo(() => {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    type Block =
      | { type: "heading"; level: number; content: string }
      | { type: "ul"; items: string[] }
      | { type: "ol"; items: string[] }
      | { type: "p"; content: string };
    const blocks: Block[] = [];
    let list: { type: "ul" | "ol"; items: string[] } | null = null;

    const flush = () => {
      if (list) {
        blocks.push(list);
        list = null;
      }
    };

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line.trim()) {
        flush();
        continue;
      }
      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        flush();
        blocks.push({
          type: "heading",
          level: heading[1].length,
          // Strip bold markers and any trailing "###" the model adds.
          content: heading[2].replace(/\*\*/g, "").replace(/\s*#+\s*$/, ""),
        });
        continue;
      }
      const ul = line.match(/^\s*[-*•]\s+(.*)$/);
      if (ul) {
        if (!list || list.type !== "ul") {
          flush();
          list = { type: "ul", items: [] };
        }
        list.items.push(ul[1]);
        continue;
      }
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ol) {
        if (!list || list.type !== "ol") {
          flush();
          list = { type: "ol", items: [] };
        }
        list.items.push(ol[1]);
        continue;
      }
      flush();
      blocks.push({ type: "p", content: line.trim() });
    }
    flush();
    return blocks;
  }, [text]);

  return (
    <div className="flex flex-col gap-2 text-sm leading-relaxed">
      {blocks.map((block, index) => {
        const key = `md-${index}`;
        switch (block.type) {
          case "heading":
            return (
              <p
                key={key}
                className={cn(
                  "font-semibold text-foreground",
                  block.level <= 2 ? "mt-1 text-base" : "mt-1 text-sm"
                )}
              >
                {renderInline(block.content, key)}
              </p>
            );
          case "ul":
            return (
              <ul key={key} className="ms-5 flex list-disc flex-col gap-1">
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`} className="ps-1">
                    {renderInline(item, `${key}-${itemIndex}`)}
                  </li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={key} className="ms-5 flex list-decimal flex-col gap-1">
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`} className="ps-1">
                    {renderInline(item, `${key}-${itemIndex}`)}
                  </li>
                ))}
              </ol>
            );
          default:
            return (
              <p key={key} className="whitespace-pre-wrap break-words">
                {renderInline(block.content, key)}
              </p>
            );
        }
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Assistant tab                                                       */
/* ------------------------------------------------------------------ */

const SUGGESTION_KEYS = ["cpu", "hardware", "check", "alerts"] as const;

export function AssistantTab({ deviceId }: { deviceId: string }) {
  const t = useTranslations("ai.assistant");
  const tAi = useTranslations("ai");
  const locale = useCurrentLocale();

  const [question, setQuestion] = useState("");
  const [lastQuestion, setLastQuestion] = useState<string | null>(null);
  const assist = useAiAssist("device", deviceId);

  const answer: AiAssistResult | undefined = assist.data;
  const error = assist.error;

  const ask = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed || assist.isPending) return;
    setLastQuestion(trimmed);
    assist.mutate({
      scope: "device",
      id: deviceId,
      question: trimmed,
      locale,
    });
  };

  const submit = () => ask(question);
  const retry = () => {
    if (lastQuestion) ask(lastQuestion);
  };

  const errorReason = (() => {
    if (!error) return undefined;
    const key = aiErrorKey(error instanceof ApiError ? error.code : "");
    return key ? tAi(key) : error.message;
  })();

  return (
    <div className="flex min-w-0 flex-col gap-4 pt-2">
      {/* Ask */}
      <SectionCard
        title={t("title")}
        description={t("intro")}
        contentClassName="p-4 flex flex-col gap-3"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            {t("suggestionsLabel")}
          </span>
          {SUGGESTION_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              disabled={assist.isPending}
              onClick={() => {
                const suggestion = t(`suggest_${key}`);
                setQuestion(suggestion);
                ask(suggestion);
              }}
              className="inline-flex items-center gap-1 rounded-full border bg-background px-3 py-1.5 text-xs transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
            >
              <Sparkles aria-hidden="true" className="size-3 text-muted-foreground" />
              {t(`suggest_${key}`)}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-2">
          <label className="sr-only" htmlFor="ai-assistant-question">
            {t("questionLabel")}
          </label>
          <Textarea
            id="ai-assistant-question"
            value={question}
            onChange={(event) => setQuestion(event.target.value.slice(0, QUESTION_MAX))}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder={t("placeholder")}
            rows={3}
            maxLength={QUESTION_MAX}
            className="min-h-20 resize-y"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-tech text-xs text-muted-foreground ltr-technical">
              {question.length}/{QUESTION_MAX}
            </span>
            <div className="flex items-center gap-2">
              {assist.isPending && (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
                  {t("sending")}
                </span>
              )}
              <Button disabled={assist.isPending || question.trim().length === 0} onClick={submit} size="sm">
                {assist.isPending ? (
                  <Loader2 aria-hidden="true" className="animate-spin" />
                ) : (
                  <Send aria-hidden="true" />
                )}
                {t("send")}
              </Button>
            </div>
          </div>
        </div>
      </SectionCard>

      {/* Error (with retry) */}
      {assist.isError && error && (
        <ErrorState
          className="py-8"
          onRetry={lastQuestion ? retry : undefined}
          reason={errorReason}
          title={t("errorTitle")}
        />
      )}

      {/* Answer */}
      {answer && !assist.isError && (
        <SectionCard contentClassName="p-4 flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <Bot aria-hidden="true" className="size-4 text-primary" />
              {t("answerTitle")}
            </span>
            <span className="text-xs text-muted-foreground">
              {t("contextBasis", {
                alerts: answer.contextSummary.alertsConsidered,
                events: answer.contextSummary.eventsConsidered,
                incidents: answer.contextSummary.incidentsConsidered,
              })}
            </span>
          </div>
          <div
            aria-live="polite"
            tabIndex={0} className="max-h-96 overflow-y-auto rounded-lg border bg-surface-subtle p-4"
          >
            <MarkdownishAnswer text={answer.answer} />
          </div>
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Sparkles aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
            {t("disclaimer")}
          </p>
        </SectionCard>
      )}
    </div>
  );
}
