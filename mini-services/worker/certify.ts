/**
 * FayaNMS LIVE_SSH certification driver (Phase 22 + Phase 23) — the CI gate
 * behind "the real-transport adapters work" and "controlled changes on live
 * devices work".
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
 *  5b.  SAFE-001 host-key pipeline (every flavor): the persona exposes its
 *       real host key; the ENROLL probe (enrollHostKey=true, no pin)
 *       captures it; a PINNED connection succeeds; a WRONG pin dies in the
 *       handshake with SSH_HOSTKEY_MISMATCH BEFORE authentication; an
 *       UNPINNED live probe/collection/apply is refused 400
 *       (SSH_HOSTKEY_UNENROLLED — fail-closed, no connection opened).
 *
 * Cross-cutting checks (once): unreachable target → SSH_UNREACHABLE,
 * missing vault entry → CREDENTIAL_UNRESOLVED, uncertified vendor (sophos)
 * → FLAVOR_UNSUPPORTED, LIVE_SSH without a credential block →
 * CREDENTIAL_REF_INVALID (routing + HTTP 400), simulator HTTP probe
 * unchanged.
 *
 * CONTROLLED-CHANGE section (Phase 23) — per flavor, over the REAL SSH
 * persona shells (config-mode CLIs that MUTATE their running-config):
 *   6.  invalid plan → PLAN_INVALID (HTTP 400, no device contact)
 *   7.  /live/apply APPLY plan → applied:true over a real PTY CLI session
 *   8.  post-apply fetchConfig reflects the delta (persona config mutated)
 *   9.  /live/apply ROLLBACK plan (original description / removal)
 *  10.  post-rollback fetchConfig restored
 * Plus: /live/fetch-config and /live/apply without a credential → 400.
 *
 * Certified flavors (slice 3): cisco (IOS), fortinet (FortiOS), hpe
 * (AOS-CX), juniper (Junos OS), palo (PAN-OS). Sophos is deliberately
 * uncertified — SFOS has no read-only SSH config dump; it needs a future
 * WebAPI transport.
 *
 * Exit code 0 = certified. Any failed check exits 1 with the CERT report.
 * Run: bun mini-services/worker/certify.ts
 */

import type { DeviceTarget } from "./adapters";
import {
  HOSTKEY_FINGERPRINT_RE,
  HostKeyPolicyError,
  parseHostKeyPin,
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
import {
  startJunosSshHarness,
  type JunosHarness,
} from "./harness/junos-sshd";
import {
  startPanosSshHarness,
  type PanosHarness,
} from "./harness/panos-sshd";
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
  startHarness: () => Promise<
    IOSHarness | FortiosHarness | AosCxHarness | JunosHarness | PanosHarness
  >;
  /** Phase 23 controlled-change parameters (anchor + markers) */
  change: {
    anchor: string;
    /** the description the anchor carries BEFORE any change (null = none) */
    original: string | null;
    applySlug: string;
  };
}

const FLAVOR_CERTS: FlavorCert[] = [
  {
    vendor: "cisco",
    hostname: "HARNESS-IOS-01",
    adapter: "cisco-ios-live",
    rawMarkers: ["Building configuration", "hostname HARNESS-IOS-01", "router ospf 1"],
    normalizedMarker: "interface Vlan10",
    startHarness: () => startIosSshHarness({ username: "netadmin", password: "faya-harness" }),
    change: { anchor: "GigabitEthernet0/1", original: "UPLINK-CORE-SW-01", applySlug: "FAYA-CHANGE-01" },
  },
  {
    vendor: "fortinet",
    hostname: "HARNESS-FTG-01",
    adapter: "fortinet-fortios-live",
    rawMarkers: ['set hostname "HARNESS-FTG-01"', "config firewall policy", "set srcintf \"lan\""],
    normalizedMarker: "config system interface",
    startHarness: () => startFortiosSshHarness({ username: "netadmin", password: "faya-harness" }),
    change: { anchor: "wan1", original: null, applySlug: "FAYA-CHANGE-01" },
  },
  {
    vendor: "hpe",
    hostname: "HARNESS-CX-01",
    adapter: "hpe-aos-cx-live",
    rawMarkers: ["hostname HARNESS-CX-01", "interface vlan 10", "ip address 10.40.10.2/24"],
    normalizedMarker: "interface 1/1/1",
    startHarness: () => startAosCxSshHarness({ username: "netadmin", password: "faya-harness" }),
    change: { anchor: "1/1/1", original: "UPLINK-CORE-SW-01", applySlug: "FAYA-CHANGE-01" },
  },
  {
    vendor: "juniper",
    hostname: "HARNESS-JN-01",
    adapter: "juniper-junos-live",
    rawMarkers: ["host-name HARNESS-JN-01;", "interfaces {", "security-zone UNTRUST"],
    normalizedMarker: "ge-0/0/1 {",
    startHarness: () => startJunosSshHarness({ username: "netadmin", password: "faya-harness" }),
    change: { anchor: "ge-0/0/0", original: "WAN-UPLINK-ISP-A", applySlug: "FAYA-CHANGE-01" },
  },
  {
    vendor: "palo",
    hostname: "HARNESS-PA-01",
    adapter: "palo-panos-live",
    rawMarkers: ["set deviceconfig system hostname HARNESS-PA-01", "set zone TRUST network layer3 ethernet1/2"],
    normalizedMarker: "set network interface ethernet ethernet1/1 link-state auto",
    startHarness: () => startPanosSshHarness({ username: "netadmin", password: "faya-harness" }),
    change: { anchor: "ethernet1/1", original: "WAN-UPLINK", applySlug: "FAYA-CHANGE-01" },
  },
];

async function main(): Promise<void> {
  console.log("FayaNMS LIVE_SSH certification — Phase 22 read-only + Phase 23 controlled change (5 certified flavors)");
  const harnesses: (IOSHarness | FortiosHarness | AosCxHarness | JunosHarness | PanosHarness)[] = [];
  try {
    for (const cert of FLAVOR_CERTS) {
      console.log(`\n── flavor: ${cert.vendor} (${cert.adapter}) ──`);
      const harness = await cert.startHarness();
      harnesses.push(harness);
      console.log(`harness: real SSH server on 127.0.0.1:${harness.port} (${cert.hostname})`);

      // ── SAFE-001: the persona's REAL host key is the pin for this flavor ──
      if (!harness.hostKeyFingerprint || !HOSTKEY_FINGERPRINT_RE.test(harness.hostKeyFingerprint)) {
        check(`${cert.vendor}: harness exposes its real host key (SAFE-001)`, false, String(harness.hostKeyFingerprint));
        continue;
      }
      const pin = harness.hostKeyFingerprint;
      const pinBlock = { fingerprint: pin };
      check(
        `${cert.vendor}: harness exposes its real host key (SAFE-001)`,
        harness.hostKeyType === "ssh-ed25519",
        `${harness.hostKeyType} ${pin}`,
      );

      const credential = parseTargetCredential({
        username: "netadmin",
        port: harness.port,
        secretRef: VAULT_REF,
      });
      const target = liveTarget(cert.hostname, cert.vendor);

      // ── 1. routing ──
      const live = resolveAdapter(target, credential, { hostKeyPin: pin });
      check(
        `${cert.vendor}: LIVE_SSH routes to the live adapter`,
        live.adapter === cert.adapter,
        live.adapter,
      );
      check(
        `${cert.vendor}: flavor registry agrees`,
        resolveLiveSshFlavor(cert.vendor).adapter === cert.adapter,
      );
      await expectError(
        `${cert.vendor}: unpinned live routing refused (SSH_HOSTKEY_UNENROLLED)`,
        "SSH_HOSTKEY_UNENROLLED",
        () => resolveAdapter(target, credential),
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

      // ── 4. wrong password → typed failure (with the CORRECT pin — proves
      // the pin passes the handshake and only the auth fails) ──
      const wrongPassword = createLiveSshAdapter(cert.vendor, {
        host: "127.0.0.1",
        port: harness.port,
        username: "netadmin",
        password: "definitely-wrong",
        expectedFingerprint: pin,
      });
      await expectError(
        `${cert.vendor}: wrong password → SSH_AUTH_FAILED`,
        "SSH_AUTH_FAILED",
        () => wrongPassword.connect(target),
      );

      // ── 4b. SAFE-001: wrong pin dies in the HANDSHAKE, pre-auth ──
      const wrongPin = `SHA256:${"A".repeat(43)}`;
      const pinMismatch = createLiveSshAdapter(cert.vendor, {
        host: "127.0.0.1",
        port: harness.port,
        username: "netadmin",
        password: "faya-harness",
        expectedFingerprint: wrongPin,
      });
      await expectError(
        `${cert.vendor}: wrong pin → SSH_HOSTKEY_MISMATCH (pre-auth)`,
        "SSH_HOSTKEY_MISMATCH",
        () => pinMismatch.connect(target),
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
        sshHostKeyPin: pinBlock,
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

      // ── 5b. SAFE-001 enrollment + fail-closed HTTP contracts ──
      const unpinnedRes = await post({
        vendor: cert.vendor,
        host: "127.0.0.1",
        hostname: cert.hostname,
        dataSource: "LIVE_SSH",
        credential: { username: "netadmin", port: harness.port, secretRef: VAULT_REF },
      });
      const unpinnedJson = (await unpinnedRes.json()) as Record<string, unknown>;
      check(
        `${cert.vendor}: HTTP live probe without pin → 400 SSH_HOSTKEY_UNENROLLED`,
        unpinnedRes.status === 400 &&
          String(unpinnedJson.error ?? "").includes("SSH_HOSTKEY_UNENROLLED"),
        `status ${unpinnedRes.status}`,
      );

      const enrollRes = await post({
        vendor: cert.vendor,
        host: "127.0.0.1",
        hostname: cert.hostname,
        dataSource: "LIVE_SSH",
        credential: { username: "netadmin", port: harness.port, secretRef: VAULT_REF },
        enrollHostKey: true,
      });
      const enrollJson = (await enrollRes.json()) as {
        ok?: boolean;
        hostKey?: { keyType?: string; fingerprint?: string };
      };
      check(
        `${cert.vendor}: enrollment probe captures the presented host key`,
        enrollRes.status === 200 &&
          enrollJson.ok === true &&
          enrollJson.hostKey?.keyType === "ssh-ed25519" &&
          enrollJson.hostKey?.fingerprint === pin,
        `status ${enrollRes.status}`,
      );

      /* ── Phase 23: controlled-change certification ── */
      const liveApply = (body: unknown) =>
        handle(
          new Request("http://worker/live/apply", {
            method: "POST",
            headers: {
              authorization: serviceAuthHeader(),
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          }),
        );

      // 6. An invalid plan must be rejected WITHOUT device contact.
      const evilRes = await liveApply({
        vendor: cert.vendor,
        host: "127.0.0.1",
        hostname: cert.hostname,
        credential: { username: "netadmin", port: harness.port, secretRef: VAULT_REF },
        sshHostKeyPin: pinBlock,
        plan: { kind: "APPLY", anchor: "bad anchor with spaces", slug: "X" },
      });
      check(
        `${cert.vendor}: invalid plan rejected (PLAN_INVALID, no device contact)`,
        evilRes.status === 400 &&
          String(((await evilRes.json()) as Record<string, unknown>).error ?? "").includes(
            "PLAN_INVALID",
          ),
        `status ${evilRes.status}`,
      );

      // 7. Controlled APPLY over the real PTY CLI session.
      const applyRes = await liveApply({
        vendor: cert.vendor,
        host: "127.0.0.1",
        hostname: cert.hostname,
        credential: { username: "netadmin", port: harness.port, secretRef: VAULT_REF },
        sshHostKeyPin: pinBlock,
        plan: {
          kind: "APPLY",
          anchor: cert.change.anchor,
          slug: cert.change.applySlug,
        },
      });
      const applyJson = (await applyRes.json()) as {
        ok?: boolean;
        applied?: boolean;
        commands?: string[];
      };
      check(
        `${cert.vendor}: controlled APPLY over real SSH session`,
        applyRes.status === 200 && applyJson.ok === true && applyJson.applied === true,
        `status ${applyRes.status} commands=${(applyJson.commands ?? []).length}`,
      );

      // 8. Post-apply fetch reflects the delta (persona config mutated).
      const appliedPassword = resolveVaultSecret(VAULT_REF);
      const postApplyAdapter = createLiveSshAdapter(cert.vendor, {
        host: "127.0.0.1",
        port: harness.port,
        username: "netadmin",
        password: appliedPassword,
        expectedFingerprint: pin,
      });
      const postApply = await postApplyAdapter.fetchConfig(target);
      const applyMarker =
        cert.vendor === "fortinet"
          ? `set description "${cert.change.applySlug}"`
          : cert.vendor === "palo"
            ? `comment "${cert.change.applySlug}"`
            : cert.vendor === "juniper"
              ? `description ${cert.change.applySlug};`
              : `description ${cert.change.applySlug}`;
      check(
        `${cert.vendor}: post-apply fetch reflects the applied delta`,
        postApply.rawText.includes(applyMarker),
        `marker "${applyMarker}"`,
      );

      // 9. Controlled ROLLBACK (restore original, or remove when none).
      const rollbackRes = await liveApply({
        vendor: cert.vendor,
        host: "127.0.0.1",
        hostname: cert.hostname,
        credential: { username: "netadmin", port: harness.port, secretRef: VAULT_REF },
        sshHostKeyPin: pinBlock,
        plan: {
          kind: "ROLLBACK",
          anchor: cert.change.anchor,
          slug: cert.change.original,
        },
      });
      const rollbackJson = (await rollbackRes.json()) as {
        ok?: boolean;
        applied?: boolean;
      };
      check(
        `${cert.vendor}: controlled ROLLBACK over real SSH session`,
        rollbackRes.status === 200 && rollbackJson.ok === true && rollbackJson.applied === true,
        `status ${rollbackRes.status}`,
      );

      // 10. Post-rollback fetch restored the original state.
      const postRollback = await postApplyAdapter.fetchConfig(target);
      check(
        `${cert.vendor}: post-rollback fetch restored the original config`,
        cert.change.original
          ? postRollback.rawText.includes(cert.change.original) &&
              !postRollback.rawText.includes(applyMarker)
          : !postRollback.rawText.includes(applyMarker),
      );

      // /live/fetch-config without credential → 400 (request-level).
      const fetchNoCred = await handle(
        new Request("http://worker/live/fetch-config", {
          method: "POST",
          headers: {
            authorization: serviceAuthHeader(),
            "content-type": "application/json",
          },
          body: JSON.stringify({ vendor: cert.vendor, host: "127.0.0.1" }),
        }),
      );
      check(
        `${cert.vendor}: /live/fetch-config without credential → 400`,
        fetchNoCred.status === 400,
        `status ${fetchNoCred.status}`,
      );

      // /live/fetch-config with credential but WITHOUT pin → 400 fail-closed.
      const fetchNoPin = await handle(
        new Request("http://worker/live/fetch-config", {
          method: "POST",
          headers: {
            authorization: serviceAuthHeader(),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            vendor: cert.vendor,
            host: "127.0.0.1",
            credential: { username: "netadmin", port: harness.port, secretRef: VAULT_REF },
          }),
        }),
      );
      const fetchNoPinJson = (await fetchNoPin.json()) as Record<string, unknown>;
      check(
        `${cert.vendor}: /live/fetch-config without pin → 400 SSH_HOSTKEY_UNENROLLED`,
        fetchNoPin.status === 400 &&
          String(fetchNoPinJson.error ?? "").includes("SSH_HOSTKEY_UNENROLLED"),
        `status ${fetchNoPin.status}`,
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

    // SAFE-001 — pin parsing contract (request-level, before any connection).
    check("pin parse: absent → null", parseHostKeyPin(null) === null && parseHostKeyPin(undefined) === null);
    const validFp = `SHA256:${"aZ09+/".slice(0, 1).repeat(43)}`;
    check("pin parse: valid fingerprint accepted", parseHostKeyPin({ fingerprint: validFp }) === validFp);
    for (const [label, raw] of [
      ["non-object", "SHA256:abc"],
      ["missing field", {}],
      ["empty", { fingerprint: "" }],
      ["missing prefix", { fingerprint: "a".repeat(43) }],
      ["too short", { fingerprint: `SHA256:${"a".repeat(42)}` }],
      ["bad charset", { fingerprint: `SHA256:${"@".repeat(43)}` }],
    ] as const) {
      try {
        parseHostKeyPin(raw);
        check(`pin parse: ${label} → SSH_HOSTKEY_PIN_INVALID`, false, "nothing thrown");
      } catch (e) {
        check(
          `pin parse: ${label} → SSH_HOSTKEY_PIN_INVALID`,
          e instanceof HostKeyPolicyError && e.code === "SSH_HOSTKEY_PIN_INVALID",
          errorCode(e),
        );
      }
    }

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
    `CERT RESULT: PASSED — LIVE_SSH read-only + controlled-change data plane certified (${FLAVOR_CERTS.length} flavors, protocol level)`,
  );
}

main().catch((err) => {
  console.error("certify driver crashed:", (err as Error)?.stack ?? err);
  process.exit(1);
});
