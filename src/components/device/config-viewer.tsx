"use client";

import { useMemo, useState, type ReactNode } from "react";
import { format } from "date-fns";
import {
  Check,
  Copy,
  EyeOff,
  FileCode2,
  Maximize2,
  Search,
  WrapText,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  maskSecretLine,
  normalizeConfig,
} from "@/lib/config/normalize";

/**
 * Read-only configuration viewer (Phase 2, extended in Phase 3-b): mono
 * rendering with line numbers, in-file search, wrap toggle, secrets masking,
 * an on-demand NORMALIZED rendering (vendor-aware normalization library,
 * same module the diff API uses) and a fullscreen dialog. Masking replaces
 * anything following a secret keyword with the shared constant placeholder —
 * deliberate over-masking per the F-12 requirement.
 */

/** Mask everything after a secret keyword on the line (shared rule list). */
function maskLine(line: string): string {
  return maskSecretLine(line);
}

function highlight(text: string, query: string): ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  while (cursor <= text.length) {
    const index = lower.indexOf(needle, cursor);
    if (index === -1) {
      parts.push(text.slice(cursor));
      break;
    }
    if (index > cursor) parts.push(text.slice(cursor, index));
    parts.push(
      <mark
        className="rounded-xs bg-warning/35 text-foreground"
        key={`match-${key}`}
      >
        {text.slice(index, index + needle.length)}
      </mark>
    );
    key += 1;
    cursor = index + needle.length;
  }
  return parts;
}

function CodeBlock({
  lines,
  query,
  wrap,
  maxHeightClass,
}: {
  lines: string[];
  query: string;
  wrap: boolean;
  maxHeightClass: string;
}) {
  return (
    <div
      className={cn(
        "overflow-auto rounded-lg border bg-surface-subtle font-tech leading-relaxed",
        maxHeightClass
      )}
    >
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((line, index) => (
            <tr key={index}>
              <td
                aria-hidden="true"
                className="sticky start-0 w-10 select-none border-e bg-surface-subtle pe-2 text-end align-top text-muted-foreground/70"
              >
                {index + 1}
              </td>
              <td
                className={cn(
                  "ps-2 align-top text-foreground",
                  wrap
                    ? "whitespace-pre-wrap break-all"
                    : "whitespace-pre"
                )}
              >
                {highlight(line, query)}
                {line.length === 0 ? " " : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface ConfigViewerSnapshot {
  id: string;
  version: number;
  source: string;
  configType: string;
  status: string;
  sha256: string;
  sizeBytes: number;
  rawText: string;
  createdAt: string;
  hostname?: string;
}

export function ConfigViewer({
  snapshot,
  vendorKey = "generic",
}: {
  snapshot: ConfigViewerSnapshot;
  /** Device vendor key — selects the normalization flavor (default generic). */
  vendorKey?: string;
}) {
  const [mask, setMask] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [normalized, setNormalized] = useState(false);
  const [query, setQuery] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);

  const displayLines = useMemo(() => {
    const lines = (normalized
      ? normalizeConfig(snapshot.rawText, vendorKey)
      : snapshot.rawText
    ).split("\n");
    return mask ? lines.map(maskLine) : lines;
  }, [snapshot.rawText, vendorKey, normalized, mask]);

  const matchCount = useMemo(() => {
    if (!query) return 0;
    const needle = query.toLowerCase();
    return displayLines.filter((line) => line.toLowerCase().includes(needle))
      .length;
  }, [displayLines, query]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(displayLines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard unavailable (permissions/insecure context) — ignore.
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* Meta + controls */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="font-tech text-sm font-medium ltr-technical">
            {snapshot.hostname ? `${snapshot.hostname} ` : ""}v{snapshot.version} ·{" "}
            {snapshot.configType}
          </p>
          <p className="text-xs text-muted-foreground tabular-nums">
            {format(new Date(snapshot.createdAt), "MMM d, yyyy HH:mm")} ·{" "}
            {(snapshot.sizeBytes / 1024).toFixed(1)} KB ·{" "}
            <span className="font-tech ltr-technical">
              sha256:{snapshot.sha256.slice(0, 12)}…
            </span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-40">
            <Search
              aria-hidden="true"
              className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label="Search in config"
              className="h-8 pl-7"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search in file"
              value={query}
            />
          </div>
          {query && (
            <span className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
              {matchCount} match{matchCount === 1 ? "" : "es"}
            </span>
          )}
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Switch
              aria-label="Show normalized config"
              checked={normalized}
              onCheckedChange={setNormalized}
            />
            <FileCode2 aria-hidden="true" className="size-3.5" />
            Normalize
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Switch checked={mask} onCheckedChange={setMask} aria-label="Mask secrets" />
            <EyeOff aria-hidden="true" className="size-3.5" />
            Mask
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Switch checked={wrap} onCheckedChange={setWrap} aria-label="Wrap long lines" />
            <WrapText aria-hidden="true" className="size-3.5" />
            Wrap
          </label>
          <Button
            aria-label="Copy configuration"
            onClick={() => void handleCopy()}
            size="icon"
            variant="ghost"
          >
            {copied ? (
              <Check aria-hidden="true" className="text-success" />
            ) : (
              <Copy aria-hidden="true" />
            )}
          </Button>
          <Button
            aria-label="Open fullscreen viewer"
            onClick={() => setFullscreen(true)}
            size="icon"
            variant="ghost"
          >
            <Maximize2 aria-hidden="true" />
          </Button>
        </div>
      </div>

      <CodeBlock
        lines={displayLines}
        maxHeightClass="max-h-[440px]"
        query={query}
        wrap={wrap}
      />

      <p className="text-xs text-muted-foreground">
        Use Compare in the version list to diff this version against another.
        Secrets are masked in diffs and exports.
      </p>

      {/* Fullscreen dialog */}
      <Dialog onOpenChange={setFullscreen} open={fullscreen}>
        <DialogContent className="flex max-h-[90vh] flex-col gap-3 sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle className="font-tech ltr-technical">
              {snapshot.hostname ? `${snapshot.hostname} ` : ""}v{snapshot.version}{" "}
              · {snapshot.configType}
            </DialogTitle>
            <DialogDescription className="tabular-nums">
              {(snapshot.sizeBytes / 1024).toFixed(1)} KB ·{" "}
              <span className="font-tech ltr-technical">
                sha256:{snapshot.sha256.slice(0, 16)}…
              </span>
              {normalized ? " · normalized" : ""}
              {mask ? " · secrets masked" : ""}
            </DialogDescription>
          </DialogHeader>
          <CodeBlock
            lines={displayLines}
            maxHeightClass="max-h-[65vh]"
            query={query}
            wrap={wrap}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
