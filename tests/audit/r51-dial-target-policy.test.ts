import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { DeviceTarget } from "../../mini-services/worker/adapters";
import {
  guardDialTarget,
  resolveAdapter,
  TargetPolicyError,
} from "../../mini-services/worker/adapter-router";
import { handle } from "../../mini-services/worker/index";
import { serviceAuthHeader } from "../../mini-services/worker/service-token";

/**
 * R51-A1 — the target network policy governs EVERY live dial plane.
 *
 * The Independent Production ReAudit (2026-09-18, finding F-1) proved the
 * R50-T022 resolved-address policy was enforced on the DETECTION probe
 * plane only, while the other live dial planes (CONFIG_BACKUP jobs,
 * /simulate/connect probes, /live/fetch-config, /live/apply) dialed the
 * raw payload address with vault-resolved credentials — a privileged
 * actor could register a device at 127.0.0.1 / 169.254.169.254 and the
 * worker would dial it. This suite pins the remediation:
 *
 *   - guardDialTarget: the resolved-address decision matrix (literals,
 *     hostnames, fail-closed RRsets, the documented lab hatch);
 *   - resolveAdapter: BOTH live transports (SSH + WebAPI) refuse a
 *     governed address BEFORE any vault/credential work, and the dial
 *     host returned to the adapter is the VALIDATED address;
 *   - the worker endpoints answer 400 SSH_TARGET_POLICY_REFUSED with the
 *     vault UNRESOLVABLE — proof the policy ran before any credential
 *     resolution — and the SIMULATOR plane is untouched (no policy: it
 *     never dials);
 *   - the runner's CONFIG_BACKUP path routes through resolveAdapter, so
 *     the same guard covers the job plane (wiring pin);
 *   - R51-A2: /api/v1/meta no longer selects credential-profile
 *     usernames (pre-auth bootstrap surface).
 *
 * Hermetic: no SSH personas — refusals happen BEFORE any connection by
 * construction, and that is exactly what the pins prove.
 */

const WORKER_INDEX = readFileSync("mini-services/worker/index.ts", "utf8");
const RUNNER = readFileSync("mini-services/worker/runner.ts", "utf8");
const META_ROUTE = readFileSync("src/app/api/v1/meta/route.ts", "utf8");

const savedHatch = process.env.FAYANMS_PROBE_ALLOW_SPECIAL;

/** A shape-valid OpenSSH fingerprint (never reached on refusals). */
function shapeValidFingerprint(): string {
  const digest = createHash("sha256").update("fayanms-r51-dial-policy").digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

const VALID_PIN = { fingerprint: shapeValidFingerprint() };
const VAULT_REF = "vault://ssh/r51-dial-policy";

afterAll(() => {
  if (savedHatch === undefined) delete process.env.FAYANMS_PROBE_ALLOW_SPECIAL;
  else process.env.FAYANMS_PROBE_ALLOW_SPECIAL = savedHatch;
});

describe("R51-A1 — guardDialTarget decision matrix", () => {
  test("loopback and link-local literals are refused with the class as detail", async () => {
    delete process.env.FAYANMS_PROBE_ALLOW_SPECIAL;
    for (const [host, cls] of [
      ["127.0.0.1", "loopback"],
      ["169.254.169.254", "link-local"],
    ] as const) {
      try {
        await guardDialTarget(host);
        expect.unreachable(`${host} must be refused`);
      } catch (e) {
        expect(e).toBeInstanceOf(TargetPolicyError);
        const err = e as TargetPolicyError;
        expect(err.code).toBe("SSH_TARGET_POLICY_REFUSED");
        expect(err.message).toContain(cls);
      }
    }
  });

  test("a hostname resolving into a governed class is refused (fail-closed RRset)", async () => {
    delete process.env.FAYANMS_PROBE_ALLOW_SPECIAL;
    const resolve4 = async (name: string): Promise<string[]> => {
      if (name === "rebind.internal") return ["10.1.2.3", "127.0.0.1"];
      return [];
    };
    try {
      await guardDialTarget("rebind.internal", resolve4);
      expect.unreachable("mixed RRset with one loopback candidate must refuse the whole name");
    } catch (e) {
      expect((e as TargetPolicyError).code).toBe("SSH_TARGET_POLICY_REFUSED");
    }
  });

  test("an allowed hostname returns the VALIDATED resolved address (no second lookup)", async () => {
    delete process.env.FAYANMS_PROBE_ALLOW_SPECIAL;
    const resolve4 = async (): Promise<string[]> => ["10.1.2.20", "10.1.2.3"];
    const dialed = await guardDialTarget("spine-01.lab", resolve4);
    // Deterministic numeric-ascending pick, mirroring the inventory rule.
    expect(dialed).toBe("10.1.2.3");
  });

  test("the documented FAYANMS_PROBE_ALLOW_SPECIAL=true lab hatch is honored", async () => {
    process.env.FAYANMS_PROBE_ALLOW_SPECIAL = "true";
    const dialed = await guardDialTarget("127.0.0.1");
    expect(dialed).toBe("127.0.0.1");
  });
});

describe("R51-A1 — resolveAdapter governs BOTH live transports", () => {
  const credential = { username: "netadmin", port: 22, secretRef: VAULT_REF };

  test("LIVE_SSH device at a loopback management IP → TargetPolicyError BEFORE vault resolution", async () => {
    delete process.env.FAYANMS_PROBE_ALLOW_SPECIAL;
    const target: DeviceTarget = {
      deviceId: "r51-a",
      hostname: "rogue-01",
      vendor: "cisco",
      managementIp: "127.0.0.1",
      dataSource: "LIVE_SSH",
    };
    try {
      await resolveAdapter(target, credential, { hostKeyPin: VALID_PIN.fingerprint });
      expect.unreachable("loopback live target must be refused");
    } catch (e) {
      // VaultError here would mean vault resolution ran first — it must not.
      expect(e).toBeInstanceOf(TargetPolicyError);
      expect((e as TargetPolicyError).code).toBe("SSH_TARGET_POLICY_REFUSED");
    }
  });

  test("LIVE WebAPI device at a link-local management IP → the same refusal (pre-vault)", async () => {
    delete process.env.FAYANMS_PROBE_ALLOW_SPECIAL;
    const target: DeviceTarget = {
      deviceId: "r51-b",
      hostname: "rogue-sophos",
      vendor: "sophos",
      managementIp: "169.254.169.254",
      dataSource: "LIVE_SSH",
    };
    try {
      await resolveAdapter(target, credential, { hostKeyPin: null });
      expect.unreachable("link-local WebAPI target must be refused");
    } catch (e) {
      expect(e).toBeInstanceOf(TargetPolicyError);
      expect((e as TargetPolicyError).code).toBe("SSH_TARGET_POLICY_REFUSED");
    }
  });

  test("SIMULATOR targets are NOT governed (the simulator never dials)", async () => {
    delete process.env.FAYANMS_PROBE_ALLOW_SPECIAL;
    const target: DeviceTarget = {
      deviceId: "r51-c",
      hostname: "sim-01",
      vendor: "cisco",
      managementIp: "127.0.0.1",
      dataSource: "SIMULATOR",
    };
    const adapter = await resolveAdapter(target, null);
    // The SIMULATOR plane resolves normally (label "cisco-ios", no live flavor).
    expect(adapter.adapter).toBe("cisco-ios");
    expect(adapter.capabilities).not.toContain("live");
  });
});

describe("R51-A1 — worker endpoints refuse governed dial planes (pre-vault proof)", () => {
  const call = (path: string, payload: unknown): Promise<Response> =>
    handle(
      new Request(`http://worker${path}`, {
        method: "POST",
        headers: {
          authorization: serviceAuthHeader(),
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
    );

  const credential = (port: number) => ({
    username: "netadmin",
    port,
    secretRef: VAULT_REF,
  });

  test("/live/fetch-config at 127.0.0.1 → 400 SSH_TARGET_POLICY_REFUSED with the vault UNRESOLVABLE", async () => {
    delete process.env.FAYANMS_PROBE_ALLOW_SPECIAL;
    // Deliberately NO vault provider value: if execution ever reached
    // resolveVaultSecret, the answer would be CREDENTIAL_UNRESOLVED —
    // receiving SSH_TARGET_POLICY_REFUSED proves the policy ran FIRST.
    const res = await call("/live/fetch-config", {
      vendor: "cisco",
      host: "127.0.0.1",
      hostname: "rogue-01",
      deviceId: "r51-d",
      credential: credential(22),
      sshHostKeyPin: VALID_PIN,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("SSH_TARGET_POLICY_REFUSED");
    expect(body.error).toContain("loopback");
  });

  test("/live/apply (controlled change) at 127.0.0.1 → 400 SSH_TARGET_POLICY_REFUSED before plan/vault", async () => {
    delete process.env.FAYANMS_PROBE_ALLOW_SPECIAL;
    const res = await call("/live/apply", {
      vendor: "cisco",
      host: "127.0.0.1",
      hostname: "rogue-01",
      credential: credential(22),
      // plan is deliberately absent — the refusal must fire BEFORE parsing.
      sshHostKeyPin: VALID_PIN,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("SSH_TARGET_POLICY_REFUSED");
  });

  test("/simulate/connect LIVE probe at 127.0.0.1 → 400 (the test-connection path is governed)", async () => {
    delete process.env.FAYANMS_PROBE_ALLOW_SPECIAL;
    const res = await call("/simulate/connect", {
      vendor: "cisco",
      host: "127.0.0.1",
      hostname: "rogue-01",
      deviceId: "r51-e",
      dataSource: "LIVE_SSH",
      credential: credential(22),
      sshHostKeyPin: VALID_PIN,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("SSH_TARGET_POLICY_REFUSED");
  });

  test("/simulate/connect SIMULATOR probe at 127.0.0.1 still succeeds (simulator unchanged)", async () => {
    delete process.env.FAYANMS_PROBE_ALLOW_SPECIAL;
    const res = await call("/simulate/connect", {
      vendor: "cisco",
      host: "127.0.0.1",
      hostname: "sim-01",
      deviceId: "r51-f",
      dataSource: "SIMULATOR",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

describe("R51-A1 — wiring pins (the job plane cannot bypass the guard)", () => {
  test("runner CONFIG_BACKUP resolves its adapter through resolveAdapter (guard-covered)", () => {
    const connectIdx = RUNNER.indexOf("await adapter.connect(target)");
    const resolveIdx = RUNNER.indexOf("await resolveAdapter(target, credential, { hostKeyPin })");
    expect(resolveIdx).toBeGreaterThan(-1);
    expect(connectIdx).toBeGreaterThan(resolveIdx);
  });

  test("/simulate/connect builds its target then dials via resolveAdapter (guard-covered)", () => {
    expect(WORKER_INDEX).toContain(
      "const adapter = await resolveAdapter(target, credential, { hostKeyPin, enrollmentMode });",
    );
    // The two direct live endpoints dial the VALIDATED address, never the raw literal.
    expect(WORKER_INDEX.match(/const dialHost = await guardDialTarget\(host\);/g)?.length).toBe(2);
  });
});

describe("R51-A2 — /api/v1/meta no longer discloses credential-profile usernames", () => {
  test("the reference select carries no username column (with a pin)", () => {
    // RT-024 (F-028): the reference data moved to the AUTHENTICATED
    // /api/v1/meta/reference — the pre-auth meta route no longer queries
    // credential profiles at all, and the R51-A2 pin moved with it.
    expect(META_ROUTE).not.toContain("credentialProfile");
    expect(META_ROUTE).not.toContain("type: true, username: true");
    const referenceRoute = readFileSync("src/app/api/v1/meta/reference/route.ts", "utf8");
    expect(referenceRoute).toContain("// R51-A2: no `username` here.");
    expect(referenceRoute).not.toContain("type: true, username: true");
  });
});
