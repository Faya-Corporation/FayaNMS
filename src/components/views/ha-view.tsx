"use client";

import { useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { formatDistanceToNow } from "date-fns";
import { ArrowRight, CircleCheck, CircleDashed, ShieldCheck } from "lucide-react";

import { useFailoverTest, useHaTopology } from "@/hooks/api/use-ha";
import { useToast } from "@/hooks/use-toast";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { HighRiskActionDialog } from "@/components/domain/high-risk-action-dialog";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { StatusBadge } from "@/components/domain/status-badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  pairModeBadge,
  readinessBandBadge,
  testResultBadge,
} from "@/lib/ha/band";
import {
  FAILOVER_STAGE_SLEEP_MS,
  failoverStagesForMode,
} from "@/lib/ha/topology";
import { DEVICE_STATUS, getStatusConfig } from "@/lib/domain/status";
import type { HaPairRow } from "@/lib/api-client";
import { ApiError } from "@/lib/api-client";
import { useNavigationStore } from "@/stores/navigation";
import { cn } from "@/lib/utils";

/**
 * HA / DR topology (Phase 14-c) against /api/v1/ha:
 *  - HA pair cards with live member status dots, mode/VIP badges and the
 *    latest failover state derived from HA_FAILOVER_TEST audit rows;
 *  - guarded failover test per pair (HighRiskActionDialog pattern — the
 *    staged progress ticker walks the same deterministic cadence the
 *    server simulation uses, via FAILOVER_STAGE_SLEEP_MS);
 *  - DR readiness matrix with deterministic scores + band badges
 *    (icon + text, never color-only).
 */
export function HaView() {
  const t = useTranslations("ha");
  const setActiveView = useNavigationStore((state) => state.setActiveView);
  const { toast } = useToast();

  const topology = useHaTopology();
  const failover = useFailoverTest();

  const [testTarget, setTestTarget] = useState<HaPairRow | null>(null);
  const [stageIdx, setStageIdx] = useState(-1);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const pairs = useMemo(() => topology.data?.pairs ?? [], [topology.data]);
  const drSites = useMemo(() => topology.data?.drSites ?? [], [topology.data]);

  const stages = useMemo(
    () => (testTarget ? failoverStagesForMode(testTarget.mode) : []),
    [testTarget]
  );

  const stopTicker = () => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  };

  /** Walk the documented stage cadence so the UI mirrors the server run. */
  const startTicker = () => {
    stopTicker();
    setStageIdx(0);
    let elapsed = 0;
    stages.forEach((stage, index) => {
      elapsed += FAILOVER_STAGE_SLEEP_MS[stage] ?? 1000;
      timersRef.current.push(setTimeout(() => setStageIdx(index + 1), elapsed));
    });
  };

  const openTestDialog = (pair: HaPairRow) => {
    setTestTarget(pair);
    setStageIdx(-1);
  };

  const runTest = async (): Promise<React.ReactNode> => {
    if (!testTarget) return null;
    startTicker();
    try {
      const result = await failover.mutateAsync({ pairId: testTarget.pairId });
      setStageIdx(stages.length);
      const resultLabel =
        result.result === "passed"
          ? t("test.testPassed")
          : t("test.testDegraded");
      toast({
        title: t("test.toast.title", {
          result: resultLabel,
          pair: result.pairName,
        }),
        description: t("test.toast.description", {
          correlation: result.correlationId,
          duration: `${(result.durationMs / 1000).toFixed(1)}s`,
          stages: result.stages.length,
        }),
      });
      return (
        <div className="flex flex-col gap-3">
          <div className="rounded-lg border bg-surface-subtle p-3 text-sm">
            <p className="font-medium">
              {t("test.success.title", { correlation: result.correlationId })}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("test.success.description", {
                stages: result.stages.length,
                duration: `${(result.durationMs / 1000).toFixed(1)}s`,
                activeMember: result.activeMember,
              })}
            </p>
            {result.offlineMembers.length > 0 ? (
              <p className="mt-2 text-xs text-warning">
                {t("test.degradedNote", {
                  members: result.offlineMembers.join(", "),
                })}
              </p>
            ) : null}
          </div>
          <Button
            onClick={() => setActiveView("ops.events")}
            size="sm"
            variant="outline"
          >
            {t("test.openEvents")}
            <ArrowRight aria-hidden="true" />
          </Button>
        </div>
      );
    } catch (error) {
      stopTicker();
      setStageIdx(-1);
      const message =
        error instanceof ApiError && error.code === "HA_TEST_IN_PROGRESS"
          ? t("test.testInProgress")
          : error instanceof Error
            ? error.message
            : String(error);
      throw new Error(message);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader description={t("description")} title={t("title")} />

      {topology.isError ? (
        <ErrorState
          onRetry={() => void topology.refetch()}
          reason={topology.error.message}
          title={t("errorTitle")}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {/* ── HA pairs ─────────────────────────────────────────────── */}
          <SectionCard
            description={t("pairs.description")}
            title={t("pairs.title")}
          >
            {pairs.length === 0 ? (
              <EmptyState
                description={t("pairs.emptyDescription")}
                icon={ShieldCheck}
                title={t("pairs.emptyTitle")}
              />
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                {pairs.map((pair) => {
                  const mode = pairModeBadge(pair.mode);
                  const lastTest = testResultBadge(pair.failover.lastResult);
                  return (
                    <div
                      className="flex flex-col gap-3 rounded-lg border p-4"
                      key={pair.pairId}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-medium leading-none">
                          {pair.name}
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusBadge config={mode} withIcon />
                          <StatusBadge config={lastTest} withIcon />
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span>
                          {t("pairs.vip")}:{" "}
                          <span className="font-tech ltr-technical text-foreground">
                            {pair.vip}
                          </span>
                        </span>
                        <span className="font-tech ltr-technical">
                          {pair.siteCode}
                        </span>
                      </div>

                      <div className="flex flex-col gap-1.5 text-xs">
                        <span className="text-muted-foreground">
                          {t("pairs.members")}
                        </span>
                        <div className="flex flex-wrap gap-2">
                          {pair.members.map((member) => {
                            const status = getStatusConfig(
                              DEVICE_STATUS,
                              member.status
                            );
                            return (
                              <span
                                className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1"
                                key={member.deviceId}
                              >
                                <span
                                  aria-hidden="true"
                                  className={cn(
                                    "size-2 rounded-full",
                                    status.dotClass
                                  )}
                                />
                                <span className="font-tech ltr-technical">
                                  {member.hostname}
                                </span>
                              </span>
                            );
                          })}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs">
                        <div className="flex flex-col gap-0.5">
                          <span className="text-muted-foreground">
                            {t("pairs.activeMember")}:{" "}
                            <span className="font-tech ltr-technical">
                              {pair.failover.activeMember}
                            </span>
                          </span>
                          <span className="text-muted-foreground">
                            {t("pairs.lastTest")}:{" "}
                            {pair.failover.lastTestedAt
                              ? formatDistanceToNow(
                                  new Date(pair.failover.lastTestedAt),
                                  { addSuffix: true }
                                )
                              : "—"}
                            {" · "}
                            {t("pairs.testCount", {
                              count: pair.failover.testCount,
                            })}
                          </span>
                        </div>
                        <Button
                          onClick={() => openTestDialog(pair)}
                          size="sm"
                          variant="outline"
                        >
                          {t("pairs.runTest")}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </SectionCard>

          {/* ── DR readiness matrix ──────────────────────────────────── */}
          <SectionCard
            description={t("drMatrix.description")}
            title={t("drMatrix.title")}
          >
            {drSites.length === 0 ? (
              <EmptyState
                description={t("drMatrix.emptyDescription")}
                icon={ShieldCheck}
                title={t("drMatrix.emptyTitle")}
              />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("drMatrix.primary")}</TableHead>
                      <TableHead>{t("drMatrix.secondary")}</TableHead>
                      <TableHead>{t("drMatrix.rpo")}</TableHead>
                      <TableHead>{t("drMatrix.rto")}</TableHead>
                      <TableHead>{t("drMatrix.replication")}</TableHead>
                      <TableHead>{t("drMatrix.readiness")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {drSites.map((site) => {
                      const band = readinessBandBadge(site.readiness.band);
                      return (
                        <TableRow key={`${site.primary}-${site.secondary}`}>
                          <TableCell className="font-tech ltr-technical">
                            {site.primary}
                          </TableCell>
                          <TableCell className="font-tech ltr-technical">
                            {site.secondary}
                          </TableCell>
                          <TableCell>
                            {t("drMatrix.minutes", {
                              count: site.rpoTargetMinutes,
                            })}
                          </TableCell>
                          <TableCell>
                            {t("drMatrix.minutes", {
                              count: site.rtoTargetMinutes,
                            })}
                          </TableCell>
                          <TableCell>
                            {t(`drMatrix.replicationTech.${site.replicationTech}`)}
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-col gap-1">
                              <div className="flex items-center gap-2">
                                <span className="font-tech ltr-technical text-sm font-medium">
                                  {site.readiness.score}
                                </span>
                                <StatusBadge config={band} withIcon />
                              </div>
                              <p className="text-xs text-muted-foreground">
                                {t("drMatrix.factorsBackupRate", {
                                  rate: site.readiness.backupSuccessRate,
                                })}{" "}
                                ·{" "}
                                {t("drMatrix.factorsOpenCritical", {
                                  count: site.readiness.openCritical,
                                })}{" "}
                                ·{" "}
                                {t("drMatrix.factorsMemberOnline", {
                                  rate: Math.round(
                                    site.readiness.memberOnlineRatio * 100
                                  ),
                                })}
                              </p>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </SectionCard>
        </div>
      )}

      {/* ── Guarded failover test ────────────────────────────────────── */}
      <HighRiskActionDialog
        confirmHint={testTarget?.pairId ?? "pairId"}
        confirmLabel={t("test.confirmLabel")}
        confirmPhrase={testTarget?.pairId ?? ""}
        danger={false}
        description={t("test.description")}
        impact={
          testTarget
            ? [
                {
                  label: t("test.impact.pair"),
                  value: (
                    <span className="font-tech ltr-technical">
                      {testTarget.pairId}
                    </span>
                  ),
                },
                {
                  label: t("test.impact.mode"),
                  value: (
                    <StatusBadge
                      config={pairModeBadge(testTarget.mode)}
                      withIcon
                    />
                  ),
                },
                {
                  label: t("test.impact.vip"),
                  value: (
                    <span className="font-tech ltr-technical">
                      {testTarget.vip}
                    </span>
                  ),
                },
                {
                  label: t("test.impact.members"),
                  value: (
                    <span className="font-tech ltr-technical">
                      {testTarget.members.map((m) => m.hostname).join(" + ")}
                    </span>
                  ),
                },
                {
                  label: t("test.impact.duration"),
                  value: <span>{t("test.impact.durationValue")}</span>,
                },
              ]
            : []
        }
        onOpenChange={(open) => {
          if (!open) {
            stopTicker();
            setStageIdx(-1);
          }
        }}
        onConfirm={runTest}
        open={testTarget !== null}
        title={t("test.title", { pair: testTarget?.name ?? "" })}
      >
        {testTarget ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              {t("test.stagesTitle")}
            </p>
            {stages.map((stage, index) => {
              const stageDone = stageIdx > index;
              const stageRunning = stageIdx === index;
              const stageKey =
                stage === "promote-back"
                  ? "promoteBack"
                  : stage === "keep-promoted"
                    ? "keepPromoted"
                    : stage;
              return (
                <div
                  className="flex items-center gap-2 text-xs"
                  key={stage}
                >
                  {stageDone ? (
                    <CircleCheck
                      aria-hidden="true"
                      className="size-3.5 text-success"
                    />
                  ) : (
                    <CircleDashed
                      aria-hidden="true"
                      className={cn(
                        "size-3.5",
                        stageRunning
                          ? "animate-pulse text-info"
                          : "text-muted-foreground/50"
                      )}
                    />
                  )}
                  <span
                    className={cn(
                      stageDone
                        ? "text-foreground"
                        : stageRunning
                          ? "text-foreground"
                          : "text-muted-foreground/60"
                    )}
                  >
                    {t(`test.stages.${stageKey}`)}
                  </span>
                </div>
              );
            })}
            <div className="flex items-center gap-2 text-xs">
              {stageIdx >= stages.length && stages.length > 0 ? (
                <CircleCheck
                  aria-hidden="true"
                  className="size-3.5 text-success"
                />
              ) : (
                <CircleDashed
                  aria-hidden="true"
                  className="size-3.5 text-muted-foreground/50"
                />
              )}
              <span
                className={cn(
                  stageIdx >= stages.length && stages.length > 0
                    ? "text-foreground"
                    : "text-muted-foreground/60"
                )}
              >
                {t("test.stages.complete")}
              </span>
            </div>
          </div>
        ) : null}
      </HighRiskActionDialog>
    </div>
  );
}
