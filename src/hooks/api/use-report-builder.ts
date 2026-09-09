"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api-client";
import type {
  ReportFormatKey,
  ReportFrequencyKey,
  ReportTypeKey,
} from "@/hooks/api/use-reports";

/**
 * Report Builder (Task 18-c) — client hooks for the on-demand generation
 * path POST /api/v1/reports/run (user-facing, audited REPORT_BUILT) and
 * the save-as-schedule flow.
 *
 * NOTE ON REUSE: the schedules POST already has a clean hook —
 * useCreateReportSchedule in @/hooks/api/use-reports (audited
 * REPORT_SCHEDULE_CREATED, invalidates reports/jobs/events). The builder
 * view imports it directly instead of duplicating the mutation here; only
 * the new /reports/run mutation lives in this file.
 *
 * Toasts are intentionally NOT baked into these hooks (Phase 8 convention):
 * the view owns localized success/error notifications via next-intl.
 *
 * The artifact types below MIRROR ReportArtifact in
 * src/lib/reports/generate.ts — that module imports the db client, so it
 * must never be imported from client code. Keep the two shapes in sync.
 */

/* ───────────────────────────── types ───────────────────────────── */

export interface ReportBuilderRunPayload {
  reportType: ReportTypeKey;
  frequency: ReportFrequencyKey;
  format: ReportFormatKey;
}

export interface ReportBuilderArtifactColumn {
  key: string;
  label: string;
}

export interface ReportBuilderArtifactRow {
  [key: string]: string | number | null;
}

/** Mirrors ReportArtifact in src/lib/reports/generate.ts (client copy). */
export interface ReportBuilderArtifact {
  reportType: string;
  generatedAt: string;
  range: string;
  format: string;
  columns: ReportBuilderArtifactColumn[];
  rows: ReportBuilderArtifactRow[];
}

export interface ReportBuilderRunResult {
  artifact: ReportBuilderArtifact;
  correlationId: string;
}

/* ──────────────────────────── mutations ──────────────────────────── */

/**
 * On-demand report generation (audited REPORT_BUILT, correlation RB-XXXXXX).
 * Read-only over live data — no job, no schedule write. The Event Stream
 * invalidation lets the fresh audit row surface immediately.
 */
export function useRunReportBuilder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: ReportBuilderRunPayload) =>
      apiFetch<ReportBuilderRunResult>("/api/v1/reports/run", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      // The run writes one REPORT_BUILT audit row — keep the stream live.
      void queryClient.invalidateQueries({ queryKey: ["events"] });
    },
  });
}
