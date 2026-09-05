"use client";

import { useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  KeyRound,
  LoaderCircle,
  Plus,
  ShieldCheck,
  Vault,
} from "lucide-react";
import { z } from "zod";

import { useToast } from "@/hooks/use-toast";
import {
  useCreateCredential,
  useCredentials,
  useUpdateCredential,
} from "@/hooks/api/use-credentials";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { StatusBadge } from "@/components/domain/status-badge";
import type { CredentialProfileRow } from "@/lib/api-client";
import type { StatusBadgeConfig } from "@/lib/domain/status";

/**
 * Credential Profiles (Phase 2-c): vault-backed device credentials.
 *
 * SECURITY INVARIANT (audit finding F-12): secret material is NEVER rendered,
 * exported or stored here — only the vault REFERENCE (secretRef, e.g.
 * "vault://ssh/network-admin") travels through this UI and the API. The
 * secrets themselves live in the external vault.
 */

const CREDENTIAL_TYPES = [
  "SSH_PASSWORD",
  "SSH_KEY",
  "API_TOKEN",
  "SNMPV3",
  "HTTPS",
] as const;

type CredentialType = (typeof CREDENTIAL_TYPES)[number];

/** Type badge map — token families + registry icons only, no raw colors. */
const CREDENTIAL_TYPE: Record<CredentialType, StatusBadgeConfig> = {
  SSH_PASSWORD: {
    key: "SSH_PASSWORD",
    label: "SSH Password",
    token: "info",
    icon: "KeyRound",
    dotClass: "bg-info",
    badgeClass: "bg-info-subtle text-info border-info/25",
    iconClass: "text-info",
  },
  SSH_KEY: {
    key: "SSH_KEY",
    label: "SSH Key",
    token: "success",
    icon: "Key",
    dotClass: "bg-success",
    badgeClass: "bg-success-subtle text-success border-success/25",
    iconClass: "text-success",
  },
  API_TOKEN: {
    key: "API_TOKEN",
    label: "API Token",
    token: "warning",
    icon: "Hash",
    dotClass: "bg-warning",
    badgeClass: "bg-warning-subtle text-warning border-warning/25",
    iconClass: "text-warning",
  },
  SNMPV3: {
    key: "SNMPV3",
    label: "SNMPv3",
    token: "neutral",
    icon: "Router",
    dotClass: "bg-neutral",
    badgeClass: "bg-neutral-subtle text-neutral border-neutral/25",
    iconClass: "text-neutral",
  },
  HTTPS: {
    key: "HTTPS",
    label: "HTTPS",
    token: "neutral",
    icon: "Lock",
    dotClass: "bg-neutral",
    badgeClass: "bg-neutral-subtle text-neutral border-neutral/25",
    iconClass: "text-neutral",
  },
};

/** Neutral fallback badge for unexpected type values. */
const UNKNOWN_TYPE_BADGE: StatusBadgeConfig = {
  key: "UNKNOWN",
  label: "Unknown",
  token: "neutral",
  icon: "CircleHelp",
  dotClass: "bg-neutral",
  badgeClass: "bg-neutral-subtle text-neutral border-neutral/25",
  iconClass: "text-neutral",
};

function typeBadge(type: string): StatusBadgeConfig {
  return CREDENTIAL_TYPE[type as CredentialType] ?? { ...UNKNOWN_TYPE_BADGE, label: type };
}

const credentialFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  type: z.enum(CREDENTIAL_TYPES),
  username: z.string().trim().min(1, "Username is required").max(80),
  secretRef: z
    .string()
    .trim()
    .min(1, "Vault reference is required")
    .max(200)
    .startsWith("vault://", "The reference must point into the vault (vault://…)"),
  port: z.coerce.number().int().min(1).max(65535),
  notes: z.string().trim().max(2000).optional(),
});

export function CredentialsView() {
  const credentials = useCredentials();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CredentialProfileRow | null>(null);

  const rows = credentials.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        description="Vault-backed device credentials — references only, never secrets"
        primaryAction={
          <Button
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus aria-hidden="true" />
            New Profile
          </Button>
        }
        title="Credential Profiles"
      />

      <Alert>
        <ShieldCheck aria-hidden="true" />
        <AlertTitle>Secrets stay in the vault</AlertTitle>
        <AlertDescription>
          Secrets are stored in the external vault. FayaNMS persists references
          only — secrets are never displayed or exported.
        </AlertDescription>
      </Alert>

      <SectionCard
        contentClassName="p-0"
        description="Profiles referenced by devices and collectors; the vault reference column is a pointer, not a secret"
        title="Profiles"
      >
        {credentials.isError ? (
          <div className="p-4">
            <ErrorState
              onRetry={() => void credentials.refetch()}
              reason={credentials.error.message}
              title="Credential profiles could not be loaded"
            />
          </div>
        ) : credentials.isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="h-12 animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              description="Create a profile with a vault reference (e.g. vault://ssh/network-admin) — the collector resolves the actual secret at connect time."
              icon={KeyRound}
              title="No credential profiles yet"
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[860px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Name</TableHead>
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Type</TableHead>
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Username</TableHead>
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Vault reference</TableHead>
                  <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) md:table-cell">Port</TableHead>
                  <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) md:table-cell">Devices</TableHead>
                  <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) lg:table-cell">Rotated</TableHead>
                  <TableHead className="h-(--density-row-h) w-10 px-(--density-cell-x)" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((profile) => (
                  <TableRow key={profile.id}>
                    <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                      <div className="flex flex-col">
                        <span className="text-sm font-medium">{profile.name}</span>
                        {profile.notes && (
                          <span
                            className="max-w-[36ch] truncate text-xs text-muted-foreground"
                            title={profile.notes}
                          >
                            {profile.notes}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                      <StatusBadge config={typeBadge(profile.type)} />
                    </TableCell>
                    <TableCell className="h-(--density-row-h) px-(--density-cell-x) font-tech text-sm ltr-technical">
                      {profile.username}
                    </TableCell>
                    <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                      <span className="flex items-center gap-1.5 font-tech text-xs ltr-technical text-muted-foreground">
                        <Vault aria-hidden="true" className="size-3.5 shrink-0" />
                        {profile.secretRef}
                      </span>
                    </TableCell>
                    <TableCell className="hidden h-(--density-row-h) px-(--density-cell-x) tabular-nums md:table-cell">
                      {profile.port}
                    </TableCell>
                    <TableCell className="hidden h-(--density-row-h) px-(--density-cell-x) tabular-nums md:table-cell">
                      {profile.deviceCount}
                    </TableCell>
                    <TableCell className="hidden h-(--density-row-h) px-(--density-cell-x) text-xs text-muted-foreground lg:table-cell">
                      {profile.lastRotatedAt
                        ? formatDistanceToNow(new Date(profile.lastRotatedAt), {
                            addSuffix: true,
                          })
                        : "—"}
                    </TableCell>
                    <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                      <Button
                        aria-label={`Edit ${profile.name}`}
                        onClick={() => {
                          setEditing(profile);
                          setDialogOpen(true);
                        }}
                        size="sm"
                        variant="ghost"
                      >
                        Edit
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      {/* Create / edit dialog — the form remounts per open, so its field state
          initializes from `editing` without any reset effects. */}
      <CredentialDialog
        editing={editing}
        onOpenChange={setDialogOpen}
        open={dialogOpen}
      />
    </div>
  );
}

function CredentialDialog({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: CredentialProfileRow | null;
}) {
  const { toast } = useToast();
  const createCredential = useCreateCredential();
  const updateCredential = useUpdateCredential();

  // Local field state, initialized once per mount (the dialog content
  // unmounts when closed, so every open starts from `editing`).
  const [name, setName] = useState(() => editing?.name ?? "");
  const [type, setType] = useState<CredentialType>(() =>
    CREDENTIAL_TYPES.includes(editing?.type as CredentialType)
      ? (editing?.type as CredentialType)
      : "SSH_PASSWORD"
  );
  const [username, setUsername] = useState(() => editing?.username ?? "");
  const [secretRef, setSecretRef] = useState(() => editing?.secretRef ?? "");
  const [port, setPort] = useState(() => String(editing?.port ?? 22));
  const [notes, setNotes] = useState(() => editing?.notes ?? "");

  const pending = createCredential.isPending || updateCredential.isPending;

  const secretRefValid = useMemo(
    () => credentialFormSchema.shape.secretRef.safeParse(secretRef).success,
    [secretRef]
  );

  const handleSubmit = () => {
    const parsed = credentialFormSchema.safeParse({
      name,
      type,
      username,
      secretRef,
      port,
      notes: notes.trim() || undefined,
    });
    if (!parsed.success) {
      toast({
        title: "Check the profile fields",
        description: parsed.error.issues[0]?.message ?? "Invalid profile",
        variant: "destructive",
      });
      return;
    }
    if (editing) {
      updateCredential.mutate(
        { id: editing.id, data: parsed.data },
        { onSuccess: () => onOpenChange(false) }
      );
      return;
    }
    createCredential.mutate(parsed.data, {
      onSuccess: () => onOpenChange(false),
    });
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit credential profile" : "New credential profile"}
          </DialogTitle>
          <DialogDescription>
            Store the vault reference — the secret itself never enters FayaNMS
            and is never displayed.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cred-name">Name *</Label>
            <Input
              id="cred-name"
              onChange={(event) => setName(event.target.value)}
              placeholder="Branch — read-only SSH"
              value={name}
            />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>Type</Label>
              <Select
                onValueChange={(value) => setType(value as CredentialType)}
                value={type}
              >
                <SelectTrigger aria-label="Credential type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CREDENTIAL_TYPES.map((entry) => (
                    <SelectItem key={entry} value={entry}>
                      {CREDENTIAL_TYPE[entry].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cred-port">Port</Label>
              <Input
                id="cred-port"
                inputMode="numeric"
                onChange={(event) => setPort(event.target.value)}
                value={port}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cred-username">Username *</Label>
            <Input
              className="font-tech"
              id="cred-username"
              onChange={(event) => setUsername(event.target.value)}
              placeholder="netadmin"
              value={username}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cred-secret-ref">Vault reference *</Label>
            <Input
              aria-invalid={secretRef.length > 0 && !secretRefValid}
              className="font-tech ltr-technical"
              id="cred-secret-ref"
              onChange={(event) => setSecretRef(event.target.value)}
              placeholder="vault://ssh/network-admin"
              value={secretRef}
            />
            {secretRef.length > 0 && !secretRefValid ? (
              <p className="text-xs text-danger">
                The reference must start with vault:// — this field is a
                pointer, not the secret itself.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                e.g. vault://ssh/network-admin — resolved by the collector at
                connect time.
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cred-notes">Notes</Label>
            <Textarea
              id="cred-notes"
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Rotation policy, scope, operational context…"
              rows={3}
              value={notes}
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
            Cancel
          </Button>
          <Button disabled={pending} onClick={handleSubmit} type="button">
            {pending && <LoaderCircle aria-hidden="true" className="animate-spin" />}
            {editing ? "Save changes" : "Create profile"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
