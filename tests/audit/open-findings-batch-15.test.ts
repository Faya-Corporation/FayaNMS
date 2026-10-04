/**
 * Open-findings batch 15 — F-041 (P3, BACKLOG order):
 * the CLI session driver's 64 KiB self-trim desyncs scanFrom.
 *
 *   History: the Phase 23 CLI session driver (sshCliSession) accumulates
 *   device output in a bounded buffer that self-trims to its last 64 KiB
 *   once 128 KiB is crossed — but `scanFrom`, the scanner cursor marking
 *   where the CURRENT command's output starts, stayed at its stale
 *   ABSOLUTE offset. After a trim the cursor pointed past the (now
 *   shorter) buffer, so the prompt lookbehind scanned empty text: the
 *   device prompt was "never observed", the 10 s error timer fired, and
 *   the session aborted mid-plan (SSH_SESSION_FAILED). Fail-safe, but it
 *   failed a change SPURIOUSLY on any chatty device whose output crossed
 *   ~64-128 KiB — and it silently corrupted the captured output of every
 *   command that straddled a trim.
 *
 *   The closure (the BACKLOG plan's option 2 of 2): reset `scanFrom`
 *   TOGETHER WITH the trim. The trim+cursor logic is extracted into the
 *   pure trimCliBuffer(buffer, scanFrom, cap, keep) helper — the cursor
 *   shifts by exactly the dropped delta (clamped at 0) and stays a
 *   buffer-relative index, so every existing consumer (the prompt
 *   lookbehind, the per-command output slice) keeps its exact semantics
 *   with zero call-site changes. The rejected alternative (a ring buffer
 *   with monotonic offsets) would have threaded absolute offsets through
 *   waitForPrompt, the output slice, and the results for no behavioral
 *   gain — strictly more surface for the same invariant.
 *
 *   Persona certification (the plan's named shipped bar — real-hardware
 *   certification stays open in the README honest-status block): the
 *   >128 KiB session below runs against the REAL JunOS persona harness
 *   (harness/junos-sshd.ts — a genuine ssh2 SSH server whose CLI state
 *   machine MUTATES its running-config), driven through the production
 *   LIVE_CHANGE_FLAVORS.juniper.session contract. The SFOS persona is,
 *   by design, NOT an SSH CLI surface at all (sophos rides the WebAPI
 *   transport — live-ssh.ts/live-webapi.ts), so the trim path is
 *   structurally unreachable for sophos; that scope fact is pinned, and
 *   the SFOS WebAPI suite (tests/audit/sfos-webapi.test.ts) stays green
 *   unchanged. Rig notes: this sandbox ships without ssh-keygen, so the
 *   harness gained a pure-JS fallback host-key generator (still a REAL
 *   Ed25519 OpenSSH-format key — the harness remains a genuine SSH
 *   endpoint; CI's ssh-keygen path is unchanged and primary). The red
 *   run of the >128 KiB case against the UNFIXED driver reproduced the
 *   finding verbatim ("CLI prompt not observed — session aborted")
 *   before the fix was applied.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  sshCliSession,
  sshExecText,
  trimCliBuffer,
} from "../../mini-services/worker/ssh-transport";
import {
  LIVE_CHANGE_FLAVORS,
  applyLiveChangePlan,
  parseChangePlan,
  resolveLiveChangeFlavor,
} from "../../mini-services/worker/live-change";
import {
  JUNOS_SHOW_CONFIGURATION,
  startJunosSshHarness,
  type JunosHarness,
} from "../../mini-services/worker/harness/junos-sshd";

const WORKER_ROOT = new URL("../../mini-services/worker/", import.meta.url).pathname;

/* ── the chosen design, pinned purely (trimCliBuffer) ──────────────────── */

describe("F-041 — trimCliBuffer: the trim and the scanner cursor move together", () => {
  test("under the cap the buffer and cursor are returned untouched (identity)", () => {
    const buffer = "a".repeat(128_000); // exactly the production cap → no trim
    const out = trimCliBuffer(buffer, 101_234, 128_000, 64_000);
    expect(out.buffer).toBe(buffer);
    expect(out.scanFrom).toBe(101_234);
  });

  test("over the cap the head is dropped and the cursor shifts by EXACTLY the delta", () => {
    // 150_000 chars, cursor at 101_000 → dropped = 150_000 - 64_000 = 86_000
    // → cursor 101_000 - 86_000 = 15_000, buffer = last 64_000 chars.
    const buffer = `HEAD${"x".repeat(149_991)}TAIL`;
    const out = trimCliBuffer(buffer, 101_000, 128_000, 64_000);
    expect(out.buffer).toHaveLength(64_000);
    expect(out.buffer.endsWith("TAIL")).toBe(true);
    expect(out.scanFrom).toBe(101_000 - (buffer.length - 64_000));
  });

  test("core invariant: the cursor keeps pointing at the SAME logical position", () => {
    // A marker sits exactly at scanFrom before the trim; after the trim it
    // must sit at scanFrom' — the scanner never lands in dropped territory.
    const head = "h".repeat(100_000);
    const buffer = `${head}MARKER${"t".repeat(60_000)}`;
    const scanFrom = head.length;
    const out = trimCliBuffer(buffer, scanFrom, 128_000, 64_000);
    expect(out.scanFrom).toBeGreaterThanOrEqual(0);
    expect(out.buffer.slice(out.scanFrom, out.scanFrom + 6)).toBe("MARKER");
  });

  test("when the delta exceeds the cursor it clamps to 0 (the surviving tail IS the output)", () => {
    const out = trimCliBuffer("a".repeat(200_000), 50_000, 128_000, 64_000);
    expect(out.buffer).toHaveLength(64_000);
    expect(out.scanFrom).toBe(0);
  });

  test("the production driver wires the helper at the 128_000/64_000 cap — the inline self-trim is gone", () => {
    const source = readFileSync(`${WORKER_ROOT}ssh-transport.ts`, "utf8");
    // The wired call site: cap 128_000, keep 64_000, cursor shifted in-step.
    expect(source).toContain("trimCliBuffer(buffer + chunk.toString(), scanFrom, 128_000, 64_000)");
    // Regression tripwire: the old inline trim that desynced scanFrom.
    expect(source).not.toContain("buffer = buffer.slice(-64_000)");
    expect(source).not.toContain("buffer = buffer.slice(-32_000)");
  });
});

/* ── JunOS persona certification: real SSH, >128 KiB session ───────────── */

/**
 * Persona state math: the JunOS persona REPLACES ge-0/0/0's 37-char
 * description line ("        description WAN-UPLINK-ISP-A;") with a
 * (21 + pad)-char line, so body length = BASE + pad - 16 — exact, not
 * estimated. Pads are derived from the live persona constant so persona
 * edits can never silently break the trigger windows below.
 */
const BASE_BODY = JUNOS_SHOW_CONFIGURATION.length;
const padForBody = (bodyTarget: number): number => bodyTarget - BASE_BODY + 16;
const loudPad = (n: number, tail: string): string => `F4L${"X".repeat(n)}${tail}`;
const setDesc = (pad: string): string => `set interfaces ge-0/0/0 description "${pad}"`;
const JUNOS_CONFIG_PROMPT = "netadmin@HARNESS-JN-01#";
const JUNOS_OP_PROMPT = "netadmin@HARNESS-JN-01>";

// Body targets (see the window pins inside the test):
const B1 = 101_000; // show #1: cursor climbs past 64 KiB with NO trim yet
const B2 = 45_000; // show #2: accumulated output crosses 128 KiB → trim w/ stale cursor (pre-fix: abort)
const B3 = 137_000; // show #3: a SINGLE command output > 128 KiB (two trims)

describe("F-041 — JunOS persona certification (real SSH harness, >128 KiB output)", () => {
  const harnessPromise: Promise<JunosHarness> = startJunosSshHarness({
    username: "netadmin",
    password: "faya-harness",
  });

  const creds = async () => {
    const harness = await harnessPromise;
    expect(harness.hostKeyFingerprint).toBeTruthy();
    return {
      host: "127.0.0.1",
      port: harness.port,
      username: "netadmin",
      password: "faya-harness",
      expectedFingerprint: harness.hostKeyFingerprint,
    };
  };

  const showConfig = async (): Promise<string> =>
    sshExecText(await creds(), "show configuration");

  test(
    "control: the production change path (parseChangePlan → applyLiveChangePlan) applies and mutates the persona",
    async () => {
      const plan = parseChangePlan({ kind: "APPLY", anchor: "ge-0/0/1", slug: "FAYA-F041-CERT" });
      const result = await applyLiveChangePlan("juniper", await creds(), plan);
      expect(result.applied).toBe(true);
      expect(result.results.every((r) => r.ok)).toBe(true);
      expect(result.results.map((r) => r.command)).toEqual([
        "configure",
        'set interfaces ge-0/0/1 description "FAYA-F041-CERT"',
        "commit and-quit",
      ]);
      const body = await showConfig();
      expect(body).toContain("description FAYA-F041-CERT;");
    },
    45_000,
  );

  test(
    ">128 KiB session: the trim fires, the prompt is NEVER stranded, and the post-trim commands capture exact output",
    async () => {
      // A FRESH persona so the body-size arithmetic below stays exact (the
      // control test above mutated ge-0/0/1's line on the shared harness).
      const harness = await startJunosSshHarness({ username: "netadmin", password: "faya-harness" });
      try {
      const creds = {
        host: "127.0.0.1",
        port: harness.port,
        username: "netadmin",
        password: "faya-harness",
        expectedFingerprint: harness.hostKeyFingerprint,
      };
      const PAD1 = loudPad(padForBody(B1), "-T1");
      const PAD2 = loudPad(padForBody(B2), "-T2END");
      const PAD3 = loudPad(padForBody(B3), "-T3END");

      // Trigger-window pins (the desync's arithmetic, kept honest):
      // show #1 must NOT trim (cursor must still climb past 64 KiB).
      expect(B1).toBeGreaterThan(64_200);
      expect(B1 + BASE_BODY).toBeLessThan(108_000); // << 128_000 cap
      // show #2: accumulated output MUST cross the 128_000 cap…
      const bufferAtShow2 = B1 + BASE_BODY + 220; // prompts + mode banner + slack
      expect(bufferAtShow2 + B2 + BASE_BODY).toBeGreaterThan(128_000);
      // …but leave a post-trim tail (64_000 + overshoot) that can NEVER
      // reach the stale cursor's lookbehind (scanFrom - 200): that is what
      // made the pre-fix driver abort with "CLI prompt not observed".
      expect(B2 + BASE_BODY).toBeLessThan(63_800);
      // show #3 is a single output genuinely above 128 KiB.
      expect(B3 + BASE_BODY).toBeGreaterThan(128 * 1024);

      const commands = [
        "configure",
        setDesc(PAD1),
        "show configuration",
        setDesc(PAD2),
        "show configuration", // ← the trim fires here (accumulated > 128 KiB)
        setDesc(PAD3),
        "show configuration", // ← a single >128 KiB output (two trims)
        "commit and-quit",
      ];
      const results = await sshCliSession(
        creds,
        commands,
        LIVE_CHANGE_FLAVORS.juniper.session, // the PRODUCTION session contract
        25_000,
      );

      // The session completed — pre-fix this aborted at show #2 with
      // SSH_SESSION_FAILED "CLI prompt not observed" (red-proven).
      expect(results).toHaveLength(commands.length);
      expect(results.every((r) => r.ok)).toBe(true);

      const body1 = BASE_BODY + PAD1.length - 16;
      const body2 = BASE_BODY + PAD2.length - 16;
      const body3 = BASE_BODY + PAD3.length - 16;

      // show #1 (no trim): full body + prompt, head intact.
      expect(results[2]!.ok).toBe(true);
      expect(results[2]!.output.length).toBe(body1 + JUNOS_CONFIG_PROMPT.length);
      expect(results[2]!.output).toContain("-T1");
      expect(results[2]!.output.endsWith(JUNOS_CONFIG_PROMPT)).toBe(true);

      // show #2 (trim fired): scanFrom stayed consistent → the captured
      // output is EXACTLY this command's body + trimmed prompt — the same
      // code path pre-fix left empty/corrupted or stranded the prompt.
      expect(results[4]!.ok).toBe(true);
      expect(results[4]!.output.length).toBe(body2 + JUNOS_CONFIG_PROMPT.length);
      expect(results[4]!.output).toContain("-T2END");
      expect(results[4]!.output.endsWith(JUNOS_CONFIG_PROMPT)).toBe(true);

      // show #3 (a single >128 KiB output, two trims): bounded tail capture
      // (≥ 64 KiB kept) that still ends on the prompt and keeps the pad's
      // tail marker — no desync, no abort.
      expect(results[6]!.ok).toBe(true);
      expect(results[6]!.output.length).toBeGreaterThanOrEqual(64_000);
      expect(results[6]!.output).toContain("-T3END");
      expect(results[6]!.output.endsWith(JUNOS_CONFIG_PROMPT)).toBe(true);

      // THE scanFrom-consistency pin: the command AFTER all trims captures
      // its exact delta text — a stale cursor would produce "" or a wrong
      // tail (pre-fix it never even ran: the session was already aborted).
      expect(results[7]!.ok).toBe(true);
      expect(results[7]!.output).toBe(
        `commit complete\nExiting configuration mode\n${JUNOS_OP_PROMPT}`,
      );

      // The persona actually applied the last description (end-to-end proof
      // the session drove the device, not just survived it).
      const body = await sshExecText(creds, "show configuration");
      expect(body).toHaveLength(body3);
      expect(body).toContain("-T3END");
      } finally {
        await harness.close();
      }
    },
    45_000,
  );
});

/* ── SFOS persona scope: sophos rides the WebAPI plane (honest N/A) ────── */

describe("F-041 — SFOS persona scope: the trim path is structurally unreachable for sophos", () => {
  test("sophos has no CLI session contract — it cannot enter sshCliSession", () => {
    expect(Object.keys(LIVE_CHANGE_FLAVORS)).not.toContain("sophos");
    try {
      resolveLiveChangeFlavor("sophos");
      throw new Error("unreachable: sophos must not resolve to a change flavor");
    } catch (error) {
      expect((error as Error).name).toBe("LiveAdapterError");
      expect((error as Error & { code?: string }).code).toBe("FLAVOR_UNSUPPORTED");
    }
  });

  test("the SFOS harness is a WebAPI server, not an SSH CLI persona", async () => {
    const sfos = await import("../../mini-services/worker/harness/sfos-webapi");
    const exports = Object.keys(sfos);
    expect(exports).toContain("startSfosWebApiHarness");
    expect(exports.some((name) => /ssh/i.test(name))).toBe(false);
  });
});
