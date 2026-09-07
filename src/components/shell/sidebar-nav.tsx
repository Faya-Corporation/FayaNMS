"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, LayoutDashboard } from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  SIDEBAR_GROUPS,
  type SidebarBadgeKey,
} from "@/lib/navigation/sidebar-config";
import { useLocaleInfo } from "@/i18n/locale-provider";
import {
  useLocalizedGroupLabel,
  useLocalizedViewMeta,
} from "@/i18n/view-labels";
import { useNavigationStore, type ViewKey } from "@/stores/navigation";

export interface SidebarCounts {
  alerts: number;
  approvals: number;
  jobs: number;
}

interface SidebarNavProps {
  collapsed: boolean;
  counts: SidebarCounts;
  /** Called after a navigation (used to close the mobile drawer). */
  onNavigate?: () => void;
  className?: string;
}

const BADGE_TONE: Record<SidebarBadgeKey, string> = {
  alerts: "bg-danger-subtle text-danger",
  approvals: "bg-warning-subtle text-warning",
  jobs: "bg-primary/10 text-primary",
};

const BADGE_DOT_TONE: Record<SidebarBadgeKey, string> = {
  alerts: "bg-danger",
  approvals: "bg-warning",
  jobs: "bg-primary",
};

/**
 * The full sidebar taxonomy (spec §16). Collapsible groups auto-expand when
 * they contain the active view; collapsed mode renders icon-only items with
 * tooltips. Used by both the desktop aside and the mobile drawer.
 */
export function SidebarNav({
  collapsed,
  counts,
  onNavigate,
  className,
}: SidebarNavProps) {
  const tA11y = useTranslations("a11y");
  const localizedViewMeta = useLocalizedViewMeta();
  const localizedGroupLabel = useLocalizedGroupLabel();

  const activeView = useNavigationStore((state) => state.activeView);
  const setActiveView = useNavigationStore((state) => state.setActiveView);

  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  const navigate = (view: ViewKey) => {
    setActiveView(view);
    onNavigate?.();
  };

  const badgeFor = (badge: SidebarBadgeKey | undefined): number => {
    if (!badge) return 0;
    return counts[badge];
  };

  return (
    <ScrollArea className={cn("flex-1 min-h-0", className)}>
      <nav
        aria-label={tA11y("mainNavigation")}
        className={cn("flex flex-col gap-1 pb-4", collapsed ? "px-2" : "px-3")}
      >
        {/* Dashboard is a standalone top-level entry. */}
        <NavItem
          active={activeView === "dashboard"}
          collapsed={collapsed}
          icon={LayoutDashboard}
          label={localizedViewMeta("dashboard").title}
          onClick={() => navigate("dashboard")}
        />

        {SIDEBAR_GROUPS.map((group) => {
          const containsActive = group.items.some(
            (item) => item.view === activeView
          );
          // Groups auto-expand while they own the active view unless the
          // user explicitly collapsed them.
          const isOpen = collapsed
            ? false
            : (openGroups[group.id] ?? containsActive);

          if (collapsed) {
            // Icon-only mode: flatten group items, tooltip carries context.
            return (
              <div key={group.id} className="mt-1 flex flex-col gap-1">
                <div className="mx-auto h-px w-6 bg-border" aria-hidden="true" />
                {group.items.map((item) => (
                  <NavItem
                    key={item.view}
                    active={activeView === item.view}
                    collapsed
                    icon={item.icon}
                    label={localizedViewMeta(item.view).title}
                    badgeCount={badgeFor(item.badge)}
                    badgeDotTone={item.badge ? BADGE_DOT_TONE[item.badge] : undefined}
                    onClick={() => navigate(item.view)}
                  />
                ))}
              </div>
            );
          }

          return (
            <Collapsible
              key={group.id}
              open={isOpen}
              onOpenChange={(open) =>
                setOpenGroups((prev) => ({ ...prev, [group.id]: open }))
              }
            >
              <CollapsibleTrigger
                className={cn(
                  "group mt-2 flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground",
                  containsActive && "text-foreground"
                )}
                aria-expanded={isOpen}
              >
                {localizedGroupLabel(group.id, group.label)}
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    "ms-auto size-3.5 shrink-0 transition-transform",
                    isOpen && "rotate-180"
                  )}
                />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="flex flex-col gap-0.5 pb-1 pt-0.5">
                  {group.items.map((item) => (
                    <NavItem
                      key={item.view}
                      active={activeView === item.view}
                      collapsed={false}
                      icon={item.icon}
                      label={localizedViewMeta(item.view).title}
                      badgeCount={badgeFor(item.badge)}
                      badgeTone={item.badge ? BADGE_TONE[item.badge] : undefined}
                      onClick={() => navigate(item.view)}
                    />
                  ))}
                </div>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </nav>
    </ScrollArea>
  );
}

/* ------------------------------------------------------------------ */

interface NavItemProps {
  active: boolean;
  collapsed: boolean;
  icon: LucideIconType;
  label: string;
  badgeCount?: number;
  badgeTone?: string;
  badgeDotTone?: string;
  onClick: () => void;
}

type LucideIconType = React.ComponentType<{ className?: string }>;

function NavItem({
  active,
  collapsed,
  icon: Icon,
  label,
  badgeCount = 0,
  badgeTone,
  badgeDotTone,
  onClick,
}: NavItemProps) {
  const { isRtl } = useLocaleInfo();

  const button = (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex h-(--density-control-h) min-h-9 w-full items-center gap-2.5 rounded-md text-sm transition-colors",
        collapsed ? "justify-center px-0" : "px-2.5",
        active
          ? "bg-primary/10 font-medium text-primary"
          : "text-muted-foreground hover:bg-accent hover:text-foreground"
      )}
    >
      {active && (
        <span
          aria-hidden="true"
          className="absolute inset-y-1.5 start-0 w-0.5 rounded-full bg-primary"
        />
      )}
      <Icon className="size-5 shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
      {!collapsed && badgeCount > 0 && (
        <span
          className={cn(
            "ms-auto min-w-5 rounded-full px-1.5 py-0.5 text-center text-[11px] font-semibold tabular-nums",
            badgeTone ?? "bg-muted text-muted-foreground"
          )}
        >
          {badgeCount > 99 ? "99+" : badgeCount}
        </span>
      )}
      {collapsed && badgeCount > 0 && (
        <span
          aria-hidden="true"
          className={cn(
            "absolute end-2 top-1.5 size-1.5 rounded-full",
            badgeDotTone ?? "bg-primary"
          )}
        />
      )}
    </button>
  );

  if (!collapsed) return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      {/* Tooltip flips with the reading direction. */}
      <TooltipContent className="font-medium" side={isRtl ? "left" : "right"}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
