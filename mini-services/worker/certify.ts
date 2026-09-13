/**
 * FayaNMS LIVE_SSH certification driver (Phase 22 slice 1) — the CI gate
 * behind "the real-transport adapter works".
 *
 * Starts the in-process IOS SSH harness (a REAL SSH protocol server, see
 * harness/ios-sshd.ts) and drives the live data plane end-to-end:
 *
 *   1.  adapter routing: LIVE_SSH resolves to the live adapter, SIMULATOR
 *       targets keep the simulator adapters (zero-regression guarantee)
 *   2.  connect over REAL SSH (probe latency + negotiated)
 *   3.  fetchConfig over REAL SSH exec — vendor-realistic IOS payload,
 *       normalization contract holds
 *   4.  wrong password       → SSH_AUTH_FAILED (typed)
 *   5.  unreachable target   → SSH_UNREACHABLE/SSH_TIMEOUT (typed)
 *   6.  missing vault entry  → CREDENTIAL_UNRESOLVED (typed, fail-closed)
 *   7.  unsupported flavor   → FLAVOR_UNSUPPORTED (typed)
 *   8.  LIVE_SSH without a credential block → CREDENTIAL_REF_INVALID
 *   9.  HTTP routing: POST /simulate/connect with dataSource LIVE_SSH +
 *       a credential block (control token) — the exact surface the
 *       test-connection flow uses — plus the simulator body unchanged and
 *       the LIVE_SSH-without-credential rejection (400)
 *
 * Exit code 0 = certified. Any failed check exits 1 with the CERT report.
 * Run: bun mini-services/worker/certify.ts
 */

import type { DeviceTarget } from "./adapters";
import {
  parseTargetCredential,
  resolveAdapter,
} from "./adapter-router";
import { createLiveSshAdapter, LiveAdapterError, resolveLiveSshFlavor } from "./live-ssh";
import { sshProbe } from "./ssh-transport";
import { resolveVaultSecret, VaultError } from "./vault";
import { startIosSshHarness, type IOSHarness } from "./harness/ios-sshd";
import { serviceAuthHeader } from "./service-token";

// The worker verifies control tokens with FAYANMS_SERVICE_SECRET (process
// env first, repo .env fallback). CI has no .env — set a throwaway BEFORE
// importing the HTTP surface. Shape is irrelevant to the worker's HMAC
// verifier; this value never authenticates anything beyond this process.
process.env.FAYANMS_SERVICE_SECRET ||= "certify-throwaway-0123456789abcdef";
// The harness secret lives in the worker-side vault namespace.
process.env.FAYANMS_VAULT_SSH_HARNESS = "faya-harness";

const VAULT_REF = "vault://ssh/harness";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function errorCode(err: unknown): string {
  return (err as { code?: string })?.code ?? `<no-code:${(err as Error)?.name}>`;
}

async function expectError(
  name: string,
  expectedCode: string,
  fn: () => Promise<unknown> | unknown,
): Promise<void> {
  try {
    await fn();
    check(name, false, `expected ${expectedCode}, nothing was thrown`);
  } catch (err) {
    check(name, errorCode(err) === expectedCode, `got ${errorCode(err)}`);
  }
}

function liveTarget(): DeviceTarget {
  return {
    deviceId: "cert-live",
    hostname: "HARNESS-IOS-01",
    vendor: "cisco",
    managementIp: "127.0.0.1",
    dataSource: "LIVE_SSH",
    status: "ONLINE",
  };
}

async function main(): Promise<void> {
  console.log("FayaNMS LIVE_SSH certification — Phase 22 slice 1");
  const harness: IOSHarness = await startIosSshHarness({
    username: "netadmin",
    password: "faya-harness",
  });
  console.log(`harness: real SSH server on 127.0.0.1:${harness.port} (IOS 15.2 persona)`);

  try {
    const credential = parseTargetCredential({
      username: "netadmin",
      port: harness.port,
      secretRef: VAULT_REF,
    });

    // ── 1. routing ──
    const live = resolveAdapter(liveTarget(), credential);
    check("LIVE_SSH routes to the live adapter", live.adapter === "cisco-ios-live", live.adapter);
    const sim = resolveAdapter(
      { deviceId: "cert-sim", hostname: "sim-01", vendor: "cisco" },
      null,
    );
    check("SIMULATOR routing unchanged (zero regression)", sim.adapter === "cisco-ios", sim.adapter);
    await expectError(
      "LIVE_SSH without credential block rejected",
      "CREDENTIAL_REF_INVALID",
      () => resolveAdapter(liveTarget(), null),
    );

    // ── 2. connect over real SSH ──
    const conn = await live.connect(liveTarget());
    check("connect over real SSH", Number.isFinite(conn.latencyMs) && conn.latencyMs >= 0, `${conn.latencyMs} ms`);
    check("negotiated marks the real transport", conn.negotiated.includes("real"), conn.negotiated);

    // ── 3. config collection over real SSH exec ──
    const cfg = await live.fetchConfig(liveTarget());
    check(
      "raw config is the device payload (authentic IOS body)",
      cfg.rawText.includes("Building configuration") &&
        cfg.rawText.includes("hostname HARNESS-IOS-01") &&
        cfg.rawText.includes("router ospf 1") &&
        cfg.rawText.trimEnd().endsWith("end"),
    );
    const noCommentLines = !cfg.normalizedText
      .split("\n")
      .some((line) => line.trim().startsWith("!") || line.trim().startsWith("#"));
    check(
      "normalization contract holds on live output",
      noCommentLines && cfg.normalizedText.includes("interface Vlan10"),
      `${cfg.normalizedText.split("\n").length} normalized lines`,
    );

    // ── 4/5. typed transport failures ──
    const wrongPassword = createLiveSshAdapter("cisco", {
      host: "127.0.0.1",
      port: harness.port,
      username: "netadmin",
      password: "definitely-wrong",
    });
    await expectError("wrong password → SSH_AUTH_FAILED", "SSH_AUTH_FAILED", () =>
      wrongPassword.connect(liveTarget()),
    );
    await expectError("unreachable target → SSH_UNREACHABLE", "SSH_UNREACHABLE", () =>
      sshProbe({ host: "127.0.0.1", port: 1, username: "netadmin", password: "x" }, 3000),
    );

    // ── 6/7/8. typed routing/vault failures ──
    await expectError("missing vault entry → CREDENTIAL_UNRESOLVED", "CREDENTIAL_UNRESOLVED", () =>
      resolveVaultSecret("vault://ssh/missing-entry"),
    );
    await expectError("uncertified vendor → FLAVOR_UNSUPPORTED", "FLAVOR_UNSUPPORTED", () =>
      resolveLiveSshFlavor("fortinet"),
    );

    // ── 9. HTTP routing (the test-connection surface) ──
    const { handle } = await import("./index");
    const post = (body: unknown) =>
      handle(
        new Request("http://worker/simulate/connect", {
          method: "POST",
          headers: {
            authorization: serviceAuthHeader(),
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      );

    const liveRes = await post({
      vendor: "cisco",
      host: "127.0.0.1",
      hostname: "HARNESS-IOS-01",
      dataSource: "LIVE_SSH",
      credential: { username: "netadmin", port: harness.port, secretRef: VAULT_REF },
    });
    const liveJson = (await liveRes.json()) as Record<string, unknown>;
    check(
      "HTTP LIVE_SSH probe (test-connection surface)",
      liveRes.status === 200 && liveJson.ok === true && typeof liveJson.latencyMs === "number",
      `status ${liveRes.status}`,
    );

    const simRes = await post({ vendor: "cisco", host: "10.0.0.9", hostname: "SIM-TEST" });
    const simJson = (await simRes.json()) as Record<string, unknown>;
    check(
      "HTTP simulator probe unchanged",
      simRes.status === 200 && simJson.ok === true && simJson.adapter === "cisco-ios",
      `status ${simRes.status}`,
    );

    const badRes = await post({
      vendor: "cisco",
      host: "127.0.0.1",
      hostname: "HARNESS-IOS-01",
      dataSource: "LIVE_SSH",
    });
    const badJson = (await badRes.json()) as Record<string, unknown>;
    check(
      "HTTP LIVE_SSH without credential → 400",
      badRes.status === 400 && badJson.ok === false,
      `status ${badRes.status}`,
    );
  } finally {
    await harness.close();
  }

  console.log("");
  if (failures > 0) {
    console.log(`CERT RESULT: FAILED (${failures} check(s) failed)`);
    process.exit(1);
  }
  console.log("CERT RESULT: PASSED — LIVE_SSH read-only data plane certified (protocol level)");
}

main().catch((err) => {
  console.error("certify driver crashed:", (err as Error)?.stack ?? err);
  process.exit(1);
});
