"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useForm, useWatch, type UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  CheckCircle2,
  CircleSlash,
  KeyRound,
  LoaderCircle,
  MinusCircle,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { isLiveWebApiVendor } from "@/lib/devices/live-transport";
import {
  buildAddressStageRow,
  buildHostKeyPanel,
  buildVendorStageRow,
  decideApply,
  type DetectableField,
  type StageRow,
} from "@/lib/devices/detection-ui";

import { useMeta } from "@/hooks/api/use-meta";
import {
  useCreateDevice,
  useUpdateDevice,
  useAutoDetectDevice,
  type AutoDetectResult,
} from "@/hooks/api/use-devices";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useNavigationStore } from "@/stores/navigation";
import type { DeviceDetail } from "@/lib/api-client";

const IPV4_PATTERN =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

/**
 * Form schema (RT-022/F-021). Messages are devices.form.* dictionary KEYS
 * (resolved at render time via tForm — the same key-based pattern as the
 * alert-rules panel), so validation copy localizes with the locale.
 * DELIBERATE DUPLICATION: the server re-states these rules in
 * src/app/api/v1/devices (unchanged by this RT) — its messages remain the
 * fallback for API-level rejections; client keys are authoritative for the
 * client. Unknown (server) messages still render verbatim via the t.has
 * gate in tForm.
 */
const formSchema = z
  .object({
    hostname: z
      .string()
      .trim()
      .min(1, "hostnameRequired")
      .max(63, "hostnameMax")
      .regex(HOSTNAME_PATTERN, "hostnamePattern"),
    displayName: z.string().trim().max(120).optional(),
    vendorId: z.string().min(1, "vendorRequired"),
    model: z.string().trim().max(120).optional(),
    mgmtIp: z
      .string()
      .trim()
      .regex(IPV4_PATTERN, "mgmtIpPattern"),
    siteId: z.string().optional(),
    criticality: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
    // Data plane (Phase 22): SIMULATOR = deterministic in-memory adapters;
    // LIVE_SSH = the worker connects over REAL SSH (exec-only, read-only).
    dataSource: z.enum(["SIMULATOR", "LIVE_SSH"]),
    credentialProfileId: z.string().optional(),
    /** Comma-separated tags; parsed into an array on submit. */
    tags: z.string().trim().max(400).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .superRefine((values, ctx) => {
    // Fail-closed at the form layer too: a LIVE_SSH device without a linked
    // credential profile can never work — the API rejects it as well.
    if (values.dataSource === "LIVE_SSH" && !(values.credentialProfileId ?? "").trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["credentialProfileId"],
        message: "liveRequiresCredential",
      });
    }
  });

type FormValues = z.infer<typeof formSchema>;

/** R50-T062 — a detected value held for the operator's explicit pick. */
interface PendingPick {
  field: DetectableField;
  value: string;
  label: string;
}

/**
 * Detection pick labels. Keys resolve at render time via
 * `devices.form.pickField*` (localized); the field discriminant stays the
 * stable token. (The raw pick.label data from the detection result is not
 * rendered — this map drives the visible "Detected …" row.)
 */
const PICK_FIELD_LABELS: Record<DetectableField, string> = {
  vendorId: "pickFieldVendor",
  model: "pickFieldModel",
  mgmtIp: "pickFieldMgmtIp",
};

/** R50-T060 — the icon speaks the row state at a glance. */
function StageRowIcon({ row }: { row: StageRow }) {
  switch (row.state) {
    case "running":
      return <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin text-muted-foreground" />;
    case "matched":
    case "resolved":
      return <CheckCircle2 aria-hidden="true" className="size-4 shrink-0 text-success" />;
    case "generic":
      return <MinusCircle aria-hidden="true" className="size-4 shrink-0 text-warning" />;
    case "failed":
    case "refused":
      return <XCircle aria-hidden="true" className="size-4 shrink-0 text-danger" />;
    default:
      return <CircleSlash aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />;
  }
}

/** One explicit stage row (T060) with its retry affordance (T064). */
function StageRowView({
  onRetry,
  retryDisabled,
  row,
}: {
  row: StageRow;
  onRetry: () => void;
  retryDisabled: boolean;
}) {
  const t = useTranslations("devices.form");
  return (
    <div className="flex items-start justify-between gap-2">
      <div className="flex min-w-0 items-start gap-2">
        <span className="mt-0.5">
          <StageRowIcon row={row} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-xs font-medium">{row.headline}</p>
          {row.detail && (
            <p className="text-xs break-words text-muted-foreground">{row.detail}</p>
          )}
          {row.code && (
            <p className="font-tech text-[10px] tracking-wide text-muted-foreground">
              {row.code}
            </p>
          )}
        </div>
      </div>
      {row.retryable && (
        <Button
          aria-label={row.stage === "vendor" ? t("stageRetryVendorAria") : t("stageRetryAddressAria")}
          className="h-7 shrink-0 gap-1 px-2 text-xs"
          disabled={retryDisabled}
          onClick={onRetry}
          size="sm"
          type="button"
          variant="ghost"
        >
          <RefreshCw aria-hidden="true" className="size-3" />
          {t("stageRetry")}
        </Button>
      )}
    </div>
  );
}


/**
 * R50.6 — the detection section of the Add/Edit device sheet: the Detect
 * button, the two explicit stage rows (T060/T061), the first-contact
 * host-key disclosure (T063), the explicit Use / Keep-mine picks (T062)
 * and the per-stage retries (T064).
 *
 * It is rendered INSIDE the sheet content on purpose: Radix unmounts that
 * subtree when the sheet closes, so every open session starts with fresh
 * detection state — no effect-driven reset (which the react-hooks
 * set-state-in-effect rule — and honestly, the invariant — forbid).
 * Form writes go through the shared RHF instance via `form`.
 */
function DetectionSection({
  editing,
  form,
  vendors,
}: {
  editing: boolean;
  form: UseFormReturn<FormValues>;
  vendors: Array<{ id: string; key: string; name: string }>;
}) {
  const t = useTranslations("devices.form");
  const autoDetect = useAutoDetectDevice();
  // Compiler-safe field subscriptions (form.watch() in render is the
  // incompatible-library pattern).
  const hostnameValue = useWatch({ control: form.control, name: "hostname" });
  const credentialProfileId = useWatch({
    control: form.control,
    name: "credentialProfileId",
  });

  /** The last detection response — the two stage blocks drive the rows. */
  const [detectionResult, setDetectionResult] = useState<AutoDetectResult | null>(null);
  /** Which stages the CURRENT/last invocation was asked to run (T064). */
  const [ranStages, setRanStages] = useState<{ vendor: boolean; address: boolean }>({
    vendor: false,
    address: false,
  });
  /** T062 — detected values awaiting the operator's explicit Use / Keep. */
  const [pendingPicks, setPendingPicks] = useState<PendingPick[]>([]);

  /**
   * R50 — auto-detect: FIRST fingerprint the vendor over read-only SSH
   * (when a credential profile is selected), THEN map the hostname to its
   * management address. R50.6 hardening:
   *  - T060/T061: results are rendered per stage in the panel — partial
   *    success stays visible, nothing is collapsed into one toast.
   *  - T062: the result reaches the form ONLY through decideApply — an
   *    empty field is filled, a field the operator typed is staged for an
   *    explicit Use / Keep-mine pick (never silently overwritten).
   *  - T064: `stages` re-runs exactly one stage (an address-only retry
   *    does NOT re-probe the device over SSH).
   */
  const runDetection = (stages?: Array<"vendor" | "address">) => {
    const host = (form.getValues("hostname") ?? "").trim();
    if (!host) return;
    const credentialProfileId = form.getValues("credentialProfileId") || undefined;
    setRanStages({
      vendor: stages ? stages.includes("vendor") : true,
      address: stages ? stages.includes("address") : true,
    });
    autoDetect.mutate(
      stages ? { host, credentialProfileId, stages } : { host, credentialProfileId },
      {
        onSuccess: (result) => {
          setDetectionResult(result);
          // T062 — explicit replace/keep semantics, applied per field.
          const picks: PendingPick[] = [];
          const consider = (
            field: DetectableField,
            currentValue: string | undefined | null,
            value: string,
            label: string,
          ) => {
            const decision = decideApply(currentValue, { field, value, label });
            if (decision.action === "apply") {
              form.setValue(field, decision.value, { shouldValidate: true });
            } else if (decision.action === "stage") {
              picks.push({ field, value: decision.value, label: decision.label });
            }
          };
          const detectedVendor =
            result.detected && result.detection
              ? vendors.find((v) => v.key === result.detection?.vendorKey)
              : undefined;
          // Vendor + model are create-flow concerns: on edit the vendor
          // select is locked and the edit submit does not persist model,
          // so a pick there would silently do nothing on save.
          if (!editing && detectedVendor) {
            consider(
              "vendorId",
              form.getValues("vendorId"),
              detectedVendor.id,
              detectedVendor.name,
            );
          }
          if (!editing && result.detection?.model) {
            consider("model", form.getValues("model"), result.detection.model, "model");
          }
          const detectedIp =
            result.addressResolution?.mgmtIp ?? result.mgmtIpResolution.mgmtIp;
          if (detectedIp) {
            consider("mgmtIp", form.getValues("mgmtIp"), detectedIp, "management IP");
          }
          setPendingPicks(picks);
        },
      },
    );
  };

  /** T062 — the operator accepted a staged value. */
  const applyPick = (pick: PendingPick) => {
    form.setValue(pick.field, pick.value, { shouldValidate: true });
    setPendingPicks((current) => current.filter((entry) => entry !== pick));
  };

  /** T062 — the operator kept their own value. */
  const discardPick = (pick: PendingPick) => {
    setPendingPicks((current) => current.filter((entry) => entry !== pick));
  };

  // R50.6 panel derivations (pure layer, pinned by the audit suite).
  const vendorStageRow = buildVendorStageRow(
    detectionResult?.vendorDetection ?? null,
    autoDetect.isPending && ranStages.vendor,
  );
  const addressStageRow = buildAddressStageRow(
    detectionResult?.addressResolution ?? null,
    autoDetect.isPending && ranStages.address,
  );
  const hostKeyPanel = buildHostKeyPanel(
    detectionResult?.vendorDetection ?? null,
    detectionResult?.requestedHost ?? detectionResult?.host ?? null,
    detectionResult?.connectionAddress ?? null,
  );
  const retryDisabled = autoDetect.isPending || !hostnameValue.trim();

  return (
    <>
      <div className="flex items-center gap-2">
        <Button
          aria-label={t("detectButtonAria")}
          disabled={autoDetect.isPending || !hostnameValue.trim()}
          onClick={() => runDetection()}
          size="sm"
          type="button"
          variant="outline"
        >
          {autoDetect.isPending && (
            <LoaderCircle aria-hidden="true" className="animate-spin" />
          )}
          {t("detectButton")}
        </Button>
        <p className="text-xs text-muted-foreground">
          {credentialProfileId ? t("detectHintWithProfile") : t("detectHintNoProfile")}
        </p>
      </div>

      {/* R50.6 — the two-stage detection panel (T060/T061) with explicit
          picks (T062), first-contact host-key disclosure (T063) and
          per-stage retry (T064). */}
      {(autoDetect.isPending || detectionResult) && (
        <div
          aria-live="polite"
          className="flex flex-col gap-2.5 rounded-md border bg-muted/30 p-3"
          role="status"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold">
              {detectionResult
                ? t("detectionTitle", {
                    host: detectionResult.requestedHost ?? detectionResult.host,
                  })
                : t("detectionHeading")}
            </p>
            {detectionResult?.contractVersion != null && (
              <span className="font-tech text-[10px] text-muted-foreground">
                contract v{detectionResult.contractVersion}
              </span>
            )}
          </div>
          <StageRowView
            onRetry={() => runDetection(["vendor"])}
            retryDisabled={retryDisabled}
            row={vendorStageRow}
          />
          <StageRowView
            onRetry={() => runDetection(["address"])}
            retryDisabled={retryDisabled}
            row={addressStageRow}
          />
          {hostKeyPanel && (
            <div
              className={`flex flex-col gap-1 rounded-md border p-2.5 ${
                hostKeyPanel.state === "pinned"
                  ? "border-success/40 bg-success-subtle/40"
                  : "border-warning/40 bg-warning-subtle/40"
              }`}
            >
              <div className="flex items-center gap-1.5">
                <KeyRound
                  aria-hidden="true"
                  className={`size-3.5 ${
                    hostKeyPanel.state === "pinned" ? "text-success" : "text-warning"
                  }`}
                />
                <p className="text-xs font-medium">
                  {hostKeyPanel.state === "capture-requested"
                    ? t("hostKeyCaptured")
                    : t("hostKeyVerified")}
                </p>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                {hostKeyPanel.target && (
                  <>
                    <dt className="text-muted-foreground">{t("hostKeyTarget")}</dt>
                    <dd className="font-tech break-all">{hostKeyPanel.target}</dd>
                  </>
                )}
                {hostKeyPanel.dialed && (
                  <>
                    <dt className="text-muted-foreground">{t("hostKeyDialed")}</dt>
                    <dd className="font-tech break-all">{hostKeyPanel.dialed}</dd>
                  </>
                )}
                {hostKeyPanel.captured && (
                  <>
                    <dt className="text-muted-foreground">{t("hostKeyAlgorithm")}</dt>
                    <dd className="font-tech break-all">{hostKeyPanel.captured.keyType}</dd>
                  </>
                )}
                {hostKeyPanel.captured && (
                  <>
                    <dt className="text-muted-foreground">{t("hostKeyFingerprint")}</dt>
                    <dd className="font-tech break-all">
                      {hostKeyPanel.captured.fingerprint}
                    </dd>
                  </>
                )}
              </dl>
              {hostKeyPanel.state === "capture-requested" && (
                <p className="text-xs text-muted-foreground">{t("hostKeyDisclaimer")}</p>
              )}
            </div>
          )}
          {pendingPicks.map((pick) => (
            <div
              className="flex items-center justify-between gap-2 rounded-md border bg-background px-2.5 py-1.5"
              key={`${pick.field}-${pick.value}`}
            >
              <p className="min-w-0 text-xs">
                <span className="text-muted-foreground">
                  {t("detectedPick", { field: t(PICK_FIELD_LABELS[pick.field]) })}
                </span>
                <span className="font-tech break-all">{pick.value}</span>
                <span className="text-muted-foreground"> {t("pickHasInput")}</span>
              </p>
              <div className="flex shrink-0 gap-1">
                <Button
                  className="h-7 px-2 text-xs"
                  onClick={() => applyPick(pick)}
                  size="sm"
                  type="button"
                >
                  {t("pickUse")}
                </Button>
                <Button
                  className="h-7 px-2 text-xs"
                  onClick={() => discardPick(pick)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {t("pickKeepMine")}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

interface DeviceFormSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When provided the sheet edits this device instead of creating one. */
  device?: DeviceDetail | null;
}

function parseTags(input: string | undefined): string[] | undefined {
  const tags = (input ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  return tags.length > 0 ? tags : undefined;
}

/**
 * Add / Edit device sheet (Phase 2). React-hook-form + Zod validation;
 * create navigates straight to the new device's detail view.
 */
export function AddDeviceSheet({ open, onOpenChange, device }: DeviceFormSheetProps) {
  const t = useTranslations("devices.form");
  // Key-based message resolver (RT-005 alert-rules-panel pattern): the zod
  // messages ARE devices.form.* dictionary keys; anything that is not a
  // known key — e.g. a server-side rejection reason surfaced through the
  // same channel — renders VERBATIM (fallback contract preserved, see the
  // schema comment on the deliberate server-copy duplication).
  const tForm = (message: string | undefined): string =>
    message && t.has(message) ? t(message) : (message ?? "");
  const meta = useMeta();
  const createDevice = useCreateDevice();
  const updateDevice = useUpdateDevice();
  const setActiveView = useNavigationStore((state) => state.setActiveView);

  const editing = Boolean(device);
  const defaultValues = useMemo<FormValues>(
    () => ({
      hostname: device?.hostname ?? "",
      displayName: device?.displayName ?? "",
      vendorId: device?.vendor.id ?? "",
      model: device?.model ?? "",
      mgmtIp: device?.mgmtIp ?? "",
      siteId: device?.site?.id ?? "",
      criticality:
        device?.criticality === "HIGH" || device?.criticality === "CRITICAL"
          ? device.criticality
          : device?.criticality === "LOW"
            ? "LOW"
            : "MEDIUM",
      dataSource: device?.dataSource === "LIVE_SSH" ? "LIVE_SSH" : "SIMULATOR",
      credentialProfileId: device?.credentialProfile?.id ?? "",
      tags: device?.tags.join(", ") ?? "",
      notes: device?.notes ?? "",
    }),
    [device]
  );

  const form = useForm<FormValues>({
    defaultValues,
    resolver: zodResolver(formSchema),
    mode: "onSubmit",
  });

  // Subscribe to field values via useWatch (compiler-safe) instead of
  // form.watch(), which returns a function React Compiler cannot memoize.
  const vendorId = useWatch({ control: form.control, name: "vendorId" });
  const liveWebApiVendor = isLiveWebApiVendor((meta.data?.vendors ?? []).find((v) => v.id === vendorId)?.key);
  const siteId = useWatch({ control: form.control, name: "siteId" });
  const criticality = useWatch({ control: form.control, name: "criticality" });
  const dataSource = useWatch({ control: form.control, name: "dataSource" });
  const credentialProfileId = useWatch({
    control: form.control,
    name: "credentialProfileId",
  });
  const isLive = dataSource === "LIVE_SSH";

  const pending = createDevice.isPending || updateDevice.isPending;

  const onSubmit = (values: FormValues) => {
    if (editing && device) {
      updateDevice.mutate(
        {
          id: device.id,
          data: {
            displayName: values.displayName || values.hostname,
            notes: values.notes || null,
            criticality: values.criticality,
            mgmtIp: values.mgmtIp,
            siteId: values.siteId || null,
            dataSource: values.dataSource,
            credentialProfileId: values.credentialProfileId || null,
            tags: parseTags(values.tags) ?? [],
          },
        },
        { onSuccess: () => onOpenChange(false) }
      );
      return;
    }

    createDevice.mutate(
      {
        hostname: values.hostname,
        displayName: values.displayName || undefined,
        vendorId: values.vendorId,
        model: values.model || undefined,
        mgmtIp: values.mgmtIp,
        siteId: values.siteId || undefined,
        criticality: values.criticality,
        dataSource: values.dataSource,
        credentialProfileId: values.credentialProfileId || undefined,
        tags: parseTags(values.tags),
        notes: values.notes || undefined,
      },
      {
        onSuccess: (result) => {
          onOpenChange(false);
          setActiveView("network.device-detail", { deviceId: result.device.id });
        },
      }
    );
  };

  const vendors = meta.data?.vendors ?? [];
  const sites = meta.data?.sites ?? [];
  const profiles = meta.data?.credentialProfiles ?? [];

  const criticalities: { value: FormValues["criticality"]; label: string }[] = [
    { value: "LOW", label: t("criticalityLow") },
    { value: "MEDIUM", label: t("criticalityMedium") },
    { value: "HIGH", label: t("criticalityHigh") },
    { value: "CRITICAL", label: t("criticalityCritical") },
  ];

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="flex flex-col gap-0 overflow-y-auto sm:max-w-md" side="right">
        <SheetHeader className="pb-2">
          <SheetTitle>{editing ? t("editTitle") : t("addTitle")}</SheetTitle>
          <SheetDescription>
            {editing ? t("editDescription") : t("addDescription")}
          </SheetDescription>
        </SheetHeader>

        <form
          className="flex flex-1 flex-col gap-4 px-4 pb-4"
          onSubmit={form.handleSubmit(onSubmit)}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="device-hostname">{t("hostnameLabel")}</Label>
            <Input
              {...form.register("hostname")}
              aria-invalid={Boolean(form.formState.errors.hostname)}
              disabled={editing}
              id="device-hostname"
              // Example-format DATA placeholder (hostname shape) — kept
              // untranslated per the RT-020 precedent.
              placeholder="HQ-Core-RTR-01"
              className="font-tech"
            />
            {form.formState.errors.hostname && (
              <p className="text-xs text-danger">
                {tForm(form.formState.errors.hostname.message)}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="device-display-name">{t("displayNameLabel")}</Label>
            <Input {...form.register("displayName")} id="device-display-name" placeholder="HQ Core Router 01" />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="device-vendor">{t("vendorLabel")}</Label>
              <Select
                disabled={editing}
                onValueChange={(value) => form.setValue("vendorId", value, { shouldValidate: true })}
                value={vendorId}
              >
                <SelectTrigger aria-label={t("vendorAria")} id="device-vendor">
                  <SelectValue placeholder={t("vendorPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {vendors.map((vendor) => (
                    <SelectItem key={vendor.id} value={vendor.id}>
                      {vendor.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {form.formState.errors.vendorId && (
                <p className="text-xs text-danger">{tForm(form.formState.errors.vendorId.message)}</p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="device-model">{t("modelLabel")}</Label>
              <Input {...form.register("model")} id="device-model" placeholder="ISR4451-X" />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="device-mgmt-ip">{t("mgmtIpLabel")}</Label>
            <Input
              {...form.register("mgmtIp")}
              aria-invalid={Boolean(form.formState.errors.mgmtIp)}
              className="font-tech"
              id="device-mgmt-ip"
              inputMode="numeric"
              placeholder="10.20.255.1"
            />
            {form.formState.errors.mgmtIp && (
              <p className="text-xs text-danger">{tForm(form.formState.errors.mgmtIp.message)}</p>
            )}
            <DetectionSection editing={editing} form={form} vendors={vendors} />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>{t("siteLabel")}</Label>
              <Select
                onValueChange={(value) => form.setValue("siteId", value === "NONE" ? "" : value)}
                value={siteId || "NONE"}
              >
                <SelectTrigger aria-label={t("siteAria")}>
                  <SelectValue placeholder={t("unassigned")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">{t("unassigned")}</SelectItem>
                  {sites.map((site) => (
                    <SelectItem key={site.id} value={site.id}>
                      {site.name} ({site.code})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{t("criticalityLabel")}</Label>
              <Select
                onValueChange={(value) =>
                  form.setValue("criticality", value as FormValues["criticality"])
                }
                value={criticality}
              >
                <SelectTrigger aria-label={t("criticalityAria")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {criticalities.map((entry) => (
                    <SelectItem key={entry.value} value={entry.value}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>{t("dataPlaneLabel")}</Label>
            <Select
              onValueChange={(value) =>
                form.setValue("dataSource", value as FormValues["dataSource"], {
                  shouldValidate: true,
                })
              }
              value={dataSource}
            >
              <SelectTrigger aria-label={t("dataPlaneAria")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="SIMULATOR">{t("dataPlaneSimulator")}</SelectItem>
                <SelectItem value="LIVE_SSH">{t("dataPlaneLive")}</SelectItem>
              </SelectContent>
            </Select>
            {isLive ? (
              <p className="text-xs text-muted-foreground">{t("liveDataPlaneHint")}</p>
            ) : (
              <p className="text-xs text-muted-foreground">{t("simulatorDataPlaneHint")}</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="device-credential-profile">
              {isLive ? t("credentialLabelRequired") : t("credentialLabel")}
            </Label>
            <Select
              onValueChange={(value) =>
                form.setValue("credentialProfileId", value === "NONE" ? "" : value, {
                  shouldValidate: true,
                })
              }
              value={credentialProfileId || "NONE"}
            >
              <SelectTrigger
                aria-label={t("credentialAria")}
                aria-invalid={Boolean(form.formState.errors.credentialProfileId)}
                id="device-credential-profile"
              >
                <SelectValue placeholder={t("credentialPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="NONE">{t("credentialNoneOption")}</SelectItem>
                {profiles.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.name} · {profile.type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.formState.errors.credentialProfileId && (
              <p className="text-xs text-danger">
                {tForm(form.formState.errors.credentialProfileId.message)}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {isLive
                ? liveWebApiVendor
                  ? t("credentialHintLiveApiToken")
                  : t("credentialHintLivePassword")
                : t("credentialHintManaged")}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="device-tags">{t("tagsLabel")}</Label>
            <Input
              {...form.register("tags")}
              id="device-tags"
              placeholder="core, bgp, hsrp"
            />
            <p className="text-xs text-muted-foreground">{t("tagsHint")}</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="device-notes">{t("notesLabel")}</Label>
            <Textarea
              {...form.register("notes")}
              id="device-notes"
              placeholder={t("notesPlaceholder")}
              rows={3}
            />
          </div>

          <Separator className="mt-auto" />
          <SheetFooter className="px-0">
            <Button
              disabled={pending}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              {t("cancel")}
            </Button>
            <Button disabled={pending} type="submit">
              {pending && <LoaderCircle aria-hidden="true" className="animate-spin" />}
              {editing ? t("saveChanges") : t("createDevice")}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
