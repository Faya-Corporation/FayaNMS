"use client";

import { Waypoints } from "lucide-react";

import { cn } from "@/lib/utils";
import { SidebarNav, type SidebarCounts } from "./sidebar-nav";
import { Button } from "@/components/ui/button";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

interface AppSidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  counts: SidebarCounts;
}

/**
 * Desktop sidebar: 264px expanded / 72px collapsed (preferences store),
 * brand mark on top, scrollable nav groups, collapse toggle at the bottom.
 */
export function AppSidebar({
  collapsed,
  onToggleCollapsed,
  counts,
}: AppSidebarProps) {
  return (
    <aside
      data-collapsed={collapsed}
      className={cn(
        "sticky top-0 hidden h-screen shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-in-out lg:flex",
        collapsed ? "w-[72px]" : "w-[264px]"
      )}
    >
      <div
        className={cn(
          "flex h-14 shrink-0 items-center border-b",
          collapsed ? "justify-center px-2" : "gap-2.5 px-4"
        )}
      >
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground"
        >
          <Waypoints className="size-4.5" />
        </span>
        {!collapsed && (
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold leading-tight">
              FayaNMS
            </span>
            <span className="block text-[11px] leading-tight text-muted-foreground">
              Network Operations
            </span>
          </span>
        )}
      </div>

      <SidebarNav collapsed={collapsed} counts={counts} />

      <div
        className={cn(
          "flex h-12 shrink-0 items-center border-t",
          collapsed ? "justify-center px-2" : "justify-end px-3"
        )}
      >
        <Button
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="text-muted-foreground"
          onClick={onToggleCollapsed}
          size="icon"
          variant="ghost"
        >
          {collapsed ? (
            <PanelLeftOpen aria-hidden="true" />
          ) : (
            <PanelLeftClose aria-hidden="true" />
          )}
        </Button>
      </div>
    </aside>
  );
}
