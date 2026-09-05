/**
 * FayaNMS worker — job runner.
 *
 * Every 3 s the runner claims QUEUED JobExecutions from the Next.js API
 * (POST /api/v1/worker/claim), executes them with a concurrency cap of 3 and
 * a per-job timeout of 30 s, and reports progress/completion back over HTTP.
 * The runner is a pure orchestration/simulation engine — no DB access.
 *
 * CONFIG_BACKUP step sequence (progress reported via /api/v1/worker/progress):
 *   5%  resolving device            15% connect (via self POST /simulate/connect)
 *   40–85% generate config (1–2 s simulated work, 1–2 progress posts)
 *   then POST /api/v1/worker/complete with the raw/normalized config text.
 *
 * DISCOVERY step sequence (roadmap 2-c):
 *   per subnet 1.2–2.5 s of simulated scanning, 2–4 candidate devices per
 *   subnet, progress = round(scanned/total*90) with a per-subnet message,
 *   then POST /api/v1/worker/complete with { candidates, scannedSubnets,
 *   durationMs }. Candidates are persistence-free: they land in the job's
 *   resultJson and the import flow turns them into real Device rows.
 *
 * Failure semantics live on the Next.js side: complete(FAILED) either requeues
 * with exponential-ish backoff (30 s * attempts) or dead-letters the job.
 * Any single job failure is contained — the loop never crashes.
 */

import { pickAdapter, sleep, randInt, type DeviceTarget } from "./adapters";
import { nextPost, selfPost, log } from "./next-client";

const CLAIM_INTERVAL_MS = 3_000;
const CONCURRENCY_CAP = 3;
const CLAIM_BATCH = 3;
const JOB_TIMEOUT_MS = 30_000;

export interface ClaimedJob {
  id: string;
  type: string;
  targetType?: string | null;
  targetId?: string | null;
  correlationId: string;
  attempts: number;
  maxAttempts: number;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

const counters = {
  claimed: 0,
  completed: 0,
  failed: 0,
  running: 0,
  completedByType: {} as Record<string, number>,
};

export function getCounters() {
  return { ...counters };
}

/** Bounded promise race: rejects with a clear message after `ms`. */
function raceTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function reportProgress(jobId: string, progress: number, message: string) {
  try {
    await nextPost("/api/v1/worker/progress", { jobId, progress, message }, 8_000);
  } catch (e) {
    await log(`progress post failed for ${jobId} @${progress}%: ${(e as Error).message}`);
  }
}

async function reportFailure(jobId: string, correlationId: string, message: string) {
  counters.failed += 1;
  try {
    await nextPost(
      "/api/v1/worker/complete",
      { jobId, outcome: "FAILED", error: message },
      10_000
    );
    await log(`job ${jobId} [${correlationId}] FAILED: ${message}`);
  } catch (e) {
    await log(`complete(FAILED) post failed for ${jobId}: ${(e as Error).message}`);
  }
}

/** CONFIG_BACKUP execution — throws on timeout/unreachable target. */
async function runBackupJob(job: ClaimedJob): Promise<void> {
  const payload = job.payload ?? {};
  const target: DeviceTarget = {
    deviceId: String(payload.deviceId ?? job.targetId ?? ""),
    hostname: String(payload.hostname ?? payload.name ?? "unknown"),
    name: typeof payload.name === "string" ? payload.name : undefined,
    vendor: String(payload.vendor ?? "generic"),
    model: (payload.model as string) ?? null,
    platform: (payload.platform as string) ?? null,
    firmware: (payload.firmware as string) ?? null,
    managementIp: (payload.managementIp as string) ?? null,
    status: (payload.status as string) ?? null,
  };

  if (!target.deviceId || target.deviceId === "null" || !payload.hostname) {
    throw new Error(
      "Unclaimable target: CONFIG_BACKUP payload carries no resolvable device (deviceId/hostname missing)"
    );
  }

  await reportProgress(job.id, 5, `Resolving device ${target.hostname} (${target.managementIp ?? "?"})`);

  if ((target.status ?? "").toUpperCase() === "OFFLINE") {
    // Realism: unreachable device — matches the seeded HQ-IDF-SW-01 failure story.
    throw new Error("SSH connection timed out after 30 s (device state: OFFLINE)");
  }

  // Connect step goes through the worker's own /simulate/connect endpoint
  // (spec step sequence) — same adapter code path the test-connection flow uses.
  const sim = (await selfPost("/simulate/connect", {
    vendor: target.vendor,
    host: target.managementIp ?? target.hostname,
    hostname: target.hostname,
  })) as { latencyMs?: number; negotiated?: string };

  const adapter = pickAdapter(target.vendor);
  await reportProgress(
    job.id,
    15,
    `Connected to ${target.hostname} via ${sim.negotiated ?? "ssh2"} in ${sim.latencyMs ?? "?"} ms`
  );

  const workMs = randInt(1_000, 2_000);
  await reportProgress(
    job.id,
    40,
    `Reading running-config from ${target.hostname} (flavor ${adapter.configFlavor})`
  );
  await sleep(Math.floor(workMs / 2));
  await reportProgress(
    job.id,
    randInt(70, 85),
    `Parsing ${adapter.configFlavor} configuration blocks`
  );
  await sleep(workMs - Math.floor(workMs / 2));

  const cfg = await adapter.fetchConfig(target);
  const bytes = new TextEncoder().encode(cfg.rawText).length;

  await nextPost(
    "/api/v1/worker/complete",
    {
      jobId: job.id,
      outcome: "SUCCEEDED",
      result: {
        rawText: cfg.rawText,
        normalizedText: cfg.normalizedText,
        configFlavor: adapter.configFlavor,
        bytes,
      },
    },
    15_000
  );

  counters.completed += 1;
  counters.completedByType.CONFIG_BACKUP =
    (counters.completedByType.CONFIG_BACKUP ?? 0) + 1;
  await log(
    `job ${job.id} [${job.correlationId}] SUCCEEDED: ${target.hostname} bytes=${bytes} flavor=${adapter.configFlavor}`
  );
}

/* ───────────────────────── DISCOVERY simulation ───────────────────────── */

/** Candidate vendors, weighted towards cisco/hpe like a real campus fleet. */
const DISCOVERY_VENDORS: { vendor: string; weight: number }[] = [
  { vendor: "cisco", weight: 4 },
  { vendor: "hpe", weight: 3 },
  { vendor: "fortinet", weight: 2 },
  { vendor: "sophos", weight: 2 },
  { vendor: "generic", weight: 1 },
];

const OS_FINGERPRINTS: Record<string, string[]> = {
  cisco: [
    "Cisco IOS 15.x banner",
    "Cisco IOS XE 17.x banner (SSH-2.0 Cisco)",
    "Cisco NX-OS 9.3 banner",
  ],
  fortinet: ["FortiGate FortiOS 7.x", "FortiGate FortiOS 7.4 banner"],
  sophos: ["Sophos SFOS 19.x banner", "Sophos SFOS 20.x banner"],
  hpe: ["HPE AOS-CX 10.x banner", "HPE AOS-CX 10.10 banner"],
  generic: ["Generic SNMP sysDescr (v2c)", "Unknown appliance SSH banner"],
};

const MODEL_GUESSES: Record<string, string[]> = {
  cisco: ["C9300-48P", "C9200L-24P-4G", "ISR4331", "WS-C2960X-24TS-L"],
  fortinet: ["FortiGate 120G", "FortiGate 90G", "FortiGate 201F"],
  sophos: ["XGS 1300", "XGS 2100", "XGS 87"],
  hpe: ["6200F 48G (JL727A)", "6100 24G (JL679A)", "3810M 24G"],
  generic: ["NetGate 6100", "Unmanaged appliance"],
};

function weightedVendor(): string {
  const total = DISCOVERY_VENDORS.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = Math.random() * total;
  for (const entry of DISCOVERY_VENDORS) {
    roll -= entry.weight;
    if (roll < 0) return entry.vendor;
  }
  return "generic";
}

const SUBNET_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

/** Loose CIDR validation: dotted quad + prefix 8..32. Throws on garbage. */
function parseSubnet(subnet: string): { baseInt: number; prefix: number } {
  const match = SUBNET_PATTERN.exec(subnet.trim());
  if (!match) {
    throw new Error(`Invalid subnet "${subnet}" — expected a.b.c.d/prefix`);
  }
  const octets = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
  ];
  if (octets.some((o) => o > 255)) {
    throw new Error(`Invalid subnet "${subnet}" — octet out of range`);
  }
  const prefix = Number(match[5]);
  if (prefix < 8 || prefix > 32) {
    throw new Error(`Invalid subnet "${subnet}" — prefix must be 8..32`);
  }
  const baseInt =
    ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  return { baseInt, prefix };
}

function intToIp(value: number): string {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join(".");
}

/** Host address inside the subnet: /24 → last octet 1..254, else base + offset. */
function hostAddress(baseInt: number, prefix: number): number {
  return prefix >= 24
    ? (baseInt & 0xffffff00) + randInt(1, 254)
    : baseInt + randInt(1, 254);
}

function candidateHostname(ip: string, vendor: string): string {
  const dashed = ip.replaceAll(".", "-");
  // Reverse-DNS-ish name for ~40% of hosts, neutral otherwise.
  const role = vendor === "cisco" || vendor === "hpe" ? "sw" : "unk";
  return Math.random() < 0.4
    ? `${role}-${dashed}.example.net`
    : `unk-${dashed}`;
}

/** DISCOVERY execution — simulates a per-subnet sweep and reports candidates. */
async function runDiscoveryJob(job: ClaimedJob): Promise<void> {
  const startedAt = Date.now();
  const payload = job.payload ?? {};
  const name = typeof payload.name === "string" && payload.name ? payload.name : null;
  const rawSubnets = Array.isArray(payload.subnets) ? payload.subnets : [];
  const subnets = rawSubnets.map((s) => String(s));

  if (subnets.length === 0) {
    throw new Error("Invalid discovery payload: subnets[] is empty or missing");
  }
  const parsed = subnets.map((s) => ({ subnet: s, ...parseSubnet(s) }));

  await reportProgress(
    job.id,
    3,
    `Starting${name ? ` "${name}"` : ""} scan of ${parsed.length} subnet${parsed.length === 1 ? "" : "s"} (ping/SNMP sweep)`
  );

  const candidates: Array<Record<string, unknown>> = [];
  let scanned = 0;

  for (const entry of parsed) {
    await sleep(randInt(1_200, 2_500));
    const found = randInt(2, 4);
    const usedHosts = new Set<number>();
    for (let i = 0; i < found; i += 1) {
      // Roll a unique host address within the subnet (12 tries is plenty
      // for 2–4 picks out of ≥254 addresses).
      let hostInt = 0;
      for (let tries = 0; tries < 12; tries += 1) {
        hostInt = hostAddress(entry.baseInt, entry.prefix);
        if (!usedHosts.has(hostInt)) break;
      }
      usedHosts.add(hostInt);
      const vendor = weightedVendor();
      const ip = intToIp(hostInt);
      const fingerprints = OS_FINGERPRINTS[vendor];
      const models = MODEL_GUESSES[vendor];
      candidates.push({
        ip,
        hostname: candidateHostname(ip, vendor),
        vendorGuess: vendor,
        modelGuess: models[randInt(0, models.length - 1)],
        mgmtPort: 22,
        protocols: ["ssh", "https"],
        confidence: randInt(60, 99),
        osFingerprint: fingerprints[randInt(0, fingerprints.length - 1)],
        discoveredAt: new Date().toISOString(),
      });
    }
    scanned += 1;
    await reportProgress(
      job.id,
      Math.round((scanned / parsed.length) * 90),
      `Scanned ${entry.subnet} — ${found} candidates`
    );
  }

  const durationMs = Date.now() - startedAt;
  await nextPost(
    "/api/v1/worker/complete",
    {
      jobId: job.id,
      outcome: "SUCCEEDED",
      result: {
        candidates,
        scannedSubnets: subnets.length,
        durationMs,
      },
    },
    15_000
  );

  counters.completed += 1;
  counters.completedByType.DISCOVERY = (counters.completedByType.DISCOVERY ?? 0) + 1;
  await log(
    `job ${job.id} [${job.correlationId}] SUCCEEDED: discovery scanned=${subnets.length} candidates=${candidates.length} durationMs=${durationMs}`
  );
}

async function executeJob(job: ClaimedJob): Promise<void> {
  try {
    if (job.type === "CONFIG_BACKUP") {
      await raceTimeout(runBackupJob(job), JOB_TIMEOUT_MS, `job ${job.id}`);
    } else if (job.type === "DISCOVERY") {
      await raceTimeout(runDiscoveryJob(job), JOB_TIMEOUT_MS, `job ${job.id}`);
    } else {
      throw new Error(`Unsupported job type for worker v1: ${job.type}`);
    }
  } catch (e) {
    await reportFailure(job.id, job.correlationId, (e as Error)?.message ?? String(e));
  }
}

let claiming = false;

async function claimTick(): Promise<void> {
  if (claiming) return;
  claiming = true;
  try {
    const free = CONCURRENCY_CAP - counters.running;
    if (free <= 0) return;
    const jobs = (await nextPost(
      "/api/v1/worker/claim",
      { types: ["CONFIG_BACKUP", "DISCOVERY"], limit: Math.min(CLAIM_BATCH, free) },
      10_000
    )) as ClaimedJob[];
    for (const job of Array.isArray(jobs) ? jobs : []) {
      counters.claimed += 1;
      counters.running += 1;
      await log(
        `claimed ${job.id} (${job.type}) corr=${job.correlationId} attempt=${job.attempts}/${job.maxAttempts}`
      );
      void executeJob(job).finally(() => {
        counters.running -= 1;
      });
    }
  } catch (e) {
    await log(`claim failed: ${(e as Error).message}`);
  } finally {
    claiming = false;
  }
}

export function startRunner(): void {
  log(
    `runner started: claim every ${CLAIM_INTERVAL_MS / 1000}s, batch ${CLAIM_BATCH}, concurrency ${CONCURRENCY_CAP}, per-job timeout ${JOB_TIMEOUT_MS / 1000}s`
  );
  void claimTick();
  setInterval(() => void claimTick(), CLAIM_INTERVAL_MS);
}
