"use client";

import { useEffect, useState } from "react";
import {
  Activity,
  BadgeCheck,
  BellRing,
  CalendarClock,
  CalendarDays,
  ClipboardCheck,
  CloudUpload,
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

import { useToast } from "@/hooks/use-toast";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { DeviceStatusBadge } from "@/components/domain/device-status-badge";
import { useDevices } from "@/hooks/api/use-devices";
import { useCreateJob } from "@/hooks/api/use-jobs";
import { useSearch } from "@/hooks/api/use-search";
import { getViewMeta } from "@/lib/navigation/registry";
import { useNavigationStore, type ViewKey } from "@/stores/navigation";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenJobCenter: () => void;
}

type PaletteMode = "root" | "backup";

/** Every registry view for the Navigation section. */
const NAVIGATION_ITEMS: { view: ViewKey; icon: LucideIcon }[] = [
  { view: "network.devices", icon: Router },
  { view: "network.sites", icon: MapPin },
  { view: "network.interfaces", icon: Network },
  { view: "network.topology", icon: Waypoints },
  { view: "network.discovery", icon: Radar },
  { view: "config.backups", icon: DatabaseBackup },
  { view: "config.snapshots", icon: History },
  { view: "config.baselines", icon: ShieldCheck },
  { view: "config.drift", icon: FileDiff },
  { view: "config.compliance", icon: BadgeCheck },
  { view: "changes.all", icon: GitPullRequest },
  { view: "changes.mine", icon: UserCheck },
  { view: "changes.approvals", icon: ClipboardCheck },
  { view: "changes.calendar", icon: CalendarDays },
  { view: "changes.templates", icon: LayoutTemplate },
  { view: "ops.noc", icon: Tv },
  { view: "ops.alerts", icon: BellRing },
  { view: "ops.incidents", icon: Siren },
  { view: "ops.maintenance", icon: Wrench },
  { view: "ops.events", icon: ScrollText },
  { view: "ops.jobs", icon: ListTodo },
  { view: "perf.overview", icon: Gauge },
  { view: "perf.devices", icon: Cpu },
  { view: "perf.interfaces", icon: Activity },
  { view: "perf.availability", icon: HeartPulse },
  { view: "perf.capacity", icon: TrendingUp },
  { view: "reports.reports", icon: FileText },
  { view: "reports.scheduled", icon: CalendarClock },
  { view: "reports.builder", icon: FilePlus },
  { view: "admin.users", icon: Users },
  { view: "admin.credentials", icon: KeyRound },
  { view: "admin.apiClients", icon: KeySquare },
  { view: "admin.collectors", icon: Server },
  { view: "admin.drivers", icon: Puzzle },
  { view: "admin.integrations", icon: Webhook },
  { view: "admin.system", icon: Settings },
];

/**
 * Global command palette (⌘K): navigation across every registry view,
 * quick actions (backup now with a device picker) and live search results
 * against /api/v1/search. Single admin role — no permission filtering yet.
 */
export function CommandPalette({
  open,
  onOpenChange,
  onOpenJobCenter,
}: CommandPaletteProps) {
  const setActiveView = useNavigationStore((state) => state.setActiveView);
  const { toast } = useToast();

  const [mode, setMode] = useState<PaletteMode>("root");
  const [input, setInput] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, [open, onOpenChange]);

  // Debounce the search input before hitting /api/v1/search.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(input), 250);
    return () => clearTimeout(timer);
  }, [input]);

  // Reset the palette content whenever it is (re)opened. Resetting in the
  // open handler keeps the effect body free of cascading setStates.
  const handleOpenChange = (next: boolean) => {
    if (next) {
      setMode("root");
      setInput("");
      setDebounced("");
    }
    onOpenChange(next);
  };

  const search = useSearch(mode === "root" ? debounced : "");
  const devices = useDevices(
    mode === "backup" ? { pageSize: 50, sort: "hostname", dir: "asc" } : { pageSize: 1 }
  );
  const createJob = useCreateJob();

  const runBackup = (deviceId: string) => {
    createJob.mutate(
      { type: "CONFIG_BACKUP", deviceId },
      {
        onSuccess: () => {
          onOpenChange(false);
          onOpenJobCenter();
        },
      }
    );
  };

  const navigateTo = (view: ViewKey, params?: Record<string, string>) => {
    onOpenChange(false);
    setActiveView(view, params);
  };

  const showToastFor = (title: string, description?: string) => {
    onOpenChange(false);
    toast({ title, description });
  };

  return (
    <CommandDialog
      description={
        mode === "backup"
          ? "Pick a device to queue an immediate configuration backup."
          : "Type a command or search devices, incidents and changes."
      }
      open={open}
      onOpenChange={handleOpenChange}
      title={mode === "backup" ? "Backup now" : "Command Palette"}
    >
      <CommandInput
        onValueChange={setInput}
        placeholder={
          mode === "backup"
            ? "Select a device…"
            : "Search commands, devices, incidents…"
        }
        value={input}
      />
      <CommandList>
        <CommandEmpty>
          {mode === "backup"
            ? "No matching devices."
            : debounced.length >= 2
              ? "No results found."
              : "Type to search or pick a destination below."}
        </CommandEmpty>

        {mode === "backup" ? (
          <CommandGroup heading="Devices">
            {(devices.data?.data ?? []).map((device) => (
              <CommandItem
                key={device.id}
                onSelect={() => runBackup(device.id)}
                value={`${device.hostname} ${device.mgmtIp} ${device.displayName ?? ""}`}
              >
                <CloudUpload aria-hidden="true" className="text-muted-foreground" />
                <span className="flex-1 truncate">
                  <span className="font-medium">{device.hostname}</span>
                  <span className="ltr-technical ms-2 font-tech text-muted-foreground">
                    {device.mgmtIp}
                  </span>
                </span>
                <DeviceStatusBadge className="max-sm:hidden" value={device.status} />
              </CommandItem>
            ))}
          </CommandGroup>
        ) : (
          <>
            {debounced.length >= 2 && search.data && (
              <CommandGroup heading="Search Results">
                {search.data.devices.map((device) => (
                  <CommandItem
                    key={`device-${device.id}`}
                    onSelect={() => {
                      navigateTo("network.devices", { selectedId: device.id });
                      toast({
                        title: "Device detail arrives with Phase 2",
                        description: `${device.hostname} selected in the device list.`,
                      });
                    }}
                    value={`device ${device.hostname} ${device.mgmtIp}`}
                  >
                    <Cpu aria-hidden="true" className="text-muted-foreground" />
                    <span className="flex-1 truncate">{device.hostname}</span>
                    <span className="ltr-technical font-tech text-xs text-muted-foreground">
                      {device.mgmtIp}
                    </span>
                  </CommandItem>
                ))}
                {search.data.incidents.map((incident) => (
                  <CommandItem
                    key={`incident-${incident.id}`}
                    onSelect={() =>
                      showToastFor(
                        "Incident detail arrives with Phase 5",
                        `${incident.number} opened from the command palette.`
                      )
                    }
                    value={`incident ${incident.number} ${incident.title}`}
                  >
                    <Siren aria-hidden="true" className="text-muted-foreground" />
                    <span className="font-tech">{incident.number}</span>
                    <span className="flex-1 truncate">{incident.title}</span>
                  </CommandItem>
                ))}
                {search.data.changes.map((change) => (
                  <CommandItem
                    key={`change-${change.id}`}
                    onSelect={() =>
                      showToastFor(
                        "Change detail arrives with Phase 4",
                        `${change.number} — open the change module for the full record.`
                      )
                    }
                    value={`change ${change.number} ${change.title}`}
                  >
                    <GitPullRequest
                      aria-hidden="true"
                      className="text-muted-foreground"
                    />
                    <span className="font-tech">{change.number}</span>
                    <span className="flex-1 truncate">{change.title}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            <CommandGroup heading="Quick Actions">
              <CommandItem
                onSelect={() => {
                  setMode("backup");
                  setInput("");
                }}
                value="backup now configuration device"
              >
                <CloudUpload aria-hidden="true" className="text-muted-foreground" />
                <span>Backup now…</span>
                <span className="ms-auto text-xs text-muted-foreground">
                  pick a device
                </span>
              </CommandItem>
              <CommandItem
                onSelect={() => {
                  onOpenChange(false);
                  onOpenJobCenter();
                }}
                value="open job center queue"
              >
                <ListTodo aria-hidden="true" className="text-muted-foreground" />
                <span>Open Job Center</span>
              </CommandItem>
            </CommandGroup>

            <CommandSeparator />
            <CommandGroup heading="Navigation">
              {NAVIGATION_ITEMS.map((item) => {
                const Icon = item.icon;
                return (
                  <CommandItem
                    key={item.view}
                    onSelect={() => navigateTo(item.view)}
                    value={`${getViewMeta(item.view).group} ${getViewMeta(item.view).title} ${getViewMeta(item.view).description}`}
                  >
                    <Icon aria-hidden="true" className="text-muted-foreground" />
                    <span>{getViewMeta(item.view).title}</span>
                    <span className="ms-auto text-xs text-muted-foreground">
                      {getViewMeta(item.view).group}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
