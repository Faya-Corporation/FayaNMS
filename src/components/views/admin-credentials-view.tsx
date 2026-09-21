"use client";

import { useMemo } from "react";
import { formatDistanceToNow, parseISO } from "date-fns";
import { EyeOff, KeyRound, Lock, ShieldCheck, Vault } from "lucide-react";
import { useTranslations } from "next-intl";

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

// Auth-method labels resolve in the active locale at render (the R82
// SORT_CHIPS / R84 STATUS_GROUPS / R86 KIND_KEYS dynamic-key precedent).
// The API contract is an open string (CredentialProfileRow.type), so
// unknown tokens fall back to the raw value. SNMPv3/HTTPS are protocol
// names — the dictionary values stay Latin in BOTH locales (the pre-tranche
// EN chip rendered "SNMPv3", not the raw SNMPV3 token).
const AUTH_KEYS: Record<string, string> = {
  SSH_PASSWORD: "sshPassword",
  SSH_KEY: "sshKey",
  API_TOKEN: "apiToken",
  SNMPV3: "snmpv3",
  HTTPS: "https",
};

// The bullet mask is a locale-neutral technical token: secrets are never
// rendered in ANY locale (Gate G7 — documented survivor).
const SECRET_MASK = "••••••••";

export function AdminCredentialsView() {
  const t = useTranslations("credentials");
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
        breadcrumbs={[
          { label: t("breadcrumb.administration") },
          { label: t("breadcrumb.credentials") },
        ]}
        description={t("description")}
        title={t("title")}
      />

      {/* KPI row — the loading "—" placeholders and the KPI numbers are
          locale-neutral tokens (numeric chip + fmtMetric precedent). */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          description={t("kpi.total.description")}
          icon={KeyRound}
          label={t("kpi.total.label")}
          loading={credentialsQuery.isLoading}
          value={credentialsQuery.isLoading ? "—" : kpis.total}
        />
        <KpiCard
          description={t("kpi.ssh.description")}
          icon={Lock}
          label={t("kpi.ssh.label")}
          loading={credentialsQuery.isLoading}
          value={credentialsQuery.isLoading ? "—" : kpis.ssh}
        />
        <KpiCard
          description={t("kpi.tokens.description")}
          icon={ShieldCheck}
          label={t("kpi.tokens.label")}
          loading={credentialsQuery.isLoading}
          value={credentialsQuery.isLoading ? "—" : kpis.tokens}
        />
        <KpiCard
          description={t("kpi.rotation.description")}
          icon={Vault}
          label={t("kpi.rotation.label")}
          loading={credentialsQuery.isLoading}
          value={
            kpis.lastRotated
              ? formatDistanceToNow(kpis.lastRotated, { addSuffix: true })
              : "—"
          }
        />
      </div>

      {/* Gate G7 notice — the vault:// reference is a technical token
          (documented survivor); the prose splits around it so the code
          element keeps its font-mono styling. */}
      <div className="flex items-start gap-3 rounded-xl border border-success/30 bg-success/10 p-4 text-sm">
        <EyeOff aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
        <div>
          <p className="font-medium text-success">{t("notice.title")}</p>
          <p className="text-muted-foreground">
            {t("notice.bodyStart")}{" "}
            <code className="font-mono text-xs">vault://…</code>{" "}
            {t("notice.bodyEnd")}
          </p>
        </div>
      </div>

      <SectionCard
        title={t("card.title")}
        description={t("card.description")}
      >
        {credentialsQuery.isError ? (
          <ErrorState
            reason={
              credentialsQuery.error instanceof Error
                ? credentialsQuery.error.message
                : t("error.reasonFallback")
            }
            title={t("error.title")}
          />
        ) : profiles.length === 0 && !credentialsQuery.isLoading ? (
          <EmptyState
            description={t("empty.description")}
            icon={KeyRound}
            title={t("empty.title")}
          />
        ) : (
          <div className="overflow-x-auto">
            <Table aria-label={t("table.ariaLabel")}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("table.col.name")}</TableHead>
                  <TableHead>{t("table.col.authMethod")}</TableHead>
                  <TableHead>{t("table.col.username")}</TableHead>
                  <TableHead>{t("table.col.secret")}</TableHead>
                  <TableHead>{t("table.col.port")}</TableHead>
                  <TableHead>{t("table.col.devices")}</TableHead>
                  <TableHead>{t("table.col.lastRotated")}</TableHead>
                  <TableHead>{t("table.col.notes")}</TableHead>
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
  const t = useTranslations("credentials");
  const authKey = AUTH_KEYS[profile.type];
  // date-fns English relative time — no ar locale wired anywhere
  // (device-config-tab / R83-R86 precedent, documented survivor).
  const lastRotated = profile.lastRotatedAt
    ? formatDistanceToNow(parseISO(profile.lastRotatedAt), { addSuffix: true })
    : t("row.never");

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
          {authKey ? t(`authMethod.${authKey}`) : profile.type}
        </span>
      </TableCell>
      {/* Data-plane cells: username/name/port/notes are vault-backed row
          values (R83 data-plane titles precedent). */}
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
            {t("row.vaultManaged")}
            <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">
              {t("row.ref", { ref: profile.secretRef })}
            </span>
          </TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell className="tabular-nums">{profile.port}</TableCell>
      <TableCell className="tabular-nums">
        {profile.deviceCount > 0 ? (
          t("row.devices", { count: profile.deviceCount })
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
