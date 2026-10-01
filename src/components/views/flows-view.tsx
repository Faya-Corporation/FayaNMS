"use client";

import { useMemo, useState } from "react";
import { format } from "date-fns";
import {
  Activity,
  ArrowLeftRight,
  Clock,
  Database,
  FileText,
  Globe,
  HardDrive,
  Layers,
  Lock,
  Monitor,
  Network as NetworkIcon,
  RefreshCcw,
  Server,
  Terminal,
  Users,
  Waves,
  type LucideIcon,
} from "lucide-react";

import { useFlows } from "@/hooks/api/use-flows";
import { useDevices } from "@/hooks/api/use-devices";
import { useTranslations } from "next-intl";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { KpiCard } from "@/components/domain/kpi-card";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { WidgetSkeleton } from "@/components/dashboard/widget-skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { FlowProtocolRow, FlowWindow } from "@/lib/api-client";

/* ───────────────────────── formatters ───────────────────────── */

/** 1,234 → "1.2 KB" style humanized byte sizes. */
function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024))
  );
  const value = bytes / 1024 ** i;
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** Compact counts: 12,345 → "12.3K", 2,000,000 → "2.0M". */
function fmtCount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

/** Mbps above 1000 renders as Gbps. */
function fmtMbps(mbps: number): string {
  if (!Number.isFinite(mbps)) return "—";
  return mbps >= 1000 ? `${(mbps / 1000).toFixed(2)} Gbps` : `${mbps.toFixed(2)} Mbps`;
}

/** Protocol → icon mapping for the distribution bars. */
const PROTOCOL_ICONS: Record<string, LucideIcon> = {
  HTTPS: Lock,
  HTTP: Globe,
  DNS: NetworkIcon,
  SSH: Terminal,
  RDP: Monitor,
  SNMP: Server,
  SMB: HardDrive,
  NFS: Database,
  NTP: Clock,
  SYSLOG: FileText,
};

function ProtocolBadge({ row }: { row: { protocol: string; port: number } }) {
  const Icon = PROTOCOL_ICONS[row.protocol] ?? Activity;
  return (
    <Badge className="gap-1 font-tech ltr-technical" variant="secondary">
      <Icon aria-hidden="true" className="size-3" />
      {row.protocol}
      <span className="text-muted-foreground">/{row.port}</span>
    </Badge>
  );
}

/** Fixed flow windows — a subset of the shared time-range values, styled
 *  like TimeRangeSelect (labels come from the same timeRange namespace). */
const FLOW_WINDOW_VALUES: FlowWindow[] = ["1h", "6h", "24h"];

/**
 * Flow Analytics (Phase 13-c): deterministic NetFlow-style conversation
 * analytics per device. Data is generated from stable 15-minute export
 * buckets, so 30 s polling never changes numbers mid-bucket.
 */
export function FlowsView() {
  const t = useTranslations("flows");
  const tTime = useTranslations("timeRange");

  const [manualDeviceId, setManualDeviceId] = useState("");
  const [window, setWindow] = useState<FlowWindow>("1h");

  const devicesQuery = useDevices({ pageSize: 100, sort: "hostname", dir: "asc" });
  const devices = useMemo(
    () => devicesQuery.data?.data ?? [],
    [devicesQuery.data]
  );

  // Default: the "busiest" device (most interfaces, online first), else
  // the first inventory row. Deterministic so polls never flip the pick.
  const autoDeviceId = useMemo(() => {
    if (devices.length === 0) return null;
    const pool = devices.filter((d) => d.status !== "UNMANAGED");
    const candidates = pool.length > 0 ? pool : devices;
    const online = candidates.filter((d) => d.status === "ONLINE");
    const ranked = [...(online.length > 0 ? online : candidates)].sort(
      (a, b) =>
        b._count.interfaces - a._count.interfaces ||
        a.hostname.localeCompare(b.hostname)
    );
    return ranked[0]?.id ?? null;
  }, [devices]);

  // Derived selection: the manual pick wins; otherwise fall back to the
  // auto default (declarative — no setState-in-effect needed).
  const deviceId = manualDeviceId !== "" ? manualDeviceId : autoDeviceId ?? "";

  const flows = useFlows(deviceId === "" ? null : deviceId, window);
  const data = flows.data?.data;

  const talkers = data?.topTalkers ?? [];
  const maxTalkerBytes = talkers.length > 0 ? talkers[0].bytes : 0;
  const protocols = data?.protocolDistribution ?? [];
  const interfaces = data?.interfaceTotals ?? [];
  const maxInterfaceMbps = Math.max(
    1e-6,
    ...interfaces.map((i) => Math.max(i.inMbps, i.outMbps))
  );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        primaryAction={
          <Button
            disabled={flows.isFetching || deviceId === ""}
            onClick={() => void flows.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            <RefreshCcw
              aria-hidden="true"
              className={cn("size-3.5", flows.isFetching && "animate-spin")}
            />
            {t("refresh")}
          </Button>
        }
        description={t("description")}
        title={t("title")}
        actions={
          <>
            <Select onValueChange={setManualDeviceId} value={deviceId}>
              <SelectTrigger
                aria-label={t("deviceLabel")}
                className="h-8 w-56 text-xs"
                size="sm"
              >
                <Server aria-hidden="true" className="size-3.5 text-muted-foreground" />
                <SelectValue placeholder={t("devicePlaceholder")} />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {devices.map((device) => (
                  <SelectItem key={device.id} value={device.id}>
                    <span className="font-tech ltr-technical">{device.hostname}</span>
                    {device.site ? (
                      <span className="text-muted-foreground"> · {device.site.code}</span>
                    ) : null}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select onValueChange={(v) => setWindow(v as FlowWindow)} value={window}>
              <SelectTrigger
                aria-label={t("windowLabel")}
                className="h-8 w-[9.5rem] gap-1.5 text-xs"
                size="sm"
              >
                <Clock aria-hidden="true" className="size-3.5 text-muted-foreground" />
                <SelectValue placeholder={t("windowLabel")} />
              </SelectTrigger>
              <SelectContent>
                {FLOW_WINDOW_VALUES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {tTime.has(`options.${value}`) ? tTime(`options.${value}`) : value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
      />

      {devicesQuery.isLoading ? (
        <WidgetSkeleton rows={8} />
      ) : devices.length === 0 || deviceId === "" ? (
        <EmptyState
          description={t("noDeviceDescription")}
          icon={ArrowLeftRight}
          title={t("noDeviceTitle")}
        />
      ) : flows.isError ? (
        <ErrorState
          onRetry={() => void flows.refetch()}
          reason={flows.error.message}
          title={t("errorTitle")}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {/* KPI row */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              description={t("kpi.throughputHint")}
              icon={Activity}
              label={t("kpi.throughput")}
              loading={!data}
              value={
                data
                  ? fmtMbps(data.totals.avgInMbps + data.totals.avgOutMbps)
                  : "—"
              }
            />
            <KpiCard
              description={t("kpi.flowsHint")}
              icon={Waves}
              label={t("kpi.flows")}
              loading={!data}
              value={data ? fmtCount(data.totals.flows) : "—"}
            />
            <KpiCard
              description={
                data && talkers.length > 0 ? fmtBytes(talkers[0].bytes) : t("kpi.topTalkerHint")
              }
              icon={Users}
              label={t("kpi.topTalker")}
              loading={!data}
              value={data && talkers.length > 0 ? talkers[0].srcIp : "—"}
            />
            <KpiCard
              description={
                data && protocols.length > 0
                  ? `${protocols[0].pct}% ${t("kpi.topProtocolHint")}`
                  : t("kpi.topProtocolHint")
              }
              icon={Layers}
              label={t("kpi.topProtocol")}
              loading={!data}
              value={
                data && protocols.length > 0
                  ? `${protocols[0].protocol} /${protocols[0].port}`
                  : "—"
              }
            />
          </div>

          {data && (
            <p className="text-xs text-muted-foreground tabular-nums">
              {t("metaLine", {
                windowEnd: format(new Date(data.meta.windowEnd), "MMM d, HH:mm"),
                buckets: data.meta.buckets,
                bucketMinutes: Math.round(data.meta.bucketMs / 60_000),
                computed: format(new Date(data.meta.computedAt), "HH:mm:ss"),
              })}
            </p>
          )}

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
            {/* Top talkers */}
            <SectionCard
              className="xl:col-span-7"
              contentClassName="p-0"
              description={t("talkers.description", { count: talkers.length })}
              title={t("talkers.title")}
            >
              {!data ? (
                <div className="p-4">
                  <WidgetSkeleton rows={5} />
                </div>
              ) : talkers.length === 0 ? (
                <div className="p-4">
                  <EmptyState
                    className="border-none bg-transparent py-8"
                    description={t("talkers.empty")}
                    icon={ArrowLeftRight}
                    title={t("talkers.title")}
                  />
                </div>
              ) : (
                <div className="max-h-96 overflow-auto">
                  <table
                    aria-label={t("talkers.title")}
                    className="w-full min-w-[560px] text-sm"
                  >
                    <thead className="sticky top-0 z-10 bg-card">
                      <tr className="border-b text-xs text-muted-foreground">
                        <th className="w-10 px-4 py-2 text-start font-medium" scope="col">
                          {t("talkers.rank")}
                        </th>
                        <th className="px-4 py-2 text-start font-medium" scope="col">
                          {t("talkers.src")} → {t("talkers.dst")}
                        </th>
                        <th className="px-4 py-2 text-start font-medium" scope="col">
                          {t("talkers.protocol")}
                        </th>
                        <th className="px-4 py-2 text-end font-medium" scope="col">
                          {t("talkers.bytes")}
                        </th>
                        <th className="hidden px-4 py-2 text-end font-medium sm:table-cell" scope="col">
                          {t("talkers.packets")}
                        </th>
                        <th className="w-28 px-4 py-2 text-end font-medium" scope="col">
                          {t("talkers.share")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {talkers.map((talker) => (
                        <tr className="border-b transition-colors last:border-0 hover:bg-accent/50" key={talker.srcIp}>
                          <td className="px-4 py-2 text-muted-foreground tabular-nums">
                            {talker.rank}
                          </td>
                          <td className="px-4 py-2">
                            <div className="flex flex-col gap-0.5">
                              <span className="flex items-center gap-1.5">
                                <span className="font-tech text-sm ltr-technical" title={talker.srcIp}>
                                  {talker.srcIp}
                                </span>
                                <ArrowLeftRight aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
                                {talker.dstIp ? (
                                  <span className="truncate font-tech text-xs text-muted-foreground ltr-technical" title={talker.dstIp}>
                                    {talker.dstIp}
                                  </span>
                                ) : (
                                  <span className="text-xs text-muted-foreground">
                                    {t("talkers.multi", { count: talker.dstIpCount })}
                                  </span>
                                )}
                              </span>
                              <span className="text-[11px] text-muted-foreground tabular-nums">
                                {t("talkers.flows")}: {fmtCount(talker.flows)}
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-2">
                            <ProtocolBadge
                              row={{ protocol: talker.topProtocol, port: talker.topPort }}
                            />
                          </td>
                          <td className="px-4 py-2 text-end font-medium tabular-nums">
                            {fmtBytes(talker.bytes)}
                          </td>
                          <td className="hidden px-4 py-2 text-end text-muted-foreground tabular-nums sm:table-cell">
                            {fmtCount(talker.packets)}
                          </td>
                          <td className="px-4 py-2">
                            <div className="flex items-center justify-end gap-2">
                              <div
                                aria-hidden="true"
                                className="h-1.5 w-16 overflow-hidden rounded-full bg-muted"
                              >
                                <div
                                  className="h-full rounded-full bg-primary/70"
                                  style={{
                                    width: `${
                                      maxTalkerBytes > 0
                                        ? Math.max(4, (talker.bytes / maxTalkerBytes) * 100)
                                        : 0
                                    }%`,
                                  }}
                                />
                              </div>
                              <span className="w-12 text-end text-xs text-muted-foreground tabular-nums">
                                {data.totals.bytes > 0
                                  ? `${Math.round((talker.bytes / data.totals.bytes) * 100)}%`
                                  : "0%"}
                              </span>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>

            {/* Protocol distribution */}
            <SectionCard
              className="xl:col-span-5"
              description={t("protocols.description")}
              title={t("protocols.title")}
            >
              {!data ? (
                <WidgetSkeleton rows={5} />
              ) : protocols.length === 0 ? (
                <EmptyState
                  className="border-none bg-transparent py-8"
                  description={t("protocols.empty")}
                  icon={Layers}
                  title={t("protocols.title")}
                />
              ) : (
                <ul className="flex flex-col">
                  {protocols.map((row: FlowProtocolRow) => {
                    const Icon = PROTOCOL_ICONS[row.protocol] ?? Activity;
                    return (
                      <li className="flex flex-col gap-1 border-b py-2 last:border-0" key={row.protocol}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                              <Icon aria-hidden="true" className="size-3.5" />
                            </span>
                            <span className="truncate text-sm font-medium">
                              {row.protocol}
                              <span className="ms-1.5 text-xs text-muted-foreground font-tech ltr-technical">
                                /{row.port}
                              </span>
                            </span>
                          </span>
                          <span className="flex shrink-0 items-baseline gap-2 text-xs text-muted-foreground tabular-nums">
                            <span>{fmtBytes(row.bytes)}</span>
                            <span className="font-medium text-foreground">{row.pct}%</span>
                          </span>
                        </div>
                        <div
                          aria-hidden="true"
                          className="h-1.5 overflow-hidden rounded-full bg-muted"
                        >
                          <div
                            className="h-full rounded-full bg-primary/70"
                            style={{ width: `${Math.max(2, row.pct)}%` }}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </SectionCard>

            {/* Interface totals */}
            <SectionCard
              className="xl:col-span-5"
              description={t("interfaces.description")}
              title={t("interfaces.title")}
            >
              {!data ? (
                <WidgetSkeleton rows={5} />
              ) : interfaces.length === 0 ? (
                <EmptyState
                  className="border-none bg-transparent py-8"
                  description={t("interfaces.empty")}
                  icon={NetworkIcon}
                  title={t("interfaces.title")}
                />
              ) : (
                <ul className="flex flex-col">
                  {interfaces.map((iface) => (
                    <li className="flex flex-col gap-1.5 border-b py-2.5 last:border-0" key={iface.interfaceId}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-baseline gap-2">
                          <span className="truncate font-tech text-sm ltr-technical" title={iface.name}>
                            {iface.name}
                          </span>
                          {iface.speedMbps ? (
                            <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                              {iface.speedMbps >= 1000
                                ? `${iface.speedMbps / 1000}G`
                                : `${iface.speedMbps}M`}
                            </span>
                          ) : null}
                        </span>
                        <span className="shrink-0 text-xs font-medium text-muted-foreground tabular-nums">
                          {fmtMbps(iface.inMbps + iface.outMbps)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="w-7 shrink-0 font-medium">{t("interfaces.in")}</span>
                        <div aria-hidden="true" className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-primary/70"
                            style={{
                              width: `${Math.max(1, (iface.inMbps / maxInterfaceMbps) * 100)}%`,
                            }}
                          />
                        </div>
                        <span className="w-20 shrink-0 text-end tabular-nums">{fmtMbps(iface.inMbps)}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="w-7 shrink-0 font-medium">{t("interfaces.out")}</span>
                        <div aria-hidden="true" className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-success/70"
                            style={{
                              width: `${Math.max(1, (iface.outMbps / maxInterfaceMbps) * 100)}%`,
                            }}
                          />
                        </div>
                        <span className="w-20 shrink-0 text-end tabular-nums">{fmtMbps(iface.outMbps)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>

            {/* Recent flows sample */}
            <SectionCard
              className="xl:col-span-7"
              contentClassName="p-0"
              description={t("sample.description", { count: data?.sample.length ?? 0 })}
              title={t("sample.title")}
            >
              {!data ? (
                <div className="p-4">
                  <WidgetSkeleton rows={5} />
                </div>
              ) : data.sample.length === 0 ? (
                <div className="p-4">
                  <EmptyState
                    className="border-none bg-transparent py-8"
                    description={t("sample.empty")}
                    icon={ArrowLeftRight}
                    title={t("sample.title")}
                  />
                </div>
              ) : (
                <div className="max-h-96 overflow-auto">
                  <table
                    aria-label={t("sample.title")}
                    className="w-full min-w-[640px] text-sm"
                  >
                    <thead className="sticky top-0 z-10 bg-card">
                      <tr className="border-b text-xs text-muted-foreground">
                        <th className="px-4 py-2 text-start font-medium" scope="col">
                          {t("sample.time")}
                        </th>
                        <th className="px-4 py-2 text-start font-medium" scope="col">
                          {t("sample.src")} → {t("sample.dst")}
                        </th>
                        <th className="px-4 py-2 text-start font-medium" scope="col">
                          {t("sample.proto")}
                        </th>
                        <th className="px-4 py-2 text-end font-medium" scope="col">
                          {t("sample.bytes")}
                        </th>
                        <th className="hidden px-4 py-2 text-end font-medium sm:table-cell" scope="col">
                          {t("sample.packets")}
                        </th>
                        <th className="hidden px-4 py-2 text-start font-medium md:table-cell" scope="col">
                          {t("sample.flags")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.sample.map((flow) => (
                        <tr className="border-b transition-colors last:border-0 hover:bg-accent/50" key={flow.id}>
                          <td className="whitespace-nowrap px-4 py-2 text-muted-foreground tabular-nums">
                            {format(new Date(flow.ts), "HH:mm:ss")}
                          </td>
                          <td className="px-4 py-2">
                            <span className="flex items-center gap-1.5">
                              <span className="font-tech text-xs ltr-technical" title={flow.srcIp}>
                                {flow.srcIp}
                              </span>
                              <ArrowLeftRight aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
                              <span className="truncate font-tech text-xs text-muted-foreground ltr-technical" title={flow.dstIp}>
                                {flow.dstIp}
                              </span>
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-4 py-2">
                            <ProtocolBadge
                              row={{ protocol: flow.protocol, port: flow.dstPort }}
                            />
                          </td>
                          <td className="px-4 py-2 text-end font-medium tabular-nums">
                            {fmtBytes(flow.bytes)}
                          </td>
                          <td className="hidden px-4 py-2 text-end text-muted-foreground tabular-nums sm:table-cell">
                            {fmtCount(flow.packets)}
                          </td>
                          <td className="hidden px-4 py-2 md:table-cell">
                            {flow.tcpFlags ? (
                              <span className="font-tech text-xs text-muted-foreground ltr-technical">
                                {flow.tcpFlags}
                              </span>
                            ) : (
                              <span className="text-xs text-muted-foreground">{t("sample.udp")}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
          </div>
        </div>
      )}
    </div>
  );
}
