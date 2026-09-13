/**
 * FayaNMS LIVE_SSH certification driver (Phase 22) — the CI gate behind
 * "the real-transport adapters work".
 *
 * Starts the in-process protocol harnesses (REAL SSH servers, see
 * harness/*.ts — one persona per certified vendor) and drives the live
 * data plane end-to-end FOR EACH CERTIFIED FLAVOR:
 *
 *   1.  adapter routing: LIVE_SSH resolves to that flavor's live adapter;
 *       SIMULATOR targets keep the simulator adapters (zero-regression)
 *   2.  connect over REAL SSH (probe latency + negotiated)
 *   3.  fetchConfig over REAL SSH exec — vendor-realistic payload,
 *       normalization contract holds
 *   4.  wrong password → SSH_AUTH_FAILED (typed)
 *   5.  HTTP routing: POST /simulate/connect with dataSource LIVE_SSH +
 *       a credential block (control token) — the exact surface the
 *       test-connection flow uses
 *
 * Cross-cutting checks (once): unreachable target → SSH_UNREACHABLE,
 * missing vault entry → CREDENTIAL_UNRESOLVED, uncertified vendor (sophos)
 * → FLAVOR_UNSUPPORTED, LIVE_SSH without a credential block →
 * CREDENTIAL_REF_INVALID (routing + HTTP 400), simulator HTTP probe
 * unchanged.
 *
 * Certified flavors (slice 2): cisco (IOS), fortinet (FortiOS), hpe
 * (AOS-CX). Sophos is deliberately uncertified — SFOS has no read-only
 * SSH config dump; it needs a future WebAPI transport.
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
import {
  startIosSshHarness,
  type IOSHarness,
} from "./harness/ios-sshd";
import {
  startFortiosSshHarness,
  type FortiosHarness,
} from "./harness/fortios-sshd";
import {
  startAosCxSshHarness,
  type AosCxHarness,
} from "./harness/aoscx-sshd";
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

function liveTarget(hostname: string, vendor: string): DeviceTarget {
  return {
    deviceId: "cert-live",
    hostname,
    vendor,
    managementIp: "127.0.0.1",
    dataSource: "LIVE_SSH",
    status: "ONLINE",
  };
}

/** Per-flavor certification plan: persona harness + payload assertions. */
interface FlavorCert {
  vendor: string;
  hostname: string;
  adapter: string;
  /** one authoritative marker line from the persona's raw config payload */
  rawMarkers: string[];
  /** one structural line that must survive normalization */
  normalizedMarker: string;
  startHarness: () => Promise<IOSHarness | FortiosHarness | AosCxHarness>;
}

const FLAVOR_CERTS: FlavorCert[] = [
  {
    vendor: "cisco",
    hostname: "HARNESS-IOS-01",
    adapter: "cisco-ios-live",
    rawMarkers: ["Building configuration", "hostname HARNESS-IOS-01", "router ospf 1"],
    normalizedMarker: "interface Vlan10",
    startHarness: () => startIosSshHarness({ username: "netadmin", password: "faya-harness" }),
  },
  {
    vendor: "fortinet",
    hostname: "HARNESS-FTG-01",
    adapter: "fortinet-fortios-live",
    rawMarkers: ['set hostname "HARNESS-FTG-01"', "config firewall policy", "set srcintf \"lan\""],
    normalizedMarker: "config system interface",
    startHarness: () => startFortiosSshHarness({ username: "netadmin", password: "faya-harness" }),
  },
  {
    vendor: "hpe",
    hostname: "HARNESS-CX-01",
    adapter: "hpe-aos-cx-live",
    rawMarkers: ["hostname HARNESS-CX-01", "interface vlan 10", "ip address 10.40.10.2/24"],
    normalizedMarker: "interface 1/1/1",
    startHarness: () => startAosCxSshHarness({ username: "netadmin", password: "faya-harness" }),
  },
];

async function main(): Promise<void> {
  console.log("FayaNMS LIVE_SSH certification — Phase 22 (3 certified flavors)");
  const harnesses: (IOSHarness | FortiosHarness | AosCxHarness)[] = [];
  try {
    for (const cert of FLAVOR_CERTS) {
      console.log(`\n── flavor: ${cert.vendor} (${cert.adapter}) ──`);
      const harness = await cert.startHarness();
      harnesses.push(harness);
      console.log(`harness: real SSH server on 127.0.0.1:${harness.port} (${cert.hostname})`);

      const credential = parseTargetCredential({
        username: "netadmin",
        port: harness.port,
        secretRef: VAULT_REF,
      });
      const target = liveTarget(cert.hostname, cert.vendor);

      // ── 1. routing ──
      const live = resolveAdapter(target, credential);
      check(
        `${cert.vendor}: LIVE_SSH routes to the live adapter`,
        live.adapter === cert.adapter,
        live.adapter,
      );
      check(
        `${cert.vendor}: flavor registry agrees`,
        resolveLiveSshFlavor(cert.vendor).adapter === cert.adapter,
      );

      // ── 2. connect over real SSH ──
      const conn = await live.connect(target);
      check(
        `${cert.vendor}: connect over real SSH`,
        Number.isFinite(conn.latencyMs) && conn.latencyMs >= 0,
        `${conn.latencyMs} ms`,
      );
      check(
        `${cert.vendor}: negotiated marks the real transport`,
        conn.negotiated.includes("real"),
        conn.negotiated,
      );

      // ── 3. config collection over real SSH exec ──
      const cfg = await live.fetchConfig(target);
      check(
        `${cert.vendor}: raw config is the device payload (authentic body)`,
        cert.rawMarkers.every((m) => cfg.rawText.includes(m)),
      );
      const noCommentLines = !cfg.normalizedText
        .split("\n")
        .some((line) => line.trim().startsWith("!") || line.trim().startsWith("#"));
      check(
        `${cert.vendor}: normalization contract holds on live output`,
        noCommentLines && cfg.normalizedText.includes(cert.normalizedMarker),
        `${cfg.normalizedText.split("\n").length} normalized lines`,
      );

      // ── 4. wrong password → typed failure ──
      const wrongPassword = createLiveSshAdapter(cert.vendor, {
        host: "127.0.0.1",
        port: harness.port,
        username: "netadmin",
        password: "definitely-wrong",
      });
      await expectError(
        `${cert.vendor}: wrong password → SSH_AUTH_FAILED`,
        "SSH_AUTH_FAILED",
        () => wrongPassword.connect(target),
      );

      // ── 5. HTTP routing (the test-connection surface) ──
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
        vendor: cert.vendor,
        host: "127.0.0.1",
        hostname: cert.hostname,
        dataSource: "LIVE_SSH",
        credential: { username: "netadmin", port: harness.port, secretRef: VAULT_REF },
      });
      const liveJson = (await liveRes.json()) as Record<string, unknown>;
      check(
        `${cert.vendor}: HTTP LIVE_SSH probe (test-connection surface)`,
        liveRes.status === 200 &&
          liveJson.ok === true &&
          typeof liveJson.latencyMs === "number" &&
          liveJson.adapter === cert.adapter,
        `status ${liveRes.status}`,
      );

      const badRes = await post({
        vendor: cert.vendor,
        host: "127.0.0.1",
        hostname: cert.hostname,
        dataSource: "LIVE_SSH",
      });
      check(
        `${cert.vendor}: HTTP LIVE_SSH without credential → 400`,
        badRes.status === 400 && (await badRes.json()).ok === false,
        `status ${badRes.status}`,
      );
    }

    console.log("\n── cross-cutting contracts ──");

    // Simulator routing unchanged (zero regression).
    const sim = resolveAdapter(
      { deviceId: "cert-sim", hostname: "sim-01", vendor: "cisco" },
      null,
    );
    check("SIMULATOR routing unchanged (zero regression)", sim.adapter === "cisco-ios", sim.adapter);
    await expectError(
      "LIVE_SSH without credential block rejected (routing)",
      "CREDENTIAL_REF_INVALID",
      () => resolveAdapter(liveTarget("HARNESS-IOS-01", "cisco"), null),
    );
    await expectError(
      "unreachable target → SSH_UNREACHABLE",
      "SSH_UNREACHABLE",
      () => sshProbe({ host: "127.0.0.1", port: 1, username: "netadmin", password: "x" }, 3000),
    );
    await expectError("missing vault entry → CREDENTIAL_UNRESOLVED", "CREDENTIAL_UNRESOLVED", () =>
      resolveVaultSecret("vault://ssh/missing-entry"),
    );
    await expectError(
      "uncertified vendor (sophos) → FLAVOR_UNSUPPORTED",
      "FLAVOR_UNSUPPORTED",
      () => resolveLiveSshFlavor("sophos"),
    );

    // HTTP simulator probe unchanged.
    const { handle } = await import("./index");
    const simRes = await handle(
      new Request("http://worker/simulate/connect", {
        method: "POST",
        headers: {
          authorization: serviceAuthHeader(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ vendor: "cisco", host: "10.0.0.9", hostname: "SIM-TEST" }),
      }),
    );
    const simJson = (await simRes.json()) as Record<string, unknown>;
    check(
      "HTTP simulator probe unchanged",
      simRes.status === 200 && simJson.ok === true && simJson.adapter === "cisco-ios",
      `status ${simRes.status}`,
    );
  } finally {
    for (const harness of harnesses) {
      await harness.close();
    }
  }

  console.log("");
  if (failures > 0) {
    console.log(`CERT RESULT: FAILED (${failures} check(s) failed)`);
    process.exit(1);
  }
  console.log(
    `CERT RESULT: PASSED — LIVE_SSH read-only data plane certified (${FLAVOR_CERTS.length} flavors, protocol level)`,
  );
}

main().catch((err) => {
  console.error("certify driver crashed:", (err as Error)?.stack ?? err);
  process.exit(1);
});
