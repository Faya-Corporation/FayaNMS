"use client";

import { useEffect, useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { format, formatDistanceToNow } from "date-fns";
import {
  CalendarClock,
  CalendarRange,
  GitPullRequest,
  History,
  Pencil,
  Plus,
  Search,
  Trash2,
  Wrench,
} from "lucide-react";

import { useMeta } from "@/hooks/api/use-meta";
import { useDevices } from "@/hooks/api/use-devices";
import { useChanges } from "@/hooks/api/use-changes";
import {
  useCreateMaintenanceWindow,
  useDeleteMaintenanceWindow,
  useMaintenance,
  useToggleMaintenanceWindow,
  useUpdateMaintenanceWindow,
} from "@/hooks/api/use-maintenance";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { KpiCard } from "@/components/domain/kpi-card";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { StatusDot } from "@/components/domain/status-dot";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type {
  MaintenanceRow,
  MaintenanceStatus,
  MaintenanceWindowPayload,
} from "@/lib/api-client";

/**
 * Maintenance windows (Task 5-c): KPI row, status chips + site/device
 * filters, and CRUD. Active windows suppress alerts for their scope (the
 * alert engine semantics in src/lib/alerts/evaluate.ts are untouched —
 * this surface only manages the windows).
 */

const STATUS_FILTERS = [
  { key: "ALL", label: "All" },
  { key: "ACTIVE", label: "Active" },
  { key: "UPCOMING", label: "Upcoming" },
  { key: "PAST", label: "Past" },
] as const;

const BADGE_CLASSES: Record<MaintenanceStatus, string> = {
  ACTIVE: "bg-success-subtle text-success border-success/25",
  UPCOMING: "bg-info-subtle text-info border-info/25",
  PAST: "bg-neutral-subtle text-neutral border-neutral/25",
};

/** "YYYY-MM-DDTHH:mm" for <input type="datetime-local"> in local time. */
function toLocalInputValue(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fmtAbsolute(iso: string): string {
  return format(new Date(iso), "MMM d, HH:mm");
}

function fmtRelative(iso: string): string {
  return formatDistanceToNow(new Date(iso), { addSuffix: true });
}

function WindowStatusBadge({ status }: { status: MaintenanceStatus }) {
  const config: Record<
    MaintenanceStatus,
    { label: string; token: "success" | "info" | "neutral"; pulse: boolean }
  > = {
    ACTIVE: { label: "Active", token: "success", pulse: true },
    UPCOMING: { label: "Upcoming", token: "info", pulse: false },
    PAST: { label: "Past", token: "neutral", pulse: false },
  };
  const entry = config[status];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        BADGE_CLASSES[status]
      )}
    >
      <StatusDot pulse={entry.pulse} token={entry.token} />
      {entry.label}
    </span>
  );
}

/** Scope chip: site code, hostname, or "Fleet" when nothing is scoped. */
function ScopeChip({ row }: { row: MaintenanceRow }) {
  if (row.device) {
    return (
      <span className="inline-flex max-w-[22ch] shrink-0 items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-[11px] font-tech ltr-technical">
        <Wrench aria-hidden className="size-3 shrink-0" />
        <span className="truncate">{row.device.hostname}</span>
      </span>
    );
  }
  if (row.site) {
    return (
      <span className="inline-flex max-w-[22ch] shrink-0 items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-[11px] font-tech ltr-technical">
        <span className="truncate">{row.site.code}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      Fleet-wide
    </span>
  );
}

const windowFormSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(160),
    siteId: z.string(), // "" = fleet-wide
    deviceId: z.string(), // "" = no device
    changeId: z.string(), // "" = no linked change
    startsAt: z.string().min(1, "Start is required"),
    endsAt: z.string().min(1, "End is required"),
    reason: z.string().trim().max(500),
    isActive: z.boolean(),
  })
  .refine(
    (values) =>
      !values.startsAt ||
      !values.endsAt ||
      new Date(values.endsAt).getTime() > new Date(values.startsAt).getTime(),
    { message: "End must be after start", path: ["endsAt"] }
  );

type WindowFormValues = z.infer<typeof windowFormSchema>;

/**
 * Client-side preview of the server's non-blocking overlap warning: same
 * device (or, for site/fleet windows, same site) + intersecting time range,
 * checked against the currently loaded windows.
 */
function WindowFormDialog({
  open,
  onOpenChange,
  row,
  loadedWindows,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: MaintenanceRow | null;
  loadedWindows: MaintenanceRow[];
}) {
  const meta = useMeta();
  const createWindow = useCreateMaintenanceWindow();
  const updateWindow = useUpdateMaintenanceWindow();

  const editing = Boolean(row);
  const defaultValues: WindowFormValues = useMemo(
    () => ({
      name: row?.name ?? "",
      siteId: row?.site?.id ?? "",
      deviceId: row?.device?.id ?? "",
      changeId: row?.change?.id ?? "",
      startsAt: row ? toLocalInputValue(row.startsAt) : toLocalInputValue(new Date().toISOString()),
      endsAt: row
        ? toLocalInputValue(row.endsAt)
        : toLocalInputValue(new Date(Date.now() + 4 * 3600 * 1000).toISOString()),
      reason: row?.reason ?? "",
      isActive: row?.isActive ?? true,
    }),
    [row]
  );

  const form = useForm<WindowFormValues>({
    defaultValues,
    resolver: zodResolver(windowFormSchema),
    mode: "onSubmit",
  });

  useEffect(() => {
    if (open) form.reset(defaultValues);
  }, [open, defaultValues, form]);

  const watchedSiteId = useWatch({ control: form.control, name: "siteId" });
  const watchedDeviceId = useWatch({ control: form.control, name: "deviceId" });
  const watchedStartsAt = useWatch({ control: form.control, name: "startsAt" });
  const watchedEndsAt = useWatch({ control: form.control, name: "endsAt" });
  const watchedChangeId = useWatch({ control: form.control, name: "changeId" });
  const watchedIsActive = useWatch({ control: form.control, name: "isActive" });

  // Devices are site-filtered (editing keeps the window's own device
  // visible even before the site changes).
  const devices = useDevices({
    siteId: watchedSiteId || undefined,
    pageSize: 100,
    sort: "hostname",
  });
  const changes = useChanges({ pageSize: 100 });

  const overlaps = useMemo(() => {
    if (!watchedStartsAt || !watchedEndsAt) return [];
    const start = new Date(watchedStartsAt).getTime();
    const end = new Date(watchedEndsAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
    return loadedWindows.filter((candidate) => {
      if (row && candidate.id === row.id) return false;
      if (!candidate.isActive) return false;
      if (watchedDeviceId) {
        if (candidate.device?.id !== watchedDeviceId) return false;
      } else if (watchedSiteId) {
        if (candidate.site?.id !== watchedSiteId) return false;
      } else if (candidate.device || candidate.site) {
        return false;
      }
      const candidateStart = new Date(candidate.startsAt).getTime();
      const candidateEnd = new Date(candidate.endsAt).getTime();
      return candidateStart < end && candidateEnd > start;
    });
  }, [loadedWindows, row, watchedDeviceId, watchedSiteId, watchedStartsAt, watchedEndsAt]);

  const pending = createWindow.isPending || updateWindow.isPending;

  const onSubmit = (values: WindowFormValues) => {
    const payload: MaintenanceWindowPayload = {
      name: values.name,
      siteId: values.siteId || null,
      deviceId: values.deviceId || null,
      changeId: values.changeId || null,
      startsAt: new Date(values.startsAt).toISOString(),
      endsAt: new Date(values.endsAt).toISOString(),
      reason: values.reason || null,
      isActive: values.isActive,
    };
    if (editing && row) {
      updateWindow.mutate(
        { id: row.id, data: payload },
        { onSuccess: () => onOpenChange(false) }
      );
      return;
    }
    createWindow.mutate(payload, { onSuccess: () => onOpenChange(false) });
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit maintenance window" : "New maintenance window"}</DialogTitle>
          <DialogDescription>
            While an active window covers a device (or its site), the alert
            engine suppresses new alerts for that scope instead of firing.
          </DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={form.handleSubmit(onSubmit)}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mw-name">Name *</Label>
            <Input
              {...form.register("name")}
              aria-invalid={Boolean(form.formState.errors.name)}
              id="mw-name"
              placeholder="BR2-Access-SW-01 firmware prep (MW-2026-011)"
            />
            {form.formState.errors.name && (
              <p className="text-xs text-danger">{form.formState.errors.name.message}</p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>Site</Label>
              <Select
                onValueChange={(value) => {
                  form.setValue("siteId", value === "__none__" ? "" : value);
                  // Scope moves with the site — clear a device from another site.
                  form.setValue("deviceId", "");
                }}
                value={watchedSiteId || "__none__"}
              >
                <SelectTrigger aria-label="Site">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Fleet-wide (no site)</SelectItem>
                  {(meta.data?.sites ?? []).map((site) => (
                    <SelectItem key={site.id} value={site.id}>
                      {site.name} ({site.code})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Device</Label>
              <Select
                onValueChange={(value) =>
                  form.setValue("deviceId", value === "__none__" ? "" : value)
                }
                value={watchedDeviceId || "__none__"}
              >
                <SelectTrigger aria-label="Device">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-60">
                  <SelectItem value="__none__">
                    {watchedSiteId ? "Whole site" : "Fleet-wide"}
                  </SelectItem>
                  {(devices.data?.data ?? []).map((device) => (
                    <SelectItem key={device.id} value={device.id}>
                      {device.hostname}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {watchedSiteId ? "Filtered to the selected site." : "All sites shown."}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mw-starts">Starts *</Label>
              <Input
                {...form.register("startsAt")}
                aria-invalid={Boolean(form.formState.errors.startsAt)}
                id="mw-starts"
                type="datetime-local"
              />
              {form.formState.errors.startsAt && (
                <p className="text-xs text-danger">{form.formState.errors.startsAt.message}</p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mw-ends">Ends *</Label>
              <Input
                {...form.register("endsAt")}
                aria-invalid={Boolean(form.formState.errors.endsAt)}
                id="mw-ends"
                type="datetime-local"
              />
              {form.formState.errors.endsAt && (
                <p className="text-xs text-danger">{form.formState.errors.endsAt.message}</p>
              )}
            </div>
          </div>

          {overlaps.length > 0 && (
            <div className="rounded-md border border-warning/30 bg-warning-subtle px-3 py-2 text-xs text-warning" role="status">
              Overlaps {overlaps.length} active same-scope window
              {overlaps.length === 1 ? "" : "s"}: {overlaps.map((entry) => entry.name).join(", ")}. Saving is
              allowed — the most specific scope suppresses first.
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mw-reason">Reason</Label>
            <Input
              {...form.register("reason")}
              id="mw-reason"
              placeholder="AOS-CX 10.10 → 10.13 upgrade prep; alert suppression active."
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Linked change (optional)</Label>
            <Select
              onValueChange={(value) =>
                form.setValue("changeId", value === "__none__" ? "" : value)
              }
              value={watchedChangeId || "__none__"}
            >
              <SelectTrigger aria-label="Linked change">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-60">
                <SelectItem value="__none__">No linked change</SelectItem>
                {(changes.data?.data ?? []).map((change) => (
                  <SelectItem key={change.id} value={change.id}>
                    {change.number} — {change.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <label className="flex items-center justify-between gap-3 rounded-md border bg-surface-subtle px-3 py-2.5">
            <span className="text-sm font-medium">
              Suppression active
              <span className="block text-xs font-normal text-muted-foreground">
                Pause to keep the window for planning without suppressing alerts.
              </span>
            </span>
            <Switch
              aria-label="Suppression active"
              checked={watchedIsActive}
              onCheckedChange={(checked) => form.setValue("isActive", checked)}
            />
          </label>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={pending} type="submit">
              {editing ? "Save changes" : "Create window"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function MaintenanceView() {
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [siteId, setSiteId] = useState<string>("ALL");
  const [deviceId, setDeviceId] = useState<string>("ALL");
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  const [formOpen, setFormOpen] = useState(false);
  const [editRow, setEditRow] = useState<MaintenanceRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MaintenanceRow | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const meta = useMeta();
  const sites = meta.data?.sites ?? [];

  // Device filter select (light list; narrowed when a site is picked).
  const devices = useDevices({
    siteId: siteId === "ALL" ? undefined : siteId,
    pageSize: 100,
    sort: "hostname",
  });

  const windows = useMaintenance({
    status: statusFilter === "ALL" ? undefined : (statusFilter as MaintenanceStatus),
    siteId: siteId === "ALL" ? undefined : siteId,
    deviceId: deviceId === "ALL" ? undefined : deviceId,
    q: q || undefined,
    page,
    pageSize: 20,
  });

  const rows = windows.data?.data ?? [];
  const listMeta = windows.data?.meta;
  const toggleWindow = useToggleMaintenanceWindow();
  const deleteWindow = useDeleteMaintenanceWindow();

  const resetFilters = () => {
    setStatusFilter("ALL");
    setSiteId("ALL");
    setDeviceId("ALL");
    setSearchInput("");
    setQ("");
    setPage(1);
  };

  const hasFilters =
    statusFilter !== "ALL" || siteId !== "ALL" || deviceId !== "ALL" || q !== "";

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        description="Planned windows during which alerts are suppressed for the scoped device or site"
        primaryAction={
          <Button
            onClick={() => {
              setEditRow(null);
              setFormOpen(true);
            }}
          >
            <Plus aria-hidden="true" />
            New window
          </Button>
        }
        title="Maintenance Windows"
      />

      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard
          description="Windows covering now and suppressing alerts"
          icon={Wrench}
          label="Active now"
          loading={windows.isLoading}
          status={{ label: "live", token: "info", pulse: true }}
          value={listMeta?.activeNow ?? "—"}
        />
        <KpiCard
          description="Starting within the next 24 hours"
          icon={CalendarClock}
          label="Upcoming 24 h"
          loading={windows.isLoading}
          value={listMeta?.upcoming24h ?? "—"}
        />
        <KpiCard
          description="Ended in the last 7 days"
          icon={History}
          label="Past 7 days"
          loading={windows.isLoading}
          value={listMeta?.past7d ?? "—"}
        />
      </div>

      {/* Status chips */}
      <div className="flex flex-wrap items-center gap-2">
        {STATUS_FILTERS.map((entry) => (
          <button
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
              statusFilter === entry.key
                ? "border-primary/30 bg-primary/10 text-primary"
                : "bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
            key={entry.key}
            onClick={() => {
              setStatusFilter(entry.key);
              setPage(1);
            }}
            type="button"
          >
            {entry.label}
            {entry.key === "ACTIVE" && listMeta ? ` · ${listMeta.activeNow}` : ""}
          </button>
        ))}
      </div>

      {/* Toolbar: site, device, search */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative">
          <span className="sr-only">Search windows</span>
          <Search
            aria-hidden
            className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            className="w-full ps-8 sm:w-64"
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search name or reason…"
            value={searchInput}
          />
        </label>
        <Select
          onValueChange={(value) => {
            setSiteId(value);
            setDeviceId("ALL");
            setPage(1);
          }}
          value={siteId}
        >
          <SelectTrigger aria-label="Site" className="w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Any site</SelectItem>
            {sites.map((site) => (
              <SelectItem key={site.id} value={site.id}>
                {site.code}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          onValueChange={(value) => {
            setDeviceId(value);
            setPage(1);
          }}
          value={deviceId}
        >
          <SelectTrigger aria-label="Device" className="w-[190px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-60">
            <SelectItem value="ALL">Any device</SelectItem>
            {(devices.data?.data ?? []).map((device) => (
              <SelectItem key={device.id} value={device.id}>
                {device.hostname}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hasFilters && (
          <Button onClick={resetFilters} size="sm" variant="ghost">
            Reset
          </Button>
        )}
      </div>

      <SectionCard
        contentClassName="p-0"
        title={`Windows${listMeta ? ` — ${listMeta.total}` : ""}`}
      >
        {windows.isError ? (
          <div className="p-4">
            <ErrorState
              onRetry={() => void windows.refetch()}
              reason={windows.error.message}
              title="Maintenance windows could not be loaded"
            />
          </div>
        ) : windows.isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="h-11 animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              description="No maintenance windows match the current filter. Create one to suppress alerts during planned work."
              icon={CalendarRange}
              title="No maintenance windows to show"
            />
          </div>
        ) : (
          <ul className="max-h-[600px] overflow-y-auto">
            {rows.map((row) => (
              <li
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-4 py-2.5 transition-colors last:border-0 hover:bg-accent/40"
                key={row.id}
              >
                <WindowStatusBadge status={row.status} />
                <span className="min-w-0 max-w-[30ch] flex-1 truncate text-sm font-medium" title={row.name}>
                  {row.name}
                </span>
                <ScopeChip row={row} />
                <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">
                  <span className="font-tech ltr-technical">
                    {fmtAbsolute(row.startsAt)} → {fmtAbsolute(row.endsAt)}
                  </span>
                  <span className="ms-1.5">
                    ({fmtRelative(row.startsAt)})
                  </span>
                </span>
                {row.reason && (
                  <span className="hidden min-w-0 max-w-[28ch] shrink-0 truncate text-xs text-muted-foreground lg:inline" title={row.reason}>
                    {row.reason}
                  </span>
                )}
                {row.change && (
                  <span className="hidden shrink-0 items-center gap-1 rounded-full border border-info/25 bg-info-subtle px-2 py-0.5 text-[11px] font-medium text-info xl:inline-flex">
                    <GitPullRequest aria-hidden className="size-3" />
                    {row.change.number}
                  </span>
                )}
                {!row.isActive && (
                  <span className="shrink-0 rounded-full border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    Suppression paused
                  </span>
                )}
                <div className="ms-auto flex shrink-0 items-center gap-1">
                  <Switch
                    aria-label={`${row.isActive ? "Pause" : "Enable"} suppression for ${row.name}`}
                    checked={row.isActive}
                    disabled={toggleWindow.isPending}
                    onCheckedChange={(checked) =>
                      toggleWindow.mutate({ id: row.id, isActive: checked })
                    }
                  />
                  <Button
                    aria-label={`Edit ${row.name}`}
                    onClick={() => {
                      setEditRow(row);
                      setFormOpen(true);
                    }}
                    size="icon"
                    variant="ghost"
                  >
                    <Pencil aria-hidden="true" />
                  </Button>
                  <Button
                    aria-label={`Delete ${row.name}`}
                    disabled={deleteWindow.isPending}
                    onClick={() => setDeleteTarget(row)}
                    size="icon"
                    variant="ghost"
                  >
                    <Trash2 aria-hidden="true" className="text-danger" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {listMeta && listMeta.totalPages > 1 && (
          <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
            <span>
              Page {listMeta.page} of {listMeta.totalPages} · {listMeta.total} windows
            </span>
            <div className="flex gap-2">
              <Button
                disabled={listMeta.page <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
                size="sm"
                variant="outline"
              >
                Previous
              </Button>
              <Button
                disabled={listMeta.page >= listMeta.totalPages}
                onClick={() => setPage((value) => value + 1)}
                size="sm"
                variant="outline"
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </SectionCard>

      <WindowFormDialog
        loadedWindows={rows}
        onOpenChange={setFormOpen}
        open={formOpen}
        row={editRow}
      />

      <AlertDialog
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        open={deleteTarget !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The window is removed permanently. Alerts for its scope fire
              normally again immediately — existing alerts and incidents are
              untouched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-danger text-white hover:bg-danger/90"
              onClick={() => {
                if (!deleteTarget) return;
                deleteWindow.mutate(deleteTarget.id, {
                  onSettled: () => setDeleteTarget(null),
                });
              }}
            >
              Delete window
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
