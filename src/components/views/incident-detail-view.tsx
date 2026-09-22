"use client";

import { useMemo, useState } from "react";
import { format, formatDistanceToNow } from "date-fns";
import {
  ArrowLeft,
  Bot,
  CircleCheck,
  CircleDot,
  ClipboardList,
  Clock,
  Eye,
  FileDown,
  GitPullRequest,
  Link2,
  Loader2,
  MonitorDot,
  Plug,
  Save,
  ShieldAlert,
  Siren,
  Sparkles,
  Unlink,
  User,
  Wrench,
} from "lucide-react";

import { useIncidentDetail } from "@/hooks/api/use-incident-detail";
import { useIncidentAction } from "@/hooks/api/use-incident-mutations";
import { useMetaUsers } from "@/hooks/api/use-meta";
import { useChanges } from "@/hooks/api/use-changes";
import { aiErrorKey, useAiRcaDraft } from "@/hooks/api/use-ai";
import { useTranslations } from "next-intl";
import { useCurrentLocale } from "@/i18n/locale-provider";
import { usePreferencesStore } from "@/stores/preferences";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { KpiCard } from "@/components/domain/kpi-card";
import { SectionCard } from "@/components/domain/section-card";
import { SlaChip } from "@/components/domain/sla-chip";
import { StatusBadge } from "@/components/domain/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api-client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useNavigationStore } from "@/stores/navigation";
import { cn } from "@/lib/utils";
import { INCIDENT_STATUS_UI, lookupStatusConfig } from "./status-extras";
import { IncidentSeverityBadge } from "./incident-severity-badge";

/**
 * Incident detail (Task 5-b) — view key ops.incident-detail (hidden from the
 * sidebar, opened with params { incidentId }). Header with contextual
 * lifecycle actions, KPI strip (time-to-ack / time-to-resolve / SLA /
 * devices), chronological timeline with SYSTEM|USER|INTEGRATION attribution,
 * and a side panel: devices, linked alerts, linked change, PIR form and the
 * printable PIR export. Live-polls every 5 s while the incident is active.
 */

const OPEN_STATUSES = [
  "NEW",
  "ACKNOWLEDGED",
  "ASSIGNED",
  "INVESTIGATING",
  "MITIGATING",
  "MONITORING",
];

type NoteAction = "acknowledge" | "investigate" | "mitigate" | "monitor" | "resolve" | "close";

const KIND_META: Record<string, { icon: typeof Bot; className: string; labelKey: "system" | "user" | "integration" }> = {
  SYSTEM: { icon: Bot, className: "bg-neutral-subtle text-neutral", labelKey: "system" },
  USER: { icon: User, className: "bg-primary/10 text-primary-ink", labelKey: "user" },
  INTEGRATION: { icon: Plug, className: "bg-info-subtle text-info", labelKey: "integration" },
};

function durationBetween(from: string | null, to: string | null): string {
  if (!from || !to) return "—";
  const ms = Math.max(0, new Date(to).getTime() - new Date(from).getTime());
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

export function IncidentDetailView() {
  const t = useTranslations("incidentDetail");
  const params = useNavigationStore((state) => state.params);
  const setActiveView = useNavigationStore((state) => state.setActiveView);
  const incidentId = params?.incidentId ?? null;

  // HC-2 (R54): the user directory is served by the AUTHENTICATED
  // /api/v1/meta/users — this view consumes ONLY that segment.
  const meta = useMetaUsers();

  const incident = useIncidentDetail(incidentId);
  const detail = incident.data;

  // ── dialog state ───────────────────────────────────────────────────────
  const [noteAction, setNoteAction] = useState<NoteAction | null>(null);
  const [noteText, setNoteText] = useState("");
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignOwnerId, setAssignOwnerId] = useState<string>("");
  const [assignTeam, setAssignTeam] = useState<string>("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkChangeId, setLinkChangeId] = useState<string>("");

  // PIR form state (seeded from the server each time the incident resolves onward).
  const [pirRootCause, setPirRootCause] = useState("");
  const [pirCorrective, setPirCorrective] = useState("");
  const [pirPreventive, setPirPreventive] = useState("");
  const [pirSeededFor, setPirSeededFor] = useState<string | null>(null);
  if (
    detail &&
    ["RESOLVED", "POST_INCIDENT_REVIEW", "CLOSED"].includes(detail.status) &&
    pirSeededFor !== detail.id
  ) {
    setPirSeededFor(detail.id);
    setPirRootCause(detail.rootCause ?? "");
    setPirCorrective(detail.correctiveAction ?? "");
    setPirPreventive(detail.preventiveAction ?? "");
  }

  const ackAction = useIncidentAction("acknowledge");
  const assignAction = useIncidentAction("assign");
  const investigateAction = useIncidentAction("investigate");
  const mitigateAction = useIncidentAction("mitigate");
  const monitorAction = useIncidentAction("monitor");
  const resolveAction = useIncidentAction("resolve");
  const reviewAction = useIncidentAction("review");
  const closeAction = useIncidentAction("close");
  const savePirAction = useIncidentAction("save-pir");
  const linkChangeAction = useIncidentAction("link-change");
  const unlinkChangeAction = useIncidentAction("unlink-change");

  // ── AI RCA draft (Phase 12-a) — pre-fills the PIR form for review; the
  // draft NEVER auto-saves: the user still submits via the existing flow.
  const tAi = useTranslations("ai.rca");
  const tAiRoot = useTranslations("ai");
  const locale = useCurrentLocale();
  const rcaDraft = useAiRcaDraft(incidentId ?? "");
  const [aiDraft, setAiDraft] = useState<{
    incidentId: string;
    confidence: "low" | "medium" | "high";
    correlationId: string;
  } | null>(null);

  const generateRcaDraft = () => {
    if (!incidentId || rcaDraft.isPending) return;
    rcaDraft.mutate(
      { incidentId, locale },
      {
        onSuccess: (result) => {
          const { draft } = result;
          const bullets = (items: string[]) =>
            items.map((item) => `- ${item}`).join("\n");
          const rootCauseText = [
            draft.summary,
            draft.rootCause,
            draft.contributingFactors.length > 0
              ? `${tAi("contributingLabel")}\n${bullets(draft.contributingFactors)}`
              : null,
          ]
            .filter((part) => part && part.trim().length > 0)
            .join("\n\n");
          setPirRootCause(rootCauseText);
          setPirCorrective(bullets(draft.remediation));
          setPirPreventive(bullets(draft.prevention));
          setAiDraft({
            incidentId,
            confidence: draft.confidence,
            correlationId: result.correlationId,
          });
        },
      }
    );
  };

  const draftErrorReason = (() => {
    if (!rcaDraft.error) return null;
    const key = aiErrorKey(rcaDraft.error instanceof ApiError ? rcaDraft.error.code : "");
    return key ? tAiRoot(key) : rcaDraft.error.message;
  })();

  const changes = useChanges({ pageSize: 50, status: "AWAITING_APPROVAL,SCHEDULED,APPROVED,SCHEDULED,EXECUTING,SUCCESSFUL,FAILED,ROLLBACK,CLOSED" });

  const actionFor = (action: NoteAction) => {
    const map: Record<NoteAction, typeof ackAction> = {
      acknowledge: ackAction,
      investigate: investigateAction,
      mitigate: mitigateAction,
      monitor: monitorAction,
      resolve: resolveAction,
      close: closeAction,
    };
    return map[action];
  };

  const submitNoteAction = () => {
    if (!incidentId || !noteAction) return;
    const mutation = actionFor(noteAction);
    mutation.mutate(
      {
        id: incidentId,
        payload: {
          note: noteText.trim() || undefined,
          resolutionNote: noteAction === "resolve" ? noteText.trim() || undefined : undefined,
        },
      },
      {
        onSuccess: () => {
          setNoteAction(null);
          setNoteText("");
        },
      }
    );
  };

  const submitAssign = () => {
    if (!incidentId) return;
    assignAction.mutate(
      {
        id: incidentId,
        payload: {
          ownerId: assignOwnerId || undefined,
          ownerTeam: assignTeam.trim() || undefined,
        },
      },
      {
        onSuccess: () => {
          setAssignOpen(false);
          setAssignOwnerId("");
          setAssignTeam("");
        },
      }
    );
  };

  const submitLink = () => {
    if (!incidentId || !linkChangeId) return;
    linkChangeAction.mutate(
      { id: incidentId, payload: { changeId: linkChangeId } },
      {
        onSuccess: () => {
          setLinkOpen(false);
          setLinkChangeId("");
        },
      }
    );
  };

  const submitPir = () => {
    if (!incidentId) return;
    savePirAction.mutate({
      id: incidentId,
      payload: {
        rootCause: pirRootCause,
        correctiveAction: pirCorrective,
        preventiveAction: pirPreventive,
      },
    });
  };

  const isOpen = detail ? OPEN_STATUSES.includes(detail.status) : false;
  const showPir = detail
    ? ["RESOLVED", "POST_INCIDENT_REVIEW", "CLOSED"].includes(detail.status)
    : false;

  const timeline = useMemo(() => detail?.events ?? [], [detail]);

  return (
    <div className="flex flex-col gap-5">
      <Button
        className="w-fit"
        onClick={() => setActiveView("ops.incidents")}
        size="sm"
        variant="ghost"
      >
        <ArrowLeft aria-hidden className="size-4" />
        {t("page.back")}
      </Button>

      {incident.isError ? (
        <ErrorState
          onRetry={() => void incident.refetch()}
          reason={incident.error.message}
          title={t("page.error")}
        />
      ) : incident.isLoading || !detail ? (
        <div className="flex flex-col gap-3">
          <div className="h-20 animate-pulse rounded-xl bg-muted/60" />
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="h-24 animate-pulse rounded-xl bg-muted/60" />
            ))}
          </div>
        </div>
      ) : (
        <>
          {/* ── Header ─────────────────────────────────────────────────── */}
          <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 md:flex-row md:items-start md:justify-between md:p-6">
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <IncidentSeverityBadge value={detail.severity} />
                <span className="font-tech text-sm text-muted-foreground ltr-technical">
                  {detail.number}
                </span>
                {detail.priority && <Badge variant="outline">{detail.priority}</Badge>}
                <StatusBadge
                  config={lookupStatusConfig(INCIDENT_STATUS_UI, detail.status)}
                  withIcon
                />
                <SlaChip sla={detail.sla} />
                {detail.source && (
                  <Badge className="font-tech" variant="secondary">
                    {detail.source}
                  </Badge>
                )}
              </div>
              <h1 className="truncate text-lg font-semibold" title={detail.title}>
                {detail.title}
              </h1>
              <p className="text-xs text-muted-foreground">
                {detail.site ? `${detail.site.name} · ` : ""}
                {t("header.created", {
                  time: formatDistanceToNow(new Date(detail.createdAt), { addSuffix: true }),
                })}
                {detail.owner ? ` · ${t("header.owner", { name: detail.owner.name })}` : ""}

              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {isOpen && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm">
                      <Wrench aria-hidden className="size-4" />
                      {t("header.actions")}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuLabel>{t("header.lifecycle")}</DropdownMenuLabel>
                    {detail.status === "NEW" && (
                      <DropdownMenuItem
                        onSelect={() => {
                          setNoteText("");
                          setNoteAction("acknowledge");
                        }}
                      >
                        <Eye aria-hidden className="size-4" /> {t("header.acknowledge")}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={() => setAssignOpen(true)}>
                      <User aria-hidden className="size-4" /> {t("header.assign")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => {
                        setNoteText("");
                        setNoteAction("investigate");
                      }}
                    >
                        <Siren aria-hidden className="size-4" /> {t("header.investigate")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => {
                        setNoteText("");
                        setNoteAction("mitigate");
                      }}
                    >
                        <Wrench aria-hidden className="size-4" /> {t("header.mitigate")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => {
                        setNoteText("");
                        setNoteAction("monitor");
                      }}
                    >
                        <MonitorDot aria-hidden className="size-4" /> {t("header.monitor")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => {
                        setNoteText("");
                        setNoteAction("resolve");
                      }}
                    >
                        <CircleCheck aria-hidden className="size-4" /> {t("header.resolve")}
                    </DropdownMenuItem>
                    {detail.status === "RESOLVED" && (
                      <DropdownMenuItem onSelect={() => reviewAction.mutate({ id: detail.id, payload: {} })}>
                        <ClipboardList aria-hidden className="size-4" /> {t("header.openReview")}
                      </DropdownMenuItem>
                    )}
                    {(detail.status === "RESOLVED" || detail.status === "POST_INCIDENT_REVIEW") && (
                      <DropdownMenuItem
                        onSelect={() => {
                          setNoteText("");
                          setNoteAction("close");
                        }}
                      >
                        <ShieldAlert aria-hidden className="size-4" /> {t("header.close")}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    {detail.changeId ? (
                      <DropdownMenuItem
                        onSelect={() =>
                          unlinkChangeAction.mutate({ id: detail.id, payload: {} })
                        }
                      >
                        <Unlink aria-hidden className="size-4" /> {t("header.unlink")}
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onSelect={() => setLinkOpen(true)}>
                        <Link2 aria-hidden className="size-4" /> {t("header.link")}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <Button
                onClick={() =>
                  window.open(
                    `/api/v1/incidents/export?id=${detail.id}`,
                    "_blank",
                    "noopener"
                  )
                }
                size="sm"
                variant="outline"
              >
                <FileDown aria-hidden className="size-4" />
                {t("header.exportPir")}
              </Button>
            </div>
          </div>

          {/* ── KPI strip ──────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiCard
              description={detail.acknowledgedAt ? format(new Date(detail.acknowledgedAt), "MMM d, HH:mm") : t("kpi.notAcknowledged")}
              icon={Eye}
              label={t("kpi.timeToAcknowledge")}
              value={durationBetween(detail.createdAt, detail.acknowledgedAt)}
            />
            <KpiCard
              description={detail.resolvedAt ? format(new Date(detail.resolvedAt), "MMM d, HH:mm") : t("kpi.open")}
              icon={CircleCheck}
              label={t("kpi.timeToResolve")}
              value={durationBetween(detail.createdAt, detail.resolvedAt)}
            />
            <KpiCard
              description={detail.sla.targetLabel ?? t("kpi.noTarget")}
              icon={Clock}
              label={t("kpi.slaState")}
              value={
                detail.sla.outcome
                  ? detail.sla.outcome === "MET"
                    ? t("kpi.met")
                    : t("kpi.breached")
                  : detail.sla.breached
                    ? t("kpi.breached")
                    : detail.sla.tracked
                      ? t("kpi.onTrack")
                      : "—"
              }
            />
            <KpiCard
              description={detail.alerts.length > 0 ? t("kpi.linkedAlerts", { count: detail.alerts.length }) : t("kpi.noAlerts")}
              icon={CircleDot}
              label={t("kpi.affectedDevices")}
              value={detail.devices.length}
            />
          </div>

          {/* ── Two-column: timeline + side panel ──────────────────────── */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.4fr_1fr]">
            <SectionCard contentClassName="p-0" title={t("timeline.title", { count: timeline.length })}>
              {timeline.length === 0 ? (
                <div className="p-4">
                  <EmptyState
                    description={t("timeline.emptyDescription")}
                    icon={Clock}
                    title={t("timeline.emptyTitle")}
                  />
                </div>
              ) : (
                <ol className="max-h-[560px] overflow-y-auto p-4">
                  {timeline.map((event) => {
                    const kindMeta = KIND_META[event.kind] ?? KIND_META.SYSTEM;
                    const KindIcon = kindMeta.icon;
                    return (
                      <li className="relative flex gap-3 pb-4 last:pb-0" key={event.id}>
                        <span
                          className={cn(
                            "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border",
                            kindMeta.className
                          )}
                          title={t("timeline.kindEvent", {
                            kind: t(`timeline.kind.${kindMeta.labelKey}`),
                          })}
                        >
                          <KindIcon aria-hidden className="size-3.5" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-x-2">
                            <span className="text-sm">{event.message}</span>
                          </div>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            <span className="font-medium">
                              {event.actor?.name ??
                                t(event.kind === "SYSTEM" ? "timeline.systemActor" : "timeline.unknownActor")}
                            </span>
                            {event.actor?.email ? ` · ${event.actor.email}` : ""} ·{" "}
                            <time dateTime={event.createdAt} title={format(new Date(event.createdAt), "EEE d MMM yyyy, HH:mm:ss")}>
                              {formatDistanceToNow(new Date(event.createdAt), { addSuffix: true })}
                            </time>{" "}
                            · {format(new Date(event.createdAt), "HH:mm:ss")}
                          </p>
                        </div>
                        <span
                          className={cn(
                            "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                            kindMeta.className
                          )}
                        >
                          {event.kind}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </SectionCard>

            <div className="flex flex-col gap-4">
              {/* Devices */}
              <SectionCard contentClassName="p-0" title={t("devices.title", { count: detail.devices.length })}>
                {detail.devices.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">{t("devices.empty")}</p>
                ) : (
                  <ul className="max-h-48 overflow-y-auto">
                    {detail.devices.map((link) => (
                      <li className="border-b px-4 py-2.5 last:border-0" key={link.id}>
                        <div className="flex items-center justify-between gap-2">
                          <button
                            className="min-w-0 truncate text-sm font-medium hover:underline"
                            onClick={() => setActiveView("network.device-detail", { deviceId: link.deviceId })}
                            type="button"
                          >
                            {link.device.hostname}
                          </button>
                          <span className="font-tech shrink-0 text-xs text-muted-foreground ltr-technical">
                            {link.device.mgmtIp}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {link.device.model ?? "—"} · {link.device.site?.code ?? t("devices.noSite")} · {t("devices.status", { status: link.device.status })}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </SectionCard>

              {/* Linked alerts */}
              <SectionCard contentClassName="p-0" title={t("alerts.title", { count: detail.alerts.length })}>
                {detail.alerts.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">{t("alerts.empty")}</p>
                ) : (
                  <ul className="max-h-48 overflow-y-auto">
                    {detail.alerts.map((alert) => (
                      <li className="flex items-center gap-2 border-b px-4 py-2.5 last:border-0" key={alert.id}>
                        <span
                          className={cn(
                            "size-2 shrink-0 rounded-full",
                            alert.severity === "CRITICAL"
                              ? "bg-danger"
                              : alert.severity === "HIGH"
                                ? "bg-danger-orange"
                                : alert.severity === "MEDIUM"
                                  ? "bg-warning"
                                  : "bg-info"
                          )}
                          title={alert.severity}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm" title={alert.message}>
                          {alert.message}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {alert.status} · ×{alert.count}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </SectionCard>

              {/* Linked change */}
              <SectionCard contentClassName="p-0" title={t("change.title")}>
                {detail.change ? (
                  <div className="flex items-center justify-between gap-2 p-4">
                    <div className="min-w-0">
                      <p className="font-tech text-sm ltr-technical">{detail.change.number}</p>
                      <p className="truncate text-xs text-muted-foreground" title={detail.change.title}>
                        {detail.change.title} · {detail.change.status} · {detail.change.riskLevel}
                      </p>
                    </div>
                    <Button
                      onClick={() => setActiveView("changes.change-detail", { changeId: detail.change!.id })}
                      size="sm"
                      variant="outline"
                    >
                      <GitPullRequest aria-hidden className="size-4" />
                      {t("change.open")}
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2 p-4">
                    <p className="text-sm text-muted-foreground">
                      {t("change.emptyDescription")}
                    </p>
                    <Button disabled={!isOpen} onClick={() => setLinkOpen(true)} size="sm" variant="outline">
                      <Link2 aria-hidden className="size-4" />
                      {t("change.link")}
                    </Button>
                  </div>
                )}
              </SectionCard>

              {/* PIR form */}
              <SectionCard
                contentClassName="p-4"
                title={t("pir.title")}
              >
                {showPir ? (
                  <div className="flex flex-col gap-3">
                    {/* AI draft toolbar (Phase 12-a) — generates a draft and
                        pre-fills the fields below; nothing saves until the
                        user presses Save PIR. */}
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-surface-subtle px-3 py-2.5">
                      <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                        <Sparkles aria-hidden className="size-3.5 shrink-0" />
                        {tAi("hint")}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={rcaDraft.isPending}
                        onClick={generateRcaDraft}
                      >
                        {rcaDraft.isPending ? (
                          <Loader2 aria-hidden className="size-4 animate-spin" />
                        ) : (
                          <Sparkles aria-hidden className="size-4" />
                        )}
                        {rcaDraft.isPending ? tAi("generating") : tAi("generate")}
                      </Button>
                    </div>
                    {aiDraft && aiDraft.incidentId === detail.id && (
                      <div
                        className="flex flex-wrap items-center gap-2 rounded-lg border border-info/30 bg-info-subtle px-3 py-2 text-sm text-info"
                        role="status"
                      >
                        <Sparkles aria-hidden className="size-4 shrink-0" />
                        <span className="font-medium">{tAi("banner")}</span>
                        <Badge className="border-info/40 bg-transparent text-info" variant="outline">
                          {tAi("confidenceLabel")}: {tAi(`confidence.${aiDraft.confidence}`)}
                        </Badge>
                      </div>
                    )}
                    {rcaDraft.isError && draftErrorReason && (
                      <p className="rounded-lg border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger" role="alert">
                        {draftErrorReason}
                      </p>
                    )}
                    <div className="space-y-1.5">
                      <Label htmlFor="pir-root-cause">{t("pir.rootCause")}</Label>
                      <Textarea
                        id="pir-root-cause"
                        onChange={(event) => setPirRootCause(event.target.value)}
                        placeholder={t("pir.rootCausePlaceholder")}
                        rows={3}
                        value={pirRootCause}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="pir-corrective">{t("pir.correctiveAction")}</Label>
                      <Textarea
                        id="pir-corrective"
                        onChange={(event) => setPirCorrective(event.target.value)}
                        placeholder={t("pir.correctiveActionPlaceholder")}
                        rows={3}
                        value={pirCorrective}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="pir-preventive">{t("pir.preventiveAction")}</Label>
                      <Textarea
                        id="pir-preventive"
                        onChange={(event) => setPirPreventive(event.target.value)}
                        placeholder={t("pir.preventiveActionPlaceholder")}
                        rows={3}
                        value={pirPreventive}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs text-muted-foreground">
                        {t("pir.exportHint")}
                      </p>
                      <Button
                        disabled={
                          savePirAction.isPending ||
                          pirRootCause.trim().length < 3 ||
                          pirCorrective.trim().length < 3 ||
                          pirPreventive.trim().length < 3
                        }
                        onClick={submitPir}
                        size="sm"
                      >
                        <Save aria-hidden className="size-4" />
                        {savePirAction.isPending ? t("pir.saving") : t("pir.save")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t("pir.unlockHint")}
                  </p>
                )}
              </SectionCard>
            </div>
          </div>
        </>
      )}

      {/* ── Note action dialog ─────────────────────────────────────────── */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setNoteAction(null);
        }}
        open={noteAction !== null}
      >
        <DialogContent>
          {noteAction && (
            <>
              <DialogHeader>
                <DialogTitle>{t(`actions.${noteAction}.title`)}</DialogTitle>
                <DialogDescription>{t(`actions.${noteAction}.description`)}</DialogDescription>
              </DialogHeader>
              <div className="space-y-1.5">
                <Label htmlFor="incident-action-note">{t(`actions.${noteAction}.noteLabel`)}</Label>
                <Textarea
                  id="incident-action-note"
                  onChange={(event) => setNoteText(event.target.value)}
                  placeholder={t(`actions.${noteAction}.notePlaceholder`)}
                  rows={3}
                  value={noteText}
                />
              </div>
              <DialogFooter>
                <Button onClick={() => setNoteAction(null)} variant="outline">
                  {t("common.cancel")}
                </Button>
                <Button
                  disabled={actionFor(noteAction).isPending}
                  onClick={submitNoteAction}
                >
                  {actionFor(noteAction).isPending
                    ? t("actions.working")
                    : t(`actions.${noteAction}.cta`)}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Assign dialog ──────────────────────────────────────────────── */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setAssignOpen(false);
        }}
        open={assignOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("assign.title")}</DialogTitle>
            <DialogDescription>{t("assign.description")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t("assign.ownerLabel")}</Label>
              <Select onValueChange={setAssignOwnerId} value={assignOwnerId}>
                <SelectTrigger>
                  <SelectValue placeholder={t("assign.ownerPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {(meta.data?.users ?? []).map((user) => (
                    <SelectItem key={user.id} value={user.id}>
                      {user.name} · {user.roleLabel}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="assign-team">{t("assign.teamLabel")}</Label>
              <Input
                id="assign-team"
                onChange={(event) => setAssignTeam(event.target.value)}
                placeholder={t("assign.teamPlaceholder")}
                value={assignTeam}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setAssignOpen(false)} variant="outline">
              {t("common.cancel")}
            </Button>
            <Button disabled={assignAction.isPending || (!assignOwnerId && !assignTeam.trim())} onClick={submitAssign}>
              {assignAction.isPending ? t("assign.assigning") : t("assign.action")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Link change dialog ─────────────────────────────────────────── */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setLinkOpen(false);
        }}
        open={linkOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("link.title")}</DialogTitle>
            <DialogDescription>{t("link.description")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>{t("link.requestLabel")}</Label>
            <Select onValueChange={setLinkChangeId} value={linkChangeId}>
              <SelectTrigger>
                <SelectValue placeholder={t("link.requestPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {(changes.data?.data ?? []).map((change) => (
                  <SelectItem key={change.id} value={change.id}>
                    {change.number} · {change.title.slice(0, 48)} · {change.status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button onClick={() => setLinkOpen(false)} variant="outline">
              {t("common.cancel")}
            </Button>
            <Button disabled={linkChangeAction.isPending || !linkChangeId} onClick={submitLink}>
              {linkChangeAction.isPending ? t("link.linking") : t("link.action")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
