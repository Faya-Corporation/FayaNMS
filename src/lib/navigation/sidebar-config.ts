import {
  Activity as ActivityIcon,
  BadgeCheck,
  BellRing,
  CalendarClock,
  CalendarDays,
  CircleGauge,
  ClipboardCheck,
  Cpu,
  DatabaseBackup,
  FileDiff,
  FilePlus,
  FileText,
  Gauge,
  GitPullRequest,
  HeartPulse,
  History,
  KeyRound,
  KeySquare,
  LayoutDashboard,
  LayoutTemplate,
  ListTodo,
  MapPin,
  Network,
  Puzzle,
  Radar,
  Router,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  Siren,
  TrendingUp,
  Tv,
  UserCheck,
  Users,
  Webhook,
  Waypoints,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import type { ViewKey } from "@/stores/navigation";

/**
 * Sidebar taxonomy (design spec §16): Dashboard, then the seven domain
 * groups. Badge keys resolve to live counts from the dashboard payload.
 */

export type SidebarBadgeKey = "alerts" | "approvals" | "jobs";

export interface SidebarItemConfig {
  view: ViewKey;
  icon: LucideIcon;
  badge?: SidebarBadgeKey;
}

export interface SidebarGroupConfig {
  id: string;
  label: string;
  items: SidebarItemConfig[];
}

export const SIDEBAR_GROUPS: SidebarGroupConfig[] = [
  {
    id: "network",
    label: "Network",
    items: [
      { view: "network.devices", icon: Router },
      { view: "network.sites", icon: MapPin },
      { view: "network.interfaces", icon: Network },
      { view: "network.topology", icon: Waypoints },
      { view: "network.discovery", icon: Radar },
    ],
  },
  {
    id: "configurations",
    label: "Configurations",
    items: [
      { view: "config.backups", icon: DatabaseBackup },
      { view: "config.snapshots", icon: History },
      { view: "config.baselines", icon: ShieldCheck },
      { view: "config.drift", icon: FileDiff },
      { view: "config.compliance", icon: BadgeCheck },
    ],
  },
  {
    id: "changes",
    label: "Changes",
    items: [
      { view: "changes.all", icon: GitPullRequest },
      { view: "changes.mine", icon: UserCheck },
      { view: "changes.approvals", icon: ClipboardCheck, badge: "approvals" },
      { view: "changes.calendar", icon: CalendarDays },
      { view: "changes.templates", icon: LayoutTemplate },
    ],
  },
  {
    id: "operations",
    label: "Operations",
    items: [
      { view: "ops.noc", icon: Tv },
      { view: "ops.alerts", icon: BellRing, badge: "alerts" },
      { view: "ops.incidents", icon: Siren },
      { view: "ops.maintenance", icon: Wrench },
      { view: "ops.events", icon: ScrollText },
      { view: "ops.jobs", icon: ListTodo, badge: "jobs" },
    ],
  },
  {
    id: "performance",
    label: "Performance",
    items: [
      { view: "perf.overview", icon: Gauge },
      { view: "perf.devices", icon: Cpu },
      { view: "perf.interfaces", icon: ActivityIcon },
      { view: "perf.availability", icon: HeartPulse },
      { view: "perf.capacity", icon: TrendingUp },
      { view: "perf.predictive", icon: CircleGauge },
    ],
  },
  {
    id: "reports",
    label: "Reports",
    items: [
      { view: "reports.reports", icon: FileText },
      { view: "reports.scheduled", icon: CalendarClock },
      { view: "reports.builder", icon: FilePlus },
    ],
  },
  {
    id: "administration",
    label: "Administration",
    items: [
      { view: "admin.users", icon: Users },
      { view: "admin.credentials", icon: KeyRound },
      { view: "admin.apiClients", icon: KeySquare },
      { view: "admin.collectors", icon: Server },
      { view: "admin.drivers", icon: Puzzle },
      { view: "admin.integrations", icon: Webhook },
      { view: "admin.system", icon: Settings },
    ],
  },
];
