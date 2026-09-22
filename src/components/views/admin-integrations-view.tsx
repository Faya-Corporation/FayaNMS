"use client";

import { useState } from "react";
import { formatDistanceToNow, parseISO } from "date-fns";
import { Bell, Globe, Mail, Plus, Send, Trash2, Webhook } from "lucide-react";
import { useTranslations } from "next-intl";

import {
  useCreateNotificationChannel,
  useCreateWebhook,
  useDeleteNotificationChannel,
  useDeleteWebhook,
  useNotificationChannels,
  useTestNotificationChannel,
  useTestWebhook,
  useUpdateNotificationChannel,
  useUpdateWebhook,
  useWebhooks,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import type { NotificationChannelRow, WebhookRow } from "@/lib/api-client";
import { useCanWrite } from "@/stores/permissions";

/**
 * Administration → Integrations (Task 7-b).
 *
 * Signed webhooks + notification channels. Webhook secrets are masked
 * ("••••••••" + last 8) in every read; the plaintext is shown once at
 * creation. Test deliveries record their outcome on the row — an
 * unreachable receiver is a recorded result, never an error dialog.
 */

type TranslateFn = (key: string, values?: Record<string, string | number>) => string;

function deliveryBadge(
  row: { lastStatus: string | null; lastStatusCode: number | null },
  t: TranslateFn,
) {
  if (!row.lastStatus) {
    return <Badge variant="outline" className="text-muted-foreground">{t("delivery.neverDelivered")}</Badge>;
  }
  if (row.lastStatus === "DELIVERED") {
    return (
      <Badge className="bg-success/10 text-success">
        {t("delivery.delivered", { code: row.lastStatusCode ? ` · ${row.lastStatusCode}` : "" })}
      </Badge>
    );
  }
  return <Badge className="bg-danger-orange/10 text-danger-orange">{t("delivery.failed")}</Badge>;
}

export function AdminIntegrationsView() {
  const t = useTranslations("adminIntegrations");
  const canWrite = useCanWrite();

  const webhooksQuery = useWebhooks();
  const channelsQuery = useNotificationChannels();
  const createWebhookMut = useCreateWebhook();
  const updateWebhookMut = useUpdateWebhook();
  const deleteWebhookMut = useDeleteWebhook();
  const testWebhookMut = useTestWebhook();
  const createChannelMut = useCreateNotificationChannel();
  const updateChannelMut = useUpdateNotificationChannel();
  const deleteChannelMut = useDeleteNotificationChannel();
  const testChannelMut = useTestNotificationChannel();

  const webhooks = webhooksQuery.data?.webhooks ?? [];
  const eventCatalog = webhooksQuery.data?.events ?? [];
  const channels = channelsQuery.data?.channels ?? [];

  const [webhookOpen, setWebhookOpen] = useState(false);
  const [whName, setWhName] = useState("");
  const [whUrl, setWhUrl] = useState("");
  const [whEvents, setWhEvents] = useState<string[]>([]);
  const [secretReveal, setSecretReveal] = useState<{ name: string; secret: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WebhookRow | null>(null);

  const [channelOpen, setChannelOpen] = useState(false);
  const [chName, setChName] = useState("");
  const [chType, setChType] = useState("EMAIL");
  const [chAddress, setChAddress] = useState("");
  const [chUrl, setChUrl] = useState("");
  const [channelDeleteTarget, setChannelDeleteTarget] = useState<NotificationChannelRow | null>(null);

  const handleCreateWebhook = async () => {
    if (!whName.trim() || !whUrl.trim() || whEvents.length === 0) return;
    const result = await createWebhookMut.mutateAsync({
      name: whName.trim(),
      url: whUrl.trim(),
      events: whEvents,
    });
    setWebhookOpen(false);
    setWhName("");
    setWhUrl("");
    setWhEvents([]);
    setSecretReveal({ name: result.webhook.name, secret: result.secretOnce });
  };

  const handleCreateChannel = async () => {
    if (!chName.trim()) return;
    if (chType === "EMAIL" && !chAddress.trim()) return;
    if (chType === "WEBHOOK" && !chUrl.trim()) return;
    await createChannelMut.mutateAsync({
      name: chName.trim(),
      type: chType,
      config: chType === "EMAIL" ? { address: chAddress.trim() } : { url: chUrl.trim() },
    });
    setChannelOpen(false);
    setChName("");
    setChAddress("");
    setChUrl("");
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("page.title")}
        description={t("page.description")}
        actions={
          canWrite ? (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setChannelOpen(true)}>
                <Bell className="mr-2 size-4" /> {t("common.newChannel")}
              </Button>
              <Button size="sm" onClick={() => setWebhookOpen(true)}>
                <Webhook className="mr-2 size-4" /> {t("common.newWebhook")}
              </Button>
            </div>
          ) : undefined
        }
      />

      <SectionCard
        title={t("sections.webhooks.title")}
        description={t("sections.webhooks.description")}
      >
        {webhooksQuery.isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="h-10 animate-pulse rounded bg-muted" />
            ))}
          </div>
        ) : webhooksQuery.isError ? (
          <ErrorState title={t("sections.webhooks.error")} reason="Try again." onRetry={() => void webhooksQuery.refetch()} />
        ) : webhooks.length === 0 ? (
          <EmptyState
            icon={Webhook}
            title={t("sections.webhooks.emptyTitle")}
            description={t("sections.webhooks.emptyDescription")}
          />
        ) : (
          <Table aria-label={t("sections.webhooks.tableAria")}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("webhooks.columns.endpoint")}</TableHead>
                <TableHead>{t("webhooks.columns.events")}</TableHead>
                <TableHead>{t("webhooks.columns.secret")}</TableHead>
                <TableHead>{t("webhooks.columns.lastDelivery")}</TableHead>
                <TableHead>{t("webhooks.columns.active")}</TableHead>
                {canWrite && <TableHead className="text-right">{t("webhooks.columns.actions")}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {webhooks.map((webhook) => (
                <TableRow key={webhook.id}>
                  <TableCell>
                    <div className="font-medium">{webhook.name}</div>
                    <div className="max-w-56 truncate font-mono text-xs text-muted-foreground">
                      {webhook.url}
                    </div>
                    {webhook.lastError && (
                      <div className="mt-0.5 max-w-56 truncate text-xs text-danger-orange">
                        {webhook.lastError}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex max-w-44 flex-wrap gap-1">
                      {webhook.events.slice(0, 3).map((event) => (
                        <Badge key={event} variant="secondary" className="text-[10px]">
                          {event}
                        </Badge>
                      ))}
                      {webhook.events.length > 3 && (
                        <Badge variant="secondary" className="text-[10px]">
                          +{webhook.events.length - 3}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                      {webhook.secretMasked}
                    </code>
                  </TableCell>
                  <TableCell>
                    {deliveryBadge(webhook, t)}
                    {webhook.lastDeliveredAt && (
                      <div className="text-xs text-muted-foreground">
                        {formatDistanceToNow(parseISO(webhook.lastDeliveredAt), { addSuffix: true })}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={webhook.isActive}
                      disabled={!canWrite}
                      onCheckedChange={(checked) =>
                        void updateWebhookMut.mutateAsync({ id: webhook.id, isActive: checked })
                      }
                      aria-label={t("row.toggleAria", { name: webhook.name })}
                    />
                  </TableCell>
                  {canWrite && (
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void testWebhookMut.mutateAsync(webhook.id)}
                          disabled={testWebhookMut.isPending}
                        >
                          <Send className="mr-1 size-3" /> {t("common.test")}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-danger-orange hover:text-danger-orange"
                          onClick={() => setDeleteTarget(webhook)}
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      <SectionCard
        title={t("sections.channels.title")}
        description={t("sections.channels.description")}
      >
        {channelsQuery.isLoading ? (
          <div className="space-y-2 p-4">
            <div className="h-10 animate-pulse rounded bg-muted" />
          </div>
        ) : channelsQuery.isError ? (
          <ErrorState title={t("sections.channels.error")} reason="Try again." onRetry={() => void channelsQuery.refetch()} />
        ) : channels.length === 0 ? (
          <EmptyState
            icon={Bell}
            title={t("sections.channels.emptyTitle")}
            description={t("sections.channels.emptyDescription")}
          />
        ) : (
          <Table aria-label={t("sections.channels.tableAria")}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("channels.columns.channel")}</TableHead>
                <TableHead>{t("channels.columns.type")}</TableHead>
                <TableHead>{t("channels.columns.target")}</TableHead>
                <TableHead>{t("channels.columns.lastTest")}</TableHead>
                <TableHead>{t("channels.columns.active")}</TableHead>
                {canWrite && <TableHead className="text-right">{t("channels.columns.actions")}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {channels.map((channel) => (
                <TableRow key={channel.id}>
                  <TableCell className="font-medium">{channel.name}</TableCell>
                  <TableCell>
                    {channel.type === "EMAIL" ? (
                      <Badge className="bg-info/10 text-info">
                        <Mail className="mr-1 size-3" /> {t("channelDialog.email")}
                      </Badge>
                    ) : (
                      <Badge className="bg-warning/10 text-warning">
                        <Globe className="mr-1 size-3" /> {t("channelDialog.webhook")}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="max-w-48 truncate font-mono text-xs text-muted-foreground">
                    {String(channel.config.address ?? channel.config.url ?? "—")}
                  </TableCell>
                  <TableCell>
                    {channel.lastTestResult ? (
                      <span className="text-xs text-muted-foreground">{channel.lastTestResult}</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">{t("delivery.neverTested")}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={channel.isActive}
                      disabled={!canWrite}
                      onCheckedChange={(checked) =>
                        void updateChannelMut.mutateAsync({ id: channel.id, isActive: checked })
                      }
                      aria-label={t("row.toggleAria", { name: channel.name })}
                    />
                  </TableCell>
                  {canWrite && (
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void testChannelMut.mutateAsync(channel.id)}
                          disabled={testChannelMut.isPending}
                        >
                          <Send className="mr-1 size-3" /> {t("common.test")}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-danger-orange hover:text-danger-orange"
                          onClick={() => setChannelDeleteTarget(channel)}
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      {/* New webhook dialog */}
      <Dialog open={webhookOpen} onOpenChange={setWebhookOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("webhookDialog.title")}</DialogTitle>
            <DialogDescription>{t("webhookDialog.description")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="wh-name">{t("webhookDialog.nameLabel")}</Label>
              <Input id="wh-name" value={whName} onChange={(e) => setWhName(e.target.value)} placeholder={t("webhookDialog.namePlaceholder")} maxLength={80} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wh-url">{t("webhookDialog.endpointLabel")}</Label>
              <Input id="wh-url" value={whUrl} onChange={(e) => setWhUrl(e.target.value)} placeholder={t("webhookDialog.endpointPlaceholder")} />
            </div>
            <div className="space-y-2">
              <Label>{t("webhookDialog.eventsLabel", { count: whEvents.length })}</Label>
              <div className="grid max-h-40 grid-cols-2 gap-1.5 overflow-y-auto rounded-md border p-2">
                {eventCatalog.map((event) => {
                  const checked = whEvents.includes(event);
                  return (
                    <label
                      key={event}
                      className={`flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-xs ${checked ? "bg-primary/10 text-primary-ink" : "hover:bg-muted"}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setWhEvents((prev) =>
                            checked ? prev.filter((e) => e !== event) : [...prev, event]
                          )
                        }
                        className="size-3.5"
                      />
                      <span className="font-mono">{event}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWebhookOpen(false)}>{t("common.cancel")}</Button>
            <Button
              onClick={() => void handleCreateWebhook()}
              disabled={!whName.trim() || !whUrl.trim() || whEvents.length === 0 || createWebhookMut.isPending}
            >
              {createWebhookMut.isPending ? t("common.creating") : t("common.createWebhook")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Secret reveal */}
      <Dialog open={Boolean(secretReveal)} onOpenChange={(open) => !open && setSecretReveal(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("secretDialog.title", { name: secretReveal?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("secretDialog.description")}</DialogDescription>
          </DialogHeader>
          <code className="break-all rounded bg-muted p-2 font-mono text-xs">{secretReveal?.secret}</code>
          <DialogFooter>
            <Button onClick={() => setSecretReveal(null)}>{t("common.done")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Webhook delete confirm */}
      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("deleteWebhook.title")}</DialogTitle>
            <DialogDescription>{t("deleteWebhook.description", { name: deleteTarget?.name ?? "" })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>{t("common.cancel")}</Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (deleteTarget) await deleteWebhookMut.mutateAsync(deleteTarget.id);
                setDeleteTarget(null);
              }}
              disabled={deleteWebhookMut.isPending}
            >
              {deleteWebhookMut.isPending ? t("common.deleting") : t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New channel dialog */}
      <Dialog open={channelOpen} onOpenChange={setChannelOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("channelDialog.title")}</DialogTitle>
            <DialogDescription>{t("channelDialog.description")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="ch-name">{t("channelDialog.nameLabel")}</Label>
              <Input id="ch-name" value={chName} onChange={(e) => setChName(e.target.value)} placeholder={t("channelDialog.namePlaceholder")} maxLength={80} />
            </div>
            <div className="space-y-2">
              <Label>{t("channelDialog.typeLabel")}</Label>
              <Select value={chType} onValueChange={setChType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="EMAIL">{t("channelDialog.email")}</SelectItem>
                  <SelectItem value="WEBHOOK">{t("channelDialog.webhook")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {chType === "EMAIL" ? (
              <div className="space-y-2">
                <Label htmlFor="ch-address">{t("channelDialog.recipientLabel")}</Label>
                <Input id="ch-address" type="email" value={chAddress} onChange={(e) => setChAddress(e.target.value)} placeholder={t("channelDialog.recipientPlaceholder")} />
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="ch-url">{t("channelDialog.webhookUrlLabel")}</Label>
                <Input id="ch-url" value={chUrl} onChange={(e) => setChUrl(e.target.value)} placeholder={t("channelDialog.webhookUrlPlaceholder")} />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setChannelOpen(false)}>{t("common.cancel")}</Button>
            <Button
              onClick={() => void handleCreateChannel()}
              disabled={
                !chName.trim() ||
                (chType === "EMAIL" ? !chAddress.trim() : !chUrl.trim()) ||
                createChannelMut.isPending
              }
            >
              {createChannelMut.isPending ? t("common.creating") : t("common.createChannel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Channel delete confirm */}
      <Dialog open={Boolean(channelDeleteTarget)} onOpenChange={(open) => !open && setChannelDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("deleteChannel.title")}</DialogTitle>
            <DialogDescription>{t("deleteChannel.description", { name: channelDeleteTarget?.name ?? "" })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setChannelDeleteTarget(null)}>{t("common.cancel")}</Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (channelDeleteTarget) await deleteChannelMut.mutateAsync(channelDeleteTarget.id);
                setChannelDeleteTarget(null);
              }}
              disabled={deleteChannelMut.isPending}
            >
              {deleteChannelMut.isPending ? t("common.deleting") : t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
