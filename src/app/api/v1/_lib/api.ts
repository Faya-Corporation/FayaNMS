import { NextResponse } from "next/server";
import { z } from "zod";

/**
 * Shared helpers for /api/v1 route handlers.
 *
 * Every endpoint answers with the standard JSON envelope:
 *   success: { success: true, data: T, meta?: {...} }
 *   error:   { success: false, error: { code, message } }
 *
 * List endpoints use server-side pagination and return
 * meta: { page, pageSize, total, totalPages }.
 */

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function ok<T>(
  data: T,
  meta?: object,
  status = 200
): NextResponse {
  return NextResponse.json(
    meta ? { success: true, data, meta } : { success: true, data },
    { status }
  );
}

export function fail(
  code: string,
  message: string,
  status = 400
): NextResponse {
  return NextResponse.json(
    { success: false, error: { code, message } },
    { status }
  );
}

export function pageMeta(
  page: number,
  pageSize: number,
  total: number
): PageMeta {
  return {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** Shared pagination query params (pageSize hard-capped at 100). */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * Parse a comma-separated multi-value query param ("ACTIVE,ACKNOWLEDGED")
 * into a trimmed, non-empty string array. Returns undefined when absent/empty.
 */
export function csvParam(
  value: string | null | undefined
): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts : undefined;
}

/** Human-readable message from the first Zod issue. */
export function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid request";
  const path = issue.path.length > 0 ? issue.path.join(".") : "query";
  return `${path}: ${issue.message}`;
}

/** JOB-XXXXXX correlation id (6 random uppercase alphanumerics). */
export function newJobCorrelationId(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let suffix = "";
  for (let i = 0; i < 6; i += 1) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `JOB-${suffix}`;
}
