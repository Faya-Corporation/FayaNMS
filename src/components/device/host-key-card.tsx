"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Fingerprint, KeyRound, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import { useToast } from "@/hooks/use-toast";
import { SectionCard } from "@/components/domain/section-card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/**
 * SAFE-001 (audit P0-001) — SSH host-key enrollment card for LIVE_SSH
 * devices.
 *
 * Shows the pinned host key for the device's SSH endpoint (known_hosts
 * model), or the fail-closed warning when unenrolled (the worker refuses
 * ALL live connections without a pin). Enrollment is a two-step, audited
 * flow: probe (capture the presented key) → operator confirms (out-of-band
 * fingerprint verification is the intended discipline) → pin stored; the
 * transport then enforces it BEFORE authentication on every connection.
 */

interface HostKeyEnrollmentDto {
  id: string;
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  enrolledAt: string;
  enrolledBy: string;
  lastVerifiedAt: string | null;
}

interface ProbeResultDto {
  keyType: string;
  fingerprint: string;
  host: string;
  port: number;
  message: string;
}

interface EnrollResultDto {
  id: string;
  fingerprint: string;
  message: string;
}

interface RevokeResultDto {
  revoked: boolean;
  message: string;
}

export function HostKeyCard({ deviceId }: { deviceId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [probed, setProbed] = useState<ProbeResultDto | null>(null);
  const [revokeOpen, setRevokeOpen] = useState(false);

  const enrollment = useQuery({
    queryKey: ["device", deviceId, "host-key"],
    queryFn: async () => {
      try {
        return await apiFetch<HostKeyEnrollmentDto | null>(
          `/api/v1/devices/${deviceId}/host-key`
        );
      } catch {
        return null; // no endpoint coordinates (e.g. no credential linked)
      }
    },
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["device", deviceId, "host-key"] });

  const probe = useMutation({
    mutationFn: async () =>
      apiFetch<ProbeResultDto>(`/api/v1/devices/${deviceId}/host-key`, {
        method: "POST",
        body: JSON.stringify({ action: "probe" }),
      }),
    onSuccess: (result) => setProbed(result),
    onError: (error: Error) => {
      toast({
        title: "Host-key probe failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const enroll = useMutation({
    mutationFn: async (captured: ProbeResultDto) =>
      apiFetch<EnrollResultDto>(`/api/v1/devices/${deviceId}/host-key`, {
        method: "PUT",
        body: JSON.stringify({
          fingerprint: captured.fingerprint,
          keyType: captured.keyType,
        }),
      }),
    onSuccess: (result) => {
      setProbed(null);
      void invalidate();
      toast({ title: "Host key pinned", description: result.message });
    },
    onError: (error: Error) => {
      toast({
        title: "Enrollment failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const revoke = useMutation({
    mutationFn: async () =>
      apiFetch<RevokeResultDto>(`/api/v1/devices/${deviceId}/host-key`, {
        method: "DELETE",
      }),
    onSuccess: (result) => {
      setRevokeOpen(false);
      void invalidate();
      toast({ title: "Host key enrollment revoked", description: result.message });
    },
    onError: (error: Error) => {
      toast({
        title: "Revoke failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const row = enrollment.data ?? null;

  return (
    <SectionCard
      contentClassName="p-0"
      description="Pinned SSH host key for this device's endpoint (fail-closed enforcement)"
      title="SSH Host Key"
      actions={
        row ? (
          <Button
            disabled={probe.isPending}
            onClick={() => probe.mutate()}
            size="sm"
            variant="ghost"
          >
            <RefreshCw aria-hidden="true" className={probe.isPending ? "animate-spin" : undefined} />
            Re-enroll
          </Button>
        ) : (
          <Button
            disabled={probe.isPending}
            onClick={() => probe.mutate()}
            size="sm"
            variant="outline"
          >
            <KeyRound aria-hidden="true" />
            {probe.isPending ? "Probing…" : "Enroll host key"}
          </Button>
        )
      }
    >
      {row ? (
        <div className="flex flex-col gap-2 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-success">
            <ShieldCheck aria-hidden="true" className="size-4" />
            Host key pinned — enforced before authentication
          </div>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">Endpoint</dt>
              <dd className="font-mono text-xs">
                {row.host}:{row.port}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Key type</dt>
              <dd className="font-mono text-xs">{row.keyType}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs text-muted-foreground">Fingerprint (SHA256)</dt>
              <dd className="break-all font-mono text-xs">{row.fingerprint}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Enrolled</dt>
              <dd className="text-xs">
                {formatDistanceToNow(new Date(row.enrolledAt), { addSuffix: true })} by{" "}
                {row.enrolledBy}
              </dd>
            </div>
          </dl>
          <div className="flex justify-end">
            <Button
              onClick={() => setRevokeOpen(true)}
              size="sm"
              variant="ghost"
              className="text-danger hover:text-danger"
            >
              Revoke
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-warning">
            <ShieldAlert aria-hidden="true" className="size-4" />
            No pinned host key — live connections are REFUSED (fail-closed)
          </div>
          <p className="text-sm text-muted-foreground">
            Enroll the device&apos;s SSH host key to pin this endpoint. The worker verifies
            the pinned key during the SSH handshake, before credentials are sent — a
            mismatched key aborts the connection. Verify the fingerprint out-of-band
            (device console) before confirming.
          </p>
          {probe.isError && (
            <p className="text-xs text-danger" role="alert">
              {(probe.error as Error).message}
            </p>
          )}
        </div>
      )}

      {/* Confirm-the-captured-fingerprint dialog */}
      <AlertDialog
        onOpenChange={(open) => {
          if (!open) setProbed(null);
        }}
        open={probed !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Fingerprint aria-hidden="true" className="size-5" />
              Pin this host key?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-3">
                <span>
                  The device presented this key for{" "}
                  <span className="font-mono">
                    {probed?.host}:{probed?.port}
                  </span>
                  . Verify it out-of-band (device console / trusted channel) — pinning the
                  wrong key would lock the platform to an impostor.
                </span>
                <span className="rounded-lg border bg-muted/40 p-3 text-left">
                  <span className="mb-1 block text-xs text-muted-foreground">
                    Key type: <span className="font-mono">{probed?.keyType}</span>
                  </span>
                  <span className="break-all font-mono text-xs">{probed?.fingerprint}</span>
                </span>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!probed || enroll.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (probed) enroll.mutate(probed);
              }}
            >
              {enroll.isPending ? "Pinning…" : "Pin this key"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Revoke confirmation */}
      <AlertDialog onOpenChange={setRevokeOpen} open={revokeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke the pinned host key?</AlertDialogTitle>
            <AlertDialogDescription>
              Every live connection to this endpoint will be REFUSED (fail-closed) until a
              key is enrolled again. Backups, validation and controlled changes on this
              device will fail closed while unenrolled.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-danger text-danger-foreground hover:bg-danger/90"
              disabled={revoke.isPending}
              onClick={(event) => {
                event.preventDefault();
                revoke.mutate();
              }}
            >
              {revoke.isPending ? "Revoking…" : "Revoke enrollment"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}
