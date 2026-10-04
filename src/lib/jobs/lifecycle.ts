/**
 * Single source of truth for the JobExecution lifecycle status sets shared
 * by the API surface and the UI.
 *
 * Wave-6 (audit 6-a P3-4): POST /api/v1/jobs/[id]/retry had NO status
 * guard — any job (including a QUEUED/RUNNING one) was cloneable via the
 * API while the job center's retry button only ever showed for terminal
 * failures, so the API could bypass the SAFE-003 single-flight lease for
 * CHANGE_EXECUTE jobs (two live executions of one change). Both planes now
 * import THIS set — they cannot drift apart again.
 */

/** The only statuses a job may be retried from: terminal failures. */
export const RETRYABLE_JOB_STATUSES: ReadonlySet<string> = new Set(["FAILED", "DEAD"]);

/** The statuses a job may be cancelled from: not yet terminal. */
export const CANCELLABLE_JOB_STATUSES: ReadonlySet<string> = new Set(["QUEUED", "RUNNING"]);
