"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { format, formatDistanceToNow } from "date-fns";
import {
  ArrowLeft,
  CloudUpload,
  Edit,
  History,
  PlugZap,
  Siren,
  TriangleAlert,
} from "lucide-react";

import { useCreateJob } from "@/hooks/api/use-jobs";
import { useToast } from "@/hooks/use-toast";
import { DeviceVendorIcon, NetworkDeviceIcon } from "@/components/icons";
import {
  useDevice,
  useDeviceAudit,
} from "@/hooks/api/use-device-detail";
import { useTestConnection } from "@/hooks/api/use-devices";
import { BackupComplianceBadge } from "@/components/domain/backup-status-badge";
import { DeviceStatusBadge } from "@/components/domain/device-status-badge";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { KpiCard } from "@/components/domain/kpi-card";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { StatusBadge } from "@/components/domain/status-badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { deviceRoleLabelFor } from "@/lib/icons/device-role-meta";
import { getLifecycle } from "@/lib/firmware/lifecycle";
import { lifecycleBadge } from "@/components/views/firmware-band";
import { useStatusLabel } from "@/hooks/use-status-label";
import type { DeviceAuditRow, DeviceDetail, TestConnectionResult } from "@/lib/api-client";
import { useNavigationStore } from "@/stores/navigation";
import { AddDeviceSheet } from "@/components/device/device-form-sheet";
import { HostKeyCard } from "@/components/device/host-key-card";
import { DeviceHealthTab } from "@/components/device/device-health-tab";
import { DeviceInterfacesTab } from "@/components/device/device-interfaces-tab";
import { DeviceConfigTab } from "@/components/device/device-config-tab";
import {
  BackupsTab,
  ChangesTab,
  DeviceAlertsTab,
  DeviceAuditTab,
  IncidentsTab,
} from "@/components/device/device-records-tabs";
import { AssistantTab } from "@/components/device/assistant-tab";

type DetailTab =
  | "overview"
  | "health"
  | "interfaces"
  | "config"
  | "backups"
  | "changes"
  | "incidents"
  | "alerts"
  | "assistant"
  | "audit";

const TAB_ITEMS: DetailTab[] = [
  "overview",
  "health",
  "interfaces",
  "config",
  "backups",
  "changes",
  "incidents",
  "alerts",
  "assistant",
  "audit",
];

function formatUptime(seconds: string | null): string {
  if (!seconds) return "—";
  const total = Number(seconds);
  if (!Number.isFinite(total)) return "—";
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function relative(iso: string | null | undefined): string {
  if (!iso) return "—";
  return formatDistanceToNow(new Date(iso), { addSuffix: true });
}

/**
 * Device detail (Phase 2): header with quick actions + lazy-loaded tabs
 * (overview / health / interfaces / config / backups / changes / incidents /
 * alerts / assistant / audit). Radix Tabs unmount inactive panels, so each
 * tab fetches only while it is visible.
 */
export function DeviceDetailView() {
  const params = useNavigationStore((state) => state.params);
  const setActiveView = useNavigationStore((state) => state.setActiveView);
  const { toast } = useToast();
  const t = useTranslations("deviceDetail");
  const tCommon = useTranslations("common");

  const deviceId = params?.deviceId ?? null;
  const detail = useDevice(deviceId);

  const [tab, setTab] = useState<DetailTab>("overview");
  const [editOpen, setEditOpen] = useState(false);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const [lastTest, setLastTest] = useState<TestConnectionResult | null>(null);

  const testConnection = useTestConnection();
  const createJob = useCreateJob();

  // Reset transient state when switching between devices. Adjusting state
  // during render (keyed on the previous device id) avoids an effect-driven
  // cascading render while still remounting sub-tab data cleanly.
  const [prevDeviceId, setPrevDeviceId] = useState(deviceId);
  if (prevDeviceId !== deviceId) {
    setPrevDeviceId(deviceId);
    setTab("overview");
    setSelectedSnapshotId(null);
    setLastTest(null);
  }

  if (!deviceId) {
    return (
      <EmptyState
        actions={
          <Button onClick={() => setActiveView("network.devices")} variant="outline">
            <ArrowLeft aria-hidden="true" />
            {t("back")}
          </Button>
        }
        description={t("noDevice.description")}
        title={t("noDevice.title")}
      />
    );
  }

  if (detail.isError) {
    return (
      <div className="flex flex-col gap-4">
        <Button
          className="self-start"
          onClick={() => setActiveView("network.devices")}
          size="sm"
          variant="ghost"
        >
          <ArrowLeft aria-hidden="true" />
          {t("back")}
        </Button>
        <ErrorState
          onRetry={() => void detail.refetch()}
          reason={detail.error.message}
          title={t("error.title")}
        />
      </div>
    );
  }

  const device = detail.data;

  if (!device) {
    return (
      <div aria-busy="true" className="flex flex-col gap-4">
        <div className="h-8 w-40 animate-pulse rounded-md bg-muted/60" />
        <div className="h-24 animate-pulse rounded-xl bg-muted/60" />
        <div className="h-10 w-full max-w-2xl animate-pulse rounded-lg bg-muted/60" />
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-24 animate-pulse rounded-xl bg-muted/60" />
          ))}
        </div>
      </div>
    );
  }

  const handleTestConnection = () => {
    testConnection.mutate(device.id, {
      onSuccess: (result) => setLastTest(result),
    });
  };

  const testBannerTone = !lastTest
    ? null
    : lastTest.reachable && lastTest.ok
      ? "border-success/30 bg-success-subtle text-success"
      : lastTest.reachable
        ? "border-danger/30 bg-danger-subtle text-danger"
        : "border-warning/30 bg-warning-subtle text-warning";

  return (
    <div className="flex flex-col gap-4">
      <Button
        className="self-start"
        onClick={() => setActiveView("network.devices")}
        size="sm"
        variant="ghost"
      >
        <ArrowLeft aria-hidden="true" />
        {t("back")}
      </Button>

      {lastTest && testBannerTone && (
        <div
          className={cn(
            "flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm",
            testBannerTone
          )}
          role="status"
        >
          <PlugZap aria-hidden="true" className="size-4" />
          <span className="font-medium">
            {!lastTest.reachable
              ? t("test.workerUnreachable")
              : lastTest.ok
                ? lastTest.latencyMs !== null
                  ? t("test.okLatency", { latency: lastTest.latencyMs })
                  : t("test.ok")
                : t("test.failed")}
          </span>
          {lastTest.message && !lastTest.ok && (
            <span className="text-muted-foreground">{lastTest.message}</span>
          )}
          <button
            className="ms-auto text-xs underline-offset-2 hover:underline"
            onClick={() => setLastTest(null)}
            type="button"
          >
            {tCommon("dismiss")}
          </button>
        </div>
      )}

      <PageHeader
        actions={
          <>
            <DeviceStatusBadge value={device.status} />
            <Button
              disabled={testConnection.isPending}
              onClick={handleTestConnection}
              size="sm"
              variant="outline"
            >
              <PlugZap aria-hidden="true" />
              {t("test.action")}
            </Button>
            <Button
              disabled={device.status === "UNMANAGED" || createJob.isPending}
              onClick={() =>
                createJob.mutate(
                  { type: "CONFIG_BACKUP", deviceId: device.id },
                  { onSuccess: undefined }
                )
              }
              size="sm"
              variant="outline"
            >
              <CloudUpload aria-hidden="true" />
              {t("header.backupNow")}
            </Button>
          </>
        }
        breadcrumbs={[
          { label: t("header.breadcrumbNetwork") },
          { label: t("header.breadcrumbDevices") },
          { label: device.hostname },
        ]}
        description={
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            {/* Vendor glyph (decorative — the "Vendor · Model" text follows). */}
            <DeviceVendorIcon vendor={device.vendor.key} />
            <span>
              {[
                [device.vendor.name, device.model].filter(Boolean).join(" "),
                device.site ? `${device.site.name} (${device.site.code})` : null,
                device.role ? deviceRoleLabelFor(device.role) : null,
              ]
                .filter(Boolean)
                .join(" · ") || undefined}
            </span>
          </span>
        }
        primaryAction={
          <Button onClick={() => setEditOpen(true)} size="sm">
            <Edit aria-hidden="true" />
            {tCommon("edit")}
          </Button>
        }
        title={device.hostname}
        titleIcon={<NetworkDeviceIcon deviceType={device.role} size="lg" />}
      />

      <Tabs
        onValueChange={(value) => setTab(value as DetailTab)}
        value={tab}
      >
        <div className="overflow-x-auto pb-1">
          <TabsList className="min-w-full justify-start">
            {TAB_ITEMS.map((value) => (
              <TabsTrigger key={value} value={value}>
                {t(`tabs.${value}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <TabsContent value="overview">
          <OverviewSection device={device} onGoAudit={() => setTab("audit")} />
        </TabsContent>
        <TabsContent value="health">
          <DeviceHealthTab
            deviceId={device.id}
            healthScore={device.healthScore}
            status={device.status}
          />
        </TabsContent>
        <TabsContent value="interfaces">
          <DeviceInterfacesTab deviceId={device.id} />
        </TabsContent>
        <TabsContent value="config">
          <DeviceConfigTab
            deviceId={device.id}
            onSelectSnapshot={setSelectedSnapshotId}
            selectedSnapshotId={selectedSnapshotId}
          />
        </TabsContent>
        <TabsContent value="backups">
          <BackupsTab
            deviceId={device.id}
            device={{
              lastBackupAt: device.lastBackupAt,
              backupCompliance: device.backupCompliance,
            }}
            onViewConfig={(snapshotId) => {
              setSelectedSnapshotId(snapshotId);
              setTab("config");
            }}
          />
        </TabsContent>
        <TabsContent value="changes">
          <ChangesTab deviceId={device.id} />
        </TabsContent>
        <TabsContent value="incidents">
          <IncidentsTab deviceId={device.id} />
        </TabsContent>
        <TabsContent value="alerts">
          <DeviceAlertsTab deviceId={device.id} />
        </TabsContent>
        <TabsContent value="assistant">
          <AssistantTab deviceId={device.id} />
        </TabsContent>
        <TabsContent value="audit">
          <DeviceAuditTab deviceId={device.id} pageSize={50} />
        </TabsContent>
      </Tabs>

      <AddDeviceSheet device={device} onOpenChange={setEditOpen} open={editOpen} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Overview tab                                                         */
/* ------------------------------------------------------------------ */

function OverviewSection({
  device,
  onGoAudit,
}: {
  device: DeviceDetail;
  onGoAudit: () => void;
}) {
  const t = useTranslations("deviceDetail");
  const tCommon = useTranslations("common");
  const audit = useDeviceAudit(device.id, { pageSize: 5 });
  // Phase 13-b — lifecycle dot next to the firmware value (static matrix).
  const lifecycle = getLifecycle(device.vendor.key, device.firmware);
  const lifecycleBadgeConfig = lifecycleBadge(lifecycle?.status ?? null);
  const resolveStatusLabel = useStatusLabel();
  const lifecycleTitle = lifecycle
    ? resolveStatusLabel(lifecycleBadgeConfig)
    : null;

  return (
    <div className="flex flex-col gap-4 pt-2">
      {/* KPI mini-cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard
          className={cn(device.counts.openAlerts > 0 && "border-danger/40")}
          description={t("kpi.openAlertsDescription")}
          icon={Siren}
          label={t("kpi.openAlertsLabel")}
          value={device.counts.openAlerts}
        />
        <KpiCard
          description={t("kpi.openIncidentsDescription")}
          icon={TriangleAlert}
          label={t("kpi.openIncidentsLabel")}
          value={device.counts.openIncidents}
        />
        <KpiCard
          description={t("kpi.snapshotsDescription")}
          icon={History}
          label={t("kpi.snapshotsLabel")}
          value={device.counts.snapshots}
        />
        <div className="flex flex-col justify-between gap-2 rounded-xl border bg-card p-4 shadow-e1">
          <p className="text-xs font-medium text-muted-foreground" title={t("kpi.backupComplianceTitle")}>
            {t("kpi.backupComplianceTitle")}
          </p>
          <div className="flex flex-col gap-1.5">
            <BackupComplianceBadge className="w-fit" value={device.backupCompliance} />
            <span className="text-xs text-muted-foreground tabular-nums">
              {device.lastBackupAt
                ? t("kpi.lastBackup", { time: relative(device.lastBackupAt) })
                : t("kpi.noBackup")}
            </span>
          </div>
        </div>
      </div>

      {/* SAFE-001 — host-key enrollment state for live devices (fail-closed
          enforcement lives in the worker transport; this card is the
          operator's enrollment surface). */}
      {device.dataSource === "LIVE_SSH" && <HostKeyCard deviceId={device.id} />}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* Identity */}
        <SectionCard
          contentClassName="p-0"
          description={t("record.description")}
          title={t("record.title")}
        >
          <dl className="grid grid-cols-1 gap-x-6 gap-y-0 p-card sm:grid-cols-2">
            <RecordItem label={t("record.mgmtIp")} mono value={device.mgmtIp} />
            <RecordItem
              label={t("record.dataPlane")}
              value={
                device.dataSource === "LIVE_SSH"
                  ? device.credentialProfile
                    ? t("record.dataPlaneLiveWithProfile", {
                        profile: device.credentialProfile.name,
                      })
                    : t("record.dataPlaneLive")
                  : t("record.dataPlaneSimulator")
              }
            />
            <RecordItem label={t("record.hostname")} mono value={device.hostname} />
            <RecordItem label={t("record.vendor")} value={device.vendor.name} />
            <RecordItem
              label={t("record.model")}
              value={[device.model, device.platform].filter(Boolean).join(" · ") || "—"}
            />
            <RecordItem
              dotClass={lifecycleBadgeConfig.dotClass}
              dotTitle={lifecycleTitle}
              label={t("record.firmware")}
              mono
              value={device.firmware ?? "—"}
            />
            <RecordItem label={t("record.serialNumber")} mono value={device.serialNumber ?? "—"} />
            <RecordItem label={t("record.role")} value={device.role ? deviceRoleLabelFor(device.role) : "—"} />
            <RecordItem label={t("record.site")} value={device.site ? `${device.site.name} (${device.site.code})` : "—"} />
            <RecordItem label={t("record.lastSeen")} value={relative(device.lastSeen)} />
            <RecordItem label={t("record.uptime")} value={formatUptime(device.uptimeSeconds)} />
            <RecordItem
              label={t("record.lastConfigChange")}
              value={relative(device.lastConfigChangeAt)}
            />
            <RecordItem
              label={t("record.backupJobs")}
              value={String(device.counts.backupJobs)}
            />
          </dl>
          {device.notes && (
            <div className="border-t p-card">
              <p className="text-xs font-medium text-muted-foreground">{t("record.notesLabel")}</p>
              <p className="mt-1 text-sm leading-relaxed">{device.notes}</p>
            </div>
          )}
          {device.tags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 border-t p-card">
              <span className="text-xs font-medium text-muted-foreground">{t("record.tagsLabel")}</span>
              {device.tags.map((tag) => (
                <StatusBadge
                  key={tag}
                  config={{
                    key: tag,
                    label: tag,
                    token: "neutral",
                    icon: "CircleMinus",
                    dotClass: "bg-neutral",
                    badgeClass: "bg-neutral-subtle text-neutral border-neutral/25",
                    iconClass: "text-neutral",
                  }}
                  withIcon={false}
                />
              ))}
            </div>
          )}
        </SectionCard>

        {/* Recent activity */}
        <SectionCard
          contentClassName="p-0"
          description={t("activity.description")}
          title={t("activity.title")}
          actions={
            <Button onClick={onGoAudit} size="sm" variant="ghost">
              {tCommon("viewAll")}
            </Button>
          }
        >
          {audit.isLoading ? (
            <div className="flex flex-col gap-2 p-4">
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="h-8 animate-pulse rounded-md bg-muted/60" />
              ))}
            </div>
          ) : audit.isError ? (
            <div className="p-4">
              <ErrorState
                onRetry={() => void audit.refetch()}
                reason={audit.error.message}
                title={t("activity.errorTitle")}
              />
            </div>
          ) : (audit.data?.data.length ?? 0) === 0 ? (
            <div className="p-4">
              <EmptyState
                className="border-none bg-transparent py-8"
                description={t("activity.emptyDescription")}
                icon={History}
                title={t("activity.emptyTitle")}
              />
            </div>
          ) : (
            <ul className="divide-y">
              {audit.data?.data.map((event) => (
                <AuditItem event={event} key={event.id} />
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

function RecordItem({
  label,
  value,
  mono,
  dotClass,
  dotTitle,
}: {
  label: string;
  value: string;
  mono?: boolean;
  /** Optional lifecycle dot (Phase 13-b) rendered before the value. */
  dotClass?: string;
  dotTitle?: string | null;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 border-b py-2.5 last:border-b-0 sm:border-b">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "flex min-w-0 items-center gap-1.5 text-sm",
          mono && "font-tech ltr-technical"
        )}
      >
        {dotClass && (
          <span
            aria-hidden="true"
            className={cn("size-2 shrink-0 rounded-full", dotClass)}
            title={dotTitle ?? undefined}
          />
        )}
        <span className="min-w-0 truncate" title={value}>
          {value}
        </span>
      </dd>
    </div>
  );
}

function AuditItem({ event }: { event: DeviceAuditRow }) {
  const success = event.result !== "FAILURE";
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <span
        aria-hidden="true"
        className={cn(
          "size-2 shrink-0 rounded-full",
          success ? "bg-success" : "bg-danger"
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">
          <span className="font-tech ltr-technical">{event.action}</span>
          {event.resourceLabel && (
            <span className="text-muted-foreground"> — {event.resourceLabel}</span>
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          {event.actorName} · {format(new Date(event.createdAt), "MMM d, HH:mm:ss")}
          {event.ip ? ` · ${event.ip}` : ""}
        </p>
      </div>
    </li>
  );
}
