"use client";

import { useState } from "react";
import { format, formatDistanceToNow } from "date-fns";
import {
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  CircleX,
  ClipboardList,
  FileText,
  GitPullRequest,
  Info,
  LoaderCircle,
  Pencil,
  Play,
  Send,
  Siren,
  Trash2,
  XCircle,
} from "lucide-react";

import { useChangeDetail } from "@/hooks/api/use-change-detail";
import {
  useCreateIncidentFromChange,
  useExecuteChange,
  useUpdateChange,
} from "@/hooks/api/use-change-mutations";
import { useDecideApproval } from "@/hooks/api/use-approval-mutations";
import { useStatusLabel } from "@/hooks/use-status-label";
import { useSession } from "next-auth/react";
import { usePreferencesStore } from "@/stores/preferences";
import { usePermissionsStore } from "@/stores/permissions";
import { useCanApproveLevel, APPROVAL_LEVEL_PERMISSIONS, useCan } from "@/lib/permissions-client";
import type { ApprovalLevel } from "@/lib/auth/permissions";
import {
  getStatusConfig,
  INCIDENT_SEVERITY,
  SEVERITY,
  SNAPSHOT_STATUS,
} from "@/lib/domain/status";

import { ChangeRiskBadge } from "@/components/domain/change-risk-badge";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { KpiCard } from "@/components/domain/kpi-card";
import { SectionCard } from "@/components/domain/section-card";
import { StatusBadge } from "@/components/domain/status-badge";
import { StatusIcon } from "@/components/domain/status-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useNavigationStore } from "@/stores/navigation";
import { approvalLevelsFor } from "@/lib/change/risk";
import { ChangeWizard } from "@/components/change/change-wizard";
import {
  lookupStatusConfig,
  CHANGE_APPROVAL_LEVEL_UI,
  CHANGE_APPROVAL_STATUS_UI,
  CHANGE_DEVICE_RESULT_UI,
  CHANGE_STEP_STATUS_UI,
  CHANGE_STEP_TYPE_UI,
  CHANGE_STATUS_UI,
  CHANGE_TYPE_UI,
  INCIDENT_STATUS_UI,
} from "@/components/views/status-extras";
import type { ChangeDetailStep } from "@/lib/api-client";

/** Statuses whose detail still offers Edit/Submit (mirrors the API guard). */
const EDITABLE_STATUSES = ["DRAFT"];
const CANCELLABLE_STATUSES = ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SCHEDULED"];
/** Execute action guard (mirrors the execute endpoint). */
const EXECUTABLE_STATUSES = ["APPROVED", "SCHEDULED"];
/** Statuses the engine is actively driving — the UI shows live state. */
const EXECUTION_STATUSES = ["PRE_CHECK", "EXECUTING", "VALIDATING", "ROLLBACK"];
/** Statuses that offer the incident-creation follow-up. */
const FAILED_STATUSES = ["FAILED", "ROLLBACK_FAILED"];
/** SoD-gated risk levels (mirrors the server rule). */
const SOD_GATED_RISK_LEVELS = ["HIGH", "CRITICAL"];

function formatDate(value: string | null | undefined, pattern = "EEE, MMM d, HH:mm"): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : format(date, pattern);
}

/** Human step duration between startedAt/finishedAt. */
function stepDuration(step: ChangeDetailStep): string | null {
  if (!step.startedAt || !step.finishedAt) return null;
  const start = new Date(step.startedAt).getTime();
  const end = new Date(step.finishedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  const seconds = Math.max(1, Math.round((end - start) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** One prose plan block (plans are normal text, pre-wrapped). */
function PlanBlock({ label, text }: { label: string; text: string | null }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {text ? (
        <p className="whitespace-pre-wrap rounded-lg border bg-surface-subtle/60 p-3 text-sm leading-relaxed">
          {text}
        </p>
      ) : (
        <p className="flex items-center gap-1.5 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          <CircleAlert aria-hidden="true" className="size-3.5" />
          Not documented yet
        </p>
      )}
    </div>
  );
}

/** Expandable font-tech block for step output/error lines. */
function StepOutputBlock({ text, tone }: { text: string; tone: "output" | "error" }) {
  return (
    <details className="mt-1">
      <summary
        className={
          tone === "error"
            ? "cursor-pointer text-xs font-medium text-danger"
            : "cursor-pointer text-xs font-medium text-muted-foreground"
        }
      >
        {tone === "error" ? "error detail" : "output"}
      </summary>
      <pre
        className={`font-tech ltr-technical mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border px-2 py-1.5 text-xs leading-relaxed ${
          tone === "error"
            ? "border-danger/30 bg-danger-subtle text-danger"
            : "bg-surface-subtle/60 text-muted-foreground"
        }`}
      >
        {text}
      </pre>
    </details>
  );
}

/** Vertical step timeline — live-updates while the engine drives the change. */
function StepTimeline({ steps }: { steps: ChangeDetailStep[] }) {
  return (
    <ol className="relative flex flex-col gap-0 ps-1">
      {steps.map((step, index) => {
        const typeConfig = lookupStatusConfig(CHANGE_STEP_TYPE_UI, step.type);
        const statusConfig = lookupStatusConfig(CHANGE_STEP_STATUS_UI, step.status);
        const running = step.status === "RUNNING";
        const last = index === steps.length - 1;
        const duration = stepDuration(step);
        return (
          <li className="relative flex gap-3 pb-4" key={step.id}>
            {!last && (
              <span
                aria-hidden="true"
                className="absolute start-[15px] top-8 h-[calc(100%-16px)] w-px bg-border"
              />
            )}
            <span className="relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border bg-card">
              {running ? (
                <LoaderCircle
                  aria-hidden="true"
                  className="size-4 animate-spin text-info"
                />
              ) : (
                <StatusIcon className={typeConfig.iconClass} icon={typeConfig.icon} />
              )}
            </span>
            <div className="min-w-0 flex-1 pt-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-tech text-xs tabular-nums text-muted-foreground">
                  {step.order}.
                </span>
                <span className="text-sm font-medium">{step.name}</span>
                <Badge className="font-tech" variant="outline">
                  {step.type}
                </Badge>
                <StatusBadge config={statusConfig} />
                {running && (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-info">
                    <span
                      aria-hidden="true"
                      className="size-1.5 animate-pulse rounded-full bg-info"
                    />
                    running…
                  </span>
                )}
              </div>
              {(step.startedAt || step.finishedAt) && (
                <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                  {step.startedAt && `started ${formatDate(step.startedAt, "MMM d HH:mm")}`}
                  {step.startedAt && step.finishedAt && " · "}
                  {step.finishedAt && `finished ${formatDate(step.finishedAt, "MMM d HH:mm")}`}
                  {duration && ` · took ${duration}`}
                </p>
              )}
              {step.error && <StepOutputBlock text={step.error} tone="error" />}
              {step.output && <StepOutputBlock text={step.output} tone="output" />}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Change detail view (Tasks 4-a + 4-b) — reached via row click from the
 * changes lists; hidden view key `changes.change-detail` with params
 * { changeId }. 4-b adds the approval actions (SoD-aware), the guarded
 * execute dialog with the demo failAt control, the live step timeline
 * (2 s polling while the engine drives the change), the outcome banner
 * with incident creation and the Mark-closed sign-off.
 */
export function ChangeDetailView() {
  const params = useNavigationStore((state) => state.params);
  const setActiveView = useNavigationStore((state) => state.setActiveView);
  // Status labels resolve in the active locale (falls back to config.label).
  const resolveStatusLabel = useStatusLabel();
  // Signed-in principal for the client-side SoD pre-check (server enforces it).
  const { data: sessionData } = useSession();
  const permissionUser = usePermissionsStore((state) => state.user);
  const changeId = params?.changeId ?? null;


  const detail = useChangeDetail(changeId);
  const updateChange = useUpdateChange();
  const executeChange = useExecuteChange();
  const decide = useDecideApproval();
  const createIncident = useCreateIncidentFromChange();

  const [wizardOpen, setWizardOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<
    "SUBMIT" | "CANCEL" | "CLOSE" | null
  >(null);
  const [executeOpen, setExecuteOpen] = useState(false);
  const [failAt, setFailAt] = useState<string>("NONE");
  const [decision, setDecision] = useState<{
    level: string;
    decision: "APPROVED" | "REJECTED";
  } | null>(null);
  const [comment, setComment] = useState("");

  // Phase 19-C client-side permission mirrors — hooks MUST run before the
  // early returns below (rules of hooks). The server gates remain the hard
  // backstop; these only disable the affordances.
  const mayExecute = useCan("change.execute");
  const mayCancel = useCan("change.cancel");
  const mayClose = useCan("change.close");
  const canTechnical = useCanApproveLevel("TECHNICAL");
  const canSecurity = useCanApproveLevel("SECURITY");
  const canManager = useCanApproveLevel("MANAGER");
  const canCab = useCanApproveLevel("CAB");
  const LEVEL_ENTITLED: Record<ApprovalLevel, boolean> = {
    TECHNICAL: canTechnical,
    SECURITY: canSecurity,
    MANAGER: canManager,
    CAB: canCab,
  };
  const levelEntitled = (level: string): boolean =>
    LEVEL_ENTITLED[level as ApprovalLevel] ?? false;
  const levelEntitlementHint = (level: string): string =>
    `Requires the "${APPROVAL_LEVEL_PERMISSIONS[level as ApprovalLevel]}" permission, which your role does not hold.`;

  if (!changeId) {
    return (
      <div className="flex flex-col gap-4">
        <EmptyState
          description="Open a change from the All Changes list."
          icon={GitPullRequest}
          title="No change selected"
        />
      </div>
    );
  }

  if (detail.isError) {
    return (
      <ErrorState
        onRetry={() => void detail.refetch()}
        reason={detail.error.message}
        title="Change could not be loaded"
      />
    );
  }

  if (detail.isLoading || !detail.data) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-live="polite">
        <div className="h-8 w-64 animate-pulse rounded-md bg-muted/60" />
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div className="h-24 animate-pulse rounded-xl bg-muted/60" key={index} />
          ))}
        </div>
        <div className="h-64 animate-pulse rounded-xl bg-muted/60" />
      </div>
    );
  }

  const change = detail.data;
  const canEdit = EDITABLE_STATUSES.includes(change.status);
  const canCancel = CANCELLABLE_STATUSES.includes(change.status) && mayCancel;
  const canExecute =
    EXECUTABLE_STATUSES.includes(change.status) &&
    change.approvals.every(
      (approval) => approval.status === "APPROVED" || approval.status === "NOT_REQUIRED"
    ) &&
    change.approvals.length > 0 &&
    mayExecute;
  const canClose = change.status === "SUCCESSFUL" && mayClose;
  const executing = EXECUTION_STATUSES.includes(change.status);
  const stepsDone = change.steps.filter(
    (step) => step.status === "PASSED" || step.status === "SKIPPED"
  ).length;
  const pendingApprovals = change.approvals.filter(
    (approval) => approval.status === "PENDING"
  ).length;
  const requiredLevels = approvalLevelsFor(change.riskLevel);
  const missingApprovalRows = requiredLevels.filter(
    (level) => !change.approvals.some((approval) => approval.level === level)
  );
  const showFailedBanner =
    FAILED_STATUSES.includes(change.status) && change.incidents.length === 0;

  /** SoD pre-check against the signed-in principal (server-enforced; P19). */
  const sessionUserId = permissionUser?.id ?? sessionData?.user?.id;
  const sodBlocked = Boolean(
    sessionUserId &&
      change.requester.id === sessionUserId &&
      SOD_GATED_RISK_LEVELS.includes(change.riskLevel)
  );

  const confirmRun = () => {
    if (!confirmAction) return;
    updateChange.mutate(
      { id: change.id, data: { action: confirmAction } },
      {
        onSuccess: () => {
          setConfirmAction(null);
          void detail.refetch();
        },
        onError: () => setConfirmAction(null),
      }
    );
  };

  const submitDecision = () => {
    if (!decision) return;
    const trimmed = comment.trim();
    if (decision.decision === "REJECTED" && trimmed.length < 4) return;
    decide.mutate(
      {
        changeId: change.id,
        payload: {
          level: decision.level,
          decision: decision.decision,
          comment: trimmed || undefined,
        },
      },
      {
        onSuccess: () => {
          setDecision(null);
          setComment("");
          void detail.refetch();
        },
      }
    );
  };

  const submitExecute = () => {
    executeChange.mutate(
      {
        id: change.id,
        payload: {
          failAt: failAt === "APPLY" || failAt === "VALIDATE" ? failAt : null,
        },
      },
      { onSuccess: () => setExecuteOpen(false) }
    );
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <div className="flex flex-col gap-3">
        <div>
          <Button
            onClick={() => setActiveView("changes.all")}
            size="sm"
            variant="ghost"
          >
            <ArrowLeft aria-hidden="true" />
            All Changes
          </Button>
        </div>
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-tech text-sm font-semibold ltr-technical text-muted-foreground">
                {change.number}
              </span>
              <StatusBadge
                config={lookupStatusConfig(CHANGE_STATUS_UI, change.status)}
              />
              <StatusBadge
                config={lookupStatusConfig(CHANGE_TYPE_UI, change.type)}
              />
              <ChangeRiskBadge value={change.riskLevel} />
            </div>
            <h1 className="text-xl font-semibold tracking-tight md:text-2xl">
              {change.title}
            </h1>
            {change.description && (
              <p className="max-w-3xl whitespace-pre-wrap text-sm text-muted-foreground">
                {change.description}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 md:shrink-0">
            {canEdit && (
              <>
                <Button
                  onClick={() => setWizardOpen(true)}
                  size="sm"
                  variant="outline"
                >
                  <Pencil aria-hidden="true" />
                  Edit
                </Button>
                <Button
                  onClick={() => setConfirmAction("SUBMIT")}
                  size="sm"
                  variant="outline"
                >
                  <Send aria-hidden="true" />
                  Submit for approval
                </Button>
              </>
            )}
            {canExecute && (
              <Button onClick={() => setExecuteOpen(true)} size="sm">
                <Play aria-hidden="true" />
                Execute
              </Button>
            )}
            {canClose && (
              <Button
                onClick={() => setConfirmAction("CLOSE")}
                size="sm"
                variant="outline"
              >
                <CheckCircle2 aria-hidden="true" />
                Mark closed
              </Button>
            )}
            {canCancel && (
              <Button
                onClick={() => setConfirmAction("CANCEL")}
                size="sm"
                variant="ghost"
              >
                <Trash2 aria-hidden="true" className="text-danger" />
                Cancel change
              </Button>
            )}
          </div>
        </div>
        {/* Live-state banner */}
        {executing && (
          <p className="flex items-start gap-2 rounded-lg border border-info/25 bg-info-subtle px-3 py-2 text-xs text-info">
            <LoaderCircle
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0 animate-spin"
            />
            Execution in progress — the step timeline below live-updates every 2 s.
          </p>
        )}
      </div>

      {/* Outcome banners (4-b) */}
      {change.status === "SUCCESSFUL" && (
        <div className="flex items-start gap-2 rounded-lg border border-success/25 bg-success-subtle px-3 py-2 text-xs text-success">
          <CheckCircle2 aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          All steps passed — the change completed successfully. Mark it closed to
          sign off the record.
        </div>
      )}
      {showFailedBanner && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-danger/25 bg-danger-subtle px-3 py-2 text-xs text-danger">
          <CircleX aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            {change.status === "ROLLBACK_FAILED"
              ? "The change failed AND the rollback could not be completed — investigate before re-attempting."
              : "The change failed during execution. Correlate an incident so the response is tracked."}
          </span>
          <Button
            disabled={createIncident.isPending}
            onClick={() =>
              createIncident.mutate({
                changeId: change.id,
                    })
            }
            size="sm"
            type="button"
            variant="outline"
          >
            <Siren aria-hidden="true" />
            Create incident from failed change
          </Button>
        </div>
      )}

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard
          description={`${change.riskScore}/100 score`}
          icon={ClipboardList}
          label="Risk"
          value={change.riskLevel}
        />
        <KpiCard
          icon={GitPullRequest}
          label="Devices in scope"
          value={change.devices.length}
        />
        <KpiCard
          description={`${stepsDone}/${change.steps.length} passed or skipped`}
          icon={Play}
          label="Steps done"
          value={`${stepsDone}/${change.steps.length}`}
        />
        <KpiCard
          description={
            missingApprovalRows.length > 0
              ? `Missing rows: ${missingApprovalRows.join(", ")}`
              : "Per risk policy"
          }
          icon={ClipboardList}
          label="Approvals pending"
          value={pendingApprovals}
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        {/* Details */}
        <SectionCard title="Details">
          <dl className="flex flex-col gap-2 text-sm">
            {[
              {
                label: "Site",
                value: change.site
                  ? `${change.site.name} (${change.site.code})`
                  : "—",
              },
              {
                label: "Requester",
                value: change.requester?.name ?? change.requester?.email ?? "—",
              },
              {
                label: "Owner",
                value: change.owner?.name ?? "—",
              },
              {
                label: "Technical owner",
                value: change.technicalOwner?.name ?? "—",
              },
              {
                label: "Created",
                value: formatDate(change.createdAt),
              },
            ].map((row) => (
              <div className="flex items-center justify-between gap-3" key={row.label}>
                <dt className="shrink-0 text-xs text-muted-foreground">{row.label}</dt>
                <dd className="min-w-0 truncate text-end">{row.value}</dd>
              </div>
            ))}
            <div className="mt-1 rounded-lg border bg-surface-subtle/60 p-3">
              <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <CalendarClock aria-hidden="true" className="size-3.5" />
                Schedule window
              </p>
              {change.scheduledStart ? (
                <>
                  <p className="mt-1 text-sm tabular-nums">
                    {formatDate(change.scheduledStart)} → {formatDate(change.scheduledEnd)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Execute is available while the change is APPROVED or SCHEDULED.
                  </p>
                </>
              ) : (
                <p className="mt-1 text-sm text-muted-foreground">Unscheduled</p>
              )}
            </div>
          </dl>
        </SectionCard>

        {/* Plans */}
        <SectionCard
          description="Prose plans are rendered as written — no pre-formatting"
          title="Plans"
        >
          <div className="flex flex-col gap-4">
            <PlanBlock label="Implementation" text={change.implementationPlan} />
            <PlanBlock label="Validation" text={change.validationPlan} />
            <PlanBlock label="Rollback" text={change.rollbackPlan} />
          </div>
        </SectionCard>
      </div>

      {/* Devices */}
      <SectionCard
        description={`${change.devices.length} device${change.devices.length === 1 ? "" : "s"} targeted`}
        title="Devices"
      >
        {change.devices.length === 0 ? (
          <EmptyState
            description="This change has no device links."
            icon={GitPullRequest}
            title="No devices"
          />
        ) : (
          <ul className="max-h-96 divide-y overflow-y-auto">
            {change.devices.map((device) => (
              <li className="flex flex-wrap items-center gap-3 py-2" key={device.linkId}>
                <button
                  className="min-w-0 flex-1 truncate text-start font-tech text-sm ltr-technical hover:text-primary hover:underline"
                  onClick={() =>
                    setActiveView("network.device-detail", { deviceId: device.deviceId })
                  }
                  type="button"
                >
                  {device.hostname}
                </button>
                <span className="hidden text-xs text-muted-foreground sm:inline">
                  {device.siteCode ?? "no site"}
                </span>
                <StatusBadge config={getStatusConfig(SEVERITY, device.criticality)} />
                {device.result && (
                  <StatusBadge
                    config={lookupStatusConfig(CHANGE_DEVICE_RESULT_UI, device.result)}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {/* Steps timeline */}
      <SectionCard
        description={
          executing
            ? "Live — statuses stream from the execution engine"
            : "Ordered execution plan — appended rollback steps appear after a failure"
        }
        title="Steps"
      >
        {change.steps.length === 0 ? (
          <EmptyState
            description="This change has no execution steps."
            icon={Play}
            title="No steps"
          />
        ) : (
          <div className="max-h-[480px] overflow-y-auto pt-1">
            <StepTimeline steps={change.steps} />
          </div>
        )}
      </SectionCard>

      <div className="grid gap-5 xl:grid-cols-2">
        {/* Approvals */}
        <SectionCard
          actions={
            change.status === "AWAITING_APPROVAL" && (
              <span className="text-xs text-muted-foreground">
                Decisions are recorded under your signed-in account
              </span>
            )
          }
          description="Levels required by the risk policy — decide under your signed-in account"
          title="Approvals"
        >
          <div className="flex flex-col gap-2">
            {requiredLevels.map((level) => {
              const approval = change.approvals.find((row) => row.level === level);
              const levelConfig = lookupStatusConfig(CHANGE_APPROVAL_LEVEL_UI, level);
              const statusConfig = lookupStatusConfig(
                CHANGE_APPROVAL_STATUS_UI,
                approval?.status
              );
              const isPending = approval?.status === "PENDING";
              return (
                <div
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border p-3"
                  key={level}
                >
                  <StatusIcon className={levelConfig.iconClass} icon={levelConfig.icon} />
                  <span className="text-sm font-medium">{resolveStatusLabel(levelConfig)}</span>
                  <StatusBadge config={statusConfig} />
                  <span className="ms-auto text-xs text-muted-foreground">
                    {approval?.approverName ?? "unassigned"}
                    {approval?.decidedAt
                      ? ` · ${formatDate(approval.decidedAt, "MMM d HH:mm")}`
                      : ""}
                  </span>
                  {/* POL-001 — quorum progress: a level with quorumRequired
                      > 1 (CAB on CRITICAL changes) shows how many DISTINCT
                      approvers have validly approved so far. */}
                  {approval && approval.quorumRequired > 1 && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
                      {approval.decisions.filter(
                        (d) =>
                          d.decision === "APPROVED" &&
                          d.expiresAt !== null &&
                          new Date(d.expiresAt).getTime() > Date.now()
                      ).length}/{approval.quorumRequired} distinct approvals
                    </span>
                  )}
                  {/* POL-003 — validity horizon of the latest APPROVED
                      decision, surfaced so approvers see the expiry. */}
                  {approval?.decisions.some((d) => d.decision === "APPROVED" && d.expiresAt) && (
                    <span className="text-xs text-muted-foreground">
                      valid until{" "}
                      {formatDate(
                        approval.decisions
                          .filter((d) => d.decision === "APPROVED" && d.expiresAt)
                          .sort(
                            (a, b) =>
                              new Date(a.expiresAt ?? 0).getTime() -
                              new Date(b.expiresAt ?? 0).getTime()
                          )[0].expiresAt as string,
                        "MMM d, yyyy"
                      )}
                    </span>
                  )}
                  {approval?.comment && (
                    <p className="w-full text-xs text-muted-foreground">
                      “{approval.comment}”
                    </p>
                  )}
                  {isPending && change.status === "AWAITING_APPROVAL" && (
                    <div className="flex w-full items-center gap-2">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-block">
                            <Button
                              aria-label={`Approve ${resolveStatusLabel(levelConfig)}`}
                              className="h-8"
                              disabled={
                                sodBlocked ||
                                !levelEntitled(level) ||
                                decide.isPending ||
                                updateChange.isPending
                              }
                              onClick={() => {
                                setComment("");
                                setDecision({ level, decision: "APPROVED" });
                              }}
                              size="sm"
                              type="button"
                              variant="outline"
                            >
                              Approve
                            </Button>
                          </span>
                        </TooltipTrigger>
                        {sodBlocked ? (
                          <TooltipContent>
                            Blocked by separation of duties — the requester cannot
                            approve a {change.riskLevel} change
                          </TooltipContent>
                        ) : (
                          !levelEntitled(level) && (
                            <TooltipContent>
                              {levelEntitlementHint(level)}
                            </TooltipContent>
                          )
                        )}
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-block">
                            <Button
                              aria-label={`Reject ${resolveStatusLabel(levelConfig)}`}
                              className="h-8"
                              disabled={
                                sodBlocked ||
                                !levelEntitled(level) ||
                                decide.isPending ||
                                updateChange.isPending
                              }
                              onClick={() => {
                                setComment("");
                                setDecision({ level, decision: "REJECTED" });
                              }}
                              size="sm"
                              type="button"
                              variant="outline"
                            >
                              <XCircle aria-hidden="true" className="text-danger" />
                              Reject
                            </Button>
                          </span>
                        </TooltipTrigger>
                        {sodBlocked ? (
                          <TooltipContent>
                            Blocked by separation of duties — the requester cannot
                            reject a {change.riskLevel} change
                          </TooltipContent>
                        ) : (
                          !levelEntitled(level) && (
                            <TooltipContent>
                              {levelEntitlementHint(level)}
                            </TooltipContent>
                          )
                        )}
                      </Tooltip>
                      {sodBlocked && (
                        <span className="text-xs text-warning">
                          SoD — switch the acting user to decide
                        </span>
                      )}
                      {!levelEntitled(level) && !sodBlocked && (
                        <span className="text-xs text-muted-foreground">
                          Not entitled for this level
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {missingApprovalRows.length > 0 && (
              <p className="flex items-center gap-1.5 text-xs text-warning">
                <CircleAlert aria-hidden="true" className="size-3.5" />
                No approval rows yet for: {missingApprovalRows.join(", ")} — submit the
                change to create them.
              </p>
            )}
            {change.status === "DRAFT" && (
              <p className="text-xs text-muted-foreground">
                Draft changes carry no approval rows — they are created on submit per the
                {` ${change.riskLevel}`} policy ({requiredLevels.join(" → ")}) for
                approvers to action in the approvals queue.
              </p>
            )}
          </div>
        </SectionCard>

        {/* Linked records */}
        <SectionCard
          description="Pre/post-change snapshots and correlated incidents"
          title="Linked records"
        >
          <div className="flex flex-col gap-4">
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Snapshots ({change.snapshots.length})
              </p>
              {change.snapshots.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  None yet — pre/post-change backups appear here when the executor runs.
                </p>
              ) : (
                <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto text-sm">
                  {change.snapshots.map((snapshot) => (
                    <li className="flex items-center gap-2" key={snapshot.id}>
                      <span className="font-tech ltr-technical">
                        {snapshot.hostname} v{snapshot.version}
                      </span>
                      <StatusBadge
                        config={getStatusConfig(SNAPSHOT_STATUS, snapshot.status)}
                      />
                      <Badge variant="outline">{snapshot.source}</Badge>
                      <span className="ms-auto text-xs tabular-nums text-muted-foreground">
                        {formatDistanceToNow(new Date(snapshot.createdAt), {
                          addSuffix: true,
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Incidents ({change.incidents.length})
              </p>
              {change.incidents.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No incidents correlated to this change.
                </p>
              ) : (
                <ul className="flex flex-col gap-1 text-sm">
                  {change.incidents.map((incident) => (
                    <li className="flex flex-wrap items-center gap-2" key={incident.id}>
                      <span className="font-tech ltr-technical">{incident.number}</span>
                      <StatusBadge
                        config={lookupStatusConfig(INCIDENT_SEVERITY, incident.severity)}
                      />
                      <StatusBadge
                        config={lookupStatusConfig(INCIDENT_STATUS_UI, incident.status)}
                      />
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {incident.title}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </SectionCard>
      </div>

      {/* Pre-checks (when seeded or produced by the engine) */}
      {change.preChecks.length > 0 && (
        <SectionCard
          description="Engine pre-check results merge into this list per device"
          title="Pre-checks"
        >
          <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto text-sm">
            {change.preChecks.map((preCheck, index) => (
              <li className="flex items-start gap-2" key={`${preCheck.name}-${index}`}>
                <FileText aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{preCheck.name}</span>
                  {preCheck.detail && (
                    <span className="block text-xs text-muted-foreground">
                      {preCheck.detail}
                    </span>
                  )}
                </span>
                <Badge
                  className={
                    preCheck.status === "FAILED"
                      ? "border-danger/25 bg-danger-subtle text-danger"
                      : preCheck.status === "PASSED"
                        ? "border-success/25 bg-success-subtle text-success"
                        : undefined
                  }
                  variant="outline"
                >
                  {preCheck.status}
                </Badge>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {/* Edit wizard (DRAFT only — same component as create, edit mode) */}
      <ChangeWizard
        change={change}
        onOpenChange={setWizardOpen}
        open={wizardOpen}
      />

      {/* Execute dialog (Task 4-b) */}
      <Dialog onOpenChange={setExecuteOpen} open={executeOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              Execute <span className="font-tech ltr-technical">{change.number}</span>?
            </DialogTitle>
            <DialogDescription>
              Queues a CHANGE_EXECUTE job — the worker drives each step
              (pre-checks, pre-change backup, apply, validation). The run is
              attributed to your signed-in account.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div>
              <p className="text-xs font-medium text-muted-foreground">
                Steps preview ({change.steps.length})
              </p>
              <ol className="mt-1 flex max-h-40 flex-col gap-1 overflow-y-auto rounded-lg border bg-surface-subtle/60 p-2 text-sm">
                {change.steps.map((step) => (
                  <li className="flex items-center gap-2" key={step.id}>
                    <span className="font-tech text-xs tabular-nums text-muted-foreground">
                      {step.order}.
                    </span>
                    <span className="min-w-0 flex-1 truncate">{step.name}</span>
                    <Badge className="font-tech" variant="outline">
                      {step.type}
                    </Badge>
                  </li>
                ))}
              </ol>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fail-at-select">Simulate failure at</Label>
              <Select onValueChange={setFailAt} value={failAt}>
                <SelectTrigger id="fail-at-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">None — run the happy path</SelectItem>
                  <SelectItem value="APPLY">APPLY — simulated apply failure</SelectItem>
                  <SelectItem value="VALIDATE">
                    VALIDATE — simulated validation failure
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <Info aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
                Demo control — forces the engine down its rollback path (restore
                pre-change config, post-rollback validation + backup).
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={() => setExecuteOpen(false)}
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={executeChange.isPending}
              onClick={submitExecute}
              type="button"
            >
              {executeChange.isPending && (
                <LoaderCircle aria-hidden="true" className="animate-spin" />
              )}
              Queue execution
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Approval decision dialog (Task 4-b) */}
      <Dialog
        onOpenChange={(open) => !open && setDecision(null)}
        open={decision !== null}
      >
        <DialogContent className="sm:max-w-md">
          {decision && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {decision.decision === "APPROVED" ? "Approve" : "Reject"}{" "}
                  {resolveStatusLabel(lookupStatusConfig(CHANGE_APPROVAL_LEVEL_UI, decision.level))}
                </DialogTitle>
                <DialogDescription>
                  {decision.decision === "APPROVED"
                    ? "Recorded under your signed-in account — a comment is optional."
                    : "Recorded under your signed-in account — a short reason (min 4 characters) is required."}
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-2">
                <Label htmlFor="detail-approval-comment">
                  Comment {decision.decision === "APPROVED" ? "(optional)" : "(required)"}
                </Label>
                <Textarea
                  aria-label="Decision comment"
                  id="detail-approval-comment"
                  onChange={(event) => setComment(event.target.value)}
                  rows={3}
                  value={comment}
                />
              </div>
              <DialogFooter>
                <Button onClick={() => setDecision(null)} type="button" variant="ghost">
                  Cancel
                </Button>
                <Button
                  className={
                    decision.decision === "REJECTED"
                      ? "bg-danger text-white hover:bg-danger/90"
                      : undefined
                  }
                  disabled={
                    decide.isPending ||
                    (decision.decision === "REJECTED" && comment.trim().length < 4)
                  }
                  onClick={submitDecision}
                  type="button"
                >
                  {decision.decision === "APPROVED" ? "Approve" : "Reject"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Submit / Cancel / Close confirmation */}
      <AlertDialog
        onOpenChange={(open) => !open && setConfirmAction(null)}
        open={confirmAction !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction === "SUBMIT"
                ? `Submit ${change.number} for approval?`
                : confirmAction === "CLOSE"
                  ? `Mark ${change.number} closed?`
                  : `Cancel ${change.number}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction === "SUBMIT"
                ? `The draft moves to AWAITING_APPROVAL and PENDING approval rows are created per the ${change.riskLevel} policy: ${requiredLevels.join(", ")}.`
                : confirmAction === "CLOSE"
                  ? "The successful change is signed off as CLOSED. Closed changes leave every active queue."
                  : "The change is marked CANCELLED and leaves every planning queue. Execution states cannot be cancelled once the engine starts."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep as is</AlertDialogCancel>
            <AlertDialogAction
              className={
                confirmAction === "CANCEL"
                  ? "bg-danger text-white hover:bg-danger/90"
                  : undefined
              }
              disabled={updateChange.isPending}
              onClick={(event) => {
                event.preventDefault();
                confirmRun();
              }}
            >
              {updateChange.isPending && (
                <LoaderCircle aria-hidden="true" className="animate-spin" />
              )}
              {confirmAction === "SUBMIT"
                ? "Submit"
                : confirmAction === "CLOSE"
                  ? "Mark closed"
                  : "Cancel change"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
