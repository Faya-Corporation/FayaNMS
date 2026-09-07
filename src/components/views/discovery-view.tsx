"use client";

import { useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { z } from "zod";
import {
  Crosshair,
  LoaderCircle,
  Radar,
  SearchX,
} from "lucide-react";

import { useMeta } from "@/hooks/api/use-meta";
import {
  useDiscoveryJobs,
  useImportCandidates,
  useStartScan,
} from "@/hooks/api/use-discovery";
import { useToast } from "@/hooks/use-toast";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { JobStatusBadge } from "@/components/domain/job-status-badge";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { StatusBadge } from "@/components/domain/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Progress } from "@/components/ui/progress";
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
import { Textarea } from "@/components/ui/textarea";
import type {
  DiscoveryCandidate,
  DiscoveryJobSummary,
} from "@/lib/api-client";
import type { StatusBadgeConfig } from "@/lib/domain/status";
import { cn } from "@/lib/utils";

/**
 * Discovery (Phase 2-c): queue simulated subnet scans on the worker, watch
 * the scan history progress live, and import selected candidates into the
 * device inventory. Candidates are persistence-free — they live in the
 * DISCOVERY job's resultJson until imported.
 */

const IPV4_OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const CIDR_PATTERN = new RegExp(
  `^${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\/(3[0-2]|[12]?\\d)$`
);

const scanFormSchema = z.object({
  subnets: z
    .array(z.string().trim().regex(CIDR_PATTERN, "Not a valid CIDR (a.b.c.d/prefix)"))
    .min(1, "At least one subnet is required")
    .max(8, "A scan is limited to 8 subnets"),
  name: z.string().trim().max(120).optional(),
});

/** "Imported" chip — neutral token family per the status.ts token classes. */
const IMPORTED_CHIP: StatusBadgeConfig = {
  key: "IMPORTED",
  label: "Imported",
  token: "neutral",
  icon: "Check",
  dotClass: "bg-neutral",
  badgeClass: "bg-neutral-subtle text-neutral border-neutral/25",
  iconClass: "text-neutral",
};

/** "New" chip for not-yet-imported candidates. */
const NEW_CHIP: StatusBadgeConfig = {
  key: "NEW",
  label: "New",
  token: "info",
  icon: "Sparkles",
  dotClass: "bg-info",
  badgeClass: "bg-info-subtle text-info border-info/25",
  iconClass: "text-info",
};

const CRITICALITIES: { value: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"; label: string }[] = [
  { value: "LOW", label: "Low" },
  { value: "MEDIUM", label: "Medium" },
  { value: "HIGH", label: "High" },
  { value: "CRITICAL", label: "Critical" },
];

function durationLabel(ms: number | null): string {
  if (ms === null || ms < 0) return "—";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function DiscoveryView() {
  const { toast } = useToast();
  const jobs = useDiscoveryJobs();
  const meta = useMeta();
  const startScan = useStartScan();
  const importCandidates = useImportCandidates();

  const [scanOpen, setScanOpen] = useState(false);
  const [scanName, setScanName] = useState("");
  const [subnetsText, setSubnetsText] = useState("");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedCandidates, setSelectedCandidates] = useState<Set<string>>(new Set());
  const [importOpen, setImportOpen] = useState(false);
  const [importSiteId, setImportSiteId] = useState("");
  const [importCredentialId, setImportCredentialId] = useState("");
  const [importCriticality, setImportCriticality] =
    useState<"LOW" | "MEDIUM" | "HIGH" | "CRITICAL">("MEDIUM");
  const [importManaged, setImportManaged] = useState(true);

  const rows = jobs.data ?? [];

  // Selected scan: the explicitly chosen job, else the newest scan that
  // already carries candidates (derived — no selection side-effects).
  const selectedJob = useMemo(() => {
    if (selectedJobId) {
      const explicit = rows.find((job) => job.id === selectedJobId);
      if (explicit) return explicit;
    }
    return (
      rows.find(
        (job) => job.status === "SUCCEEDED" && job.candidateCount > 0
      ) ?? null
    );
  }, [rows, selectedJobId]);

  /** History row click — switches the scan and clears candidate selection. */
  const handleSelectJob = (jobId: string) => {
    setSelectedJobId(jobId);
    setSelectedCandidates(new Set());
  };

  const importable = useMemo(
    () =>
      (selectedJob?.candidates ?? []).filter(
        (candidate) => !candidate.imported
      ),
    [selectedJob]
  );

  const pendingScan = startScan.isPending;
  const pendingImport = importCandidates.isPending;

  // New-scan dialog: parse the textarea one CIDR per line and validate.
  const scanIssues = useMemo(() => {
    const lines = subnetsText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return lines.filter((line) => !CIDR_PATTERN.test(line));
  }, [subnetsText]);

  const handleStartScan = () => {
    const lines = subnetsText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const parsed = scanFormSchema.safeParse({
      subnets: lines,
      name: scanName.trim() || undefined,
    });
    if (!parsed.success) {
      toast({
        title: "Check the scan settings",
        description: parsed.error.issues[0]?.message ?? "Invalid scan",
        variant: "destructive",
      });
      return;
    }
    startScan.mutate(parsed.data, {
      onSuccess: (result) => {
        setScanOpen(false);
        setScanName("");
        setSubnetsText("");
        setSelectedCandidates(new Set());
        setSelectedJobId(result.jobId);
      },
    });
  };

  const handleToggleCandidate = (ip: string, checked: boolean) => {
    setSelectedCandidates((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(ip);
      } else {
        next.delete(ip);
      }
      return next;
    });
  };

  const handleImport = () => {
    if (!selectedJob) return;
    importCandidates.mutate(
      {
        jobId: selectedJob.id,
        ips: Array.from(selectedCandidates),
        siteId: importSiteId || undefined,
        credentialProfileId: importCredentialId || undefined,
        criticality: importCriticality,
        managed: importManaged,
      },
      {
        onSuccess: (result) => {
          setImportOpen(false);
          setSelectedCandidates(new Set());
          if (result.skipped.length > 0) {
            toast({
              title: `${result.skipped.length} candidate${result.skipped.length === 1 ? "" : "s"} skipped`,
              description: result.skipped
                .slice(0, 3)
                .map((entry) => `${entry.ip}: ${entry.reason}`)
                .join(" · "),
            });
          }
        },
      }
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        description="Scan subnets for candidate devices and import them into the inventory"
        primaryAction={
          <Button onClick={() => setScanOpen(true)}>
            <Radar aria-hidden="true" />
            New Scan
          </Button>
        }
        title="Discovery"
      />

      {/* Scan history */}
      <SectionCard
        contentClassName="p-0"
        description="The worker sweeps each subnet and reports candidates — polling is live while a scan runs"
        title="Scan history"
      >
        {jobs.isError ? (
          <div className="p-4">
            <ErrorState
              onRetry={() => void jobs.refetch()}
              reason={jobs.error.message}
              title="Scan history could not be loaded"
            />
          </div>
        ) : jobs.isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="h-12 animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              description="Queue a scan against one or more subnets (one CIDR per line, e.g. 10.60.0.0/24) — discovered candidates appear here."
              icon={Radar}
              title="No discovery scans yet"
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table aria-label="Discovery scan history — sweep target, method, status, found devices and progress" className="min-w-[860px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Scan</TableHead>
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Status</TableHead>
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Subnets</TableHead>
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Candidates</TableHead>
                  <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) md:table-cell">
                    Duration
                  </TableHead>
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((job) => {
                  const running = job.status === "RUNNING" || job.status === "QUEUED";
                  return (
                    <TableRow
                      className={cn("cursor-pointer", job.id === selectedJob?.id && "bg-primary/5")}
                      data-state={job.id === selectedJob?.id ? "selected" : undefined}
                      key={job.id}
                      onClick={() => handleSelectJob(job.id)}
                    >
                      <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">
                            {job.name ?? "Ad-hoc scan"}
                          </span>
                          <span className="font-tech text-xs ltr-technical text-muted-foreground">
                            {job.correlationId}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                        <div className="flex flex-col gap-1.5">
                          <JobStatusBadge value={job.status} />
                          {running && (
                            <Progress
                              aria-label={`Scan ${job.correlationId} progress`}
                              className="h-1.5 w-28"
                              value={job.progress}
                            />
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                        <div className="flex flex-wrap gap-1">
                          {job.subnets.map((subnet) => (
                            <Badge
                              className="font-tech ltr-technical"
                              key={subnet}
                              variant="outline"
                            >
                              {subnet}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="h-(--density-row-h) px-(--density-cell-x) tabular-nums">
                        {job.status === "SUCCEEDED" ? (
                          <span>
                            {job.candidateCount}
                            {job.importedCount > 0 && (
                              <span className="text-muted-foreground">
                                {" "}
                                ({job.importedCount} imported)
                              </span>
                            )}
                          </span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="hidden h-(--density-row-h) px-(--density-cell-x) tabular-nums md:table-cell">
                        {durationLabel(job.durationMs)}
                      </TableCell>
                      <TableCell className="h-(--density-row-h) px-(--density-cell-x) text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(job.createdAt), { addSuffix: true })}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      {/* Candidates of the selected scan */}
      {selectedJob && (
        <SectionCard
          contentClassName="p-0"
          actions={
            <span className="font-tech text-xs ltr-technical text-muted-foreground">
              {selectedJob.correlationId}
            </span>
          }
          description={
            selectedJob.status === "SUCCEEDED"
              ? `${selectedJob.candidateCount} candidate${selectedJob.candidateCount === 1 ? "" : "s"} · ${selectedJob.subnets.join(", ")}`
              : "Candidates appear when the scan finishes"
          }
          title="Candidates"
        >
          {selectedJob.status !== "SUCCEEDED" ? (
            <div className="p-4">
              <EmptyState
                description={
                  selectedJob.error
                    ? `Last error: ${selectedJob.error}`
                    : "The scan is queued or running — the table fills in as soon as the worker reports."
                }
                icon={LoaderCircle}
                title="Scan not finished yet"
              />
            </div>
          ) : selectedJob.candidateCount === 0 ? (
            <div className="p-4">
              <EmptyState
                description="The scan finished without discovering candidates. Try a different subnet range."
                icon={SearchX}
                title="No candidates in this scan"
              />
            </div>
          ) : (
            <>
              {/* Bulk import bar */}
              {selectedCandidates.size > 0 && (
                <div
                  aria-live="polite"
                  className="flex flex-wrap items-center gap-2 border-b border-t bg-primary/5 px-4 py-2.5"
                >
                  <span className="text-sm font-medium">
                    {selectedCandidates.size} candidate
                    {selectedCandidates.size === 1 ? "" : "s"} selected
                  </span>
                  <Button disabled={pendingImport} onClick={() => setImportOpen(true)} size="sm">
                    <Crosshair aria-hidden="true" />
                    Import {selectedCandidates.size} candidate
                    {selectedCandidates.size === 1 ? "" : "s"}
                  </Button>
                  <Button
                    onClick={() => setSelectedCandidates(new Set())}
                    size="sm"
                    variant="ghost"
                  >
                    Clear
                  </Button>
                </div>
              )}

              <div className="overflow-x-auto">
                <Table aria-label="Importable device candidates — IP, hostname, vendor, confidence and import selection" className="min-w-[980px]">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="h-(--density-row-h) w-10 px-(--density-cell-x)">
                        <Checkbox
                          aria-label="Select all importable candidates"
                          checked={
                            importable.length > 0 &&
                            importable.every((candidate) =>
                              selectedCandidates.has(candidate.ip)
                            )
                              ? true
                              : selectedCandidates.size > 0
                                ? "indeterminate"
                                : false
                          }
                          disabled={importable.length === 0}
                          onCheckedChange={(checked) => {
                            setSelectedCandidates(
                              checked === true
                                ? new Set(importable.map((candidate) => candidate.ip))
                                : new Set()
                            );
                          }}
                        />
                      </TableHead>
                      <TableHead className="h-(--density-row-h) px-(--density-cell-x)">IP</TableHead>
                      <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Hostname</TableHead>
                      <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Vendor</TableHead>
                      <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) md:table-cell">Model</TableHead>
                      <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Confidence</TableHead>
                      <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) lg:table-cell">Ports / protocols</TableHead>
                      <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) xl:table-cell">OS fingerprint</TableHead>
                      <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Imported</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {selectedJob.candidates.map((candidate) => (
                      <CandidateRow
                        candidate={candidate}
                        key={candidate.ip}
                        onToggle={handleToggleCandidate}
                        selected={selectedCandidates.has(candidate.ip)}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </SectionCard>
      )}

      {/* New scan dialog */}
      <Dialog onOpenChange={setScanOpen} open={scanOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New discovery scan</DialogTitle>
            <DialogDescription>
              One subnet per line in CIDR notation. The simulation worker scans
              each subnet and reports candidate devices.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="scan-name">Name (optional)</Label>
              <Input
                id="scan-name"
                onChange={(event) => setScanName(event.target.value)}
                placeholder="Branch sweep — September"
                value={scanName}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="scan-subnets">Subnets *</Label>
              <Textarea
                aria-invalid={scanIssues.length > 0}
                className="font-tech ltr-technical"
                id="scan-subnets"
                onChange={(event) => setSubnetsText(event.target.value)}
                placeholder={"10.60.0.0/24\n10.70.0.0/24"}
                rows={4}
                value={subnetsText}
              />
              {scanIssues.length > 0 ? (
                <p className="text-xs text-danger">
                  Invalid subnets: {scanIssues.join(", ")} — expected a.b.c.d/prefix.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Up to 8 subnets per scan (e.g. 10.60.0.0/24).
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setScanOpen(false)} type="button" variant="outline">
              Cancel
            </Button>
            <Button
              disabled={pendingScan || scanIssues.length > 0}
              onClick={handleStartScan}
              type="button"
            >
              {pendingScan && <LoaderCircle aria-hidden="true" className="animate-spin" />}
              Queue scan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import dialog */}
      <Dialog onOpenChange={setImportOpen} open={importOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Import {selectedCandidates.size} candidate
              {selectedCandidates.size === 1 ? "" : "s"}
            </DialogTitle>
            <DialogDescription>
              Devices are created with status Unknown (or Unmanaged) until the
              first successful poll. The credential profile is recorded for the
              collector — secrets stay in the vault.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>Site</Label>
              <Select
                onValueChange={(value) =>
                  setImportSiteId(value === "NONE" ? "" : value)
                }
                value={importSiteId || "NONE"}
              >
                <SelectTrigger aria-label="Site">
                  <SelectValue placeholder="Unassigned" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">Unassigned</SelectItem>
                  {(meta.data?.sites ?? []).map((site) => (
                    <SelectItem key={site.id} value={site.id}>
                      {site.name} ({site.code})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Credential profile</Label>
              <Select
                onValueChange={(value) =>
                  setImportCredentialId(value === "NONE" ? "" : value)
                }
                value={importCredentialId || "NONE"}
              >
                <SelectTrigger aria-label="Credential profile">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">— none —</SelectItem>
                  {(meta.data?.credentialProfiles ?? []).map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {profile.name} · {profile.type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label>Default criticality</Label>
                <Select
                  onValueChange={(value) =>
                    setImportCriticality(value as typeof importCriticality)
                  }
                  value={importCriticality}
                >
                  <SelectTrigger aria-label="Default criticality">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CRITICALITIES.map((entry) => (
                      <SelectItem key={entry.value} value={entry.value}>
                        {entry.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2 pt-6">
                <Switch
                  aria-label="Manage imported devices"
                  checked={importManaged}
                  id="import-managed"
                  onCheckedChange={setImportManaged}
                />
                <Label htmlFor="import-managed">Managed</Label>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setImportOpen(false)} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={pendingImport} onClick={handleImport} type="button">
              {pendingImport && <LoaderCircle aria-hidden="true" className="animate-spin" />}
              Import devices
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CandidateRow({
  candidate,
  selected,
  onToggle,
}: {
  candidate: DiscoveryCandidate;
  selected: boolean;
  onToggle: (ip: string, checked: boolean) => void;
}) {
  const disabled = Boolean(candidate.imported);
  const confidence = candidate.confidence ?? 0;

  return (
    <TableRow data-state={selected ? "selected" : undefined}>
      <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
        <Checkbox
          aria-label={`Select candidate ${candidate.ip}`}
          aria-disabled={disabled}
          checked={candidate.imported ? true : selected}
          disabled={disabled}
          onCheckedChange={(checked) => onToggle(candidate.ip, checked === true)}
        />
      </TableCell>
      <TableCell className="h-(--density-row-h) px-(--density-cell-x) font-tech text-sm ltr-technical">
        {candidate.ip}
      </TableCell>
      <TableCell className="h-(--density-row-h) px-(--density-cell-x) font-tech text-sm ltr-technical">
        {candidate.hostname}
      </TableCell>
      <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
        <Badge variant="outline">{candidate.vendorGuess}</Badge>
      </TableCell>
      <TableCell className="hidden h-(--density-row-h) px-(--density-cell-x) text-sm md:table-cell">
        {candidate.modelGuess ?? "—"}
      </TableCell>
      <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
        <div className="flex items-center gap-2">
          <Progress aria-label={`Confidence ${confidence}%`} className="h-1.5 w-16" value={confidence} />
          <span className="text-xs tabular-nums text-muted-foreground">{confidence}%</span>
        </div>
      </TableCell>
      <TableCell className="hidden h-(--density-row-h) px-(--density-cell-x) text-xs text-muted-foreground lg:table-cell">
        <span className="font-tech ltr-technical">
          {candidate.mgmtPort ?? "?"} / {(candidate.protocols ?? []).join(" + ")}
        </span>
      </TableCell>
      <TableCell className="hidden h-(--density-row-h) max-w-[24ch] truncate px-(--density-cell-x) text-xs text-muted-foreground xl:table-cell" title={candidate.osFingerprint}>
        {candidate.osFingerprint ?? "—"}
      </TableCell>
      <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
        {candidate.imported ? (
          <StatusBadge config={IMPORTED_CHIP} />
        ) : (
          <StatusBadge config={NEW_CHIP} />
        )}
      </TableCell>
    </TableRow>
  );
}
