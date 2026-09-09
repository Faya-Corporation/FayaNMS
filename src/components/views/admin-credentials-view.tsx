"use client";

import { useMemo } from "react";
import { formatDistanceToNow, parseISO } from "date-fns";
import { EyeOff, KeyRound, Lock, ShieldCheck, Vault } from "lucide-react";

import { useCredentials } from "@/hooks/api/use-credentials";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { KpiCard } from "@/components/domain/kpi-card";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { cn } from "@/lib/utils";
import type { CredentialProfileRow } from "@/lib/api-client";

/**
 * Administration → Credential Profiles (Task 7-a).
 *
 * READ-ONLY BY DESIGN (Gate G7): credential profiles are vault-backed and
 * secrets are NEVER rendered — not even a preview. The UI shows the auth
 * method, username, port, device count and rotation timestamps; the secret
 * column is a fixed "••••••••" chip pointing at the vault reference.
 */

const AUTH_METHOD_LABEL: Record<string, string> = {
  SSH_PASSWORD: "SSH password",
  SSH_KEY: "SSH key",
  API_TOKEN: "API token",
  SNMPV3: "SNMPv3",
  HTTPS: "HTTPS",
};

const SECRET_MASK = "••••••••";

export function AdminCredentialsView() {
  const credentialsQuery = useCredentials();
  const profiles = credentialsQuery.data ?? [];

  const kpis = useMemo(() => {
    const total = profiles.length;
    const ssh = profiles.filter((p) => p.type.startsWith("SSH")).length;
    const tokens = profiles.filter(
      (p) => p.type === "API_TOKEN" || p.type === "HTTPS"
    ).length;
    const rotated = profiles
      .map((p) => (p.lastRotatedAt ? parseISO(p.lastRotatedAt) : null))
      .filter((date): date is Date => date !== null)
      .sort((a, b) => b.getTime() - a.getTime());
    const lastRotated = rotated[0] ?? null;
    return { total, ssh, tokens, lastRotated };
  }, [profiles]);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        breadcrumbs={[{ label: "Administration" }, { label: "Credential Profiles" }]}
        description="Vault-backed device credentials for adapter, backup and discovery jobs. This view is read-only by design — secret material never leaves the vault."
        title="Credential Profiles"
      />

      {/* KPI row */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          description="Profiles across all auth methods"
          icon={KeyRound}
          label="Credential profiles"
          loading={credentialsQuery.isLoading}
          value={credentialsQuery.isLoading ? "—" : kpis.total}
        />
        <KpiCard
          description="Password and key-based CLI access"
          icon={Lock}
          label="SSH profiles"
          loading={credentialsQuery.isLoading}
          value={credentialsQuery.isLoading ? "—" : kpis.ssh}
        />
        <KpiCard
          description="API_TOKEN and HTTPS integrations"
          icon={ShieldCheck}
          label="API tokens"
          loading={credentialsQuery.isLoading}
          value={credentialsQuery.isLoading ? "—" : kpis.tokens}
        />
        <KpiCard
          description="Most recent secret rotation across the vault"
          icon={Vault}
          label="Last rotation"
          loading={credentialsQuery.isLoading}
          value={
            kpis.lastRotated
              ? formatDistanceToNow(kpis.lastRotated, { addSuffix: true })
              : "—"
          }
        />
      </div>

      {/* Gate G7 notice */}
      <div className="flex items-start gap-3 rounded-xl border border-success/30 bg-success/10 p-4 text-sm">
        <EyeOff aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
        <div>
          <p className="font-medium text-success">Secrets are always masked</p>
          <p className="text-muted-foreground">
            The vault holds the secret material; the platform stores and
            displays only vault references ({" "}
            <code className="font-mono text-xs">vault://…</code> ). No read,
            export or display path for secrets exists in this view — enforced
            for every role, including administrators.
          </p>
        </div>
      </div>

      <SectionCard
        title="Profiles"
        description="Auth methods, ownership and rotation history — secrets never displayed"
      >
        {credentialsQuery.isError ? (
          <ErrorState
            reason={
              credentialsQuery.error instanceof Error
                ? credentialsQuery.error.message
                : "The credential list could not be loaded."
            }
            title="Could not load credential profiles"
          />
        ) : profiles.length === 0 && !credentialsQuery.isLoading ? (
          <EmptyState
            description="Credential profiles are provisioned with the vault and used by backup, discovery and change jobs."
            icon={KeyRound}
            title="No credential profiles yet"
          />
        ) : (
          <div className="overflow-x-auto">
            <Table aria-label="Credential vault — profile name, type, owner and rotation metadata (secrets are masked and never displayed)">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Auth method</TableHead>
                  <TableHead>Username</TableHead>
                  <TableHead>Secret</TableHead>
                  <TableHead>Port</TableHead>
                  <TableHead>Devices</TableHead>
                  <TableHead>Last rotated</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {credentialsQuery.isLoading
                  ? Array.from({ length: 3 }).map((_, index) => (
                      <TableRow key={index}>
                        <TableCell colSpan={8}>
                          <div className="h-9 w-full animate-pulse rounded-md bg-muted" />
                        </TableCell>
                      </TableRow>
                    ))
                  : profiles.map((profile) => (
                      <ProfileRow key={profile.id} profile={profile} />
                    ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function ProfileRow({ profile }: { profile: CredentialProfileRow }) {
  const lastRotated = profile.lastRotatedAt
    ? formatDistanceToNow(parseISO(profile.lastRotatedAt), { addSuffix: true })
    : "Never";

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-2 font-medium">
          <Vault aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          {profile.name}
        </div>
      </TableCell>
      <TableCell>
        <span className="whitespace-nowrap rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold">
          {AUTH_METHOD_LABEL[profile.type] ?? profile.type}
        </span>
      </TableCell>
      <TableCell className="font-mono text-xs">{profile.username}</TableCell>
      <TableCell>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                "inline-flex cursor-help items-center gap-1.5 rounded-md border border-dashed px-2 py-1",
                "font-mono text-xs tracking-widest text-muted-foreground",
                "hover:border-primary/40 hover:text-foreground"
              )}
            >
              <Lock aria-hidden="true" className="size-3" />
              {SECRET_MASK}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-56">
            Vault-managed — secrets are never displayed
            <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">
              ref: {profile.secretRef}
            </span>
          </TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell className="tabular-nums">{profile.port}</TableCell>
      <TableCell className="tabular-nums">
        {profile.deviceCount > 0 ? (
          `${profile.deviceCount} device${profile.deviceCount === 1 ? "" : "s"}`
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
        {lastRotated}
      </TableCell>
      <TableCell className="max-w-64">
        {profile.notes ? (
          <p className="truncate text-xs text-muted-foreground" title={profile.notes}>
            {profile.notes}
          </p>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}
