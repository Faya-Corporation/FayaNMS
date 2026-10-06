"use client";

import { useState } from "react";
import { formatDistanceToNow, parseISO } from "date-fns";
import { Copy, KeyRound, Lock, Plus, RefreshCcw, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";

import { useToast } from "@/hooks/use-toast";
import {
  useApiClients,
  useCreateApiClient,
  useRotateApiClient,
  useUpdateApiClient,
} from "@/hooks/api/use-admin";
import { Badge } from "@/components/ui/badge";
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { KpiCard } from "@/components/domain/kpi-card";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import type { AdminApiClientRow } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useCanWrite } from "@/stores/permissions";

/**
 * Administration → API Clients (Task 7-b).
 *
 * Scoped bearer tokens for integrations. The plaintext token exists only
 * at creation/rotation — this view is the one chance to copy it; the API
 * stores a sha256 hash and returns only the prefix afterwards.
 */

export function AdminApiClientsView() {
  const t = useTranslations("adminApiClients");
  const canWrite = useCanWrite();
  const { toast } = useToast();

  const clientsQuery = useApiClients();
  const createClient = useCreateApiClient();
  const updateClient = useUpdateApiClient();
  const rotateClient = useRotateApiClient();

  const clients = clientsQuery.data?.clients ?? [];
  const scopeCatalog = clientsQuery.data?.scopes ?? [];

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [reveal, setReveal] = useState<{ name: string; token: string } | null>(null);
  const [rotateTarget, setRotateTarget] = useState<AdminApiClientRow | null>(null);

  const activeCount = clients.filter((c) => c.isActive).length;
  const scopesInUse = new Set(clients.flatMap((c) => c.scopes)).size;

  const handleCreate = async () => {
    if (!name.trim() || selectedScopes.length === 0) return;
    try {
      const result = await createClient.mutateAsync({
        name: name.trim(),
        scopes: selectedScopes,
      });
      setCreateOpen(false);
      setName("");
      setSelectedScopes([]);
      setReveal({ name: result.client.name, token: result.token });
    } catch {
      // toast handled by the mutation
    }
  };

  const handleRotate = async () => {
    if (!rotateTarget) return;
    const result = await rotateClient.mutateAsync(rotateTarget.id);
    setRotateTarget(null);
    setReveal({ name: result.client.name, token: result.token });
  };

  const copyToken = async (token: string) => {
    try {
      await navigator.clipboard.writeText(token);
      toast({ title: t("toast.copied") });
    } catch {
      toast({ title: t("toast.copyFailed"), variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("page.title")}
        description={t("page.description")}
        actions={
          canWrite ? (
            <Button onClick={() => setCreateOpen(true)} size="sm">
              <Plus className="me-2 size-4" /> {t("actions.newClient")}
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiCard label={t("kpi.registered")} value={String(clients.length)} icon={KeyRound} />
        <KpiCard label={t("kpi.active")} value={String(activeCount)} icon={ShieldCheck} />
        <KpiCard label={t("kpi.scopesInUse")} value={String(scopesInUse)} icon={Lock} />
      </div>

      <SectionCard title={t("card.title")} description={t("card.description")}>
        {clientsQuery.isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-10 animate-pulse rounded bg-muted" />
            ))}
          </div>
        ) : clientsQuery.isError ? (
          <ErrorState
            title={t("error.title")}
            reason={t("error.reason")}
            onRetry={() => void clientsQuery.refetch()}
          />
        ) : clients.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title={t("empty.title")}
            description={t("empty.description")}
          />
        ) : (
          <Table aria-label={t("table.aria")}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("table.client")}</TableHead>
                <TableHead>{t("table.token")}</TableHead>
                <TableHead>{t("table.scopes")}</TableHead>
                <TableHead>{t("table.siteScope")}</TableHead>
                <TableHead>{t("table.expiry")}</TableHead>
                <TableHead>{t("table.lastUsed")}</TableHead>
                <TableHead>{t("table.created")}</TableHead>
                <TableHead>{t("table.active")}</TableHead>
                {canWrite && <TableHead className="text-end">{t("table.actions")}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {clients.map((client) => (
                <TableRow key={client.id}>
                  <TableCell className="font-medium">{client.name}</TableCell>
                  <TableCell>
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                      {client.tokenPrefix}…
                    </code>
                  </TableCell>
                  <TableCell>
                    <div className="flex max-w-56 flex-wrap gap-1">
                      {client.scopes.map((scope) => (
                        <Badge key={scope} variant="secondary" className="font-mono text-[10px]">
                          {scope}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    {client.siteCodes === null ? (
                      <Badge variant="outline" className="text-[10px]">
                        {t("row.globalScope")}
                      </Badge>
                    ) : client.siteCodes.length === 0 ? (
                      <Badge variant="destructive" className="text-[10px]">
                        {t("row.denyAll")}
                      </Badge>
                    ) : (
                      <div className="flex max-w-40 flex-wrap gap-1">
                        {client.siteCodes.map((code) => (
                          <Badge key={code} variant="outline" className="font-mono text-[10px]">
                            {code}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {client.expiresAt === null ? (
                      <span aria-label={t("row.noExpiry")}>—</span>
                    ) : (
                      <ExpiryBadge expiresAt={client.expiresAt} warnLabel={t("row.expiringSoon")} expiredLabel={t("row.expired")} />
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {client.lastUsedAt
                      ? formatDistanceToNow(parseISO(client.lastUsedAt), { addSuffix: true })
                      : t("row.never")}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDistanceToNow(parseISO(client.createdAt), { addSuffix: true })}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={client.isActive}
                      disabled={!canWrite}
                      onCheckedChange={(checked) =>
                        void updateClient.mutateAsync({ id: client.id, isActive: checked })
                      }
                      aria-label={t("row.toggle", { name: client.name })}
                    />
                  </TableCell>
                  {canWrite && (
                    <TableCell className="text-end">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setRotateTarget(client)}
                        disabled={!client.isActive}
                      >
                        <RefreshCcw className="me-1 size-3" /> {t("actions.rotate")}
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("dialog.create.title")}</DialogTitle>
            <DialogDescription>
              {t("dialog.create.description")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="client-name">{t("dialog.create.nameLabel")}</Label>
              <Input
                id="client-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("dialog.create.namePlaceholder")}
                maxLength={80}
              />
            </div>
            <div className="space-y-2">
              <Label>
                {t("dialog.create.scopesLabel")} {t("dialog.create.scopesSelected", { count: selectedScopes.length })}
              </Label>
              <div className="grid max-h-44 grid-cols-2 gap-1.5 overflow-y-auto rounded-md border p-2 sm:grid-cols-3">
                {scopeCatalog.map((scope) => {
                  const checked = selectedScopes.includes(scope);
                  return (
                    <label
                      key={scope}
                      className={cn(
                        "flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-xs",
                        checked ? "bg-primary/10 text-primary-ink" : "hover:bg-muted"
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setSelectedScopes((prev) =>
                            checked ? prev.filter((s) => s !== scope) : [...prev, scope]
                          )
                        }
                        className="size-3.5"
                      />
                      <span className="font-mono">{scope}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t("dialog.create.cancel")}
            </Button>
            <Button
              onClick={() => void handleCreate()}
              disabled={!name.trim() || selectedScopes.length === 0 || createClient.isPending}
            >
              {createClient.isPending ? t("dialog.create.submitting") : t("dialog.create.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Token reveal dialog (create + rotate) */}
      <Dialog open={Boolean(reveal)} onOpenChange={(open) => !open && setReveal(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("dialog.reveal.title", { name: reveal?.name ?? "" })}</DialogTitle>
            <DialogDescription>
              {t("dialog.reveal.description")}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
            <div className="flex items-start gap-2">
              <Lock className="mt-0.5 size-4 shrink-0 text-warning" />
              <p className="text-warning-foreground">
                {t("dialog.reveal.security")}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-muted p-2 font-mono text-xs">
              {reveal?.token}
            </code>
            <Button
              variant="outline"
              size="icon"
              onClick={() => reveal && void copyToken(reveal.token)}
              aria-label={t("actions.copyToken")}
            >
              <Copy className="size-4" />
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setReveal(null)}>{t("dialog.reveal.done")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rotate confirm dialog */}
      <Dialog open={Boolean(rotateTarget)} onOpenChange={(open) => !open && setRotateTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("dialog.rotate.title")}</DialogTitle>
            <DialogDescription>
              {t("dialog.rotate.description", { name: rotateTarget?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRotateTarget(null)}>
              {t("dialog.rotate.cancel")}
            </Button>
            <Button onClick={() => void handleRotate()} disabled={rotateClient.isPending}>
              {rotateClient.isPending ? t("dialog.rotate.submitting") : t("dialog.rotate.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * GA-3 (P1-A04) — expiry display with the audit's "expiration warning UI":
 * a LIVE token expiring within 7 days renders an amber warning badge; an
 * expired token renders a destructive badge. Null expiry (legacy row) shows
 * a plain dash.
 */
function ExpiryBadge({
  expiresAt,
  warnLabel,
  expiredLabel,
}: {
  expiresAt: string;
  warnLabel: string;
  expiredLabel: string;
}) {
  const ms = parseISO(expiresAt).getTime() - Date.now();
  if (ms <= 0) {
    return (
      <Badge variant="destructive" className="text-[10px]">
        {expiredLabel}
      </Badge>
    );
  }
  const soon = ms <= 7 * 86_400_000;
  return (
    <div className="flex items-center gap-1.5">
      <span>{formatDistanceToNow(parseISO(expiresAt), { addSuffix: true })}</span>
      {soon && (
        <Badge variant="outline" className="border-amber-500/50 text-[10px] text-amber-600 dark:text-amber-400">
          {warnLabel}
        </Badge>
      )}
    </div>
  );
}
