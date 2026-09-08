"use client";

import { useEffect, useMemo, useState } from "react";
import { useFieldArray, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { format } from "date-fns";
import {
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  Check,
  CircleAlert,
  ClipboardList,
  LoaderCircle,
  Plus,
  Rocket,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";

import {
  approvalLevelsFor,
  deviceAffectsFirewall,
  isBusinessHours,
  scoreChangeRisk,
  type RiskBreakdown,
} from "@/lib/change/risk";
import type { ChangeTemplate } from "@/lib/change/templates";
import type {
  AiChangeDraftPrefill,
  ChangeCreateResult,
  ChangeDetail,
  ChangeStepInput,
  WizardPayload,
} from "@/lib/api-client";
import type { DeviceRow } from "@/lib/api-client";
import { useDevices } from "@/hooks/api/use-devices";
import { useMeta } from "@/hooks/api/use-meta";
import {
  useCreateChange,
  useUpdateChange,
} from "@/hooks/api/use-change-mutations";
import { useChangeConflicts } from "@/hooks/api/use-change-conflicts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/domain/status-badge";
import { ChangeRiskBadge } from "@/components/domain/change-risk-badge";
import { cn } from "@/lib/utils";
import { useNavigationStore } from "@/stores/navigation";
import { getStatusConfig, SEVERITY } from "@/lib/domain/status";

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

const STEP_TYPES = ["CHECK", "BACKUP", "APPLY", "VALIDATE", "ROLLBACK"] as const;

const wizardSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(6, "Title must be at least 6 characters")
      .max(200, "Title is limited to 200 characters"),
    description: z.string().trim().max(4000).optional(),
    type: z.enum(["STANDARD", "NORMAL", "EMERGENCY"]),
    siteId: z.string().optional(),
    deviceIds: z
      .array(z.string())
      .min(1, "Select at least one device")
      .max(20, "At most 20 devices per change"),
    implementationPlan: z.string().trim().max(8000).optional(),
    steps: z
      .array(
        z.object({
          name: z
            .string()
            .trim()
            .min(1, "Step name is required")
            .max(160, "Step name is limited to 160 characters"),
          type: z.enum(STEP_TYPES),
        })
      )
      .min(1, "At least one step is required")
      .max(20, "At most 20 steps"),
    validationPlan: z.string().trim().max(8000).optional(),
    rollbackPlan: z.string().trim().max(8000).optional(),
    /** datetime-local strings ("" = unset). */
    scheduledStart: z.string().optional(),
    scheduledEnd: z.string().optional(),
    submitNow: z.boolean(),
  })
  .superRefine((values, ctx) => {
    // Cross-field rule 1: implementation prose is mandatory for anything
    // that is not a pre-approved STANDARD change.
    if (
      values.type !== "STANDARD" &&
      (!values.implementationPlan || values.implementationPlan.trim().length < 20)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["implementationPlan"],
        message:
          "Describe the implementation in at least 20 characters for non-standard changes",
      });
    }
    // Cross-field rule 2: window pairing.
    if (values.scheduledStart && values.scheduledEnd) {
      const start = new Date(values.scheduledStart);
      const end = new Date(values.scheduledEnd);
      if (
        !Number.isNaN(start.getTime()) &&
        !Number.isNaN(end.getTime()) &&
        end <= start
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["scheduledEnd"],
          message: "The end of the window must be after its start",
        });
      }
    }
  });

type WizardFormValues = z.infer<typeof wizardSchema>;

/** Default step plan — mirrors the server-side DEFAULT_CHANGE_STEPS. */
const WIZARD_DEFAULT_STEPS: ChangeStepInput[] = [
  { name: "Verify device reachable", type: "CHECK" },
  { name: "Pre-change backup", type: "BACKUP" },
  { name: "Apply configuration changes", type: "APPLY" },
  { name: "Post-change validation", type: "VALIDATE" },
  { name: "Post-change backup", type: "BACKUP" },
];

const STEPS: { key: string; label: string }[] = [
  { key: "general", label: "General" },
  { key: "scope", label: "Scope" },
  { key: "implementation", label: "Implementation" },
  { key: "validation", label: "Validation" },
  { key: "rollback", label: "Rollback" },
  { key: "schedule", label: "Schedule" },
  { key: "risk", label: "Risk" },
  { key: "review", label: "Review" },
];

/** Fields validated by each step's Next action. */
const STEP_FIELDS: string[][] = [
  ["title", "type"],
  ["deviceIds"],
  ["implementationPlan", "steps"],
  ["validationPlan"],
  ["rollbackPlan"],
  ["scheduledStart", "scheduledEnd"],
  [],
  [],
];

const TYPE_HINTS: Record<
  WizardFormValues["type"],
  { title: string; hint: string }
> = {
  STANDARD: {
    title: "Standard",
    hint: "Pre-approved, low risk (base score 5) — no implementation prose required",
  },
  NORMAL: {
    title: "Normal",
    hint: "Planned change with full review (base score 15)",
  },
  EMERGENCY: {
    title: "Emergency",
    hint: "Urgent fix under elevated scrutiny (base score 30)",
  },
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

interface WizardDevice {
  id: string;
  hostname: string;
  model: string | null;
  role: string | null;
  criticality: string;
  siteCode: string | null;
  vendorKey: string | null;
}

function deviceFromRow(row: DeviceRow): WizardDevice {
  return {
    id: row.id,
    hostname: row.hostname,
    model: row.model,
    role: row.role,
    criticality: row.criticality,
    siteCode: row.site?.code ?? null,
    vendorKey: row.vendor?.key ?? null,
  };
}

function deviceFromDetail(d: ChangeDetail["devices"][number]): WizardDevice {
  return {
    id: d.deviceId,
    hostname: d.hostname,
    model: d.model,
    role: d.role,
    criticality: d.criticality,
    siteCode: d.siteCode,
    vendorKey: d.vendorKey,
  };
}

function toDateTimeLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Tiny debounce for the conflict check (keeps keystrokes off the API). */
function useDebounced(value: string, delay = 500): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function parseLocalInput(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/* ------------------------------------------------------------------ */
/* Wizard                                                              */
/* ------------------------------------------------------------------ */

interface ChangeWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prefill from a template (templates view "Use template"). */
  template?: ChangeTemplate | null;
  /** Edit an existing DRAFT change (detail view "Edit"). */
  change?: ChangeDetail | null;
  /**
   * Prefill from the "Draft with AI" dialog (Phase 13-a) — a user-reviewed
   * LLM draft. Purely fills the form; the wizard still starts at step 1 and
   * nothing is created until the user completes the wizard.
   */
  aiDraft?: AiChangeDraftPrefill | null;
}

export function ChangeWizard({
  open,
  onOpenChange,
  template = null,
  change = null,
  aiDraft = null,
}: ChangeWizardProps) {
  const setActiveView = useNavigationStore((state) => state.setActiveView);
  const meta = useMeta();
  const createChange = useCreateChange();
  const updateChange = useUpdateChange();

  const editing = Boolean(change);
  const [step, setStep] = useState(0);
  const [created, setCreated] = useState<ChangeCreateResult["change"] | null>(null);

  const defaultValues = useMemo<WizardFormValues>(() => {
    if (change) {
      return {
        title: change.title,
        description: change.description ?? "",
        type: (change.type as WizardFormValues["type"]) ?? "NORMAL",
        siteId: change.site?.id ?? "",
        deviceIds: change.devices.map((d) => d.deviceId),
        implementationPlan: change.implementationPlan ?? "",
        steps:
          change.steps.length > 0
            ? change.steps.map((s) => ({
                name: s.name,
                type: s.type as ChangeStepInput["type"],
              }))
            : WIZARD_DEFAULT_STEPS,
        validationPlan: change.validationPlan ?? "",
        rollbackPlan: change.rollbackPlan ?? "",
        scheduledStart: toDateTimeLocal(change.scheduledStart),
        scheduledEnd: toDateTimeLocal(change.scheduledEnd),
        submitNow: false,
      };
    }
    if (template) {
      return {
        title: template.defaultTitle,
        description: template.description,
        type: template.defaultType,
        siteId: "",
        deviceIds: [],
        implementationPlan: template.implementationPlan,
        steps: template.defaultSteps,
        validationPlan: template.validationPlan,
        rollbackPlan: template.rollbackPlan,
        scheduledStart: "",
        scheduledEnd: "",
        submitNow: true,
      };
    }
    if (aiDraft) {
      // AI draft prefill (Phase 13-a): plan arrays map onto the wizard's
      // free-text plan fields; the typed execution steps keep their default
      // sequence. The suggested window stays free-text (review panel only) —
      // it is not parsed into the schedule fields. Risk is recomputed live
      // by the risk engine (the AI riskHint is advisory only).
      const draft = aiDraft.draft;
      return {
        title: draft.title.slice(0, 200),
        description: draft.description,
        type: draft.changeType,
        siteId: "",
        deviceIds: aiDraft.matchedDevices.map((d) => d.id).slice(0, 20),
        implementationPlan:
          draft.implementationPlan.length > 0
            ? draft.implementationPlan
                .map((line, index) => `${index + 1}. ${line}`)
                .join("\n")
            : "",
        steps: WIZARD_DEFAULT_STEPS,
        validationPlan: draft.validationPlan.join("\n"),
        rollbackPlan: draft.rollbackPlan.join("\n"),
        scheduledStart: "",
        scheduledEnd: "",
        submitNow: true,
      };
    }
    return {
      title: "",
      description: "",
      type: "NORMAL",
      siteId: "",
      deviceIds: [],
      implementationPlan: "",
      steps: WIZARD_DEFAULT_STEPS,
      validationPlan: "",
      rollbackPlan: "",
      scheduledStart: "",
      scheduledEnd: "",
      submitNow: true,
    };
  }, [change, template, aiDraft]);

  const form = useForm<WizardFormValues>({
    defaultValues,
    resolver: zodResolver(wizardSchema),
    mode: "onSubmit",
  });
  const { fields, append, remove, move } = useFieldArray({
    control: form.control,
    name: "steps",
  });

  // Fresh state on every open (render-time adjustment — no effect resets).
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) {
      setStep(0);
      setCreated(null);
    }
  }

  // Reset the form whenever the dialog opens (or the target changes).
  useEffect(() => {
    if (open) {
      form.reset(defaultValues);
    }
  }, [open, defaultValues, form]);

  // Watched values (useWatch — compiler-safe) drive the live risk preview.
  const watchedType = useWatch({ control: form.control, name: "type" });
  const watchedDeviceIds = useWatch({ control: form.control, name: "deviceIds" });
  const watchedImplementation = useWatch({
    control: form.control,
    name: "implementationPlan",
  });
  const watchedValidation = useWatch({ control: form.control, name: "validationPlan" });
  const watchedRollback = useWatch({ control: form.control, name: "rollbackPlan" });
  const watchedStart = useWatch({ control: form.control, name: "scheduledStart" });
  const watchedEnd = useWatch({ control: form.control, name: "scheduledEnd" });
  const watchedSubmitNow = useWatch({ control: form.control, name: "submitNow" });
  const watchedSiteId = useWatch({ control: form.control, name: "siteId" });

  /* ------------------------- device picker ------------------------- */

  // Device attributes for the selected ids (needed for the risk engine).
  const [pickedDevices, setPickedDevices] = useState<Record<string, WizardDevice>>({});

  const editKey = change?.id ?? null;
  const [prevEditKey, setPrevEditKey] = useState<string | null>(null);
  if (prevEditKey !== editKey) {
    setPrevEditKey(editKey);
    setPickedDevices(
      editKey && change
        ? Object.fromEntries(
            change.devices.map((d) => [d.deviceId, deviceFromDetail(d)])
          )
        : {}
    );
  }

  // AI draft prefill: seed the picked-device map so the risk engine and the
  // selected chips see the matched devices (server-validated ids only).
  const aiKey = aiDraft?.draft.title ?? null;
  const [prevAiKey, setPrevAiKey] = useState<string | null>(null);
  if (prevAiKey !== aiKey) {
    setPrevAiKey(aiKey);
    setPickedDevices(
      aiDraft
        ? Object.fromEntries(
            aiDraft.matchedDevices.slice(0, 20).map((d) => [
              d.id,
              {
                id: d.id,
                hostname: d.hostname,
                model: d.model,
                role: d.role,
                criticality: d.criticality,
                siteCode: d.siteCode,
                vendorKey: d.vendorKey,
              } satisfies WizardDevice,
            ])
          )
        : {}
    );
  }

  const [deviceSearchInput, setDeviceSearchInput] = useState("");
  const [deviceQuery, setDeviceQuery] = useState("");
  const [deviceStatus, setDeviceStatus] = useState("ALL");
  const [deviceVendor, setDeviceVendor] = useState("ALL");
  const [devicePage, setDevicePage] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDeviceQuery(deviceSearchInput.trim());
      setDevicePage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [deviceSearchInput]);

  const deviceList = useDevices({
    q: deviceQuery || undefined,
    status: deviceStatus !== "ALL" ? deviceStatus : undefined,
    vendorId: deviceVendor !== "ALL" ? deviceVendor : undefined,
    page: devicePage,
    pageSize: 8,
  });
  const deviceRows = deviceList.data?.data ?? [];
  const deviceMeta = deviceList.data?.meta;

  const toggleDevice = (row: DeviceRow, checked: boolean) => {
    const current = form.getValues("deviceIds");
    let next: string[];
    if (checked) {
      if (current.includes(row.id) || current.length >= 20) return;
      next = [...current, row.id];
      setPickedDevices((prev) => ({ ...prev, [row.id]: deviceFromRow(row) }));
    } else {
      next = current.filter((id) => id !== row.id);
    }
    form.setValue("deviceIds", next, { shouldValidate: true, shouldDirty: true });
  };

  const removeDevice = (id: string) => {
    const current = form.getValues("deviceIds");
    form.setValue(
      "deviceIds",
      current.filter((entry) => entry !== id),
      { shouldValidate: true, shouldDirty: true }
    );
  };

  /* --------------------------- risk preview ------------------------- */

  const risk: RiskBreakdown = useMemo(() => {
    const ids = watchedDeviceIds ?? [];
    const devices = ids
      .map((id) => pickedDevices[id])
      .filter((d): d is WizardDevice => Boolean(d));
    return scoreChangeRisk({
      deviceCriticalities: devices.map((d) => d.criticality),
      deviceCount: ids.length,
      type: watchedType ?? "NORMAL",
      siteCount: new Set(devices.map((d) => d.siteCode ?? "_unassigned")).size,
      hasRollbackPlan: (watchedRollback ?? "").trim().length > 0,
      hasValidationPlan: (watchedValidation ?? "").trim().length > 0,
      scheduledBusinessHours: parseLocalInput(watchedStart)
        ? isBusinessHours(parseLocalInput(watchedStart) as Date)
        : false,
      affectsFirewall: devices.some((d) => deviceAffectsFirewall(d)),
    });
  }, [
    watchedDeviceIds,
    pickedDevices,
    watchedType,
    watchedRollback,
    watchedValidation,
    watchedStart,
  ]);

  /* ------------------------- schedule conflicts --------------------- */

  const startIso = useMemo(() => {
    const date = parseLocalInput(watchedStart);
    return date ? date.toISOString() : "";
  }, [watchedStart]);
  const endIso = useMemo(() => {
    const date = parseLocalInput(watchedEnd);
    return date ? date.toISOString() : "";
  }, [watchedEnd]);
  const debouncedStart = useDebounced(startIso);
  const debouncedEnd = useDebounced(endIso);

  const conflicts = useChangeConflicts({
    start: debouncedStart || undefined,
    end: debouncedEnd || undefined,
    excludeId: change?.id,
  });
  const conflictRows = debouncedStart && debouncedEnd ? conflicts.data ?? [] : [];

  // Blocking policy (documented choice): HIGH/CRITICAL changes may not be
  // scheduled over another change at the SAME site — hard stop. MEDIUM/LOW
  // conflicts are advisory only. No site selected ⇒ never blocking (site
  // overlap cannot be established).
  const selectedSiteCode = meta.data?.sites.find(
    (site) => site.id === watchedSiteId
  )?.code;
  const highRisk = risk.level === "HIGH" || risk.level === "CRITICAL";
  const blockingConflicts =
    highRisk && selectedSiteCode
      ? conflictRows.filter((c) => c.siteCode === selectedSiteCode)
      : [];

  /* ------------------------------ submit ---------------------------- */

  const pending = createChange.isPending || updateChange.isPending;

  const buildPayload = (): WizardPayload => {
    const values = form.getValues();
    return {
      title: values.title.trim(),
      description: values.description?.trim() || undefined,
      type: values.type,
      siteId: values.siteId || undefined,
      scheduledStart: parseLocalInput(values.scheduledStart)?.toISOString(),
      scheduledEnd: parseLocalInput(values.scheduledEnd)?.toISOString(),
      implementationPlan: values.implementationPlan?.trim() || undefined,
      validationPlan: values.validationPlan?.trim() || undefined,
      rollbackPlan: values.rollbackPlan?.trim() || undefined,
      deviceIds: values.deviceIds,
      steps: values.steps.map((s) => ({ name: s.name.trim(), type: s.type })),
      submit: editing ? undefined : values.submitNow,
    };
  };

  const submitFinal = () => {
    if (editing && change) {
      const payload = buildPayload();
      const { submit: _submit, ...fields } = payload;
      updateChange.mutate(
        { id: change.id, data: { ...fields, action: watchedSubmitNow ? "SUBMIT" : undefined } },
        { onSuccess: () => onOpenChange(false) }
      );
      return;
    }
    createChange.mutate(buildPayload(), {
      onSuccess: (result) => setCreated(result.change),
    });
  };

  const onFormSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    // Enter-key submits only validate on the review step; earlier steps
    // advance through the per-step Next action.
    if (step === STEPS.length - 1) {
      void form.handleSubmit(submitFinal)();
    }
  };

  const goNext = async () => {
    const fields = STEP_FIELDS[step];
    if (fields.length > 0) {
      const valid = await form.trigger(
        fields as Parameters<typeof form.trigger>[0]
      );
      if (!valid) return;
    }
    // Hard stop: HIGH/CRITICAL over an overlapping same-site window.
    if (step === 5 && blockingConflicts.length > 0) return;
    setStep((current) => Math.min(current + 1, STEPS.length - 1));
  };

  const sites = meta.data?.sites ?? [];
  const vendors = meta.data?.vendors ?? [];
  const requiredApprovals = approvalLevelsFor(risk.level);

  const selectedIds = watchedDeviceIds ?? [];
  const deviceIdsError = form.formState.errors.deviceIds?.message;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="flex max-h-[92vh] w-full flex-col gap-0 overflow-hidden sm:max-w-3xl">
        {created ? (
          /* ------------------------- success ------------------------- */
          <>
            <DialogHeader className="border-b pb-4">
              <DialogTitle className="flex items-center gap-2">
                <span className="flex size-8 items-center justify-center rounded-md bg-success-subtle text-success">
                  <Check aria-hidden="true" className="size-4" />
                </span>
                Change created
              </DialogTitle>
              <DialogDescription>
                The change request was registered with a computed risk score.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col items-start gap-4 p-6">
              <div className="rounded-xl border bg-surface-subtle/60 p-4 text-sm">
                <p className="text-xs text-muted-foreground">Change number</p>
                <p className="font-tech ltr-technical text-lg font-semibold">
                  {created.number}
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <ChangeRiskBadge value={created.riskLevel} />
                  <span className="text-xs text-muted-foreground">
                    Risk score {created.riskScore} · {created.status.replace(/_/g, " ")}
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => {
                    setActiveView("changes.change-detail", { changeId: created.id });
                    onOpenChange(false);
                  }}
                >
                  Open change detail
                  <ArrowRight aria-hidden="true" />
                </Button>
                <Button onClick={() => onOpenChange(false)} variant="outline">
                  Done
                </Button>
              </div>
            </div>
          </>
        ) : (
          /* -------------------------- wizard -------------------------- */
          <>
            <DialogHeader className="border-b pb-4">
              <DialogTitle>
                {editing ? `Edit change ${change?.number}` : "New change request"}
              </DialogTitle>
              <DialogDescription>
                {editing
                  ? "Drafts can be edited freely — the risk score is recomputed on save."
                  : "Eight steps: the risk engine computes the score live as you fill in the plan."}
              </DialogDescription>
              {/* Step indicator */}
              <ol className="flex flex-wrap items-center gap-1.5 pt-2" aria-label="Wizard steps">
                {STEPS.map((entry, index) => {
                  const isCurrent = index === step;
                  const isDone = index < step;
                  return (
                    <li key={entry.key}>
                      <button
                        aria-current={isCurrent ? "step" : undefined}
                        className={cn(
                          "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                          isCurrent
                            ? "border-primary/30 bg-primary/10 font-medium text-primary"
                            : isDone
                              ? "border-success/25 bg-success-subtle text-success"
                              : "bg-card text-muted-foreground"
                        )}
                        disabled={index >= step}
                        onClick={() => setStep(index)}
                        type="button"
                      >
                        <span className="tabular-nums">
                          {isDone ? <Check aria-hidden="true" className="size-3" /> : index + 1}
                        </span>
                        <span className={cn(index === step ? "" : "hidden lg:inline")}>
                          {entry.label}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </DialogHeader>

            <form className="flex min-h-0 flex-1 flex-col" onSubmit={onFormSubmit}>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="flex flex-col gap-4 p-4">
                  {/* ------------------- 1. General ------------------- */}
                  {step === 0 && (
                    <>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="wizard-title">Title *</Label>
                        <Input
                          {...form.register("title")}
                          aria-invalid={Boolean(form.formState.errors.title)}
                          id="wizard-title"
                          placeholder="e.g. Upgrade HQ-Access-SW-02 firmware to AOS-CX 10.13"
                        />
                        {form.formState.errors.title && (
                          <p className="text-xs text-danger">
                            {form.formState.errors.title.message}
                          </p>
                        )}
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="wizard-description">Description</Label>
                        <Textarea
                          {...form.register("description")}
                          id="wizard-description"
                          placeholder="Why is this change needed? Business context, ticket references…"
                          rows={3}
                        />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label>Change type *</Label>
                        <div className="grid gap-2 sm:grid-cols-3">
                          {(Object.keys(TYPE_HINTS) as WizardFormValues["type"][]).map(
                            (typeKey) => (
                              <button
                                aria-pressed={watchedType === typeKey}
                                className={cn(
                                  "rounded-lg border p-3 text-start transition-colors",
                                  watchedType === typeKey
                                    ? "border-primary/40 bg-primary/5 ring-1 ring-primary/30"
                                    : "bg-card hover:bg-accent"
                                )}
                                key={typeKey}
                                onClick={() =>
                                  form.setValue("type", typeKey, {
                                    shouldValidate: true,
                                    shouldDirty: true,
                                  })
                                }
                                type="button"
                              >
                                <span className="block text-sm font-medium">
                                  {TYPE_HINTS[typeKey].title}
                                </span>
                                <span className="mt-1 block text-xs text-muted-foreground">
                                  {TYPE_HINTS[typeKey].hint}
                                </span>
                              </button>
                            )
                          )}
                        </div>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label>Site</Label>
                        <Select
                          onValueChange={(value) =>
                            form.setValue("siteId", value === "NONE" ? "" : value, {
                              shouldDirty: true,
                            })
                          }
                          value={watchedSiteId || "NONE"}
                        >
                          <SelectTrigger aria-label="Site">
                            <SelectValue placeholder="Change site (optional)" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="NONE">— none —</SelectItem>
                            {sites.map((site) => (
                              <SelectItem key={site.id} value={site.id}>
                                {site.name} ({site.code})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                          The primary site of the change — used for conflict checks and the calendar.
                        </p>
                      </div>
                    </>
                  )}

                  {/* -------------------- 2. Scope -------------------- */}
                  {step === 1 && (
                    <>
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="relative min-w-[180px] flex-1">
                          <Search
                            aria-hidden="true"
                            className="absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                          />
                          <Input
                            className="ps-8"
                            onChange={(event) => setDeviceSearchInput(event.target.value)}
                            placeholder="Search hostname or IP…"
                            value={deviceSearchInput}
                          />
                        </div>
                        <Select
                          onValueChange={(value) => {
                            setDeviceStatus(value);
                            setDevicePage(1);
                          }}
                          value={deviceStatus}
                        >
                          <SelectTrigger aria-label="Device status" className="w-[130px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="ALL">Any status</SelectItem>
                            {["ONLINE", "DEGRADED", "MAINTENANCE", "OFFLINE", "UNKNOWN"].map(
                              (statusKey) => (
                                <SelectItem key={statusKey} value={statusKey}>
                                  {statusKey}
                                </SelectItem>
                              )
                            )}
                          </SelectContent>
                        </Select>
                        <Select
                          onValueChange={(value) => {
                            setDeviceVendor(value);
                            setDevicePage(1);
                          }}
                          value={deviceVendor}
                        >
                          <SelectTrigger aria-label="Vendor" className="w-[130px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="ALL">Any vendor</SelectItem>
                            {vendors.map((vendor) => (
                              <SelectItem key={vendor.id} value={vendor.id}>
                                {vendor.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {/* Selected chips */}
                      <div className="flex flex-wrap items-center gap-1.5">
                        {selectedIds.length === 0 ? (
                          <span className="text-xs text-muted-foreground">
                            No devices selected yet — pick 1–20 targets below.
                          </span>
                        ) : (
                          selectedIds.map((id) => {
                            const device = pickedDevices[id];
                            return (
                              <Badge
                                className="gap-1 pe-1.5"
                                key={id}
                                variant="outline"
                              >
                                <span className="font-tech ltr-technical">
                                  {device?.hostname ?? id}
                                </span>
                                <button
                                  aria-label={`Remove ${device?.hostname ?? id}`}
                                  className="rounded-sm p-0.5 hover:bg-accent"
                                  onClick={() => removeDevice(id)}
                                  type="button"
                                >
                                  <X aria-hidden="true" className="size-3" />
                                </button>
                              </Badge>
                            );
                          })
                        )}
                        <span
                          className={cn(
                            "ms-auto text-xs tabular-nums",
                            selectedIds.length >= 20 ? "text-warning" : "text-muted-foreground"
                          )}
                        >
                          {selectedIds.length}/20 selected
                        </span>
                      </div>
                      {deviceIdsError && (
                        <p className="text-xs text-danger" role="alert">
                          {deviceIdsError}
                        </p>
                      )}

                      <div className="max-h-72 overflow-y-auto rounded-lg border">
                        {deviceList.isLoading ? (
                          <div className="flex flex-col gap-2 p-3">
                            {Array.from({ length: 4 }).map((_, index) => (
                              <div
                                className="h-9 animate-pulse rounded-md bg-muted/60"
                                key={index}
                              />
                            ))}
                          </div>
                        ) : deviceRows.length === 0 ? (
                          <p className="p-4 text-center text-sm text-muted-foreground">
                            No devices match the filters.
                          </p>
                        ) : (
                          <ul className="divide-y">
                            {deviceRows.map((row) => {
                              const checked = selectedIds.includes(row.id);
                              const disabled = !checked && selectedIds.length >= 20;
                              return (
                                <li
                                  className="flex items-center gap-3 px-3 py-2 hover:bg-surface-subtle/60"
                                  key={row.id}
                                >
                                  <Checkbox
                                    aria-label={`Select ${row.hostname}`}
                                    checked={checked}
                                    disabled={disabled}
                                    onCheckedChange={(value) =>
                                      toggleDevice(row, value === true)
                                    }
                                  />
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate font-tech text-sm ltr-technical">
                                      {row.hostname}
                                    </p>
                                    <p className="truncate text-xs text-muted-foreground">
                                      {row.site?.code ?? "no site"} · {row.model ?? "unknown model"}
                                    </p>
                                  </div>
                                  <StatusBadge
                                    config={getStatusConfig(SEVERITY, row.criticality)}
                                  />
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                      {deviceMeta && deviceMeta.totalPages > 1 && (
                        <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
                          <Button
                            disabled={devicePage <= 1}
                            onClick={() => setDevicePage((p) => p - 1)}
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            <ArrowLeft aria-hidden="true" />
                            Prev
                          </Button>
                          <span className="tabular-nums">
                            {deviceMeta.page}/{deviceMeta.totalPages}
                          </span>
                          <Button
                            disabled={devicePage >= deviceMeta.totalPages}
                            onClick={() => setDevicePage((p) => p + 1)}
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            Next
                            <ArrowRight aria-hidden="true" />
                          </Button>
                        </div>
                      )}
                    </>
                  )}

                  {/* ---------------- 3. Implementation ---------------- */}
                  {step === 2 && (
                    <>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="wizard-implementation">Implementation plan *</Label>
                        <Textarea
                          {...form.register("implementationPlan")}
                          aria-invalid={Boolean(form.formState.errors.implementationPlan)}
                          id="wizard-implementation"
                          placeholder="Numbered steps describing exactly what will be configured…"
                          rows={5}
                        />
                        {form.formState.errors.implementationPlan && (
                          <p className="text-xs text-danger">
                            {form.formState.errors.implementationPlan.message}
                          </p>
                        )}
                        {watchedType !== "STANDARD" && (
                          <p className="text-xs text-muted-foreground">
                            Required for {watchedType} changes — at least 20 characters.
                          </p>
                        )}
                      </div>

                      <div className="flex flex-col gap-2">
                        <div className="flex items-center justify-between">
                          <Label>Execution steps</Label>
                          <Button
                            disabled={fields.length >= 20}
                            onClick={() => append({ name: "", type: "CHECK" })}
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            <Plus aria-hidden="true" />
                            Add step
                          </Button>
                        </div>
                        <ol className="flex flex-col gap-2">
                          {fields.map((field, index) => {
                            const stepError = form.formState.errors.steps?.[index];
                            return (
                              <li
                                className="flex flex-wrap items-center gap-2 rounded-lg border p-2"
                                key={field.id}
                              >
                                <span
                                  className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-medium tabular-nums"
                                  title={`Order ${index + 1}`}
                                >
                                  {index + 1}
                                </span>
                                <div className="min-w-[160px] flex-1">
                                  <Input
                                    {...form.register(`steps.${index}.name` as const)}
                                    aria-invalid={Boolean(stepError?.name)}
                                    placeholder={`Step ${index + 1} name`}
                                  />
                                  {stepError?.name && (
                                    <p className="mt-1 text-xs text-danger">
                                      {stepError.name.message}
                                    </p>
                                  )}
                                </div>
                                <Select
                                  onValueChange={(value) =>
                                    form.setValue(
                                      `steps.${index}.type`,
                                      value as ChangeStepInput["type"],
                                      { shouldDirty: true }
                                    )
                                  }
                                  value={form.getValues(`steps.${index}.type`)}
                                >
                                  <SelectTrigger aria-label="Step type" className="w-[120px]">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {STEP_TYPES.map((typeKey) => (
                                      <SelectItem key={typeKey} value={typeKey}>
                                        {typeKey}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <div className="flex items-center gap-1">
                                  <Button
                                    aria-label="Move step up"
                                    disabled={index === 0}
                                    onClick={() => move(index, index - 1)}
                                    size="icon"
                                    type="button"
                                    variant="ghost"
                                  >
                                    <ArrowLeft aria-hidden="true" className="size-4" />
                                  </Button>
                                  <Button
                                    aria-label="Move step down"
                                    disabled={index === fields.length - 1}
                                    onClick={() => move(index, index + 1)}
                                    size="icon"
                                    type="button"
                                    variant="ghost"
                                  >
                                    <ArrowRight aria-hidden="true" className="size-4" />
                                  </Button>
                                  <Button
                                    aria-label="Remove step"
                                    disabled={fields.length <= 1}
                                    onClick={() => remove(index)}
                                    size="icon"
                                    type="button"
                                    variant="ghost"
                                  >
                                    <Trash2 aria-hidden="true" className="size-4 text-danger" />
                                  </Button>
                                </div>
                              </li>
                            );
                          })}
                        </ol>
                        {form.formState.errors.steps?.message && (
                          <p className="text-xs text-danger" role="alert">
                            {form.formState.errors.steps.message}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground">
                          Types: CHECK (pre-check) · BACKUP · APPLY · VALIDATE · ROLLBACK.
                          Reorder with the arrows — the executor runs steps top-down.
                        </p>
                      </div>
                    </>
                  )}

                  {/* ----------------- 4. Validation ------------------ */}
                  {step === 3 && (
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="wizard-validation">Validation plan</Label>
                      <Textarea
                        {...form.register("validationPlan")}
                        id="wizard-validation"
                        placeholder="How will success be proven? Commands, probes, acceptance thresholds…"
                        rows={7}
                      />
                      <p className="text-xs text-muted-foreground">
                        A missing validation plan adds +8 to the risk score.
                      </p>
                    </div>
                  )}

                  {/* ------------------ 5. Rollback ------------------- */}
                  {step === 4 && (
                    <>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="wizard-rollback">Rollback plan</Label>
                        <Textarea
                          {...form.register("rollbackPlan")}
                          id="wizard-rollback"
                          placeholder="Exact actions to restore service if validation fails…"
                          rows={7}
                        />
                        <p className="flex items-start gap-1.5 text-xs text-warning">
                          <ShieldAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                          Required for HIGH/CRITICAL — the risk engine penalizes a missing
                          rollback plan with +15 points.
                        </p>
                      </div>
                      {/* Live risk preview chip (auto-refetch — pure recomputation) */}
                      <div className="flex items-center gap-2 rounded-lg border bg-surface-subtle/60 p-3">
                        <ChangeRiskBadge value={risk.level} />
                        <span className="text-sm text-muted-foreground">
                          Current preview score{" "}
                          <span className="font-medium tabular-nums text-foreground">
                            {risk.score}
                          </span>
                        </span>
                      </div>
                    </>
                  )}

                  {/* ------------------ 6. Schedule ------------------- */}
                  {step === 5 && (
                    <>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="wizard-start">Window start</Label>
                          <Input
                            {...form.register("scheduledStart")}
                            id="wizard-start"
                            type="datetime-local"
                          />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="wizard-end">Window end</Label>
                          <Input
                            {...form.register("scheduledEnd")}
                            aria-invalid={Boolean(form.formState.errors.scheduledEnd)}
                            id="wizard-end"
                            type="datetime-local"
                          />
                          {form.formState.errors.scheduledEnd && (
                            <p className="text-xs text-danger">
                              {form.formState.errors.scheduledEnd.message}
                            </p>
                          )}
                        </div>
                      </div>
                      {parseLocalInput(watchedStart) && (
                        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <CalendarClock aria-hidden="true" className="size-3.5" />
                          {isBusinessHours(parseLocalInput(watchedStart) as Date)
                            ? "Inside business hours (Sun–Thu 08:00–17:00) — +12 risk points."
                            : "Outside business hours — no scheduling penalty."}
                        </p>
                      )}

                      {/* Conflict panel (debounced check) */}
                      {debouncedStart && debouncedEnd && (
                        <div
                          className={cn(
                            "rounded-lg border p-3",
                            blockingConflicts.length > 0
                              ? "border-danger/30 bg-danger-subtle"
                              : conflictRows.length > 0
                                ? "border-warning/30 bg-warning-subtle"
                                : "border-success/25 bg-success-subtle"
                          )}
                          role="status"
                        >
                          {conflicts.isFetching ? (
                            <p className="flex items-center gap-2 text-sm text-muted-foreground">
                              <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                              Checking overlapping changes…
                            </p>
                          ) : conflictRows.length === 0 ? (
                            <p className="flex items-center gap-2 text-sm">
                              <ShieldCheck aria-hidden="true" className="size-4 text-success" />
                              No overlapping changes in this window.
                            </p>
                          ) : (
                            <div className="flex flex-col gap-2">
                              <p
                                className={cn(
                                  "flex items-center gap-2 text-sm font-medium",
                                  blockingConflicts.length > 0
                                    ? "text-danger"
                                    : "text-warning"
                                )}
                              >
                                <CircleAlert aria-hidden="true" className="size-4" />
                                {conflictRows.length} overlapping change
                                {conflictRows.length === 1 ? "" : "s"} in this window
                                {blockingConflicts.length > 0
                                  ? " — same-site overlap blocks HIGH/CRITICAL changes"
                                  : " — advisory for MEDIUM/LOW risk"}
                              </p>
                              <ul className="flex flex-col gap-1">
                                {conflictRows.slice(0, 5).map((conflict) => (
                                  <li
                                    className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs"
                                    key={conflict.id}
                                  >
                                    <span className="font-tech ltr-technical">
                                      {conflict.number}
                                    </span>
                                    <span className="truncate">{conflict.title}</span>
                                    <span className="tabular-nums text-muted-foreground">
                                      {format(new Date(conflict.scheduledStart), "MMM d HH:mm")}
                                      {" → "}
                                      {format(new Date(conflict.scheduledEnd), "MMM d HH:mm")}
                                    </span>
                                    <span className="text-muted-foreground">
                                      {conflict.siteCode ?? "no site"}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}

                  {/* -------------------- 7. Risk --------------------- */}
                  {step === 6 && (
                    <>
                      <div className="flex items-center justify-between rounded-lg border bg-surface-subtle/60 p-4">
                        <div>
                          <p className="text-xs text-muted-foreground">Computed risk</p>
                          <p className="text-2xl font-semibold tabular-nums">{risk.score}/100</p>
                        </div>
                        <ChangeRiskBadge value={risk.level} />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Read-only — the risk engine is authoritative and recomputes the same
                        score server-side on submit.
                      </p>
                      <div className="overflow-hidden rounded-lg border">
                        <table className="w-full text-sm">
                          <tbody className="divide-y">
                            {risk.factors.map((factor) => (
                              <tr className="odd:bg-surface-subtle/60" key={factor.key}>
                                <td className="px-3 py-2 font-medium">{factor.label}</td>
                                <td className="px-3 py-2 text-muted-foreground">{factor.detail}</td>
                                <td className="px-3 py-2 text-end font-medium tabular-nums">
                                  +{factor.points}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}

                  {/* -------------------- 8. Review ------------------- */}
                  {step === 7 && (
                    <>
                      <dl className="overflow-hidden rounded-lg border text-sm">
                        {[
                          {
                            label: "Title",
                            value: form.getValues("title") || "—",
                          },
                          {
                            label: "Type",
                            value: TYPE_HINTS[watchedType ?? "NORMAL"].title,
                          },
                          {
                            label: "Site",
                            value:
                              sites.find((site) => site.id === watchedSiteId)?.name ?? "—",
                          },
                          {
                            label: "Devices",
                            value: `${selectedIds.length} selected`,
                          },
                          {
                            label: "Steps",
                            value: `${fields.length} step${fields.length === 1 ? "" : "s"}`,
                          },
                          {
                            label: "Window",
                            value:
                              watchedStart && watchedEnd
                                ? `${format(
                                    parseLocalInput(watchedStart) as Date,
                                    "EEE, MMM d HH:mm"
                                  )} → ${format(
                                    parseLocalInput(watchedEnd) as Date,
                                    "MMM d HH:mm"
                                  )}`
                                : "Unscheduled",
                          },
                          {
                            label: "Plans",
                            value: [
                              (watchedImplementation ?? "").trim() ? "implementation" : null,
                              (watchedValidation ?? "").trim() ? "validation" : null,
                              (watchedRollback ?? "").trim() ? "rollback" : null,
                            ]
                              .filter(Boolean)
                              .join(" · ") || "none documented",
                          },
                        ].map((row) => (
                          <div
                            className="flex items-start justify-between gap-3 px-3 py-2 odd:bg-surface-subtle/60"
                            key={row.label}
                          >
                            <dt className="shrink-0 text-xs font-medium text-muted-foreground">
                              {row.label}
                            </dt>
                            <dd className="min-w-0 truncate text-end">{row.value}</dd>
                          </div>
                        ))}
                      </dl>

                      <div className="flex items-center justify-between rounded-lg border p-3">
                        <div className="flex items-center gap-2">
                          <ClipboardList aria-hidden="true" className="size-4 text-muted-foreground" />
                          <div>
                            <p className="text-sm font-medium">Approvals required by policy</p>
                            <p className="text-xs text-muted-foreground">
                              Risk {risk.score} ({risk.level}) — one PENDING approval per level
                              is created on submit.
                            </p>
                          </div>
                        </div>
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {requiredApprovals.map((level) => (
                            <Badge key={level} variant="outline">
                              {level}
                            </Badge>
                          ))}
                        </div>
                      </div>

                      <div className="flex items-center justify-between gap-3 rounded-lg border bg-surface-subtle/60 p-3">
                        <div className="flex items-center gap-2">
                          <Rocket aria-hidden="true" className="size-4 text-muted-foreground" />
                          <div>
                            <Label htmlFor="wizard-submit-now">
                              Submit for approval now
                            </Label>
                            <p className="text-xs text-muted-foreground">
                              {editing
                                ? "Saves the draft and moves it to AWAITING_APPROVAL."
                                : "Unchecked = keep as DRAFT for later review."}
                            </p>
                          </div>
                        </div>
                        <Checkbox
                          aria-label="Submit for approval now"
                          checked={watchedSubmitNow ?? false}
                          id="wizard-submit-now"
                          onCheckedChange={(value) =>
                            form.setValue("submitNow", value === true, { shouldDirty: true })
                          }
                        />
                      </div>

                      <div className="flex items-center justify-between rounded-lg border p-3">
                        <span className="text-sm font-medium">Final risk</span>
                        <span className="flex items-center gap-2">
                          <span className="text-sm tabular-nums text-muted-foreground">
                            {risk.score}/100
                          </span>
                          <ChangeRiskBadge value={risk.level} />
                        </span>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Footer navigation */}
              <div className="flex items-center justify-between gap-2 border-t p-3">
                <Button
                  disabled={step === 0 || pending}
                  onClick={() => setStep((current) => Math.max(0, current - 1))}
                  type="button"
                  variant="outline"
                >
                  <ArrowLeft aria-hidden="true" />
                  Back
                </Button>
                <div className="flex items-center gap-2">
                  <Button disabled={pending} onClick={() => onOpenChange(false)} type="button" variant="ghost">
                    Cancel
                  </Button>
                  {step < STEPS.length - 1 ? (
                    <Button
                      disabled={
                        pending ||
                        (step === 5 && blockingConflicts.length > 0)
                      }
                      onClick={() => void goNext()}
                      type="button"
                    >
                      Next
                      <ArrowRight aria-hidden="true" />
                    </Button>
                  ) : (
                    <Button disabled={pending} type="submit">
                      {pending && <LoaderCircle aria-hidden="true" className="animate-spin" />}
                      {editing
                        ? "Save changes"
                        : watchedSubmitNow
                          ? "Create & submit"
                          : "Create draft"}
                    </Button>
                  )}
                </div>
              </div>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
