/**
 * R50.6 — UI/UX hardening (R50-T060..T063): the PURE decision layer behind
 * the Add/Edit device sheet's detection panel. No React, no form, no DOM —
 * the audit suite pins every branch here, and the sheet renders what these
 * functions decide.
 *
 *  - T060  the two stages are rendered as two EXPLICIT rows, each with its
 *          own state (buildVendorStageRow / buildAddressStageRow).
 *  - T061  partial success: each row is built from its OWN stage block, so
 *          "vendor matched + DNS failed" shows one green row and one red
 *          row — useful results are never discarded because the other
 *          stage failed.
 *  - T062  decideApply implements the apply contract: an EMPTY field is
 *          auto-filled (safe), an unchanged field is a no-op, and a field
 *          the operator already filled is NEVER silently overwritten —
 *          the candidate is staged for an explicit Use / Keep-mine pick.
 *  - T063  buildHostKeyPanel surfaces first contact (target, dialed
 *          address, key type + fingerprint) BEFORE any enrollment.
 *  - T064  rows know whether they are retryable; the sheet re-issues the
 *          mutation with the matching `stages` filter.
 */

/* ───────────────── T062 — apply / stage / keep decisions ───────────────── */

export type DetectableField = "vendorId" | "model" | "mgmtIp";

export interface ApplyCandidate {
  field: DetectableField;
  /** The value detection produced (for vendorId: the vendor SELECT id). */
  value: string;
  /** Human-readable label of the detected value (vendor name / model / IP). */
  label: string;
}

export type ApplyDecision =
  | { action: "apply"; field: DetectableField; value: string }
  | { action: "noop"; field: DetectableField }
  | {
      action: "stage";
      field: DetectableField;
      value: string;
      label: string;
    };

/**
 * T062 — the ONLY path a detection result may take into the form:
 *   empty field      → apply directly (filling a blank cannot destroy work),
 *   already equal    → no-op (nothing to do, nothing to ask),
 *   anything else    → stage for an explicit pick — silent overwrite is
 *                      structurally impossible through this function.
 */
export function decideApply(
  current: string | undefined | null,
  candidate: ApplyCandidate,
): ApplyDecision {
  const trimmedCurrent = (current ?? "").trim();
  const trimmedValue = candidate.value.trim();
  if (!trimmedCurrent) {
    return { action: "apply", field: candidate.field, value: trimmedValue };
  }
  if (trimmedCurrent === trimmedValue) {
    return { action: "noop", field: candidate.field };
  }
  return {
    action: "stage",
    field: candidate.field,
    value: trimmedValue,
    label: candidate.label,
  };
}

/* ───────────── T060/T061/T064 — the two explicit stage rows ─────────────── */

export type StageRowState =
  | "idle"
  | "running"
  | "matched"
  | "generic"
  | "failed"
  | "refused"
  | "resolved"
  | "skipped-credential"
  | "skipped-not-requested";

export interface StageRow {
  stage: "vendor" | "address";
  state: StageRowState;
  /** One-line headline (the ✓/✗ line the roadmap's T060 sketch shows). */
  headline: string;
  /** Typed-code / diagnostic detail line, when there is one. */
  detail: string | null;
  /** The stable registry code behind a failure/refusal, when present. */
  code: string | null;
  /** T064 — a failed/refused stage offers a stage-specific retry. */
  retryable: boolean;
}

/** Structural input — satisfied by the wire block; keeps this module DOM-
 *  and hook-free so the audit suite pins it directly. */
export interface VendorStageBlockInput {
  status: string;
  outcome: string;
  code: string | null;
  message: string | null;
  detection: {
    vendorKey: string;
    confidence: string;
    model: string | null;
    osVersion: string | null;
    matchReasons?: string[];
    softMatches?: string[];
  } | null;
  latencyMs: number | null;
}

export interface AddressStageBlockInput {
  status: string;
  code: string | null;
  message: string | null;
  mgmtIp: string | null;
  mode: string;
}

function vendorRow(
  state: StageRowState,
  headline: string,
  code: string | null,
  detail: string | null,
): StageRow {
  return {
    stage: "vendor",
    state,
    headline,
    detail,
    code,
    // T064: only genuine per-stage failures offer a retry. Skips are not
    // failures (retrying cannot help — pick a credential / re-run both);
    // matched/generic are successes.
    retryable: state === "failed" || state === "refused",
  };
}

export function buildVendorStageRow(
  block: VendorStageBlockInput | null,
  running: boolean,
): StageRow {
  if (running) {
    return vendorRow("running", "Detecting vendor…", null, null);
  }
  if (!block) return vendorRow("idle", "Vendor detection not run yet", null, null);
  if (block.status === "skipped-not-requested") {
    return vendorRow(
      "skipped-not-requested",
      "Vendor detection not requested this run",
      null,
      null,
    );
  }
  if (block.status === "skipped-no-credential") {
    return vendorRow(
      "skipped-credential",
      "Skipped — no credential profile selected",
      null,
      "Select an SSH_PASSWORD credential profile to fingerprint the vendor",
    );
  }
  if (block.outcome === "matched" && block.detection) {
    const d = block.detection;
    const parts = [
      d.model ?? null,
      d.osVersion ? `OS ${d.osVersion}` : null,
      block.latencyMs !== null ? `${block.latencyMs} ms` : null,
    ].filter(Boolean) as string[];
    return vendorRow(
      "matched",
      `Vendor identified — ${d.vendorKey}`,
      null,
      parts.length > 0 ? parts.join(" · ") : null,
    );
  }
  if (block.outcome === "generic") {
    const near = block.detection?.softMatches?.length
      ? `Unconfirmed vendor tokens: ${block.detection.softMatches.join(", ")}`
      : null;
    return vendorRow("generic", "No certified vendor signature matched", block.code, near);
  }
  // failed / not-attempted-with-error — the typed code leads, the raw
  // message stays the diagnostic (T060's ✗ line).
  return vendorRow(
    "failed",
    "Vendor detection failed",
    block.code,
    block.message ?? null,
  );
}

export function buildAddressStageRow(
  block: AddressStageBlockInput | null,
  running: boolean,
): StageRow {
  if (running) {
    return {
      stage: "address",
      state: "running",
      headline: "Resolving management address…",
      detail: null,
      code: null,
      retryable: false,
    };
  }
  if (!block) {
    return {
      stage: "address",
      state: "idle",
      headline: "Address resolution not run yet",
      detail: null,
      code: null,
      retryable: false,
    };
  }
  if (block.status === "skipped-not-requested") {
    return {
      stage: "address",
      state: "skipped-not-requested",
      headline: "Address resolution not requested this run",
      detail: null,
      code: null,
      retryable: false,
    };
  }
  if (block.status === "resolved" && block.mgmtIp) {
    return {
      stage: "address",
      state: "resolved",
      headline: `Management address — ${block.mgmtIp}`,
      detail: block.mode === "dns-a" ? "Resolved via DNS (A record)" : "Used the entered address",
      code: null,
      retryable: false,
    };
  }
  const state: StageRowState = block.status === "refused" ? "refused" : "failed";
  return {
    stage: "address",
    state,
    headline:
      state === "refused"
        ? "Address refused by the inventory policy"
        : "Address resolution failed",
    detail: block.message ?? null,
    code: block.code,
    retryable: true,
  };
}

/* ──────────────────── T063 — host-key first-contact panel ─────────────────── */

export interface HostKeyPanelData {
  /** The trust path the probe took (drives the panel's tone). */
  state: "not-probed" | "pinned" | "capture-requested";
  captured: { keyType: string; fingerprint: string } | null;
  /** The operator-typed target (what trust is anchored to — R50-T012). */
  target: string | null;
  /** The address the worker actually dialed. */
  dialed: string | null;
}

/**
 * T063 — before ANY enrollment decision the operator must see, in one
 * place: the target they typed, the address that was dialed, and the
 * presented key's type + fingerprint. Null when the last run did not
 * probe (no credential / not requested) — an absent panel must never be
 * readable as "host key verified".
 */
export function buildHostKeyPanel(
  block:
    | (VendorStageBlockInput & {
        hostKeyState?: string;
        hostKeyCaptured?: { keyType: string; fingerprint: string } | null;
      })
    | null,
  requestedHost: string | null,
  dialedAddress: string | null,
): HostKeyPanelData | null {
  if (!block) return null;
  if (block.status === "skipped-not-requested" || block.status === "skipped-no-credential") {
    return null;
  }
  const state =
    block.hostKeyState === "pinned" || block.hostKeyState === "capture-requested"
      ? block.hostKeyState
      : "not-probed";
  return {
    state,
    captured: block.hostKeyCaptured ?? null,
    // R50-T012 (ADR-host-key-trust-identity): the target shown is the
    // operator-typed endpoint — the trust identity — never a DNS product.
    target: requestedHost,
    dialed: dialedAddress,
  };
}
