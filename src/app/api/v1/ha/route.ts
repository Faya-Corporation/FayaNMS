import { db } from "@/lib/db";
import { ok } from "../_lib/api";
import { INCIDENT_OPEN_STATUSES } from "@/lib/incidents/lifecycle";
import {
  composeDrReadiness,
  deriveFailoverState,
  DR_SITES,
  HA_PAIR_HOSTNAMES,
  HA_PAIRS,
} from "@/lib/ha/topology";
import { z } from "zod";

export const dynamic = "force-dynamic";

/* ─────────────────────────────────────────────────────────────────────────────
 * HA/DR topology — GET /api/v1/ha (Phase 14-c)
 *
 * Deterministic composition over REAL database signals + a static in-code
 * redundancy matrix (src/lib/ha/topology.ts — documented simulated design):
 *
 *   pairs   — HA_PAIRS members joined to the live Device rows (status/model/
 *             uptime straight from the DB) + the LATEST failover state derived
 *             from HA_FAILOVER_TEST AuditEvent rows (audit-as-event-store —
 *             no schema changes; tests write rows, this route reads them).
 *
 *   drSites — DR_SITES mapping enriched with a deterministic readiness score
 *             per PRIMARY site composed of three real signals:
 *               1. backupSuccessRate — % SUCCEEDED among the site's devices'
 *                  CONFIG_BACKUP jobs in the last 7 days (JobExecution
 *                  targetType DEVICE / targetId). When a site has no recent
 *                  jobs the score falls back to its device backupCompliance
 *                  ratio (COMPLIANT / total) so "no evidence" degrades the
 *                  score instead of quietly passing.
 *               2. openCritical — open SEV1 incidents touching the site
 *                  (incident.siteId OR linked via IncidentDevice).
 *               3. memberOnlineRatio — share of the site's devices ONLINE.
 *             score = 0.5·rate + 0.35·uptime% + ≤15 incident credit, banded
 *             healthy ≥ 85 · degraded ≥ 60 · else at-risk (see topology.ts).
 *
 * Bounded queries: 10 pair-member devices, ≤300 audit rows, 4 sites, one
 * ≤30-row device scan, ≤400 recent backup jobs, 4 indexed incident counts.
 * Read-only GET → no audit event (app convention). Identical data always
 * yields identical scores — two back-to-back GETs are byte-stable apart
 * from generatedAt (deterministic-composition contract).
 * ───────────────────────────────────────────────────────────────────────────── */

const BACKUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const AUDIT_TAKE = 300;
const JOB_TAKE = 400;

/* ── response schema (Zod-validated response contract) ── */

const memberSchema = z.object({
  deviceId: z.string(),
  hostname: z.string(),
  status: z.string(),
  model: z.string().nullable(),
  /** BigInt-as-string wire convention (interfaces/metrics precedent). */
  uptimeSeconds: z.string().nullable(),
});

const failoverSchema = z.object({
  activeMember: z.string(),
  lastTestedAt: z.string().nullable(),
  lastResult: z.enum(["passed", "degraded", "never-tested"]),
  testCount: z.number().int().min(0),
  correlationId: z.string().nullable(),
});

const pairSchema = z.object({
  pairId: z.string(),
  name: z.string(),
  mode: z.enum(["active-standby", "active-active"]),
  vip: z.string(),
  siteCode: z.string(),
  members: z.array(memberSchema).length(2),
  failover: failoverSchema,
});

const readinessSchema = z.object({
  score: z.number().int().min(0).max(100),
  band: z.enum(["healthy", "degraded", "at-risk"]),
  backupSuccessRate: z.number().min(0).max(100),
  openCritical: z.number().int().min(0),
  memberOnlineRatio: z.number().min(0).max(1),
});

const drSiteSchema = z.object({
  primary: z.string(),
  secondary: z.string(),
  rpoTargetMinutes: z.number().int().min(0),
  rtoTargetMinutes: z.number().int().min(0),
  replicationTech: z.enum(["sync-mirror", "async-snapshot"]),
  readiness: readinessSchema,
});

const responseSchema = z.object({
  pairs: z.array(pairSchema),
  drSites: z.array(drSiteSchema),
  meta: z.object({ generatedAt: z.string() }),
});

export type HaTopologyResponse = z.infer<typeof responseSchema>;

export async function GET(request: Request) {

  /* 1 — pair members, live from the DB (status is never guessed). */
  const memberDevices = await db.device.findMany({
    where: { hostname: { in: [...HA_PAIR_HOSTNAMES] } },
    select: {
      id: true,
      hostname: true,
      status: true,
      model: true,
      uptimeSeconds: true,
    },
  });
  const byHostname = new Map(memberDevices.map((d) => [d.hostname, d]));

  /* 2 — failover-test audit rows (audit-as-event-store, newest window). */
  const auditRows = await db.auditEvent.findMany({
    where: { action: "HA_FAILOVER_TEST", resourceType: "HaPair" },
    select: {
      resourceId: true,
      correlationId: true,
      createdAt: true,
      afterJson: true,
    },
    orderBy: { createdAt: "desc" },
    take: AUDIT_TAKE,
  });
  const auditByPair = new Map<string, typeof auditRows>();
  for (const row of auditRows) {
    if (!row.resourceId) continue;
    const bucket = auditByPair.get(row.resourceId);
    if (bucket) bucket.push(row);
    else auditByPair.set(row.resourceId, [row]);
  }

  const pairs = HA_PAIRS.map((pair) => {
    const members = pair.members.map((hostname) => {
      const device = byHostname.get(hostname);
      return {
        deviceId: device?.id ?? hostname,
        hostname,
        status: device?.status ?? "UNKNOWN",
        model: device?.model ?? null,
        uptimeSeconds:
          device?.uptimeSeconds != null ? device.uptimeSeconds.toString() : null,
      };
    });
    return {
      pairId: pair.pairId,
      name: pair.name,
      mode: pair.mode,
      vip: pair.vip,
      siteCode: pair.siteCode,
      members,
      failover: deriveFailoverState(auditByPair.get(pair.pairId) ?? [], pair),
    };
  });

  /* 3 — DR readiness inputs, gathered in bounded bulk queries. */
  const sites = await db.site.findMany({ select: { id: true, code: true } });
  const siteIdByCode = new Map(sites.map((s) => [s.code, s.id]));

  const drSiteIds = [
    ...new Set(
      DR_SITES.map((dr) => siteIdByCode.get(dr.primary)).filter(
        (id): id is string => Boolean(id)
      )
    ),
  ];

  const siteDevices = await db.device.findMany({
    where: { siteId: { in: drSiteIds } },
    select: { id: true, siteId: true, status: true, backupCompliance: true },
  });
  const deviceIdsBySite = new Map<string, string[]>();
  for (const device of siteDevices) {
    if (!device.siteId) continue;
    const bucket = deviceIdsBySite.get(device.siteId);
    if (bucket) bucket.push(device.id);
    else deviceIdsBySite.set(device.siteId, [device.id]);
  }
  const deviceIdToSite = new Map(
    siteDevices.map((d) => [d.id, d.siteId ?? ""])
  );

  const since = new Date(Date.now() - BACKUP_WINDOW_MS);
  const allSiteDeviceIds = [...deviceIdToSite.keys()];
  const backupJobs = await db.jobExecution.findMany({
    where: {
      type: "CONFIG_BACKUP",
      status: { in: ["SUCCEEDED", "FAILED"] },
      targetType: "DEVICE",
      targetId: { in: allSiteDeviceIds },
      createdAt: { gte: since },
    },
    select: { targetId: true, status: true },
    orderBy: { createdAt: "desc" },
    take: JOB_TAKE,
  });
  const jobStatsBySite = new Map<string, { ok: number; total: number }>();
  for (const job of backupJobs) {
    const siteId = deviceIdToSite.get(job.targetId ?? "");
    if (!siteId) continue;
    const stats = jobStatsBySite.get(siteId) ?? { ok: 0, total: 0 };
    stats.total += 1;
    if (job.status === "SUCCEEDED") stats.ok += 1;
    jobStatsBySite.set(siteId, stats);
  }

  const drSites = await Promise.all(
    DR_SITES.map(async (dr) => {
      const siteId = siteIdByCode.get(dr.primary) ?? "";
      const devices = siteDevices.filter((d) => d.siteId === siteId);
      const total = devices.length;
      const online = devices.filter((d) => d.status === "ONLINE").length;

      // Backup success rate — job-based when the window has evidence,
      // device backupCompliance ratio otherwise (documented fallback).
      const stats = jobStatsBySite.get(siteId);
      const backupSuccessRate =
        stats && stats.total > 0
          ? (stats.ok / stats.total) * 100
          : total > 0
            ? (devices.filter((d) => d.backupCompliance === "COMPLIANT")
                .length /
                total) *
              100
            : 0;

      // Open SEV1 incidents touching the site (direct OR device-linked).
      const openCritical = siteId
        ? await db.incident.count({
            where: {
              severity: "SEV1",
              status: { in: [...INCIDENT_OPEN_STATUSES] },
              OR: [{ siteId }, { devices: { some: { device: { siteId } } } }],
            },
          })
        : 0;

      return {
        primary: dr.primary,
        secondary: dr.secondary,
        rpoTargetMinutes: dr.rpoTargetMinutes,
        rtoTargetMinutes: dr.rtoTargetMinutes,
        replicationTech: dr.replicationTech,
        readiness: composeDrReadiness({
          backupSuccessRate,
          openCritical,
          memberOnlineRatio: total > 0 ? online / total : 0,
        }),
      };
    })
  );

  const payload = {
    pairs,
    drSites,
    meta: { generatedAt: new Date().toISOString() },
  };

  // Zod-validated response contract — a malformed payload fails loudly
  // instead of shipping a shape the client cannot trust.
  const validated: HaTopologyResponse = responseSchema.parse(payload);

  return ok(validated, { generatedAt: payload.meta.generatedAt }, 200);
}
