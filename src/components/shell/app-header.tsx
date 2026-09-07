"use client";

import { Fragment } from "react";
import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";
import { signOut, useSession } from "next-auth/react";
import { formatDistanceToNow, parseISO } from "date-fns";
import {
  Bell,
  Check,
  CircleHelp,
  Languages,
  ListTodo,
  LogOut,
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
import {
  useMarkNotificationsRead,
  useNotifications,
} from "@/hooks/api/use-notifications";

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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { EmptyState } from "@/components/domain/empty-state";
import { StatusDot } from "@/components/domain/status-dot";
import { cn } from "@/lib/utils";
import { isValidViewKey } from "@/lib/navigation/registry";
import { useLocalizedViewMeta } from "@/i18n/view-labels";
import { LOCALES, LOCALE_LABELS } from "@/i18n/locale";
import { ROLE_LABELS, type UserRole } from "@/lib/auth/roles";
import { useNavigationStore } from "@/stores/navigation";
import { usePermissionsStore } from "@/stores/permissions";
import { usePreferencesStore, type Density } from "@/stores/preferences";
import type { SidebarCounts } from "./sidebar-nav";

const DENSITY_ORDER: Density[] = ["comfortable", "compact", "dense"];
const DENSITY_LABEL_KEY: Record<Density, string> = {
  comfortable: "densityComfortable",
  compact: "densityCompact",
  dense: "densityDense",
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
  const tHeader = useTranslations("header");
  const tA11y = useTranslations("a11y");
  const tTour = useTranslations("tour");
  const localizedViewMeta = useLocalizedViewMeta();

  const activeView = useNavigationStore((state) => state.activeView);
  const setActiveView = useNavigationStore((state) => state.setActiveView);
  const density = usePreferencesStore((state) => state.density);
  const setDensity = usePreferencesStore((state) => state.setDensity);
  const startTour = usePreferencesStore((state) => state.startTour);
  const locale = usePreferencesStore((state) => state.locale);
  const setLocale = usePreferencesStore((state) => state.setLocale);
  const { theme, setTheme } = useTheme();
  const { toast } = useToast();

  // Real session identity (Task 7-a) — replaces the pre-auth hardcoded
  // "Admin" chip. Permission store carries the server-verified role.
  const { data: sessionData } = useSession();
  const permissionUser = usePermissionsStore((state) => state.user);
  const currentUser = permissionUser ??
    (sessionData?.user
      ? {
          id: sessionData.user.id,
          email: sessionData.user.email ?? "",
          name: sessionData.user.name,
          role: sessionData.user.role,
          isActive: true,
          createdAt: "",
        }
      : null);
  const initials = (currentUser?.name ?? currentUser?.email ?? "?")
    .split(/\s+/)
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const roleLabel =
    ROLE_LABELS[currentUser?.role as UserRole] ?? currentUser?.role ?? "";

  // Notifications center (Task 5-a; design §74 — separate surface from the
  // operational alert stream). Data-driven: unread badge, mark read,
  // deep-link into the ops views.
  const notificationsQuery = useNotifications({ refetchInterval: 15_000, limit: 30 });
  const markRead = useMarkNotificationsRead();
  const notificationItems = notificationsQuery.data?.data ?? [];
  const unreadCount = notificationsQuery.data?.meta.unreadCount ?? 0;

  const healthy = criticalAlerts === 0;
  // Localized breadcrumbs mirror breadcrumbFor(): dashboard is a lone crumb,
  // every other view is group → title (registry English fallback intact).
  const activeMeta = localizedViewMeta(activeView);
  const crumbs =
    activeView === "dashboard"
      ? [{ label: activeMeta.title }]
      : [{ label: activeMeta.group }, { label: activeMeta.title }];

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
        aria-label={collapsed ? tHeader("expandSidebar") : tHeader("collapseSidebar")}
        className="hidden lg:inline-flex"
        onClick={onToggleSidebar}
        size="icon"
        variant="ghost"
      >
        {collapsed ? (
          <PanelLeftOpen aria-hidden="true" className="rtl:-scale-x-100" />
        ) : (
          <PanelLeftClose aria-hidden="true" className="rtl:-scale-x-100" />
        )}
      </Button>
      <Button
        aria-label={tHeader("openNavigation")}
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
              <Fragment key={`${index}-${crumb.label}`}>
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
          aria-label={tHeader("searchAria")}
        >
          <Search aria-hidden="true" className="size-4 shrink-0" />
          <span className="hidden md:inline md:flex-1 md:truncate md:text-start">
            {tHeader("searchPlaceholder")}
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
            healthy ? tHeader("healthOkAria") : tHeader("healthCriticalAria")
          }
        >
          <StatusDot
            label={undefined}
            pulse={!healthy}
            token={healthy ? "success" : "danger"}
          />
          {healthy
            ? tHeader("systemHealthy")
            : tHeader("systemCritical", { count: criticalAlerts })}
        </span>

        {/* Job center */}
        <Button
          aria-label={tHeader("jobCenter")}
          className="relative"
          onClick={onOpenJobCenter}
          size="icon"
          variant="ghost"
        >
          <ListTodo aria-hidden="true" />
          {counts.jobs > 0 && (
            <span className="absolute -end-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground tabular-nums">
              {counts.jobs > 9 ? "9+" : counts.jobs}
            </span>
          )}
        </Button>

        {/* Notifications (§74 — separate from the alert stream) */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={
                unreadCount > 0
                  ? tHeader("notificationsUnreadAria", { count: unreadCount })
                  : tHeader("notifications")
              }
              className="relative"
              size="icon"
              variant="ghost"
            >
              <Bell aria-hidden="true" />
              {unreadCount > 0 && (
                <span className="absolute -end-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-danger text-[10px] font-semibold text-white tabular-nums">
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-80">
            <DropdownMenuLabel className="flex items-center justify-between">
              {tHeader("notifications")}
              {unreadCount > 0 && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground transition-colors hover:text-foreground"
                  disabled={markRead.isPending}
                  onClick={() => markRead.mutate({ all: true })}
                >
                  <Check aria-hidden="true" className="size-3" />
                  {tHeader("markAllRead")}
                </button>
              )}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {notificationItems.length === 0 ? (
              <div className="p-1">
                <EmptyState
                  className="border-none bg-transparent py-8"
                  description={tHeader("notifEmptyDescription")}
                  icon={Bell}
                  title={tHeader("notifEmptyTitle")}
                />
              </div>
            ) : (
              <div className="max-h-96 overflow-y-auto">
                {notificationItems.map((notification) => {
                  const severityToken =
                    notification.severity === "CRITICAL" ||
                    notification.severity === "SEV1"
                      ? "bg-danger"
                      : notification.severity === "HIGH" ||
                          notification.severity === "SEV2"
                        ? "bg-danger-orange"
                        : notification.severity === "MEDIUM" ||
                            notification.severity === "SEV3"
                          ? "bg-warning"
                          : "bg-info";
                  return (
                    <DropdownMenuItem
                      key={notification.id}
                      className="flex-col items-start gap-0.5 py-2.5"
                      onClick={() => {
                        if (!notification.readAt) {
                          markRead.mutate({ ids: [notification.id] });
                        }
                        if (
                          notification.link &&
                          isValidViewKey(notification.link)
                        ) {
                          setActiveView(notification.link);
                        }
                      }}
                    >
                      <span className="flex w-full items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5">
                          {!notification.readAt && (
                            <span
                              aria-hidden="true"
                              className={cn(
                                "size-1.5 shrink-0 rounded-full",
                                severityToken
                              )}
                            />
                          )}
                          <span
                            className={cn(
                              "truncate text-sm",
                              notification.readAt
                                ? "font-normal"
                                : "font-medium"
                            )}
                          >
                            {notification.title}
                          </span>
                        </span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {formatDistanceToNow(parseISO(notification.createdAt), {
                            addSuffix: true,
                          })}
                        </span>
                      </span>
                      <span className="line-clamp-2 text-xs text-muted-foreground">
                        {notification.body}
                      </span>
                    </DropdownMenuItem>
                  );
                })}
              </div>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Theme toggle */}
        <Button
          aria-label={tHeader("themeAria", {
            mode:
              theme === "light"
                ? tHeader("themeLight")
                : theme === "dark"
                  ? tHeader("themeDark")
                  : tHeader("themeSystem"),
          })}
          onClick={cycleTheme}
          size="icon"
          variant="ghost"
        >
          <ThemeIcon aria-hidden="true" />
        </Button>

        {/* Density toggle */}
        <Button
          aria-label={tHeader("densityAria", {
            tier: tHeader(DENSITY_LABEL_KEY[density]),
          })}
          onClick={cycleDensity}
          size="icon"
          variant="ghost"
        >
          <Rows3 aria-hidden="true" />
        </Button>

        {/* Guided tour (Phase 9-b) — starts the demo walkthrough overlay. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={tTour("startTour")}
              onClick={startTour}
              size="icon"
              variant="ghost"
            >
              <CircleHelp aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{tTour("startTour")}</TooltipContent>
        </Tooltip>

        {/* Language switcher (Task 8-a) — persisted in the preferences store. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={tA11y("languageSwitch")}
              size="icon"
              variant="ghost"
            >
              <Languages aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{tHeader("language")}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {LOCALES.map((option) => (
              <DropdownMenuItem
                key={option}
                onClick={() => setLocale(option)}
              >
                <Check
                  aria-hidden="true"
                  className={cn(
                    "size-4",
                    option === locale ? "opacity-100" : "opacity-0"
                  )}
                />
                {LOCALE_LABELS[option]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* User menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={tHeader("userMenu")}
              className="ms-1 gap-2 ps-1.5"
              variant="ghost"
            >
              <Avatar className="size-7">
                <AvatarFallback className="bg-primary text-xs font-semibold text-primary-foreground">
                  {initials || "?"}
                </AvatarFallback>
              </Avatar>
              <span className="hidden min-w-0 flex-col items-start leading-tight xl:flex">
                <span className="truncate text-sm font-medium">
                  {currentUser?.name ?? tHeader("signedIn")}
                </span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {roleLabel}
                </span>
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              <span className="block text-sm font-medium">
                {currentUser?.name ?? tHeader("signedIn")}
              </span>
              <span className="block truncate text-xs font-normal text-muted-foreground">
                {currentUser?.email ?? ""}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                setActiveView("admin.users");
              }}
            >
              <User aria-hidden="true" />
              {tHeader("usersAndRoles")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                signOut({ callbackUrl: "/" }).then(() => {
                  toast({
                    title: tHeader("signedOut"),
                    description: tHeader("signedOutDescription"),
                  });
                })
              }
            >
              <LogOut aria-hidden="true" />
              {tHeader("signOut")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
