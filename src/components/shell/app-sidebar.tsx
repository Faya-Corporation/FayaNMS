"use client";

import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import { FayaNMSMark } from "@/components/brand/fayanms-mark";
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
  const tNav = useTranslations("nav");
  const tHeader = useTranslations("header");

  return (
    <aside
      data-collapsed={collapsed}
      className={cn(
        // border-e (logical): the rail sits on the inline-start side and
        // flips with the document direction under RTL.
        "sticky top-0 hidden h-screen shrink-0 flex-col border-e bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-in-out lg:flex",
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
          <FayaNMSMark size="sm" tone="white" />
        </span>
        {!collapsed && (
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold leading-tight">
              FayaNMS
            </span>
            <span className="block text-[11px] leading-tight text-muted-foreground">
              {tNav("brand.subtitle")}
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
          aria-label={collapsed ? tHeader("expandSidebar") : tHeader("collapseSidebar")}
          className="text-muted-foreground"
          onClick={onToggleCollapsed}
          size="icon"
          variant="ghost"
        >
          {collapsed ? (
            <PanelLeftOpen aria-hidden="true" className="rtl:-scale-x-100" />
          ) : (
            <PanelLeftClose aria-hidden="true" className="rtl:-scale-x-100" />
          )}
        </Button>
      </div>
    </aside>
  );
}
