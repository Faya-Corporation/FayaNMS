"use client";

import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import { FayaNMSLockup } from "@/components/brand";
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
 * canonical brand lockup on top (re-audit B1-003 — no hand-composed
 * mark + literal name), scrollable nav groups, collapse toggle at the
 * bottom.
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
          collapsed ? "justify-center px-2" : "px-4"
        )}
      >
        {/* Canonical lockup — expanded: tile + name + translated subtitle
            via the lockup's descriptorOverride API; collapsed: tile only. */}
        {collapsed ? (
          <FayaNMSLockup variant="compact" />
        ) : (
          <FayaNMSLockup
            variant="tiled"
            descriptorOverride={tNav("brand.subtitle")}
          />
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
