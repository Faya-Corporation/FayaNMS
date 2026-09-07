"use client";

import { useEffect, useMemo, useState } from "react";
import { format, formatDistanceToNow } from "date-fns";
import {
  Activity,
  Bot,
  ChevronDown,
  ChevronUp,
  Copy,
  FileWarning,
  Link2,
  Search,
  ShieldCheck,
  Ticket,
  User,
  Users,
  Wrench,
  Zap,
} from "lucide-react";

import { useEvents, type EventListParams } from "@/hooks/api/use-events";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { KpiCard } from "@/components/domain/kpi-card";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { StatusDot } from "@/components/domain/status-dot";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { AuditEventRow } from "@/lib/api-client";
import type { StatusToken } from "@/lib/domain/status";

/**
 * Event stream (Task 5-c): the platform audit-event timeline (AuditEvent
 * table). Live-polled; filterable by actor, action family/prefix, entity
 * type, time range and correlation id. Rows expand to show the recorded
 * before/after JSON side-by-side.
 */

const ACTION_FAMILIES = [
  "CHANGE_",
  "CONFIG_",
  "ALERT_",
  "INCIDENT_",
  "MAINTENANCE_",
  "AUTH_",
] as const;

const TIME_RANGES = [
  { value: "1h", label: "Last hour", ms: 3600_000 },
  { value: "24h", label: "Last 24 hours", ms: 24 * 3600_000 },
  { value: "7d", label: "Last 7 days", ms: 7 * 24 * 3600_000 },
  { value: "30d", label: "Last 30 days", ms: 30 * 24 * 3600_000 },
  { value: "all", label: "All time", ms: null },
] as const;

type TimeRangeKey = (typeof TIME_RANGES)[number]["value"];

const FAMILY_TOKEN: Record<(typeof ACTION_FAMILIES)[number], StatusToken> = {
  CHANGE_: "warning",
  CONFIG_: "info",
  ALERT_: "danger-orange",
  INCIDENT_: "danger",
  MAINTENANCE_: "success",
  AUTH_: "neutral",
};

const TOKEN_BADGE: Record<StatusToken, string> = {
  success: "bg-success-subtle text-success border-success/25",
  warning: "bg-warning-subtle text-warning border-warning/25",
  danger: "bg-danger-subtle text-danger border-danger/25",
  "danger-orange": "bg-danger-orange-subtle text-danger-orange border-danger-orange/25",
  info: "bg-info-subtle text-info border-info/25",
  neutral: "bg-neutral-subtle text-neutral border-neutral/25",
};

function actionFamily(action: string): StatusToken {
  const family = ACTION_FAMILIES.find((prefix) => action.startsWith(prefix));
  return family ? FAMILY_TOKEN[family] : "neutral";
}

function isSystemActor(actorName: string): boolean {
  return actorName.startsWith("system:");
}

function ActorChip({ actorName }: { actorName: string }) {
  if (isSystemActor(actorName)) {
    return (
      <span
        className="inline-flex max-w-[20ch] shrink-0 items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-[11px] font-tech ltr-technical text-muted-foreground"
        title={actorName}
      >
        <Bot aria-hidden className="size-3 shrink-0" />
        <span className="truncate">{actorName.replace(/^system:/, "")}</span>
      </span>
    );
  }
  return (
    <span
      className="inline-flex max-w-[20ch] shrink-0 items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
      title={actorName}
    >
      <User aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{actorName}</span>
    </span>
  );
}

function JsonPane({
  label,
  value,
  onCopied,
}: {
  label: string;
  value: unknown;
  onCopied: (text: string, label: string) => void;
}) {
  const isEmpty = value === null || value === undefined;
  return (
    <div className="min-w-0 rounded-md border bg-surface-subtle">
      <div className="flex items-center justify-between gap-2 border-b px-2.5 py-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
        {!isEmpty && (
          <Button
            aria-label={`Copy ${label.toLowerCase()} JSON`}
            className="size-6"
            onClick={() => onCopied(JSON.stringify(value, null, 2), label)}
            size="icon"
            variant="ghost"
          >
            <Copy aria-hidden="true" className="size-3" />
          </Button>
        )}
      </div>
      {isEmpty ? (
        <p className="px-2.5 py-2 text-xs text-muted-foreground">Not recorded</p>
      ) : (
        <pre className="max-h-48 overflow-auto p-2.5 font-tech text-[11px] leading-relaxed ltr-technical">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}

function EventRow({
  event,
  expanded,
  onToggle,
  onCorrelationClick,
}: {
  event: AuditEventRow;
  expanded: boolean;
  onToggle: () => void;
  onCorrelationClick: (correlationId: string) => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const token = actionFamily(event.action);
  const hasPayload = event.beforeJson !== null || event.afterJson !== null;

  const copy = (text: string, label: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(label);
      window.setTimeout(() => setCopied(null), 1500);
    });
  };

  return (
    <li className="border-b last:border-0">
      <button
        aria-expanded={expanded}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 text-start transition-colors hover:bg-accent/40"
        onClick={onToggle}
        type="button"
      >
        <span className="w-[8.5rem] shrink-0 text-xs text-muted-foreground">
          <span className="block tabular-nums">{formatDistanceToNow(new Date(event.createdAt), { addSuffix: true })}</span>
          <span className="hidden font-tech text-[11px] ltr-technical sm:block">
            {format(new Date(event.createdAt), "MMM d, HH:mm:ss")}
          </span>
        </span>
        <span
          className={cn(
            "inline-flex max-w-[24ch] shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-tech ltr-technical",
            TOKEN_BADGE[token]
          )}
        >
          <span className="truncate">{event.action}</span>
        </span>
        <ActorChip actorName={event.actorName} />
        <span className="hidden min-w-0 max-w-[26ch] shrink-0 items-center gap-1 text-xs text-muted-foreground md:inline-flex">
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-tech text-[10px] ltr-technical">
            {event.resourceType}
          </span>
          {event.resourceLabel && (
            <span className="truncate" title={event.resourceLabel}>
              {event.resourceLabel}
            </span>
          )}
        </span>
        {event.result !== "SUCCESS" && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-danger/25 bg-danger-subtle px-2 py-0.5 text-[11px] font-medium text-danger">
            <FileWarning aria-hidden className="size-3" />
            {event.result}
          </span>
        )}
        {event.correlationId && (
          <span className="hidden shrink-0 items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-[11px] font-tech text-muted-foreground ltr-technical lg:inline-flex">
            <Link2 aria-hidden className="size-3" />
            {event.correlationId}
          </span>
        )}
        <span className="ms-auto flex shrink-0 items-center gap-1 text-muted-foreground">
          {hasPayload && (
            <span className="me-1 text-[11px]">{expanded ? "Hide" : "Detail"}</span>
          )}
          {expanded ? (
            <ChevronUp aria-hidden className="size-4" />
          ) : (
            <ChevronDown aria-hidden className="size-4" />
          )}
        </span>
      </button>

      {expanded && (
        <div className="flex flex-col gap-2 px-4 pb-4 md:px-[8.5rem]">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {event.correlationId && (
              <button
                className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-1 font-tech text-[11px] transition-colors hover:bg-accent ltr-technical"
                onClick={() => onCorrelationClick(event.correlationId as string)}
                title="Filter the stream by this correlation id"
                type="button"
              >
                <Link2 aria-hidden className="size-3" />
                correlationId: {event.correlationId}
              </button>
            )}
            {event.ip && (
              <span className="font-tech text-[11px] ltr-technical">ip: {event.ip}</span>
            )}
            {event.userAgent && (
              <span className="hidden max-w-[40ch] truncate font-tech text-[11px] ltr-technical xl:inline" title={event.userAgent}>
                ua: {event.userAgent}
              </span>
            )}
            {event.resourceId && (
              <span className="hidden font-tech text-[11px] ltr-technical xl:inline">
                resource: {event.resourceId}
              </span>
            )}
            {copied && (
              <span className="text-[11px] font-medium text-success">{copied} copied</span>
            )}
          </div>
          {hasPayload ? (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              <JsonPane label="Before" onCopied={copy} value={event.beforeJson} />
              <JsonPane label="After" onCopied={copy} value={event.afterJson} />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              No structured before/after payload was recorded for this event.
            </p>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Events view (ops.events) — audit-event timeline. Correlation-id chips
 * apply the correlation filter (the "click to filter" affordance).
 */
export function EventsView() {
  const [actor, setActor] = useState<string>("ALL");
  const [action, setAction] = useState<string>("ALL");
  const [entityType, setEntityType] = useState<string>("ALL");
  const [timeRange, setTimeRange] = useState<TimeRangeKey>("24h");
  const [correlationInput, setCorrelationInput] = useState("");
  const [correlationId, setCorrelationId] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => {
      setCorrelationId(correlationInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [correlationInput]);

  const range = TIME_RANGES.find((entry) => entry.value === timeRange) ?? TIME_RANGES[1];
  // The floor must be STABLE across renders — computing it inline would mint
  // a new query key every render and the live poll would never settle.
  const from = useMemo(
    () => (range.ms ? new Date(Date.now() - range.ms).toISOString() : undefined),
    [range.ms]
  );

  const params: EventListParams = useMemo(
    () => ({
      actor: actor === "ALL" ? undefined : actor,
      action: action === "ALL" ? undefined : action,
      entityType: entityType === "ALL" ? undefined : entityType,
      correlationId: correlationId || undefined,
      from,
      page,
      pageSize: 30,
    }),
    [actor, action, entityType, correlationId, from, page]
  );

  // Live poll (7 s) — the stream moves as the worker + users act.
  const events = useEvents(params, { refetchInterval: 7000 });

  const rows = events.data?.data ?? [];
  const listMeta = events.data?.meta;

  const facetActions = listMeta?.topActions ?? [];
  const extraActions = facetActions
    .map((facet) => facet.action)
    .filter((name) => !ACTION_FAMILIES.some((prefix) => name.startsWith(prefix)));

  const resetFilters = () => {
    setActor("ALL");
    setAction("ALL");
    setEntityType("ALL");
    setTimeRange("24h");
    setCorrelationInput("");
    setCorrelationId("");
    setPage(1);
  };

  const hasFilters =
    actor !== "ALL" ||
    action !== "ALL" ||
    entityType !== "ALL" ||
    timeRange !== "24h" ||
    correlationId !== "";

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        description="Platform audit-event timeline — every user action, engine decision and system job, newest first"
        title="Event Stream"
      />

      {/* KPI strip */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard
          description="Audit events recorded in the trailing 24 h"
          icon={Activity}
          label="Events · 24 h"
          loading={events.isLoading}
          status={{ label: "live · 7 s", token: "info", pulse: true }}
          value={listMeta?.last24h ?? "—"}
        />
        <KpiCard
          description="Distinct actors over the current filter"
          icon={Users}
          label="Distinct actors"
          loading={events.isLoading}
          value={listMeta?.distinctActors ?? "—"}
        />
        <KpiCard
          description={
            facetActions.length > 0
              ? `${facetActions[0].count} events — actions are grouped by family prefix`
              : "No action activity under the current filter"
          }
          icon={Zap}
          label="Top action"
          loading={events.isLoading}
          value={facetActions.length > 0 ? facetActions[0].action : "—"}
        />
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          onValueChange={(value) => {
            setActor(value);
            setPage(1);
          }}
          value={actor}
        >
          <SelectTrigger aria-label="Actor" className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-60">
            <SelectItem value="ALL">Any actor</SelectItem>
            {(listMeta?.topActors ?? []).map((facet) => (
              <SelectItem key={facet.actor} value={facet.actor}>
                {facet.actor} · {facet.count}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          onValueChange={(value) => {
            setAction(value);
            setPage(1);
          }}
          value={action}
        >
          <SelectTrigger aria-label="Action" className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-60">
            <SelectItem value="ALL">Any action</SelectItem>
            <SelectGroup>
              <SelectLabel>Families</SelectLabel>
              {ACTION_FAMILIES.map((family) => {
                const count = facetActions
                  .filter((facet) => facet.action.startsWith(family))
                  .reduce((sum, facet) => sum + facet.count, 0);
                const Icon =
                  family === "MAINTENANCE_"
                    ? Wrench
                    : family === "CHANGE_"
                      ? Ticket
                      : family === "AUTH_"
                        ? ShieldCheck
                        : Activity;
                return (
                  <SelectItem key={family} value={family}>
                    <span className="inline-flex items-center gap-1.5">
                      <Icon aria-hidden className="size-3" />
                      {family.replace(/_$/, "")}*
                      {count > 0 ? ` · ${count}` : ""}
                    </span>
                  </SelectItem>
                );
              })}
            </SelectGroup>
            {extraActions.length > 0 && (
              <SelectGroup>
                <SelectLabel>Other actions</SelectLabel>
                {extraActions.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
          </SelectContent>
        </Select>
        <Select
          onValueChange={(value) => {
            setEntityType(value);
            setPage(1);
          }}
          value={entityType}
        >
          <SelectTrigger aria-label="Entity type" className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-60">
            <SelectItem value="ALL">Any entity</SelectItem>
            {(listMeta?.entityTypes ?? []).map((facet) => (
              <SelectItem key={facet.entityType} value={facet.entityType}>
                {facet.entityType} · {facet.count}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          onValueChange={(value) => {
            setTimeRange(value as TimeRangeKey);
            setPage(1);
          }}
          value={timeRange}
        >
          <SelectTrigger aria-label="Time range" className="w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIME_RANGES.map((entry) => (
              <SelectItem key={entry.value} value={entry.value}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="relative">
          <span className="sr-only">Filter by correlation id</span>
          <Link2
            aria-hidden
            className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            className="w-full ps-8 font-tech ltr-technical sm:w-52"
            onChange={(event) => setCorrelationInput(event.target.value)}
            placeholder="correlationId…"
            value={correlationInput}
          />
        </label>
        {hasFilters && (
          <Button onClick={resetFilters} size="sm" variant="ghost">
            Reset
          </Button>
        )}
      </div>

      <SectionCard
        actions={
          <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <StatusDot pulse token="info" />
            live · polls every 7 s
          </span>
        }
        contentClassName="p-0"
        title={`Events${listMeta ? ` — ${listMeta.total}` : ""}`}
      >
        {events.isError ? (
          <div className="p-4">
            <ErrorState
              onRetry={() => void events.refetch()}
              reason={events.error.message}
              title="Events could not be loaded"
            />
          </div>
        ) : events.isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <div key={index} className="h-11 animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              description="No audit events match the current filter. Widen the time range or clear a filter."
              icon={Search}
              title="No events to show"
            />
          </div>
        ) : (
          <ul className="max-h-[620px] overflow-y-auto">
            {rows.map((event) => (
              <EventRowContainer
                key={event.id}
                event={event}
                onCorrelationClick={(value) => {
                  setCorrelationInput(value);
                  setCorrelationId(value);
                  setPage(1);
                }}
              />
            ))}
          </ul>
        )}
        {listMeta && listMeta.totalPages > 1 && (
          <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
            <span>
              Page {listMeta.page} of {listMeta.totalPages} · {listMeta.total} events
            </span>
            <div className="flex gap-2">
              <Button
                disabled={listMeta.page <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
                size="sm"
                variant="outline"
              >
                Previous
              </Button>
              <Button
                disabled={listMeta.page >= listMeta.totalPages}
                onClick={() => setPage((value) => value + 1)}
                size="sm"
                variant="outline"
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

/**
 * Expansion state wrapper — one row expanded at a time is enough for a
 * timeline (keeps the live poll from collapsing multi-open panels silently).
 */
function EventRowContainer({
  event,
  onCorrelationClick,
}: {
  event: AuditEventRow;
  onCorrelationClick: (correlationId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <EventRow
      event={event}
      expanded={expanded}
      onCorrelationClick={onCorrelationClick}
      onToggle={() => setExpanded((value) => !value)}
    />
  );
}
