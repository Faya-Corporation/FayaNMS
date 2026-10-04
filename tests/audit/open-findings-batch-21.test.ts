/**
 * Open-findings batch 21 — F-037 (P3, effort M):
 * per-packet SNMPv3 vault resolution + unauthenticated UDP flood amplification.
 *
 *   History: every datagram landing on the opt-in snmp-trap socket ran the
 *   FULL resolution pipeline — `nextPost(snmpv3-profile)` + vault
 *   `resolveVaultSecret` + `nextPost(…/accept)` — with a concurrency cap of
 *   32. With provider=file that is a secrets-file re-read per packet and
 *   with provider=exec a PROCESS SPAWN per packet: an unauthenticated UDP
 *   flood bought one vault round-trip per datagram (asymmetric
 *   attacker→defender cost). Worse, a socket bind failure was reported as
 *   `fayanms_worker_protocol_collector_up 1` — the metric conflated "enabled"
 *   for "healthy", so an operator could lose the trap listener with every
 *   dashboard showing green.
 *
 *   The closure is exactly the BACKLOG plan's named decision:
 *     1. TTL cache of resolved secrets, keyed per credential profile
 *        (credentialProfileId + secretRef), default 30s
 *        (SNMPV3_SECRET_CACHE_DEFAULT_TTL_MS; FAYANMS_SNMPV3_SECRET_CACHE_
 *        TTL_MS override clamped to [250ms, 600s]), bounded to 256 entries,
 *        cleared on stop() — resolved VALUES never outlive the collector.
 *        Cache entries never leak across profiles and the cached value is
 *        byte-identical to what resolveVaultSecret returned (fidelity is
 *        proven by USM auth: a cached wrong value cannot produce a
 *        wrong-accept, it fails closed as a rejected trap).
 *     2. Single-flight coalescing: concurrent packets for the same profile
 *        join ONE in-flight vault resolution instead of N parallel ones.
 *     3. `protocol_collector_up` is now derived (enabled + every configured
 *        socket bound, no bind failures) — bind failure reports 0 — with a
 *        matching FayanmsWorkerProtocolCollectorDown entry in the RT-030
 *        starter rules family.
 *     4. A synthetic 1k pps loopback soak (the lab-network stand-in) that
 *        measures the amplification before/after: 1000 vault resolutions
 *        → 1.
 *
 *   Rig notes: like batch 14 this is a pure unit suite — no DB rows, no
 *   app boot. The bind pins use REAL loopback UDP sockets on ephemeral high
 *   ports (a pre-bound holder socket manufactures EADDRINUSE). The soak
 *   sends real datagrams over loopback at ~1k pps and decodes them through
 *   the same decodeVerifiedSnmpV3Trap the collector's message handler
 *   calls; the app-plane nextPost hops are NOT part of this measurement
 *   (they need the Next.js process and remain per-packet by design — only
 *   the vault resolution was in the plan's scope). A REAL flood benchmark
 *   needs lab hardware beyond this sandbox.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SNMPV3_SECRET_CACHE_DEFAULT_TTL_MS,
  decodeVerifiedSnmpV3Trap,
  getProtocolCollectorMetrics,
  getSnmpV3SecretCacheStats,
  resetSnmpV3SecretCache,
  snmpv3SecretCacheTtlMs,
  startProtocolCollector,
  type SnmpV3ProfileReference,
} from "../../mini-services/worker/protocol-collector";
import { resolveVaultSecret } from "../../mini-services/worker/vault";
import {
  buildSnmpV3Trap,
  decodeSnmpV3Trap,
  readSnmpV3UsmIdentity,
} from "../../scripts/protocol-lab/snmpv3";
import { normalizeEngineIdHex } from "../../src/lib/protocol/snmpv3-policy";

/* ── env discipline: every touched variable recorded once, restored after ── */

const savedEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterAll(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetSnmpV3SecretCache();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error("timed out waiting for: " + label);
}

/* ── personas (simulated lab devices; engine IDs are enrolled stand-ins) ─── */

const ENGINE_A = Uint8Array.from([0x80, 0x00, 0x1f, 0x88, 0x80, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e]);
const ENGINE_B = Uint8Array.from([0x80, 0x00, 0x1f, 0x88, 0x80, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e]);
const ENGINE_SOAK = Uint8Array.from([0x80, 0x00, 0x1f, 0x88, 0x80, 0x5a, 0x5b, 0x5c, 0x5d, 0x5e]);

const profileA: SnmpV3ProfileReference = {
  credentialProfileId: "cred-f037-a",
  hostname: "router-f037-a",
  username: "trap-user-f037-a",
  secretRef: "vault://snmp/f037-a",
  engineIdHex: Buffer.from(ENGINE_A).toString("hex"),
};

const profileB: SnmpV3ProfileReference = {
  credentialProfileId: "cred-f037-b",
  hostname: "router-f037-b",
  username: "trap-user-f037-b",
  secretRef: "vault://snmp/f037-b",
  engineIdHex: Buffer.from(ENGINE_B).toString("hex"),
};

const remote = { address: "192.0.2.77", port: 40000 };

function trapPacket(engineId: Uint8Array, username: string, secret: string): Buffer {
  return Buffer.from(
    buildSnmpV3Trap({
      engineId,
      username,
      secret,
      notificationOid: "1.3.6.1.6.3.1.1.5.3",
      varBinds: [{ oid: "1.3.6.1.2.1.1.1.0", value: "f037" }],
    }),
  );
}

function enableEnvProvider(ref: "A" | "B" | "AB", secretA: string, secretB: string): void {
  setEnv("FAYANMS_VAULT_PROVIDER", "env");
  setEnv("FAYANMS_SNMPV3_SECRET_CACHE_TTL_MS", undefined);
  setEnv("FAYANMS_VAULT_SNMP_F037_A", ref === "B" ? undefined : secretA);
  setEnv("FAYANMS_VAULT_SNMP_F037_B", ref === "A" ? undefined : secretB);
}

/* ═══════════════════════════ source pins ═══════════════════════════════ */

describe("F-037 source pins", () => {
  const collectorSrc = Bun.file("mini-services/worker/protocol-collector.ts").text();
  const workerSrc = Bun.file("mini-services/worker/index.ts").text();
  const rulesSrc = Bun.file("monitoring/rules/fayanms-starter.yml").text();

  test("per-packet path consults the TTL cache, and the vault is reached ONLY through it", async () => {
    const src = await collectorSrc;
    // The decoder must await the cached resolver, not the raw vault.
    expect(src).toContain(
      "const secret = await resolveSnmpV3ProfileSecret(profile);",
    );
    // Exactly ONE resolveVaultSecret call site in the file — inside the
    // cache/single-flight layer (the import line carries no call parens).
    const callSites = src.match(/resolveVaultSecret\(/g) ?? [];
    expect(callSites.length).toBe(1);
    expect(src).toContain(
      "async function resolveSnmpV3ProfileSecret(\n  profile: SnmpV3ProfileReference,\n)",
    );
  });

  test("cache is keyed per profile, bounded, TTL-defaulted, and cleared on stop()", async () => {
    const src = await collectorSrc;
    expect(src).toContain(
      "export const SNMPV3_SECRET_CACHE_DEFAULT_TTL_MS = 30_000;",
    );
    expect(src).toContain("const SNMPV3_SECRET_CACHE_MAX_ENTRIES = 256;");
    // Key = credentialProfileId + secretRef → no cross-profile leakage.
    expect(src).toContain(
      'profile.credentialProfileId + "@" + profile.secretRef',
    );
    // stop() must not leave resolved VALUES in memory.
    expect(src).toMatch(/stop: \(\) => \{[\s\S]*?resetSnmpV3SecretCache\(\);[\s\S]*?\},/);
  });

  test("worker metric line reports the derived up signal, not bare enabled", async () => {
    expect(await workerSrc).toContain(
      "fayanms_worker_protocol_collector_up ${protocol.up ? 1 : 0}",
    );
  });

  test("RT-030 starter rules gained FayanmsWorkerProtocolCollectorDown in the family shape", async () => {
    const rules = await rulesSrc;
    const start = rules.indexOf("- alert: FayanmsWorkerProtocolCollectorDown");
    expect(start).toBeGreaterThan(-1);
    const rest = rules.slice(start);
    const next = rest.indexOf("\n      - alert:", 1);
    const block = rest.slice(0, next === -1 ? rest.length : next);
    expect(block).toContain("expr: fayanms_worker_protocol_collector_up == 0");
    expect(block).toMatch(/^\s*for:\s*5m$/m);
    expect(block).toMatch(/^\s*severity:\s*warning$/m);
    expect(block).toMatch(/^\s*component:\s*worker$/m);
    expect(block).toMatch(/^\s*summary:\s*"FayaNMS protocol collector/m);
    expect(block).toMatch(/^\s*description:\s*'/m);
    // Placement sanity: it lives inside the starter group after the
    // scheduler *_up entry (the RT-030 *_up family).
    expect(rules.indexOf("- alert: FayanmsWorkerSchedulerDown")).toBeLessThan(start);
  });
});

/* ═══════════════════ TTL knob (clamped override) pins ═══════════════════ */

describe("F-037 TTL knob", () => {
  test("default 30s; override clamped to the 250ms–600s window; garbage falls back", () => {
    setEnv("FAYANMS_SNMPV3_SECRET_CACHE_TTL_MS", undefined);
    expect(SNMPV3_SECRET_CACHE_DEFAULT_TTL_MS).toBe(30_000);
    expect(snmpv3SecretCacheTtlMs()).toBe(30_000);

    setEnv("FAYANMS_SNMPV3_SECRET_CACHE_TTL_MS", "50");
    expect(snmpv3SecretCacheTtlMs()).toBe(250); // low clamp — never effectively disabled

    setEnv("FAYANMS_SNMPV3_SECRET_CACHE_TTL_MS", "99999999");
    expect(snmpv3SecretCacheTtlMs()).toBe(600_000);

    setEnv("FAYANMS_SNMPV3_SECRET_CACHE_TTL_MS", "soon");
    expect(snmpv3SecretCacheTtlMs()).toBe(30_000);
  });
});

/* ═══════════════════ cache semantics (real env vault) ═══════════════════ */

describe("F-037 secret cache semantics", () => {
  test("hit inside the TTL window; cached value is value-faithful; rotation inside the window fails closed; expiry re-resolves", async () => {
    const secretA = randomBytes(24).toString("hex");
    const secretB = randomBytes(24).toString("hex");
    enableEnvProvider("A", secretA, secretB);
    resetSnmpV3SecretCache();

    const packetA = trapPacket(ENGINE_A, profileA.username, secretA);
    const packetA2 = trapPacket(ENGINE_A, profileA.username, secretA);
    const packetB = trapPacket(ENGINE_A, profileA.username, secretB);

    const before = getSnmpV3SecretCacheStats();

    // 1) First packet: one real vault resolution; USM verifies with the
    //    resolved value (fidelity: decode succeeds ONLY with secretA).
    const event1 = await decodeVerifiedSnmpV3Trap(packetA, remote, profileA);
    expect(event1.securityLevel).toBe("authPriv");
    expect(event1.deviceHint).toEqual({
      hostname: "router-f037-a",
      credentialProfileId: "cred-f037-a",
    });

    // 2) Second packet inside the window: served from cache, same value,
    //    still a valid authPriv verification.
    const event2 = await decodeVerifiedSnmpV3Trap(packetA2, remote, profileA);
    expect(event2.eventType).toBe("SNMP_TRAP");

    let stats = getSnmpV3SecretCacheStats();
    expect(stats.resolutions - before.resolutions).toBe(1);
    expect(stats.cacheHits - before.cacheHits).toBe(1);

    // 3) Rotation INSIDE the TTL window: the vault now holds secretB but the
    //    cached entry is still secretA → the trap signed with the new secret
    //    FAILS USM auth (fail-closed: never a wrong-accept).
    setEnv("FAYANMS_VAULT_SNMP_F037_A", secretB);
    await expect(
      decodeVerifiedSnmpV3Trap(packetB, remote, profileA),
    ).rejects.toThrow("SNMPv3 USM authentication failed");
    stats = getSnmpV3SecretCacheStats();
    expect(stats.resolutions - before.resolutions).toBe(1); // still no second vault trip

    // 4) Expiry: an entry's lifetime is fixed at cache time — so start a
    //    fresh entry under the SHORT TTL, confirm it serves hits inside the
    //    window, then wait past it: the entry expires and the SAME persona
    //    re-resolves from the vault (a rotation becomes effective exactly
    //    at expiry, not before).
    setEnv("FAYANMS_SNMPV3_SECRET_CACHE_TTL_MS", "250");
    resetSnmpV3SecretCache();
    const expBefore = getSnmpV3SecretCacheStats();

    const freshEntryEvent = await decodeVerifiedSnmpV3Trap(packetB, remote, profileA);
    expect(freshEntryEvent.eventType).toBe("SNMP_TRAP"); // fresh resolution → secretB
    await decodeVerifiedSnmpV3Trap(packetB, remote, profileA); // inside window → hit
    let expStats = getSnmpV3SecretCacheStats();
    expect(expStats.resolutions - expBefore.resolutions).toBe(1);
    expect(expStats.cacheHits - expBefore.cacheHits).toBe(1);

    await sleep(400); // past the 250ms TTL
    const postExpiryEvent = await decodeVerifiedSnmpV3Trap(packetB, remote, profileA);
    expect(postExpiryEvent.eventType).toBe("SNMP_TRAP"); // re-resolved → still secretB
    expStats = getSnmpV3SecretCacheStats();
    expect(expStats.resolutions - expBefore.resolutions).toBe(2);
    expect(expStats.expired - expBefore.expired).toBe(1);
    expect(expStats.entries).toBe(1);
  });

  test("per-profile isolation: profiles A and B never share cache entries", async () => {
    const secretA = randomBytes(24).toString("hex");
    const secretB = randomBytes(24).toString("hex");
    enableEnvProvider("AB", secretA, secretB);
    resetSnmpV3SecretCache();

    const packetA = trapPacket(ENGINE_A, profileA.username, secretA);
    const packetB = trapPacket(ENGINE_B, profileB.username, secretB);

    const before = getSnmpV3SecretCacheStats();

    const eventA = await decodeVerifiedSnmpV3Trap(packetA, remote, profileA);
    const eventB = await decodeVerifiedSnmpV3Trap(packetB, remote, profileB);
    expect(eventA.deviceHint?.credentialProfileId).toBe("cred-f037-a");
    expect(eventB.deviceHint?.credentialProfileId).toBe("cred-f037-b");

    // Two profiles ⇒ two distinct vault round-trips (B could NOT have
    // answered from A's entry)…
    let stats = getSnmpV3SecretCacheStats();
    expect(stats.resolutions - before.resolutions).toBe(2);
    expect(stats.cacheHits - before.cacheHits).toBe(0);

    // …and each profile now hits its OWN entry (value fidelity per profile:
    // both verifications succeed with their respective secrets).
    await decodeVerifiedSnmpV3Trap(packetA, remote, profileA);
    await decodeVerifiedSnmpV3Trap(packetB, remote, profileB);
    stats = getSnmpV3SecretCacheStats();
    expect(stats.resolutions - before.resolutions).toBe(2);
    expect(stats.cacheHits - before.cacheHits).toBe(2);
    expect(stats.entries).toBe(2);
  });

  test("single-flight: N concurrent packets for one profile cost exactly ONE vault resolution", async () => {
    const secretA = randomBytes(24).toString("hex");
    enableEnvProvider("A", secretA, "");
    resetSnmpV3SecretCache();

    const packet = trapPacket(ENGINE_A, profileA.username, secretA);
    const before = getSnmpV3SecretCacheStats();

    // Array.from invokes all 12 decodes synchronously — every one reaches
    // the cache/in-flight check before any microtask resolves the first
    // vault promise, so 11 MUST join the single in-flight resolution.
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        decodeVerifiedSnmpV3Trap(packet, remote, profileA),
      ),
    );
    expect(results.length).toBe(12);
    for (const event of results) expect(event.securityLevel).toBe("authPriv");

    let stats = getSnmpV3SecretCacheStats();
    expect(stats.resolutions - before.resolutions).toBe(1);
    expect(stats.coalesced - before.coalesced).toBe(11);
    expect(stats.cacheHits - before.cacheHits).toBe(0);

    // After the burst settles, the same persona rides the TTL cache.
    for (let i = 0; i < 5; i++) {
      await decodeVerifiedSnmpV3Trap(packet, remote, profileA);
    }
    stats = getSnmpV3SecretCacheStats();
    expect(stats.resolutions - before.resolutions).toBe(1);
    expect(stats.cacheHits - before.cacheHits).toBe(5);
  });
});

/* ═════════════ bind-fail honesty (real loopback sockets, ephemeral ports) ═════════════ */

describe("F-037 protocol_collector_up on bind outcomes", () => {
  function collectorEnv(port: number): void {
    setEnv("FAYANMS_PROTOCOL_COLLECTOR_ENABLED", "true");
    setEnv("FAYANMS_PROTOCOL_COLLECTOR_BIND", "127.0.0.1");
    setEnv("FAYANMS_SYSLOG_DISABLED", "true");
    setEnv("FAYANMS_NETFLOW_DISABLED", "true");
    setEnv("FAYANMS_IPFIX_DISABLED", "true");
    setEnv("FAYANMS_SFLOW_DISABLED", "true");
    setEnv("FAYANMS_SNMP_TRAP_PORT", String(port));
  }

  async function freeUdpPort(): Promise<number> {
    const probe = createSocket("udp4");
    await new Promise<void>((resolve) => probe.bind(0, "127.0.0.1", () => resolve()));
    const port = probe.address().port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  }

  test("healthy bind → up 1; stop() → up 0", async () => {
    collectorEnv(0); // port filled per attempt below (shared machine: retry)
    let handle: { stop: () => void } | null = null;
    try {
      // Loopback ephemeral ports are freed microseconds before the collector
      // binds; on a shared machine the port can be stolen in between. Retry
      // a fresh port on an observed bind failure instead of flaking.
      for (let attempt = 0; attempt < 3; attempt++) {
        setEnv("FAYANMS_SNMP_TRAP_PORT", String(await freeUdpPort()));
        const started = startProtocolCollector();
        expect(started).not.toBeNull();
        if (started === null) throw new Error("collector did not start");
        handle = started;
        await sleep(300); // bind callbacks settle
        const mid = getProtocolCollectorMetrics();
        if (mid.bindFailures === 0) break;
        started.stop();
        handle = null;
      }
      expect(handle).not.toBeNull();
      await waitFor(
        () => getProtocolCollectorMetrics().up === true,
        2_000,
        "collector bind to become healthy",
      );
      const metrics = getProtocolCollectorMetrics();
      expect(metrics.enabled).toBe(true);
      expect(metrics.sockets).toBe(1);
      expect(metrics.boundSockets).toBe(1);
      expect(metrics.bindFailures).toBe(0);
      expect(metrics.up).toBe(true);
    } finally {
      handle?.stop();
    }
    const afterStop = getProtocolCollectorMetrics();
    expect(afterStop.enabled).toBe(false);
    expect(afterStop.sockets).toBe(0);
    expect(afterStop.up).toBe(false);
  });

  test("bind failure (EADDRINUSE) → up 0 while enabled, boundSockets 0, bindFailures 1", async () => {
    const holder = createSocket("udp4");
    await new Promise<void>((resolve) => holder.bind(0, "127.0.0.1", () => resolve()));
    const occupied = holder.address().port;
    try {
      collectorEnv(occupied);
      const handle = startProtocolCollector();
      expect(handle).not.toBeNull();
      try {
        // The failure must be OBSERVED (error event → bindFailures), and the
        // derived up signal must be 0 — the F-037 fix (it stayed 1 before).
        await waitFor(
          () => getProtocolCollectorMetrics().bindFailures === 1,
          2_000,
          "bind failure to surface",
        );
        const metrics = getProtocolCollectorMetrics();
        expect(metrics.enabled).toBe(true);
        expect(metrics.sockets).toBe(1);
        expect(metrics.boundSockets).toBe(0);
        expect(metrics.bindFailures).toBe(1);
        expect(metrics.up).toBe(false);
      } finally {
        handle?.stop();
      }
      expect(getProtocolCollectorMetrics().up).toBe(false);
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });
});

/* ═══════════════════════ the 1k pps synthetic soak ═══════════════════════ */

describe("F-037 soak (loopback stand-in for the lab network)", () => {
  test("1k pps × 1000 datagrams × 1 persona: 1000 vault resolutions → 1 (before vs after)", async () => {
    // provider=file is the honest soak backend: the OLD path re-reads the
    // secrets JSON file PER PACKET (provider=exec would spawn per packet).
    const dir = mkdtempSync(join(tmpdir(), "f037-soak-"));
    const vaultFile = join(dir, "secrets.json");
    const soakSecret = randomBytes(24).toString("hex");
    writeFileSync(
      vaultFile,
      JSON.stringify({ "vault://snmp/soak-persona": soakSecret }),
      { mode: 0o600 },
    );
    setEnv("FAYANMS_VAULT_PROVIDER", "file");
    setEnv("FAYANMS_VAULT_FILE", vaultFile);
    setEnv("FAYANMS_SNMPV3_SECRET_CACHE_TTL_MS", undefined); // default 30s > soak duration

    const soakProfile: SnmpV3ProfileReference = {
      credentialProfileId: "cred-f037-soak",
      hostname: "router-f037-soak",
      username: "trap-user-soak",
      secretRef: "vault://snmp/soak-persona",
      engineIdHex: Buffer.from(ENGINE_SOAK).toString("hex"),
    };
    const packet = trapPacket(ENGINE_SOAK, soakProfile.username, soakSecret);

    /**
     * The PRE-F-037 per-packet body, replicated verbatim from the finding
     * (identity checks + per-packet resolveVaultSecret + USM decode) so the
     * "before" arm measures exactly the old amplification. The vault-call
     * counter IS the amplification metric.
     */
    let soakVaultCallsBefore = 0;
    const legacyPerPacketDecode = async (): Promise<void> => {
      const identity = readSnmpV3UsmIdentity(new Uint8Array(packet));
      if (identity.username !== soakProfile.username) {
        throw new Error("SNMPv3 profile username mismatch");
      }
      if (
        normalizeEngineIdHex(identity.engineId) !==
        soakProfile.engineIdHex.toLowerCase()
      ) {
        throw new Error("SNMPv3 profile engine ID mismatch");
      }
      soakVaultCallsBefore += 1; // provider=file: one full JSON re-read here
      const secret = await resolveVaultSecret(soakProfile.secretRef);
      decodeSnmpV3Trap(new Uint8Array(packet), {
        engineId: identity.engineId,
        username: soakProfile.username,
        secret,
      });
    };

    try {
      /* — BEFORE arm: old behavior, ~1k pps paced — */
      const beforeStart = performance.now();
      for (let i = 0; i < 1000; i++) {
        await legacyPerPacketDecode();
        await sleep(1); // ~1k pps pacing
      }
      const beforeMs = performance.now() - beforeStart;
      expect(soakVaultCallsBefore).toBe(1000);

      /* — AFTER arm: same 1k pps over a REAL loopback UDP socket, decoded by
            the exact per-packet verification function the collector uses — */
      resetSnmpV3SecretCache();
      const afterStatsStart = getSnmpV3SecretCacheStats();

      const receiver = createSocket("udp4");
      receiver.setRecvBufferSize(1_048_576);
      receiver.on("error", () => {});
      await new Promise<void>((resolve) => receiver.bind(0, "127.0.0.1", () => resolve()));
      const receiverPort = receiver.address().port;

      const sender = createSocket("udp4");
      sender.on("error", () => {});

      let received = 0;
      const decodeResults: Promise<unknown>[] = [];
      receiver.on("message", (msg, rinfo) => {
        received += 1;
        decodeResults.push(
          decodeVerifiedSnmpV3Trap(msg, {
            address: rinfo.address,
            port: rinfo.port,
          }, soakProfile),
        );
      });

      try {
        const afterStart = performance.now();
        for (let i = 0; i < 1000; i++) {
          await new Promise<void>((resolve, reject) =>
            sender.send(packet, receiverPort, "127.0.0.1", (err) =>
              err ? reject(err) : resolve(),
            ),
          );
          await sleep(1); // ~1k pps pacing
        }
        const afterMs = performance.now() - afterStart;
        await waitFor(() => received === 1000, 5_000, "all soak datagrams to arrive");
        const events = (await Promise.all(decodeResults)) as Array<{
          eventType: string;
          securityLevel: string;
        }>;
        expect(events.length).toBe(1000);
        for (const event of events) {
          expect(event.eventType).toBe("SNMP_TRAP");
          expect(event.securityLevel).toBe("authPriv");
        }

        const afterStats = getSnmpV3SecretCacheStats();
        const resolutions = afterStats.resolutions - afterStatsStart.resolutions;
        const servedFromCache =
          afterStats.cacheHits -
          afterStatsStart.cacheHits +
          (afterStats.coalesced - afterStatsStart.coalesced);

        // THE pin: 1000 datagrams, ONE vault round-trip, 999 answered from
        // the cache/single-flight layer. (Before: 1000 resolutions.)
        expect(resolutions).toBe(1);
        expect(servedFromCache).toBe(999);
        expect(afterStats.entries).toBe(1);
        expect(afterStats.expired).toBe(0); // TTL (30s) never elapsed mid-soak

        // Honest numbers for the worklog (no flaky wall-clock assertions —
        // count-based amplification is the contract; timing is reported).
        const beforePerSec = Math.round(1000 / (beforeMs / 1000));
        const afterPerSec = Math.round(1000 / (afterMs / 1000));
        console.log(
          `[F-037 soak] vault resolutions: 1000 (before) → ${resolutions} (after); ` +
            `cache-hit ratio ${(servedFromCache / 10).toFixed(1)}%; ` +
            `loopback achieved ~${beforePerSec} pps (before arm) vs ~${afterPerSec} pps (after arm); ` +
            `before arm ${beforeMs.toFixed(0)}ms, after arm ${afterMs.toFixed(0)}ms`,
        );
      } finally {
        await new Promise<void>((resolve) => sender.close(() => resolve()));
        await new Promise<void>((resolve) => receiver.close(() => resolve()));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000); // two ~1k-pps paced arms — well over the 5s default
});
