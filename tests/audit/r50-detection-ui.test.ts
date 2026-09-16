import { describe, expect, test } from "bun:test";

/**
 * R50.6 — UI/UX hardening (R50-T060..T064) audit pins.
 *
 * The sheet's detection panel is driven ENTIRELY by the pure layer in
 * src/lib/devices/detection-ui.ts (+ resolveRequestedStages in the
 * detection contract). Every branch an operator can see is pinned here:
 * the two explicit stage rows (T060), partial success as independent rows
 * (T061), the apply/stage/keep contract that makes silent overwrite
 * structurally impossible (T062), the first-contact host-key disclosure
 * (T063), retryable-row semantics + the stage-selection normalizer behind
 * stage-specific retry (T064).
 */

import {
  buildAddressStageRow,
  buildHostKeyPanel,
  buildVendorStageRow,
  decideApply,
  type AddressStageBlockInput,
  type VendorStageBlockInput,
} from "@/lib/devices/detection-ui";
import {
  DETECTION_STAGES,
  resolveRequestedStages,
} from "@/lib/net/detection-contract";

/* ───────────────── T062 — decideApply (the only apply path) ───────────── */

describe("R50-T062 decideApply — explicit replace/keep semantics", () => {
  test("empty field → apply (filling a blank cannot destroy work)", () => {
    const decision = decideApply("", {
      field: "mgmtIp",
      value: "10.20.1.10",
      label: "management IP",
    });
    expect(decision).toEqual({ action: "apply", field: "mgmtIp", value: "10.20.1.10" });
  });

  test("whitespace-only field counts as empty", () => {
    const decision = decideApply("   ", {
      field: "model",
      value: "WS-C2960X-24TS-L",
      label: "model",
    });
    expect(decision.action).toBe("apply");
  });

  test("field already equal to the candidate → noop (no question asked)", () => {
    const decision = decideApply(" 10.20.1.10 ", {
      field: "mgmtIp",
      value: "10.20.1.10",
      label: "management IP",
    });
    expect(decision).toEqual({ action: "noop", field: "mgmtIp" });
  });

  test("operator-typed value differing from detection → STAGE, never overwrite", () => {
    const decision = decideApply("10.99.99.99", {
      field: "mgmtIp",
      value: "10.20.1.10",
      label: "management IP",
    });
    expect(decision).toEqual({
      action: "stage",
      field: "mgmtIp",
      value: "10.20.1.10",
      label: "management IP",
    });
  });

  test("null current value behaves like empty", () => {
    const decision = decideApply(null, {
      field: "vendorId",
      value: "v-1",
      label: "Cisco Systems",
    });
    expect(decision).toEqual({ action: "apply", field: "vendorId", value: "v-1" });
  });

  test("values are trimmed in the staged candidate", () => {
    const decision = decideApply("10.99.99.99", {
      field: "mgmtIp",
      value: " 10.20.1.10 ",
      label: "management IP",
    });
    expect(decision.action === "stage" && decision.value).toBe("10.20.1.10");
  });
});

/* ───────────── T060/T061 — the two explicit stage rows ────────────────── */

const matchedVendor: VendorStageBlockInput = {
  status: "executed",
  outcome: "matched",
  code: null,
  message: null,
  detection: {
    vendorKey: "cisco",
    confidence: "high",
    model: "WS-C2960X-24TS-L",
    osVersion: "15.2(4)E7",
    matchReasons: ["cisco.ios-banner"],
  },
  latencyMs: 812,
};

const failedVendor: VendorStageBlockInput = {
  status: "executed",
  outcome: "failed",
  code: "SSH_CONNECT_TIMEOUT",
  message: "The endpoint did not answer in time",
  detection: null,
  latencyMs: null,
};

describe("R50-T060/T061 buildVendorStageRow — the explicit vendor row", () => {
  test("running state renders the in-progress line", () => {
    const row = buildVendorStageRow(matchedVendor, true);
    expect(row.state).toBe("running");
    expect(row.headline).toBe("Detecting vendor…");
    expect(row.retryable).toBe(false);
  });

  test("no result yet → idle row (panel skeleton before first run)", () => {
    const row = buildVendorStageRow(null, false);
    expect(row.state).toBe("idle");
    expect(row.retryable).toBe(false);
  });

  test("matched → vendor named + model/OS/latency detail; NOT retryable", () => {
    const row = buildVendorStageRow(matchedVendor, false);
    expect(row.state).toBe("matched");
    expect(row.headline).toContain("cisco");
    expect(row.detail).toContain("WS-C2960X-24TS-L");
    expect(row.detail).toContain("15.2(4)E7");
    expect(row.detail).toContain("812 ms");
    expect(row.retryable).toBe(false);
  });

  test("generic → warning row; R50-T054 near-misses stay visible in the detail", () => {
    const row = buildVendorStageRow(
      {
        ...matchedVendor,
        outcome: "generic",
        detection: {
          vendorKey: "generic",
          confidence: "low",
          model: null,
          osVersion: null,
          softMatches: ["cisco.vendor-name"],
        },
      },
      false,
    );
    expect(row.state).toBe("generic");
    expect(row.detail).toContain("cisco.vendor-name");
    expect(row.retryable).toBe(false);
  });

  test("failed → the typed code is surfaced and the row is RETRYABLE (T064)", () => {
    const row = buildVendorStageRow(failedVendor, false);
    expect(row.state).toBe("failed");
    expect(row.code).toBe("SSH_CONNECT_TIMEOUT");
    expect(row.retryable).toBe(true);
  });

  test("T064 — skipped-not-requested is a NO-OP row, never a failure", () => {
    const row = buildVendorStageRow(
      { ...failedVendor, status: "skipped-not-requested", code: null, message: null },
      false,
    );
    expect(row.state).toBe("skipped-not-requested");
    expect(row.retryable).toBe(false);
    expect(row.code).toBeNull();
  });

  test("no credential → skip row names the fix, is not retryable", () => {
    const row = buildVendorStageRow(
      { ...matchedVendor, status: "skipped-no-credential", outcome: "not-attempted", detection: null },
      false,
    );
    expect(row.state).toBe("skipped-credential");
    expect(row.retryable).toBe(false);
    expect(row.detail).toContain("credential");
  });
});

const resolvedAddress: AddressStageBlockInput = {
  status: "resolved",
  code: null,
  message: null,
  mgmtIp: "10.20.1.10",
  mode: "dns-a",
};

const failedAddress: AddressStageBlockInput = {
  status: "failed",
  code: "DNS_NOT_FOUND",
  message: "ENOTFOUND",
  mgmtIp: null,
  mode: "failed",
};

describe("R50-T060/T061 buildAddressStageRow — the explicit address row", () => {
  test("resolved → IP + how it was obtained; not retryable", () => {
    const row = buildAddressStageRow(resolvedAddress, false);
    expect(row.state).toBe("resolved");
    expect(row.headline).toContain("10.20.1.10");
    expect(row.detail).toContain("DNS");
    expect(row.retryable).toBe(false);
  });

  test("ip-literal mode says 'used the entered address', not DNS", () => {
    const row = buildAddressStageRow({ ...resolvedAddress, mode: "ip-literal" }, false);
    expect(row.detail).not.toContain("DNS");
    expect(row.detail).toContain("entered");
  });

  test("failed → typed code + retryable (T064)", () => {
    const row = buildAddressStageRow(failedAddress, false);
    expect(row.state).toBe("failed");
    expect(row.code).toBe("DNS_NOT_FOUND");
    expect(row.retryable).toBe(true);
  });

  test("refused (IPv4-only policy) → refused row + retryable", () => {
    const row = buildAddressStageRow(
      {
        status: "refused",
        code: "IPV6_UNSUPPORTED",
        message: "AAAA-only",
        mgmtIp: null,
        mode: "refused-aaaa-only",
      },
      false,
    );
    expect(row.state).toBe("refused");
    expect(row.code).toBe("IPV6_UNSUPPORTED");
    expect(row.retryable).toBe(true);
  });

  test("T064 — skipped-not-requested row for a vendor-only run", () => {
    const row = buildAddressStageRow(
      { ...failedAddress, status: "skipped-not-requested", code: null, message: null },
      false,
    );
    expect(row.state).toBe("skipped-not-requested");
    expect(row.retryable).toBe(false);
  });

  test("running while a retry is in flight", () => {
    const row = buildAddressStageRow(resolvedAddress, true);
    expect(row.state).toBe("running");
    expect(row.headline).toBe("Resolving management address…");
  });
});

/* ───────────────────── T063 — first-contact disclosure ─────────────────── */

describe("R50-T063 buildHostKeyPanel — first contact before enrollment", () => {
  const capturedKey = { keyType: "ssh-ed25519", fingerprint: "SHA256:abc123" };

  test("capture-requested → panel with target, dialed address, key + fingerprint", () => {
    const panel = buildHostKeyPanel(
      {
        ...matchedVendor,
        hostKeyState: "capture-requested",
        hostKeyCaptured: capturedKey,
      },
      "21.0.17.144",
      "21.0.17.144",
    );
    expect(panel).not.toBeNull();
    expect(panel?.state).toBe("capture-requested");
    expect(panel?.target).toBe("21.0.17.144");
    expect(panel?.dialed).toBe("21.0.17.144");
    expect(panel?.captured?.fingerprint).toBe("SHA256:abc123");
  });

  test("pinned endpoint → verified panel (still shows the trust identity)", () => {
    const panel = buildHostKeyPanel(
      { ...matchedVendor, hostKeyState: "pinned", hostKeyCaptured: null },
      "core-sw.hq.faya",
      "core-sw.hq.faya",
    );
    expect(panel?.state).toBe("pinned");
    expect(panel?.target).toBe("core-sw.hq.faya");
  });

  test("null when the vendor stage never ran — an absent panel is never readable as verified", () => {
    expect(buildHostKeyPanel(null, "x", "x")).toBeNull();
    expect(
      buildHostKeyPanel(
        { ...matchedVendor, status: "skipped-no-credential", outcome: "not-attempted", detection: null },
        "x",
        "x",
      ),
    ).toBeNull();
    expect(
      buildHostKeyPanel(
        { ...matchedVendor, status: "skipped-not-requested" },
        "x",
        "x",
      ),
    ).toBeNull();
  });
});

/* ───────────────────── T064 — stage selection (server) ─────────────────── */

describe("R50-T064 resolveRequestedStages — stage-specific retry selection", () => {
  test("omitted selection = BOTH stages (the historical full run)", () => {
    expect(resolveRequestedStages(undefined)).toEqual({ vendor: true, address: true });
  });

  test("explicit vendor-only selection", () => {
    expect(resolveRequestedStages(["vendor"])).toEqual({ vendor: true, address: false });
  });

  test("explicit address-only selection", () => {
    expect(resolveRequestedStages(["address"])).toEqual({ vendor: false, address: true });
  });

  test("explicit both", () => {
    expect(resolveRequestedStages(["vendor", "address"])).toEqual({
      vendor: true,
      address: true,
    });
  });

  test("defensive: empty selection falls back to both (schema enforces min(1))", () => {
    expect(resolveRequestedStages([])).toEqual({ vendor: true, address: true });
  });

  test("the stage names are exactly the two contract stages", () => {
    expect([...DETECTION_STAGES]).toEqual(["vendor", "address"]);
  });
});
