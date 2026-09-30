import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { evaluateTargetPolicy } from "../../src/lib/net/target-policy";
import { mapResolutionToContractCode, mapWorkerErrorToDetectionCode } from "../../src/lib/net/detection-contract";
import {
  authorizeProbeCredential,
  parseProbeCredentialAllowlist,
} from "../../src/lib/security/probe-credential";
import {
  DNS_BUDGET_EXCEEDED,
  resolveHostToIp,
} from "../../src/lib/dns/resolve-host";
import {
  appendBounded,
} from "../../mini-services/worker/ssh-transport";
import {
  classifyTargetAddress,
  DEFAULT_WORKER_RESOLVE_BUDGET_MS,
  deterministicAddressPick,
  resolveTargetForDial,
} from "../../mini-services/worker/target-policy";

/**
 * R50 Phase 8 — authorization chain + abuse-budget hardening for the
 * vendor auto-detect plane.
 *
 *   R50-T021 — credential-profile authorization: the route verifies
 *              actor → credential profile → tenant → target network
 *              scope. The actor link is the device.detect RBAC gate
 *              (R50-T020) + the optional FAYANMS_PROBE_CREDENTIAL_ALLOWLIST
 *              (fail-closed when enforced); the tenant link passes
 *              structurally (single-tenant schema) and is RECORDED; the
 *              target link is the two-plane policy (literal class
 *              app-side + resolved class worker-side), all audited as one
 *              `credentialAuthorization` chain.
 *   R50-T022 follow-up — the worker enforces the target policy on the
 *              RESOLVED address (hostnames were opaque to the app-plane
 *              literal policy): every resolved candidate must pass, the
 *              probe dials the validated address (no second lookup — the
 *              rebinding window is structurally gone), and the decision
 *              rides back as evidence.
 *   R50-T025 — timeout and resource budgets: bounded DNS waits (app
 *              resolver + worker resolution), a worker-side total probe
 *              budget, and a per-stream exec output cap in the SSH
 *              transport.
 */

const ROUTE = readFileSync("src/app/api/v1/devices/auto-detect/route.ts", "utf8");
const WORKER_INDEX = readFileSync("mini-services/worker/index.ts", "utf8");
const WORKER_TRANSPORT = readFileSync("mini-services/worker/ssh-transport.ts", "utf8");
const WORKER_POLICY = readFileSync("mini-services/worker/target-policy.ts", "utf8");

/* ── R50-T021 — the allowlist decision module ── */

describe("R50-T021 — probe-credential allowlist parsing", () => {
  test("unset / null / blank → not enforced", () => {
    expect(parseProbeCredentialAllowlist(undefined)).toBeNull();
    expect(parseProbeCredentialAllowlist(null)).toBeNull();
    expect(parseProbeCredentialAllowlist("")).toBeNull();
    expect(parseProbeCredentialAllowlist("   ")).toBeNull();
  });

  test("csv parses with trimming; empty tokens dropped", () => {
    expect(parseProbeCredentialAllowlist("a,b")).toEqual(["a", "b"]);
    expect(parseProbeCredentialAllowlist(" a ,  b ,, c ")).toEqual(["a", "b", "c"]);
  });

  test("a set-but-empty-of-tokens value is NOT enforcement (documented)", () => {
    // "set = enforced" is expressed by a non-matching sentinel (e.g. none);
    // a whitespace-only value parses to the documented not-enforced null.
    expect(parseProbeCredentialAllowlist(" , ")).toBeNull();
  });
});

describe("R50-T021 — probe-credential authorization decision", () => {
  test("no allowlist → allowed, enforcement flagged false", () => {
    const d = authorizeProbeCredential({ profileId: "p1", profileName: "n", allowlist: null });
    expect(d.decision).toBe("allowed");
    expect(d.allowlistEnforced).toBe(false);
    expect(d.matchedBy).toBeNull();
  });

  test("allowlist matched by profile id", () => {
    const d = authorizeProbeCredential({
      profileId: "cred-1",
      profileName: "Core SSH",
      allowlist: ["cred-1", "cred-2"],
    });
    expect(d.decision).toBe("allowed");
    expect(d.matchedBy).toBe("id");
    expect(d.allowlistEnforced).toBe(true);
  });

  test("allowlist matched by unique profile name", () => {
    const d = authorizeProbeCredential({
      profileId: "cred-x",
      profileName: "Core SSH",
      allowlist: ["Core SSH"],
    });
    expect(d.decision).toBe("allowed");
    expect(d.matchedBy).toBe("name");
  });

  test("profile matching no entry → refused (fail-closed)", () => {
    const d = authorizeProbeCredential({
      profileId: "cred-9",
      profileName: "Other",
      allowlist: ["cred-1"],
    });
    expect(d.decision).toBe("refused-not-allowlisted");
    expect(d.matchedBy).toBeNull();
    expect(d.allowlistEnforced).toBe(true);
  });
});

describe("R50-T021 — route wiring of the authorization chain", () => {
  test("the route reads the allowlist at request time and decides with the module", () => {
    expect(ROUTE).toContain("parseProbeCredentialAllowlist(");
    expect(ROUTE).toContain("process.env.FAYANMS_PROBE_CREDENTIAL_ALLOWLIST");
    expect(ROUTE).toContain("authorizeProbeCredential({");
  });

  test("the profile query selects name (allowlist matches by unique name)", () => {
    expect(ROUTE).toContain(
      "select: { id: true, name: true, type: true, username: true, port: true, secretRef: true }",
    );
  });

  test("an allowlisted refusal is a stable CREDENTIAL_NOT_AUTHORIZED + audited reason", () => {
    expect(ROUTE).toContain('reason: "profile-not-allowlisted"');
    expect(ROUTE).toContain(
      '"The selected credential profile is not authorized for active probing"',
    );
  });

  test("the main audit event carries the FULL actor→profile→tenant→target chain", () => {
    expect(ROUTE).toContain("tenantScope: \"single-tenant\"");
    expect(ROUTE).toContain('actorPermission: "device.detect"');
    expect(ROUTE).toContain("targetPolicyClass: targetPolicy.addressClass");
    expect(ROUTE).toContain("resolvedAddressPolicy");
    expect(ROUTE).toContain("credentialAuthorization,");
  });

  test("the worker's resolved-address policy decision completes the chain", () => {
    expect(ROUTE).toContain(
      "credentialAuthorization.resolvedAddressPolicy = payload.targetPolicy ?? null;",
    );
  });
});

/* ── R50-T022 follow-up — worker-plane resolved-address policy ── */

describe("R50-T022-fu — classification parity across the two planes", () => {
  const CORPUS = [
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "172.32.0.1",
    "192.167.0.1",
    "192.168.1.1",
    "224.0.0.1",
    "239.1.1.1",
    "240.0.0.1",
    "255.255.255.255",
    "8.8.8.8",
    "21.0.17.144",
    "::",
    "::1",
    "fe80::1",
    "fec0::1",
    "ff02::1",
    "fd00::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "::ffff:8.8.8.8",
    "::ffff:169.254.169.254",
  ];

  test("the worker module classifies EVERY literal exactly like the app module", () => {
    for (const address of CORPUS) {
      const app = evaluateTargetPolicy(address);
      const worker = classifyTargetAddress(address);
      expect(worker.allowed).toBe(app.allowed);
      expect(worker.addressClass).toBe(app.addressClass);
    }
  });

  test("the lab escape hatch behaves identically on both planes", () => {
    const original = process.env.FAYANMS_PROBE_ALLOW_SPECIAL;
    try {
      process.env.FAYANMS_PROBE_ALLOW_SPECIAL = "true";
      for (const address of ["127.0.0.1", "169.254.169.254", "::1"]) {
        expect(classifyTargetAddress(address).allowed).toBe(true);
        expect(evaluateTargetPolicy(address).allowed).toBe(true);
      }
    } finally {
      if (original === undefined) delete process.env.FAYANMS_PROBE_ALLOW_SPECIAL;
      else process.env.FAYANMS_PROBE_ALLOW_SPECIAL = original;
    }
  });

  test("the worker module is SELF-CONTAINED (the image COPYs only the worker dir)", () => {
    expect(WORKER_POLICY).not.toMatch(/from "\.\.\/\.\.\/src\//);
    expect(WORKER_POLICY).not.toContain('@/lib');
  });
});

describe("R50-T022-fu — resolveTargetForDial", () => {
  const ok4 = (records: string[]) => async () => records;
  const fail4 = (code: string) => async () => {
    throw { code };
  };

  test("an IP literal classifies with NO DNS and dials verbatim", async () => {
    let dnsCalled = false;
    const spy = async (h: string): Promise<string[]> => {
      dnsCalled = true;
      return [];
    };
    const r = await resolveTargetForDial("10.20.0.5", spy, spy);
    expect(dnsCalled).toBe(false);
    expect(r.decision.ok).toBe(true);
    if (r.decision.ok) {
      expect(r.decision.dialedAddress).toBe("10.20.0.5");
      expect(r.decision.checked).toBe("literal");
      expect(r.decision.addressClass).toBe("private");
    }
  });

  test("a governed-class literal is refused worker-side (defense in depth)", async () => {
    const r = await resolveTargetForDial("127.0.0.1", ok4([]), ok4([]));
    expect(r.decision).toEqual({ ok: false, code: "SSH_TARGET_POLICY_REFUSED", detail: "loopback" });
  });

  test("a hostname resolving to private addresses dials the DETERMINISTIC pick", async () => {
    // R50-T033 rule mirrored: numeric-ascending — 10.0.0.2 sorts before 10.0.0.20.
    const r = await resolveTargetForDial("core.corp.local", ok4(["10.0.0.20", "10.0.0.2"]), ok4([]));
    expect(r.decision.ok).toBe(true);
    if (r.decision.ok) {
      expect(r.decision.dialedAddress).toBe("10.0.0.2");
      expect(r.decision.checked).toBe("resolved");
    }
    expect(r.candidates.map((c) => c.addressClass)).toEqual(["private", "private"]);
  });

  test("ANY governed-denied candidate refuses the WHOLE name (fail-closed RRset)", async () => {
    const r = await resolveTargetForDial(
      "mixed.corp.local",
      ok4(["10.0.0.1", "169.254.169.254"]),
      ok4([]),
    );
    expect(r.decision).toEqual({
      ok: false,
      code: "SSH_TARGET_POLICY_REFUSED",
      detail: "link-local",
    });
    // The evidence records the candidates seen up to the refusal.
    expect(r.candidates.map((c) => c.address)).toContain("10.0.0.1");
  });

  test("a metadata-style hostname (resolving to link-local) can never be probed", async () => {
    const r = await resolveTargetForDial("metadata.google.internal", ok4(["169.254.169.254"]), ok4([]));
    expect(r.decision.ok).toBe(false);
  });

  test("an unresolvable hostname answers the typed unresolved refusal", async () => {
    const r = await resolveTargetForDial("blackhole.faya.invalid", fail4("ENOTFOUND"), fail4("ENOTFOUND"));
    expect(r.decision).toEqual({ ok: false, code: "SSH_TARGET_UNRESOLVED", detail: "ENOTFOUND" });
  });

  test("a stalled resolver answers the typed resolution TIMEOUT", async () => {
    const stalled = () => new Promise<string[]>(() => {});
    const r = await resolveTargetForDial("slow.corp.local", stalled, stalled, 40);
    expect(r.decision).toEqual({
      ok: false,
      code: "SSH_TARGET_RESOLVE_TIMEOUT",
      detail: "DNS_TIMEOUT",
    });
  });

  test("an AAAA-only host dials its first AAAA record (policy-governed)", async () => {
    const r = await resolveTargetForDial("v6.corp.local", ok4([]), ok4(["2001:db8::1"]));
    expect(r.decision.ok).toBe(true);
    if (r.decision.ok) {
      expect(r.decision.dialedAddress).toBe("2001:db8::1");
      expect(r.decision.checked).toBe("resolved");
    }
  });

  test("deterministicAddressPick is numeric-ascending (octet-aware)", () => {
    expect(deterministicAddressPick(["10.0.0.20", "10.0.0.2"])).toBe("10.0.0.2");
    expect(deterministicAddressPick(["192.168.0.10", "9.0.0.1"])).toBe("9.0.0.1");
    expect(deterministicAddressPick([])).toBeNull();
  });

  test("the default worker budget is bounded and env-overridable", () => {
    expect(DEFAULT_WORKER_RESOLVE_BUDGET_MS).toBe(5_000);
    expect(WORKER_POLICY).toContain("FAYANMS_WORKER_RESOLVE_TIMEOUT_MS");
  });
});

describe("R50-T022-fu — the worker dial path uses the validated address", () => {
  test("the detect handler resolves the dial target through the policy module", () => {
    expect(WORKER_INDEX).toContain('import { resolveTargetForDial } from "./target-policy";');
    expect(WORKER_INDEX).toContain("const dial = await resolveTargetForDial(host);");
    expect(WORKER_INDEX).toContain("if (!dial.decision.ok) {");
    expect(WORKER_INDEX).toContain("host: dial.decision.dialedAddress,");
  });

  test("the policy refusal surfaces as the typed worker error (contract-mapped)", () => {
    expect(WORKER_INDEX).toContain("error: `${dial.decision.code}: ${dial.decision.detail}`");
    // The worker codes map to the SAME registry entries app-side.
    expect(mapWorkerErrorToDetectionCode("SSH_TARGET_POLICY_REFUSED: loopback")).toBe(
      "TARGET_NOT_ALLOWED",
    );
    expect(mapWorkerErrorToDetectionCode("SSH_TARGET_UNRESOLVED: ENOTFOUND")).toBe(
      "DNS_NOT_FOUND",
    );
    expect(mapWorkerErrorToDetectionCode("SSH_TARGET_RESOLVE_TIMEOUT: DNS_TIMEOUT")).toBe(
      "DNS_TIMEOUT",
    );
  });

  test("the success payload carries the dial + policy evidence (additive)", () => {
    expect(WORKER_INDEX).toContain("dialedAddress: dial.decision.dialedAddress,");
    expect(WORKER_INDEX).toContain("checked: dial.decision.checked,");
    expect(WORKER_INDEX).toContain("addressClass: dial.decision.addressClass,");
  });
});

/* ── R50-T025 — timeout and resource budgets ── */

describe("R50-T025 — app-plane DNS budget", () => {
  test("the DNS_TIMEOUT marker is the contract-mapped budget-exceeded code", () => {
    expect(DNS_BUDGET_EXCEEDED).toBe("DNS_TIMEOUT");
    expect(mapResolutionToContractCode("failed", "DNS_TIMEOUT")).toBe("DNS_TIMEOUT");
  });

  test("a stalled A resolver answers DNS_TIMEOUT instead of hanging", async () => {
    const stalled = () => new Promise<string[]>(() => {});
    const r = await resolveHostToIp("slow.corp.local", stalled, stalled, 40);
    expect(r.mode).toBe("failed");
    expect(r.resolutionError).toBe("DNS_TIMEOUT");
    expect(r.mgmtIp).toBeNull();
  });

  test("a fast resolver is unaffected by the budget (behavior unchanged)", async () => {
    const r = await resolveHostToIp("core.corp.local", async () => ["10.0.0.9"], async () => [], 2_000);
    expect(r.mode).toBe("dns-a");
    expect(r.mgmtIp).toBe("10.0.0.9");
  });

  test("the AAAA diagnostic carries the same budget; a diagnostic timeout keeps the A truth", async () => {
    const stalled = () => new Promise<string[]>(() => {});
    const r = await resolveHostToIp("dual-stall.corp.local", stalled, stalled, 40);
    expect(r.mode).toBe("failed");
    expect(r.resolutionError).toBe("DNS_TIMEOUT");
  });

  test("literals and typed refusals bypass the budget entirely", async () => {
    let dnsCalled = false;
    const spy = async (): Promise<string[]> => {
      dnsCalled = true;
      return [];
    };
    const literal = await resolveHostToIp("10.0.0.1", spy, spy, 1);
    expect(literal.mode).toBe("ip-literal");
    expect(dnsCalled).toBe(false);
    const v6 = await resolveHostToIp("2001:db8::1", spy, spy, 1);
    expect(v6.mode).toBe("refused-ipv6-literal");
    expect(dnsCalled).toBe(false);
  });

  test("the budget knob is documented in the resolver", () => {
    expect(readFileSync("src/lib/dns/resolve-host.ts", "utf8")).toContain(
      "FAYANMS_RESOLVE_TIMEOUT_MS",
    );
  });
});

describe("R50-T025 — worker budgets", () => {
  test("the detect probe carries a TOTAL budget checked between candidates", () => {
    expect(WORKER_INDEX).toContain("FAYANMS_DETECT_TOTAL_BUDGET_MS");
    expect(WORKER_INDEX).toContain("if (Date.now() - startedAt > DETECT_TOTAL_BUDGET_MS)");
  });

  test("the probe exec passes the per-stream output cap (analysis budget)", () => {
    expect(WORKER_INDEX).toContain("sshExecText(creds, command, 15000, ANALYSIS_MAX_BYTES)");
  });

  test("the SSH transport bounds exec accumulation per stream", () => {
    expect(WORKER_TRANSPORT).toContain("maxOutputBytes = 1_048_576");
    expect(WORKER_TRANSPORT).toContain("appendBounded(outAcc, chunk, maxOutputBytes)");
    expect(WORKER_TRANSPORT).toContain("appendBounded(errAcc, chunk, maxOutputBytes)");
  });
});

describe("R50-T025 — appendBounded accumulator", () => {
  test("appends under the budget with byte accounting", () => {
    let acc = { text: "", bytes: 0, truncated: false };
    acc = appendBounded(acc, Buffer.from("hello"), 100);
    expect(acc).toEqual({ text: "hello", bytes: 5, truncated: false });
  });

  test("a chunk crossing the budget is sliced to the exact remaining budget; later chunks are dropped", () => {
    // RT-026 (F-042): the crossing chunk is no longer taken WHOLE — the
    // accumulator appends exactly the remaining budget and drops the tail,
    // so `bytes` never overshoots maxBytes (the pre-RT-026 behavior this
    // pin asserted — bytes === 8 with a 4-byte cap — was the bug).
    let acc = { text: "", bytes: 0, truncated: false };
    acc = appendBounded(acc, Buffer.from("abcdefgh"), 4);
    expect(acc.text).toBe("abcd"); // sliced to the exact remaining budget
    expect(acc.bytes).toBe(4);
    expect(acc.truncated).toBe(true);
    acc = appendBounded(acc, Buffer.from("more"), 4);
    expect(acc.text).toBe("abcd"); // tail dropped
    expect(acc.bytes).toBe(4);
  });

  test("multibyte characters are accounted by BYTES (exact cap at the boundary)", () => {
    // RT-026: the cap is exact — `bytes` equals maxBytes. A 2-byte é sliced
    // at the 1-byte boundary decodes as U+FFFD (documented in the helper's
    // comment); the text's re-encoded length may exceed the cap by at most
    // the 2 bytes of the split sequence — the accumulator counter does not.
    let acc = { text: "", bytes: 0, truncated: false };
    acc = appendBounded(acc, Buffer.from("é"), 1); // 2 bytes in UTF-8
    expect(acc.bytes).toBe(1);
    expect(acc.truncated).toBe(true);
  });

  test("an exhausted accumulator stays exhausted (idempotent)", () => {
    const acc = { text: "x", bytes: 10, truncated: true };
    const next = appendBounded(acc, Buffer.from("y"), 10);
    expect(next.text).toBe("x");
    expect(next.bytes).toBe(10);
    expect(next.truncated).toBe(true);
  });
});
