"use client";

import { useMemo, useRef, useState } from "react";
import { Import, LoaderCircle, Paperclip } from "lucide-react";
import { z } from "zod";

import { useToast } from "@/hooks/use-toast";
import { useCsvImportDevices } from "@/hooks/api/use-devices";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import type { CsvImportRowPayload } from "@/lib/api-client";

/**
 * Import CSV (Phase 2-c): client-side CSV parsing — zero new dependencies.
 *
 * Expected header (one device per line, plain comma split):
 *   hostname,vendor,model,mgmtIp,siteCode,criticality,tags
 * - vendor: vendor key or display name (cisco / Cisco Systems)
 * - tags: `|`-separated inside the tags cell (core|bgp)
 * - criticality: LOW | MEDIUM | HIGH | CRITICAL (defaults to MEDIUM)
 * Rows are parsed and previewed here; the server re-validates each row and
 * reports per-row skips. A header row is detected and skipped automatically.
 */

const IPV4_PATTERN =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const CRITICALITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

const csvRowSchema = z.object({
  hostname: z
    .string()
    .trim()
    .min(1, "hostname is required")
    .max(63)
    .regex(HOSTNAME_PATTERN, "hostname may contain letters, digits and hyphens"),
  vendor: z.string().trim().min(1, "vendor is required"),
  model: z.string().trim().max(120).optional(),
  mgmtIp: z.string().trim().regex(IPV4_PATTERN, "mgmtIp must be a valid IPv4 address"),
  siteCode: z.string().trim().max(40).optional(),
  criticality: z.enum(CRITICALITIES).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
});

interface ParsedRow {
  row: CsvImportRowPayload;
  error: string | null;
}

const CSV_TEMPLATE_HEADER =
  "hostname,vendor,model,mgmtIp,siteCode,criticality,tags\n" +
  "BR3-Edge-RTR-01,cisco,ISR4331,10.60.255.1,BR1-HOD,MEDIUM,branch|sdwan\n" +
  "BR3-FW-01,fortinet,FortiGate 90G,10.60.255.2,BR1-HOD,HIGH,firewall";

function parseCsv(text: string): ParsedRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const parsed: ParsedRow[] = [];
  for (const line of lines) {
    // Skip a header row when pasted with the data.
    if (/^hostname\s*,/i.test(line) && parsed.length === 0) continue;
    const cells = line.split(",").map((cell) => cell.trim());
    const [hostname = "", vendor = "", model = "", mgmtIp = "", siteCode = "", criticality = "", tagsCell = ""] = cells;

    const criticalityNormalized =
      criticality.length > 0 ? criticality.toUpperCase() : undefined;
    const tags = tagsCell
      .split("|")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);

    const candidate = {
      hostname,
      vendor,
      model: model || undefined,
      mgmtIp,
      siteCode: siteCode || undefined,
      criticality:
        criticalityNormalized && CRITICALITIES.includes(criticalityNormalized as (typeof CRITICALITIES)[number])
          ? (criticalityNormalized as (typeof CRITICALITIES)[number])
          : undefined,
      tags: tags.length > 0 ? tags : undefined,
    };

    const result = csvRowSchema.safeParse(candidate);
    if (!result.success) {
      const issue = result.error.issues[0];
      const field = issue?.path?.length > 0 ? `${issue.path.join(".")}: ` : "";
      parsed.push({
        row: { ...candidate, criticality: candidate.criticality ?? "MEDIUM" },
        error: `${field}${issue?.message ?? "invalid row"}`,
      });
      continue;
    }
    parsed.push({
      row: {
        ...result.data,
        criticality: result.data.criticality ?? "MEDIUM",
      },
      error: null,
    });
  }
  return parsed;
}

interface CsvImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CsvImportDialog({ open, onOpenChange }: CsvImportDialogProps) {
  const { toast } = useToast();
  const csvImport = useCsvImportDevices();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [csvText, setCsvText] = useState("");

  const parsedRows = useMemo(() => parseCsv(csvText), [csvText]);
  const invalidCount = parsedRows.filter((entry) => entry.error !== null).length;

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setCsvText((current) => (current.trim() ? `${current}\n${text}` : text));
  };

  const handleDownloadTemplate = () => {
    const blob = new Blob([CSV_TEMPLATE_HEADER], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "fayanms-device-import-template.csv";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const handleImport = () => {
    const rows = parsedRows
      .filter((entry) => entry.error === null)
      .map((entry) => entry.row);
    if (rows.length === 0) {
      toast({
        title: "Nothing to import",
        description: "Fix the highlighted rows or paste valid CSV content first.",
        variant: "destructive",
      });
      return;
    }
    csvImport.mutate(
      { rows },
      {
        onSuccess: () => {
          setCsvText("");
          onOpenChange(false);
        },
      }
    );
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import devices from CSV</DialogTitle>
          <DialogDescription>
            Expected header:{" "}
            <span className="font-tech ltr-technical">
              hostname,vendor,model,mgmtIp,siteCode,criticality,tags
            </span>{" "}
            — vendor accepts the key or the display name, tags are separated by{" "}
            <span className="font-tech">|</span> inside the cell.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => fileInputRef.current?.click()}
              size="sm"
              type="button"
              variant="outline"
            >
              <Paperclip aria-hidden="true" />
              Choose file…
            </Button>
            <input
              accept=".csv,text/csv,text/plain"
              aria-label="CSV file"
              className="hidden"
              onChange={(event) => {
                void handleFile(event.target.files?.[0]);
                event.target.value = "";
              }}
              ref={fileInputRef}
              type="file"
            />
            <button
              className="text-xs text-brand-accent underline-offset-2 hover:underline"
              onClick={handleDownloadTemplate}
              type="button"
            >
              Download template
            </button>
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              className="text-xs font-medium text-muted-foreground"
              htmlFor="csv-paste"
            >
              …or paste CSV content
            </label>
            <Textarea
              className="font-tech ltr-technical min-h-28"
              id="csv-paste"
              onChange={(event) => setCsvText(event.target.value)}
              placeholder={CSV_TEMPLATE_HEADER}
              rows={5}
              value={csvText}
            />
          </div>

          {parsedRows.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">
                {parsedRows.length} row{parsedRows.length === 1 ? "" : "s"} parsed
                {invalidCount > 0 ? ` · ${invalidCount} with issues (they will be skipped)` : ""}
                {parsedRows.length > 10 ? " · showing the first 10" : ""}
              </p>
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Hostname</TableHead>
                      <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Vendor</TableHead>
                      <TableHead className="h-(--density-row-h) px-(--density-cell-x)">mgmtIp</TableHead>
                      <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Site</TableHead>
                      <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Crit.</TableHead>
                      <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Issue</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {parsedRows.slice(0, 10).map((entry, index) => (
                      <TableRow key={`${entry.row.hostname}-${index}`}>
                        <TableCell className="h-(--density-row-h) px-(--density-cell-x) font-tech text-xs ltr-technical">
                          {entry.row.hostname || "—"}
                        </TableCell>
                        <TableCell className="h-(--density-row-h) px-(--density-cell-x) text-xs">
                          {entry.row.vendor || "—"}
                        </TableCell>
                        <TableCell className="h-(--density-row-h) px-(--density-cell-x) font-tech text-xs ltr-technical">
                          {entry.row.mgmtIp || "—"}
                        </TableCell>
                        <TableCell className="h-(--density-row-h) px-(--density-cell-x) font-tech text-xs ltr-technical">
                          {entry.row.siteCode ?? "—"}
                        </TableCell>
                        <TableCell className="h-(--density-row-h) px-(--density-cell-x) text-xs">
                          {entry.row.criticality ?? "MEDIUM"}
                        </TableCell>
                        <TableCell className="h-(--density-row-h) px-(--density-cell-x) text-xs">
                          {entry.error ? (
                            <span className="text-danger">{entry.error}</span>
                          ) : (
                            <span className="text-success">OK</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={csvImport.isPending || parsedRows.length === 0}
            onClick={handleImport}
            type="button"
          >
            {csvImport.isPending ? (
              <LoaderCircle aria-hidden="true" className="animate-spin" />
            ) : (
              <Import aria-hidden="true" />
            )}
            Import {parsedRows.filter((entry) => entry.error === null).length} row
            {parsedRows.filter((entry) => entry.error === null).length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
