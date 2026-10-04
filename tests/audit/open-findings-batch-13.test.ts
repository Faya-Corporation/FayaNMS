/**
 * Open-findings batch 13 — F-038 (P3, BACKLOG order):
 * discovery accepts public/link-local CIDRs the SSH dial plane refuses.
 *
 *   History: the SSH/SNMP dial plane refuses governed special-address
 *   classes (this-network, loopback, link-local, multicast, reserved)
 *   BEFORE any network work (src/lib/net/target-policy.ts, mirrored
 *   worker-side), but the discovery policy plane accepted ANY /24-/32
 *   CIDR unchecked — an app-plane actor could aim the worker's
 *   TCP-connect scanner at governed address classes the probe plane
 *   refuses (connect-only, but asymmetric with the documented probe
 *   policy).
 *
 *   The closure (the BACKLOG plan's named decision): EVERY enumerated
 *   discovery target of every policy subnet is classified with the
 *   app-plane classifier (evaluateTargetPolicy); a single governed-
 *   denied target refuses the WHOLE config (fail-closed), unless the
 *   documented lab hatch FAYANMS_PROBE_ALLOW_SPECIAL=true is set —
 *   shared with the probe plane, never silent (the accepted payload is
 *   the audited artifact). The gate lives in src/lib/discovery/policy.ts
 *   so it covers BOTH planes: the app routes (scan queueing + policy
 *   CRUD) AND the worker's runner, which re-validates every job payload
 *   through the same function (the worker never trusts the app plane).
 *
 *   The probe module itself (mini-services/worker/discovery.ts) stays
 *   deliberately policy-free — it is the bounded probe ENGINE, the
 *   policy layer decides what may be probed. Its loopback behavior is
 *   pinned unchanged (used directly by tests/discovery.test.ts).
 *
 * Same certified rig as batches 2-12 (tests/audit/open-findings-batch-
 * {2..12}.test.ts): REAL session tokens minted with the production
 * next-auth/jwt encoder (no mock.module — it is process-wide and
 * poisons later suites). Every identity these probes depend on is
 * SELF-CONTAINED via the rt012/rt014 ensure-helper pattern: the CI gate
 * replays ONLY `migrate deploy` (no demo seed), so the roles and users
 * are upserted here and never deleted.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";

import { db } from "../../src/lib/db";
import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";
import {
  enumerateDiscoveryPolicyTargets,
  firstGovernedDiscoverySubnet,
  normalizeDiscoveryPolicyConfig,
} from "../../src/lib/discovery/policy";
import { enumerateDiscoveryTargets } from "../../mini-services/worker/discovery";

/* ── env discipline (hermetic regardless of the shell's exports) ───────── */

const HATCH = "FAYANMS_PROBE_ALLOW_SPECIAL";
const savedHatch = process.env[HATCH];

/** Restore the hatch to the suite's DEFAULT posture: unset (strict gate). */
function strictHatch(): void {
  delete process.env[HATCH];
}

/* ── self-contained identity (the certified rt012/rt014 pattern) ────────── */

const userCache = new Map<string, { id: string; email: string; name: string | null; role: string }>();

async function ensureBatch13User(role: string) {
  const cached = userCache.get(role);
  if (cached) return cached;
  const matrixEntry = ROLE_MATRIX.find((entry) => entry.name === role);
  if (!matrixEntry) throw new Error(`role ${role} missing from ROLE_MATRIX`);
  await db.role.upsert({
    where: { name: role },
    update: {},
    create: {
      name: role,
      description: matrixEntry.description,
      permissionsJson: JSON.stringify([...matrixEntry.permissions]),
    },
  });
  const email = `batch13-${role}@faya.local`;
  const user = await db.user.upsert({
    where: { email },
    update: { isActive: true },
    create: {
      email,
      name: `Batch13 ${role}`,
      role,
      isActive: true,
      passwordHash: "batch13-test-no-login",
    },
    select: { id: true, email: true, name: true, role: true },
  });
  userCache.set(role, user);
  return user;
}

async function sessionHeaders(role: string): Promise<Record<string, string>> {
  const user = await ensureBatch13User(role);
  const token = await encode({
    token: { id: user.id, email: user.email, name: user.name ?? undefined, role: user.role },
    secret: process.env.NEXTAUTH_SECRET ?? "",
  });
  return { Cookie: `next-auth.session-token=${token}` };
}

/* ── request helpers (handler-level — the gate runs inside the handler) ── */

async function postScan(body: unknown, headers: Record<string, string>): Promise<Response> {
  const mod = await import("../../src/app/api/v1/discovery/route");
  return mod.POST(
    new NextRequest("http://app.local/api/v1/discovery", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

async function postPolicy(body: unknown, headers: Record<string, string>): Promise<Response> {
  const mod = await import("../../src/app/api/v1/discovery/policies/route");
  return mod.POST(
    new NextRequest("http://app.local/api/v1/discovery/policies", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

async function patchPolicy(
  id: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<Response> {
  const mod = await import("../../src/app/api/v1/discovery/policies/[id]/route");
  return mod.PATCH(
    new NextRequest(`http://app.local/api/v1/discovery/policies/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

type FailBody = { success: false; error: { code: string; message: string } };

async function failBody(res: Response): Promise<FailBody> {
  return (await res.json()) as FailBody;
}

/* ── A. the policy gate (unit matrix — no DB) ──────────────────────────── */

describe("F-038 (batch 13): the discovery policy gate mirrors the dial plane", () => {
  test("governed special-address subnets refuse the whole config", () => {
    strictHatch();
    const governed = [
      "0.0.0.0/24", // this-network
      "127.0.0.0/24", // loopback (/24)
      "127.0.0.1/32", // loopback (/32 — the documented probe example)
      "169.254.169.254/32", // cloud-metadata link-local
      "169.254.0.0/24", // link-local block
      "224.0.0.0/24", // multicast
      "239.255.255.0/24", // multicast upper edge
      "240.0.0.0/24", // reserved
      "255.255.255.0/24", // reserved upper edge
    ];
    for (const subnet of governed) {
      const config = normalizeDiscoveryPolicyConfig({ subnets: [subnet] });
      expect(config, subnet).toBeNull();
    }
  });

  test("allowed classes unchanged — no false positives at class boundaries", () => {
    strictHatch();
    const allowed = [
      "10.60.0.0/24", // private
      "172.16.0.0/24", // private (12-bit block lower edge)
      "192.168.1.0/24", // private
      "100.64.0.0/24", // cgnat
      "172.15.255.0/24", // PUBLIC — immediately below the 172.16/12 block
      "203.0.113.0/24", // public (TEST-NET-3)
      "9.9.9.9/32", // public single host
      "100.127.255.0/24", // cgnat upper edge
    ];
    for (const subnet of allowed) {
      const config = normalizeDiscoveryPolicyConfig({ subnets: [subnet] });
      expect(config, subnet).not.toBeNull();
      expect(config?.subnets).toEqual([subnet]);
    }
  });

  test("one governed subnet among clean ones refuses the WHOLE config (fail-closed)", () => {
    strictHatch();
    const config = normalizeDiscoveryPolicyConfig({
      subnets: ["10.60.0.0/24", "127.0.0.0/24"],
    });
    expect(config).toBeNull();
  });

  test("the documented FAYANMS_PROBE_ALLOW_SPECIAL=true lab hatch is honored", () => {
    try {
      process.env[HATCH] = "true";
      const config = normalizeDiscoveryPolicyConfig({ subnets: ["127.0.0.1/32"] });
      expect(config).not.toBeNull();
    } finally {
      if (savedHatch === undefined) delete process.env[HATCH];
      else process.env[HATCH] = savedHatch;
    }
  });

  test("firstGovernedDiscoverySubnet names the FIRST governed subnet + class", () => {
    strictHatch();
    expect(
      firstGovernedDiscoverySubnet(["10.60.0.0/24", "169.254.0.0/24", "127.0.0.0/24"]),
    ).toEqual({ subnet: "169.254.0.0/24", addressClass: "link-local" });
    expect(firstGovernedDiscoverySubnet(["10.60.0.0/24", "203.0.113.0/24"])).toBeNull();
    // Shape errors are the generic INVALID_POLICY path (null, not a refusal).
    expect(firstGovernedDiscoverySubnet(["not-a-cidr"])).toBeNull();
  });

  test("enumerateDiscoveryPolicyTargets mirrors the worker enumerator exactly", () => {
    for (const cidr of ["192.0.2.0/30", "192.0.2.10/32", "10.0.0.0/31", "10.60.0.0/24"]) {
      expect(enumerateDiscoveryPolicyTargets(cidr), cidr).toEqual(enumerateDiscoveryTargets(cidr));
    }
    // A /24 enumerates 254 hosts (network + broadcast excluded).
    expect(enumerateDiscoveryPolicyTargets("10.60.0.0/24")).toHaveLength(254);
    expect(enumerateDiscoveryPolicyTargets("10.60.0.0/24")?.[0]).toBe("10.60.0.1");
    expect(enumerateDiscoveryPolicyTargets("10.60.0.0/24")?.[253]).toBe("10.60.0.254");
    // Anything the worker enumerator throws on is null here.
    expect(enumerateDiscoveryPolicyTargets("192.0.2.0/23")).toBeNull();
    expect(enumerateDiscoveryPolicyTargets("not-a-cidr")).toBeNull();
    // FAIL-OPEN REGRESSION (caught pre-ship by this pin): a valid CIDR must
    // NEVER enumerate to an empty host set — the capture-index bug (the
    // worker's CAPTURING regex indexes match[5]; this module's NON-capturing
    // regex exposes the prefix at match[1]) produced Number(undefined)=NaN,
    // NaN<24=false, and an empty host set that silently passed every target.
    for (const cidr of ["127.0.0.1/32", "10.0.0.0/31", "10.60.0.0/24", "203.0.113.7/32"]) {
      const targets = enumerateDiscoveryPolicyTargets(cidr);
      expect(targets, cidr).not.toBeNull();
      expect((targets ?? []).length, cidr).toBeGreaterThan(0);
    }
    expect(enumerateDiscoveryPolicyTargets("127.0.0.1/32")).toEqual(["127.0.0.1"]);
  });

  test("an empty enumeration can never prove a subnet clean (fail-closed pin)", () => {
    strictHatch();
    // Direct evidence the gate refuses the documented probe example: every
    // target of 127.0.0.1/32 classifies loopback-denied.
    const config = normalizeDiscoveryPolicyConfig({ subnets: ["127.0.0.1/32"] });
    expect(config).toBeNull();
  });

  test("regression — the ORIGINAL policy bounds are still enforced", () => {
    strictHatch();
    expect(normalizeDiscoveryPolicyConfig({ subnets: ["10.0.0.0/23"] })).toBeNull(); // prefix < 24
    expect(normalizeDiscoveryPolicyConfig({ subnets: ["nope"] })).toBeNull(); // not a CIDR
    expect(
      normalizeDiscoveryPolicyConfig({
        subnets: ["10.0.0.0/24", "10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24", "10.0.4.0/24"],
      }),
    ).toBeNull(); // > 4 subnets
    expect(
      normalizeDiscoveryPolicyConfig({
        subnets: ["10.0.0.0/24", "10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"], // 4 × 254 = 1,016
      }),
    ).not.toBeNull(); // 1,016 ≤ 1,024
    expect(
      normalizeDiscoveryPolicyConfig({ subnets: ["10.0.0.0/24"], ports: [80, 9999] }),
    ).toBeNull(); // unapproved port
  });
});

/* ── B. handler pins (minted device.write session; the real routes) ─────── */

describe("F-038 (batch 13): the app routes refuse governed subnets with a precise detail", () => {
  test("POST /api/v1/discovery with a loopback subnet → 400 INVALID_POLICY (class + hatch named)", async () => {
    strictHatch();
    const res = await postScan(
      { subnets: ["127.0.0.1/32"] },
      await sessionHeaders("engineer"),
    );
    expect(res.status).toBe(400);
    const body = await failBody(res);
    expect(body.error.code).toBe("INVALID_POLICY");
    expect(body.error.message).toContain("governed address class (loopback)");
    expect(body.error.message).toContain("FAYANMS_PROBE_ALLOW_SPECIAL");
  });

  test("POST /api/v1/discovery with a malformed subnet → zod INVALID_BODY (the schema is tighter than the gate)", async () => {
    strictHatch();
    // The scan route's zod CIDR_PATTERN admits ONLY /24-/32 — a /23 dies at
    // INVALID_BODY and can never reach the policy gate. The GENERIC
    // INVALID_POLICY branch is reachable only via the PATCH route (its zod
    // has no regex), pinned right after the PATCH governed-class test.
    const res = await postScan(
      { subnets: ["10.0.0.0/23"] },
      await sessionHeaders("engineer"),
    );
    expect(res.status).toBe(400);
    const body = await failBody(res);
    expect(body.error.code).toBe("INVALID_BODY");
    expect(body.error.message).toContain("/24-/32 prefix");
  });

  test("POST /api/v1/discovery/policies with a link-local subnet → 400 (class named)", async () => {
    strictHatch();
    const res = await postPolicy(
      { name: "batch13-governed", subnets: ["169.254.0.0/24"] },
      await sessionHeaders("engineer"),
    );
    expect(res.status).toBe(400);
    const body = await failBody(res);
    expect(body.error.code).toBe("INVALID_POLICY");
    expect(body.error.message).toContain("governed address class (link-local)");
  });

  test("POST /api/v1/discovery/policies with a private subnet still succeeds", async () => {
    strictHatch();
    const res = await postPolicy(
      { name: `batch13-clean-${Date.now()}`, subnets: ["10.60.0.0/24"] },
      await sessionHeaders("engineer"),
    );
    expect(res.status).toBeLessThan(400);
    const body = (await res.json()) as { success: boolean; data?: { policy?: { id?: string } } };
    expect(body.success).toBe(true);
    expect(typeof body.data?.policy?.id).toBe("string");
  });

  test("PATCH /api/v1/discovery/policies/[id] to a this-network subnet → 400", async () => {
    strictHatch();
    // Self-contained fixture: create a clean policy as the same actor...
    const created = await postPolicy(
      { name: `batch13-patch-${Date.now()}`, subnets: ["10.70.0.0/24"] },
      await sessionHeaders("engineer"),
    );
    expect(created.status).toBeLessThan(400);
    const createdBody = (await created.json()) as { data?: { policy?: { id?: string } } };
    const id = createdBody.data?.policy?.id;
    expect(typeof id).toBe("string");

    // ...then try to retarget it at a governed class.
    const res = await patchPolicy(id as string, { subnets: ["0.0.0.0/24"] }, await sessionHeaders("engineer"));
    expect(res.status).toBe(400);
    const body = await failBody(res);
    expect(body.error.code).toBe("INVALID_POLICY");
    expect(body.error.message).toContain("governed address class (this-network)");

    // The GENERIC policy message stays reachable through the PATCH route
    // (its zod has no subnet regex, so normalize's original bounds decide):
    // a /23 is not governed — it refuses with the generic bounds message.
    const generic = await patchPolicy(id as string, { subnets: ["10.0.0.0/23"] }, await sessionHeaders("engineer"));
    expect(generic.status).toBe(400);
    const genericBody = await failBody(generic);
    expect(genericBody.error.code).toBe("INVALID_POLICY");
    expect(genericBody.error.message).toContain("/24-/32 subnets");
  });

  test("F-038 SUB-FIX — the policy-POST zod regex accepts real /24s again (was dead on arrival)", async () => {
    // The pre-F-038 schema regex had THREE octet groups: every valid
    // 4-octet CIDR failed INVALID_BODY (the whole policy-POST surface was
    // unusable) while malformed 3-octet shapes ("10.60.0/24") passed zod.
    // Source pin: four octet groups + the /24-/32 prefix alternation.
    const route = readFileSync("src/app/api/v1/discovery/policies/route.ts", "utf8");
    expect(route).toContain(
      "/^(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\/(3[0-2]|2[4-9])$/",
    );
    // Behavioral: a VALID /24 passes zod and reaches the policy gate (the
    // governed-class pin above would 400 with INVALID_POLICY, not
    // INVALID_BODY, for 169.254.0.0/24 — already pinned there).
    strictHatch();
    const bad = await postPolicy(
      { name: `batch13-shape-${Date.now()}`, subnets: ["10.60.0/24"] },
      await sessionHeaders("engineer"),
    );
    expect(bad.status).toBe(400);
    const badBody = await failBody(bad);
    expect(badBody.error.code).toBe("INVALID_BODY");
    expect(badBody.error.message).toContain("IPv4 /24-/32 subnet");
  });
});

/* ── C. worker-plane defense in depth + layering honesty (source pins) ──── */

describe("F-038 (batch 13): the worker re-validates payloads through the same gate", () => {
  const runner = readFileSync("mini-services/worker/runner.ts", "utf8");

  test("the runner guard reuses normalizeDiscoveryPolicyConfig (never trusts the app plane)", () => {
    expect(runner).toContain('normalizeDiscoveryPolicyConfig');
    expect(runner).toContain(
      "Invalid discovery payload: only bounded /24-/32 subnets, approved TCP ports, and non-governed address classes are allowed",
    );
  });

  test("the probe module stays policy-free — the POLICY layer decides (layering pin)", () => {
    strictHatch();
    // The worker probe ENGINE still enumerates loopback (it is bounded and
    // unauthenticated by design); the runner's policy guard is what refuses
    // a governed payload BEFORE enumeration ever happens.
    expect(enumerateDiscoveryTargets("127.0.0.1/32")).toEqual(["127.0.0.1"]);
    // ...while the same subnet refuses at the policy gate.
    expect(normalizeDiscoveryPolicyConfig({ subnets: ["127.0.0.1/32"] })).toBeNull();
  });
});

/* ── D. deployment contract: the worker image ships the COPY pair ───────── */

describe("F-038 (batch 13): the worker image COPY pair for the policy + classifier", () => {
  const dockerfile = readFileSync("Dockerfile.worker", "utf8");

  test("both the discovery policy AND its sibling classifier are COPYed", () => {
    expect(dockerfile).toContain(
      "COPY --chown=10001:10001 src/lib/discovery/policy.ts /src/lib/discovery/policy.ts",
    );
    expect(dockerfile).toContain(
      "COPY --chown=10001:10001 src/lib/net/target-policy.ts /src/lib/net/target-policy.ts",
    );
  });

  test("the policy module's import is RELATIVE (no '@/' alias inside the worker image)", () => {
    const policy = readFileSync("src/lib/discovery/policy.ts", "utf8");
    expect(policy).toContain('from "../net/target-policy"');
    expect(policy).not.toContain('from "@/lib/net/target-policy"');
  });
});

/* ── E. copy + documentation pins (never silent) ────────────────────────── */

describe("F-038 (batch 13): the operator-facing copy names the governed classes", () => {
  test("the discovery view's subnet helper (en + ar) carries the refusal clause", () => {
    const en = JSON.parse(readFileSync("messages/en.json", "utf8")) as {
      discoveryView?: { scan?: { helper?: string } };
    };
    const ar = JSON.parse(readFileSync("messages/ar.json", "utf8")) as {
      discoveryView?: { scan?: { helper?: string } };
    };
    expect(en.discoveryView?.scan?.helper ?? "").toContain("Governed blocks");
    expect(en.discoveryView?.scan?.helper ?? "").toContain("refused");
    expect(ar.discoveryView?.scan?.helper ?? "").toContain("تُرفض");
  });

  test(".env.example documents that the hatch also governs discovery subnets", () => {
    const env = readFileSync(".env.example", "utf8");
    expect(env).toContain("AND discovery subnets (F-038)");
  });

  test("the scan route docstring carries the F-038 contract", () => {
    const route = readFileSync("src/app/api/v1/discovery/route.ts", "utf8");
    expect(route).toContain("F-038: every enumerated target must classify");
  });
});
