"use client";

import { Fragment, useState } from "react";
import { useTheme } from "next-themes";
import {
  Bell,
  Check,
  ListTodo,
  Menu,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Rows3,
  Search,
  Sun,
  User,
} from "lucide-react";

import { useToast } from "@/hooks/use-toast";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/domain/empty-state";
import { StatusDot } from "@/components/domain/status-dot";
import { cn } from "@/lib/utils";
import { breadcrumbFor } from "@/lib/navigation/registry";
import { useNavigationStore } from "@/stores/navigation";
import { usePreferencesStore, type Density } from "@/stores/preferences";
import type { SidebarCounts } from "./sidebar-nav";

const DENSITY_ORDER: Density[] = ["comfortable", "compact", "dense"];
const DENSITY_LABEL: Record<Density, string> = {
  comfortable: "Comfortable",
  compact: "Compact",
  dense: "Dense",
};

interface AppHeaderProps {
  collapsed: boolean;
  onToggleSidebar: () => void;
  onOpenMobileNav: () => void;
  onOpenCommandPalette: () => void;
  onOpenJobCenter: () => void;
  counts: SidebarCounts;
  criticalAlerts: number;
}

/**
 * Top application bar: layout toggles + breadcrumb, global search entry
 * point, system health, job center, notifications, theme & density
 * controls and the user menu.
 */
export function AppHeader({
  collapsed,
  onToggleSidebar,
  onOpenMobileNav,
  onOpenCommandPalette,
  onOpenJobCenter,
  counts,
  criticalAlerts,
}: AppHeaderProps) {
  const activeView = useNavigationStore((state) => state.activeView);
  const density = usePreferencesStore((state) => state.density);
  const setDensity = usePreferencesStore((state) => state.setDensity);
  const { theme, setTheme } = useTheme();
  const { toast } = useToast();

  const [notifications, setNotifications] = useState([
    {
      id: "n1",
      title: "Report ready",
      description: "Weekly availability report finished generating.",
      time: "12 min ago",
    },
    {
      id: "n2",
      title: "Approval requested",
      description: "CHG-2026-00403 awaits your technical approval.",
      time: "48 min ago",
    },
  ]);

  const healthy = criticalAlerts === 0;
  const crumbs = breadcrumbFor(activeView);

  const cycleTheme = () => {
    if (theme === "light") setTheme("dark");
    else if (theme === "dark") setTheme("system");
    else setTheme("light");
  };

  const cycleDensity = () => {
    const next =
      DENSITY_ORDER[(DENSITY_ORDER.indexOf(density) + 1) % DENSITY_ORDER.length];
    setDensity(next);
  };

  const ThemeIcon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur md:px-4">
      {/* Layout controls */}
      <Button
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        className="hidden lg:inline-flex"
        onClick={onToggleSidebar}
        size="icon"
        variant="ghost"
      >
        {collapsed ? (
          <PanelLeftOpen aria-hidden="true" />
        ) : (
          <PanelLeftClose aria-hidden="true" />
        )}
      </Button>
      <Button
        aria-label="Open navigation menu"
        className="lg:hidden"
        onClick={onOpenMobileNav}
        size="icon"
        variant="ghost"
      >
        <Menu aria-hidden="true" />
      </Button>

      {/* Breadcrumb */}
      <Breadcrumb className="hidden sm:block">
        <BreadcrumbList>
          {crumbs.map((crumb, index) => {
            const isLast = index === crumbs.length - 1;
            return (
              <Fragment key={crumb.label}>
                <BreadcrumbItem>
                  {isLast ? (
                    <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                  ) : (
                    <span className="text-muted-foreground">{crumb.label}</span>
                  )}
                </BreadcrumbItem>
                {!isLast && <BreadcrumbSeparator />}
              </Fragment>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>

      <div className="ms-auto flex items-center gap-1 md:gap-1.5">
        {/* Global search / command palette trigger */}
        <button
          type="button"
          onClick={onOpenCommandPalette}
          className={cn(
            "flex h-9 items-center gap-2 rounded-md border border-input bg-background text-sm text-muted-foreground shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground",
            "w-9 justify-center md:w-56 md:justify-start md:px-3 lg:w-64"
          )}
          aria-label="Search (opens command palette)"
        >
          <Search aria-hidden="true" className="size-4 shrink-0" />
          <span className="hidden md:inline md:flex-1 md:truncate md:text-start">
            Search devices, incidents…
          </span>
          <kbd className="hidden h-5 items-center rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground md:flex">
            ⌘K
          </kbd>
        </button>

        {/* System health */}
        <span
          className="hidden items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs font-medium xl:flex"
          role="status"
          aria-label={
            healthy ? "System health: operational" : "System health: critical alerts active"
          }
        >
          <StatusDot
            label={undefined}
            pulse={!healthy}
            token={healthy ? "success" : "danger"}
          />
          {healthy ? "All systems operational" : `${criticalAlerts} critical alert${criticalAlerts === 1 ? "" : "s"}`}
        </span>

        {/* Job center */}
        <Button
          aria-label="Open job center"
          className="relative"
          onClick={onOpenJobCenter}
          size="icon"
          variant="ghost"
        >
          <ListTodo aria-hidden="true" />
          {counts.jobs > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground tabular-nums">
              {counts.jobs > 9 ? "9+" : counts.jobs}
            </span>
          )}
        </Button>

        {/* Notifications */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label="Notifications"
              className="relative"
              size="icon"
              variant="ghost"
            >
              <Bell aria-hidden="true" />
              {notifications.length > 0 && (
                <span
                  aria-hidden="true"
                  className="absolute right-1.5 top-1.5 size-2 rounded-full bg-danger"
                />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-80">
            <DropdownMenuLabel className="flex items-center justify-between">
              Notifications
              {notifications.length > 0 && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => setNotifications([])}
                >
                  <Check aria-hidden="true" className="size-3" />
                  Mark all read
                </button>
              )}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {notifications.length === 0 ? (
              <div className="p-1">
                <EmptyState
                  className="border-none bg-transparent py-8"
                  description="New report and approval updates will show up here."
                  icon={Bell}
                  title="You're all caught up"
                />
              </div>
            ) : (
              notifications.map((notification) => (
                <DropdownMenuItem
                  key={notification.id}
                  className="flex-col items-start gap-0.5 py-2.5"
                >
                  <span className="flex w-full items-center justify-between gap-2">
                    <span className="text-sm font-medium">{notification.title}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {notification.time}
                    </span>
                  </span>
                  <span className="line-clamp-2 text-xs text-muted-foreground">
                    {notification.description}
                  </span>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Theme toggle */}
        <Button
          aria-label={`Theme: ${theme ?? "system"} (click to cycle light, dark, system)`}
          onClick={cycleTheme}
          size="icon"
          variant="ghost"
        >
          <ThemeIcon aria-hidden="true" />
        </Button>

        {/* Density toggle */}
        <Button
          aria-label={`Density: ${DENSITY_LABEL[density]} (click to cycle)`}
          onClick={cycleDensity}
          size="icon"
          variant="ghost"
        >
          <Rows3 aria-hidden="true" />
        </Button>

        {/* User menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label="User menu"
              className="ms-1 gap-2 ps-1.5"
              variant="ghost"
            >
              <Avatar className="size-7">
                <AvatarFallback className="bg-primary text-xs font-semibold text-primary-foreground">
                  AD
                </AvatarFallback>
              </Avatar>
              <span className="hidden min-w-0 flex-col items-start leading-tight xl:flex">
                <span className="truncate text-sm font-medium">Admin</span>
                <span className="truncate text-[11px] text-muted-foreground">
                  System Administrator
                </span>
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              <span className="block text-sm font-medium">Admin</span>
              <span className="block text-xs font-normal text-muted-foreground">
                admin@fayanms.local
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() =>
                toast({
                  title: "Profile management arrives in Phase 7",
                  description: "User accounts and roles ship with the Administration module.",
                })
              }
            >
              <User aria-hidden="true" />
              Profile
              <span className="ms-auto text-[11px] text-muted-foreground">
                Phase 7
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem disabled>
              Sign out
              <span className="ms-auto text-[11px] text-muted-foreground">
                Phase 7
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
