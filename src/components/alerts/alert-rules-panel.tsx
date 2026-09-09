"use client";

import { useEffect, useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Pencil, Plus, Trash2 } from "lucide-react";

import { useMeta } from "@/hooks/api/use-meta";
import {
  useAlertRules,
  useCreateAlertRule,
  useDeleteAlertRule,
  useUpdateAlertRule,
} from "@/hooks/api/use-alert-rules";
import { SeverityBadge } from "@/components/domain/severity-badge";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { SectionCard } from "@/components/domain/section-card";
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
import { Checkbox } from "@/components/ui/checkbox";
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
import type { AlertRuleRow } from "@/lib/api-client";

/**
 * Rules management panel (Task 5-a, second tab of the Alerts view):
 * table of alert rules + create/edit dialog + delete guard
 * (409 RULE_IN_USE surfaces as a toast suggesting deactivation).
 */

const METRIC_OPTIONS: { value: string; label: string }[] = [
  { value: "CPU", label: "CPU utilization (%)" },
  { value: "MEMORY", label: "Memory utilization (%)" },
  { value: "UTILIZATION_IN", label: "Inbound utilization (%)" },
  { value: "UTILIZATION_OUT", label: "Outbound utilization (%)" },
  { value: "LATENCY_MS", label: "Latency (ms)" },
  { value: "PACKET_LOSS", label: "Packet loss (%)" },
  { value: "SESSIONS", label: "Session count" },
  { value: "TEMPERATURE", label: "Temperature (°C)" },
  { value: "AVAILABILITY", label: "Availability — device down (0/1)" },
];

const OPERATOR_OPTIONS = ["GT", "GTE", "LT", "LTE", "EQ"] as const;
const SEVERITY_OPTIONS = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const;
const CRITICALITY_OPTIONS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
const ROLE_OPTIONS = [
  "CORE_ROUTER",
  "EDGE_ROUTER",
  "BRANCH_ROUTER",
  "FIREWALL",
  "CORE_SWITCH",
  "ACCESS_SWITCH",
  "TOP_OF_RACK",
  "WIRELESS_CONTROLLER",
  "LOAD_BALANCER",
  "WAN_GATEWAY",
] as const;

const ruleFormSchema = z.object({
  name: z.string().trim().min(2, "Name is required").max(80),
  metric: z.string().min(1, "Pick a metric"),
  operator: z.string().min(1, "Pick an operator"),
  // String inputs keep zodResolver input/output types aligned (3-a pattern).
  threshold: z
    .string()
    .trim()
    .min(1, "Threshold is required")
    .refine((value) => Number.isFinite(Number(value)), "Enter a number"),
  durationMinutes: z
    .string()
    .trim()
    .min(1, "Duration is required")
    .regex(/^\d+$/, "Whole minutes only")
    .refine((value) => {
      const n = Number(value);
      return n >= 1 && n <= 1440;
    }, "Between 1 and 1440 minutes"),
  severity: z.string().min(1, "Pick a severity"),
  siteCodes: z.array(z.string()),
  criticalities: z.array(z.string()),
  deviceRoles: z.array(z.string()),
  isActive: z.boolean(),
});

type RuleFormValues = z.infer<typeof ruleFormSchema>;

function ScopeCheckboxGroup({
  label,
  hint,
  options,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  options: { value: string; label: string }[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <div className="grid max-h-36 grid-cols-2 gap-2 overflow-y-auto rounded-md border bg-surface-subtle p-3">
        {options.map((option) => {
          const checked = value.includes(option.value);
          return (
            <label
              className="flex min-h-8 cursor-pointer items-center gap-2 text-sm"
              key={option.value}
            >
              <Checkbox
                aria-label={`${label}: ${option.label}`}
                checked={checked}
                onCheckedChange={(checkedState) =>
                  onChange(
                    checkedState === true
                      ? [...value, option.value]
                      : value.filter((entry) => entry !== option.value)
                  )
                }
              />
              <span className="truncate">{option.label}</span>
            </label>
          );
        })}
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function RuleFormDialog({
  open,
  onOpenChange,
  rule,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rule?: AlertRuleRow | null;
}) {
  const meta = useMeta();
  const createRule = useCreateAlertRule();
  const updateRule = useUpdateAlertRule();

  const editing = Boolean(rule);
  const defaultValues: RuleFormValues = useMemo(
    () => ({
      name: rule?.name ?? "",
      metric: rule?.metric ?? "CPU",
      operator: rule?.operator ?? "GT",
      threshold: String(rule?.threshold ?? 95),
      durationMinutes: String(rule?.durationMinutes ?? 5),
      severity: rule?.severity ?? "HIGH",
      siteCodes: rule?.scope.siteCodes ?? [],
      criticalities: rule?.scope.criticalities ?? [],
      deviceRoles: rule?.scope.deviceRoles ?? [],
      isActive: rule?.isActive ?? true,
    }),
    [rule]
  );

  const form = useForm<RuleFormValues>({
    defaultValues,
    resolver: zodResolver(ruleFormSchema),
    mode: "onSubmit",
  });

  const metric = useWatch({ control: form.control, name: "metric" });
  const siteCodes = useWatch({ control: form.control, name: "siteCodes" });
  const criticalities = useWatch({ control: form.control, name: "criticalities" });
  const deviceRoles = useWatch({ control: form.control, name: "deviceRoles" });
  const isActive = useWatch({ control: form.control, name: "isActive" });

  useEffect(() => {
    if (open) form.reset(defaultValues);
  }, [open, defaultValues, form]);

  const pending = createRule.isPending || updateRule.isPending;

  const onSubmit = (values: RuleFormValues) => {
    const scope: {
      siteCodes?: string[];
      criticalities?: string[];
      deviceRoles?: string[];
    } = {};
    if (values.siteCodes.length > 0) scope.siteCodes = values.siteCodes;
    if (values.criticalities.length > 0) scope.criticalities = values.criticalities;
    if (values.deviceRoles.length > 0) scope.deviceRoles = values.deviceRoles;
    const payload = {
      name: values.name,
      metric: values.metric,
      operator: values.operator,
      threshold: Number(values.threshold),
      durationMinutes: Number(values.durationMinutes),
      severity: values.severity,
      scope: Object.keys(scope).length > 0 ? scope : undefined,
      isActive: values.isActive,
    };
    if (editing && rule) {
      updateRule.mutate(
        { id: rule.id, data: payload },
        { onSuccess: () => onOpenChange(false) }
      );
      return;
    }
    createRule.mutate(payload, { onSuccess: () => onOpenChange(false) });
  };

  const metricLabel =
    METRIC_OPTIONS.find((option) => option.value === metric)?.label ?? metric;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit alert rule" : "New alert rule"}</DialogTitle>
          <DialogDescription>
            Active rules are evaluated every worker tick (~3 min). The
            condition uses the average of the metric samples inside the
            duration window; AVAILABILITY uses device reachability.
          </DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={form.handleSubmit(onSubmit)}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rule-name">Name *</Label>
            <Input
              {...form.register("name")}
              aria-invalid={Boolean(form.formState.errors.name)}
              id="rule-name"
              placeholder="CPU Critical"
            />
            {form.formState.errors.name && (
              <p className="text-xs text-danger">{form.formState.errors.name.message}</p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label>Condition *</Label>
              <div className="flex items-center gap-1">
                <Select
                  onValueChange={(value) => form.setValue("metric", value, { shouldValidate: true })}
                  value={metric}
                >
                  <SelectTrigger aria-label="Metric" className="min-w-0 flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {METRIC_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Operator *</Label>
              <Select
                onValueChange={(value) => form.setValue("operator", value, { shouldValidate: true })}
                defaultValue={form.getValues("operator")}
              >
                <SelectTrigger aria-label="Operator">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OPERATOR_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rule-threshold">Threshold *</Label>
              <Input
                {...form.register("threshold")}
                aria-invalid={Boolean(form.formState.errors.threshold)}
                id="rule-threshold"
                inputMode="decimal"
              />
              {form.formState.errors.threshold && (
                <p className="text-xs text-danger">{form.formState.errors.threshold.message}</p>
              )}
            </div>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">
            Fires when the average {metricLabel} breaches the threshold for the
            whole duration window.
          </p>

          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rule-duration">Duration (minutes) *</Label>
              <Input
                {...form.register("durationMinutes")}
                aria-invalid={Boolean(form.formState.errors.durationMinutes)}
                id="rule-duration"
                inputMode="numeric"
              />
              {form.formState.errors.durationMinutes && (
                <p className="text-xs text-danger">
                  {form.formState.errors.durationMinutes.message}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Severity *</Label>
              <Select
                onValueChange={(value) => form.setValue("severity", value, { shouldValidate: true })}
                defaultValue={form.getValues("severity")}
              >
                <SelectTrigger aria-label="Severity">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEVERITY_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <ScopeCheckboxGroup
            hint="Leave empty for every manageable device."
            label="Sites (scope)"
            onChange={(next) => form.setValue("siteCodes", next)}
            options={(meta.data?.sites ?? []).map((site) => ({
              value: site.code,
              label: `${site.name} (${site.code})`,
            }))}
            value={siteCodes ?? []}
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <ScopeCheckboxGroup
              hint="Empty = all criticalities."
              label="Criticalities"
              onChange={(next) => form.setValue("criticalities", next)}
              options={CRITICALITY_OPTIONS.map((value) => ({ value, label: value }))}
              value={criticalities ?? []}
            />
            <ScopeCheckboxGroup
              hint="Empty = all roles."
              label="Device roles"
              onChange={(next) => form.setValue("deviceRoles", next)}
              options={ROLE_OPTIONS.map((value) => ({ value, label: value.replace(/_/g, " ") }))}
              value={deviceRoles ?? []}
            />
          </div>

          <label className="flex items-center justify-between gap-3 rounded-md border bg-surface-subtle px-3 py-2.5">
            <span className="text-sm font-medium">Rule active</span>
            <Switch
              aria-label="Rule active"
              checked={isActive}
              onCheckedChange={(checked) => form.setValue("isActive", checked)}
            />
          </label>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={pending} type="submit">
              {editing ? "Save changes" : "Create rule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AlertRulesPanel() {
  const rules = useAlertRules();
  const updateRule = useUpdateAlertRule();
  const deleteRule = useDeleteAlertRule();
  const [formOpen, setFormOpen] = useState(false);
  const [editRule, setEditRule] = useState<AlertRuleRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AlertRuleRow | null>(null);

  const rows = rules.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {rows.length} rule{rows.length === 1 ? "" : "s"} — active rules are
          evaluated by the alert engine every worker tick.
        </p>
        <Button
          onClick={() => {
            setEditRule(null);
            setFormOpen(true);
          }}
          size="sm"
        >
          <Plus aria-hidden="true" />
          New rule
        </Button>
      </div>

      <SectionCard contentClassName="p-0" title="Alert Rules">
        {rules.isError ? (
          <div className="p-4">
            <ErrorState
              onRetry={() => void rules.refetch()}
              reason={rules.error.message}
              title="Rules could not be loaded"
            />
          </div>
        ) : rules.isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="h-11 animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              description="Create a threshold rule to start firing alerts."
              icon={Plus}
              title="No alert rules yet"
            />
          </div>
        ) : (
          <div className="max-h-[600px] overflow-x-auto overflow-y-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b text-start text-xs text-muted-foreground">
                  <th className="px-4 py-2.5 text-start font-medium">Rule</th>
                  <th className="px-4 py-2.5 text-start font-medium">Condition</th>
                  <th className="px-4 py-2.5 text-start font-medium">Duration</th>
                  <th className="px-4 py-2.5 text-start font-medium">Severity</th>
                  <th className="hidden px-4 py-2.5 text-start font-medium lg:table-cell">Scope</th>
                  <th className="px-4 py-2.5 text-end font-medium">Devices</th>
                  <th className="px-4 py-2.5 text-end font-medium">Open alerts</th>
                  <th className="px-4 py-2.5 text-center font-medium">Active</th>
                  <th className="px-4 py-2.5 text-end font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((rule) => (
                  <tr
                    className="h-(--density-row-h) border-b transition-colors last:border-0 hover:bg-accent/40"
                    key={rule.id}
                  >
                    <td className="max-w-44 truncate px-(--density-cell-x) py-2 font-medium" title={rule.name}>
                      {rule.name}
                    </td>
                    <td className="px-(--density-cell-x) py-2 font-tech text-xs ltr-technical">
                      {rule.metric} {rule.operator} {rule.threshold}
                    </td>
                    <td className="px-(--density-cell-x) py-2 tabular-nums">
                      {rule.durationMinutes} min
                    </td>
                    <td className="px-(--density-cell-x) py-2">
                      <SeverityBadge value={rule.severity} />
                    </td>
                    <td className="hidden max-w-52 px-(--density-cell-x) py-2 lg:table-cell">
                      {rule.scope.siteCodes?.length ||
                      rule.scope.criticalities?.length ||
                      rule.scope.deviceRoles?.length ? (
                        <span className="flex flex-wrap gap-1">
                          {rule.scope.siteCodes?.map((code) => (
                            <span
                              className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-tech"
                              key={code}
                            >
                              {code}
                            </span>
                          ))}
                          {rule.scope.criticalities?.map((value) => (
                            <span
                              className="rounded-full bg-muted px-2 py-0.5 text-[11px]"
                              key={value}
                            >
                              {value}
                            </span>
                          ))}
                          {rule.scope.deviceRoles?.map((value) => (
                            <span
                              className="rounded-full bg-muted px-2 py-0.5 text-[11px]"
                              key={value}
                            >
                              {value.replace(/_/g, " ")}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">All devices</span>
                      )}
                    </td>
                    <td className="px-(--density-cell-x) py-2 text-end tabular-nums">
                      {rule.scopedDeviceCount}
                    </td>
                    <td className="px-(--density-cell-x) py-2 text-end tabular-nums">
                      <span className={cn(rule.openAlerts > 0 && "font-semibold text-warning")}>
                        {rule.openAlerts}
                      </span>
                    </td>
                    <td className="px-(--density-cell-x) py-2">
                      <div className="flex justify-center">
                        <Switch
                          aria-label={`${rule.isActive ? "Pause" : "Enable"} rule ${rule.name}`}
                          checked={rule.isActive}
                          disabled={updateRule.isPending}
                          onCheckedChange={(checked) =>
                            updateRule.mutate({ id: rule.id, data: { isActive: checked } })
                          }
                        />
                      </div>
                    </td>
                    <td className="px-(--density-cell-x) py-2">
                      <div className="flex justify-end gap-1">
                        <Button
                          aria-label={`Edit rule ${rule.name}`}
                          onClick={() => {
                            setEditRule(rule);
                            setFormOpen(true);
                          }}
                          size="icon"
                          variant="ghost"
                        >
                          <Pencil aria-hidden="true" />
                        </Button>
                        <Button
                          aria-label={`Delete rule ${rule.name}`}
                          disabled={deleteRule.isPending}
                          onClick={() => setDeleteTarget(rule)}
                          size="icon"
                          variant="ghost"
                        >
                          <Trash2 aria-hidden="true" className="text-danger" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <RuleFormDialog
        onOpenChange={setFormOpen}
        open={formOpen}
        rule={editRule}
      />

      <AlertDialog
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        open={deleteTarget !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete rule “{deleteTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The rule stops evaluating immediately. Rules referenced by
              existing alerts cannot be deleted — pause them instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-danger text-white hover:bg-danger/90"
              onClick={() => {
                if (!deleteTarget) return;
                deleteRule.mutate(deleteTarget.id, {
                  onSettled: () => setDeleteTarget(null),
                });
              }}
            >
              Delete rule
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
