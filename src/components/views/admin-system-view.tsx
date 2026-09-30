"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Link2,
  LoaderCircle,
  Save,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { useTranslations } from "next-intl";

import {
  useAdminSettings,
  useAuditChain,
  useBackfillAuditChain,
  useUpdateAdminSettings,
} from "@/hooks/api/use-admin";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { KpiCard } from "@/components/domain/kpi-card";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import type { AdminSettingRow } from "@/lib/api-client";
import { useCanWrite } from "@/stores/permissions";

/**
 * Administration → System Settings (Task 7-b).
 *
 * Whitelisted platform settings (Setting table) + audit hash-chain
 * integrity. The metrics *tier* retention policy has its own UI on the
 * Performance Overview view — a pointer card links there.
 *
 * i18n (R81 tranche 2): all chrome keyed through the `systemSettings`
 * namespace — including the colon-syntax GROUPS block (never matched by
 * the shallow sweep; keyed by hand via `group.${prefix}.*` keys) and the
 * unsaved-changes ICU plural. Documented data-plane survivors: rows'
 * setting.label / aria-label (rendered from the Setting table — DB
 * content, like hostnames) and the "—" em-dash placeholders.
 */

const GROUPS: { prefix: string }[] = [
  { prefix: "system" },
  { prefix: "backup" },
  { prefix: "drift" },
  { prefix: "alert" },
  { prefix: "metrics" },
  { prefix: "performance" },
];

function groupOf(key: string): string {
  return key.split(".")[0] ?? "other";
}

export function AdminSystemView() {
  const t = useTranslations("systemSettings");
  const canWrite = useCanWrite();

  const settingsQuery = useAdminSettings();
  const updateSettings = useUpdateAdminSettings();
  const auditChainQuery = useAuditChain();
  const backfillChain = useBackfillAuditChain();

  const settings = settingsQuery.data?.settings ?? [];
  const [edits, setEdits] = useState<Record<string, string | number | boolean>>({});

  // Draft = seeded values overlaid with local edits (no setState-in-effect:
  // the seed derives synchronously from the query data).
  const draft = useMemo(() => {
    const seeded: Record<string, string | number | boolean> = {};
    for (const setting of settings) {
      if (setting.value !== null) {
        seeded[setting.key] = setting.value as string | number | boolean;
      }
    }
    return { ...seeded, ...edits };
  }, [settings, edits]);

  const dirty = useMemo(() => {
    const changes: { key: string; value: string | number | boolean }[] = [];
    for (const [key, value] of Object.entries(draft)) {
      const original = settings.find((s) => s.key === key)?.value;
      if (original !== value) changes.push({ key, value });
    }
    return changes;
  }, [draft, settings]);

  const chain = auditChainQuery.data;

  const save = async () => {
    if (dirty.length === 0) return;
    await updateSettings.mutateAsync({ updates: dirty });
  };

  const renderControl = (setting: AdminSettingRow) => {
    const current = draft[setting.key];
    if (setting.type === "boolean") {
      return (
        <Switch
          checked={current === true}
          disabled={!canWrite}
          onCheckedChange={(checked) =>
            setEdits((prev) => ({ ...prev, [setting.key]: checked }))
          }
          aria-label={setting.label}
        />
      );
    }
    return (
      <Input
        value={String(current ?? "")}
        disabled={!canWrite}
        type={setting.type === "number" ? "number" : "text"}
        step="any"
        onChange={(e) => {
          const raw = e.target.value;
          setEdits((prev) => ({
            ...prev,
            [setting.key]: setting.type === "number" ? Number(raw) : raw,
          }));
        }}
        className="max-w-56"
        aria-label={setting.label}
      />
    );
  };

  const grouped = GROUPS.map((group) => ({
    ...group,
    settings: settings.filter((s) => groupOf(s.key) === group.prefix),
  })).filter((group) => group.settings.length > 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          canWrite ? (
            <Button size="sm" onClick={() => void save()} disabled={dirty.length === 0 || updateSettings.isPending}>
              {updateSettings.isPending ? (
                <LoaderCircle className="me-2 size-4 animate-spin" />
              ) : (
                <Save className="me-2 size-4" />
              )}
              {dirty.length > 0 ? t("saveWithCount", { count: dirty.length }) : t("save")}
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiCard label={t("kpi.settings")} value={String(settings.length)} icon={SlidersHorizontal} />
        <KpiCard
          label={t("kpi.auditChain")}
          value={chain ? (chain.valid ? t("chain.validValue") : t("chain.brokenValue")) : "—"}
          icon={chain?.valid ? CheckCircle2 : AlertTriangle}
        />
        <KpiCard
          label={t("kpi.chainEvents")}
          value={chain ? chain.checked.toLocaleString() : "—"}
          icon={Link2}
        />
      </div>

      {/* Audit hash chain integrity */}
      <SectionCard
        title={t("chain.title")}
        description={t("chain.description")}
        actions={
          <div className="flex gap-2">
            {canWrite && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void backfillChain.mutateAsync()}
                disabled={backfillChain.isPending}
              >
                {backfillChain.isPending ? (
                  <LoaderCircle className="me-1 size-3 animate-spin" />
                ) : (
                  <Database className="me-1 size-3" />
                )}
                {t("chain.runBackfill")}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => void auditChainQuery.refetch()} disabled={auditChainQuery.isFetching}>
              <ShieldCheck className="me-1 size-3" /> {t("chain.verify")}
            </Button>
          </div>
        }
      >
        <div className="p-4">
          {auditChainQuery.isLoading ? (
            <div className="h-12 animate-pulse rounded bg-muted" />
          ) : auditChainQuery.isError ? (
            <ErrorState
              title={t("chain.errorTitle")}
              reason={t("chain.errorReason")}
              onRetry={() => void auditChainQuery.refetch()}
            />
          ) : chain ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                {chain.valid ? (
                  <Badge className="bg-success/10 text-success">
                    <CheckCircle2 className="me-1 size-3" /> {t("chain.validBadge", { count: chain.checked })}
                  </Badge>
                ) : (
                  <Badge className="bg-danger-orange/10 text-danger-orange">
                    <AlertTriangle className="me-1 size-3" /> {t("chain.brokenBadge", { index: chain.brokenAt?.index ?? "—" })}
                  </Badge>
                )}
              </div>
              {!chain.valid && chain.brokenAt && (
                <p className="text-sm text-muted-foreground">
                  {t("chain.inconsistencyPrefix")}{" "}
                  <code className="font-mono text-xs">{chain.brokenAt.id}</code>
                  {t("chain.inconsistencyTail", { reason: chain.brokenAt.reason })}
                </p>
              )}
              {chain.window === "TAIL" && (
                <p className="text-xs text-muted-foreground">
                  {t("chain.tailWindow", { anchor: chain.anchoredAt ?? "—" })}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {t("chain.autoChainNote")}
              </p>
            </div>
          ) : null}
        </div>
      </SectionCard>

      {/* Tier retention pointer */}
      <SectionCard title={t("tiers.title")} description={t("tiers.description")}>
        <div className="flex items-center justify-between gap-4 p-4">
          <p className="text-sm text-muted-foreground">
            {t("tiers.editorNote")}{" "}
            <strong className="text-foreground">{t("tiers.overviewLink")}</strong>.
          </p>
          <Badge variant="secondary">{t("tiers.managedElsewhere")}</Badge>
        </div>
      </SectionCard>

      {/* Settings groups */}
      {settingsQuery.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : settingsQuery.isError ? (
        <ErrorState
          title={t("error.title")}
          reason={t("error.reason")}
          onRetry={() => void settingsQuery.refetch()}
        />
      ) : settings.length === 0 ? (
        <EmptyState
          icon={SlidersHorizontal}
          title={t("empty.title")}
          description={t("empty.description")}
        />
      ) : (
        grouped.map((group) => (
          <SectionCard
            key={group.prefix}
            title={t(`group.${group.prefix}.title`)}
            description={t(`group.${group.prefix}.description`)}
          >
            <div className="divide-y">
              {group.settings.map((setting) => (
                <div key={setting.key} className="flex flex-col gap-1.5 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-0.5">
                    <Label className="text-sm">{setting.label}</Label>
                    <code className="block font-mono text-xs text-muted-foreground">{setting.key}</code>
                  </div>
                  <div className="flex items-center gap-3">
                    {setting.updatedAt && (
                      <span className="text-xs text-muted-foreground">
                        {t("updated", { date: new Date(setting.updatedAt).toLocaleDateString() })}
                      </span>
                    )}
                    {renderControl(setting)}
                  </div>
                </div>
              ))}
            </div>
          </SectionCard>
        ))
      )}

      {/* Unsaved-changes guard toast */}
      {dirty.length > 0 && canWrite && (
        <div className="sticky bottom-4 flex items-center justify-between gap-3 rounded-lg border bg-background/95 p-3 shadow-sm backdrop-blur">
          <span className="text-sm">{t("unsavedChanges", { count: dirty.length })}</span>
          <Button size="sm" onClick={() => void save()} disabled={updateSettings.isPending}>
            <Save className="me-2 size-4" /> {t("saveNow")}
          </Button>
        </div>
      )}
    </div>
  );
}
