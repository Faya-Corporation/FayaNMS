"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { useMetaUsers } from "@/hooks/api/use-meta";
import { useAssignAlert, useSuppressAlert } from "@/hooks/api/use-alert-mutations";
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
import type { AlertStreamRow } from "@/lib/api-client";

/**
 * Assign + suppress dialogs for the alert stream (Task 5-a). Kept in one
 * small file — both are single-purpose and stateless across opens.
 */

export function AssignAlertDialog({
  alert,
  onClose,
}: {
  alert: AlertStreamRow | null;
  onClose: () => void;
}) {
  const t = useTranslations("alerts.dialogs");
  const meta = useMetaUsers();
  const assign = useAssignAlert();
  const [userId, setUserId] = useState("");
  // Render-time reset (react-hooks/set-state-in-effect): clear the picker
  // whenever the dialog is (re)opened for a different alert.
  const [lastAlertId, setLastAlertId] = useState<string | null>(null);
  const alertId = alert?.id ?? null;
  if (alertId !== lastAlertId) {
    setLastAlertId(alertId);
    setUserId("");
  }

  const users = meta.data?.users ?? [];

  return (
    <Dialog open={alert !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("assignTitle")}</DialogTitle>
          <DialogDescription>
            {alert ? `${alert.device.hostname} — ${alert.message}` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="assign-user">{t("assignTo")}</Label>
          <Select value={userId} onValueChange={setUserId}>
            <SelectTrigger id="assign-user" aria-label={t("assigneeAria")}>
              <SelectValue placeholder={t("selectUser")} />
            </SelectTrigger>
            <SelectContent>
              {users.map((user) => (
                <SelectItem key={user.id} value={user.id}>
                  {user.name} · {user.roleLabel}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            disabled={!userId || assign.isPending}
            onClick={() => {
              if (!alert || !userId) return;
              assign.mutate(
                { id: alert.id, assignedToId: userId },
                { onSettled: () => onClose() }
              );
            }}
          >
            {t("assign")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SuppressAlertDialog({
  alert,
  onClose,
}: {
  alert: AlertStreamRow | null;
  onClose: () => void;
}) {
  const t = useTranslations("alerts.dialogs");
  const suppress = useSuppressAlert();
  const [reason, setReason] = useState("");
  // Render-time reset (react-hooks/set-state-in-effect): clear the reason
  // whenever the dialog is (re)opened for a different alert.
  const [lastAlertId, setLastAlertId] = useState<string | null>(null);
  const alertId = alert?.id ?? null;
  if (alertId !== lastAlertId) {
    setLastAlertId(alertId);
    setReason("");
  }

  return (
    <Dialog open={alert !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("suppressTitle")}</DialogTitle>
          <DialogDescription>
            {alert ? `${alert.device.hostname} — ${alert.message}` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="suppress-reason">{t("reasonLabel")}</Label>
          <Input
            id="suppress-reason"
            value={reason}
            maxLength={240}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t("reasonPlaceholder")}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            disabled={suppress.isPending}
            onClick={() => {
              if (!alert) return;
              suppress.mutate(
                { id: alert.id, reason: reason.trim() || undefined },
                { onSettled: () => onClose() }
              );
            }}
          >
            {t("suppress")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
