"use client";

import { useEffect, useMemo } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { LoaderCircle } from "lucide-react";
import { isLiveWebApiVendor } from "@/lib/devices/live-transport";

import { useMeta } from "@/hooks/api/use-meta";
import { useCreateDevice, useUpdateDevice } from "@/hooks/api/use-devices";
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

const formSchema = z
  .object({
    hostname: z
      .string()
      .trim()
      .min(1, "Hostname is required")
      .max(63, "Hostname is limited to 63 characters")
      .regex(HOSTNAME_PATTERN, "Letters, digits and hyphens only"),
    displayName: z.string().trim().max(120).optional(),
    vendorId: z.string().min(1, "Vendor is required"),
    model: z.string().trim().max(120).optional(),
    mgmtIp: z
      .string()
      .trim()
      .regex(IPV4_PATTERN, "Enter a valid IPv4 management address"),
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
        message: "LIVE devices require a linked SSH credential profile",
      });
    }
  });

type FormValues = z.infer<typeof formSchema>;

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

  // Reset the form whenever the sheet opens (or the edited device changes).
  useEffect(() => {
    if (open) {
      form.reset(defaultValues);
    }
  }, [open, defaultValues, form]);

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
    { value: "LOW", label: "Low" },
    { value: "MEDIUM", label: "Medium" },
    { value: "HIGH", label: "High" },
    { value: "CRITICAL", label: "Critical" },
  ];

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="flex flex-col gap-0 overflow-y-auto sm:max-w-md" side="right">
        <SheetHeader className="pb-2">
          <SheetTitle>{editing ? "Edit device" : "Add device"}</SheetTitle>
          <SheetDescription>
            {editing
              ? "Update the inventory record. Connectivity details are managed by the collector."
              : "Registers the device with status Unknown until the first successful poll."}
          </SheetDescription>
        </SheetHeader>

        <form
          className="flex flex-1 flex-col gap-4 px-4 pb-4"
          onSubmit={form.handleSubmit(onSubmit)}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="device-hostname">Hostname *</Label>
            <Input
              {...form.register("hostname")}
              aria-invalid={Boolean(form.formState.errors.hostname)}
              disabled={editing}
              id="device-hostname"
              placeholder="HQ-Core-RTR-01"
              className="font-tech"
            />
            {form.formState.errors.hostname && (
              <p className="text-xs text-danger">
                {form.formState.errors.hostname.message}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="device-display-name">Display name</Label>
            <Input {...form.register("displayName")} id="device-display-name" placeholder="HQ Core Router 01" />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="device-vendor">Vendor *</Label>
              <Select
                disabled={editing}
                onValueChange={(value) => form.setValue("vendorId", value, { shouldValidate: true })}
                value={vendorId}
              >
                <SelectTrigger aria-label="Vendor" id="device-vendor">
                  <SelectValue placeholder="Select vendor" />
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
                <p className="text-xs text-danger">{form.formState.errors.vendorId.message}</p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="device-model">Model</Label>
              <Input {...form.register("model")} id="device-model" placeholder="ISR4451-X" />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="device-mgmt-ip">Management IP *</Label>
            <Input
              {...form.register("mgmtIp")}
              aria-invalid={Boolean(form.formState.errors.mgmtIp)}
              className="font-tech"
              id="device-mgmt-ip"
              inputMode="numeric"
              placeholder="10.20.255.1"
            />
            {form.formState.errors.mgmtIp && (
              <p className="text-xs text-danger">{form.formState.errors.mgmtIp.message}</p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>Site</Label>
              <Select
                onValueChange={(value) => form.setValue("siteId", value === "NONE" ? "" : value)}
                value={siteId || "NONE"}
              >
                <SelectTrigger aria-label="Site">
                  <SelectValue placeholder="Unassigned" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">Unassigned</SelectItem>
                  {sites.map((site) => (
                    <SelectItem key={site.id} value={site.id}>
                      {site.name} ({site.code})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Criticality</Label>
              <Select
                onValueChange={(value) =>
                  form.setValue("criticality", value as FormValues["criticality"])
                }
                value={criticality}
              >
                <SelectTrigger aria-label="Criticality">
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
            <Label>Data plane</Label>
            <Select
              onValueChange={(value) =>
                form.setValue("dataSource", value as FormValues["dataSource"], {
                  shouldValidate: true,
                })
              }
              value={dataSource}
            >
              <SelectTrigger aria-label="Data plane">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="SIMULATOR">Simulator (deterministic demo adapters)</SelectItem>
                <SelectItem value="LIVE_SSH">Live device (read-only SSH)</SelectItem>
              </SelectContent>
            </Select>
            {isLive ? (
              <p className="text-xs text-muted-foreground">
                The worker connects over REAL SSH (exec-only, read-only show
                commands). Certified live vendors: Cisco IOS/IOS-XE, Fortinet
                FortiOS, HPE Aruba AOS-CX.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Simulator devices answer the worker deterministically — ideal
                for demos, training and workflow testing.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="device-credential-profile">
              Credential profile{isLive ? " *" : ""}
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
                aria-label="Credential profile"
                aria-invalid={Boolean(form.formState.errors.credentialProfileId)}
                id="device-credential-profile"
              >
                <SelectValue placeholder="None yet" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="NONE">— none —</SelectItem>
                {profiles.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.name} · {profile.type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.formState.errors.credentialProfileId && (
              <p className="text-xs text-danger">
                {form.formState.errors.credentialProfileId.message}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {isLive
                ? `Required for live devices — use an ${liveWebApiVendor ? "API_TOKEN (the SFOS WebAPI api-key)" : "SSH_PASSWORD"} profile and make sure its secret exists in the worker vault (FAYANMS_VAULT_*).`
                : "Managed in Administration → Credential Profiles — secrets stay in the vault, FayaNMS stores references only."}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="device-tags">Tags</Label>
            <Input
              {...form.register("tags")}
              id="device-tags"
              placeholder="core, bgp, hsrp"
            />
            <p className="text-xs text-muted-foreground">Comma-separated keywords.</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="device-notes">Description</Label>
            <Textarea
              {...form.register("notes")}
              id="device-notes"
              placeholder="Role, location notes, operational context…"
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
              Cancel
            </Button>
            <Button disabled={pending} type="submit">
              {pending && <LoaderCircle aria-hidden="true" className="animate-spin" />}
              {editing ? "Save changes" : "Create device"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
