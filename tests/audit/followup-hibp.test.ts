/**
 * F-034 documented follow-up — HIBP k-anonymity password-breach check
 * (src/lib/auth/hibp.ts).
 *
 *   History: the F-034 wave shipped the role-aware password policy with an
 *   OFFLINE common-password denylist standing in for a breach corpus, and
 *   the docs named the k-anonymity HIBP range-API check as the production
 *   follow-up (a network dependency deliberately kept out of that change).
 *   This follow-up ships it CONFIG-GATED: FAYANMS_HIBP_MODE (off = the
 *   hermetic default, zero network; enforce = the check gates every
 *   password SET at the SAME surfaces as the denylist — admin create /
 *   PATCH / reset-password, NEVER at login).
 *
 *   Pinned here (hermetic — globalThis.fetch is stubbed with a spy; NO
 *   real network):
 *     - the mode gate: off never calls fetch and accepts per the existing
 *       policy only; enforce + breached → PASSWORD_BREACHED with the
 *       occurrence count; enforce + clean → accepted;
 *     - FAIL-CLOSED honesty under enforce: transport rejection, non-2xx,
 *       malformed response, and a real signal-honoring abort all answer
 *       PASSWORD_BREACH_CHECK_UNAVAILABLE (an unverifiable password is
 *       refused — the AI-quota-store posture);
 *     - the request shape: GET on the range URL with EXACTLY the 5-char
 *       SHA-1 prefix (the k-anonymity property — the full hash never
 *       leaves the process; no request body), the Add-Padding etiquette
 *       header, a proper User-Agent, and an abort signal attached;
 *     - parsing honesty: case-insensitive suffix match, leading-zero
 *       padding, any non-conforming line poisons the whole response;
 *     - the knob clamps: FAYANMS_HIBP_TIMEOUT_MS into 500..10000 (default
 *       1500, garbage → default) and the unknown-mode clamp to off with a
 *       one-shot [security-policy] warning (the FAYANMS_MFA_MODE pattern);
 *     - the error-envelope contract the routes rely on (breachIssueToFail
 *       carries the occurrence detail for PASSWORD_BREACHED and renders
 *       the unavailable code without one);
 *     - source pins: the breach check runs AFTER the offline policy and
 *       BEFORE hashPassword at all three admin SET surfaces, never in
 *       options.ts (the login plane), plus the .env.example block and the
 *       operator docs that retire the follow-up TODO.
 *
 *   LEAK DISCIPLINE: bun test runs every suite in ONE process — afterEach
 *   restores globalThis.fetch, deletes both env knobs and resets the
 *   one-shot warning dedupe so no other suite can ever reach the network.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  HIBP_DEFAULT_TIMEOUT_MS,
  HIBP_MAX_TIMEOUT_MS,
  HIBP_MIN_TIMEOUT_MS,
  HIBP_MODE_ENV,
  HIBP_PREFIX_LENGTH,
  HIBP_RANGE_API_BASE,
  HIBP_SUFFIX_LENGTH,
  HIBP_TIMEOUT_ENV,
  HIBP_USER_AGENT,
  HibpCheckUnavailableError,
  breachIssueToFail,
  checkPasswordBreach,
  parseRangeBodyForSuffix,
  queryPwnedPasswordRange,
  resetHibpModeForTests,
  resolveHibpMode,
  resolveHibpTimeoutMs,
  sha1HexUpper,
} from "../../src/lib/auth/hibp";
import {
  MIN_PASSWORD_LENGTH,
  PRIVILEGED_MIN_PASSWORD_LENGTH,
  validatePasswordPolicy,
} from "../../src/lib/auth/password";

/* ── the fetch spy (hermetic by construction) ─────────────────────────── */

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  hasBody: boolean;
  signal: AbortSignal | null;
}

const originalFetch = globalThis.fetch;
let calls: CapturedCall[] = [];
let responder: ((call: CapturedCall) => Promise<Response>) | null = null;

function installFetchSpy(
  responderFn: (call: CapturedCall) => Promise<Response>
): void {
  responder = responderFn;
  calls = [];
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const headers: Record<string, string> = {};
    if (init?.headers !== undefined) {
      const parsed = new Headers(init.headers as HeadersInit);
      parsed.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
    }
    const call: CapturedCall = {
      url,
      method: init?.method ?? "GET",
      headers,
      hasBody: init?.body !== undefined && init.body !== null,
      signal: init?.signal ?? null,
    };
    calls.push(call);
    return responder!(call);
  }) as typeof fetch;
}

/** A HIBP range body listing the given suffix/count pairs (UPPERCASE hex). */
function rangeBody(entries: Array<[suffix: string, count: number]>): string {
  return entries.map(([suffix, count]) => `${suffix}:${count}`).join("\n");
}

/** A 35-char hex suffix that provably differs from the given one. */
function decoySuffix(notThis: string, seed: number): string {
  let out = "";
  for (let i = 0; i < HIBP_SUFFIX_LENGTH; i += 1) {
    const nibble = (seed * (i + 3) * 7) % 16;
    let hex = nibble.toString(16).toUpperCase();
    if (hex === notThis[i]) hex = notThis[i] === "0" ? "1" : "0";
    out += hex;
  }
  return out;
}

/** A candidate that passes the OFFLINE policy (length + denylist). */
const CLEAN_CANDIDATE = "FayaNMS-hibp-pin-2026-candidate!";

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env[HIBP_MODE_ENV];
  delete process.env[HIBP_TIMEOUT_ENV];
  resetHibpModeForTests();
  calls = [];
  responder = null;
});

/* ─────────────────────── mode gate (FAYANMS_HIBP_MODE) ─────────────────── */

describe("HIBP follow-up — mode gate (FAYANMS_HIBP_MODE)", () => {
  test("off (unset, empty, 'off') is the default: fetch NEVER runs, the gate accepts", async () => {
    installFetchSpy(async () => {
      throw new Error("network must never be touched with the mode off");
    });
    for (const value of [undefined, "", "off", "OFF"]) {
      if (value === undefined) delete process.env[HIBP_MODE_ENV];
      else process.env[HIBP_MODE_ENV] = value;
      expect(resolveHibpMode()).toBe("off");
      const issue = await checkPasswordBreach(CLEAN_CANDIDATE);
      expect(issue).toBeNull(); // accepted — the existing policy is the only bar
      expect(calls).toHaveLength(0); // zero network, byte-unchanged behavior
    }
  });

  test("enforce + breached → PASSWORD_BREACHED with the occurrence count in detail", async () => {
    const hash = sha1HexUpper(CLEAN_CANDIDATE);
    const suffix = hash.slice(HIBP_PREFIX_LENGTH);
    installFetchSpy(async () =>
      new Response(
        rangeBody([
          [decoySuffix(suffix, 1), 999999],
          [suffix, 3730471], // the matched line — not the decoy's bigger count
          [decoySuffix(suffix, 2), 42],
        ]),
        { status: 200 }
      )
    );
    process.env[HIBP_MODE_ENV] = "enforce";
    const issue = await checkPasswordBreach(CLEAN_CANDIDATE);
    expect(issue).not.toBeNull();
    expect(issue!.code).toBe("PASSWORD_BREACHED");
    expect(issue!.detail?.occurrences).toBe(3730471);
    expect(issue!.message).toContain("3730471");
    expect(calls).toHaveLength(1); // no retries (v1 honest simplicity)
  });

  test("enforce + clean → accepted (null) with exactly one range request", async () => {
    const hash = sha1HexUpper(CLEAN_CANDIDATE);
    const suffix = hash.slice(HIBP_PREFIX_LENGTH);
    installFetchSpy(async () =>
      new Response(
        rangeBody([
          [decoySuffix(suffix, 3), 12],
          [decoySuffix(suffix, 4), 34567],
        ]),
        { status: 200 }
      )
    );
    process.env[HIBP_MODE_ENV] = "enforce";
    const issue = await checkPasswordBreach(CLEAN_CANDIDATE);
    expect(issue).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("enforce + transport rejection → PASSWORD_BREACH_CHECK_UNAVAILABLE (fail-closed)", async () => {
    installFetchSpy(async () => {
      throw new Error("ECONNREFUSED — simulated transport failure");
    });
    process.env[HIBP_MODE_ENV] = "enforce";
    const noise: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => noise.push(args.map(String).join(" "));
    let issue: Awaited<ReturnType<typeof checkPasswordBreach>>;
    try {
      issue = await checkPasswordBreach(CLEAN_CANDIDATE);
    } finally {
      console.error = originalError;
    }
    expect(issue).not.toBeNull();
    expect(issue!.code).toBe("PASSWORD_BREACH_CHECK_UNAVAILABLE");
    expect(issue!.detail).toBeUndefined();
    // The operator opted in — the refusal is explained server-side too.
    expect(
      noise.some((line) => line.includes("[hibp]") && line.includes("fail-closed"))
    ).toBe(true);
  });

  test("enforce + non-2xx → PASSWORD_BREACH_CHECK_UNAVAILABLE", async () => {
    installFetchSpy(async () => new Response("rate limited", { status: 429 }));
    process.env[HIBP_MODE_ENV] = "enforce";
    const issue = await checkPasswordBreach(CLEAN_CANDIDATE);
    expect(issue?.code).toBe("PASSWORD_BREACH_CHECK_UNAVAILABLE");
  });

  test("enforce + malformed response → PASSWORD_BREACH_CHECK_UNAVAILABLE", async () => {
    installFetchSpy(async () =>
      new Response("unexpected gateway error page <!doctype html>", { status: 200 })
    );
    process.env[HIBP_MODE_ENV] = "enforce";
    const issue = await checkPasswordBreach(CLEAN_CANDIDATE);
    expect(issue?.code).toBe("PASSWORD_BREACH_CHECK_UNAVAILABLE");
  });

  test("unknown mode values clamp to off with a ONE-SHOT [security-policy] warning", () => {
    resetHibpModeForTests();
    process.env[HIBP_MODE_ENV] = "maybe";
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message?: unknown) => warnings.push(String(message));
    try {
      expect(resolveHibpMode()).toBe("off");
    } finally {
      console.warn = original;
    }
    expect(warnings.some((w) => w.includes("[security-policy]") && w.includes(HIBP_MODE_ENV))).toBe(
      true
    );
    // One-shot per process (mirrors resolveMfaMode's dedupe).
    const warningsAfter = warnings.length;
    resolveHibpMode();
    expect(warnings.length).toBe(warningsAfter);
  });
});

/* ───────────────── k-anonymity request shape (prefix ONLY) ─────────────── */

describe("HIBP follow-up — k-anonymity request shape (spy sees the prefix ONLY)", () => {
  test("the full hash NEVER leaves the process: exactly the 5-char prefix, no body", async () => {
    const hash = sha1HexUpper(CLEAN_CANDIDATE);
    installFetchSpy(async () =>
      new Response(rangeBody([[decoySuffix(hash.slice(5), 5), 1]]), { status: 200 })
    );
    process.env[HIBP_MODE_ENV] = "enforce";
    await checkPasswordBreach(CLEAN_CANDIDATE);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    const sent = call.url.slice(HIBP_RANGE_API_BASE.length);
    expect(call.url.startsWith(HIBP_RANGE_API_BASE)).toBe(true);
    expect(sent).toHaveLength(HIBP_PREFIX_LENGTH); // 5 — the k-anonymity budget
    expect(sent).toBe(hash.slice(0, HIBP_PREFIX_LENGTH));
    expect(sent).not.toBe(hash);
    // Not even ONE character beyond the prefix (a 6th hash char would narrow
    // the anonymity set; the candidate's suffix never travels either).
    expect(call.url.includes(hash)).toBe(false);
    expect(call.url.includes(hash.slice(HIBP_PREFIX_LENGTH))).toBe(false);
    expect(call.hasBody).toBe(false);
  });

  test("request shape pinned: GET, Add-Padding etiquette header, User-Agent, Accept, abort signal", async () => {
    installFetchSpy(async () => new Response("", { status: 200 }));
    process.env[HIBP_MODE_ENV] = "enforce";
    await checkPasswordBreach(CLEAN_CANDIDATE);
    const call = calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.headers["add-padding"]).toBe("true");
    expect(call.headers["user-agent"]).toBe(HIBP_USER_AGENT);
    expect(call.headers["user-agent"]).toContain("FayaNMS");
    expect(call.headers.accept).toBe("text/plain");
    expect(call.signal).toBeInstanceOf(AbortSignal);
  });

  test("a fetch that HONORS the abort signal rejects in real time and the check fails closed", async () => {
    installFetchSpy(async (call) => {
      return new Promise<Response>((_resolve, reject) => {
        call.signal?.addEventListener("abort", () => reject(call.signal?.reason));
      });
    });
    process.env[HIBP_MODE_ENV] = "enforce";
    const issue = await checkPasswordBreach(CLEAN_CANDIDATE, { timeoutMs: 60 });
    expect(issue?.code).toBe("PASSWORD_BREACH_CHECK_UNAVAILABLE");
  });

  test("the env timeout knob reaches the REAL deadline (clamped floor honored)", async () => {
    installFetchSpy(async (call) => {
      return new Promise<Response>((_resolve, reject) => {
        call.signal?.addEventListener("abort", () => reject(call.signal?.reason));
      });
    });
    // "80" is below the 500 ms floor → the clamp decides the deadline.
    process.env[HIBP_MODE_ENV] = "enforce";
    process.env[HIBP_TIMEOUT_ENV] = "80";
    const started = Date.now();
    const issue = await checkPasswordBreach(CLEAN_CANDIDATE);
    const elapsed = Date.now() - started;
    expect(issue?.code).toBe("PASSWORD_BREACH_CHECK_UNAVAILABLE");
    expect(elapsed).toBeGreaterThanOrEqual(HIBP_MIN_TIMEOUT_MS - 10);
    expect(elapsed).toBeLessThan(HIBP_DEFAULT_TIMEOUT_MS + 500);
  });
});

/* ─────────────────── range-body parsing (fail-closed honesty) ──────────── */

describe("HIBP follow-up — range-body parsing (fail-closed honesty)", () => {
  const SUFFIX = "1E4C9B93F3F0682250B6CF8331B7EE68FD8"; // 35 hex chars

  test("the suffix match is case-insensitive and count-padding tolerant", () => {
    expect(parseRangeBodyForSuffix(`${SUFFIX.toLowerCase()}:7`, SUFFIX)).toBe(7);
    expect(
      parseRangeBodyForSuffix(`  ${SUFFIX}:0000012  `, SUFFIX) // Add-Padding zero-count + line whitespace
    ).toBe(12);
  });

  test("a whitespace-only body is a valid empty range (clean)", () => {
    expect(parseRangeBodyForSuffix("", SUFFIX)).toBe(0);
    expect(parseRangeBodyForSuffix("\n  \n", SUFFIX)).toBe(0);
  });

  test("the candidate is found among many lines; the count comes from the MATCHED line", () => {
    const body = rangeBody([
      [`${"0".repeat(34)}A`, 5],
      [SUFFIX, 4],
      ["F".repeat(35), 9999],
    ]);
    expect(parseRangeBodyForSuffix(body, SUFFIX)).toBe(4);
    expect(parseRangeBodyForSuffix(body, "0123456789ABCDEF0123456789ABCDEF012")).toBe(0);
  });

  test("ANY non-conforming line poisons the WHOLE response (a partial parse cannot prove absence)", () => {
    expect(() =>
      parseRangeBodyForSuffix(`${SUFFIX}:1\nnot-a-hex-line:2`, SUFFIX)
    ).toThrow(HibpCheckUnavailableError);
    // A 34- or 36-char suffix is malformed, never a near-match.
    expect(() =>
      parseRangeBodyForSuffix(`${SUFFIX.slice(0, 34)}:1`, SUFFIX)
    ).toThrow(HibpCheckUnavailableError);
    expect(() =>
      parseRangeBodyForSuffix(`${SUFFIX}F:1`, SUFFIX)
    ).toThrow(HibpCheckUnavailableError);
    // A count line without digits is malformed.
    expect(() => parseRangeBodyForSuffix(`${SUFFIX}:`, SUFFIX)).toThrow(
      HibpCheckUnavailableError
    );
  });

  test("queryPwnedPasswordRange maps the parse failure to the unavailable error (no retries)", async () => {
    const hash = sha1HexUpper(CLEAN_CANDIDATE);
    installFetchSpy(async () => new Response("<<html garbage>>", { status: 200 }));
    let thrown: unknown = null;
    try {
      await queryPwnedPasswordRange(CLEAN_CANDIDATE, { timeoutMs: 100 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HibpCheckUnavailableError);
    expect(calls).toHaveLength(1); // one attempt — no retry loop
    expect(thrown instanceof HibpCheckUnavailableError && thrown.message.length > 0).toBe(
      true
    );
    expect(hash).toHaveLength(40); // the derivation pin rides along
  });
});

/* ─────────────────────── timeout knob (FAYANMS_HIBP_TIMEOUT_MS) ────────── */

describe("HIBP follow-up — timeout knob (FAYANMS_HIBP_TIMEOUT_MS)", () => {
  test("unset/empty → 1500; garbage → the default (never zero, never unbounded)", () => {
    delete process.env[HIBP_TIMEOUT_ENV];
    expect(resolveHibpTimeoutMs()).toBe(HIBP_DEFAULT_TIMEOUT_MS);
    process.env[HIBP_TIMEOUT_ENV] = "";
    expect(resolveHibpTimeoutMs()).toBe(HIBP_DEFAULT_TIMEOUT_MS);
    process.env[HIBP_TIMEOUT_ENV] = "not-a-number";
    expect(resolveHibpTimeoutMs()).toBe(HIBP_DEFAULT_TIMEOUT_MS);
    process.env[HIBP_TIMEOUT_ENV] = "-5";
    expect(resolveHibpTimeoutMs()).toBe(HIBP_DEFAULT_TIMEOUT_MS);
    process.env[HIBP_TIMEOUT_ENV] = "0";
    expect(resolveHibpTimeoutMs()).toBe(HIBP_DEFAULT_TIMEOUT_MS);
    process.env[HIBP_TIMEOUT_ENV] = "Infinity";
    expect(resolveHibpTimeoutMs()).toBe(HIBP_DEFAULT_TIMEOUT_MS);
  });

  test("finite values clamp into 500..10000 (floor and ceiling honored)", () => {
    for (const [raw, expected] of [
      ["500", HIBP_MIN_TIMEOUT_MS],
      ["3000", 3000],
      ["2500.7", 2501],
      ["100", HIBP_MIN_TIMEOUT_MS], // below the floor → floor
      ["80", HIBP_MIN_TIMEOUT_MS],
      ["60000", HIBP_MAX_TIMEOUT_MS], // above the ceiling → ceiling
      ["10000", HIBP_MAX_TIMEOUT_MS],
      ["10001", HIBP_MAX_TIMEOUT_MS],
    ] as const) {
      process.env[HIBP_TIMEOUT_ENV] = raw;
      expect(resolveHibpTimeoutMs()).toBe(expected);
    }
    expect(HIBP_MIN_TIMEOUT_MS).toBe(500);
    expect(HIBP_MAX_TIMEOUT_MS).toBe(10000);
    expect(HIBP_DEFAULT_TIMEOUT_MS).toBe(1500);
  });
});

/* ───────────────────────────── SHA-1 derivation ────────────────────────── */

describe("HIBP follow-up — SHA-1 derivation (node:crypto, UPPERCASE hex)", () => {
  test("matches node:crypto and the documented HIBP corpus form (5-char prefix + 35-char suffix)", () => {
    const vector = createHash("sha1").update("password", "utf8").digest("hex").toUpperCase();
    expect(sha1HexUpper("password")).toBe("5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8");
    expect(sha1HexUpper("password")).toBe(vector);
    const hash = sha1HexUpper(CLEAN_CANDIDATE);
    expect(hash).toHaveLength(40);
    expect(hash).toBe(hash.toUpperCase());
    expect(hash.slice(0, HIBP_PREFIX_LENGTH)).toHaveLength(5);
    expect(hash.slice(HIBP_PREFIX_LENGTH)).toHaveLength(35);
  });
});

/* ──────────────────── coexistence with the offline policy ──────────────── */

describe("HIBP follow-up — coexistence with the offline policy", () => {
  test("mode off: the offline policy is the ONLY bar — unchanged codes and thresholds", () => {
    delete process.env[HIBP_MODE_ENV];
    // The F-034 phase-1 contract is untouched (thresholds + code family).
    expect(MIN_PASSWORD_LENGTH).toBe(8);
    expect(PRIVILEGED_MIN_PASSWORD_LENGTH).toBe(12);
    expect(validatePasswordPolicy("password1", "viewer")?.code).toBe("PASSWORD_DENYLISTED");
    expect(validatePasswordPolicy("short", "viewer")?.code).toBe("PASSWORD_TOO_SHORT");
    expect(validatePasswordPolicy("only11char!", "admin")?.code).toBe(
      "PASSWORD_TOO_SHORT_FOR_ROLE"
    );
    expect(validatePasswordPolicy(CLEAN_CANDIDATE, "admin")).toBeNull();
  });

  test("enforce: the gate refuses only what HIBP knows — the offline layer still speaks first", async () => {
    // A denylisted password is refused by the OFFLINE policy without any
    // network — the route ordering pins enforce this; here we pin that the
    // offline refusal does not depend on the mode at all.
    process.env[HIBP_MODE_ENV] = "enforce";
    installFetchSpy(async () => {
      throw new Error("must not be reached for offline-refused passwords");
    });
    expect(validatePasswordPolicy("password1", "viewer")).not.toBeNull();
    // ...while a policy-clean but breached password is refused by the gate.
    const hash = sha1HexUpper(CLEAN_CANDIDATE);
    const suffix = hash.slice(HIBP_PREFIX_LENGTH);
    installFetchSpy(async () =>
      new Response(rangeBody([[suffix, 11]]), { status: 200 })
    );
    const issue = await checkPasswordBreach(CLEAN_CANDIDATE);
    expect(issue?.code).toBe("PASSWORD_BREACHED");
    expect(issue?.detail?.occurrences).toBe(11);
  });
});

/* ───────────────────── error envelope (breachIssueToFail) ──────────────── */

describe("HIBP follow-up — error envelope (breachIssueToFail)", () => {
  test("PASSWORD_BREACHED carries the occurrence detail; the unavailable code renders without one", async () => {
    const breached = (await breachIssueToFail({
      code: "PASSWORD_BREACHED",
      message: "password appears in known breach corpora 3730471 time(s)",
      detail: { occurrences: 3730471 },
    }).json()) as { success: boolean; error: Record<string, unknown> };
    expect(breached.success).toBe(false);
    expect(breached.error).toEqual({
      code: "PASSWORD_BREACHED",
      message: "password appears in known breach corpora 3730471 time(s)",
      detail: { occurrences: 3730471 },
    });
    const unavailable = (await breachIssueToFail({
      code: "PASSWORD_BREACH_CHECK_UNAVAILABLE",
      message: "the breach-corpus check could not be completed",
    }).json()) as { success: boolean; error: Record<string, unknown> };
    expect(unavailable.success).toBe(false);
    expect(unavailable.error).toEqual({
      code: "PASSWORD_BREACH_CHECK_UNAVAILABLE",
      message: "the breach-corpus check could not be completed",
    });
    expect("detail" in unavailable.error).toBe(false);
  });

  test("the distinct codes follow the PASSWORD_* family convention of the F-034 policy", () => {
    // Family: PASSWORD_TOO_SHORT / PASSWORD_TOO_SHORT_FOR_ROLE /
    // PASSWORD_DENYLISTED — the new refusals extend it, they do not fork it.
    expect(validatePasswordPolicy("short", "viewer")?.code?.startsWith("PASSWORD_")).toBe(
      true
    );
  });
});

/* ─────────── enforcement-point wiring + operator docs (source pins) ────── */

describe("HIBP follow-up — enforcement-point wiring + operator docs (source)", () => {
  const read = (p: string): string => readFileSync(join(".", p), "utf8");

  test("all three admin SET surfaces run the breach check AFTER the offline policy and BEFORE hashPassword", () => {
    const create = read("src/app/api/v1/admin/users/route.ts");
    const patch = read("src/app/api/v1/admin/users/[id]/route.ts");
    const reset = read("src/app/api/v1/admin/users/[id]/reset-password/route.ts");
    for (const source of [create, patch, reset]) {
      expect(source).toContain("breachIssueToFail, checkPasswordBreach");
      expect(source).toContain("return breachIssueToFail(breachIssue);");
      const policyAt = source.indexOf("validatePasswordPolicy(");
      const breachAt = source.indexOf("await checkPasswordBreach(");
      const hashAt = source.indexOf("hashPassword(");
      expect(policyAt).toBeGreaterThan(-1);
      expect(breachAt).toBeGreaterThan(policyAt);
      expect(hashAt).toBeGreaterThan(breachAt);
    }
    // Per-surface argument pins (create/PATCH carry the payload password;
    // reset carries the parsed reset password).
    expect(create).toContain("await checkPasswordBreach(data.password)");
    expect(patch).toContain("await checkPasswordBreach(data.password)");
    expect(reset).toContain("await checkPasswordBreach(parsed.data.password)");
    // The unavailable code renders byte-identically to a plain fail() because
    // breachIssueToFail omits an undefined detail — pinned by the envelope
    // test above; here we pin that the routes never hand-construct fail()
    // with the new codes (both propagate through breachIssueToFail), while
    // the docblocks may still NAME the codes for the reader.
    for (const source of [create, patch, reset]) {
      expect(source).not.toContain('fail("PASSWORD_BREACHED"');
      expect(source).not.toContain('fail("PASSWORD_BREACH_CHECK_UNAVAILABLE"');
    }
  });

  test("the login path never consults the breach check (options.ts stays plane-free)", () => {
    const options = read("src/lib/auth/options.ts");
    expect(options).not.toContain("checkPasswordBreach");
    expect(options).not.toContain("lib/auth/hibp");
    expect(options).not.toContain("PASSWORD_BREACHED");
  });

  test("the module owns the gate with injectable fetch, mode resolution, and typed failures", () => {
    const hibp = read("src/lib/auth/hibp.ts");
    expect(hibp).toContain("FAYANMS_HIBP_MODE");
    expect(hibp).toContain("FAYANMS_HIBP_TIMEOUT_MS");
    expect(hibp).toContain('"Add-Padding": "true"');
    expect(hibp).toContain("api.pwnedpasswords.com/range/");
    expect(hibp).toContain("fetchImpl?: typeof fetch");
    expect(hibp).toContain("PASSWORD_BREACHED");
    expect(hibp).toContain("PASSWORD_BREACH_CHECK_UNAVAILABLE");
    expect(hibp).toContain("No caching, no retries");
  });

  test("the .env.example block documents the mode + timeout + the fail-closed rationale", () => {
    const env = read(".env.example");
    expect(env).toContain("FAYANMS_HIBP_MODE=off");
    expect(env).toContain("FAYANMS_HIBP_TIMEOUT_MS=1500");
    expect(env).toContain("k-anonymity");
    expect(env).toContain("5-character SHA-1 prefix");
    expect(env).toContain("NEVER leave the process");
    expect(env).toContain("PASSWORD_BREACHED");
    expect(env).toContain("PASSWORD_BREACH_CHECK_UNAVAILABLE");
    expect(env).toContain("FAILS CLOSED");
    expect(env).toContain("no caching and no retries");
    expect(env).toContain("500..10000 (clamped), default 1500");
  });

  test("the operator docs retire the follow-up TODO and carry the honest limitations", () => {
    const runbook = read("docs/runbooks/deployment.md");
    expect(runbook).toContain("Password breach check — HIBP k-anonymity");
    expect(runbook).toContain("FAYANMS_HIBP_MODE");
    expect(runbook).toContain("PASSWORD_BREACH_CHECK_UNAVAILABLE");
    expect(runbook).toContain("5-character hash prefix");
    expect(runbook).toContain("no caching and no retries");
    expect(runbook).toContain("500–10000 ms");
    expect(runbook).toContain("rollback lever");

    const matrix = read("docs/security/authorization-matrix.md");
    expect(matrix).toContain("FAYANMS_HIBP_MODE=enforce");
    expect(matrix).toContain("PASSWORD_BREACHED");
    expect(matrix).toContain("never at login");

    // The password.ts docblock retires the old TODO language into
    // "shipped, config-gated" — the denylist's honest role remains.
    const passwordModule = read("src/lib/auth/password.ts");
    expect(passwordModule).toContain(
      "The documented production follow-up is SHIPPED and"
    );
    expect(passwordModule).toContain("CONFIG-GATED");
    expect(passwordModule).not.toContain("kept out of this change");
  });
});
