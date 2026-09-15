"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ArrowLeftRight,
  ArrowRight,
  Building2,
  FlaskConical,
  Globe,
  HardDrive,
  Network,
  Router,
  Server,
  Shield,
  Waypoints,
  Wifi,
  type LucideIcon,
} from "lucide-react";

import { useTopology } from "@/hooks/api/use-topology";
import { useSites } from "@/hooks/api/use-sites";
import { useStatusLabel } from "@/hooks/use-status-label";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { KpiCard } from "@/components/domain/kpi-card";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DEVICE_STATUS,
  getStatusConfig,
  type StatusBadgeConfig,
  type StatusToken,
} from "@/lib/domain/status";
import type { TopologyEdge, TopologyEdgeType, TopologyNode } from "@/lib/topology/graph";
import { useNavigationStore } from "@/stores/navigation";
import { cn } from "@/lib/utils";

/**
 * Network topology map (Task 18-b) against /api/v1/topology:
 *  - demo-data banner (documented simulated link design over REAL inventory
 *    — mirrors the honesty banner of src/lib/ha/topology.ts);
 *  - KPI cards (sites / devices / links / simulated links);
 *  - site filter + status & edge-type legend;
 *  - a deterministic PURE-SVG map (no reactflow/d3): sites in a fixed grid
 *    of rounded zones, devices as pill nodes, edges as elbow paths routed
 *    through the gaps between zones. Nodes are focusable buttons that open
 *    the device detail view (same navigation as devices-view);
 *  - an edge list table below the map — the accessible representation
 *    (the SVG is a labelled image; the table carries the data).
 *
 * Layout + edge routing are pure helpers in this file, computed with
 * useMemo — identical data always renders an identical map.
 */

/* ───────────────────────── layout constants ───────────────────────── */

const ZONE_W = 320;
const ZONE_HEADER_H = 46;
const ZONE_PAD = 14;
const PILL_H = 38;
const PILL_GAP = 8;
const COL_GAP = 150; // horizontal routing channel between zone columns
const ROW_GAP = 120; // horizontal routing channel between zone rows
const CANVAS_PAD = 28;
const SVG_MIN_WIDTH = 1100;

interface PillBox {
  x: number;
  y: number;
  w: number;
  h: number;
  cy: number;
}

interface ZoneBox {
  key: string;
  code: string | null;
  col: number;
  row: number;
  x: number;
  y: number;
  w: number;
  h: number;
  nodeCount: number;
}

interface MapLayout {
  width: number;
  height: number;
  zones: ZoneBox[];
  /** nodeId → its zone + pill box. */
  nodePills: Map<string, { zone: ZoneBox; pill: PillBox }>;
  rowBands: { top: number; bottom: number }[];
}

interface ZoneInput {
  key: string;
  code: string | null;
  nodes: TopologyNode[];
}

function zoneHeightFor(nodeCount: number): number {
  return (
    ZONE_HEADER_H +
    ZONE_PAD +
    nodeCount * PILL_H +
    Math.max(0, nodeCount - 1) * PILL_GAP +
    ZONE_PAD
  );
}

/**
 * Deterministic grid layout: zones flow into ≤3 columns (row-major in the
 * given order), each zone sized by its device count. Columns/rows leave
 * wide channels (COL_GAP/ROW_GAP) that the edge router uses.
 */
function computeMapLayout(zones: readonly ZoneInput[]): MapLayout {
  const visible = zones.filter((zone) => zone.nodes.length > 0);
  const cols = Math.min(Math.max(visible.length, 1), 3);

  const rowHeights: number[] = [];
  const rowOf: number[] = [];
  visible.forEach((zone, index) => {
    const row = Math.floor(index / cols);
    rowOf[index] = row;
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, zoneHeightFor(zone.nodes.length));
  });

  const rowBands: { top: number; bottom: number }[] = [];
  let cursorY = CANVAS_PAD;
  for (const height of rowHeights) {
    rowBands.push({ top: cursorY, bottom: cursorY + height });
    cursorY += height + ROW_GAP;
  }
  const contentH = Math.max(0, cursorY - ROW_GAP) + CANVAS_PAD;

  const contentW = cols * ZONE_W + (cols - 1) * COL_GAP;
  const width = Math.max(SVG_MIN_WIDTH, contentW + CANVAS_PAD * 2);
  const offsetX = Math.max(CANVAS_PAD, (width - contentW) / 2);

  const layout: MapLayout = {
    width,
    height: contentH,
    zones: [],
    nodePills: new Map(),
    rowBands,
  };

  visible.forEach((zone, index) => {
    const col = index % cols;
    const row = rowOf[index];
    const x = offsetX + col * (ZONE_W + COL_GAP);
    const y = rowBands[row].top;
    layout.zones.push({
      key: zone.key,
      code: zone.code,
      col,
      row,
      x,
      y,
      w: ZONE_W,
      h: rowHeights[row],
      nodeCount: zone.nodes.length,
    });
    zone.nodes.forEach((node, pillIndex) => {
      const px = x + ZONE_PAD;
      const py = y + ZONE_HEADER_H + ZONE_PAD + pillIndex * (PILL_H + PILL_GAP);
      layout.nodePills.set(node.id, {
        zone: layout.zones[layout.zones.length - 1],
        pill: { x: px, y: py, w: ZONE_W - ZONE_PAD * 2, h: PILL_H, cy: py + PILL_H / 2 },
      });
    });
  });

  return layout;
}

/* ───────────────────────── edge routing ───────────────────────── */

interface RoutedEdge {
  edge: TopologyEdge;
  d: string;
  labelX: number;
  labelY: number;
  /** Off-map endpoint marker (site-filtered edges). */
  stub?: { x: number; y: number };
}

/**
 * Deterministic elbow router. Intra-zone edges loop through a per-zone
 * right-side channel (slot-offset so multiple edges don't overlap); cross-
 * zone edges exit one zone sideways, travel through the gap between rows
 * (or the column channel for adjacent same-row zones), and enter the other
 * zone. With one endpoint filtered off the map, a straight stub with an
 * open-circle terminator is drawn instead.
 */
function routeEdges(
  edges: readonly TopologyEdge[],
  layout: MapLayout
): RoutedEdge[] {
  const sideSlots = new Map<string, number>();
  const takeSlot = (key: string): number => {
    const next = sideSlots.get(key) ?? 0;
    sideSlots.set(key, next + 1);
    return next;
  };

  const offX = layout.width - CANVAS_PAD - 10;

  return edges.flatMap((edge): RoutedEdge[] => {
    const a = layout.nodePills.get(edge.sourceDeviceId);
    const b = layout.nodePills.get(edge.targetDeviceId);

    /* One endpoint hidden by the site filter → off-map stub. */
    if (!a || !b) {
      const visible = a ?? b;
      if (!visible) return [];
      const pill = visible.pill;
      const anchorX = visible.zone.x + ZONE_W;
      return [
        {
          edge,
          d: `M ${anchorX} ${pill.cy} H ${offX}`,
          labelX: (anchorX + offX) / 2,
          labelY: pill.cy - 7,
          stub: { x: offX, y: pill.cy },
        },
      ];
    }

    /* Intra-zone edge — loop through the zone's right-side channel. */
    if (a.zone.key === b.zone.key) {
      const slot = takeSlot(`${a.zone.key}:right`);
      const channelX = a.zone.x + ZONE_W + 16 + 12 * slot;
      const ax = a.zone.x + ZONE_W;
      const bx = b.zone.x + ZONE_W;
      return [
        {
          edge,
          d: `M ${ax} ${a.pill.cy} H ${channelX} V ${b.pill.cy} H ${bx}`,
          labelX: channelX + 5,
          labelY: (a.pill.cy + b.pill.cy) / 2,
        },
      ];
    }

    /* Cross-zone edge. */
    const sameRow = a.zone.row === b.zone.row;
    const sourceSide = a.zone.col > b.zone.col ? "left" : "right";
    const targetSide = b.zone.col > a.zone.col ? "left" : "right";
    const slotS = takeSlot(`${a.zone.key}:${sourceSide}`);
    const slotT = takeSlot(`${b.zone.key}:${targetSide}`);
    const stubS = 16 + 12 * slotS;
    const stubT = 16 + 12 * slotT;
    const ax = sourceSide === "right" ? a.zone.x + ZONE_W : a.zone.x;
    const bx = targetSide === "right" ? b.zone.x + ZONE_W : b.zone.x;
    const dirS = sourceSide === "right" ? 1 : -1;
    const dirT = targetSide === "right" ? 1 : -1;
    const p1x = ax + dirS * stubS;
    const p4x = bx + dirT * stubT;

    if (sameRow && Math.abs(a.zone.col - b.zone.col) === 1) {
      // Adjacent zones in the same row — simple 3-segment elbow through
      // the column channel.
      const midX = (ax + bx) / 2;
      return [
        {
          edge,
          d: `M ${ax} ${a.pill.cy} H ${midX} V ${b.pill.cy} H ${bx}`,
          labelX: midX,
          labelY: (a.pill.cy + b.pill.cy) / 2 - 5,
        },
      ];
    }

    const upper = Math.min(a.zone.row, b.zone.row);
    const lower = Math.max(a.zone.row, b.zone.row);
    const channelY = sameRow
      ? layout.rowBands[a.zone.row].bottom + 36 // non-adjacent same-row: dip below
      : (layout.rowBands[upper].bottom + layout.rowBands[lower].top) / 2;

    return [
      {
        edge,
        d: `M ${ax} ${a.pill.cy} H ${p1x} V ${channelY} H ${p4x} V ${b.pill.cy} H ${bx}`,
        labelX: (p1x + p4x) / 2,
        labelY: channelY - 6,
      },
    ];
  });
}

/* ───────────────────────── rendering lookups ───────────────────────── */

/** status token → CSS custom property (theme-safe in light and dark). */
const TOKEN_VAR: Record<StatusToken, string> = {
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--danger)",
  "danger-orange": "var(--danger-orange)",
  info: "var(--info)",
  neutral: "var(--neutral)",
};

const EDGE_STYLES: Record<
  TopologyEdgeType,
  { stroke: string; strokeWidth: number; dashed: boolean }
> = {
  ha: { stroke: "var(--success)", strokeWidth: 2.5, dashed: false },
  circuit: { stroke: "var(--warning)", strokeWidth: 2, dashed: false },
  uplink: { stroke: "var(--muted-foreground)", strokeWidth: 2, dashed: true },
};

const EDGE_TYPE_BADGE: Record<TopologyEdgeType, string> = {
  ha: "bg-success-subtle text-success border-success/25",
  circuit: "bg-warning-subtle text-warning border-warning/25",
  uplink: "bg-neutral-subtle text-neutral border-neutral/25",
};

/** Device role → lucide icon (technical glyph, never color-only meaning). */
const ROLE_ICONS: Record<string, LucideIcon> = {
  CORE_ROUTER: Router,
  EDGE_ROUTER: Router,
  BRANCH_ROUTER: Router,
  FIREWALL: Shield,
  CORE_SWITCH: Network,
  ACCESS_SWITCH: Network,
  TOP_OF_RACK: Server,
  WIRELESS_CONTROLLER: Wifi,
  LOAD_BALANCER: ArrowLeftRight,
  WAN_GATEWAY: Globe,
};

function roleIconFor(role: string | null): LucideIcon {
  if (!role) return HardDrive;
  return ROLE_ICONS[role.trim().toUpperCase()] ?? HardDrive;
}

/** Legend statuses in the canonical display order. */
const LEGEND_STATUSES: readonly StatusBadgeConfig[] = [
  DEVICE_STATUS.ONLINE,
  DEVICE_STATUS.DEGRADED,
  DEVICE_STATUS.OFFLINE,
  DEVICE_STATUS.MAINTENANCE,
  DEVICE_STATUS.UNKNOWN,
];

/** One legend row: bold lead-in label + inline items. */
function LegendRow({ label, items }: { label: string; items: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">{label}</span>
      {items}
    </div>
  );
}

/* ───────────────────────── view ───────────────────────── */

export function TopologyView() {
  const t = useTranslations("topo");
  const resolveStatusLabel = useStatusLabel();
  const setActiveView = useNavigationStore((state) => state.setActiveView);

  const topology = useTopology();
  const sitesQuery = useSites();

  const [siteFilter, setSiteFilter] = useState<string>("all");
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);

  const data = topology.data;

  const siteNameByCode = useMemo(
    () => new Map((sitesQuery.data ?? []).map((site) => [site.code, site.name])),
    [sitesQuery.data]
  );

  /* Zone grouping — nodes arrive sorted (site asc, unassigned last), so
   * Map insertion order preserves the deterministic zone order. */
  const zones = useMemo<ZoneInput[]>(() => {
    if (!data) return [];
    const groups = new Map<string | null, TopologyNode[]>();
    for (const node of data.nodes) {
      const bucket = groups.get(node.siteCode);
      if (bucket) bucket.push(node);
      else groups.set(node.siteCode, [node]);
    }
    return [...groups.entries()].map(([code, nodes]) => ({
      key: code ?? "__unassigned__",
      code,
      nodes,
    }));
  }, [data]);

  const visibleZones = useMemo(
    () => (siteFilter === "all" ? zones : zones.filter((zone) => zone.code === siteFilter)),
    [zones, siteFilter]
  );

  const visibleNodeCount = useMemo(
    () => visibleZones.reduce((sum, zone) => sum + zone.nodes.length, 0),
    [visibleZones]
  );

  const visibleNodeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const zone of visibleZones) {
      for (const node of zone.nodes) ids.add(node.id);
    }
    return ids;
  }, [visibleZones]);

  const visibleEdges = useMemo(() => {
    if (!data) return [];
    if (siteFilter === "all") return data.edges;
    return data.edges.filter(
      (edge) =>
        visibleNodeIds.has(edge.sourceDeviceId) ||
        visibleNodeIds.has(edge.targetDeviceId)
    );
  }, [data, siteFilter, visibleNodeIds]);

  const layout = useMemo(() => computeMapLayout(visibleZones), [visibleZones]);
  const routed = useMemo(() => routeEdges(visibleEdges, layout), [visibleEdges, layout]);

  const openDetail = (deviceId: string) =>
    setActiveView("network.device-detail", { deviceId });

  const onNodeKeyDown = (event: React.KeyboardEvent, deviceId: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openDetail(deviceId);
    }
  };

  /* ── loading ── */
  if (topology.isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader description={t("description")} title={t("title")} />
        <p className="rounded-md border border-warning/25 bg-warning-subtle px-3 py-2 text-xs text-warning">
          {t("banner")}
        </p>
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <KpiCard key={index} label="" loading value="" />
          ))}
        </div>
        <SectionCard className="min-h-48" title={t("map.title")}>
          <div className="flex flex-col gap-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="h-10 animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        </SectionCard>
      </div>
    );
  }
  /* ── error ── */
  if (topology.isError || !data) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader description={t("description")} title={t("title")} />
        <ErrorState
          onRetry={() => void topology.refetch()}
          reason={
            topology.error instanceof Error ? topology.error.message : undefined
          }
          title={t("errorTitle")}
        />
      </div>
    );
  }

  const summary = data.summary;

  const kpis: { label: string; hint: string; icon: LucideIcon; value: number }[] = [
    { label: t("kpi.sites"), hint: t("kpi.sitesHint"), icon: Building2, value: summary.siteCount },
    { label: t("kpi.devices"), hint: t("kpi.devicesHint"), icon: Server, value: summary.deviceCount },
    { label: t("kpi.links"), hint: t("kpi.linksHint"), icon: Waypoints, value: summary.edgeCount },
    { label: t("kpi.simulated"), hint: t("kpi.simulatedHint"), icon: FlaskConical, value: summary.simulatedEdgeCount },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader description={t("description")} title={t("title")} />

      {/* ── demo-data banner (documented simulated link design) ── */}
      <p className="rounded-md border border-warning/25 bg-warning-subtle px-3 py-2 text-xs text-warning">
        {t("banner")}
      </p>

      {/* ── KPI cards ── */}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {kpis.map((kpi) => (
          <KpiCard
            description={kpi.hint}
            icon={kpi.icon}
            key={kpi.label}
            label={kpi.label}
            value={kpi.value}
          />
        ))}
      </div>

      {/* ── the map ── */}
      <SectionCard
        actions={
          <Select value={siteFilter} onValueChange={setSiteFilter}>
            <SelectTrigger
              aria-label={t("filterAria")}
              className="h-8 w-[200px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("filter.all")}</SelectItem>
              {zones
                .filter((zone) => zone.code !== null)
                .map((zone) => (
                  <SelectItem key={zone.key} value={zone.code as string}>
                    {`${zone.code} — ${siteNameByCode.get(zone.code as string) ?? zone.code}`}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        }
        description={t("map.description")}
        title={t("map.title")}
      >
        {data.nodes.length === 0 ? (
          <EmptyState
            description={t("empty.description")}
            icon={Waypoints}
            title={t("empty.title")}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {/* legend: status colors + edge types */}
            <LegendRow
              items={LEGEND_STATUSES.map((config) => (
                <span className="inline-flex items-center gap-1.5" key={config.key}>
                  <span aria-hidden="true" className={cn("size-2 rounded-full", config.dotClass)} />
                  {resolveStatusLabel(config)}
                </span>
              ))}
              label={t("legend.status")}
            />
            <LegendRow
              items={(Object.keys(EDGE_STYLES) as TopologyEdgeType[]).map((type) => (
                <span className="inline-flex items-center gap-1.5" key={type}>
                  <svg aria-hidden="true" height={8} width={24}>
                    <line
                      stroke={EDGE_STYLES[type].stroke}
                      strokeDasharray={EDGE_STYLES[type].dashed ? "5 4" : undefined}
                      strokeWidth={EDGE_STYLES[type].strokeWidth}
                      x1={1}
                      x2={23}
                      y1={4}
                      y2={4}
                    />
                  </svg>
                  {t(`edgeType.${type}`)}
                </span>
              ))}
              label={t("legend.edges")}
            />

            {/* horizontally scrollable SVG map — the page never overflows,
                only this inner container scrolls (375px-safe) */}
            <div className="overflow-x-auto rounded-lg border">
              <svg
                aria-label={t("mapAria", {
                  sites: visibleZones.length,
                  devices: visibleNodeCount,
                  links: visibleEdges.length,
                })}
                className="block"
                height={layout.height}
                role="img"
                style={{ minWidth: SVG_MIN_WIDTH, maxWidth: "none" }}
                viewBox={`0 0 ${layout.width} ${layout.height}`}
                width={layout.width}
              >
                {/* zone frames + headers */}
                {layout.zones.map((zone) => (
                  <g key={zone.key}>
                    <rect
                      fill="var(--surface-subtle)"
                      height={zone.h}
                      rx={12}
                      stroke="var(--border)"
                      strokeWidth={1}
                      width={zone.w}
                      x={zone.x}
                      y={zone.y}
                    />
                    <text
                      className="font-tech ltr-technical text-foreground"
                      dominantBaseline="central"
                      fill="currentColor"
                      fontSize={13}
                      fontWeight={600}
                      x={zone.x + ZONE_PAD}
                      y={zone.y + 18}
                    >
                      {zone.code ?? t("unassignedSite")}
                    </text>
                    <text
                      className="text-muted-foreground"
                      dominantBaseline="central"
                      fill="currentColor"
                      fontSize={10.5}
                      x={zone.x + ZONE_PAD}
                      y={zone.y + 34}
                    >
                      {zone.code
                        ? (siteNameByCode.get(zone.code) ?? zone.code)
                        : t("unassignedHint")}
                    </text>
                    <text
                      className="text-muted-foreground"
                      dominantBaseline="central"
                      fill="currentColor"
                      fontSize={10.5}
                      textAnchor="end"
                      x={zone.x + zone.w - ZONE_PAD}
                      y={zone.y + 18}
                    >
                      {zone.nodeCount}
                    </text>
                    <line
                      stroke="var(--border)"
                      x1={zone.x}
                      x2={zone.x + zone.w}
                      y1={zone.y + ZONE_HEADER_H}
                      y2={zone.y + ZONE_HEADER_H}
                    />
                  </g>
                ))}

                {/* edges (under the node pills) */}
                {routed.map((routedEdge) => {
                  const style = EDGE_STYLES[routedEdge.edge.type];
                  return (
                    <g key={routedEdge.edge.id}>
                      <path
                        d={routedEdge.d}
                        fill="none"
                        stroke={style.stroke}
                        strokeDasharray={style.dashed ? "6 5" : undefined}
                        strokeLinecap="round"
                        strokeWidth={style.strokeWidth}
                      />
                      {routedEdge.stub ? (
                        <circle
                          cx={routedEdge.stub.x}
                          cy={routedEdge.stub.y}
                          fill="var(--card)"
                          r={4}
                          stroke={style.stroke}
                          strokeWidth={1.5}
                        />
                      ) : null}
                      <text
                        className="text-muted-foreground"
                        dominantBaseline="central"
                        fill="currentColor"
                        fontSize={9.5}
                        stroke="var(--card)"
                        strokeLinejoin="round"
                        strokeWidth={3.5}
                        style={{ paintOrder: "stroke" }}
                        textAnchor="middle"
                        x={routedEdge.labelX}
                        y={routedEdge.labelY}
                      >
                        {routedEdge.edge.type === "ha"
                          ? t("haEdgeLabel")
                          : routedEdge.edge.label}
                      </text>
                    </g>
                  );
                })}

                {/* node pills — focusable buttons */}
                {visibleZones.flatMap((zone) =>
                  zone.nodes.map((node) => {
                    const entry = layout.nodePills.get(node.id);
                    if (!entry) return null;
                    const { pill } = entry;
                    const statusConfig = getStatusConfig(DEVICE_STATUS, node.status);
                    const RoleIcon = roleIconFor(node.role);
                    const roleLabel = node.role
                      ? t(`role.${node.role.trim().toUpperCase()}`)
                      : t("role.other");
                    return (
                      <g
                        aria-label={t("nodeAria", {
                          hostname: node.hostname,
                          status: resolveStatusLabel(statusConfig),
                          role: roleLabel,
                        })}
                        className="cursor-pointer outline-none"
                        key={node.id}
                        onBlur={() => setFocusedNodeId(null)}
                        onClick={() => openDetail(node.id)}
                        onFocus={() => setFocusedNodeId(node.id)}
                        onKeyDown={(event) => onNodeKeyDown(event, node.id)}
                        role="button"
                        tabIndex={0}
                      >
                        <rect
                          fill="var(--card)"
                          height={pill.h}
                          rx={8}
                          stroke="var(--border)"
                          strokeWidth={1}
                          width={pill.w}
                          x={pill.x}
                          y={pill.y}
                        />
                        {focusedNodeId === node.id ? (
                          <rect
                            fill="none"
                            height={pill.h + 5}
                            rx={10}
                            stroke="var(--ring)"
                            strokeDasharray="4 3"
                            strokeWidth={1.5}
                            width={pill.w + 5}
                            x={pill.x - 2.5}
                            y={pill.y - 2.5}
                          />
                        ) : null}
                        <circle
                          cx={pill.x + 15}
                          cy={pill.cy}
                          fill={TOKEN_VAR[statusConfig.token]}
                          r={4.5}
                        />
                        <RoleIcon
                          aria-hidden="true"
                          className="text-muted-foreground"
                          height={14}
                          width={14}
                          x={pill.x + 27}
                          y={pill.cy - 7}
                        />
                        <text
                          className="font-tech ltr-technical text-foreground"
                          dominantBaseline="central"
                          fill="currentColor"
                          fontSize={11.5}
                          x={pill.x + 47}
                          y={pill.cy}
                        >
                          {node.hostname}
                        </text>
                      </g>
                    );
                  })
                )}
              </svg>
            </div>
          </div>
        )}
      </SectionCard>

      {/* ── edge list (accessible representation of the map) ── */}
      <SectionCard
        description={t("links.description")}
        title={t("links.title")}
      >
        {visibleEdges.length === 0 ? (
          <EmptyState
            description={t("links.emptyDescription")}
            icon={Waypoints}
            title={t("links.emptyTitle")}
          />
        ) : (
          <div tabIndex={0} className="max-h-96 overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("table.type")}</TableHead>
                  <TableHead>{t("table.endpoints")}</TableHead>
                  <TableHead>{t("table.label")}</TableHead>
                  <TableHead>{t("table.simulated")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleEdges.map((edge) => (
                  <TableRow key={edge.id}>
                    <TableCell>
                      <Badge
                        className={EDGE_TYPE_BADGE[edge.type]}
                        variant="outline"
                      >
                        {t(`edgeType.${edge.type}`)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        <span className="font-tech ltr-technical text-xs">
                          {edge.sourceHostname}
                        </span>
                        <ArrowRight
                          aria-hidden="true"
                          className="size-3 text-muted-foreground"
                        />
                        <span className="font-tech ltr-technical text-xs">
                          {edge.targetHostname}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="max-w-[260px] truncate text-xs text-muted-foreground">
                      {edge.label}
                    </TableCell>
                    <TableCell>
                      {edge.simulated ? (
                        <Badge
                          className="bg-warning-subtle text-warning border-warning/25"
                          variant="outline"
                        >
                          {t("simulatedBadge")}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
