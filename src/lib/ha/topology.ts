/**
 * FayaNMS HA/DR topology (Phase 14-c).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ ⚠ DEMO DATA — DOCUMENTED SIMULATED HA/DR DESIGN                          │
 * │ The pairs, VIPs, DR mappings and RPO/RTO targets below are a DOCUMENTED  │
 * │ SIMULATION for the FayaNMS demo fleet. Pair members are REAL seeded      │
 * │ hostnames (prisma/seed.ts) and the readiness inputs are REAL database    │
 * │ signals, but the redundancy design itself is invented — this is NOT a    │
 * │ discovered/live topology and MUST NOT be used for real DR planning.      │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Everything in this module is deterministic and dependency-free:
 *   - HA_PAIRS / DR_SITES are static in-code matrices (style reference:
 *     src/lib/firmware/lifecycle.ts);
 *   - deriveFailoverState() derives the LATEST failover state of a pair
 *     purely from AuditEvent rows (audit-as-event-store — no schema, no
 *     new tables; every test writes HA_FAILOVER_TEST rows with a shared
 *     correlationId and { pairId, stage, result } metadata);
 *   - readinessScore() / deriveReadinessBand() / composeDrReadiness() are
 *     pure functions over the readiness inputs so GET /api/v1/ha returns
 *     identical scores for identical data (deterministic composition).
 */

/* ───────────────────────── HA pair definitions ───────────────────────── */

export type HaPairMode = "active-standby" | "active-active";

export interface HaPairDefinition {
  pairId: string;
  /** English canonical name (technical string — the view localizes modes). */
  name: string;
  mode: HaPairMode;
  /** Virtual IP the pair serves (simulated). */
  vip: string;
  /** Seed-stable site code of the pair's primary member. */
  siteCode: string;
  /** Exactly two REAL seed hostnames — [primary, secondary]. */
  members: [string, string];
}

export const HA_PAIRS: readonly HaPairDefinition[] = [
  {
    pairId: "ha-hq-core-sw",
    name: "HQ Core Switch Stack (SVL)",
    mode: "active-active",
    vip: "10.20.10.1",
    siteCode: "HQ-SAN",
    members: ["HQ-Core-SW-01", "HQ-Core-SW-02"],
  },
  {
    pairId: "ha-hq-wan-fw",
    name: "HQ WAN Firewall Cluster",
    mode: "active-standby",
    vip: "10.20.0.254",
    siteCode: "HQ-SAN",
    members: ["HQ-WAN-FW-01", "HQ-WAN-FW-02"],
  },
  {
    pairId: "ha-hq-core-rtr",
    name: "HQ Core Gateway (HSRP)",
    mode: "active-standby",
    vip: "10.20.1.1",
    siteCode: "HQ-SAN",
    members: ["HQ-Core-RTR-01", "HQ-Core-RTR-02"],
  },
  {
    pairId: "ha-dc-srv-tor",
    name: "DC Server ToR MLAG Pair",
    mode: "active-active",
    vip: "10.30.10.1",
    siteCode: "DC-ADN",
    members: ["DC-SRV-TOR-01", "DC-SRV-TOR-02"],
  },
  {
    pairId: "ha-wan-srx",
    name: "WAN SRX Redundancy Group",
    mode: "active-standby",
    vip: "10.99.0.1",
    siteCode: "HQ-SAN",
    // Cross-site hub/spoke redundancy group (HQ hub + BR2 spoke) — the
    // siteCode tracks the primary (hub) member's site.
    members: ["HQ-WAN-SRX-01", "BR2-SRX-02"],
  },
];

/** Every hostname referenced by HA_PAIRS (single lookup set for the API). */
export const HA_PAIR_HOSTNAMES: readonly string[] = [
  ...new Set(HA_PAIRS.flatMap((pair) => [...pair.members])),
];

export function findHaPair(pairId: string): HaPairDefinition | null {
  return HA_PAIRS.find((pair) => pair.pairId === pairId) ?? null;
}

/* ───────────────────────── DR site mapping ───────────────────────── */

export type ReplicationTech = "sync-mirror" | "async-snapshot";

export interface DrSiteDefinition {
  /** Seed-stable site code of the protected (primary) site. */
  primary: string;
  /** Seed-stable site code of the DR (secondary) site. */
  secondary: string;
  rpoTargetMinutes: number;
  rtoTargetMinutes: number;
  replicationTech: ReplicationTech;
}

export const DR_SITES: readonly DrSiteDefinition[] = [
  {
    primary: "HQ-SAN",
    secondary: "DC-ADN",
    rpoTargetMinutes: 15,
    rtoTargetMinutes: 60,
    replicationTech: "sync-mirror",
  },
  {
    primary: "DC-ADN",
    secondary: "HQ-SAN",
    rpoTargetMinutes: 60,
    rtoTargetMinutes: 240,
    replicationTech: "async-snapshot",
  },
  {
    primary: "BR1-HOD",
    secondary: "HQ-SAN",
    rpoTargetMinutes: 60,
    rtoTargetMinutes: 120,
    replicationTech: "async-snapshot",
  },
  {
    primary: "BR2-MUK",
    secondary: "HQ-SAN",
    rpoTargetMinutes: 60,
    rtoTargetMinutes: 120,
    replicationTech: "async-snapshot",
  },
];

/* ───────────────────── Failover state derivation (audit-as-event-store) ───────────────────── */

/** Minimal AuditEvent row shape the pure helper needs. */
export interface HaFailoverAuditRow {
  correlationId: string | null;
  createdAt: Date | string | number;
  afterJson: string | null;
}

/** Metadata written into afterJson for every HA_FAILOVER_TEST audit row. */
export interface HaFailoverStageMeta {
  pairId: string;
  stage: string;
  result: "passed" | "degraded";
  /** Promote/verify stage — the member the stage acted on. */
  member?: string;
  /** Complete stage — the active member after the test settled. */
  activeMember?: string;
  /** Complete stage — full simulated duration. */
  durationMs?: number;
  /** Degraded runs — the offline member hostnames that caused it. */
  offlineMembers?: string[];
}

export interface HaFailoverState {
  /** Active member after the latest test (pair-default when never tested). */
  activeMember: string;
  /** ISO timestamp of the latest complete row (null when never tested). */
  lastTestedAt: string | null;
  lastResult: "passed" | "degraded" | "never-tested";
  /** Number of distinct failover tests (distinct correlationIds). */
  testCount: number;
  /** CorrelationId of the latest test (null when never tested). */
  correlationId: string | null;
}

/** Default active member for a pair that has never been tested. */
export function defaultActiveMember(pair: {
  mode: HaPairMode;
  members: readonly string[];
}): string {
  return pair.mode === "active-active"
    ? `${pair.members[0]} + ${pair.members[1]}`
    : pair.members[0];
}

function parseStageMeta(raw: string | null): HaFailoverStageMeta | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as HaFailoverStageMeta).stage === "string" &&
      typeof (parsed as HaFailoverStageMeta).pairId === "string"
    ) {
      return parsed as HaFailoverStageMeta;
    }
  } catch {
    // Corrupt/foreign metadata — ignore the row rather than guess.
  }
  return null;
}

function rowTime(row: HaFailoverAuditRow): number {
  const time = new Date(row.createdAt).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/**
 * Derive the LATEST failover state of one pair from its HA_FAILOVER_TEST
 * audit rows (newest wins). Pure + deterministic: identical rows always
 * produce an identical state.
 */
export function deriveFailoverState(
  auditRows: readonly HaFailoverAuditRow[],
  pair: HaPairDefinition
): HaFailoverState {
  const rows = [...auditRows].sort((a, b) => rowTime(b) - rowTime(a));

  const testCount = new Set(
    rows
      .map((row) => row.correlationId)
      .filter((id): id is string => Boolean(id))
  ).size;

  const complete = rows
    .map((row) => ({ row, meta: parseStageMeta(row.afterJson) }))
    .find(
      (entry) =>
        entry.meta?.stage === "complete" && entry.meta.pairId === pair.pairId
    );

  if (complete?.meta) {
    return {
      activeMember: complete.meta.activeMember ?? defaultActiveMember(pair),
      lastTestedAt: new Date(complete.row.createdAt).toISOString(),
      lastResult: complete.meta.result === "degraded" ? "degraded" : "passed",
      testCount,
      correlationId: complete.row.correlationId,
    };
  }

  // Rows without a complete row (partial/legacy) — report the newest result
  // but keep the pair-default active member.
  const newest = rows
    .map((row) => ({ row, meta: parseStageMeta(row.afterJson) }))
    .find((entry) => entry.meta?.pairId === pair.pairId);
  if (
    newest?.meta &&
    (newest.meta.result === "passed" || newest.meta.result === "degraded")
  ) {
    return {
      activeMember: defaultActiveMember(pair),
      lastTestedAt: new Date(newest.row.createdAt).toISOString(),
      lastResult: newest.meta.result,
      testCount,
      correlationId: newest.row.correlationId,
    };
  }

  return {
    activeMember: defaultActiveMember(pair),
    lastTestedAt: null,
    lastResult: "never-tested",
    testCount: 0,
    correlationId: null,
  };
}

/* ───────────────────── Staged failover test (shared contract) ───────────────────── */

/**
 * Ordered stages of a deterministic failover test. "promote-back" runs for
 * active-standby pairs (the original primary takes over again); active-
 * active pairs run "keep-promoted" (load rebalances across both members).
 * The final "complete" row is written after the last stage (not part of
 * this list).
 */
export function failoverStagesForMode(mode: HaPairMode): readonly string[] {
  return mode === "active-standby"
    ? ["promote", "sync", "verify", "promote-back"]
    : ["promote", "sync", "verify", "keep-promoted"];
}

/**
 * Simulated per-stage duration (ms) — SHARED by the server route (actual
 * sleeps, ~4.2s total) and the view's staged progress ticker so both sides
 * walk the same deterministic cadence.
 */
export const FAILOVER_STAGE_SLEEP_MS: Record<string, number> = {
  promote: 900,
  sync: 1100,
  verify: 1000,
  "promote-back": 1200,
  "keep-promoted": 1200,
};

/* ───────────────────── Readiness scoring (deterministic) ───────────────────── */

export type HaReadinessBand = "healthy" | "degraded" | "at-risk";

export interface HaReadinessInput {
  /** 0–100 — % SUCCEEDED among recent CONFIG_BACKUP jobs of the site. */
  backupSuccessRate: number;
  /** Open SEV1 incidents touching the site. */
  openIncidentsCritical: number;
  /** 0–100 — % of the site's devices currently ONLINE. */
  memberUptimePct: number;
}

/**
 * Deterministic 0–100 readiness score (documented composition):
 *   score = 0.50 × backupSuccessRate        (protection quality, ≤ 50)
 *         + 0.35 × memberUptimePct          (infrastructure health, ≤ 35)
 *         + incidentCredit                  (headroom, ≤ 15)
 *   incidentCredit = 15 when no open critical incidents, otherwise
 *                    max(0, 15 − 5 × openIncidentsCritical).
 * Identical inputs always produce an identical score.
 */
export function readinessScore(input: HaReadinessInput): number {
  const backup = clamp0to100(input.backupSuccessRate);
  const uptime = clamp0to100(input.memberUptimePct);
  const incidentCredit =
    input.openIncidentsCritical <= 0
      ? 15
      : Math.max(0, 15 - 5 * input.openIncidentsCritical);
  const raw = 0.5 * backup + 0.35 * uptime + incidentCredit;
  return clamp0to100(Math.round(raw));
}

/** Band ladder (mirrors the firmware/predictive band style): ≥85 / ≥60 / else. */
export function deriveReadinessBand(score: number): HaReadinessBand {
  if (score >= 85) return "healthy";
  if (score >= 60) return "degraded";
  return "at-risk";
}

export interface HaReadiness {
  score: number;
  band: HaReadinessBand;
  /** 0–1 rounded to 2dp — % of the site's devices currently ONLINE. */
  memberOnlineRatio: number;
  /** 0–100 — recent CONFIG_BACKUP job success rate for the site. */
  backupSuccessRate: number;
  /** Open SEV1 incidents touching the site. */
  openCritical: number;
}

/**
 * Compose the full DR-readiness payload from its three real database
 * signals (pure — the API route gathers the inputs, this function scores).
 */
export function composeDrReadiness(input: {
  backupSuccessRate: number;
  openCritical: number;
  memberOnlineRatio: number;
}): HaReadiness {
  const memberOnlineRatio =
    Math.round(clamp0to1(input.memberOnlineRatio) * 100) / 100;
  const score = readinessScore({
    backupSuccessRate: input.backupSuccessRate,
    openIncidentsCritical: input.openCritical,
    memberUptimePct: memberOnlineRatio * 100,
  });
  return {
    score,
    band: deriveReadinessBand(score),
    backupSuccessRate: Math.round(clamp0to100(input.backupSuccessRate)),
    openCritical: Math.max(0, Math.floor(input.openCritical)),
    memberOnlineRatio,
  };
}

/* ───────────────────────── small utils ───────────────────────── */

function clamp0to100(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function clamp0to1(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
