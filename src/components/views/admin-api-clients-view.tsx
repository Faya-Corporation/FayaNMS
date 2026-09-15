"use client";

import { useState } from "react";
import { formatDistanceToNow, parseISO } from "date-fns";
import { Copy, KeyRound, Lock, Plus, RefreshCcw, ShieldCheck } from "lucide-react";

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
      toast({ title: "Token copied to clipboard" });
    } catch {
      toast({ title: "Copy failed — select the token manually", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="API Clients"
        description="Scoped bearer tokens for integrations — hashed server-side, shown once"
        actions={
          canWrite ? (
            <Button onClick={() => setCreateOpen(true)} size="sm">
              <Plus className="mr-2 size-4" /> New client
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiCard label="Registered clients" value={String(clients.length)} icon={KeyRound} />
        <KpiCard label="Active" value={String(activeCount)} icon={ShieldCheck} />
        <KpiCard label="Scopes in use" value={String(scopesInUse)} icon={Lock} />
      </div>

      <SectionCard title="Clients" description="Tokens are stored as sha256 hashes — the prefix identifies each client">
        {clientsQuery.isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-10 animate-pulse rounded bg-muted" />
            ))}
          </div>
        ) : clientsQuery.isError ? (
          <ErrorState
            title="Could not load API clients"
            reason="The admin surface answered with an error — try again."
            onRetry={() => void clientsQuery.refetch()}
          />
        ) : clients.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title="No API clients yet"
            description="Create a scoped token to let integrations read or write FayaNMS data."
          />
        ) : (
          <Table aria-label="API clients — name, prefix, scopes and last rotation per client (tokens stored hashed)">
            <TableHeader>
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead>Token</TableHead>
                <TableHead>Scopes</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Active</TableHead>
                {canWrite && <TableHead className="text-right">Actions</TableHead>}
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
                  <TableCell className="text-muted-foreground">
                    {client.lastUsedAt
                      ? formatDistanceToNow(parseISO(client.lastUsedAt), { addSuffix: true })
                      : "never"}
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
                      aria-label={`Toggle ${client.name}`}
                    />
                  </TableCell>
                  {canWrite && (
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setRotateTarget(client)}
                        disabled={!client.isActive}
                      >
                        <RefreshCcw className="mr-1 size-3" /> Rotate
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
            <DialogTitle>New API client</DialogTitle>
            <DialogDescription>
              The bearer token is generated server-side and shown exactly once after creation.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="client-name">Client name</Label>
              <Input
                id="client-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="grafana-dashboard"
                maxLength={80}
              />
            </div>
            <div className="space-y-2">
              <Label>Scopes ({selectedScopes.length} selected)</Label>
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
              Cancel
            </Button>
            <Button
              onClick={() => void handleCreate()}
              disabled={!name.trim() || selectedScopes.length === 0 || createClient.isPending}
            >
              {createClient.isPending ? "Creating…" : "Create client"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Token reveal dialog (create + rotate) */}
      <Dialog open={Boolean(reveal)} onOpenChange={(open) => !open && setReveal(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Token for “{reveal?.name}”</DialogTitle>
            <DialogDescription>
              Copy it now — this is the only time the full token is shown. Only its sha256
              hash is stored server-side.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
            <div className="flex items-start gap-2">
              <Lock className="mt-0.5 size-4 shrink-0 text-warning" />
              <p className="text-warning-foreground">
                Shown once. Treat it like a password — rotate immediately if leaked.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-muted p-2 font-mono text-xs">
              {reveal?.token}
            </code>
            <Button variant="outline" size="icon" onClick={() => reveal && void copyToken(reveal.token)} aria-label="Copy token">
              <Copy className="size-4" />
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setReveal(null)}>Done — I saved it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rotate confirm dialog */}
      <Dialog open={Boolean(rotateTarget)} onOpenChange={(open) => !open && setRotateTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rotate token?</DialogTitle>
            <DialogDescription>
              “{rotateTarget?.name}” gets a brand-new token. The previous token stops working
              immediately — update the integration before rotating.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRotateTarget(null)}>
              Cancel
            </Button>
            <Button onClick={() => void handleRotate()} disabled={rotateClient.isPending}>
              {rotateClient.isPending ? "Rotating…" : "Rotate token"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
